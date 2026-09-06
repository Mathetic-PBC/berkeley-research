"use strict";

// The onboarding's model calls: one client that speaks Anthropic content
// blocks (the paper travels as a `document`), and one normalizer per reply
// shape. Every reply is model output on its way into the reader's record
// and into later prompts, so all of it is bounded and none of it trusted.

const { pickModel } = require("./setup-chat");
const P = require("./onboarding-prompts");
const { telemetry } = require("./telemetry");
const { hostOf, safeUrl } = require("./telemetry/redaction");
const { resolveUpstream } = require("./upstream");

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

// The model boundary. One `model.<purpose>` operation per call, recording
// the request AS SENT (the body below, byte for byte what goes over the wire,
// minus the auth header it never sees; a PDF inside it becomes a size and a
// digest), the provider's raw reply, and the JSON parsed out of it, as three
// separate snapshots. The caller's normalization is a fourth, its own
// operation. Collapsing those into "model output" is what a debugger exists
// to undo, so they stay apart here. Where the request goes (the member's key
// through LiteLLM, or one server key straight to Anthropic) is
// resolveUpstream's decision, and the record says which.
// What each call consumes and produces, by the contract's lineage names
// (api/_lib/lineage.js): the stored values the caller put into the prompt,
// and the value the reply becomes. The `reader` the callers pass is the
// profile with the graded levels folded in; `paper` here is the analysis's
// title and one-liner, so a call that takes them reads `analysis`. A call
// whose prompt also carries a previous answer to revise adds that value in
// `request.reads`.
const LINEAGE = Object.freeze({
  analysis: { reads: ["paper", "links", "profile"], writes: ["analysis"] },
  assets: { reads: ["paper"], writes: ["assets"] },
  leveled: { reads: ["assets", "assessment", "profile", "interest"], writes: ["leveled"] },
  grade: { reads: ["analysis", "calibrations"], writes: ["calibrations"] },
  follow_up: { reads: ["calibrations", "analysis", "profile"], writes: ["calibrations"] },
  brainstorm: { reads: ["profile", "analysis", "assessment", "brief", "turns"], writes: ["turns", "interest"] },
  asset_ask: { reads: ["profile", "analysis", "turns"], writes: ["turns"] },
  direction: { reads: ["profile", "analysis", "interest", "assessment", "turns", "chosen", "leveled"], writes: ["direction"] },
  subgoals: { reads: ["profile", "analysis", "direction", "chosen", "leveled"], writes: ["subgoals"] },
  details: { reads: ["profile", "analysis"], writes: ["details"] },
  goals: { reads: ["profile", "analysis", "details"], writes: ["goals"] },
  todos: { reads: ["profile", "analysis", "direction", "subgoals", "leveled"], writes: ["todos"] },
  ask: { reads: ["profile", "analysis"], writes: ["asks"] },
  rewrite: { reads: ["profile"], writes: [] },
});
function lineageOf(purpose) {
  return LINEAGE[purpose] || { reads: [], writes: [] };
}

async function callModel(request, credentials, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const purpose = request.purpose || "call";
  const lineage = lineageOf(purpose);
  const body = {
    model: pickModel(credentials.models, request.family || "sonnet"),
    max_tokens: request.maxTokens || MAX_REPLY_TOKENS,
    messages: [{ role: "user", content: request.content }],
  };
  if (request.system) body.system = request.system;
  if (request.tools) body.tools = request.tools;
  const upstream = resolveUpstream(credentials, options.env);
  const url = `${upstream.baseUrl}/v1/messages`;
  const timeoutMs = request.timeoutMs || MODEL_TIMEOUT_MS;
  telemetry.protect(credentials.apiKey);
  telemetry.protect(upstream.apiKey);
  return telemetry.runOperation({
    name: `model.${purpose}`, type: "model",
    reads: [lineage.reads, request.reads], writes: [lineage.writes, request.writes],
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": body.model,
      "gen_ai.request.max_tokens": body.max_tokens,
      "server.address": hostOf(upstream.baseUrl),
      "engelbart.model.gateway": upstream.gateway,
      "engelbart.model.purpose": purpose,
      "engelbart.prompt.template": request.template || undefined,
      "engelbart.prompt.edited": request.template ? Boolean(request.templateEdited) : undefined,
      "engelbart.model.family": request.family || "sonnet",
      "engelbart.model.timeout_ms": timeoutMs,
      "engelbart.model.has_system": Boolean(request.system),
      "engelbart.model.tools": Array.isArray(request.tools) ? request.tools.map((t) => String(t && t.name)) : undefined,
      "engelbart.model.content_blocks": Array.isArray(request.content) ? request.content.length : 1,
      "engelbart.model.block_types": Array.isArray(request.content) ? request.content.map((b) => String(b && b.type)) : undefined,
    },
  }, async (op) => {
    op.snapshot("model_request", { url: safeUrl(url), body });
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...upstream.headers },
      body: JSON.stringify(body),
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
    const value = await response.json().catch(() => ({}));
    const usage = value && value.usage && typeof value.usage === "object" ? value.usage : {};
    op.setAttributes({
      "http.response.status_code": response.status,
      "gen_ai.response.model": value && value.model ? String(value.model) : undefined,
      "gen_ai.response.finish_reasons": value && value.stop_reason ? [String(value.stop_reason)] : undefined,
      "gen_ai.usage.input_tokens": usage.input_tokens,
      "gen_ai.usage.output_tokens": usage.output_tokens,
      "engelbart.model.cache_creation_input_tokens": usage.cache_creation_input_tokens,
      "engelbart.model.cache_read_input_tokens": usage.cache_read_input_tokens,
    });
    op.snapshot("model_raw_response", value);
    if (!response.ok) {
      const detail = value && value.error && (value.error.message || value.error);
      const error = new Error(one(detail, 200) || `The model gateway answered ${response.status}`);
      // 401/429 is the member's key spent or throttled: a 409 the page can
      // show, not a 502 that reads as our outage.
      error.statusCode = response.status === 401 || response.status === 429 ? 409 : 502;
      throw error;
    }
    const blocks = Array.isArray(value.content) ? value.content : [];
    const text = blocks
      .filter((block) => block && block.type === "text")
      .map((block) => String(block.text || "")).join("\n");
    const parsed = extractJson(text);
    op.setAttributes({
      "engelbart.model.response_blocks": blocks.length,
      "engelbart.model.response_block_types": blocks.map((b) => String(b && b.type)),
      "engelbart.model.text_chars": text.length,
      "engelbart.model.parsed": parsed !== null,
    });
    op.snapshot("model_parsed_response", parsed);
    return parsed;
  });
}

// The parsed reply becoming the application's bounded shape, as its own
// processing operation: what the model said and what the record will hold
// are two different things, and the difference is visible here.
async function normalized(purpose, raw, normalize) {
  return telemetry.runOperation({
    name: `${purpose}.normalize`, type: "processing", writes: lineageOf(purpose).writes,
    attributes: { "engelbart.model.purpose": purpose, "engelbart.parsed": raw !== null && raw !== undefined },
  }, async (op) => {
    const out = normalize(raw);
    op.setAttribute("engelbart.normalized", out !== null && out !== undefined);
    op.snapshot("normalized_result", out);
    return out;
  });
}

function text(value) {
  return { type: "text", text: value };
}

// The prompt for one call: the function's own text, or -- when the request carried an edited template
// for it (an execution debugger's environment, for the member's own run) -- that template rendered from
// the same input. `template` names the prompt in the operation's record either way, `edited` says which.
function promptFor(key, input, options) {
  const overrides = options && options.promptOverrides;
  const edited = Boolean(overrides && overrides[key] != null && P.TEMPLATES[key] != null);
  return { text: edited ? P.render(key, input, overrides) : P[key](input), template: key, edited };
}

// --- analysis ---------------------------------------------------------------

function normalizeDate(value) {
  // Bounded, then matched whole: truncating first would read "2024-05-01 is
  // my best guess" as a date the model never committed to.
  const s = one(value, 40);
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
  const edited = Boolean(options.promptOverrides && options.promptOverrides.analyzePrompt != null);
  const content = await telemetry.runOperation({
    name: "analysis.construct-request", type: "processing", reads: lineageOf("analysis").reads,
    attributes: {
      "engelbart.analysis.urls": Array.isArray(input.urls) ? input.urls.length : 0,
      "engelbart.analysis.paper_mode": input.pdfBase64 ? "pdf_base64" : "text",
      "engelbart.analysis.pdf_base64_chars": input.pdfBase64 ? String(input.pdfBase64).length : undefined,
      "engelbart.analysis.familiarity": input.familiarityLabel,
      "engelbart.analysis.depth": input.depthLabel,
    },
  }, async () => {
    const { before, after } = P.analyzePrompt(input);
    const urls = (Array.isArray(input.urls) ? input.urls : [])
      .map((u) => `${one(u.url, 500)}\n${long(u.text, MAX_PAGE_TEXT)}`.trim()).filter(Boolean)
      .join("\n\n") || "(none supplied)";
    // The function form: page text we fetched is data, and $&, $` or $' in it
    // would otherwise paste the prompt back into the tag it sits inside.
    const tail = after.replace("%URLS%", () => urls);
    // The paper leads, as the cached prefix the asset hunt shares; the
    // diagnostic's own text follows verbatim, its paper tag pointing up. An
    // edited template is rendered whole, the urls in its slot.
    const body = edited ? P.render("analyzePrompt", { ...input, urls }, options.promptOverrides) : before + "(the paper attached above)" + tail;
    return [...paperPrefix(input), text(body)];
  });
  const raw = await callModel({ content, family: "sonnet", maxTokens: ANALYZE_TOKENS,
    timeoutMs: ANALYZE_TIMEOUT_MS, purpose: "analysis", template: "analyzePrompt", templateEdited: edited }, credentials, options);
  const analysis = await normalized("analysis", raw, normalizeAnalysis);
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
  const pr = promptFor("gradePrompt", input, options);
  try {
    raw = await callModel({ content: [text(pr.text)], family: "haiku", maxTokens: 300, purpose: "grade", template: pr.template, templateEdited: pr.edited },
      credentials, options);
  } catch (error) {
    if (error.statusCode === 409) throw error;
    return null;
  }
  return normalized("grade", raw, normalizeGrade);
}

function normalizeFollowUp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const question = one(raw.question, 400);
  if (!question) return null;
  return { question, sample_response: long(raw.sample_response, 900) };
}

// The one follow-up in an area. A reply the model cannot shape is null: the
// caller falls back to the ladder's own question at the graded level, so a
// flaky model costs the reader a tailored question, never the diagnostic.
async function followUp(input, credentials, options = {}) {
  let raw;
  const pr = promptFor("followUpPrompt", input, options);
  try {
    raw = await callModel({ content: [text(pr.text)], family: "sonnet", maxTokens: 500, purpose: "follow_up", template: pr.template, templateEdited: pr.edited },
      credentials, options);
  } catch (error) {
    if (error.statusCode === 409) throw error;
    return null;
  }
  return normalized("follow_up", raw, normalizeFollowUp);
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

// `purpose` names the model operation (model.<purpose>) and its normalize
// step; `reads` adds to the purpose's lineage the values this one prompt
// also carries (the previous answer a revision starts from).
async function generate(key, input, normalize, credentials, options, what, purpose, reads) {
  const pr = promptFor(key, input, options);
  const raw = await callModel({ content: [text(pr.text)], family: "sonnet", purpose, reads, template: pr.template, templateEdited: pr.edited }, credentials, options);
  const out = await normalized(purpose, raw, normalize);
  if (!out) {
    const error = new Error(`The ${what} did not come back in a usable shape`);
    error.statusCode = 502;
    throw error;
  }
  return out;
}

const details = (input, c, o) => generate("detailsPrompt", input, normalizeDetails, c, o, "questions", "details");
const goals = (input, c, o) => generate("goalsPrompt", input, normalizeGoals, c, o, "goals", "goals");
const todos = (input, c, o) => generate("todosPrompt", input, normalizeTodos, c, o, "todos", "todos");
const ask = (input, c, o) => generate("askPrompt", input, normalizeAsk, c, o, "answer", "ask");

// The screen's passages at another register: Haiku, one call, the same count
// back. A reply of the wrong shape or count is a 502, never a partial swap.
function normalizeRewrite(raw, count) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.texts) || raw.texts.length !== count) return null;
  const texts = raw.texts.map((t) => (typeof t === "string" ? long(t, 2400) : ""));
  return texts.every(Boolean) ? { texts } : null;
}
async function rewrite(input, credentials, options = {}) {
  const pr = promptFor("rewritePrompt", input, options);
  const raw = await callModel({ content: [text(pr.text)], family: "haiku", maxTokens: 6000, purpose: "rewrite", template: pr.template, templateEdited: pr.edited }, credentials, options);
  const out = await normalized("rewrite", raw, (r) => normalizeRewrite(r, input.texts.length));
  if (!out) {
    const error = new Error("The rewrite did not come back in a usable shape");
    error.statusCode = 502;
    throw error;
  }
  return out;
}

// --- the paper as a cached prefix -----------------------------------------------

// The two blocks every whole-paper call begins with. Identical bytes in
// both calls is what lets the second read the first's cache.
function paperPrefix(input) {
  if (input.pdfBase64) {
    return [text(P.PAPER_PREFIX), { type: "document",
      source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 },
      cache_control: { type: "ephemeral" } }];
  }
  return [{ type: "text", text: P.PAPER_PREFIX + "\n\n<paper_text>\n" + long(input.pdfText, 400000) + "\n</paper_text>",
    cache_control: { type: "ephemeral" } }];
}

// --- assets ---------------------------------------------------------------------

const LINK_KINDS = ["live_demo", "source_code", "download", "docs", "paper", "other"];
const AVAILABILITY = ["usable", "partial", "unavailable", "unknown"];
const MAX_ASSETS = 5;
const MAX_CHILDREN = 3;
// "Search quite aggressively": a dozen searches for the hunt, eight for the
// stand-ins, which already know what they are looking for.
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 12 };
const WEB_SEARCH_SMALL = { ...WEB_SEARCH, max_uses: 8 };

function normalizeLink(value) {
  if (!value || typeof value !== "object") return null;
  const url = one(value.url, 500);
  if (!/^https?:\/\//i.test(url)) return null;
  return { kind: LINK_KINDS.includes(value.kind) ? value.kind : "other", url };
}

function normalizeAsset(value, depth) {
  if (!value || typeof value !== "object") return null;
  const title = one(value.title, 120);
  if (!title) return null;
  const out = {
    title,
    description: long(value.description, 900),
    one_liner: one(value.one_liner, 200),
    type: P.ASSET_TYPES.includes(value.type) ? value.type : "other",
    links: (Array.isArray(value.links) ? value.links : []).map(normalizeLink).filter(Boolean).slice(0, 6),
    what_you_can_do_with_it: long(value.what_you_can_do_with_it, 300),
    availability: AVAILABILITY.includes(value.availability) ? value.availability : "unknown",
  };
  if (depth === 0 && Array.isArray(value.children)) {
    const kids = value.children.map((c) => normalizeAsset(c, 1)).filter(Boolean).slice(0, MAX_CHILDREN);
    if (kids.length) out.children = kids;
  }
  if (depth === 1) out.why = one(value.why, 300);
  return out;
}

function normalizeAssets(raw) {
  if (!raw || typeof raw !== "object") return null;
  const assets = (Array.isArray(raw.assets) ? raw.assets : []).map((a) => normalizeAsset(a, 0)).filter(Boolean).slice(0, MAX_ASSETS);
  return { assets };
}

// The mini list the brainstorm is given: names and one-liners, no links.
function briefOf(assets) {
  return (Array.isArray(assets) ? assets : []).map((a) => ({ title: a.title, type: a.type,
    one_liner: a.one_liner || one(a.description, 200) }));
}

function normalizeLeveled(raw) {
  const base = normalizeAssets(raw);
  if (!base) return null;
  return {
    locus: long(raw.locus, 300),
    sticky: (Array.isArray(raw.sticky) ? raw.sticky : []).map((s) => one(s, 160)).filter(Boolean).slice(0, 5),
    assets: base.assets,
  };
}

// The model's own web search, when the gateway forwards it; the same call
// without it when the gateway refuses, and the reply says which.
async function searched(request, credentials, options, tool) {
  try {
    return { raw: await callModel({ ...request, tools: [tool] }, credentials, options), searched: true };
  } catch (error) {
    if (error.statusCode === 409) throw error;
    // The retry is an event inside the workflow, not a node of its own: the
    // second model call that follows is the node.
    const parent = telemetry.current();
    if (parent) parent.event("model.retry-without-search", { "engelbart.model.purpose": request.purpose || "call",
      "engelbart.model.tool": tool && tool.name, "error.message": String(error && error.message || "").slice(0, 200) });
    return { raw: await callModel(request, credentials, options), searched: false };
  }
}

function shaped(out, what) {
  if (!out) {
    const error = new Error(`The ${what} did not come back in a usable shape`);
    error.statusCode = 502;
    throw error;
  }
  return out;
}

// The asset hunt: the cached paper, the prompt, and the model's own search.
async function assets(input, credentials, options = {}) {
  const pr = promptFor("assetsPrompt", {}, options);
  const content = [...paperPrefix(input), text(pr.text)];
  const got = await searched({ content, family: "sonnet", maxTokens: ANALYZE_TOKENS, timeoutMs: ANALYZE_TIMEOUT_MS, purpose: "assets", template: pr.template, templateEdited: pr.edited },
    credentials, options, WEB_SEARCH);
  const out = shaped(await normalized("assets", got.raw, normalizeAssets), "asset hunt");
  if (!out.assets.length) {
    const error = new Error("The asset hunt found nothing it could name");
    error.statusCode = 502;
    throw error;
  }
  return { ...out, searched: got.searched };
}

async function levelAssets(input, credentials, options = {}) {
  const pr = promptFor("levelPrompt", input, options);
  const got = await searched({ content: [text(pr.text)], family: "sonnet", maxTokens: ANALYZE_TOKENS,
    timeoutMs: ANALYZE_TIMEOUT_MS, purpose: "leveled", template: pr.template, templateEdited: pr.edited }, credentials, options, WEB_SEARCH_SMALL);
  return { ...shaped(await normalized("leveled", got.raw, normalizeLeveled), "leveled resources"), searched: got.searched };
}

// --- brainstorm, direction, subgoals -------------------------------------------

const QUESTION_TYPES = ["mcq", "select_all", "free", "open"];

function normalizeOptions(value) {
  return (Array.isArray(value) ? value : []).map((o) => {
    const label = one(o && typeof o === "object" ? o.label : typeof o === "string" ? o : "", 160);
    return label ? { label, why: one(o && typeof o === "object" ? o.why : "", 240) } : null;
  }).filter(Boolean).slice(0, 6);
}

function normalizeBrainstorm(raw) {
  if (!raw || typeof raw !== "object") return null;
  const say = long(raw.say, 1500);
  const out = { say, card: "none", interest: one(raw.interest, 240), ready: raw.ready === true };
  if (raw.card === "questions" && raw.questions && typeof raw.questions === "object") {
    const items = (Array.isArray(raw.questions.items) ? raw.questions.items : []).map((q, i) => {
      if (!q || typeof q !== "object") return null;
      const title = one(q.title, 300);
      if (!title) return null;
      const type = QUESTION_TYPES.includes(q.type) ? q.type : "free";
      const item = { id: one(q.id, 40) || `q${i + 1}`, type, title, subtitle: one(q.subtitle, 160) };
      if (type === "mcq" || type === "select_all") {
        item.options = normalizeOptions(q.options);
        if (item.options.length < 2) { item.type = "free"; delete item.options; }
      }
      if (item.type === "free" || item.type === "open") item.placeholder = one(q.placeholder, 120);
      return item;
    }).filter(Boolean).slice(0, 2);
    if (items.length) { out.card = "questions"; out.questions = { eyebrow: one(raw.questions.eyebrow, 40), items }; }
  } else if (raw.card === "focus" && raw.focus && typeof raw.focus === "object") {
    const options = normalizeOptions(raw.focus.options);
    if (options.length >= 2) { out.card = "focus"; out.focus = { title: one(raw.focus.title, 200), options }; }
  }
  if (!say && out.card === "none") return null;
  return out;
}

function normalizeDirection(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = one(raw.title, 80);
  if (!title) return null;
  return { title, what_you_would_make: long(raw.what_you_would_make, 600),
    uses: (Array.isArray(raw.uses) ? raw.uses : []).filter((u) => typeof u === "string").map((u) => one(u, 120)).filter(Boolean).slice(0, 6),
    why_it_fits: long(raw.why_it_fits, 400), first_visible_result: one(raw.first_visible_result, 240) };
}

function normalizeSubgoals(raw) {
  if (!raw || typeof raw !== "object") return null;
  const subgoals = (Array.isArray(raw.subgoals) ? raw.subgoals : []).map((g) => {
    if (!g || typeof g !== "object") return null;
    const label = one(g.label, 200);
    return label ? { label, description: long(g.description, 500), why: one(g.why, 300) } : null;
  }).filter(Boolean).slice(0, 3);
  if (subgoals.length < 3) return null;
  return { subgoals };
}

const brainstorm = (input, c, o) => generate("brainstormPrompt", input, normalizeBrainstorm, c, o, "brainstorm turn", "brainstorm");
// The asset asked about came from the fitted list when there is one, else from the hunt.
const assetAsk = (input, c, o) => generate("assetAskPrompt", input, normalizeAsk, c, o, "answer", "asset_ask", [input.from === "assets" ? "assets" : "leveled"]);
const direction = (input, c, o) => generate("directionPrompt", input, normalizeDirection, c, o, "direction", "direction", input.previous ? ["direction"] : []);
const subgoals = (input, c, o) => generate("subgoalsPrompt", input, normalizeSubgoals, c, o, "subgoals", "subgoals", input.previous ? ["subgoals"] : []);

module.exports = {
  LEVELS, LINEAGE, MAX_PAGE_TEXT,
  callModel, pickModel, extractJson, promptFor,
  analyze, grade, followUp, rewrite, details, goals, todos, ask, assets, levelAssets, brainstorm, assetAsk, direction, subgoals,
  paperPrefix, briefOf,
  normalizeAnalysis, normalizeGrade, normalizeFollowUp, normalizeRewrite, normalizeDetails, normalizeGoals, normalizeTodos, normalizeAsk,
  normalizeAssets, normalizeLeveled, normalizeBrainstorm, normalizeDirection, normalizeSubgoals,
};
