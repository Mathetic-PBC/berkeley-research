"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const OB = require("../api/_lib/onboarding");
const SetupChat = require("../api/_lib/setup-chat");
const setupHandler = require("../api/engelbart-setup");

const ENV = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role", LITELLM_BASE_URL: "https://proxy.example.com",
  LITELLM_MASTER_KEY: "sk-master", ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
};
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };
const PAPER = "22222222-2222-2222-2222-222222222222";
const CREDS = { apiKey: "k", baseUrl: "https://proxy.example.com", models: ["all-proxy-models"] };

function five() {
  return [0, 25, 50, 75, 100].map((level) => ({ level, capability: "x", question: `q${level}`, sample_response: `s${level}` }));
}
const ANALYSIS = { title: "Zebra Tuning", one_liner: "It tunes zebras.", date: "2024", areas: [
  { index: 0, area: "Transformers", parent_field: "ML", project_role: "core", granularity_rationale: "g", questions: five() },
  { index: 1, area: "PyTorch", parent_field: "", project_role: "code", granularity_rationale: "g", questions: five() },
] };

// An in-memory PostgREST + Storage + model gateway, routed by URL. Rows are
// keyed per table; PATCH/GET filters understand `col=eq.value` only.
// `emptyPatch` makes every PATCH match nothing (a lost write); `failTable`
// makes one table's writes answer 500.
function fake({ model = {}, pdf = Buffer.from("%PDF-1.4 fake"), emptyPatch = false, failTable = "" } = {}) {
  const tables = { engelbart_onboardings: [], engelbart_onboarding_calibrations: [],
    engelbart_onboarding_asks: [], hc_profiles: [] };
  const calls = [];
  const rpcs = [];
  let ids = 0;
  function match(row, query) {
    return [...new URLSearchParams(query)].every(([k, v]) => {
      if (k === "select" || k === "order" || k === "limit" || k === "on_conflict") return true;
      const m = /^eq\.(.*)$/.exec(v);
      return m ? String(row[k]) === m[1] : true;
    });
  }
  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (value, status = 200) => ({ ok: status < 300, status, async text() { return JSON.stringify(value); }, async json() { return value; },
      async arrayBuffer() { return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength); } });
    if (u.pathname.startsWith("/rest/v1/rpc/")) { rpcs.push({ name: u.pathname.split("/").pop(), body }); return json("33333333-3333-3333-3333-333333333333"); }
    if (u.pathname.startsWith("/rest/v1/")) {
      const table = u.pathname.slice("/rest/v1/".length);
      const rows = tables[table];
      if (table === failTable) return json({ message: "no such table" }, 500);
      if (method === "GET") return json(rows.filter((r) => match(r, u.search)));
      if (method === "POST") {
        const made = body.map((r) => ({ id: `id-${++ids}`, created_at: "t", ...r }));
        if (String((init.headers || {}).Prefer || "").includes("merge-duplicates")) {
          // An upsert conflicts on the columns the caller named, and the row
          // that was already there keeps its id.
          const keys = String(u.searchParams.get("on_conflict") || "user_id").split(",");
          return json(made.map((m) => {
            const hit = rows.find((r) => keys.every((k) => String(r[k]) === String(m[k])));
            if (hit) { Object.assign(hit, m, { id: hit.id }); return hit; }
            rows.push(m);
            return m;
          }));
        }
        rows.push(...made);
        return json(made);
      }
      if (method === "PATCH") {
        if (emptyPatch) return json([]);
        const hit = rows.filter((r) => match(r, u.search));
        hit.forEach((r) => Object.assign(r, body));
        return json(hit);
      }
    }
    if (u.pathname.startsWith("/storage/v1/object/")) return { ok: true, status: 200, async arrayBuffer() { return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength); }, async text() { return ""; } };
    if (u.pathname === "/v1/messages") {
      const text = body.messages[0].content.map((b) => b.text || "").join("\n");
      const reply = /prior-knowledge diagnostic/.test(text) ? model.analysis
        : /calibration question/.test(text) ? model.grade
        : /Ask 3 or 4 questions/.test(text) ? model.details
        : /exactly four goals/.test(text) ? model.goals
        : /TODO rows/.test(text) ? model.todos : model.ask;
      return json({ content: [{ type: "text", text: reply === undefined ? "I could not do that." : JSON.stringify(reply) }] });
    }
    if (u.hostname === "x.org") return { ok: true, status: 200, headers: { get: () => "text/html" }, async text() { return "<p>project page</p>"; } };
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { tables, calls, rpcs, options: { env: ENV, fetchImpl } };
}

function modelCalls(db) {
  return db.calls.filter((c) => c.url.endsWith("/v1/messages")).length;
}

// The record a reader has carried all the way to the last step.
async function ready(db, extra = {}) {
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { name: "Maya", year: "Second year", major: "CogSci",
    depth: "technical", paper_id: PAPER, paper_title: "Zebra Tuning", project_url: "https://x.org/p",
    project_draft: "A tool", analysis: ANALYSIS, analysis_status: "done",
    goals: { goals: [1, 2, 3, 4].map((n) => ({ label: `G${n}`, short: `s${n}`, why: `w${n}` })) }, ...extra });
  db.tables.engelbart_onboarding_calibrations.push({ id: "cal-1", onboarding_id: onboarding.id, user_id: USER.id,
    area_index: 0, question_level: 50, self_level: 50, graded_level: 50, answered_at: "2026-09-02T00:00:00Z" });
  return db.tables.engelbart_onboardings[0];
}

test("open creates one live row and finds it again; a created row is shown, fresh starts over", async () => {
  const db = fake();
  const first = await OB.open(USER, {}, db.options);
  assert.equal(first.onboarding.status, "open");
  const again = await OB.open(USER, {}, db.options);
  assert.equal(again.onboarding.id, first.onboarding.id);
  db.tables.engelbart_onboardings[0].status = "created";
  const shown = await OB.open(USER, {}, db.options);
  assert.equal(shown.onboarding.status, "created");
  const fresh = await OB.open(USER, { fresh: true }, db.options);
  assert.equal(fresh.onboarding.status, "open");
  assert.notEqual(fresh.onboarding.id, first.onboarding.id);
});

test("step keeps only whitelisted fields, bounds them, and never moves step backwards", async () => {
  const db = fake();
  const { onboarding } = await OB.open(USER, {}, db.options);
  const out = await OB.step(USER, onboarding, { step: 3, fields: { name: "  Maya ", depth: "expert",
    status: "created", analysis_status: "done", project_draft: "d".repeat(3000) } }, db.options);
  assert.equal(out.onboarding.name, "Maya");
  assert.equal(out.onboarding.depth, "expert");
  assert.equal(out.onboarding.status, "open");
  assert.equal(out.onboarding.project_draft.length, 2000);
  const back = await OB.step(USER, out.onboarding, { step: 1, fields: { depth: "nope" } }, db.options);
  assert.equal(back.onboarding.step, 3);
  assert.equal(back.onboarding.depth, "expert");                  // an unknown depth changes nothing
});

test("sources needs the paper token, then analyses to completion and stores the result", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  await assert.rejects(OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: "bad", paper_familiarity: 2 }, CREDS, db.options),
    (e) => e.statusCode === 403);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  const out = await OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, project_url: "https://x.org/p",
    repo_url: "", paper_familiarity: 2 }, CREDS, db.options);
  assert.equal(out.analysis_status, "done");
  const row = db.tables.engelbart_onboardings[0];
  assert.equal(row.paper_id, PAPER);
  assert.equal(row.paper_title, "Zebra Tuning");
  assert.equal(row.analysis.areas.length, 2);
  const modelCall = db.calls.find((c) => c.url.endsWith("/v1/messages"));
  const blocks = JSON.parse(modelCall.init.body).messages[0].content;
  assert.equal(blocks[1].type, "document");
  assert.match(blocks[2].text, /project page/);
});

test("a running analysis younger than three minutes is not started twice", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { paper_id: PAPER, analysis_status: "running",
    analysis_started_at: new Date().toISOString() });
  const out = await OB.analysis(USER, db.tables.engelbart_onboardings[0], { retry: true }, CREDS, db.options);
  assert.equal(out.analysis_status, "running");
  assert.equal(db.calls.filter((c) => c.url.endsWith("/v1/messages")).length, 0);
  db.tables.engelbart_onboardings[0].analysis_started_at = new Date(Date.now() - 200000).toISOString();
  const again = await OB.analysis(USER, db.tables.engelbart_onboardings[0], { retry: true }, CREDS, db.options);
  assert.equal(again.analysis_status, "done");
});

test("answer stores the row, grades it, and asks a follow-up when the grade disagrees", async () => {
  const db = fake({ model: { grade: { level: 25, confidence: 0.9, rationale: "recognises only" } } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis: ANALYSIS, analysis_status: "done" });
  const out = await OB.answer(USER, db.tables.engelbart_onboardings[0], [], { area_index: 0, question_level: 75,
    self_level: 75, answer: "I think it's about attention" }, CREDS, db.options);
  assert.equal(out.graded_level, 25);
  assert.deepEqual(out.follow_up, { question_level: 25, question: "q25" });
  const cal = db.tables.engelbart_onboarding_calibrations[0];
  assert.equal(cal.sample_response, "s75");
  assert.equal(cal.graded_level, 25);
  // Second question in the same area: no further follow-up, whatever the grade.
  const second = await OB.answer(USER, db.tables.engelbart_onboardings[0], db.tables.engelbart_onboarding_calibrations,
    { area_index: 0, question_level: 25, self_level: 75, answer: "It weights inputs" }, CREDS, db.options);
  assert.equal(second.follow_up, undefined);
  assert.deepEqual(OB.areaLevels(ANALYSIS, db.tables.engelbart_onboarding_calibrations), [25, null]);
});

test("assessedDepth shifts one stop on the graded mean and names the weakest area", () => {
  assert.deepEqual(OB.assessedDepth("technical", [25, 0]), { key: "some", shift: -1, weakest: 1 });
  assert.deepEqual(OB.assessedDepth("some", [75, 100]), { key: "technical", shift: 1, weakest: 0 });
  assert.deepEqual(OB.assessedDepth("everyday", [0, 25]), { key: "everyday", shift: 0, weakest: 0 });
  assert.deepEqual(OB.assessedDepth("some", [null, null]), { key: "some", shift: 0, weakest: -1 });
});

test("create maps the record to the pending payload, writes the profile, and is idempotent", async () => {
  const db = fake();
  const row = await ready(db);
  const out = await OB.create(USER, row, db.tables.engelbart_onboarding_calibrations,
    { project_name: "zebra-tuner", goal_chosen: "G2", todos: ["do a", "do b"] }, db.options);
  assert.equal(out.ok, true);
  assert.equal(out.profile_saved, true);
  const saved = db.rpcs.find((r) => r.name === "engelbart_save_pending_setup").body.p_payload;
  assert.equal(saved.name, "zebra-tuner");
  assert.equal(saved.chosen, "G2");
  assert.deepEqual(saved.todos, ["do a", "do b"]);
  assert.equal(saved.goals.length, 4);
  assert.match(saved.plan.description, /A tool[\s\S]*Building on “Zebra Tuning” — It tunes zebras\./);
  assert.deepEqual(saved.paper, { paper_id: PAPER, title: "Zebra Tuning", url: "https://x.org/p" });
  assert.equal(saved.provenance.papers[0].paper_id, PAPER);
  assert.equal(saved.provenance.idea.inspired, "Zebra Tuning");
  assert.equal(saved.reader.level, "full");
  assert.deepEqual(saved.reader.knowledge, [{ area: "Transformers", parent_field: "ML", level: 50, project_role: "core" }]);
  const profile = db.tables.hc_profiles[0];
  assert.equal(profile.tech_level, "full");
  assert.equal(profile.display_name, "Maya");
  assert.equal(db.tables.engelbart_onboardings[0].status, "created");
  const twice = await OB.create(USER, db.tables.engelbart_onboardings[0], [], { project_name: "other" }, db.options);
  assert.equal(twice.ok, true);
  assert.equal(db.rpcs.filter((r) => r.name === "engelbart_save_pending_setup").length, 1);
});

test("normalizePayload keeps a bounded reader and drops a broken one", () => {
  const out = SetupChat.normalizePayload({ name: "n", plan: { description: "d" }, reader: { name: "x".repeat(100),
    level: "expert", knowledge: [{ area: "A", level: 50 }, { area: "", level: 50 }, { area: "B", level: 33 }] } });
  assert.equal(out.reader.name.length, 60);
  assert.equal(out.reader.level, "expert");
  assert.deepEqual(out.reader.knowledge, [{ area: "A", parent_field: "", level: 50, project_role: "" }]);
  assert.equal(SetupChat.normalizePayload({ name: "n", reader: "junk" }).reader, undefined);
});

test("a write that matches no row is a 502, never a silent edit of the copy in memory", async () => {
  const db = fake();
  const { onboarding } = await OB.open(USER, {}, db.options);
  const lost = fake({ emptyPatch: true });
  lost.tables.engelbart_onboardings.push({ ...db.tables.engelbart_onboardings[0] });
  await assert.rejects(OB.step(USER, onboarding, { step: 2, fields: { name: "Maya" } }, lost.options),
    (e) => e.statusCode === 502);
  assert.equal(onboarding.name, undefined);
});

test("sources refuses a familiarity off the slider and a link that is not a public page", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  await assert.rejects(OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, paper_familiarity: 7 },
    CREDS, db.options), (e) => e.statusCode === 400);
  await assert.rejects(OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, paper_familiarity: 2,
    project_url: "file:///etc/passwd" }, CREDS, db.options), (e) => e.statusCode === 400);
  assert.equal(db.tables.engelbart_onboardings[0].paper_id, undefined);
  assert.equal(modelCalls(db), 0);
});

test("polling an errored analysis hands back the message the run left behind", async () => {
  const db = fake();
  await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis_status: "error", analysis_error: "the paper could not be read" });
  const out = await OB.analysis(USER, db.tables.engelbart_onboardings[0], {}, CREDS, db.options);
  assert.deepEqual(out, { analysis_status: "error", analysis_error: "the paper could not be read" });
  assert.equal(modelCalls(db), 0);
});

test("a grade the model does not return leaves the row ungraded and the self-rating stands", async () => {
  const db = fake();                                     // no model.grade: the gateway answers prose
  await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis: ANALYSIS, analysis_status: "done" });
  const out = await OB.answer(USER, db.tables.engelbart_onboardings[0], [], { area_index: 1, question_level: 50,
    self_level: 50, answer: "It builds and trains tensors" }, CREDS, db.options);
  assert.equal(out.graded_level, null);
  assert.equal(out.follow_up, undefined);
  assert.deepEqual(OB.areaLevels(ANALYSIS, db.tables.engelbart_onboarding_calibrations), [null, 50]);
});

test("a later ungraded answer does not erase the grade the reader already earned", () => {
  const cals = [
    { area_index: 0, question_level: 75, self_level: 75, graded_level: 25, answered_at: "2026-09-02T00:00:00Z" },
    { area_index: 0, question_level: 25, self_level: 75, graded_level: null, answered_at: "2026-09-02T00:01:00Z" },
  ];
  assert.deepEqual(OB.areaLevels(ANALYSIS, cals), [25, null]);
});

test("an area is asked at most twice", async () => {
  const db = fake({ model: { grade: { level: 50, confidence: 0.6, rationale: "ok" } } });
  await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis: ANALYSIS, analysis_status: "done" });
  const row = db.tables.engelbart_onboardings[0];
  const cals = db.tables.engelbart_onboarding_calibrations;
  await OB.answer(USER, row, cals, { area_index: 0, question_level: 75, self_level: 75, answer: "a" }, CREDS, db.options);
  await OB.answer(USER, row, cals, { area_index: 0, question_level: 50, self_level: 75, answer: "b" }, CREDS, db.options);
  await assert.rejects(OB.answer(USER, row, cals, { area_index: 0, question_level: 25, self_level: 75, answer: "c" },
    CREDS, db.options), (e) => e.statusCode === 400);
  // Re-answering one of the two it already holds is still allowed.
  const again = await OB.answer(USER, row, cals, { area_index: 0, question_level: 50, self_level: 75, answer: "b again" },
    CREDS, db.options);
  assert.equal(again.graded_level, 50);
  assert.equal(cals.filter((c) => c.area_index === 0).length, 2);
});

test("step writes only the details answers whose question id is on the record", async () => {
  const db = fake();
  await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { details: { intro: "", answers: { who: "nobody" },
    questions: [{ id: "who", kind: "short", title: "Who?" }, { id: "first", kind: "multi", title: "What first?" }] } });
  const out = await OB.step(USER, db.tables.engelbart_onboardings[0], { fields: { details_answers: {
    who: "  a lab  ", first: ["one", "two"], status: "created", never_asked: "x" } } }, db.options);
  assert.deepEqual(out.onboarding.details.answers, { who: "a lab", first: ["one", "two"] });
  assert.deepEqual(out.onboarding.details.questions.map((q) => q.id), ["who", "first"]);
});

test("details generates once, serves the stored set, and regenerates only when asked", async () => {
  const db = fake({ model: { details: { intro: "A few things", questions: [
    { id: "who", kind: "choice", title: "Who is it for?", options: ["me", "a lab"] },
    { id: "first", kind: "short", title: "What must it do first?" },
    { id: "never", kind: "short", title: "What must it never do?" }] } } });
  const row = await ready(db, { details: null, goals: null });
  const first = await OB.details(USER, row, [], {}, CREDS, db.options);
  assert.equal(first.intro, "A few things");
  assert.equal(first.questions.length, 3);
  assert.deepEqual(first.answers, {});
  const again = await OB.details(USER, row, [], {}, CREDS, db.options);
  assert.equal(modelCalls(db), 1);
  assert.deepEqual(again.questions, first.questions);
  await OB.details(USER, row, [], { regenerate: true }, CREDS, db.options);
  assert.equal(modelCalls(db), 2);
});

test("goals generates once, serves the stored four, and regenerates only when asked", async () => {
  const db = fake({ model: { goals: { goals: [1, 2, 3, 4].map((n) => ({ label: `Goal ${n}`, short: `s${n}`, why: `w${n}` })) } } });
  const row = await ready(db, { goals: null });
  const first = await OB.goals(USER, row, [], {}, CREDS, db.options);
  assert.equal(first.goals.length, 4);
  assert.equal(first.goals[0].label, "Goal 1");
  await OB.goals(USER, row, [], {}, CREDS, db.options);
  assert.equal(modelCalls(db), 1);
  await OB.goals(USER, row, [], { regenerate: true }, CREDS, db.options);
  assert.equal(modelCalls(db), 2);
});

test("todos serves the stored rows for the same goal and writes new ones for a new goal", async () => {
  const db = fake({ model: { todos: { todos: ["do a", "do b"], name: "zebra tuner" } } });
  const row = await ready(db, { todos: null, project_name: "" });
  const first = await OB.todos(USER, row, [], { goal: "G1" }, CREDS, db.options);
  assert.deepEqual(first.todos, ["do a", "do b"]);
  assert.equal(first.name, "zebra tuner");
  assert.equal(row.goal_chosen, "G1");
  await OB.todos(USER, row, [], { goal: "G1" }, CREDS, db.options);
  assert.equal(modelCalls(db), 1);
  await OB.todos(USER, row, [], { goal: "G2" }, CREDS, db.options);
  assert.equal(modelCalls(db), 2);
  assert.equal(row.goal_chosen, "G2");
  await assert.rejects(OB.todos(USER, row, [], {}, CREDS, db.options), (e) => e.statusCode === 400);
});

test("ask answers at the register asked for, keeps the exchange, and is a write like any other", async () => {
  const db = fake({ model: { ask: { answer: "It is the step that weights the inputs." } } });
  const row = await ready(db);
  const out = await OB.ask(USER, row, [], { quote: "self-attention", question: "What is this?",
    level: "everyday", step: 4 }, CREDS, db.options);
  assert.equal(out.level, "everyday");
  assert.equal(out.answer, "It is the step that weights the inputs.");
  const asked = db.tables.engelbart_onboarding_asks[0];
  assert.equal(asked.quote, "self-attention");
  assert.equal(asked.level, "everyday");
  assert.equal(asked.step, 4);
  assert.equal(asked.onboarding_id, row.id);
  await assert.rejects(OB.ask(USER, row, [], { quote: "x" }, CREDS, db.options), (e) => e.statusCode === 400);
  row.status = "created";
  await assert.rejects(OB.ask(USER, row, [], { question: "and this?" }, CREDS, db.options), (e) => e.statusCode === 409);
});

test("a profile that will not save does not cost the reader the project", async () => {
  const db = fake({ failTable: "hc_profiles" });
  const row = await ready(db);
  const out = await OB.create(USER, row, db.tables.engelbart_onboarding_calibrations,
    { project_name: "zebra-tuner", goal_chosen: "G2", todos: ["do a", "do b"] }, db.options);
  assert.equal(out.ok, true);
  assert.equal(out.profile_saved, false);
  assert.equal(out.pending_setup_id, "33333333-3333-3333-3333-333333333333");
  assert.equal(db.tables.engelbart_onboardings[0].status, "created");
  assert.equal(db.tables.hc_profiles.length, 0);
});

test("a create that is refused leaves the record exactly as the reader left it", async () => {
  const db = fake();
  const row = await ready(db, { project_name: "kept", goal_chosen: "G1", todos: ["only one"] });
  await assert.rejects(OB.create(USER, row, [], { project_name: "zebra-tuner" }, db.options),
    (e) => e.statusCode === 400);
  assert.equal(row.project_name, "kept");
  assert.equal(row.status, "open");
  assert.equal(db.rpcs.length, 0);
});
