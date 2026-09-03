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
const { deleteRows, insertRows, patchRows, selectRows, rpc } = require("./supabase");

const TABLE = "engelbart_onboardings";
const CALIBRATIONS = "engelbart_onboarding_calibrations";
const ASKS = "engelbart_onboarding_asks";
const TURNS = "engelbart_onboarding_turns";
const PROFILES = "hc_profiles";
const STEP = { paper: 4, install: 5, topics: 6, brainstorm: 7, assets: 8, direction: 9, subgoals: 10, todos: 11, done: 12 };
const LINK_CHECK_MS = 5000;
const MAX_LINK_CHECKS = 40;
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

const PROFILE_FIELDS = ["name", "year", "major", "depth"];
const PAPER_STEP = 4;

function hasProfile(row) {
  return Boolean(row) && PROFILE_FIELDS.every((k) => row[k]);
}

// The live row: the open one, else the newest created one (the page shows
// Done again), else a new one. `fresh` skips a created row and starts over.
//
// The profile is asked once. A member who has finished a setup before has
// already said who they are; the next setup starts at the paper with those
// four answers carried over, and the reply says so (`profile_reused`) so the
// page can count its steps from there. An open row that predates the finished
// one, or was made before this rule, is filled in the same way on open.
async function open(user, body, options = {}) {
  const rows = await rowsOf(user, options);
  let row = rows.find((r) => r.status === "open");
  if (!row && !(body && body.fresh)) row = rows.find((r) => r.status === "created");
  const prior = rows.find((r) => r.status === "created" && hasProfile(r) && (!row || r.id !== row.id)) || null;
  if (!row) {
    // status/step are the table's own defaults, written explicitly so the
    // row we hand back is the row the table holds without a re-read.
    const seed = { user_id: user.id, status: "open", step: 0 };
    if (prior) { for (const k of PROFILE_FIELDS) seed[k] = prior[k]; seed.step = PAPER_STEP; }
    const made = await insertRows(TABLE, [seed], options);
    row = Array.isArray(made) ? made[0] : made;
  } else if (prior && row.status === "open" && (!hasProfile(row) || (Number(row.step) || 0) < PAPER_STEP)) {
    const values = {};
    for (const k of PROFILE_FIELDS) values[k] = row[k] || prior[k];
    values.step = Math.max(Number(row.step) || 0, PAPER_STEP);
    await patch(row, values, options);
  }
  const calibrations = await calibrationsOf(row, options);
  const turns = await turnsOf(row, "brainstorm", "", options);
  return { onboarding: publicRow(row), calibrations: calibrations.map(publicRow),
    turns: turns.map(publicTurn), profile_reused: Boolean(prior) };
}

// --- turns: every conversational exchange on the page -------------------------

async function turnsOf(row, stage, assetKey, options) {
  const key = assetKey ? `&${eq("asset_key", assetKey)}` : "";
  return selectRows(TURNS, `${eq("onboarding_id", row.id)}&${eq("stage", stage)}${key}&select=*&order=created_at.asc`, options);
}

function publicTurn(t) {
  return { id: t.id, stage: t.stage, asset_key: t.asset_key || "", role: t.role, content: t.content, card: t.card || null, created_at: t.created_at };
}

async function addTurn(user, row, stage, assetKey, role, content, card, options) {
  const rows = await insertRows(TURNS, [{ onboarding_id: row.id, user_id: user.id, stage, asset_key: assetKey || "",
    role, content: long(content, 4000), card: card || null }], options);
  return wroteOne(rows);
}

// Test mode's two buttons. `project` drops the open row, so the next open
// starts a new one (still seeded from a finished setup, if there is one).
// `all` drops every setup the account has made -- calibrations and asks go
// with them -- and the saved profile, so the next open is a first setup
// again. The account, its membership and its credit are not touched.
async function reset(user, body, options = {}) {
  const scope = body && body.scope === "all" ? "all" : "project";
  if (scope === "project") {
    await deleteRows(TABLE, `${eq("user_id", user.id)}&status=eq.open`, options);
    return { ok: true, scope };
  }
  await deleteRows(TABLE, eq("user_id", user.id), options);
  try {
    await deleteRows(PROFILES, eq("user_id", user.id), options);
  } catch (error) {
    // Same posture as saveProfile: the profile table ships on its own schedule.
    console.error("engelbart-onboarding: profile not cleared:", one(error && error.message, 200));
  }
  return { ok: true, scope };
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
  if (Number.isInteger(asked)) values.step = Math.max(Number(row.step) || 0, Math.min(STEP.done, Math.max(0, asked)));
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

// A minute is long enough for the reader to go back and attach a different
// paper. The row is re-read at the end of the run, and a run whose paper is no
// longer the row's paper writes nothing at all: neither its answer nor its
// error belongs to the paper that is there now.
async function supersededBy(row, paperId, options) {
  try {
    const rows = await selectRows(TABLE, `${eq("id", row.id)}&select=id,paper_id&limit=1`, options);
    const now = rows && rows[0];
    return Boolean(now) && String(now.paper_id) !== String(paperId);
  } catch (error) {
    // A row that cannot be read is not evidence of a newer paper; write as before.
    return false;
  }
}

async function runAnalysis(user, row, credentials, options) {
  const mine = row.paper_id;
  await patch(row, { analysis_status: "running", analysis_started_at: new Date().toISOString(), analysis_error: "" }, options);
  try {
    const pdf = await Storage.downloadObject(Storage.paperObjectPath(mine),
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
    if (await supersededBy(row, mine, options)) return { analysis_status: "superseded" };
    await patch(row, { analysis, analysis_status: "done", paper_title: analysis.title }, options);
    return { analysis_status: "done", analysis };
  } catch (error) {
    if (await supersededBy(row, mine, options)) return { analysis_status: "superseded" };
    await patch(row, { analysis_status: "error", analysis_error: one(error.message, 300) || "analysis failed" }, options);
    if (error.statusCode === 409) throw error;
    return { analysis_status: "error", analysis_error: row.analysis_error };
  }
}

// Accepting the paper is not reading it. This validates and stores, and
// answers at once; the page then asks for the reading with `analysis {run}`
// and walks on while it happens. Keeping the two apart is what stops a
// minute-long model call from sitting under the reader's Continue.
async function sources(user, row, body, credentials, options = {}) {
  requireOpen(row);
  const paperId = Curated.optUuid(body && body.paper_id);
  if (!paperId) throw fail("Add the paper first", 400);
  const given = String((body && body.paper_token) || "");
  // A reload loses the token the upload minted, but not the record: the paper
  // already on this row was proven by the member who owns the row, so it stays
  // proven with no token at all. Any other paper still has to show one.
  const proven = Boolean(row.paper_id) && paperId === row.paper_id;
  if (given || !proven) {
    const expected = ownPaperToken(paperId, user.id, options.env);
    // Byte length, not character length: timingSafeEqual throws on a length
    // mismatch, and a multibyte token of the same character count would reach it.
    const ok = Buffer.byteLength(given) === expected.length
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) throw fail("That paper is not yours to analyse", 403);
  }
  const familiarity = Number(body.paper_familiarity);
  if (!Number.isInteger(familiarity) || familiarity < 0 || familiarity > 4) throw fail("Say how familiar you are with the paper", 400);
  // `analysis_started_at` goes with the status: a run that was in flight for
  // the old paper must leave no trace that reads as this paper's run.
  await patch(row, { paper_id: paperId, project_url: optionalUrl(body.project_url), repo_url: optionalUrl(body.repo_url),
    paper_familiarity: familiarity, analysis: null, paper_title: "", analysis_status: "none",
    analysis_error: "", analysis_started_at: null,
    assets: null, assets_brief: null, assets_status: "none", assets_error: "", assets_started_at: null,
    assessment: null, leveled: null, leveled_status: "none", leveled_error: "", leveled_started_at: null,
    asset_chosen: null, direction: null, subgoals: null, todos: null }, options);
  return { ok: true, analysis_status: "none", assets_status: "none" };
}

// --- the asset hunt ------------------------------------------------------------
//
// Same shape as the analysis: started by the page right after the paper is
// accepted, runs to completion in its own invocation, polled for free. The
// model searches the web for where each thing lives; every link it returns
// is then checked here, because a link that answers 404 is worse than none.

function running(row, prefix, now = Date.now()) {
  if (row[`${prefix}_status`] !== "running") return false;
  const started = Date.parse(row[`${prefix}_started_at`] || "") || 0;
  return now - started < RUNNING_STALE_MS;
}

async function linkAlive(url, options) {
  const fetchImpl = (options && options.fetchImpl) || global.fetch;
  try {
    PageFetch.safeHttpUrl(url);
  } catch {
    return false;
  }
  try {
    const response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(LINK_CHECK_MS) });
    // Only a host that positively says the thing is gone loses the link; a
    // refusal of HEAD (403, 405) or a timeout is not evidence either way.
    return !(response.status === 404 || response.status === 410);
  } catch {
    return true;
  }
}

async function verifyLinks(assets, options) {
  let budget = MAX_LINK_CHECKS;
  async function check(asset) {
    const had = asset.links.length;
    const verdicts = await Promise.all(asset.links.map((l) => {
      if (budget <= 0) return Promise.resolve(true);
      budget -= 1;
      return linkAlive(l.url, options);
    }));
    asset.links = asset.links.filter((_, i) => verdicts[i]);
    if (had && !asset.links.length && asset.availability === "usable") asset.availability = "unknown";
    for (const child of Array.isArray(asset.children) ? asset.children : []) await check(child);
  }
  for (const asset of assets) await check(asset);
  return assets;
}

async function runAssets(user, row, credentials, options) {
  const mine = row.paper_id;
  await patch(row, { assets_status: "running", assets_started_at: new Date().toISOString(), assets_error: "" }, options);
  try {
    const pdf = await Storage.downloadObject(Storage.paperObjectPath(mine), { ...options, maxBytes: MAX_PDF_BYTES });
    if (pdf.length > MAX_PDF_BYTES) throw fail("That PDF is larger than 20 MB", 413);
    const found = await OM.assets({ pdfBase64: pdf.toString("base64") }, credentials, options);
    const assets = await verifyLinks(found.assets, options);
    if (await supersededBy(row, mine, options)) return { assets_status: "superseded" };
    const value = { assets, searched: found.searched };
    await patch(row, { assets: value, assets_brief: OM.briefOf(assets), assets_status: "done" }, options);
    return { assets_status: "done", assets: value, assets_brief: row.assets_brief };
  } catch (error) {
    if (await supersededBy(row, mine, options)) return { assets_status: "superseded" };
    await patch(row, { assets_status: "error", assets_error: one(error.message, 300) || "the asset hunt failed" }, options);
    if (error.statusCode === 409) throw error;
    return { assets_status: "error", assets_error: row.assets_error };
  }
}

async function assetsAction(user, row, body, credentials, options = {}) {
  if (body && (body.run || body.retry)) {
    if (!row.paper_id) throw fail("Add the paper first", 400);
    if (running(row, "assets")) return { assets_status: "running" };
    return runAssets(user, row, credentials, options);
  }
  const out = { assets_status: row.assets_status };
  if (row.assets_status === "done") { out.assets = row.assets; out.assets_brief = row.assets_brief; }
  if (row.assets_status === "error") out.assets_error = row.assets_error;
  return out;
}

// --- what the topic questions found ------------------------------------------

// Compiled once, from the calibration rows, when the last area is answered.
// No model call: the grades are already on the rows.
function compileAssessment(row, calibrations) {
  const areas = row.analysis && Array.isArray(row.analysis.areas) ? row.analysis.areas : [];
  const levels = areaLevels(row.analysis, calibrations);
  const out = areas.map((a, i) => {
    const mine = (calibrations || []).filter((c) => Number(c.area_index) === i && c.answered_at)
      .sort((x, y) => String(x.answered_at).localeCompare(String(y.answered_at)));
    const last = mine[mine.length - 1] || null;
    const graded = mine.filter((c) => c.graded_level != null);
    const lastGraded = graded[graded.length - 1] || null;
    return { area: a.area, parent_field: a.parent_field || "", project_role: a.project_role || "",
      self_level: last ? Number(last.self_level) : null,
      graded_level: levels[i],
      confidence: lastGraded && lastGraded.grade_confidence != null ? Number(lastGraded.grade_confidence) : null,
      rationale: lastGraded ? one(lastGraded.grade_rationale, 300) : "",
      questions_asked: mine.length,
      answers: mine.map((c) => long(c.answer, 600)) };
  });
  const known = levels.filter((l) => l != null);
  const assessed = assessedDepth(row.depth, levels);
  return { areas: out, mean: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
    depth: assessed.key, depth_shift: assessed.shift, compiled_at: new Date().toISOString() };
}

async function topicsDone(user, row, calibrations, body, options = {}) {
  requireOpen(row);
  if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
  const assessment = compileAssessment(row, calibrations);
  if (!assessment.areas.some((a) => a.questions_asked > 0)) throw fail("Answer the topic questions first", 400);
  await patch(row, { assessment, step: Math.max(Number(row.step) || 0, STEP.brainstorm) }, options);
  return { assessment };
}

// --- the assets, re-cut for this reader -----------------------------------------
//
// Needs the hunt AND the assessment. Started by the page as soon as the
// topics are answered; while the hunt is still out, it answers `waiting`
// and the page asks again during the brainstorm.

async function runLeveled(user, row, calibrations, credentials, options) {
  const mine = row.paper_id;
  await patch(row, { leveled_status: "running", leveled_started_at: new Date().toISOString(), leveled_error: "" }, options);
  try {
    const leveled = await OM.levelAssets({ reader: readerOf(row, calibrations), assessment: row.assessment,
      assets: row.assets.assets, interest: row.interest || "" }, credentials, options);
    await verifyLinks(leveled.assets, options);
    if (await supersededBy(row, mine, options)) return { leveled_status: "superseded" };
    await patch(row, { leveled, leveled_status: "done" }, options);
    return { leveled_status: "done", leveled };
  } catch (error) {
    if (await supersededBy(row, mine, options)) return { leveled_status: "superseded" };
    await patch(row, { leveled_status: "error", leveled_error: one(error.message, 300) || "levelling failed" }, options);
    if (error.statusCode === 409) throw error;
    return { leveled_status: "error", leveled_error: row.leveled_error };
  }
}

async function leveledAction(user, row, calibrations, body, credentials, options = {}) {
  if (body && (body.run || body.retry)) {
    if (!row.assessment) throw fail("Answer the topic questions first", 409);
    if (row.assets_status !== "done" || !row.assets) {
      if (row.assets_status === "error") return { leveled_status: "waiting", assets_status: "error", assets_error: row.assets_error };
      return { leveled_status: "waiting", assets_status: row.assets_status };
    }
    if (running(row, "leveled")) return { leveled_status: "running" };
    if (row.leveled_status === "done" && row.leveled && !body.retry) return { leveled_status: "done", leveled: row.leveled };
    return runLeveled(user, row, calibrations, credentials, options);
  }
  const out = { leveled_status: row.leveled_status, assets_status: row.assets_status };
  if (row.leveled_status === "done") out.leveled = row.leveled;
  if (row.leveled_status === "error") out.leveled_error = row.leveled_error;
  return out;
}

// --- brainstorm ---------------------------------------------------------------

// What the reader said this turn, as one line of transcript: typed text, the
// answers to a card, a focus pick with its note. Empty on the opening turn.
function userTurnText(body, lastCard) {
  const parts = [];
  const text = long(body && body.text, 2000);
  if (text) parts.push(text);
  const answers = body && body.answers && typeof body.answers === "object" ? body.answers : null;
  if (answers && lastCard && lastCard.card === "questions") {
    for (const q of lastCard.questions.items) {
      if (!(q.id in answers)) continue;
      const a = answers[q.id];
      const said = Array.isArray(a) ? a.map((x) => one(x, 160)).filter(Boolean).join("; ") : long(a, 1000);
      if (said) parts.push(`${q.title} ${said}`);
    }
  }
  const pick = one(body && body.pick, 160);
  if (pick) parts.push(`Focus: ${pick}`);
  const note = long(body && body.note, 1000);
  if (note) parts.push(note);
  return parts.join("\n");
}

function assistantTurnText(reply) {
  const parts = [reply.say];
  if (reply.card === "questions") parts.push(...reply.questions.items.map((q) => `(asked) ${q.title}`));
  if (reply.card === "focus") parts.push(`(offered) ${reply.focus.options.map((o) => o.label).join(" / ")}`);
  return parts.filter(Boolean).join("\n");
}

async function brainstormAction(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
  const turns = await turnsOf(row, "brainstorm", "", options);
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const said = userTurnText(body, lastAssistant && lastAssistant.card);
  if (said) {
    // The answers ride along with the text, so the page can redraw the card
    // they answered with their choices marked instead of a flattened line.
    const made = await addTurn(user, row, "brainstorm", "", "user", said, userTurnCard(body), options);
    turns.push(made);
  } else if (turns.length && !(body && body.again)) {
    // Nothing new to say and a conversation already open: the last card
    // stands, so hand it back rather than ask the model to repeat itself.
    return { ...publicReply(lastAssistant), leveled_status: row.leveled_status, interest: row.interest || "" };
  }
  // Whether they are ready to plan is the model's call, and it is only asked
  // once the fitted resources exist: a plan before them would be premature
  // whatever the conversation says.
  const readyAsked = row.leveled_status === "done";
  const reply = await OM.brainstorm({ reader: readerOf(row, calibrations), paper: paperOf(row),
    assessment: row.assessment, brief: row.assets_brief || [], turns: turns.map((t) => ({ role: t.role, content: t.content })),
    readyAsked }, credentials, options);
  const card = { card: reply.card, questions: reply.questions, focus: reply.focus, ready: readyAsked && reply.ready === true };
  const made = await addTurn(user, row, "brainstorm", "", "assistant", assistantTurnText(reply), card, options);
  const values = { step: Math.max(Number(row.step) || 0, STEP.brainstorm) };
  if (reply.interest) values.interest = reply.interest;
  await patch(row, values, options);
  return { ...publicReply(made), leveled_status: row.leveled_status, interest: row.interest || "" };
}

function publicReply(turn) {
  const card = turn && turn.card ? turn.card : { card: "none" };
  return { turn_id: turn ? turn.id : null, say: turn ? String(turn.content || "").split("\n(")[0] : "",
    card: card.card || "none", questions: card.questions, focus: card.focus, ready: card.ready === true };
}

// What the reader answered with, kept beside the user turn: the answers by
// question id, the focus pick and note, and any typed text.
function userTurnCard(body) {
  const out = {};
  if (body && body.answers && typeof body.answers === "object") {
    out.answers = {};
    for (const [k, v] of Object.entries(body.answers)) {
      const key = one(k, 40); if (!key) continue;
      out.answers[key] = Array.isArray(v) ? v.map((x) => one(x, 160)).filter(Boolean).slice(0, 12) : long(v, 1000);
    }
  }
  const pick = one(body && body.pick, 160); if (pick) out.pick = pick;
  const note = long(body && body.note, 1000); if (note) out.note = note;
  const text = long(body && body.text, 2000); if (text) out.text = text;
  return Object.keys(out).length ? out : null;
}

// --- assets: ask, choose ------------------------------------------------------

// An asset is named by its title, a child by "parent title :: child title".
function findAsset(row, key) {
  const list = row.leveled && Array.isArray(row.leveled.assets) ? row.leveled.assets
    : row.assets && Array.isArray(row.assets.assets) ? row.assets.assets : [];
  const [parentTitle, childTitle] = String(key || "").split(" :: ");
  const parent = list.find((a) => a.title === parentTitle);
  if (!parent) return null;
  if (!childTitle) return { asset: parent, parent: null };
  const child = (parent.children || []).find((c) => c.title === childTitle);
  return child ? { asset: child, parent } : null;
}

async function assetAsk(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  const key = one(body && body.key, 260);
  const question = one(body && body.question, 300);
  if (!question) throw fail("Ask something first", 400);
  const found = findAsset(row, key);
  if (!found) throw fail("That is not one of the things on the list", 400);
  const thread = await turnsOf(row, "asset", key, options);
  const made = await OM.assetAsk({ reader: readerOf(row, calibrations), paper: paperOf(row), asset: found.asset,
    thread: thread.map((t) => ({ role: t.role, content: t.content })), question }, credentials, options);
  await addTurn(user, row, "asset", key, "user", question, null, options);
  const reply = await addTurn(user, row, "asset", key, "assistant", made.answer, null, options);
  return { answer: made.answer, turn_id: reply.id };
}

async function chooseAsset(user, row, body, options = {}) {
  requireOpen(row);
  const key = one(body && body.key, 260);
  const found = findAsset(row, key);
  if (!found) throw fail("Pick one of the things on the list", 400);
  const { children, ...rest } = found.asset;
  const chosen = { key, ...rest, parent: found.parent ? found.parent.title : "" };
  await patch(row, { asset_chosen: chosen, direction: null, subgoals: null, todos: null,
    step: Math.max(Number(row.step) || 0, STEP.direction) }, options);
  return { asset_chosen: chosen };
}

// --- direction, subgoals -------------------------------------------------------

async function directionAction(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (!row.asset_chosen) throw fail("Pick what to build on first", 409);
  const feedback = long(body && body.revise, 1000);
  if (row.direction && !feedback && !(body && body.regenerate)) return { direction: row.direction };
  const turns = await turnsOf(row, "brainstorm", "", options);
  const made = await OM.direction({ reader: readerOf(row, calibrations), paper: paperOf(row), interest: row.interest || "",
    assessment: row.assessment, turns: turns.map((t) => ({ role: t.role, content: t.content })), asset: row.asset_chosen,
    leveled: row.leveled ? { locus: row.leveled.locus, sticky: row.leveled.sticky } : null,
    previous: feedback ? row.direction : null, feedback }, credentials, options);
  if (feedback) await addTurn(user, row, "direction", "", "user", feedback, null, options);
  await addTurn(user, row, "direction", "", "assistant", `${made.title} -- ${made.what_you_would_make}`, made, options);
  await patch(row, { direction: made, subgoals: null, todos: null, step: Math.max(Number(row.step) || 0, STEP.direction) }, options);
  return { direction: made };
}

async function subgoalsAction(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (!row.direction) throw fail("Settle the direction first", 409);
  const feedback = long(body && body.revise, 1000);
  if (row.subgoals && !feedback && !(body && body.regenerate)) return { subgoals: row.subgoals };
  const made = await OM.subgoals({ reader: readerOf(row, calibrations), paper: paperOf(row), direction: row.direction,
    asset: row.asset_chosen, leveled: row.leveled ? { locus: row.leveled.locus, sticky: row.leveled.sticky } : null,
    previous: feedback ? row.subgoals : null, feedback }, credentials, options);
  if (feedback) await addTurn(user, row, "subgoals", "", "user", feedback, null, options);
  await addTurn(user, row, "subgoals", "", "assistant", made.subgoals.map((g) => g.label).join(" / "), made, options);
  await patch(row, { subgoals: made.subgoals, todos: null, step: Math.max(Number(row.step) || 0, STEP.subgoals) }, options);
  return { subgoals: made.subgoals };
}

async function analysis(user, row, body, credentials, options = {}) {
  // `run` is the page starting the reading it has just been told to expect;
  // `retry` is the reader asking again after one failed. Both do the same
  // work. Anything else is the poll: a row read, priced as one.
  if (body && (body.run || body.retry)) {
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
  const area = row.analysis && Array.isArray(row.analysis.areas) ? row.analysis.areas[areaIndex] : null;
  if (!area) throw fail("That area is not in this analysis", 400);
  const prior = calibrations.filter((c) => Number(c.area_index) === areaIndex);
  const existing = prior.find((c) => Number(c.question_level) === level);
  // The question being answered is the ladder's, unless a follow-up was
  // written for this level from their first answer: that row already holds
  // its own question and sample, and those are what the grade is against.
  const ladder = questionAt(row.analysis, areaIndex, level);
  const source = existing && existing.question && !existing.answered_at
    ? { question: existing.question, sample_response: existing.sample_response || "" }
    : existing && existing.question && ladder && existing.question !== ladder.question.question
      ? { question: existing.question, sample_response: existing.sample_response || "" }
      : ladder ? ladder.question : null;
  if (!source) throw fail("That question is not in this analysis", 400);
  // Two questions per area is the whole diagnostic: the reader's own, and at
  // most one follow-up. Re-answering either is allowed; a third is not, so the
  // page cannot walk an area up level by level.
  const answered = prior.filter((c) => c.answered_at);
  if (answered.length >= 2 && !answered.some((c) => Number(c.question_level) === level)) {
    throw fail("That area has been asked enough", 400);
  }
  const values = { area: area.area, parent_field: area.parent_field, self_level: self,
    question: source.question, sample_response: source.sample_response,
    answer: said, answered_at: new Date().toISOString(), graded_level: null, grade_confidence: null, grade_rationale: "" };
  let cal;
  if (existing) {
    const rows = await patchRows(CALIBRATIONS, `${eq("id", existing.id)}`, values, options);
    cal = Object.assign(existing, wroteOne(rows));
  } else {
    cal = await upsertCalibration(user, row, calibrations, areaIndex, level, values, options);
  }
  const graded = await OM.grade({ area: area.area, question: source.question, level,
    sample: source.sample_response, answer: said }, credentials, options);
  if (graded) {
    const rows = await patchRows(CALIBRATIONS, `${eq("id", cal.id)}`, { graded_level: graded.level,
      grade_confidence: graded.confidence, grade_rationale: graded.rationale }, options);
    Object.assign(cal, wroteOne(rows));
  }
  const out = { graded_level: cal.graded_level, grade_confidence: cal.grade_confidence, grade_rationale: cal.grade_rationale,
    calibrations: [publicRow(cal)] };
  // One follow-up, at the level the grade found, when it disagrees with the
  // self-rating and this was the area's first question. It is written from
  // what they said, and it is stored unanswered so a reload, or a walk to
  // another area and back, finds the same question waiting.
  const first = prior.length === 0 || (prior.length === 1 && prior[0].id === cal.id);
  if (first && graded && Math.abs(graded.level - self) >= 25 && graded.level !== level) {
    const made = await OM.followUp({ reader: readerOf(row, calibrations), area: area.area, parent_field: area.parent_field || "",
      question: source.question, level, self_level: self, answer: said, graded_level: graded.level,
      graded_rationale: graded.rationale, sample: source.sample_response }, credentials, options);
    const fallback = questionAt(row.analysis, areaIndex, graded.level);
    const next = made || (fallback ? fallback.question : null);
    if (next) {
      const pending = await upsertCalibration(user, row, calibrations, areaIndex, graded.level, {
        area: area.area, parent_field: area.parent_field, self_level: self,
        question: next.question, sample_response: next.sample_response || "",
        answer: "", answered_at: null, graded_level: null, grade_confidence: null, grade_rationale: "" }, options);
      out.follow_up = { question_level: graded.level, question: next.question, generated: Boolean(made) };
      out.calibrations.push(publicRow(pending));
    }
  }
  return out;
}

// Upsert on the table's own unique key: a caller array that has gone stale
// must not turn a re-answer into a 409, which the page would show as the
// gateway's "credit exhausted" rather than as the answer landing.
async function upsertCalibration(user, row, calibrations, areaIndex, level, values, options) {
  const rows = await insertRows(CALIBRATIONS, [{ onboarding_id: row.id, user_id: user.id, area_index: areaIndex,
    question_level: level, ...values }], { ...options,
    query: "on_conflict=onboarding_id,area_index,question_level",
    prefer: "resolution=merge-duplicates,return=representation" });
  const cal = wroteOne(rows);
  // By id, not by identity: the row came back over the wire, so it is never
  // the same object the caller already holds for a re-answered question.
  const at = calibrations.findIndex((c) => c.id === cal.id);
  if (at < 0) calibrations.push(cal); else calibrations[at] = cal;
  return cal;
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
  if (!row.direction || !Array.isArray(row.subgoals) || !row.subgoals.length) throw fail("Settle the subgoals first", 409);
  if (Array.isArray(row.todos) && row.todos.length && !(body && body.regenerate)) return { todos: row.todos, name: row.project_name };
  const reader = readerOf(row, calibrations);
  const made = await OM.todos({ reader, paper: paperOf(row), direction: row.direction, subgoal: row.subgoals[0],
    resources: row.leveled ? row.leveled.assets : [] }, credentials, options);
  await patch(row, { todos: made.todos, goal_chosen: row.direction.title, project_name: row.project_name || made.name,
    step: Math.max(Number(row.step) || 0, STEP.todos) }, options);
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
  const d = row.direction || {};
  const label = one(d.title || row.goal_chosen, 200);
  const rows = Array.isArray(row.todos) ? row.todos : [];
  // One goal -- the direction -- with its three pieces beneath it; the rows
  // live on the first piece, which is the one they start on.
  const subgoals = (Array.isArray(row.subgoals) ? row.subgoals : []).map((g, i) => ({
    label: g.label, description: g.description || "", why: g.why || "", todos: i === 0 ? rows : [] }));
  const description = [d.what_you_would_make || row.project_draft, d.why_it_fits,
    paper.title ? `Building on “${paper.title}” — ${paper.one_liner}` : "",
    row.asset_chosen ? `Starting from ${row.asset_chosen.title}${row.asset_chosen.links && row.asset_chosen.links[0] ? ` <${row.asset_chosen.links[0].url}>` : ""}.` : "",
    row.interest ? `What drew them: ${row.interest}` : ""].filter(Boolean).join("\n\n");
  const payload = {
    name: row.project_name,
    plan: { description, unsure: [] },
    goals: label ? [{ label, why: one(d.why_it_fits, 300) }] : [],
    chosen: label,
    todos: subgoals.length ? [] : rows,
    subgoals,
    reader: { name: reader.name, year: reader.year, major: reader.major, level: depth.hc, knowledge: reader.knowledge },
  };
  if (row.paper_id) {
    payload.paper = { paper_id: row.paper_id, title: paper.title, url: row.project_url || "" };
    payload.provenance = { papers: [{ paper_id: row.paper_id, title: paper.title }],
      idea: { title: label, inspired: paper.title } };
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
  if (body && Array.isArray(body.todos)) values.todos = body.todos.map((t) => one(t, 300)).filter(Boolean).slice(0, 4);
  // Checked against what the record WOULD be, and only then written to it: a
  // rejected create must leave the row exactly as the reader left it.
  const merged = { ...row, ...values };
  if (!merged.project_name) throw fail("Name this project first", 400);
  if (!merged.direction || !merged.direction.title) throw fail("Settle the direction first", 400);
  if (!Array.isArray(merged.subgoals) || merged.subgoals.length < 3) throw fail("Settle the subgoals first", 400);
  if (!Array.isArray(merged.todos) || merged.todos.length < 2) throw fail("At least two todos", 400);
  values.goal_chosen = merged.direction.title;
  Object.assign(row, values);
  const payload = SetupChat.normalizePayload(toPayload(row, calibrations));
  const saved = await rpc("engelbart_save_pending_setup", { p_user_id: user.id, p_payload: payload }, options);
  const pendingId = typeof saved === "string" ? saved : (saved && saved.id) || null;
  const profileSaved = await saveProfile(user, payload.reader, options);
  await patch(row, { ...values, status: "created", pending_setup_id: pendingId, step: STEP.done }, options);
  return { ok: true, pending_setup_id: pendingId, profile_saved: profileSaved };
}

module.exports = {
  STEP, STEP_FIELDS, RUNNING_STALE_MS, MAX_PDF_BYTES,
  open, reset, step, sources, analysis, answer, details, goals, todos, ask, create,
  assets: assetsAction, topicsDone, leveled: leveledAction, brainstorm: brainstormAction, assetAsk, chooseAsset,
  direction: directionAction, subgoals: subgoalsAction,
  areaLevels, knowledgeOf, assessedDepth, readerOf, toPayload, analysisRunning, publicRow,
  compileAssessment, verifyLinks, findAsset, userTurnText,
};
