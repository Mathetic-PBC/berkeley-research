"use strict";

// Real mode of the debugger: the adapter that turns a persisted telemetry
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
  // Labelled the way the simulator labels the same actions, so the Requests view reads the same in both modes.
  assert.deepEqual(plain(rec.stages.map((s) => s.label)), ["onboarding · open", "onboarding · step", "onboarding · sources", "onboarding · analysis (run)"]);
  assert.deepEqual(plain(rec.stages.map((s) => s.path)), Array(4).fill("/api/engelbart-onboarding"), "each recorded action was one POST to the endpoint");
  assert.deepEqual(plain(rec.stages.map((s) => s.method)), Array(4).fill("POST"));
  assert.deepEqual(plain(rec.stages.map((s) => s.root)), ["onboarding.open", "onboarding.step", "onboarding.sources", "onboarding.analysis"]);
  assert.deepEqual(plain(rec.stages.map((s) => s.modelCount)), [0, 0, 0, 1], "the one action that asked the model is marked");
  assert.equal(rec.stages[3].bg, true, "the run flag the server recorded is the background mark");
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
  assert.equal(orphan.method, "ACTION");
  assert.equal(orphan.label, "onboarding · open", "the action the operations recorded still names the row");
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
  await client.trace("tok", "a7552ec53c282068e729fef8b025b8d6");
  const api = calls.filter((c) => c.url.startsWith("/api/engelbart-telemetry"));
  assert.deepEqual(plain(api.map((c) => c.url)), ["/api/engelbart-telemetry", "/api/engelbart-telemetry?run=run-1", "/api/engelbart-telemetry?snapshot=snap-1", "/api/engelbart-telemetry?trace=a7552ec53c282068e729fef8b025b8d6"]);
  for (const c of api) { assert.equal(c.method, "GET"); assert.equal(c.auth, "Bearer tok"); }
  assert.ok(!calls.some((c) => c.url.includes("engelbart-onboarding")), "the onboarding endpoint is never touched");
  const none = R.client({ fetch, supabase: null });
  assert.equal(await none.session(), null, "without supabase-js there is no session, and no request is guessed");
});

// --- what the browser reported, joined to what the server recorded --------------------------------

const TRACE = { open: "da7a9b2cdab30b007e5fa8fdbdf79e32", step: "c857eb5dcb4e5dea436fea805844cba0" };

function request(id, over = {}) {
  return { id, at: 1_000 + id, method: "POST", path: "/api/engelbart-onboarding", where: "api", action: "open", request: { action: "open" },
    response: { onboarding: { id: FIXTURE.run.onboarding_id } }, status: "ok", code: 200, ms: 120, step: "Name", bg: false, poll: false, trace_id: null, ...over };
}

test("a reported request joins the row of the trace its reply named; requests the server did not trace are rows of their own, in the browser's order", () => {
  const R = load();
  const requests = [
    request(1, { trace_id: TRACE.open }),
    request(2, { method: "GET", path: "/api/engelbart-config", action: "engelbart-config", request: null, response: { supabaseUrl: "https://x.supabase.co" } }),
    request(3, { action: "step", request: { action: "step", name: "Ada" }, trace_id: TRACE.step, code: 200, ms: 88, step: "Paper" }),
    request(4, { action: "analysis", request: { action: "analysis" }, poll: true, response: { analysis: { status: "running" } } }),
    request(5, { action: "analysis", request: { action: "analysis" }, poll: true, response: { analysis: { status: "running" } } }),
    request(6, { action: "analysis", request: { action: "analysis" }, poll: true, response: { analysis: { status: "done" } }, ms: 95 }),
    request(7, { action: "sources", request: { action: "sources" }, trace_id: "0123456789abcdef0123456789abcdef", status: "ok" }),
    request(8, { action: "assets", request: { action: "assets", run: true }, bg: true, trace_id: "fedcba9876543210fedcba9876543210", trace: "missing", traceError: "not found" }),
    request(9, { method: "PUT", path: "/storage/v1/object/berkeley-papers/papers/x.pdf", where: "storage", action: null, request: { bytes: 1998042, type: "application/pdf" }, response: { ok: true, status: 200 }, status: "running", code: null, ms: 0 }),
  ];
  const rec = R.adapt(envelope(), { requests, name: "Current session" });
  assert.equal(rec.name, "Current session");
  const rows = rec.stages.map((s) => [s.label, s.observed === true, s.earlier === true, s.awaiting || null, s.count || null]);
  assert.deepEqual(plain(rows), [
    ["onboarding · sources", false, true, null, null],
    ["onboarding · analysis (run)", false, true, null, null],
    ["onboarding · open", true, false, null, null],
    ["config · engelbart-config", true, false, null, null],
    ["onboarding · step", true, false, null, null],
    ["onboarding · analysis (poll)", true, false, null, 3],
    ["onboarding · sources", true, false, "pending", null],
    ["onboarding · assets (run)", true, false, "missing", null],
    ["storage · upload", true, false, null, null],
  ], "traces the browser did not ask for come first as history; the session follows in request order");
  assert.deepEqual(plain(rec.stages.map((s) => s.seq)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const open = rec.stages[2];
  assert.equal(open.id, FIXTURE.operations.find((o) => o.name === "onboarding.open").operation_id, "the joined row is still the workflow root");
  assert.equal(open.real, true);
  assert.equal(open.requestId, 1);
  assert.deepEqual(plain(open.request), { action: "open" }, "what the browser sent");
  assert.deepEqual(plain(open.response), { onboarding: { id: FIXTURE.run.onboarding_id } }, "what the browser got back");
  assert.equal(open.code, 200);
  assert.equal(open.browserMs, 120, "the round trip the browser measured, next to the server's own duration");
  assert.equal(open.ms, 46.882, "the server's duration is the recorded one");
  assert.equal(open.step, "Name");
  assert.ok(open.ops.length > 0, "its operations are the trace's");

  const step = rec.stages[4];
  assert.equal(step.trace_id, TRACE.step);
  assert.equal(step.ops.map((o) => o.name).includes("db.patch"), true);

  const polls = rec.stages[5];
  assert.equal(polls.untraced, true);
  assert.equal(polls.ops.length, 0, "an untraced poll has nothing recorded under it");
  assert.equal(polls.polls.length, 3);
  assert.deepEqual(plain(polls.response), { analysis: { status: "done" } }, "the latest poll's reply is the row's");
  assert.equal(polls.ms, 95);
  assert.equal(polls.last, 1_006);

  const pending = rec.stages[6];
  assert.equal(pending.observed, true);
  assert.equal(pending.real, false);
  assert.equal(pending.untraced, false);
  assert.equal(pending.trace_id, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(plain(pending.ops), []);
  const missing = rec.stages[7];
  assert.equal(missing.awaiting, "missing");
  assert.equal(missing.traceError, "not found");
  assert.equal(missing.bg, true);
  const upload = rec.stages[8];
  assert.equal(upload.direct, true);
  assert.equal(upload.surface, "storage");
  assert.equal(upload.status, "running");
  assert.deepEqual(plain(upload.request), { bytes: 1998042, type: "application/pdf" }, "the upload is reported by size, never by content");

  const alone = R.adapt(envelope(), { requests: [request(1, { trace_id: TRACE.open })] });
  assert.equal(alone.stages.filter((s) => s.earlier).length, 3);
  const nothing = R.adapt({ operations: [], snapshots: [], events: [] }, { requests: [] });
  assert.deepEqual(plain(nothing.stages), []);
  assert.equal(nothing.name, "run");
});

test("a request whose trace has not been read yet is a row without operations; once the trace is merged in, the same request is the trace's row", () => {
  const R = load();
  const rq = request(1, { trace_id: TRACE.open });
  const before = R.adapt({ operations: [], snapshots: [], events: [] }, { requests: [rq] });
  assert.equal(before.stages.length, 1);
  assert.equal(before.stages[0].id, "req:1");
  assert.equal(before.stages[0].awaiting, "pending");
  const env = envelope();
  const only = { ...env, operations: env.operations.filter((o) => o.trace_id === TRACE.open), snapshots: env.snapshots, events: env.events.filter((e) => e.trace_id === TRACE.open) };
  const after = R.adapt(R.mergeEnvelope({ operations: [], snapshots: [], events: [] }, only), { requests: [rq] });
  assert.equal(after.stages.length, 1);
  assert.equal(after.stages[0].id, FIXTURE.operations.find((o) => o.name === "onboarding.open").operation_id);
  assert.equal(after.stages[0].observed, true);
  assert.equal(after.stages[0].awaiting, undefined);
  assert.deepEqual(plain(after.stages[0].ops.map((o) => o.name)), ["row.load", "db.insert", "calibrations.load", "turns.load"]);
});

test("folding polls keeps rows that are not consecutive untraced polls of the same action apart", () => {
  const R = load();
  const rows = [
    R.observedStage(request(1, { action: "analysis", poll: true })),
    R.observedStage(request(2, { action: "assets", poll: true })),
    R.observedStage(request(3, { action: "assets", poll: true })),
    R.observedStage(request(4, { action: "assets", poll: true, trace_id: "0123456789abcdef0123456789abcdef" })),
    R.observedStage(request(5, { action: "assets", poll: true })),
  ];
  const folded = R.foldPolls(rows);
  assert.deepEqual(plain(folded.map((s) => [s.action, s.count || 1, s.untraced])), [["analysis", 1, true], ["assets", 2, true], ["assets", 1, false], ["assets", 1, true]]);
  assert.equal(R.observedStage(request(9, { method: "PUT", path: "/storage/v1/object/b/o.pdf", where: "storage", action: null })).label, "storage · upload");
  assert.equal(R.observedStage(request(10, { method: "GET", path: "/api/engelbart-config", action: "engelbart-config" })).surface, "config");
  assert.equal(R.observedStage(request(11, { path: "/api/engelbart-device", action: "pair" })).label, "device · pair");
  assert.equal(R.surfaceOfPath("/api/engelbart-setup"), "setup");
  assert.equal(R.surfaceOfPath("/somewhere/else"), "client");
});

test("merging a trace into a run keeps one record per operation, event and snapshot, and never drops content it already has", () => {
  const R = load();
  const env = envelope();
  const open = env.operations.filter((o) => o.trace_id === TRACE.open);
  const first = { contract_version: env.contract_version, run: env.run, onboarding: env.onboarding, operations: open, events: env.events.filter((e) => e.trace_id === TRACE.open),
    snapshots: env.snapshots.filter((s) => open.some((o) => Object.values(o.snapshots || {}).includes(s.snapshot_id))).map((s) => { const { content, ...meta } = s; return { ...meta, content_omitted: true }; }),
    snapshots_inline: false };
  const merged = R.mergeEnvelope(first, env);
  assert.equal(merged.operations.length, env.operations.length, "an operation read twice is one row");
  assert.equal(merged.events.length, env.events.length);
  assert.equal(merged.snapshots.length, env.snapshots.length);
  assert.ok(merged.snapshots.every((s) => s.content !== undefined), "a snapshot with content replaces the same snapshot without it");
  assert.equal(merged.snapshots_inline, false, "an envelope that left content out is remembered as such");
  const back = R.mergeEnvelope(env, first);
  assert.ok(back.snapshots.every((s) => s.content !== undefined), "content already held is not lost to a later read without it");
  assert.equal(R.mergeEnvelope(null, { operations: open }).operations.length, open.length);
  assert.deepEqual(plain(R.mergeEnvelope(null, null)), { contract_version: null, run: null, onboarding: null, operations: [], snapshots: [], events: [], snapshots_inline: true });
  const rec = R.adapt(merged);
  assert.equal(rec.stages.length, 4);
  assert.equal(R.snapshotOf(rec, rec.stages[3].ops.find((o) => o.kind === "model").snaps.input).state, "ready");
});
