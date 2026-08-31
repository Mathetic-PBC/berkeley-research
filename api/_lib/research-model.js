"use strict";

// The model-backed half of onboarding: turn a real Berkeley lab into concrete
// project ideas, refine a chosen idea, and expand it into a four-lane path.
// Every call is grounded in a lab record refetched from the database by the
// caller (authoritative real data, not client-supplied context) and billed to
// the member's own credit key through the same LiteLLM Messages proxy the
// setup conversation uses. `pickModel` is shared with setup-chat; the small
// call/extract/bound helpers are local so this module can be tested with an
// injected fetch and never has to touch the setup_chat card machine.

const { pickModel } = require("./setup-chat");

const MAX_REPLY_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 90 * 1000;

const MAX_TITLE = 120;
const MAX_TEXT = 600;
const MAX_ROW = 240;
const MAX_IDEAS = 6;
const MAX_ROWS = 6;
const MAX_AREAS = 4;
const LANES = ["brainstorm", "understand", "implement", "apply"];

function one(value, cap) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, cap);
}

// A row may carry a second, quieter line after a newline (main \n sub); keep
// that shape but bound both halves.
function row(value) {
  const text = String(value == null ? "" : value).replace(/\r/g, "").trim();
  const [main, ...rest] = text.split("\n");
  const sub = rest.join(" ").replace(/\s+/g, " ").trim();
  const cleanMain = one(main, MAX_ROW);
  if (!cleanMain) return null;
  return sub ? `${cleanMain}\n${one(sub, MAX_ROW)}` : cleanMain;
}

function rows(value) {
  return (Array.isArray(value) ? value : [])
    .map(row)
    .filter(Boolean)
    .slice(0, MAX_ROWS);
}

function extractJson(text) {
  const value = String(text || "");
  try { return JSON.parse(value); } catch { /* fall through */ }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

async function callModel(prompt, credentials, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${credentials.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify({
      model: pickModel(credentials.models),
      max_tokens: MAX_REPLY_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: options.signal || AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = value && value.error && (value.error.message || value.error);
    const error = new Error(one(detail, 200) || `The model gateway answered ${response.status}`);
    // 401/429 from the gateway means the member's key is spent or throttled --
    // a 409 the browser can show, not a 502 that reads as our outage.
    error.statusCode = response.status === 401 || response.status === 429 ? 409 : 502;
    throw error;
  }
  const text = (Array.isArray(value.content) ? value.content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n");
  return extractJson(text);
}

// A compact, real-data description of the lab the model must stay grounded in.
function labContext(lab) {
  const pi = (lab && lab.pi) || {};
  const projects = Array.isArray(lab && lab.projects) ? lab.projects.slice(0, 8) : [];
  const members = Array.isArray(lab && lab.members) ? lab.members.slice(0, 12) : [];
  const lines = [
    `Lab: ${one(pi.lab_name, MAX_TITLE) || "(unnamed lab)"}`,
    `Principal investigator: ${one(pi.name, MAX_TITLE)}${pi.title ? ` (${one(pi.title, 80)})` : ""}`,
    pi.department ? `Department: ${one(pi.department, MAX_TITLE)}` : "",
    Array.isArray(pi.interests) && pi.interests.length
      ? `Interests: ${pi.interests.map((x) => one(x, 60)).filter(Boolean).join(", ")}` : "",
    one(pi.bio, MAX_TEXT) ? `About the PI: ${one(pi.bio, MAX_TEXT)}` : "",
    projects.length ? "Real projects in this lab:" : "",
    ...projects.map((p) => `- ${one(p.title, MAX_TITLE)}${p.description ? `: ${one(p.description, 200)}` : ""}`),
    members.length ? `PhD researchers (names only; treat their focus as open): ${members.map((m) => one(m.name, 60)).filter(Boolean).join(", ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const JSON_ONLY = "Reply with ONE JSON object and nothing else -- no prose, no code fence.";

// The visible "research areas" are semantic clusters over the REAL labs an
// interest retrieved -- never departments. The model only names and groups;
// the labs beneath every area stay the authoritative rows the caller passed in.
// Labs are referenced by list index (short, hard to mangle) and mapped back to
// their real pi_id server-side, so the model can never invent a lab that isn't
// in the retrieval set.
function labMenu(labs) {
  return labs.map((lab, i) => {
    const interests = Array.isArray(lab.interests)
      ? lab.interests.map((x) => one(x, 50)).filter(Boolean).slice(0, 5).join(", ") : "";
    return `[${i}] ${one(lab.lab_name, MAX_TITLE) || "(unnamed lab)"}`
      + ` -- ${one(lab.pi_name, 80)}${lab.department ? `, ${one(lab.department, 80)}` : ""}`
      + (interests ? ` (${interests})` : "");
  }).join("\n");
}

// Keep only areas that name at least one real lab from the retrieval set; map
// the model's indices back to real pi_ids, de-duplicated and in range.
function normalizeAreas(raw, labs) {
  const list = raw && Array.isArray(raw.areas) ? raw.areas : [];
  return list.map((area) => {
    const seen = new Set();
    const piIds = (Array.isArray(area && area.labs) ? area.labs : [])
      .map((n) => labs[Number(n)])
      .filter((lab) => lab && lab.pi_id && !seen.has(lab.pi_id) && seen.add(lab.pi_id))
      .map((lab) => lab.pi_id);
    return {
      label: one(area && area.label, 60),
      summary: one(area && area.summary, 200),
      pi_ids: piIds,
    };
  }).filter((area) => area.label && area.pi_ids.length).slice(0, MAX_AREAS);
}

// Cluster the retrieved labs into ~3 plain-English research areas. Returns
// [{ label, summary, pi_ids }]; the caller rehydrates pi_ids into the real lab
// rows. Falls back to a single "Related work" area over all labs if the model
// gives nothing usable, so an interest that matched real labs never dead-ends.
async function clusterAreas(input, credentials, options = {}) {
  const labs = Array.isArray(input && input.labs) ? input.labs : [];
  if (!labs.length) return [];
  const interest = one(input.interest, 400);
  const prompt = [
    "A student described a research interest. Below are REAL Berkeley labs that matched it.",
    "Group them into about three coherent research areas, each a short plain-English theme",
    "(e.g. \"Neural interfaces\", \"Sensorimotor systems\", \"Assistive robotics\") -- NOT a department name.",
    "Every area must contain only labs from the list, referenced by their [index]. A lab may",
    "sit in one area. It is fine to leave a weakly-related lab out. Do not invent labs or areas.",
    "",
    interest ? `Interest: "${interest}"` : "",
    "",
    "Labs:",
    labMenu(labs),
    "",
    `Give at most ${MAX_AREAS} areas, most relevant first. ${JSON_ONLY}`,
    'Shape: {"areas":[{"label":"short theme","summary":"one line on what ties these labs together",',
    '"labs":[0,3,5]}]}',
  ].filter((line) => line !== null).join("\n") + "\n";

  const areas = normalizeAreas(await callModel(prompt, credentials, options), labs);
  if (areas.length) return areas;
  return [{
    label: "Related work",
    summary: "Berkeley labs whose work connects to your interest.",
    pi_ids: labs.map((lab) => lab.pi_id).filter(Boolean),
  }];
}

function normalizeIdeas(raw) {
  const list = raw && Array.isArray(raw.ideas) ? raw.ideas : [];
  return list.map((idea) => ({
    title: one(idea && idea.title, MAX_TITLE),
    what: one(idea && idea.what, MAX_TEXT),
    why: one(idea && idea.why, MAX_TEXT),
    inspired: one(idea && idea.inspired, MAX_TITLE),
  })).filter((idea) => idea.title && idea.what).slice(0, MAX_IDEAS);
}

async function generateIdeas(input, credentials, options = {}) {
  const lab = input.lab || {};
  const interest = one(input.interest, 400);
  const prompt = [
    "You help an undergraduate find a concrete, buildable research project inside a specific Berkeley lab.",
    "Ground every idea in the lab's REAL work below. Do not invent papers, results, or people.",
    "Each idea is something a motivated student could genuinely start in about two weeks -- a tool,",
    "a visualization, a dataset, a reproduction, a small experiment -- that plausibly helps this lab.",
    "",
    labContext(lab),
    "",
    interest ? `The student described their interest as: "${interest}". Favor ideas that connect to it.` : "",
    "",
    `Propose ${MAX_IDEAS} ideas. ${JSON_ONLY}`,
    'Shape: {"ideas":[{"title": "...", "what": "one sentence on what to build",',
    '"why": "one sentence on why it helps / what the student gains",',
    '"inspired": "which real project or theme above it builds on"}]}',
  ].filter((line) => line !== null).join("\n") + "\n";
  return normalizeIdeas(await callModel(prompt, credentials, options));
}

function normalizeRefine(raw, fallback) {
  const idea = (fallback && typeof fallback === "object") ? fallback : {};
  return {
    title: one(raw && raw.title, MAX_TITLE) || one(idea.title, MAX_TITLE),
    description: one(raw && raw.description, MAX_TEXT) || one(idea.description || idea.what, MAX_TEXT),
    say: one(raw && raw.say, MAX_TEXT) || "Folded in -- the description above is updated.",
  };
}

async function refineIdea(input, credentials, options = {}) {
  const lab = input.lab || {};
  const idea = input.idea || {};
  const note = one(input.note, 400);
  const prompt = [
    "You are refining a student's project idea in conversation. Keep it grounded in the lab below.",
    "",
    labContext(lab),
    "",
    `Current idea title: ${one(idea.title, MAX_TITLE)}`,
    `Current description: ${one(idea.description || idea.what, MAX_TEXT)}`,
    "",
    `The student asked: "${note}". Fold that into the idea -- adjust scope, method, or framing as asked,`,
    "without drifting from what the lab actually does.",
    "",
    `${JSON_ONLY}`,
    'Shape: {"title": "updated (or unchanged) title", "description": "updated description",',
    '"say": "one short sentence telling the student what you changed"}',
  ].join("\n") + "\n";
  return normalizeRefine(await callModel(prompt, credentials, options), idea);
}

function normalizePath(raw, idea) {
  const source = raw && typeof raw === "object" ? raw : {};
  const lanes = source.lanes && typeof source.lanes === "object" ? source.lanes : {};
  const out = {
    name: one(source.name, 80) || one(idea && (idea.title || idea.name), 80),
    objective: one(source.objective, MAX_TEXT) || one(idea && (idea.description || idea.what), MAX_TEXT),
    lanes: {},
  };
  for (const lane of LANES) out.lanes[lane] = rows(lanes[lane]);
  return out;
}

async function generatePath(input, credentials, options = {}) {
  const lab = input.lab || {};
  const idea = input.idea || {};
  const interest = one(input.interest, 400);
  const prompt = [
    "Turn a chosen project idea into a four-lane path a student can actually follow.",
    "The lanes are fixed and mean:",
    "- brainstorm: open questions and directions to explore first (this can change as they learn).",
    "- understand: what to read, learn, or reproduce -- reference the lab's REAL projects/PI where apt.",
    "- implement: concrete build steps to a first working version.",
    "- apply: how to share it back with the lab / turn it into a result.",
    "",
    labContext(lab),
    "",
    `Chosen idea: ${one(idea.title, MAX_TITLE)} -- ${one(idea.description || idea.what, MAX_TEXT)}`,
    interest ? `Student interest: "${interest}".` : "",
    "",
    `Give ${MAX_ROWS} or fewer short rows per lane. A row may use "\\n" to add a quieter second line.`,
    `Also suggest a short project name and a one-line objective. ${JSON_ONLY}`,
    'Shape: {"name": "...", "objective": "...", "lanes": {"brainstorm": ["..."], "understand": ["..."],',
    '"implement": ["..."], "apply": ["..."]}}',
  ].filter(Boolean).join("\n") + "\n";
  return normalizePath(await callModel(prompt, credentials, options), idea);
}

// One row as a single persisted todo line: the quiet second line folds in with
// an em dash, since a stored todo is one line and hc's importer keeps it so.
function flattenRow(value) {
  const text = String(value == null ? "" : value);
  const [main, ...rest] = text.split("\n");
  const cleanMain = one(main, MAX_ROW);
  if (!cleanMain) return "";
  const sub = one(rest.join(" "), MAX_ROW);
  return sub ? `${cleanMain} — ${sub}` : cleanMain;
}

const LANE_LABEL = {
  brainstorm: "Brainstorm",
  understand: "Understand",
  implement: "Implement",
  apply: "Apply",
};

// The whole point of P3: an exploration result (a named idea + the four-lane
// path, as edited in the browser) mapped into the SAME payload vocabulary the
// setup conversation produces -- name / plan / goals / chosen / subgoals -- so
// the install code carries it through hc's existing setup-import + commit with
// no change on the CLI side. The four lanes become the project's four
// subgoals; each lane's rows become that subgoal's todos. The caller should
// still run the result through SetupChat.normalizePayload to bound it.
function explorationToPayload(input) {
  const source = input && typeof input === "object" ? input : {};
  const idea = source.idea && typeof source.idea === "object" ? source.idea : {};
  const lab = source.lab && typeof source.lab === "object" ? source.lab : {};
  const lanes = source.lanes && typeof source.lanes === "object" ? source.lanes : {};

  const name = one(source.name, 80) || one(idea.title || idea.name, 80);
  const objective = one(source.objective, MAX_TEXT) || one(idea.description || idea.what, MAX_TEXT);

  const provenance = [];
  if (one(lab.lab_name, MAX_TITLE)) {
    provenance.push(`Based on ${one(lab.lab_name, MAX_TITLE)}`
      + (one(lab.pi_name, MAX_TITLE) ? `, led by ${one(lab.pi_name, MAX_TITLE)}` : "") + ".");
  }
  if (one(idea.inspired, MAX_TITLE)) provenance.push(`Inspired by ${one(idea.inspired, MAX_TITLE)}.`);
  const description = [objective, provenance.join(" ")].filter(Boolean).join("\n\n");

  const subgoals = LANES
    .map((lane) => ({
      label: LANE_LABEL[lane],
      todos: rows(lanes[lane]).map(flattenRow).filter(Boolean),
    }))
    .filter((subgoal) => subgoal.todos.length);

  return {
    name,
    plan: { description, unsure: [] },
    goals: name ? [{ label: name, why: objective }] : [],
    chosen: name,
    todos: [],
    subgoals,
  };
}

module.exports = {
  clusterAreas,
  generateIdeas,
  refineIdea,
  generatePath,
  explorationToPayload,
  // exported for tests
  labContext,
  normalizeAreas,
  normalizeIdeas,
  normalizeRefine,
  normalizePath,
  LANES,
  MAX_AREAS,
  MAX_IDEAS,
  MAX_ROWS,
};
