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
function fake({ model = {}, pdf = Buffer.from("%PDF-1.4 fake"), emptyPatch = false, failTable = "", dead = [] } = {}) {
  const tables = { engelbart_onboardings: [], engelbart_onboarding_calibrations: [],
    engelbart_onboarding_asks: [], engelbart_onboarding_turns: [], hc_profiles: [] };
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
      if (method === "DELETE") {
        const keep = rows.filter((r) => !match(r, u.search));
        rows.splice(0, rows.length, ...keep);
        return json(null, 204);
      }
    }
    // A link check: HEAD anywhere else. `dead` lists the URLs that answer 404.
    if (method === "HEAD") return { ok: !dead.includes(url), status: dead.includes(url) ? 404 : 200, async text() { return ""; } };
    if (u.pathname.startsWith("/storage/v1/object/")) return { ok: true, status: 200, async arrayBuffer() { return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength); }, async text() { return ""; } };
    if (u.pathname === "/v1/messages") {
      const text = body.messages[0].content.map((b) => b.text || "").join("\n");
      const reply = /prior-knowledge diagnostic/.test(text) ? model.analysis
        : /calibration question/.test(text) ? model.grade
        : /Write ONE follow-up question/.test(text) ? (typeof model.followUp === "function" ? model.followUp(text) : model.followUp)
        : /Rewrite each passage at the new register/.test(text) ? (typeof model.rewrite === "function" ? model.rewrite(text) : model.rewrite)
        : /Ask 3 or 4 questions/.test(text) ? model.details
        : /exactly four goals/.test(text) ? model.goals
        : /identify the concrete inputs and outputs/.test(text) ? model.assets
        : /locus of problem solving would lie/.test(text) ? model.leveled
        : /You are brainstorming with them/.test(text) ? (typeof model.brainstorm === "function" ? model.brainstorm(text) : model.brainstorm)
        : /The thing they are asking about/.test(text) ? model.assetAsk
        : /Choose ONE direction|Revise the direction/.test(text) ? (typeof model.direction === "function" ? model.direction(text) : model.direction)
        : /exactly three subgoals|Revise the three subgoals/.test(text) ? model.subgoals
        : /Write the TODO rows for that first piece/.test(text) ? model.todos : model.ask;
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
    project_draft: "A tool", analysis: ANALYSIS, analysis_status: "done", assets_status: "none", leveled_status: "none",
    goals: { goals: [1, 2, 3, 4].map((n) => ({ label: `G${n}`, short: `s${n}`, why: `w${n}` })) },
    direction: { title: "G2", what_you_would_make: "A tool", why_it_fits: "fits" },
    subgoals: [{ label: "P1", description: "d1", why: "w1" }, { label: "P2", description: "d2", why: "w2" }, { label: "P3", description: "d3", why: "w3" }],
    ...extra });
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

// The profile is asked once: a second setup starts at the paper with the
// four answers carried over, and says so, so the page counts from there.
test("a member who finished a setup starts the next one at the paper with their profile", async () => {
  const db = fake();
  const first = await OB.open(USER, {}, db.options);
  assert.equal(first.profile_reused, false, "a first setup asks everything");
  Object.assign(db.tables.engelbart_onboardings[0], { status: "created", name: "Maya", year: "Second year", major: "CogSci", depth: "technical", step: 10 });
  const shown = await OB.open(USER, {}, db.options);
  assert.equal(shown.onboarding.status, "created");
  assert.equal(shown.profile_reused, false, "the finished setup is shown as it was walked");
  const next = await OB.open(USER, { fresh: true }, db.options);
  assert.equal(next.onboarding.status, "open");
  assert.equal(next.profile_reused, true);
  assert.equal(next.onboarding.step, 4);
  assert.deepEqual([next.onboarding.name, next.onboarding.year, next.onboarding.major, next.onboarding.depth],
    ["Maya", "Second year", "CogSci", "technical"]);
  assert.equal(next.onboarding.paper_id, undefined, "and nothing past the profile comes with it");
  // Opening again finds the same row, still counted from the paper.
  const again = await OB.open(USER, {}, db.options);
  assert.equal(again.onboarding.id, next.onboarding.id);
  assert.equal(again.profile_reused, true);
});

test("an open row without a profile is filled from the finished setup on open", async () => {
  const db = fake();
  db.tables.engelbart_onboardings.push(
    { id: "old", user_id: USER.id, status: "created", step: 10, name: "Maya", year: "Second year", major: "CogSci", depth: "some", created_at: "2026-01-01" },
    { id: "live", user_id: USER.id, status: "open", step: 1, name: "M", year: "", major: "", depth: "", created_at: "2026-02-01" });
  const out = await OB.open(USER, {}, db.options);
  assert.equal(out.onboarding.id, "live");
  assert.equal(out.profile_reused, true);
  assert.equal(out.onboarding.name, "M", "what the row already says stands");
  assert.equal(out.onboarding.year, "Second year");
  assert.equal(out.onboarding.depth, "some");
  assert.equal(out.onboarding.step, 4);
});

// Test mode's two buttons: the account keeps its membership and credit and
// loses only what it said here.
test("reset drops the open row, or every row and the profile, and never the account", async () => {
  const db = fake();
  db.tables.hc_profiles.push({ id: "p", user_id: USER.id, display_name: "Maya" });
  db.tables.engelbart_onboardings.push(
    { id: "old", user_id: USER.id, status: "created", step: 10, name: "Maya", year: "Y", major: "M", depth: "some", created_at: "2026-01-01" },
    { id: "live", user_id: USER.id, status: "open", step: 6, name: "Maya", year: "Y", major: "M", depth: "some", created_at: "2026-02-01" },
    { id: "theirs", user_id: "other", status: "open", step: 2, created_at: "2026-02-01" });
  assert.deepEqual(await OB.reset(USER, { scope: "project" }, db.options), { ok: true, scope: "project" });
  assert.deepEqual(db.tables.engelbart_onboardings.map((r) => r.id), ["old", "theirs"]);
  const next = await OB.open(USER, { fresh: true }, db.options);
  assert.equal(next.profile_reused, true, "a finished setup still seeds the next one");
  assert.equal(next.onboarding.step, 4);
  assert.deepEqual(await OB.reset(USER, { scope: "all" }, db.options), { ok: true, scope: "all" });
  assert.deepEqual(db.tables.engelbart_onboardings.map((r) => r.id), ["theirs"]);
  assert.deepEqual(db.tables.hc_profiles, []);
  const first = await OB.open(USER, {}, db.options);
  assert.equal(first.profile_reused, false, "and the next setup is a first setup again");
  assert.equal(first.onboarding.step, 0);
  assert.ok(!first.onboarding.name, "with no profile carried over");
});

test("a profile table that will not clear does not stop the reset", async () => {
  const db = fake({ failTable: "hc_profiles" });
  db.tables.engelbart_onboardings.push({ id: "live", user_id: USER.id, status: "open", step: 3, created_at: "t" });
  const quiet = console.error; console.error = () => {};
  try { assert.deepEqual(await OB.reset(USER, { scope: "all" }, db.options), { ok: true, scope: "all" }); }
  finally { console.error = quiet; }
  assert.deepEqual(db.tables.engelbart_onboardings, []);
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

// Accepting the paper and reading it are two requests. This one only has to
// be quick and right: the reader is waiting on it with their finger on
// Continue, and nothing here may reach the model.
test("sources needs the paper token, stores the paper, and does not read it", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  await assert.rejects(OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: "bad", paper_familiarity: 2 }, CREDS, db.options),
    (e) => e.statusCode === 403);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  const out = await OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, project_url: "https://x.org/p",
    repo_url: "", paper_familiarity: 2 }, CREDS, db.options);
  assert.deepEqual(out, { ok: true, analysis_status: "none", assets_status: "none" });
  const row = db.tables.engelbart_onboardings[0];
  assert.equal(row.paper_id, PAPER);
  assert.equal(row.project_url, "https://x.org/p");
  assert.equal(row.repo_url, "");
  assert.equal(row.paper_familiarity, 2);
  assert.equal(row.analysis, null);
  assert.equal(row.paper_title, "");
  assert.equal(row.analysis_status, "none");
  assert.equal(row.analysis_error, "");
  assert.equal(modelCalls(db), 0);
});

// The token only ever existed in the tab that uploaded the PDF. A reload has
// to be able to send the same paper up again -- but only the same one.
test("a paper already on the row needs no token; another one still does", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  await OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, paper_familiarity: 2 }, CREDS, db.options);
  const again = await OB.sources(USER, onboarding, { paper_id: PAPER, paper_familiarity: 4 }, CREDS, db.options);
  assert.deepEqual(again, { ok: true, analysis_status: "none", assets_status: "none" });
  assert.equal(db.tables.engelbart_onboardings[0].paper_familiarity, 4);
  const other = "44444444-4444-4444-4444-444444444444";
  await assert.rejects(OB.sources(USER, onboarding, { paper_id: other, paper_familiarity: 2 }, CREDS, db.options),
    (e) => e.statusCode === 403);
  assert.equal(db.tables.engelbart_onboardings[0].paper_id, PAPER);
});

test("analysis run reads the paper and the project page, and stores the result", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  await OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, project_url: "https://x.org/p",
    repo_url: "", paper_familiarity: 2 }, CREDS, db.options);
  const out = await OB.analysis(USER, onboarding, { run: true }, CREDS, db.options);
  assert.equal(out.analysis_status, "done");
  const row = db.tables.engelbart_onboardings[0];
  assert.equal(row.paper_title, "Zebra Tuning");
  assert.equal(row.analysis.areas.length, 2);
  const modelCall = db.calls.find((c) => c.url.endsWith("/v1/messages"));
  const blocks = JSON.parse(modelCall.init.body).messages[0].content;
  assert.equal(blocks[1].type, "document");
  assert.match(blocks[2].text, /project page/);
  // With no paper on the row there is nothing to read, and saying so is a 400.
  const empty = fake({ model: { analysis: ANALYSIS } });
  const { onboarding: bare } = await OB.open(USER, {}, empty.options);
  await assert.rejects(OB.analysis(USER, bare, { run: true }, CREDS, empty.options), (e) => e.statusCode === 400);
});

// A minute of reading is long enough for the reader to walk back and attach a
// different paper. The run that was already in flight answers about a paper the
// row no longer has, and must land nowhere.
test("a run whose paper was replaced mid-read writes nothing", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  let release = null;
  let reached = null;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  const inner = db.options.fetchImpl;
  const options = { ...db.options, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/v1/messages")) { reached(); await held; }
    return inner(url, init);
  } };
  const { onboarding } = await OB.open(USER, {}, options);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  await OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, paper_familiarity: 2 }, CREDS, options);
  const reading = OB.analysis(USER, onboarding, { run: true }, CREDS, options);
  await arrived;
  assert.equal(db.tables.engelbart_onboardings[0].analysis_status, "running");

  // Back on the paper step, a different PDF.
  const other = "55555555-5555-5555-5555-555555555555";
  await OB.sources(USER, onboarding, { paper_id: other, paper_token: setupHandler.ownPaperToken(other, USER.id, ENV),
    paper_familiarity: 3 }, CREDS, options);
  release();

  assert.deepEqual(await reading, { analysis_status: "superseded" });
  const row = db.tables.engelbart_onboardings[0];
  assert.equal(row.paper_id, other);
  assert.equal(row.analysis, null);
  assert.equal(row.paper_title, "");
  assert.equal(row.analysis_error, "");
  assert.equal(row.analysis_started_at, null);
  // "none" until the second run says otherwise -- not the first run's "done".
  assert.equal(row.analysis_status, "none");
});

test("a running analysis younger than three minutes is not started twice", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { paper_id: PAPER, analysis_status: "running",
    analysis_started_at: new Date().toISOString() });
  const out = await OB.analysis(USER, db.tables.engelbart_onboardings[0], { run: true }, CREDS, db.options);
  assert.equal(out.analysis_status, "running");
  assert.equal(db.calls.filter((c) => c.url.endsWith("/v1/messages")).length, 0);
  db.tables.engelbart_onboardings[0].analysis_started_at = new Date(Date.now() - 200000).toISOString();
  const again = await OB.analysis(USER, db.tables.engelbart_onboardings[0], { retry: true }, CREDS, db.options);
  assert.equal(again.analysis_status, "done");
});

test("answer stores the row, grades it, and asks one follow-up written from what they said", async () => {
  const seen = [];
  const db = fake({ model: { grade: { level: 25, confidence: 0.9, rationale: "recognises only" },
    followUp: (text) => { seen.push(text); return { question: "F25: you said attention weights -- weights of what?", sample_response: "F25 sample" }; } } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis: ANALYSIS, analysis_status: "done" });
  const cals = db.tables.engelbart_onboarding_calibrations;
  const out = await OB.answer(USER, db.tables.engelbart_onboardings[0], [], { area_index: 0, question_level: 75,
    self_level: 75, answer: "I think it's about attention weights" }, CREDS, db.options);
  assert.equal(out.graded_level, 25);
  assert.deepEqual(out.follow_up, { question_level: 25, question: "F25: you said attention weights -- weights of what?", generated: true });
  // The prompt carried their answer, the question, and where the grade put them.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /attention weights/);
  assert.match(seen[0], /q75/);
  assert.match(seen[0], /placed the answer at 25/);
  assert.equal(cals[0].sample_response, "s75");
  assert.equal(cals[0].graded_level, 25);
  // The follow-up is stored unanswered, with its own question and sample, so a
  // reload finds it; and the reply carries both rows for the page.
  assert.equal(cals.length, 2);
  assert.equal(cals[1].question_level, 25);
  assert.equal(cals[1].question, "F25: you said attention weights -- weights of what?");
  assert.equal(cals[1].sample_response, "F25 sample");
  assert.equal(cals[1].answered_at, null);
  assert.deepEqual(out.calibrations.map((c) => [c.question_level, Boolean(c.answered_at)]), [[75, true], [25, false]]);
  assert.deepEqual(OB.areaLevels(ANALYSIS, cals), [25, null], "an unanswered follow-up is not a level");

  // Answering the follow-up grades against ITS sample, not the ladder's, and no
  // further follow-up comes whatever the grade.
  const second = await OB.answer(USER, db.tables.engelbart_onboardings[0], cals,
    { area_index: 0, question_level: 25, self_level: 75, answer: "It weights inputs" }, CREDS, db.options);
  assert.equal(second.follow_up, undefined);
  assert.equal(cals.length, 2, "no third row");
  assert.equal(cals[1].question, "F25: you said attention weights -- weights of what?");
  assert.equal(cals[1].sample_response, "F25 sample");
  assert.ok(cals[1].answered_at);
  const gradeCalls = db.calls.filter((c) => c.url.endsWith("/v1/messages")).map((c) => JSON.parse(c.init.body).messages[0].content.map((b) => b.text || "").join("\n"));
  assert.match(gradeCalls[gradeCalls.length - 1], /F25 sample/, "the follow-up's own sample is what it is graded against");
  assert.deepEqual(OB.areaLevels(ANALYSIS, cals), [25, null]);
});

test("a follow-up the model cannot write falls back to the ladder's question at the graded level", async () => {
  const db = fake({ model: { grade: { level: 25, confidence: 0.9, rationale: "recognises only" } } });   // no model.followUp: prose comes back
  await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis: ANALYSIS, analysis_status: "done" });
  const out = await OB.answer(USER, db.tables.engelbart_onboardings[0], [], { area_index: 0, question_level: 75,
    self_level: 75, answer: "I think it's about attention" }, CREDS, db.options);
  assert.deepEqual(out.follow_up, { question_level: 25, question: "q25", generated: false });
  const pending = db.tables.engelbart_onboarding_calibrations[1];
  assert.equal(pending.question, "q25");
  assert.equal(pending.sample_response, "s25");
  assert.equal(pending.answered_at, null);
});

test("rewrite sends the screen's passages to the model at the asked register and moves the row's depth", async () => {
  const seen = [];
  const db = fake({ model: { rewrite: (text) => { seen.push(text); return { texts: ["A plainer first line.", "A plainer second."] }; } } });
  const row = await ready(db, { depth: "technical" });
  const out = await OB.rewrite(USER, row, [], { from: "technical", to: "everyday", texts: ["Attention weights the inputs.", "Softmax normalises."] }, CREDS, db.options);
  assert.deepEqual(out, { texts: ["A plainer first line.", "A plainer second."], level: "everyday" });
  assert.match(seen[0], /written technical/);
  assert.match(seen[0], /Write for somebody who has not programmed/, "the new register's own rule is in the prompt");
  assert.match(seen[0], /1\. Attention weights the inputs\.\n2\. Softmax normalises\./);
  assert.equal(db.tables.engelbart_onboardings[0].depth, "everyday", "what comes next is written there too");
  await assert.rejects(OB.rewrite(USER, row, [], { to: "shouty", texts: ["x"] }, CREDS, db.options), (e) => e.statusCode === 400);
  await assert.rejects(OB.rewrite(USER, row, [], { to: "some", texts: [] }, CREDS, db.options), (e) => e.statusCode === 400);
  // The wrong count back is a 502, never a partial swap.
  const short = fake({ model: { rewrite: { texts: ["only one"] } } });
  const row2 = await ready(short, {});
  await assert.rejects(OB.rewrite(USER, row2, [], { to: "some", texts: ["a", "b"] }, CREDS, short.options), (e) => e.statusCode === 502);
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
    { project_name: "zebra-tuner", todos: ["do a", "do b"] }, db.options);
  assert.equal(out.ok, true);
  assert.equal(out.profile_saved, true);
  const saved = db.rpcs.find((r) => r.name === "engelbart_save_pending_setup").body.p_payload;
  assert.equal(saved.name, "zebra-tuner");
  assert.equal(saved.chosen, "G2");
  assert.deepEqual(saved.todos, []);
  assert.deepEqual(saved.subgoals[0].todos, ["do a", "do b"]);
  assert.equal(saved.goals.length, 1);
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
  // A repeat writes nothing, so it claims nothing about the profile.
  assert.equal("profile_saved" in twice, false);
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

test("todos serves the stored rows and regenerates only when asked; it needs the pieces", async () => {
  const db = fake({ model: { todos: { todos: ["do a", "do b"], name: "zebra tuner" } } });
  const row = await ready(db, { todos: null, project_name: "" });
  const first = await OB.todos(USER, row, [], {}, CREDS, db.options);
  assert.deepEqual(first.todos, ["do a", "do b"]);
  assert.equal(first.name, "zebra tuner");
  assert.equal(row.goal_chosen, "G2");
  await OB.todos(USER, row, [], {}, CREDS, db.options);
  assert.equal(modelCalls(db), 1);
  await OB.todos(USER, row, [], { regenerate: true }, CREDS, db.options);
  assert.equal(modelCalls(db), 2);
  row.subgoals = null;
  await assert.rejects(OB.todos(USER, row, [], {}, CREDS, db.options), (e) => e.statusCode === 409);
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
    { project_name: "zebra-tuner", todos: ["do a", "do b"] }, db.options);
  assert.equal(out.ok, true);
  assert.equal(out.profile_saved, false);
  assert.equal(out.pending_setup_id, "33333333-3333-3333-3333-333333333333");
  assert.equal(db.tables.engelbart_onboardings[0].status, "created");
  assert.equal(db.tables.hc_profiles.length, 0);
});

test("a create that is refused leaves the record exactly as the reader left it", async () => {
  const db = fake();
  const row = await ready(db, { project_name: "kept", todos: ["only one"] });
  await assert.rejects(OB.create(USER, row, [], { project_name: "zebra-tuner" }, db.options),
    (e) => e.statusCode === 400);
  assert.equal(row.project_name, "kept");
  assert.equal(row.status, "open");
  assert.equal(db.rpcs.length, 0);
});

// --- v2: the hunt, the assessment, the leveled list, the brainstorm, the plan ----

const ASSETS = { assets: [
  { title: "Pose viewer", description: "A viewer.", one_liner: "views poses", type: "demo", availability: "usable",
    links: [{ kind: "live_demo", url: "https://x.org/demo" }, { kind: "source_code", url: "https://x.org/gone" }], what_you_can_do_with_it: "play" },
  { title: "Dance corpus", description: "Videos.", one_liner: "dance videos", type: "dataset", availability: "usable",
    links: [{ kind: "download", url: "https://x.org/gone" }], what_you_can_do_with_it: "pick clips" },
] };
const LEVELED = { locus: "geometry", sticky: ["angles"], assets: [
  { ...ASSETS.assets[0], description: "A viewer, simply.", children: [{ title: "Toy poses", type: "dataset", why: "small first",
    one_liner: "ten poses", links: [{ kind: "download", url: "https://x.org/toy" }] }] },
  ASSETS.assets[1],
] };
const DIRECTION = { title: "Pose to angles", what_you_would_make: "A page that turns a pose into joint angles.", uses: ["Pose viewer"],
  why_it_fits: "The geometry is the point.", first_visible_result: "one skeleton with its angles labelled" };
const SUBGOALS = { subgoals: [{ label: "One pose drawn", description: "d1", why: "w1" }, { label: "Angles computed", description: "d2", why: "w2" },
  { label: "A sequence compared", description: "d3", why: "w3" }] };

test("sources clears the hunt with the analysis; the hunt stores the assets, the brief, and drops dead links", async () => {
  const db = fake({ model: { assets: ASSETS }, dead: ["https://x.org/gone"] });
  const row = await ready(db, { assets_status: "done", assets: { assets: [] }, leveled_status: "done", leveled: LEVELED, direction: DIRECTION });
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  await OB.sources(USER, row, { paper_id: PAPER, paper_token: token, paper_familiarity: 1 }, CREDS, db.options);
  assert.equal(row.assets_status, "none");
  assert.equal(row.assets, null);
  assert.equal(row.leveled, null);
  assert.equal(row.direction, null, "a new paper starts the plan over");
  const poll = await OB.assets(USER, row, {}, null, db.options);
  assert.equal(poll.assets_status, "none");
  const out = await OB.assets(USER, row, { run: true }, CREDS, db.options);
  assert.equal(out.assets_status, "done");
  assert.equal(row.assets.assets.length, 2);
  assert.deepEqual(row.assets.assets[0].links, [{ kind: "live_demo", url: "https://x.org/demo" }], "the 404 is dropped");
  assert.deepEqual(row.assets.assets[1].links, []);
  assert.equal(row.assets.assets[1].availability, "unknown", "and an asset with no links left is no longer usable");
  assert.deepEqual(row.assets_brief, [{ title: "Pose viewer", type: "demo", one_liner: "views poses" },
    { title: "Dance corpus", type: "dataset", one_liner: "dance videos" }]);
  assert.equal(db.calls.filter((c) => c.init.method === "HEAD").length, 3);
  const again = await OB.assets(USER, row, {}, null, db.options);
  assert.equal(again.assets_brief.length, 2);
});

test("a hunt that finds nothing is an error the page can show, and the running guard holds", async () => {
  const db = fake({ model: { assets: { assets: [] } } });
  const row = await ready(db);
  const out = await OB.assets(USER, row, { run: true }, CREDS, db.options);
  assert.equal(out.assets_status, "error");
  assert.match(row.assets_error, /found nothing/);
  row.assets_status = "running"; row.assets_started_at = new Date().toISOString();
  assert.deepEqual(await OB.assets(USER, row, { run: true }, CREDS, db.options), { assets_status: "running" });
});

test("topics_done compiles the assessment from the calibration rows without the model", async () => {
  const db = fake();
  const row = await ready(db);
  db.tables.engelbart_onboarding_calibrations.push({ id: "cal-2", onboarding_id: row.id, user_id: USER.id,
    area_index: 1, question_level: 25, self_level: 75, graded_level: 25, grade_confidence: 0.9, grade_rationale: "recognises only",
    answer: "I have seen tensors", answered_at: "2026-09-02T00:01:00Z" });
  const cals = db.tables.engelbart_onboarding_calibrations;
  const before = modelCalls(db);
  const out = await OB.topicsDone(USER, row, cals, {}, db.options);
  assert.equal(modelCalls(db), before);
  assert.equal(out.assessment.areas.length, 2);
  assert.equal(out.assessment.areas[0].graded_level, 50);
  assert.equal(out.assessment.areas[1].graded_level, 25);
  assert.equal(out.assessment.areas[1].self_level, 75);
  assert.equal(out.assessment.areas[1].rationale, "recognises only");
  assert.deepEqual(out.assessment.areas[1].answers, ["I have seen tensors"]);
  assert.equal(out.assessment.mean, 38);
  assert.equal(out.assessment.depth, "technical", "a mean between the shifts leaves the register alone");
  assert.equal(row.step, OB.STEP.brainstorm);
  await assert.rejects(OB.topicsDone(USER, row, [], {}, db.options), (e) => e.statusCode === 400);
});

test("leveled waits for the hunt, then re-cuts the assets with children and checks their links", async () => {
  const db = fake({ model: { assets: ASSETS, leveled: LEVELED }, dead: ["https://x.org/gone"] });
  const row = await ready(db);
  const cals = db.tables.engelbart_onboarding_calibrations;
  await assert.rejects(OB.leveled(USER, row, cals, { run: true }, CREDS, db.options), (e) => e.statusCode === 409, "needs the assessment");
  await OB.topicsDone(USER, row, cals, {}, db.options);
  const waiting = await OB.leveled(USER, row, cals, { run: true }, CREDS, db.options);
  assert.equal(waiting.leveled_status, "waiting");
  assert.equal(waiting.assets_status, "none");
  await OB.assets(USER, row, { run: true }, CREDS, db.options);
  const out = await OB.leveled(USER, row, cals, { run: true }, CREDS, db.options);
  assert.equal(out.leveled_status, "done");
  assert.equal(row.leveled.locus, "geometry");
  assert.equal(row.leveled.assets[0].children[0].why, "small first");
  assert.equal(row.leveled.assets[0].description, "A viewer, simply.");
  const same = await OB.leveled(USER, row, cals, { run: true }, CREDS, db.options);
  assert.equal(same.leveled, row.leveled, "a second run without retry serves the stored one");
  assert.equal((await OB.leveled(USER, row, cals, {}, null, db.options)).leveled_status, "done");
});

test("once the resources are fitted the model is asked whether they are ready, and its answer rides on the turn", async () => {
  const asked = [];
  const db = fake({ model: { brainstorm: (text) => { asked.push(text); return { say: "You have enough to start.", card: "none", interest: "timing", ready: true }; } } });
  const row = await ready(db, { leveled_status: "done" });
  const cals = db.tables.engelbart_onboarding_calibrations;
  const out = await OB.brainstorm(USER, row, cals, { text: "I want the timing side" }, CREDS, db.options);
  assert.match(asked[0], /"ready": true \| false/);
  assert.match(asked[0], /`none` is allowed only with `ready` true/);
  assert.equal(out.ready, true);
  assert.equal(db.tables.engelbart_onboarding_turns[1].card.ready, true);
  const again = await OB.brainstorm(USER, row, cals, {}, CREDS, db.options);
  assert.equal(again.ready, true, "handing back the last card keeps its verdict");
});

test("a brainstorm turn stores both sides, carries the card, and keeps the interest current", async () => {
  const asked = [];
  const db = fake({ model: { brainstorm: (text) => { asked.push(text); return asked.length === 1
    ? { say: "What drew you here?", card: "questions", interest: "", questions: { eyebrow: "first", items: [
        { id: "drew", type: "mcq", title: "What drew you?", options: [{ label: "The dancing" }, { label: "The math" }] }] } }
    : { say: "Good.", card: "focus", interest: "the geometry of poses", focus: { title: "Which?", options: [{ label: "Angles", why: "a" }, { label: "Timing", why: "b" }] } }; } } });
  const row = await ready(db, { assets_brief: [{ title: "Pose viewer", type: "demo", one_liner: "views poses" }] });
  const cals = db.tables.engelbart_onboarding_calibrations;
  const first = await OB.brainstorm(USER, row, cals, {}, CREDS, db.options);
  assert.equal(first.card, "questions");
  assert.equal(first.say, "What drew you here?");
  assert.match(asked[0], /Pose viewer \(demo\): views poses/, "the brief is in the prompt");
  assert.equal(db.tables.engelbart_onboarding_turns.length, 1, "the opening turn is the model's alone");
  const repeat = await OB.brainstorm(USER, row, cals, {}, CREDS, db.options);
  assert.equal(repeat.card, "questions");
  assert.equal(asked.length, 1, "asking again with nothing new hands back the last card");
  const second = await OB.brainstorm(USER, row, cals, { answers: { drew: "The math" } }, CREDS, db.options);
  assert.equal(second.card, "focus");
  assert.match(asked[1], /They: What drew you\? The math/);
  assert.equal(row.interest, "the geometry of poses");
  assert.equal(row.step, OB.STEP.brainstorm);
  const turns = db.tables.engelbart_onboarding_turns;
  assert.deepEqual(turns.map((t) => t.role), ["assistant", "user", "assistant"]);
  assert.deepEqual(turns[1].card, { answers: { drew: "The math" } }, "the user turn keeps the answers beside the text");
  assert.equal(turns[2].card.card, "focus");
  // Readiness is the model's call, and only asked for once the resources are fitted.
  assert.match(asked[0], /opening turn/);
  assert.doesNotMatch(asked[1], /"ready"/, "not asked while the resources are still being fitted");
  assert.equal(second.ready, false);
  assert.equal(turns[2].card.ready, false);
  const opened = await OB.open(USER, {}, db.options);
  assert.equal(opened.turns.length, 3, "the transcript comes back with the row");
  assert.equal(opened.turns[0].card.questions.items[0].id, "drew");
});

test("asking about an asset threads on its key; choosing one keeps the child's parent and resets the plan", async () => {
  const db = fake({ model: { assetAsk: { answer: "Start with the toy." } } });
  const row = await ready(db, { leveled: LEVELED, leveled_status: "done", direction: DIRECTION });
  const cals = db.tables.engelbart_onboarding_calibrations;
  await assert.rejects(OB.assetAsk(USER, row, cals, { key: "Nope", question: "?" }, CREDS, db.options), (e) => e.statusCode === 400);
  const out = await OB.assetAsk(USER, row, cals, { key: "Pose viewer :: Toy poses", question: "Where do I start?" }, CREDS, db.options);
  assert.equal(out.answer, "Start with the toy.");
  const turns = db.tables.engelbart_onboarding_turns;
  assert.deepEqual(turns.map((t) => [t.stage, t.asset_key, t.role]), [["asset", "Pose viewer :: Toy poses", "user"], ["asset", "Pose viewer :: Toy poses", "assistant"]]);
  const chosen = await OB.chooseAsset(USER, row, { key: "Pose viewer :: Toy poses" }, db.options);
  assert.equal(chosen.asset_chosen.title, "Toy poses");
  assert.equal(chosen.asset_chosen.parent, "Pose viewer");
  assert.equal(chosen.asset_chosen.children, undefined);
  assert.equal(row.direction, null, "a new pick starts the plan over");
  assert.equal(row.step, OB.STEP.direction);
  assert.equal(OB.findAsset(row, "Dance corpus").parent, null);
});

test("one direction, revised on feedback; three subgoals, revised on feedback; todos for the first piece only", async () => {
  const seen = [];
  const db = fake({ model: { direction: (text) => { seen.push(text); return /Revise the direction/.test(text)
    ? { ...DIRECTION, title: "Pose to angles, live" } : DIRECTION; }, subgoals: SUBGOALS,
    todos: { todos: ["Draw one pose from the toy set", "Label its angles"], name: "pose-angles" } } });
  const row = await ready(db, { leveled: LEVELED, leveled_status: "done", interest: "geometry", project_name: "" });
  const cals = db.tables.engelbart_onboarding_calibrations;
  await assert.rejects(OB.direction(USER, row, cals, {}, CREDS, db.options), (e) => e.statusCode === 409, "needs a pick");
  await OB.chooseAsset(USER, row, { key: "Pose viewer" }, db.options);
  const first = await OB.direction(USER, row, cals, {}, CREDS, db.options);
  assert.equal(first.direction.title, "Pose to angles");
  assert.match(seen[0], /Choose ONE direction/);
  assert.match(seen[0], /What they are drawn to: "geometry"/);
  assert.equal((await OB.direction(USER, row, cals, {}, CREDS, db.options)).direction.title, "Pose to angles");
  assert.equal(seen.length, 1, "asking again serves the stored one");
  const revised = await OB.direction(USER, row, cals, { revise: "make it live video" }, CREDS, db.options);
  assert.equal(revised.direction.title, "Pose to angles, live");
  assert.match(seen[1], /What they want changed: "make it live video"/);
  assert.match(seen[1], /Pose to angles/);
  const dturns = db.tables.engelbart_onboarding_turns.filter((t) => t.stage === "direction");
  assert.deepEqual(dturns.map((t) => t.role), ["assistant", "user", "assistant"]);

  const sg = await OB.subgoals(USER, row, cals, {}, CREDS, db.options);
  assert.equal(sg.subgoals.length, 3);
  assert.equal(row.step, OB.STEP.subgoals);
  await OB.subgoals(USER, row, cals, { revise: "swap two and three" }, CREDS, db.options);
  assert.equal(db.tables.engelbart_onboarding_turns.filter((t) => t.stage === "subgoals").length, 3);

  const rows = await OB.todos(USER, row, cals, {}, CREDS, db.options);
  assert.deepEqual(rows.todos, ["Draw one pose from the toy set", "Label its angles"]);
  assert.equal(rows.name, "pose-angles");
  assert.equal(row.goal_chosen, "Pose to angles, live");
  const prompt = db.calls.filter((c) => c.url.endsWith("/v1/messages")).pop().init.body;
  assert.match(prompt, /One pose drawn/);
  assert.doesNotMatch(prompt, /Write rows for the other pieces/);
  assert.equal(row.step, OB.STEP.todos);
  // Re-deciding the direction throws the pieces and rows away.
  await OB.direction(USER, row, cals, { revise: "again" }, CREDS, db.options);
  assert.equal(row.subgoals, null);
  assert.equal(row.todos, null);
});

test("create maps the direction and its pieces to the payload: one goal, three subgoals, rows on the first", async () => {
  const db = fake();
  const row = await ready(db, { direction: DIRECTION, subgoals: SUBGOALS.subgoals, todos: ["Draw one pose", "Label angles"],
    project_name: "pose-angles", asset_chosen: { key: "Pose viewer", title: "Pose viewer", links: [{ kind: "live_demo", url: "https://x.org/demo" }] },
    interest: "geometry", goal_chosen: "", goals: null });
  const cals = db.tables.engelbart_onboarding_calibrations;
  const out = await OB.create(USER, row, cals, {}, db.options);
  assert.equal(out.ok, true);
  const payload = db.rpcs.find((r) => r.name === "engelbart_save_pending_setup").body.p_payload;
  assert.deepEqual(payload.goals, [{ label: "Pose to angles", why: "The geometry is the point." }]);
  assert.equal(payload.chosen, "Pose to angles");
  assert.deepEqual(payload.todos, []);
  assert.equal(payload.subgoals.length, 3);
  assert.deepEqual(payload.subgoals[0].todos, ["Draw one pose", "Label angles"]);
  assert.deepEqual(payload.subgoals[1].todos, []);
  assert.equal(payload.subgoals[2].description, "d3");
  assert.equal(payload.subgoals[2].why, "w3");
  assert.match(payload.plan.description, /turns a pose into joint angles[\s\S]*Building on “Zebra Tuning”[\s\S]*Starting from Pose viewer <https:\/\/x\.org\/demo>[\s\S]*What drew them: geometry/);
  assert.equal(payload.provenance.idea.title, "Pose to angles");
  assert.equal(row.goal_chosen, "Pose to angles");
  assert.equal(row.step, OB.STEP.done);
  assert.equal(row.status, "created");
  const normalized = SetupChat.normalizePayload(payload);
  assert.equal(normalized.subgoals.length, 3);
  assert.deepEqual(normalized.subgoals[0].todos, ["Draw one pose", "Label angles"]);
});

test("create refuses without a direction, three subgoals, and two rows", async () => {
  const db = fake();
  const row = await ready(db, { direction: null, subgoals: null, todos: ["a", "b"], project_name: "p" });
  await assert.rejects(OB.create(USER, row, [], {}, db.options), /direction/);
  row.direction = DIRECTION;
  await assert.rejects(OB.create(USER, row, [], {}, db.options), /subgoals/);
  row.subgoals = SUBGOALS.subgoals; row.todos = ["a"];
  await assert.rejects(OB.create(USER, row, [], {}, db.options), /two todos/);
  assert.equal(row.status, "open");
});
