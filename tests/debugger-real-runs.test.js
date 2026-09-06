"use strict";

// Real runs mode of the debugger: the adapter that turns a persisted telemetry
// envelope into the runs, stages and operations the debugger draws. Run under
// Node on the documented example envelope, so the mapping is checked against
// the contract's real shapes and nothing the simulator invents leaks in.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "observability", "example-onboarding-analysis-run.json"), "utf8"));

// Values built inside the sandbox have that realm's prototypes; compared as plain data.
function plain(x) { return JSON.parse(JSON.stringify(x)); }

function load(extra = {}) {
  const sandbox = Object.assign({ console }, extra);
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "engelbart", "setup", "test", "real-runs.js"), "utf8"), sandbox, { filename: "real-runs.js" });
  return sandbox.EGB_REAL;
}

function envelope(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(FIXTURE)), snapshots_inline: true, onboarding: { onboarding_id: FIXTURE.run.onboarding_id, onboarding_status: "open", step: 4, project_name: "Speculative decoding", paper_title: "Fast Inference" }, ...overrides };
}

test("each workflow root becomes one request row, in start order, with its descendants as operation rows", () => {
  const R = load();
  const rec = R.adapt(envelope());
  assert.equal(rec.real, true);
  assert.equal(rec.name, "Speculative decoding");
  assert.deepEqual(plain(rec.stages.map((s) => s.label)), ["open", "step", "sources", "analysis"]);
  assert.deepEqual(plain(rec.stages.map((s) => s.path)), ["onboarding.open", "onboarding.step", "onboarding.sources", "onboarding.analysis"]);
  const roots = FIXTURE.operations.filter((op) => op.type === "workflow");
  assert.deepEqual(plain(rec.stages.map((s) => s.id)), roots.map((op) => op.operation_id), "a stage is its workflow root");
  const total = rec.stages.reduce((n, s) => n + s.ops.length, 0);
  assert.equal(total, FIXTURE.operations.length - roots.length, "every non-root operation is a row exactly once");
  for (const s of rec.stages) {
    assert.equal(s.status, "ok");
    assert.equal(s.request, null, "no request body was recorded, so none is shown");
    assert.equal(s.response, null);
    assert.equal(s.ms, roots.find((op) => op.operation_id === s.id).duration_ms, "the recorded duration, not a computed one");
    for (const o of s.ops) { assert.deepEqual(plain(o.reads), []); assert.deepEqual(plain(o.writes), []); assert.equal(o.meta.cost, undefined, "no cost is invented"); }
  }
  const analysis = rec.stages[3];
  assert.equal(analysis.outcome, "done");
  const names = analysis.ops.map((o) => " ".repeat(o.depth) + o.name);
  assert.ok(names.indexOf(" project-page.fetch") > names.indexOf("analysis.context"), "a child follows its parent, indented");
  assert.ok(names.includes("  page.extract-text"), "a grandchild is two deep");
});

test("a model operation carries its recorded model, usage and the three snapshots the inspector shows", () => {
  const R = load();
  const rec = R.adapt(envelope());
  const op = rec.stages[3].ops.find((o) => o.kind === "model");
  const src = FIXTURE.operations.find((o) => o.type === "model");
  assert.equal(op.name, "model.analysis");
  assert.equal(op.target, "claude-sonnet-4-5-20250929 via proxy.example.com");
  assert.equal(op.meta.model, src.attributes["gen_ai.response.model"]);
  assert.equal(op.meta.family, "sonnet");
  assert.deepEqual(plain(op.meta.tokens), { input: 1843, output: 1276, cache_read: 0, cache_write: 21470 });
  assert.equal(op.snaps.input, src.snapshots.model_request);
  assert.equal(op.snaps.output, src.snapshots.model_parsed_response);
  assert.equal(op.snaps.raw, src.snapshots.model_raw_response);
  assert.equal(op.ms, src.duration_ms);
  const input = R.snapshotOf(rec, op.snaps.input);
  assert.equal(input.state, "ready");
  assert.equal(input.content.body.model, "claude-sonnet-4-5-20250929", "the request snapshot is the recorded body");
  assert.equal(R.snapshotOf(rec, op.snaps.output).kind, "model_parsed_response");
  assert.equal(R.snapshotOf(rec, op.snaps.raw).kind, "model_raw_response");
});

test("a database operation shows where it went and its request and response snapshots", () => {
  const R = load();
  const rec = R.adapt(envelope());
  const op = rec.stages[3].ops.find((o) => o.name === "analysis.persist");
  const src = FIXTURE.operations.find((o) => o.name === "analysis.persist");
  assert.equal(op.kind, "db");
  assert.equal(op.target, "PATCH /rest/v1/engelbart_onboardings?id=eq.?");
  assert.equal(op.snaps.input, src.snapshots.database_request);
  assert.equal(op.snaps.output, src.snapshots.database_response);
  assert.equal(R.snapshotOf(rec, op.snaps.input).state, "ready");
  assert.equal(R.snapshotOf(rec, op.snaps.output).state, "ready");
  const storage = rec.stages[3].ops.find((o) => o.kind === "storage");
  assert.equal(storage.target, "GET berkeley-papers/papers/3f9c1b2a-7d8e-4f60-b1c2-d3e4f5a6b7c8.pdf");
  const web = rec.stages[3].ops.find((o) => o.kind === "web");
  assert.equal(web.target, "GET https://specdec.example.edu/paper");
  const text = rec.stages[3].ops.find((o) => o.name === "page.extract-text");
  assert.equal(text.kind, "processing");
  assert.equal(text.snaps.output, src.snapshots.database_request === undefined ? null : FIXTURE.operations.find((o) => o.name === "page.extract-text").snapshots.page_text, "page text is the extraction's output");
});

test("status, errors and missing pieces are shown as recorded, never filled in", () => {
  const R = load();
  const env = envelope();
  const persist = env.operations.find((o) => o.name === "analysis.persist");
  persist.status = "failed"; persist.error = { name: "ServiceError", message: "row gone", status_code: 409 };
  const root = env.operations.find((o) => o.name === "onboarding.analysis");
  root.status = "failed"; root.error = { name: "Error", message: "analysis failed" };
  const running = env.operations.find((o) => o.name === "model.analysis");
  running.status = "running"; running.ended_at = null; running.duration_ms = null;
  // One snapshot left out of the response, one never stored.
  env.snapshots_inline = false;
  env.snapshots = env.snapshots.map((s) => { const { content, ...meta } = s; return { ...meta, content_omitted: true }; });
  const rec = R.adapt(env);
  const stage = rec.stages[3];
  assert.equal(stage.status, "error");
  assert.deepEqual(plain(stage.error), root.error);
  const failed = stage.ops.find((o) => o.id === persist.operation_id);
  assert.equal(failed.status, "error");
  assert.equal(failed.error.message, "row gone");
  const live = stage.ops.find((o) => o.id === running.operation_id);
  assert.equal(live.status, "running");
  assert.equal(live.ms, 0);
  assert.equal(rec.snapshotsInline, false);
  const pending = R.snapshotOf(rec, live.snaps.input);
  assert.equal(pending.state, "pending");
  assert.ok(pending.bytes > 0);
  assert.equal(R.snapshotOf(rec, "00000000-0000-4000-8000-000000000000").state, "missing");
  assert.equal(R.snapshotOf(rec, null).state, "none");
});

test("a trace with no workflow root is still shown, named for what it is; a run with no names falls back to its id", () => {
  const R = load();
  const env = envelope({ onboarding: { onboarding_id: FIXTURE.run.onboarding_id, onboarding_status: "open" } });
  env.operations = env.operations.filter((o) => o.name !== "onboarding.open");
  const rec = R.adapt(env);
  assert.equal(rec.name, "onboarding " + FIXTURE.run.onboarding_id.slice(0, 8));
  const orphan = rec.stages[0];
  assert.equal(orphan.synthetic, true);
  assert.match(orphan.path, /no workflow root recorded/);
  assert.equal(orphan.ops.length, FIXTURE.operations.filter((o) => o.action === "open").length - 1);
  assert.equal(rec.stages.length, 4);
});

test("the browser client only ever issues GETs with the member's bearer token, and reads the session through supabase-js", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: (init && init.method) || "GET", auth: init && init.headers && init.headers.Authorization });
    if (url === "/api/engelbart-config") return { ok: true, json: async () => ({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" }) };
    return { ok: true, status: 200, json: async () => ({ runs: [] }) };
  };
  let created = null;
  const supabase = { createClient: (url, key, opts) => { created = { url, key, opts }; return { auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { email: "m@example.com" } } } }) } }; } };
  const R = load({ fetch, supabase });
  const client = R.client({ fetch, supabase });
  const session = await client.session();
  assert.deepEqual(plain(session), { token: "tok", email: "m@example.com" });
  assert.equal(created.url, "https://x.supabase.co");
  assert.equal(created.opts.auth.persistSession, true);
  await client.list("tok");
  await client.run("tok", "run-1");
  await client.snapshot("tok", "snap-1");
  const api = calls.filter((c) => c.url.startsWith("/api/engelbart-telemetry"));
  assert.deepEqual(plain(api.map((c) => c.url)), ["/api/engelbart-telemetry", "/api/engelbart-telemetry?run=run-1", "/api/engelbart-telemetry?snapshot=snap-1"]);
  for (const c of api) { assert.equal(c.method, "GET"); assert.equal(c.auth, "Bearer tok"); }
  assert.ok(!calls.some((c) => c.url.includes("engelbart-onboarding")), "the onboarding endpoint is never touched");
  const none = R.client({ fetch, supabase: null });
  assert.equal(await none.session(), null, "without supabase-js there is no session, and no request is guessed");
});
