"use strict";

// The onboarding record: one live row per reader, written as they go, and
// the operations the page performs on it. Everything the reader types is
// bounded here before it is stored; everything the model answers was
// bounded in onboarding-model. The row is the truth the page mirrors.

const crypto = require("node:crypto");
const OM = require("./onboarding-model");
const P = require("./onboarding-prompts");
const Storage = require("./storage");
const PageFetch = require("./page-fetch");
const Curated = require("./curated");
const SetupChat = require("./setup-chat");
const { insertRows, patchRows, selectRows, rpc } = require("./supabase");

const TABLE = "engelbart_onboardings";
const CALIBRATIONS = "engelbart_onboarding_calibrations";
const ASKS = "engelbart_onboarding_asks";
const PROFILES = "hc_profiles";
const RUNNING_STALE_MS = 180 * 1000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const DEPTH_KEYS = P.DEPTHS.map((d) => d.key);

function one(value, cap) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, cap);
}
function long(value, cap) {
  return String(value == null ? "" : value).replace(/\r/g, "").trim().slice(0, cap);
}
function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function eq(column, value) {
  return `${column}=eq.${encodeURIComponent(String(value))}`;
}

// --- the row ------------------------------------------------------------------

async function rowsOf(user, options) {
  return selectRows(TABLE, `${eq("user_id", user.id)}&select=*&order=created_at.desc`, options);
}

async function calibrationsOf(row, options) {
  return selectRows(CALIBRATIONS, `${eq("onboarding_id", row.id)}&select=*&order=asked_at.asc`, options);
}

// Every write asks for the representation back, so an empty answer means the
// statement matched no row and the write was lost. Fail loudly rather than
// edit the copy in memory and let the page mirror a record nobody holds.
function wroteOne(rows) {
  if (!Array.isArray(rows) || !rows[0]) throw fail("The onboarding record could not be updated", 502);
  return rows[0];
}

async function patch(row, values, options) {
  const rows = await patchRows(TABLE, `${eq("id", row.id)}`, { ...values, updated_at: new Date().toISOString() }, options);
  Object.assign(row, wroteOne(rows));
  return row;
}

function publicRow(row) {
  const { user_id, ...rest } = row;
  return rest;
}

// The live row: the open one, else the newest created one (the page shows
// Done again), else a new one. `fresh` skips a created row and starts over.
async function open(user, body, options = {}) {
  const rows = await rowsOf(user, options);
  let row = rows.find((r) => r.status === "open");
  if (!row && !(body && body.fresh)) row = rows.find((r) => r.status === "created");
  if (!row) {
    // status/step are the table's own defaults, written explicitly so the
    // row we hand back is the row the table holds without a re-read.
    const made = await insertRows(TABLE, [{ user_id: user.id, status: "open", step: 0 }], options);
    row = Array.isArray(made) ? made[0] : made;
  }
  const calibrations = await calibrationsOf(row, options);
  return { onboarding: publicRow(row), calibrations: calibrations.map(publicRow) };
}

// --- step: the fields the page may write ------------------------------------

const STEP_FIELDS = {
  name: (v) => one(v, 60),
  year: (v) => one(v, 40),
  major: (v) => one(v, 80),
  depth: (v) => (DEPTH_KEYS.includes(String(v)) ? String(v) : undefined),
  project_draft: (v) => long(v, 2000),
  goal_chosen: (v) => one(v, 200),
  todos: (v) => (Array.isArray(v) ? v.map((t) => one(t, 300)).filter(Boolean).slice(0, 4) : undefined),
  project_name: (v) => one(v, 80),
};

function requireOpen(row) {
  if (!row || row.status !== "open") throw fail("This setup is already finished", 409);
}

async function step(user, row, body, options = {}) {
  requireOpen(row);
  const fields = body && body.fields && typeof body.fields === "object" ? body.fields : {};
  const values = {};
  for (const [key, clean] of Object.entries(STEP_FIELDS)) {
    if (!(key in fields)) continue;
    const value = clean(fields[key]);
    if (value !== undefined) values[key] = value;
  }
  if (fields.details_answers && typeof fields.details_answers === "object" && row.details) {
    const answers = { ...(row.details.answers || {}) };
    for (const q of row.details.questions || []) {
      if (!(q.id in fields.details_answers)) continue;
      const a = fields.details_answers[q.id];
      answers[q.id] = a == null ? null : Array.isArray(a) ? a.map((x) => one(x, 120)).slice(0, 6) : long(a, 1000);
    }
    values.details = { ...row.details, answers };
  }
  const asked = Number(body && body.step);
  if (Number.isInteger(asked)) values.step = Math.max(Number(row.step) || 0, Math.min(10, Math.max(0, asked)));
  await patch(row, values, options);
  return { onboarding: publicRow(row) };
}

// --- sources and the analysis ------------------------------------------------

function ownPaperToken(paperId, userId, env) {
  return require("../engelbart-setup").ownPaperToken(paperId, userId, env);
}

function optionalUrl(value) {
  const text = one(value, 500);
  if (!text) return "";
  try { return PageFetch.safeHttpUrl(text); } catch { throw fail("Links must be public http(s) pages", 400); }
}

function analysisRunning(row, now = Date.now()) {
  if (row.analysis_status !== "running") return false;
  const started = Date.parse(row.analysis_started_at || "") || 0;
  return now - started < RUNNING_STALE_MS;
}

async function pageTexts(row, options) {
  // Only the transport: a request-wide `signal` here would put both pages and
  // the model call under one budget, so a slow first page would abort the
  // analysis instead of being dropped. Each fetch keeps its own 15 s bound.
  const at = { env: options && options.env, fetchImpl: options && options.fetchImpl };
  const out = [];
  for (const url of [row.project_url, row.repo_url]) {
    if (!url) continue;
    let text = "";
    try { text = await PageFetch.fetchPageText(url, at); } catch { text = "(could not be fetched)"; }
    out.push({ url, text });
  }
  return out;
}

async function runAnalysis(user, row, credentials, options) {
  await patch(row, { analysis_status: "running", analysis_started_at: new Date().toISOString(), analysis_error: "" }, options);
  try {
    const pdf = await Storage.downloadObject(Storage.paperObjectPath(row.paper_id),
      { ...options, maxBytes: MAX_PDF_BYTES });
    if (pdf.length > MAX_PDF_BYTES) throw fail("That PDF is larger than 20 MB", 413);
    const familiarity = P.FAMILIARITY[Number(row.paper_familiarity) || 0];
    const depth = P.depthOf(row.depth) || P.DEPTHS[0];
    const analysis = await OM.analyze({
      familiarityLabel: familiarity.label, familiarityDesc: familiarity.desc,
      depthLabel: depth.label, depthDesc: depth.desc,
      pdfBase64: pdf.toString("base64"),
      urls: await pageTexts(row, options),
    }, credentials, options);
    await patch(row, { analysis, analysis_status: "done", paper_title: analysis.title }, options);
    return { analysis_status: "done", analysis };
  } catch (error) {
    await patch(row, { analysis_status: "error", analysis_error: one(error.message, 300) || "analysis failed" }, options);
    if (error.statusCode === 409) throw error;
    return { analysis_status: "error", analysis_error: row.analysis_error };
  }
}

async function sources(user, row, body, credentials, options = {}) {
  requireOpen(row);
  const paperId = Curated.optUuid(body && body.paper_id);
  if (!paperId) throw fail("Add the paper first", 400);
  const expected = ownPaperToken(paperId, user.id, options.env);
  const given = String((body && body.paper_token) || "");
  // Byte length, not character length: timingSafeEqual throws on a length
  // mismatch, and a multibyte token of the same character count would reach it.
  const ok = Buffer.byteLength(given) === expected.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw fail("That paper is not yours to analyse", 403);
  const familiarity = Number(body.paper_familiarity);
  if (!Number.isInteger(familiarity) || familiarity < 0 || familiarity > 4) throw fail("Say how familiar you are with the paper", 400);
  if (analysisRunning(row)) return { analysis_status: "running" };
  await patch(row, { paper_id: paperId, project_url: optionalUrl(body.project_url), repo_url: optionalUrl(body.repo_url),
    paper_familiarity: familiarity, analysis: null, paper_title: "" }, options);
  return runAnalysis(user, row, credentials, options);
}

async function analysis(user, row, body, credentials, options = {}) {
  if (body && body.retry) {
    if (!row.paper_id) throw fail("Add the paper first", 400);
    if (analysisRunning(row)) return { analysis_status: "running" };
    return runAnalysis(user, row, credentials, options);
  }
  const out = { analysis_status: row.analysis_status };
  if (row.analysis_status === "done") out.analysis = row.analysis;
  if (row.analysis_status === "error") out.analysis_error = row.analysis_error;
  return out;
}

// --- calibration -------------------------------------------------------------

function questionAt(analysisValue, areaIndex, level) {
  const area = analysisValue && Array.isArray(analysisValue.areas) ? analysisValue.areas[areaIndex] : null;
  if (!area) return null;
  const q = area.questions.find((x) => x.level === level);
  return q ? { area, question: q } : null;
}

async function answer(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
  const areaIndex = Number(body.area_index);
  const level = Number(body.question_level);
  const self = Number(body.self_level);
  const said = long(body.answer, 2000);
  if (!OM.LEVELS.includes(level) || !OM.LEVELS.includes(self)) throw fail("That level is not on the ladder", 400);
  if (!said) throw fail("Write an answer first", 400);
  const found = questionAt(row.analysis, areaIndex, level);
  if (!found) throw fail("That question is not in this analysis", 400);
  const prior = calibrations.filter((c) => Number(c.area_index) === areaIndex);
  // Two questions per area is the whole diagnostic: the reader's own, and at
  // most one follow-up. Re-answering either is allowed; a third is not, so the
  // page cannot walk an area up level by level.
  const answered = prior.filter((c) => c.answered_at);
  if (answered.length >= 2 && !answered.some((c) => Number(c.question_level) === level)) {
    throw fail("That area has been asked enough", 400);
  }
  const existing = prior.find((c) => Number(c.question_level) === level);
  const values = { area: found.area.area, parent_field: found.area.parent_field, self_level: self,
    question: found.question.question, sample_response: found.question.sample_response,
    answer: said, answered_at: new Date().toISOString(), graded_level: null, grade_confidence: null, grade_rationale: "" };
  let cal;
  if (existing) {
    const rows = await patchRows(CALIBRATIONS, `${eq("id", existing.id)}`, values, options);
    cal = Object.assign(existing, wroteOne(rows));
  } else {
    // Upsert on the table's own unique key: a caller array that has gone stale
    // must not turn a re-answer into a 409, which the page would show as the
    // gateway's "credit exhausted" rather than as the answer landing.
    const rows = await insertRows(CALIBRATIONS, [{ onboarding_id: row.id, user_id: user.id, area_index: areaIndex,
      question_level: level, ...values }], { ...options,
      query: "on_conflict=onboarding_id,area_index,question_level",
      prefer: "resolution=merge-duplicates,return=representation" });
    cal = wroteOne(rows);
    // By id, not by identity: the row came back over the wire, so it is never
    // the same object the caller already holds for a re-answered question.
    const at = calibrations.findIndex((c) => c.id === cal.id);
    if (at < 0) calibrations.push(cal); else calibrations[at] = cal;
  }
  const graded = await OM.grade({ area: found.area.area, question: found.question.question, level,
    sample: found.question.sample_response, answer: said }, credentials, options);
  if (graded) {
    const rows = await patchRows(CALIBRATIONS, `${eq("id", cal.id)}`, { graded_level: graded.level,
      grade_confidence: graded.confidence, grade_rationale: graded.rationale }, options);
    Object.assign(cal, wroteOne(rows));
  }
  const out = { graded_level: cal.graded_level, grade_confidence: cal.grade_confidence, grade_rationale: cal.grade_rationale };
  // One follow-up, at the level the grade found, when it disagrees with the
  // self-rating and this was the area's first question.
  const first = prior.length === 0 || (prior.length === 1 && prior[0].id === cal.id);
  if (first && graded && Math.abs(graded.level - self) >= 25 && graded.level !== level) {
    const next = questionAt(row.analysis, areaIndex, graded.level);
    if (next) out.follow_up = { question_level: graded.level, question: next.question.question };
  }
  return out;
}

// Each area's level: the most recently GRADED answer in it. Only when nothing
// in the area was graded -- the grader was down for every answer -- does it
// fall back to the last answered question's self-rating. A later ungraded
// answer must not erase a grade the reader already earned.
function areaLevels(analysisValue, calibrations) {
  const areas = analysisValue && Array.isArray(analysisValue.areas) ? analysisValue.areas : [];
  return areas.map((_, i) => {
    const mine = (calibrations || []).filter((c) => Number(c.area_index) === i && c.answered_at)
      .sort((a, b) => String(a.answered_at).localeCompare(String(b.answered_at)));
    if (!mine.length) return null;
    const graded = mine.filter((c) => c.graded_level != null);
    if (graded.length) return Number(graded[graded.length - 1].graded_level);
    return Number(mine[mine.length - 1].self_level);
  });
}

function knowledgeOf(analysisValue, calibrations) {
  const levels = areaLevels(analysisValue, calibrations);
  return levels.map((level, i) => (level == null ? null : {
    area: analysisValue.areas[i].area, parent_field: analysisValue.areas[i].parent_field,
    level, project_role: analysisValue.areas[i].project_role,
  })).filter(Boolean);
}

// The register everything after Topics is written at: the chosen depth,
// shifted one stop down when the graded mean is at or below "can follow",
// one stop up at or above "can use".
function assessedDepth(depthKey, levels) {
  const known = (levels || []).filter((l) => l != null);
  const index = Math.max(0, DEPTH_KEYS.indexOf(depthKey));
  if (!known.length) return { key: DEPTH_KEYS[index], shift: 0, weakest: -1 };
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  const shift = mean <= 25 ? -1 : mean >= 75 ? 1 : 0;
  const to = Math.max(0, Math.min(DEPTH_KEYS.length - 1, index + shift));
  let weakest = -1;
  (levels || []).forEach((l, i) => { if (l != null && (weakest < 0 || l < levels[weakest])) weakest = i; });
  return { key: DEPTH_KEYS[to], shift: to - index, weakest };
}

function readerOf(row, calibrations) {
  const levels = areaLevels(row.analysis, calibrations);
  const assessed = assessedDepth(row.depth, levels);
  return { name: row.name, year: row.year, major: row.major, depth: assessed.key,
    knowledge: knowledgeOf(row.analysis, calibrations), assessed };
}

function registerNote(row, reader) {
  const { assessed } = reader;
  if (assessed.shift < 0) {
    const area = assessed.weakest >= 0 ? row.analysis.areas[assessed.weakest].area.toLowerCase() : "the paper's areas";
    return `Note: the reader is newest to ${area}; ask in plainer terms than their chosen register.`;
  }
  if (assessed.shift > 0) return "Note: the reader graded strongly across the paper's areas; ask more directly.";
  return "";
}

function introFor(row, reader) {
  const { assessed } = reader;
  if (assessed.shift < 0) {
    const area = assessed.weakest >= 0 ? row.analysis.areas[assessed.weakest].area.toLowerCase() : "the topics";
    return `Asking in plainer terms — you're newest to ${area}.`;
  }
  if (assessed.shift > 0) return "Asking more directly — you answered strongly across the paper's areas.";
  return "";
}

function paperOf(row) {
  const a = row.analysis || {};
  return { title: one(a.title || row.paper_title, 60), one_liner: one(a.one_liner, 300) };
}

// --- generation ---------------------------------------------------------------

async function details(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
  if (row.details && row.details.questions && !(body && body.regenerate)) return row.details;
  const reader = readerOf(row, calibrations);
  const made = await OM.details({ reader, paper: paperOf(row), draft: row.project_draft, registerNote: registerNote(row, reader) },
    credentials, options);
  const value = { intro: made.intro || introFor(row, reader), questions: made.questions, answers: {} };
  await patch(row, { details: value }, options);
  return value;
}

async function goals(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.goals && row.goals.goals && !(body && body.regenerate)) return row.goals;
  const reader = readerOf(row, calibrations);
  const made = await OM.goals({ reader, paper: paperOf(row), draft: row.project_draft, details: row.details || {} },
    credentials, options);
  await patch(row, { goals: made }, options);
  return made;
}

async function todos(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  const goal = one(body && body.goal, 200);
  if (!goal) throw fail("Pick a goal first", 400);
  if (row.todos && row.goal_chosen === goal && !(body && body.regenerate)) return { todos: row.todos, name: row.project_name };
  const reader = readerOf(row, calibrations);
  const made = await OM.todos({ reader, paper: paperOf(row), draft: row.project_draft, goal, details: row.details || {} },
    credentials, options);
  await patch(row, { todos: made.todos, goal_chosen: goal, project_name: row.project_name || made.name }, options);
  return { todos: made.todos, name: row.project_name };
}

async function ask(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  const quote = one(body && body.quote, 240);
  const question = one(body && body.question, 300);
  if (!question) throw fail("Ask something first", 400);
  const reader = readerOf(row, calibrations);
  if (DEPTH_KEYS.includes(String(body && body.level))) reader.depth = String(body.level);
  const made = await OM.ask({ reader, paper: paperOf(row), quote, question }, credentials, options);
  await insertRows(ASKS, [{ onboarding_id: row.id, user_id: user.id, step: Number(body.step) || 0, quote, question,
    level: reader.depth, answer: made.answer }], options);
  return { answer: made.answer, level: reader.depth };
}

// --- create -------------------------------------------------------------------

function toPayload(row, calibrations) {
  const paper = paperOf(row);
  const reader = readerOf(row, calibrations);
  const depth = P.depthOf(reader.depth) || P.DEPTHS[0];
  const offered = (row.goals && Array.isArray(row.goals.goals) ? row.goals.goals : [])
    .map((g) => ({ label: g.label, why: g.why }));
  if (row.goal_chosen && !offered.some((g) => g.label === row.goal_chosen)) offered.push({ label: row.goal_chosen, why: "" });
  const payload = {
    name: row.project_name,
    plan: { description: [row.project_draft, paper.title ? `Building on “${paper.title}” — ${paper.one_liner}` : ""]
      .filter(Boolean).join("\n\n"), unsure: [] },
    goals: offered,
    chosen: row.goal_chosen,
    todos: Array.isArray(row.todos) ? row.todos : [],
    subgoals: [],
    reader: { name: reader.name, year: reader.year, major: reader.major, level: depth.hc, knowledge: reader.knowledge },
  };
  if (row.paper_id) {
    payload.paper = { paper_id: row.paper_id, title: paper.title, url: row.project_url || "" };
    payload.provenance = { papers: [{ paper_id: row.paper_id, title: paper.title }],
      idea: { title: row.goal_chosen, inspired: paper.title } };
  }
  return payload;
}

// The reader's profile in the workspace. Its table ships on its own schedule,
// so a profile that will not save must not cost them the project they just
// spent the whole setup on: log it and say so in the reply.
async function saveProfile(user, reader, options) {
  try {
    await insertRows(PROFILES, [{ user_id: user.id, display_name: reader.name, year: reader.year,
      major: reader.major, tech_level: reader.level, knowledge: reader.knowledge,
      updated_at: new Date().toISOString() }], { ...options, query: "on_conflict=user_id",
      prefer: "resolution=merge-duplicates,return=representation" });
    return true;
  } catch (error) {
    console.error("engelbart-onboarding: profile not saved:", one(error && error.message, 200));
    return false;
  }
}

async function create(user, row, calibrations, body, options = {}) {
  // Nothing left to write on a repeat, so nothing left to fail -- and nothing
  // written means nothing claimed: no `profile_saved` verdict on this branch.
  if (row.status === "created") return { ok: true, pending_setup_id: row.pending_setup_id };
  const values = {};
  if (body && "project_name" in body) values.project_name = one(body.project_name, 80);
  if (body && "goal_chosen" in body) values.goal_chosen = one(body.goal_chosen, 200);
  if (body && Array.isArray(body.todos)) values.todos = body.todos.map((t) => one(t, 300)).filter(Boolean).slice(0, 4);
  // Checked against what the record WOULD be, and only then written to it: a
  // rejected create must leave the row exactly as the reader left it.
  const merged = { ...row, ...values };
  if (!merged.project_name) throw fail("Name this project first", 400);
  if (!merged.goal_chosen) throw fail("Pick a goal first", 400);
  if (!Array.isArray(merged.todos) || merged.todos.length < 2) throw fail("At least two todos", 400);
  Object.assign(row, values);
  const payload = SetupChat.normalizePayload(toPayload(row, calibrations));
  const saved = await rpc("engelbart_save_pending_setup", { p_user_id: user.id, p_payload: payload }, options);
  const pendingId = typeof saved === "string" ? saved : (saved && saved.id) || null;
  const profileSaved = await saveProfile(user, payload.reader, options);
  await patch(row, { ...values, status: "created", pending_setup_id: pendingId, step: 10 }, options);
  return { ok: true, pending_setup_id: pendingId, profile_saved: profileSaved };
}

module.exports = {
  STEP_FIELDS, RUNNING_STALE_MS, MAX_PDF_BYTES,
  open, step, sources, analysis, answer, details, goals, todos, ask, create,
  areaLevels, knowledgeOf, assessedDepth, readerOf, toPayload, analysisRunning, publicRow,
};
