"use strict";

// The web half of the setup conversation. This is a port of the contract in
// hc/src/human_compact/trajectory/setup_chat.py (claude-plugins repo), which
// remains the source of truth: the CLI re-runs everything a member approves
// here through that module's commit(), so fidelity here only has to be
// display-grade -- but the FORM prompt and the caps are kept verbatim so the
// two surfaces put the same conversation to the same model.

const crypto = require("node:crypto");

const MAX_SAY = 1200;
const MAX_TITLE = 200;
const MAX_LABEL = 200;
const MAX_WHY = 300;
const MAX_LINE_VALUE = 600;
const MAX_TODO = 300;
const MAX_TURNS = 40;
const MAX_TURN_TEXT = 2000;
const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 8;
const MAX_PLAN = 2400;
const MAX_UNSURE = 6;
const MAX_GOALS = 8;
const MAX_TODOS = 20;
const MAX_SUBGOALS = 6;
const MAX_NAME = 80;

const CARDS = ["questions", "plan", "goals", "todos", "none"];
const KINDS = ["mcq", "select_all", "free", "open"];
const CHOICES = ["mcq", "select_all"];
const ORDER = ["questions", "plan", "goals", "todos"];
const MIN_QUESTION_ROUNDS = 1;

// The proxy serves dated model ids only (see scripts/verify-proxy.mjs); the
// bare alias a member's own subscription understands is not one the gateway
// answers to. Picked when the account's model list names no sonnet of its own.
const FALLBACK_MODEL = "claude-sonnet-4-5-20250929";
const MAX_REPLY_TOKENS = 4096;
const TURN_TIMEOUT_MS = 90 * 1000;

// Verbatim from setup_chat.py FORM. Any edit belongs there first.
const FORM = [
  "You are setting up a new project in Engelbart with someone who has just",
  "installed it. They have written nothing down yet. Your job is to end up",
  "with a plan they approve, one goal they want to start on, and the TODO",
  "rows for it -- and to get there in as few rounds as the work allows.",
  "",
  "Reply with ONE JSON object and nothing else:",
  "",
  '  {"say": "<what you say to them, plain prose>",',
  '   "card": "questions" | "plan" | "goals" | "todos" | "none",',
  '   "questions": {"eyebrow": "<two or three words>",',
  '                 "items": [{"id": "<short slug>",',
  '                            "type": "mcq" | "select_all" | "free"',
  '                                    | "open",',
  '                            "title": "<the question>",',
  '                            "subtitle": "<optional, e.g. pick any>",',
  '                            "options": [{"label": "<the choice>",',
  '                                        "why": "<optional: what it',
  '                                                buys them>"}],',
  '                            "placeholder": "<free and open>"}]},',
  '   "plan": {"description": "<a short paragraph or two: what you think',
  '                            they are doing and what done looks like>",',
  '            "unsure": ["<something you could not settle from what they',
  '                        said, in their terms>"]},',
  '   "goals": [{"label": "<an outcome, not a task>",',
  '              "why": "<why this one is worth starting on>"}],',
  '   "subgoals": [{"label": "<a piece of the chosen goal>",',
  '                 "todos": ["<one row of work in that piece>"]}],',
  '   "todos": ["<or, where it does not break down, just the rows>"]}',
  "",
  "Only the key for the card you name is read; leave the others out.",
  "",
  "The plan is prose and doubts, not a form. Say what you think the work",
  "is in a couple of short paragraphs they could argue with, then list what",
  "you could not settle -- that list is what tells them whether you",
  "understood them or guessed, so write the real gaps and not none.",
  "",
  "The order this normally goes in: questions, questions again if the",
  "answers opened something, then plan, then goals, then todos. Do not",
  "skip ahead to a plan you cannot write from what they have told you, and",
  "do not ask a third round of questions to avoid writing one.",
  "",
  "Questions are for what changes your proposal, never for what you could",
  "assume. Pick the kind by what you are actually asking for:",
  "",
  "  mcq         one answer out of several you can name",
  "  select_all  any number of them -- say so in the subtitle",
  "  free        one line they have to write; give a placeholder",
  "  open        a paragraph: the story, the constraint nobody wrote down",
  "",
  "An option may carry a `why`. Use it when the options are proposals of",
  "yours rather than facts of theirs -- \"which of these is the right one",
  "to start on\" is an mcq whose rows each say what that choice buys them,",
  "so they are choosing between arguments instead of guessing what you",
  "meant. Leave `why` out when the answer is simply something they know.",
  "",
  "How many is your judgement, not a rule. Two or three in a round reads",
  "as a conversation; six reads as a form and people abandon forms. If one",
  "question would change everything you propose, ask it alone. If you",
  "genuinely need another round after this one, take it -- but do not take",
  "one to put off writing a plan you could already write.",
  "",
  "A goal is an outcome someone could tell you they had reached. A TODO row",
  "is one piece of work, in the imperative, that a coding agent could pick",
  "up and finish. Neither is a phase, a heading or a category.",
  "",
  "On the todos card, break the chosen goal into its pieces and put the",
  "rows under the piece they belong to -- two to four pieces is usually",
  "the shape of it, and a list of twelve rows in one heap is a list nobody",
  "reads. A piece is still an outcome, smaller. Where the work genuinely",
  "does not break down, send the rows flat instead and say so.",
  "",
  "Nothing you propose is saved until they approve it, so propose the thing",
  "you actually think rather than the safe version of it.",
];

const DUE = {
  questions: "ask your questions -- this is a questions card",
  plan: "write the plan: this card is the plan and nothing else",
  goals: "offer the goals, as a goals card",
  todos: "break the chosen goal into rows, as a todos card",
};

function one(value, cap) {
  return String(value == null ? "" : value).split(/\s+/).filter(Boolean).join(" ").slice(0, cap);
}

function long(value, cap) {
  const lines = String(value == null ? "" : value).split(/\r?\n/)
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "));
  const out = [];
  let blank = false;
  for (const line of lines) {
    if (!line) { blank = true; continue; }
    if (out.length && blank) out.push("");
    blank = false;
    out.push(line);
  }
  return out.join("\n").slice(0, cap);
}

function stageOf(shown) {
  const drawn = (Array.isArray(shown) ? shown : []).filter((c) => ORDER.includes(c));
  const rounds = drawn.filter((c) => c === "questions").length;
  if (rounds < MIN_QUESTION_ROUNDS) return "questions";
  for (const card of ORDER.slice(1)) {
    if (!drawn.includes(card)) return card;
  }
  return "none";
}

function compose(transcript, extra) {
  const lines = FORM.concat(["", "# The conversation so far", ""]);
  const rows = (Array.isArray(transcript) ? transcript : [])
    .filter((row) => row && typeof row === "object");
  for (const row of rows.slice(-MAX_TURNS)) {
    const who = String(row.role || "") === "you" ? "them" : "you";
    const text = String(row.text || "").trim().slice(0, MAX_TURN_TEXT);
    if (text) lines.push(`${who}: ${text}`, "");
  }
  return lines.concat(Array.isArray(extra) ? extra : []);
}

function candidates(value) {
  const out = [];
  for (const row of Array.isArray(value) ? value : []) {
    let label = "";
    let why = "";
    if (row && typeof row === "object") {
      label = one(row.label, MAX_LABEL);
      why = one(row.why, MAX_WHY);
    } else if (typeof row === "string") {
      label = one(row, MAX_LABEL);
    } else continue;
    if (!label) continue;
    out.push({ label, why });
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function normalizeQuestions(value) {
  value = value && typeof value === "object" ? value : {};
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(value.items) ? value.items : []) {
    if (!row || typeof row !== "object") continue;
    const title = one(row.title, MAX_TITLE);
    if (!title) continue;
    let kind = String(row.type || "").trim().toLowerCase();
    const options = candidates(row.options || row.candidates);
    if (!KINDS.includes(kind) || (CHOICES.includes(kind) && !options.length)) kind = "free";
    let qid = one(row.id, 40);
    while (!qid || seen.has(qid)) qid = `q${crypto.randomBytes(3).toString("hex")}`;
    seen.add(qid);
    out.push({
      id: qid,
      type: kind,
      title,
      subtitle: one(row.subtitle, 80),
      options: CHOICES.includes(kind) ? options : [],
      placeholder: one(row.placeholder, MAX_TITLE),
    });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return { eyebrow: one(value.eyebrow, 40) || "a few questions", items: out };
}

function normalizePlan(value) {
  value = value && typeof value === "object" ? value : {};
  let said = long(value.description || value.head, MAX_PLAN);
  if (!said) {
    const rows = (Array.isArray(value.lines) ? value.lines : [])
      .filter((row) => row && typeof row === "object");
    said = rows.map((row) => one(row.v, MAX_LINE_VALUE)).join(" ").trim();
  }
  const unsure = [];
  for (const row of Array.isArray(value.unsure) ? value.unsure : []) {
    const text = one(row && typeof row === "object" ? row.text : row, MAX_LINE_VALUE);
    if (text) unsure.push(text);
    if (unsure.length >= MAX_UNSURE) break;
  }
  return { description: said, unsure };
}

function normalizeGoals(value) {
  const out = [];
  for (const row of Array.isArray(value) ? value : []) {
    let label = "";
    let why = "";
    if (row && typeof row === "object") {
      label = one(row.label, MAX_LABEL);
      why = one(row.why, MAX_WHY);
    } else if (typeof row === "string") {
      label = one(row, MAX_LABEL);
    } else continue;
    if (!label) continue;
    out.push({ label, why });
    if (out.length >= MAX_GOALS) break;
  }
  return out;
}

function normalizeTodos(value) {
  const out = [];
  for (const row of Array.isArray(value) ? value : []) {
    let text = "";
    if (row && typeof row === "object") text = one(row.text, MAX_TODO);
    else if (typeof row === "string") text = one(row, MAX_TODO);
    else continue;
    if (!text) continue;
    out.push(text);
    if (out.length >= MAX_TODOS) break;
  }
  return out;
}

function normalizeSubgoals(value) {
  const out = [];
  for (const row of Array.isArray(value) ? value : []) {
    if (!row || typeof row !== "object") continue;
    const label = one(row.label || row.title, MAX_LABEL);
    const rows = normalizeTodos(row.todos);
    if (!label || !rows.length) continue;
    out.push({ label, todos: rows });
    if (out.length >= MAX_SUBGOALS) break;
  }
  return out;
}

// The envelope put back around a payload the model returned bare. Read by
// shape, never by hope: the stage check refuses an out-of-turn card, and
// guessing toward the due card would let the discard be walked around.
function named(value) {
  if (Array.isArray(value)) {
    const rows = value.filter((row) => row && typeof row === "object");
    if (rows.length && rows.some((row) => "label" in row || "title" in row)) {
      return { card: "goals", goals: value };
    }
    return { card: "todos", todos: value };
  }
  if (!value || typeof value !== "object") return {};
  if (value.card) return value;
  for (const name of ["questions", "plan", "goals", "todos", "subgoals"]) {
    if (value[name]) {
      return { ...value, card: name === "subgoals" ? "todos" : name };
    }
  }
  if ("items" in value) return { card: "questions", questions: value };
  if ("description" in value || "unsure" in value) return { card: "plan", plan: value };
  return value;
}

function normalizeCard(value) {
  value = named(value);
  value = value && typeof value === "object" ? value : {};
  let card = String(value.card || "").trim().toLowerCase();
  if (!CARDS.includes(card)) card = "none";
  const out = {
    say: one(value.say, MAX_SAY),
    card,
    questions: { eyebrow: "", items: [] },
    plan: { description: "", unsure: [] },
    goals: [],
    todos: [],
    subgoals: [],
  };
  if (card === "questions") {
    out.questions = normalizeQuestions(value.questions);
    if (!out.questions.items.length) out.card = "none";
  } else if (card === "plan") {
    out.plan = normalizePlan(value.plan);
    if (!out.plan.description) out.card = "none";
  } else if (card === "goals") {
    out.goals = normalizeGoals(value.goals);
    if (!out.goals.length) out.card = "none";
  } else if (card === "todos") {
    out.subgoals = normalizeSubgoals(value.subgoals);
    out.todos = normalizeTodos(value.todos);
    if (!out.subgoals.length && !out.todos.length) out.card = "none";
  }
  return out;
}

// The approved payload, bounded before it is stored: the table must never
// hold unbounded model output. The CLI re-normalizes again on import.
function normalizePayload(value) {
  value = value && typeof value === "object" ? value : {};
  return {
    name: one(value.name, MAX_NAME),
    plan: normalizePlan(value.plan),
    goals: normalizeGoals(value.goals),
    chosen: one(value.chosen, MAX_LABEL),
    todos: normalizeTodos(value.todos),
    subgoals: normalizeSubgoals(value.subgoals),
  };
}

function pickModel(models) {
  for (const name of Array.isArray(models) ? models : []) {
    if (typeof name === "string" && name.includes("sonnet") && /\d{8}/.test(name)) {
      return name;
    }
  }
  return FALLBACK_MODEL;
}

// One JSON object out of whatever the model wrote around it.
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
    signal: options.signal || AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = value && value.error && (value.error.message || value.error);
    const error = new Error(one(detail, 200) || `The model gateway answered ${response.status}`);
    error.statusCode = response.status === 401 || response.status === 429 ? 409 : 502;
    throw error;
  }
  const text = (Array.isArray(value.content) ? value.content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n");
  return extractJson(text);
}

// One round: put the conversation to the model, take back one card. The same
// stage forcing, out-of-turn discard, and single retry as setup_chat.ask().
async function turn(input, options = {}) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];
  const due = stageOf(input.shown);
  const extra = due in DUE ? [
    "", "# The card you are writing now", "",
    `Whatever else you say, on this reply you ${DUE[due]}.`,
    "The reader is stepped through four cards in one order --",
    "questions, plan, goals, todos -- and a card out of turn is not",
    "drawn at all, so naming a different one costs them the round.",
  ] : [];
  let raw;
  try {
    raw = await callModel(compose(transcript, extra).join("\n") + "\n", input.credentials, options);
  } catch (error) {
    if (error.statusCode === 409) throw error;
    return { ok: false, error: one(error.message, 200) || "The model could not be reached" };
  }
  let card = normalizeCard(raw);
  if (card.card !== "none" && card.card !== due) {
    const kept = card.say;
    if (!kept) {
      try {
        raw = await callModel(compose(transcript, extra.concat([
          "", `You just replied with a ${card.card} card when the card`
          + ` due is ${due}. That reply was discarded. Write the ${due}`
          + " card.",
        ])).join("\n") + "\n", input.credentials, options);
      } catch { raw = {}; }
      card = normalizeCard(raw);
    }
    if (card.card !== due) {
      card = {
        ...card,
        card: "none",
        questions: { eyebrow: "", items: [] },
        plan: { description: "", unsure: [] },
        goals: [],
        todos: [],
        subgoals: [],
      };
      card.say = card.say || kept;
    }
  }
  if (!card.say && card.card === "none") {
    return { ok: false, error: "the model answered with nothing" };
  }
  return { ...card, ok: true, due };
}

module.exports = {
  FALLBACK_MODEL,
  FORM,
  MAX_TURNS,
  MIN_QUESTION_ROUNDS,
  ORDER,
  compose,
  normalizeCard,
  normalizePayload,
  pickModel,
  stageOf,
  turn,
};
