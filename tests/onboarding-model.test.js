"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const OM = require("../api/_lib/onboarding-model");
const P = require("../api/_lib/onboarding-prompts");

const CREDS = { apiKey: "k", baseUrl: "https://p", models: ["all-proxy-models"] };

function modelSaying(reply, capture) {
  return async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    if (capture) capture.push({ url, body, headers: init.headers, signal: init.signal });
    return { ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: JSON.stringify(reply) }] }; } };
  };
}

function fiveQuestions() {
  return [0, 25, 50, 75, 100].map((level) => ({
    level, capability: "x", question: `q${level}`, sample_response: `s${level}`,
  }));
}

test("normalizeAnalysis keeps 2-4 areas of exactly five levelled questions", () => {
  const out = OM.normalizeAnalysis({
    title: "A B C D E F", one_liner: "x".repeat(400), date: "2024-13",
    areas: [
      { area: "Transformers", parent_field: "ML", project_role: "r", granularity_rationale: "g",
        questions: fiveQuestions().reverse() },
      { area: "PyTorch", questions: fiveQuestions().concat([{ level: 50, question: "dup" }]) },
      { area: "Short", questions: fiveQuestions().slice(0, 4) },     // dropped: not five
    ],
  });
  assert.equal(out.title, "A B C D E F");
  assert.equal(out.one_liner.length, 300);
  assert.equal(out.date, null);
  assert.equal(out.areas.length, 2);
  assert.deepEqual(out.areas[0].questions.map((q) => q.level), [0, 25, 50, 75, 100]);
  assert.equal(out.areas[0].questions[3].capability, "can_use");
  assert.equal(out.areas[1].parent_field, "");
  assert.equal(OM.normalizeAnalysis({ title: "t", date: "2023-05-01", areas: [] }), null);
  assert.equal(OM.normalizeAnalysis({ title: "t", date: "2023", areas: [
    { area: "one", questions: fiveQuestions() }] }), null);                 // fewer than two

  // Every field the model writes reaches a later prompt, so every one is capped.
  const big = OM.normalizeAnalysis({
    title: "t".repeat(200), one_liner: "o", date: "2024-05-01 is my best guess",
    areas: [
      { area: "a".repeat(200), parent_field: "p".repeat(200), project_role: "r".repeat(900),
        granularity_rationale: "g".repeat(900),
        questions: [0, 25, 50, 75, 100].map((level) => ({
          level, question: "q".repeat(900), sample_response: "s".repeat(2000) })) },
      { area: "B", questions: fiveQuestions() },
    ],
  });
  assert.equal(big.date, null);                                  // prose is not a date
  assert.equal(big.title.length, 60);
  assert.equal(big.areas[0].area.length, 80);
  assert.equal(big.areas[0].parent_field.length, 80);
  assert.equal(big.areas[0].project_role.length, 300);
  assert.equal(big.areas[0].granularity_rationale.length, 300);
  assert.equal(big.areas[0].questions[0].question.length, 600);
  assert.equal(big.areas[0].questions[0].sample_response.length, 1200);
});

test("normalizeGrade snaps to the ladder and bounds the rationale", () => {
  assert.deepEqual(OM.normalizeGrade({ level: 60, confidence: 1.7, rationale: "r".repeat(300) }),
    { level: 50, confidence: 1, rationale: "r".repeat(200) });
  assert.equal(OM.normalizeGrade({ level: "no" }), null);
  assert.equal(OM.normalizeGrade(null), null);
});

test("details, goals, todos and ask are bounded to their shapes", () => {
  const d = OM.normalizeDetails({ intro: "i", questions: [
    { id: "who", kind: "choice", title: "Who?", options: ["me", "team", "", 7] },
    { id: "first", kind: "multi", title: "First?", options: ["a"] },
    { kind: "short", title: "Never?", placeholder: "p", hint: "h" },
    { id: "x", kind: "weird", title: "?" },
    { id: "5", kind: "short", title: "five" }, { id: "6", kind: "short", title: "six" },
  ] });
  assert.equal(d.questions.length, 4);
  assert.deepEqual(d.questions[0].options, ["me", "team"]);
  assert.equal(d.questions[2].id, "q3");
  assert.equal(d.questions[3].kind, "short");                     // unknown kind -> short
  assert.equal(OM.normalizeDetails({ questions: [{ title: "only one" }] }), null); // fewer than 3

  const g = OM.normalizeGoals({ goals: [1, 2, 3, 4, 5].map((n) => ({ label: `g${n}`, short: `s${n}`, why: `w${n}` })) });
  assert.equal(g.goals.length, 4);
  assert.equal(OM.normalizeGoals({ goals: [{ label: "a" }] }), null);

  const t = OM.normalizeTodos({ todos: ["a", "", "b", "c", "d", "e"], name: "n".repeat(100) });
  assert.deepEqual(t.todos, ["a", "b", "c", "d"]);
  assert.equal(t.name.length, 80);
  assert.equal(OM.normalizeTodos({ todos: ["one"] }), null);

  assert.equal(OM.normalizeAsk({ answer: "a".repeat(2000) }).answer.length, 1200);
  assert.equal(OM.normalizeAsk({}), null);
});

test("analyze sends the PDF as a document block where the paper tag sits, and bills the member key", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: "2024", areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  const out = await OM.analyze({
    familiarityLabel: P.FAMILIARITY[1].label, familiarityDesc: P.FAMILIARITY[1].desc,
    depthLabel: P.DEPTHS[0].label, depthDesc: P.DEPTHS[0].desc,
    pdfBase64: "JVBERi0=", urls: [{ url: "https://x.org", text: "page text" }],
  }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  assert.equal(out.areas.length, 2);
  const { body, headers, signal } = calls[0];
  assert.equal(headers.Authorization, "Bearer k");
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.model, "claude-sonnet-4-5-20250929");
  assert.ok(signal instanceof AbortSignal);
  const blocks = body.messages[0].content;
  const doc = blocks.findIndex((b) => b.type === "document");
  assert.equal(doc, 1, "the paper is the cached prefix");
  assert.equal(blocks[doc].source.media_type, "application/pdf");
  assert.match(blocks[doc + 1].text, /<phd_student_paper>\s*\(the paper attached above\)\s*<\/phd_student_paper>/);
  assert.match(blocks[doc + 1].text, /https:\/\/x\.org[\s\S]*page text/);
  assert.match(blocks[doc + 1].text, /I wouldn't know where to start/);
});

test("analyze with text instead of a PDF sends one text block", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: null, areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  await OM.analyze({ familiarityLabel: "f", familiarityDesc: "", depthLabel: "d", depthDesc: "",
    pdfText: "paper words", urls: [] }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  const blocks = calls[0].body.messages[0].content;
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /<paper_text>\s*paper words\s*<\/paper_text>/);
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  assert.match(blocks[1].text, /<phd_student_paper>\s*\(the paper attached above\)/);
});

test("page text cannot rewrite the prompt it is spliced into", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: null, areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  // $&, $` and $' are replacement patterns: a fetched page carrying them can
  // paste the prompt back into itself unless the replacement is a function.
  const hostile = "price $' and $` and $&";
  await OM.analyze({ familiarityLabel: "f", familiarityDesc: "", depthLabel: "d", depthDesc: "",
    pdfBase64: "JVBERi0=", urls: [{ url: "https://shop.example", text: hostile }] },
    CREDS, { fetchImpl: modelSaying(reply, calls) });
  const blocks = calls[0].body.messages[0].content;
  const tail = blocks[blocks.length - 1].text;
  assert.equal(tail.split(hostile).length - 1, 1);
  assert.equal(tail.split("## Project summary").length - 1, 1);
});

test("grade asks haiku and analyze asks sonnet", async () => {
  const calls = [];
  const creds = { ...CREDS, models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"] };
  await OM.grade({ area: "A", question: "q", level: 50, sample: "s", answer: "a" }, creds,
    { fetchImpl: modelSaying({ level: 50, confidence: 0.8, rationale: "ok" }, calls) });
  assert.equal(calls[0].body.model, "claude-haiku-4-5-20251001");
  assert.equal(OM.pickModel(["all-proxy-models"], "haiku"), "claude-haiku-4-5-20251001");
  assert.equal(OM.pickModel(["all-proxy-models"], "sonnet"), "claude-sonnet-4-5-20250929");
});

test("a spent key answers 409, a broken gateway 502, and unparseable JSON is null", async () => {
  await assert.rejects(OM.callModel({ content: [{ type: "text", text: "x" }] }, CREDS, {
    fetchImpl: async () => ({ ok: false, status: 429, async json() { return { error: { message: "budget" } }; } }),
  }), (e) => e.statusCode === 409);
  await assert.rejects(OM.callModel({ content: [{ type: "text", text: "x" }] }, CREDS, {
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }),
  }), (e) => e.statusCode === 502);
  assert.equal(await OM.callModel({ content: [{ type: "text", text: "x" }] }, CREDS, {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { content: [{ type: "text", text: "not json" }] }; } }),
  }), null);
});

test("readerBlock names the person, the register rule, and what they already know", () => {
  const lines = P.readerBlock({ name: "Maya", year: "Second year", major: "Cognitive Science",
    depth: "some", knowledge: [{ area: "Transformers", level: 25 }, { area: "PyTorch", level: 75 }] });
  const text = lines.join("\n");
  assert.match(text, /Maya/);
  assert.match(text, /Cognitive Science/);
  assert.match(text, /Transformers: can follow it \(25\)/i);
  assert.match(text, /PyTorch: can use it \(75\)/i);
  assert.match(text, new RegExp(P.DEPTHS[1].rule.split("\n")[0].slice(0, 20)));
  assert.deepEqual(P.readerBlock({}), []);
});

test("assets are bounded, links must be http(s), children only one level deep and carry a why", () => {
  const out = OM.normalizeAssets({ assets: [
    { title: "Pose viewer", description: "d".repeat(1200), one_liner: "a viewer", type: "demo",
      links: [{ kind: "live_demo", url: "https://x.org/demo" }, { kind: "weird", url: "ftp://nope" }, { kind: "docs", url: "javascript:alert(1)" }],
      what_you_can_do_with_it: "play", availability: "usable",
      children: [{ title: "Toy", type: "dataset", why: "small first", links: [{ kind: "download", url: "https://x.org/toy" }],
        children: [{ title: "too deep", type: "dataset" }] }] },
    { title: "", type: "dataset" },
    { title: "Lib", type: "spaceship", availability: "sort of" },
  ] });
  assert.equal(out.assets.length, 2);
  assert.equal(out.assets[0].description.length, 900);
  assert.equal(out.assets[0].one_liner, "a viewer");
  assert.deepEqual(out.assets[0].links, [{ kind: "live_demo", url: "https://x.org/demo" }]);
  assert.equal(out.assets[0].children.length, 1);
  assert.equal(out.assets[0].children[0].why, "small first");
  assert.equal(out.assets[0].children[0].children, undefined);
  assert.equal(out.assets[1].type, "other");
  assert.equal(out.assets[1].availability, "unknown");
  assert.equal(OM.normalizeAssets(null), null);
  assert.deepEqual(OM.briefOf(out.assets)[0], { title: "Pose viewer", type: "demo", one_liner: "a viewer" });
  const lev = OM.normalizeLeveled({ locus: "geometry", sticky: ["poses", "", "angles"], assets: [{ title: "A" }] });
  assert.deepEqual(lev.sticky, ["poses", "angles"]);
  assert.equal(lev.locus, "geometry");
});

test("a brainstorm turn is prose plus at most one card; a direction needs a title; subgoals come in threes", () => {
  const q = OM.normalizeBrainstorm({ say: "Hi", card: "questions", interest: "poses",
    questions: { eyebrow: "first", items: [
      { id: "a", type: "mcq", title: "Worked with pose data?", options: ["Never", { label: "Some", why: "w" }] },
      { id: "b", type: "select_all", title: "one option only", options: ["x"] },
      { type: "open", title: "Tell me", placeholder: "the story…" }, { title: "" }, { id: "e", type: "free", title: "fourth" }] } });
  assert.equal(q.card, "questions");
  assert.equal(q.questions.items.length, 3);
  assert.equal(q.questions.items[0].options[1].why, "w");
  assert.equal(q.questions.items[1].type, "free", "a choice with one option becomes a line");
  assert.equal(q.questions.items[2].id, "q3");
  assert.equal(q.interest, "poses");
  const f = OM.normalizeBrainstorm({ say: "", card: "focus", focus: { title: "Which?", options: [{ label: "A" }, { label: "B" }] } });
  assert.equal(f.card, "focus");
  assert.equal(OM.normalizeBrainstorm({ say: "", card: "focus", focus: { options: [{ label: "A" }] } }), null);
  assert.equal(OM.normalizeBrainstorm({ say: "Just prose", card: "offer" }).card, "none");
  assert.equal(OM.normalizeDirection({ title: "" }), null);
  assert.deepEqual(OM.normalizeDirection({ title: "Pose to angles", uses: ["A", 3, ""], what_you_would_make: "w" }).uses, ["A"]);
  assert.equal(OM.normalizeSubgoals({ subgoals: [{ label: "a" }, { label: "b" }] }), null);
  assert.equal(OM.normalizeSubgoals({ subgoals: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] }).subgoals.length, 3);
});

test("the asset hunt shares the paper prefix with analyze, asks for web search, and falls back without it", async () => {
  const calls = [];
  const reply = { assets: [{ title: "Pose viewer", type: "demo", links: [{ kind: "live_demo", url: "https://x.org" }] }] };
  const out = await OM.assets({ pdfBase64: "JVBERi0=" }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  assert.equal(out.searched, true);
  assert.equal(out.assets[0].title, "Pose viewer");
  const body = calls[0].body;
  assert.equal(body.tools[0].type, "web_search_20250305");
  assert.equal(body.messages[0].content[1].type, "document");
  assert.deepEqual(body.messages[0].content[1].cache_control, { type: "ephemeral" });
  assert.equal(body.messages[0].content[0].text, P.PAPER_PREFIX);

  let n = 0;
  const flaky = async (url, init) => {
    n += 1;
    if (n === 1) return { ok: false, status: 400, async json() { return { error: { message: "tools not supported" } }; } };
    return modelSaying(reply)(url, init);
  };
  const again = await OM.assets({ pdfBase64: "JVBERi0=" }, CREDS, { fetchImpl: flaky });
  assert.equal(again.searched, false);
  assert.equal(n, 2);
});

test("analyze begins with the same cached paper prefix", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: null, areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  await OM.analyze({ familiarityLabel: "f", familiarityDesc: "", depthLabel: "d", depthDesc: "",
    pdfBase64: "JVBERi0=", urls: [] }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  const blocks = calls[0].body.messages[0].content;
  assert.equal(blocks[0].text, P.PAPER_PREFIX);
  assert.equal(blocks[1].type, "document");
  assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
  assert.match(blocks[2].text, /<phd_student_paper>[\s\S]*the paper attached above[\s\S]*<\/phd_student_paper>/);
});

test("resourcesBlock lists assets and their children, or nothing", () => {
  assert.deepEqual(P.resourcesBlock([]), []);
  const lines = P.resourcesBlock([{ title: "Pose viewer", type: "demo", what_you_can_do_with_it: "play",
    links: [{ kind: "live_demo", url: "https://x.org" }], children: [{ title: "Toy", type: "dataset", description: "small", links: [] }] }]);
  assert.match(lines.join("\n"), /Pose viewer \(demo\): play <https:\/\/x\.org>/);
  assert.match(lines.join("\n"), /start with Toy \(dataset\): small/);
});
