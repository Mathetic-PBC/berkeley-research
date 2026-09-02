"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const OM = require("../api/_lib/onboarding-model");
const P = require("../api/_lib/onboarding-prompts");

const CREDS = { apiKey: "k", baseUrl: "https://p", models: ["all-proxy-models"] };

function modelSaying(reply, capture) {
  return async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    if (capture) capture.push({ url, body, headers: init.headers });
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
  const { body, headers } = calls[0];
  assert.equal(headers.Authorization, "Bearer k");
  assert.equal(body.max_tokens, 8192);
  const blocks = body.messages[0].content;
  const doc = blocks.findIndex((b) => b.type === "document");
  assert.ok(doc > 0 && doc < blocks.length - 1);
  assert.equal(blocks[doc].source.media_type, "application/pdf");
  assert.match(blocks[doc - 1].text, /<phd_student_paper>\s*$/);
  assert.match(blocks[doc + 1].text, /^\s*<\/phd_student_paper>/);
  assert.match(blocks[doc + 1].text, /https:\/\/x\.org[\s\S]*page text/);
  assert.match(blocks[0].text, /I wouldn't know where to start/);
});

test("analyze with text instead of a PDF sends one text block", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: null, areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  await OM.analyze({ familiarityLabel: "f", familiarityDesc: "", depthLabel: "d", depthDesc: "",
    pdfText: "paper words", urls: [] }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  const blocks = calls[0].body.messages[0].content;
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /<phd_student_paper>\s*paper words\s*<\/phd_student_paper>/);
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
