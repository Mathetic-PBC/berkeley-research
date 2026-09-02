"use strict";

// The onboarding's model calls: one client that speaks Anthropic content
// blocks (the paper travels as a `document`), and one normalizer per reply
// shape. Every reply is model output on its way into the reader's record
// and into later prompts, so all of it is bounded and none of it trusted.

const { pickModel } = require("./setup-chat");
const P = require("./onboarding-prompts");

const MAX_REPLY_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 90 * 1000;
const ANALYZE_TOKENS = 8192;
const ANALYZE_TIMEOUT_MS = 100 * 1000;
const MAX_PAGE_TEXT = 20000;
const LEVELS = [0, 25, 50, 75, 100];

function one(value, cap) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, cap);
}

function long(value, cap) {
  return String(value == null ? "" : value).replace(/\r/g, "").trim().slice(0, cap);
}

function extractJson(text) {
  const value = String(text || "");
  try { return JSON.parse(value); } catch { /* fall through */ }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

async function callModel(request, credentials, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const body = {
    model: pickModel(credentials.models, request.family || "sonnet"),
    max_tokens: request.maxTokens || MAX_REPLY_TOKENS,
    messages: [{ role: "user", content: request.content }],
  };
  if (request.system) body.system = request.system;
  const response = await fetchImpl(`${credentials.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
    body: JSON.stringify(body),
    signal: options.signal || AbortSignal.timeout(request.timeoutMs || MODEL_TIMEOUT_MS),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = value && value.error && (value.error.message || value.error);
    const error = new Error(one(detail, 200) || `The model gateway answered ${response.status}`);
    // 401/429 is the member's key spent or throttled: a 409 the page can
    // show, not a 502 that reads as our outage.
    error.statusCode = response.status === 401 || response.status === 429 ? 409 : 502;
    throw error;
  }
  const text = (Array.isArray(value.content) ? value.content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text || "")).join("\n");
  return extractJson(text);
}

function text(value) {
  return { type: "text", text: value };
}

// --- analysis ---------------------------------------------------------------

function normalizeDate(value) {
  const s = one(value, 10);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return null;
  const [, m, d] = s.split("-").map(Number);
  if (m !== undefined && (m < 1 || m > 12)) return null;
  if (d !== undefined && (d < 1 || d > 31)) return null;
  return s;
}

function normalizeArea(value, index) {
  if (!value || typeof value !== "object") return null;
  const area = one(value.area, 80);
  if (!area) return null;
  const byLevel = new Map();
  for (const q of Array.isArray(value.questions) ? value.questions : []) {
    if (!q || typeof q !== "object") continue;
    const level = Number(q.level);
    if (!LEVELS.includes(level) || byLevel.has(level)) continue;
    const question = long(q.question, 600);
    if (!question) continue;
    byLevel.set(level, { level, capability: P.rung(level).capability,
      question, sample_response: long(q.sample_response, 1200) });
  }
  if (byLevel.size !== 5) return null;
  return {
    index, area,
    parent_field: one(value.parent_field, 80),
    project_role: long(value.project_role, 300),
    granularity_rationale: long(value.granularity_rationale, 300),
    questions: LEVELS.map((level) => byLevel.get(level)),
  };
}

function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const areas = (Array.isArray(raw.areas) ? raw.areas : [])
    .map(normalizeArea).filter(Boolean).slice(0, 4)
    .map((a, index) => ({ ...a, index }));
  if (areas.length < 2) return null;
  return {
    title: one(raw.title, 60),
    one_liner: long(raw.one_liner, 300),
    date: normalizeDate(raw.date),
    areas,
  };
}

// input = {familiarityLabel, familiarityDesc, depthLabel, depthDesc,
//          pdfBase64 | pdfText, urls: [{url, text}]}
async function analyze(input, credentials, options = {}) {
  const { before, after } = P.analyzePrompt(input);
  const urls = (Array.isArray(input.urls) ? input.urls : [])
    .map((u) => `${one(u.url, 500)}\n${long(u.text, MAX_PAGE_TEXT)}`.trim()).filter(Boolean)
    .join("\n\n") || "(none supplied)";
  const tail = after.replace("%URLS%", urls);
  const content = input.pdfBase64
    ? [text(before),
       { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } },
       text(tail)]
    : [text(before + long(input.pdfText, 400000) + tail)];
  const raw = await callModel({ content, family: "sonnet", maxTokens: ANALYZE_TOKENS,
    timeoutMs: ANALYZE_TIMEOUT_MS }, credentials, options);
  const analysis = normalizeAnalysis(raw);
  if (!analysis) {
    const error = new Error("The paper analysis did not come back in a usable shape");
    error.statusCode = 502;
    throw error;
  }
  return analysis;
}

// --- grading ----------------------------------------------------------------

function normalizeGrade(raw) {
  if (!raw || typeof raw !== "object") return null;
  const level = Number(raw.level);
  if (!Number.isFinite(level)) return null;
  const snapped = LEVELS.reduce((best, l) => Math.abs(l - level) < Math.abs(best - level) ? l : best, 0);
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  return { level: snapped, confidence, rationale: one(raw.rationale, 200) };
}

async function grade(input, credentials, options = {}) {
  let raw;
  try {
    raw = await callModel({ content: [text(P.gradePrompt(input))], family: "haiku", maxTokens: 300 },
      credentials, options);
  } catch (error) {
    if (error.statusCode === 409) throw error;
    return null;
  }
  return normalizeGrade(raw);
}

// --- generation -------------------------------------------------------------

const KINDS = ["choice", "multi", "short"];

function normalizeDetails(raw) {
  if (!raw || typeof raw !== "object") return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((q, i) => {
    if (!q || typeof q !== "object") return null;
    const title = one(q.title, 200);
    if (!title) return null;
    const kind = KINDS.includes(q.kind) ? q.kind : "short";
    const options = (Array.isArray(q.options) ? q.options : [])
      // An option is a thing the reader clicks, so only a string (or a
      // {label}) is one; a number or a boolean there is the model losing shape.
      .map((o) => one(o && typeof o === "object" ? o.label : typeof o === "string" ? o : "", 120))
      .filter(Boolean).slice(0, 6);
    const out = { id: one(q.id, 40) || `q${i + 1}`, kind: options.length ? kind : "short", title,
      hint: one(q.hint, 200) };
    if (out.kind === "short") out.placeholder = one(q.placeholder, 120);
    else out.options = options;
    return out;
  }).filter(Boolean).slice(0, 4);
  if (questions.length < 3) return null;
  return { intro: one(raw.intro, 200), questions };
}

function normalizeGoals(raw) {
  if (!raw || typeof raw !== "object") return null;
  const goals = (Array.isArray(raw.goals) ? raw.goals : []).map((g) => {
    if (!g || typeof g !== "object") return null;
    const label = one(g.label, 200);
    return label ? { label, short: one(g.short, 40), why: one(g.why, 300) } : null;
  }).filter(Boolean).slice(0, 4);
  if (goals.length < 4) return null;
  return { goals };
}

function normalizeTodos(raw) {
  if (!raw || typeof raw !== "object") return null;
  const todos = (Array.isArray(raw.todos) ? raw.todos : []).map((t) => one(t, 300)).filter(Boolean).slice(0, 4);
  if (todos.length < 2) return null;
  return { todos, name: one(raw.name, 80) };
}

function normalizeAsk(raw) {
  if (!raw || typeof raw !== "object") return null;
  const answer = long(raw.answer, 1200);
  return answer ? { answer } : null;
}

async function generate(prompt, normalize, credentials, options, what) {
  const raw = await callModel({ content: [text(prompt)], family: "sonnet" }, credentials, options);
  const out = normalize(raw);
  if (!out) {
    const error = new Error(`The ${what} did not come back in a usable shape`);
    error.statusCode = 502;
    throw error;
  }
  return out;
}

const details = (input, c, o) => generate(P.detailsPrompt(input), normalizeDetails, c, o, "questions");
const goals = (input, c, o) => generate(P.goalsPrompt(input), normalizeGoals, c, o, "goals");
const todos = (input, c, o) => generate(P.todosPrompt(input), normalizeTodos, c, o, "todos");
const ask = (input, c, o) => generate(P.askPrompt(input), normalizeAsk, c, o, "answer");

module.exports = {
  LEVELS, MAX_PAGE_TEXT,
  callModel, pickModel, extractJson,
  analyze, grade, details, goals, todos, ask,
  normalizeAnalysis, normalizeGrade, normalizeDetails, normalizeGoals, normalizeTodos, normalizeAsk,
};
