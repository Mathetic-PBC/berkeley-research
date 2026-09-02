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
function fake({ model = {}, pdf = Buffer.from("%PDF-1.4 fake") } = {}) {
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
      if (method === "GET") return json(rows.filter((r) => match(r, u.search)));
      if (method === "POST") {
        const made = body.map((r) => ({ id: `id-${++ids}`, created_at: "t", ...r }));
        if (String((init.headers || {}).Prefer || "").includes("merge-duplicates")) {
          for (const m of made) { const i = rows.findIndex((r) => r.user_id === m.user_id); if (i >= 0) rows[i] = { ...rows[i], ...m }; else rows.push(m); }
        } else rows.push(...made);
        return json(made);
      }
      if (method === "PATCH") { const hit = rows.filter((r) => match(r, u.search)); hit.forEach((r) => Object.assign(r, body)); return json(hit); }
    }
    if (u.pathname.startsWith("/storage/v1/object/")) return { ok: true, status: 200, async arrayBuffer() { return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength); }, async text() { return ""; } };
    if (u.pathname === "/v1/messages") {
      const text = body.messages[0].content.map((b) => b.text || "").join("\n");
      const reply = /prior-knowledge diagnostic/.test(text) ? model.analysis
        : /calibration question/.test(text) ? model.grade
        : /Ask 3 or 4 questions/.test(text) ? model.details
        : /exactly four goals/.test(text) ? model.goals
        : /TODO rows/.test(text) ? model.todos : model.ask;
      return json({ content: [{ type: "text", text: JSON.stringify(reply) }] });
    }
    if (u.hostname === "x.org") return { ok: true, status: 200, headers: { get: () => "text/html" }, async text() { return "<p>project page</p>"; } };
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { tables, calls, rpcs, options: { env: ENV, fetchImpl } };
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
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { name: "Maya", year: "Second year", major: "CogSci",
    depth: "technical", paper_id: PAPER, paper_title: "Zebra Tuning", project_url: "https://x.org/p",
    project_draft: "A tool", analysis: ANALYSIS, analysis_status: "done",
    goals: { goals: [1, 2, 3, 4].map((n) => ({ label: `G${n}`, short: `s${n}`, why: `w${n}` })) } });
  db.tables.engelbart_onboarding_calibrations.push({ onboarding_id: onboarding.id, user_id: USER.id, area_index: 0,
    question_level: 50, self_level: 50, graded_level: 50, answered_at: "2026-09-02T00:00:00Z" });
  const out = await OB.create(USER, db.tables.engelbart_onboardings[0], db.tables.engelbart_onboarding_calibrations,
    { project_name: "zebra-tuner", goal_chosen: "G2", todos: ["do a", "do b"] }, db.options);
  assert.equal(out.ok, true);
  const saved = db.rpcs.find((r) => r.name === "engelbart_save_pending_setup").body.p_payload;
  assert.equal(saved.name, "zebra-tuner");
  assert.equal(saved.chosen, "G2");
  assert.deepEqual(saved.todos, ["do a", "do b"]);
  assert.equal(saved.goals.length, 4);
  assert.match(saved.plan.description, /A tool[\s\S]*Building on “Zebra Tuning” — It tunes zebras\./);
  assert.deepEqual(saved.paper, { paper_id: PAPER, title: "Zebra Tuning", url: "https://x.org/p" });
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
