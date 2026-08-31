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
// A small, bounded set of the lab's real papers to ground idea/path generation
// (not the whole corpus). The caller orders lab.papers so the highest-priority
// papers -- a curated participant's selection -- come first.
const MAX_CONTEXT_PAPERS = 6;
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
      max_tokens: options.maxTokens || MAX_REPLY_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || MODEL_TIMEOUT_MS),
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
  // A bounded set of the lab's real papers, in the order the caller supplied
  // (curated selection first, when a participant has one). These are real work
  // the model may build ideas on -- never a licence to invent a paper.
  const papers = Array.isArray(lab && lab.papers) ? lab.papers.slice(0, MAX_CONTEXT_PAPERS) : [];
  const lines = [
    `Lab: ${one(pi.lab_name, MAX_TITLE) || "(unnamed lab)"}`,
    `Principal investigator: ${one(pi.name, MAX_TITLE)}${pi.title ? ` (${one(pi.title, 80)})` : ""}`,
    pi.department ? `Department: ${one(pi.department, MAX_TITLE)}` : "",
    Array.isArray(pi.interests) && pi.interests.length
      ? `Interests: ${pi.interests.map((x) => one(x, 60)).filter(Boolean).join(", ")}` : "",
    one(pi.bio, MAX_TEXT) ? `About the PI: ${one(pi.bio, MAX_TEXT)}` : "",
    projects.length ? "Real projects in this lab:" : "",
    ...projects.map((p) => `- ${one(p.title, MAX_TITLE)}${p.description ? `: ${one(p.description, 200)}` : ""}`),
    papers.length ? "Relevant papers from this lab (real work -- ground ideas in these; never invent a paper):" : "",
    ...papers.map((p) => `- ${one(p.title, MAX_TITLE) || "(untitled)"}`
      + `${p.year ? ` (${p.year})` : ""}${p.venue ? `, ${one(p.venue, 80)}` : ""}`),
    members.length ? `PhD researchers (names only; treat their focus as open): ${members.map((m) => one(m.name, 60)).filter(Boolean).join(", ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const JSON_ONLY = "Reply with ONE JSON object and nothing else -- no prose, no code fence.";

const MAX_OWN_INFO = 2000;

// The participant's own project context, when they brought the idea themselves
// ("bring your own project" on the setup page): background they wrote, and the
// paper they attached. One shared block, so refine, path, and the structured
// generator all anchor on the student's own framing the same way.
function ownLines(own) {
  if (!own || typeof own !== "object") return [];
  const lines = [
    "",
    "The student brought this project idea THEMSELVES -- it is their own, not one"
      + " generated from the lab's work. Treat their framing as the anchor and the"
      + " lab data above as supporting context; never steer them back to a lab"
      + " project they did not ask for.",
  ];
  const info = one(own.information, MAX_OWN_INFO);
  if (info) lines.push(`Background the student wrote about it: ${info}`);
  const p = own.paper && typeof own.paper === "object" ? own.paper : null;
  if (p && (p.title || p.url)) {
    lines.push(`They attached the paper "${one(p.title, MAX_TITLE) || "(untitled)"}"`
      + `${p.url ? ` (${one(p.url, MAX_ROW)})` : ""} as a starting point.`);
  }
  return lines;
}

// Every generator writes for the same reader: an undergraduate meeting research
// for the first time, who has not used the lab's tools before. The failure mode
// this guards against is real output like "Baseline Controller in Simulation --
// a working trajectory-tracking controller (computed torque or PD+feedforward)
// for a 6-DOF arm" -- accurate, and useless to that reader.
const BEGINNER_RULES = [
  "Write for an undergraduate doing research for the FIRST time, who has not used"
    + " this lab's tools or methods before:",
  "- Plain words. The first time a tool, method, or acronym appears, say in a few"
    + " words what it is ('MuJoCo (a physics simulator)').",
  "- A step is ONE concrete action with an obvious finish line -- 'Install MuJoCo"
    + " and run its example simulation' -- never a research program disguised as a"
    + " step ('Characterize sim-to-real mismatch').",
  "- The FIRST step must be something they can do today, alone, with a laptop and"
    + " free tools: install something, run an existing example, read one thing,"
    + " reproduce the simplest known result.",
  "- Build one small thing end-to-end before adding breadth or rigor. Ambition"
    + " belongs at the end of the plan, not the start.",
].join("\n");

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
    "Ground every idea in the lab's REAL work below -- its projects AND the papers listed. Let a"
      + " relevant paper or project genuinely shape the idea. Do not invent papers, results, or people.",
    "Each idea is something a motivated student could genuinely start in about two weeks -- a tool,",
    "a visualization, a dataset, a reproduction, a small experiment -- that plausibly helps this lab.",
    "",
    BEGINNER_RULES,
    "Titles are plain English a first-year understands at a glance ('Teach a",
    "simulated robot hand to hold an egg'), never method jargon.",
    "",
    labContext(lab),
    "",
    interest ? `The student described their interest as: "${interest}". Favor ideas that connect to it.` : "",
    "",
    `Propose ${MAX_IDEAS} ideas. ${JSON_ONLY}`,
    'Shape: {"ideas":[{"title": "...", "what": "one sentence on what to build",',
    '"why": "one sentence on why it helps / what the student gains",',
    '"inspired": "the real project, paper, or theme above it builds on"}]}',
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
    ...ownLines(input.own),
    "",
    `The student asked: "${note}". Fold that into the idea -- adjust scope, method, or framing as asked,`,
    "without drifting from what the lab actually does.",
    "Keep the wording at the same level as the current idea: plain English an",
    "undergraduate new to research understands, acronyms briefly explained.",
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
    "- understand: what to read, learn, or reproduce -- reference the lab's REAL papers, projects, or PI where apt.",
    "- implement: concrete build steps to a first working version.",
    "- apply: how to share it back with the lab / turn it into a result.",
    "",
    BEGINNER_RULES,
    'A row\'s optional quieter second line (after "\\n") is the place for the',
    "how or the why -- use it to keep the first line a short plain action.",
    "",
    labContext(lab),
    "",
    `Chosen idea: ${one(idea.title, MAX_TITLE)} -- ${one(idea.description || idea.what, MAX_TEXT)}`,
    interest ? `Student interest: "${interest}".` : "",
    ...ownLines(input.own),
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

// --- the structured project generator (the final "Generate project") --------
//
// Unlike generatePath (flat rows per lane), this produces the workspace's real
// shape: phase-tagged GOALS, each with its own description, purpose and TODOs,
// plus goal-level resources -- a persisted Brainstorm document, and Understand
// goals bound to REAL canonical papers. Papers are chosen ONLY from the lab's
// own paper list, by number, and mapped back to canonical ids server-side, so
// the model can never invent a paper, an id, or an authorship. When the model
// call fails the caller falls back to explorationToPayload's flat lanes.

const MAX_UNDERSTAND = 3;      // key papers to read -- quality over quantity
const MAX_IMPLEMENT = 3;
const MAX_APPLY = 2;
const MAX_GOAL_TODOS = 5;
const MAX_DOC = 6000;

// The lab's real papers as a numbered menu; the model picks by number, exactly
// as labMenu lets it pick labs by index for clusterAreas.
function paperMenu(papers) {
  return papers.map((p, i) =>
    `[${i}] ${one(p.title, MAX_TITLE) || "(untitled)"}`
    + `${p.year ? ` (${p.year})` : ""}${p.venue ? `, ${one(p.venue, 80)}` : ""}`
  ).join("\n");
}

function boundDoc(value) {
  return String(value == null ? "" : value).replace(/\r/g, "").slice(0, MAX_DOC).trim();
}

// A project-SPECIFIC brainstorming document, used only when the model returns
// none. It interpolates the real idea and lab, so it is never the same boiler-
// plate for two projects -- the model normally supplies the tailored version.
function fallbackDoc(ctx) {
  const t = one(ctx.idea && (ctx.idea.title || ctx.idea.name), MAX_TITLE) || "this project";
  const lab = one(ctx.lab && ctx.lab.pi && ctx.lab.pi.lab_name, MAX_TITLE);
  return [
    `# Shaping: ${t}`,
    "",
    "A few questions to figure out what you actually want to build"
      + `${lab ? ` (with ${lab}'s work as the backdrop)` : ""}:`,
    "",
    `- What part of "${t}" sounds most interesting to you?`,
    "- What would you be excited to have working at the end — something you"
      + " could see, run, or play with?",
    "- What would you be curious to change, just to see what happens?",
    lab
      ? `- Would you rather recreate something ${lab} has already done, or try`
        + " your own variation on it?"
      : "- Would you rather recreate something from the research, or try your"
        + " own variation on it?",
    "- How small could the first version be and still feel real to you?",
    "- If it works, what would make you want to keep exploring?",
  ].join("\n");
}

// One todo line, main clause only (a generated goal's rows are single lines).
function todoLines(value) {
  return rows(value).map((r) => one(r.split("\n")[0], MAX_ROW)).filter(Boolean)
    .slice(0, MAX_GOAL_TODOS);
}

// Keep the model's project inside a known shape, grounded in canonical data:
// Understand entries are mapped from paper NUMBERS back to real papers and
// deduplicated; anything that is not a real paper of this lab is dropped.
function normalizeProject(raw, ctx) {
  const src = raw && typeof raw === "object" ? raw : {};
  const papers = Array.isArray(ctx.lab && ctx.lab.papers) ? ctx.lab.papers : [];

  const b = src.brainstorm && typeof src.brainstorm === "object" ? src.brainstorm : {};
  const brainstorm = {
    description: one(b.description, MAX_TEXT),
    purpose: one(b.purpose, MAX_TEXT),
    document_md: boundDoc(b.document_md) || fallbackDoc(ctx),
  };

  const seen = new Set();
  const understand = [];
  for (const u of Array.isArray(src.understand) ? src.understand : []) {
    if (!u || typeof u !== "object") continue;
    const idx = Number(u.paper);
    if (!Number.isInteger(idx) || idx < 0 || idx >= papers.length) continue;
    const p = papers[idx];
    if (!p || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    understand.push({
      paper: {
        paper_id: p.id,
        title: one(p.title, MAX_TITLE),
        url: one(p.doi_url || p.url, MAX_ROW),
      },
      description: one(u.description, MAX_TEXT),
      purpose: one(u.purpose, MAX_TEXT),
      todos: todoLines(u.todos),
    });
    if (understand.length >= MAX_UNDERSTAND) break;
  }

  const goalList = (arr, cap) => {
    const out = [];
    for (const g of Array.isArray(arr) ? arr : []) {
      if (!g || typeof g !== "object") continue;
      const title = one(g.title, MAX_TITLE);
      if (!title) continue;
      out.push({
        title,
        description: one(g.description, MAX_TEXT),
        purpose: one(g.purpose, MAX_TEXT),
        todos: todoLines(g.todos),
      });
      if (out.length >= cap) break;
    }
    return out;
  };

  return {
    brainstorm,
    understand,
    implement: goalList(src.implement, MAX_IMPLEMENT),
    apply: goalList(src.apply, MAX_APPLY),
  };
}

// The student's own attached paper is non-negotiable: whatever papers the model
// chose, their paper reads first. Prepend a deterministic Understand goal when
// the model left it out (the numbered-menu instruction normally suffices).
function forceOwnUnderstand(project, p) {
  if (project.understand.some((u) => u.paper.paper_id === p.id)) return project;
  project.understand.unshift({
    paper: {
      paper_id: p.id,
      title: one(p.title, MAX_TITLE),
      url: one(p.doi_url || p.url, MAX_ROW),
    },
    description: "The paper you attached to this project.",
    purpose: "You picked it as the starting point -- understanding it grounds"
      + " everything you build after.",
    todos: [
      "Read the abstract and introduction, and write three sentences on what the paper does",
      "List each tool or method it uses that is new to you, with a one-line note on what it is",
      "Note the one result that matters most for your project",
    ],
  });
  project.understand = project.understand.slice(0, MAX_UNDERSTAND);
  return project;
}

async function generateProject(input, credentials, options = {}) {
  const lab = input.lab || {};
  const idea = input.idea || {};
  const interest = one(input.interest, 400);
  const papers = Array.isArray(lab.papers) ? lab.papers.slice(0, 20) : [];
  // The caller marks the student's own attached paper with `own: true` (and
  // puts it first, so the slice above can never drop it).
  const ownIdx = papers.findIndex((p) => p && p.own);
  const hints = input.lanes && typeof input.lanes === "object" ? input.lanes : {};
  const hintLines = LANES.map((lane) => {
    const rs = rows(hints[lane]).map((r) => one(r.split("\n")[0], MAX_ROW)).filter(Boolean);
    return rs.length ? `- ${LANE_LABEL[lane]}: ${rs.join("; ")}` : "";
  }).filter(Boolean);

  const prompt = [
    "Turn a chosen research project idea into a COMPLETE structured project for a"
      + " student, grounded ONLY in the real lab data below.",
    "The project has four phases; give concrete GOALS for each (not a flat list).",
    "",
    BEGINNER_RULES,
    "Goal titles are plain-English outcomes ('Get a robot arm moving in"
      + " simulation'), never method names ('Baseline Controller in Simulation').",
    "Each goal is about a week of a beginner's part-time effort; its todos are"
      + " single sittings, ordered easiest first, each starting with a verb and"
      + " naming its finish line.",
    "The first implement goal is the on-ramp: install the tools, run an existing"
      + " example, see SOMETHING work. Rigor (baselines, metrics, validation)"
      + " comes in later goals only.",
    "",
    "The brainstorm \"document_md\" is genuine brainstorming, never a requirements"
      + " interview. Its job is to help the student DISCOVER what they want to"
      + " build -- do not assume they already know the technical shape. It reads"
      + " like two people sitting together figuring out what would be interesting"
      + " to build: a short heading, then 5-6 questions, nothing else.",
    "The questions progress roughly like this, each carrying ONE idea:",
    "1. which part of this idea actually interests them;",
    "2. what they would be excited to have working, see, or interact with;",
    "3. what they are curious to change or experiment with, just to see what happens;",
    "4. whether they would rather recreate/extend the lab's research or try their own variation;",
    "5. how small or ambitious the first version should be;",
    "6. what result or next step would make them want to keep going.",
    "Every question must be answerable by a beginner who does not know the field"
      + " yet, and tailored to THIS idea, lab, papers, and the student's stated"
      + " interest -- specific, never boilerplate, and never copied mechanically"
      + " from the progression above. A short example inside a question is fine"
      + " when it clarifies; a menu of options is not.",
    "NEVER lead with technical decisions the plan can propose later: algorithm or"
      + " controller choices, simulators or libraries, evaluation metrics, numeric"
      + " thresholds, hardware specs, safety limits, deployment formats, benchmark"
      + " design. Nothing that reads like filling out a technical specification.",
    "",
    labContext(lab),
    "",
    papers.length
      ? "Real papers from this lab. Choose Understand papers ONLY from these, by"
        + " their number; NEVER invent a paper, a title, or an id:"
      : "This lab has no papers on record -- return an empty \"understand\" list;"
        + " do not invent papers.",
    papers.length ? paperMenu(papers) : "",
    "",
    `Chosen idea: ${one(idea.title || idea.name, MAX_TITLE)} -- `
      + `${one(idea.description || idea.what, MAX_TEXT)}`,
    idea.inspired ? `It builds on: ${one(idea.inspired, MAX_TITLE)}.` : "",
    interest ? `Student's stated interest: "${interest}".` : "",
    ...ownLines(input.own),
    ownIdx >= 0
      ? `Paper [${ownIdx}] is the one the student attached themselves: it MUST be`
        + ' one of the "understand" entries.'
      : "",
    hintLines.length
      ? "\nThe student sketched these rough directions; use them as hints and refine:"
      : "",
    ...hintLines,
    "",
    "Reply with ONE JSON object of exactly this shape:",
    "{",
    '  "brainstorm": {"description": "one line: what \\"Shape the project\\" means'
      + ' here", "purpose": "why shaping it first matters", "document_md": "the'
      + ' brainstorming page described above: a short heading, then 5-6 tailored'
      + ' questions, nothing else"},',
    '  "understand": [{"paper": <number from the list above>, "description": "what'
      + ' this paper covers that matters here", "purpose": "why understanding it'
      + ' matters for THIS project", "todos": ["read the relevant sections",'
      + ' "identify the core method", "note the finding most relevant to the'
      + ' project"]}],',
    '  "implement": [{"title": "a concrete build/experiment goal for THIS project",'
      + ' "description": "what it produces", "purpose": "why it matters", "todos":'
      + ' ["..."]}],',
    '  "apply": [{"title": "a packaging/outreach goal", "description": "...",'
      + ' "purpose": "...", "todos": ["..."]}]',
    "}",
    `Choose at most ${MAX_UNDERSTAND} of the MOST relevant papers, at most `
      + `${MAX_IMPLEMENT} implement goals, at most ${MAX_APPLY} apply goals. Keep`
      + ` todos few and concrete. ${JSON_ONLY}`,
  ].filter(Boolean).join("\n") + "\n";

  // The reply is the flow's largest by far (a full project with a markdown
  // document): give it token and time headroom the smaller calls don't need,
  // still inside engelbart-setup's 120s maxDuration.
  const raw = await callModel(prompt, credentials, Object.assign(
    { maxTokens: 8192, timeoutMs: 100 * 1000 }, options));
  if (!raw) {
    // A truncated or unparseable reply used to slip through as a near-empty
    // "structured" project (one Shape goal, nothing else). Throwing instead
    // lets the caller degrade to the flat-lane payload, which at least keeps
    // everything the student drafted.
    const error = new Error("The generator's reply was not usable JSON");
    error.statusCode = 502;
    throw error;
  }
  const project = normalizeProject(raw, { lab, idea, interest });
  return ownIdx >= 0 ? forceOwnUnderstand(project, papers[ownIdx]) : project;
}

// The structured project as the pending-setup payload the CLI already imports:
// one phase-tagged subgoal per goal, each carrying its own why/description/todos
// and its goal-level resource (a Brainstorm document, or an Understand paper).
// SetupChat.normalizePayload bounds every field before it is stored.
function structuredToPayload(project, meta) {
  const name = one(meta.name, 80);
  const objective = one(meta.objective, MAX_TEXT);
  const subgoals = [];

  subgoals.push({
    label: "Shape the project",
    phase: "brainstorm",
    why: project.brainstorm.purpose,
    description: project.brainstorm.description,
    document: {
      title: name ? `Shaping: ${name}` : "Shape the project",
      body_md: project.brainstorm.document_md,
    },
    todos: [],
  });
  for (const u of project.understand) {
    subgoals.push({
      label: `Read “${u.paper.title || "this paper"}”`,
      phase: "understand",
      why: u.purpose,
      description: u.description,
      paper: u.paper,
      todos: u.todos,
    });
  }
  for (const g of project.implement) {
    subgoals.push({ label: g.title, phase: "implement", why: g.purpose,
      description: g.description, todos: g.todos });
  }
  for (const g of project.apply) {
    subgoals.push({ label: g.title, phase: "apply", why: g.purpose,
      description: g.description, todos: g.todos });
  }

  const description = [objective, one(meta.provenanceProse, MAX_TEXT)]
    .filter(Boolean).join("\n\n");
  const payload = {
    name,
    plan: { description, unsure: [] },
    goals: name ? [{ label: name, why: objective }] : [],
    chosen: name,
    todos: [],
    subgoals,
  };
  if (meta.provenance && typeof meta.provenance === "object") {
    payload.provenance = meta.provenance;
  }
  return payload;
}

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

  const payload = {
    name,
    plan: { description, unsure: [] },
    goals: name ? [{ label: name, why: objective }] : [],
    chosen: name,
    todos: [],
    subgoals,
  };
  // The canonical paper the chosen goal reads against, when the caller resolved
  // one from the grounding lab. Passed through as-is; SetupChat.normalizePayload
  // validates the id and bounds the text before it is stored.
  if (source.paper && typeof source.paper === "object") payload.paper = source.paper;
  return payload;
}

module.exports = {
  clusterAreas,
  generateIdeas,
  refineIdea,
  generatePath,
  generateProject,
  structuredToPayload,
  explorationToPayload,
  // exported for tests
  labContext,
  normalizeAreas,
  normalizeIdeas,
  normalizeRefine,
  normalizePath,
  normalizeProject,
  LANES,
  MAX_AREAS,
  MAX_IDEAS,
  MAX_ROWS,
  MAX_UNDERSTAND,
};
