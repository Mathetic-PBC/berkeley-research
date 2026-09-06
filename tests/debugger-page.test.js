"use strict";

// The debugger page (debugger.js) in Real mode: the same request list and
// inspector the simulator fills, fed by what the frame reports and by the
// traces the telemetry endpoint returns. Mounted under Node on a stand-in for
// React that keeps the component's logic and skips the DOM, with the real
// adapter (real-runs.js) and the documented example envelope behind a fake
// endpoint. Nothing here reaches a network or a real Supabase project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "engelbart", "setup", "test");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "observability", "example-onboarding-analysis-run.json"), "utf8"));
const ORIGIN = "https://app.example";
const OB = FIXTURE.run.onboarding_id;
const TRACE = { open: "da7a9b2cdab30b007e5fa8fdbdf79e32", step: "c857eb5dcb4e5dea436fea805844cba0", analysis: "a7552ec53c282068e729fef8b025b8d6" };
const ROOTS = {}; FIXTURE.operations.filter((o) => o.type === "workflow").forEach((o) => { ROOTS[o.action] = o.operation_id; });
const MODEL_OP = FIXTURE.operations.find((o) => o.type === "model").operation_id;
const TOKEN = "member-token";

function plain(x) { return JSON.parse(JSON.stringify(x)); }
// Values built in the sandbox have that realm's prototypes: compared as plain data.
function same(actual, expected, message) { assert.deepEqual(plain(actual), plain(expected), message); }
async function settle(rounds = 8) { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); }

// React, as far as the component uses it: a base class with setState/forceUpdate, createElement as a plain tree, refs.
function fakeReact() {
  class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(patch, after) { const p = typeof patch === "function" ? patch(this.state) : patch; if (p) this.state = Object.assign({}, this.state, p); if (after) after(); }
    forceUpdate(after) { if (after) after(); }
  }
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) });
  return { Component, createElement, createRef: () => ({ current: null }) };
}
// Every string in a rendered tree, for asserting what a pane says.
function texts(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (node.props) { ["title", "value", "placeholder"].forEach((k) => { if (typeof node.props[k] === "string") out.push(node.props[k]); }); }
  (node.children || []).forEach((n) => texts(n, out));
  return out;
}
function find(node, pred, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  (node.children || []).forEach((n) => find(n, pred, out));
  return out;
}

// The telemetry endpoint the page reads, answering from the fixture; every call is kept for inspection.
function telemetryServer(options = {}) {
  const calls = [];
  const sub = (filter, onboarding) => ({ contract_version: FIXTURE.contract_version, run: FIXTURE.run, onboarding, operations: FIXTURE.operations.filter(filter),
    snapshots: options.inline === false ? FIXTURE.snapshots.map((s) => { const { content, ...meta } = s; return { ...meta, content_omitted: true }; }) : FIXTURE.snapshots,
    events: FIXTURE.events.filter(filter), snapshots_inline: options.inline !== false });
  const row = (id, extra) => Object.assign({ onboarding_id: id, onboarding_status: "open", step: 4, project_name: "Speculative decoding", paper_title: "Fast Inference", created_at: "2026-09-06T02:49:00.000Z" }, extra || {});
  const runs = [
    Object.assign({ run_id: OB }, row(OB), { telemetry: { started_at: FIXTURE.run.started_at, status: "completed", counts: FIXTURE.run.counts } }),
    Object.assign({ run_id: "ob-older" }, row("ob-older", { project_name: "Older project", created_at: "2026-09-01T10:00:00.000Z" }), { telemetry: { started_at: "2026-09-01T10:00:01.000Z", status: "failed", counts: { traces: 2 } } }),
    Object.assign({ run_id: "ob-blank" }, row("ob-blank", { project_name: "Never recorded" }), { telemetry: null }),
  ];
  const fetch = async (url, init) => {
    const method = (init && init.method) || "GET", auth = init && init.headers && init.headers.Authorization;
    calls.push({ url: String(url), method, auth });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url === "/api/engelbart-config") return json(200, { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" });
    const u = new URL(String(url), ORIGIN);
    if (u.pathname !== "/api/engelbart-telemetry") return json(404, { error: "Not found" });
    if (options.status) return json(options.status, { error: options.status === 401 ? "Sign in to Engelbart" : "Not an Engelbart member" });
    if (auth !== "Bearer " + TOKEN) return json(401, { error: "Sign in to Engelbart" });
    if (u.searchParams.has("trace")) {
      const t = u.searchParams.get("trace");
      if (!FIXTURE.run.trace_ids.includes(t)) return json(404, { error: "No trace by that id was recorded for you" });
      return json(200, Object.assign(sub((o) => o.trace_id === t, row(OB)), { trace_id: t }));
    }
    if (u.searchParams.has("run")) {
      const id = u.searchParams.get("run");
      if (id === OB) return json(200, sub(() => true, row(OB)));
      if (id === "ob-older") return json(200, sub((o) => o.trace_id === TRACE.analysis, row("ob-older", { project_name: "Older project" })));
      return json(404, { error: "No run by that id" });
    }
    if (u.searchParams.has("snapshot")) { const s = FIXTURE.snapshots.find((x) => x.snapshot_id === u.searchParams.get("snapshot")); return s ? json(200, { snapshot: s }) : json(404, { error: "No snapshot" }); }
    return json(200, { runs });
  };
  return { fetch, calls, telemetry: () => calls.filter((c) => c.url.startsWith("/api/engelbart-telemetry")) };
}

// The page, mounted: the component instance, the messages it sent the frame, and a way to send it the frame's.
function page(options = {}) {
  const store = new Map();
  const server = options.server || telemetryServer();
  const toFrame = [];
  const frameWindow = { postMessage(m, origin) { toFrame.push({ m: plain(m), origin }); } };
  const timers = { held: [] };
  const listeners = {};
  const React = fakeReact();
  let mounted = null;
  const sandbox = {
    console, URLSearchParams, URL,
    // Trace re-reads wait seconds between tries; those timers are held so a test can run them at once.
    setTimeout: (fn, ms) => { if (ms >= 500) { timers.held.push(fn); return -1; } return setTimeout(fn, ms); }, clearTimeout,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { origin: ORIGIN, search: options.search || "?test=true", href: ORIGIN + "/engelbart/setup/test" },
    document: { getElementById: () => ({ innerHTML: "" }), createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {}, style: {} }, addEventListener() {} },
    addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {},
    confirm: () => true, navigator: {},
    fetch: server.fetch,
    supabase: { createClient: () => ({ auth: { getSession: async () => (options.signedIn === false ? { data: { session: null } } : { data: { session: { access_token: TOKEN, user: { email: "member@berkeley.edu" } } } }) } }) },
    React, ReactDOM: { createRoot: () => ({ render(el) { mounted = new el.type(el.props); mounted.componentDidMount(); } }) },
  };
  if (options.mode) store.set("egb.debugger.mode", options.mode);
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ["fixture.js", "prompts.js", "sim-backend.js", "real-runs.js", "debugger.js"]) vm.runInContext(fs.readFileSync(path.join(DIR, file), "utf8"), sandbox, { filename: file });
  assert.ok(mounted, "the page mounted");
  mounted.frameRef.current = { contentWindow: frameWindow };
  const send = (data, from) => listeners.message(Object.assign({ origin: ORIGIN, source: frameWindow, data }, from || {}));
  const stages = () => mounted.state.recordings[0].stages;
  return { w: sandbox, d: mounted, server, toFrame, send, stages, store, timers, cmds: () => toFrame.map((x) => x.m.cmd),
    request: (id, over) => send(Object.assign({ egb: "request", id, at: 1_700_000_000_000 + Number(String(id).replace(/\D/g, "")), method: "POST", path: "/api/engelbart-onboarding", where: "api", action: "open", body: { action: "open" }, step: "Name", bg: false, poll: false }, over || {})),
    response: (id, over) => send(Object.assign({ egb: "response", id, at: 1_700_000_000_000 + 120, ms: 120, status: 200, ok: true, trace_id: null, body: { ok: true } }, over || {})) };
}

test("the stored mode decides how the page starts; Real mode never hands the frame the product's test switch, and hides the simulator's reset", async () => {
  const P = page({ mode: "real" });
  assert.equal(P.d.isReal(), true);
  const V = P.d.renderVals();
  assert.equal(V.frameSrc, "/engelbart/setup/test/frame?mode=real", "no env, no participant, and never test=true, although the page itself was opened with it");
  assert.equal(P.d.props.productTestMode, true);
  const bar = texts(P.d.renderTopBar(V));
  assert.ok(bar.includes("Simulated") && bar.includes("Real"), "the mode toggle");
  assert.ok(bar.includes("real actions"), "the warning badge");
  assert.ok(!bar.includes("Reset test environment"), "no reset button in Real mode");
  assert.ok(!bar.some((t) => /Configure this environment/.test(t)), "no environment menu in Real mode");
  assert.ok(texts(P.d.renderRealStrip()).join(" ").includes("Model calls spend real credit"), "the strip says what Real means");
  assert.ok(texts(P.d.render()).includes("Engelbart setup, running against the real backend"), "the frame is on the page in Real mode");
  assert.equal(find(P.d.render(), (n) => n.type === "iframe").length, 1);
  assert.equal(V.isRequestsView, true, "Real mode opens on Requests, where the work shows");
  assert.equal(V.stages.length, 0);
  await settle();
  same((P.server.telemetry()), [{ url: "/api/engelbart-telemetry", method: "GET", auth: "Bearer " + TOKEN }], "on entering, the run list is read for the picker, with the member's token");
  assert.equal(P.d.realVM().email, "member@berkeley.edu");

  const S = page({});
  assert.equal(S.d.isReal(), false);
  const VS = S.d.renderVals();
  assert.match(VS.frameSrc, /^\/engelbart\/setup\/test\/frame\?env=env-[a-z0-9]+&test=true$/, "Simulated mode still passes the test switch through");
  const sbar = texts(S.d.renderTopBar(VS));
  assert.ok(sbar.includes("Reset test environment") && !sbar.includes("real actions"));
  assert.equal(S.server.telemetry().length, 0, "the simulator never reads telemetry");
});

test("a request the frame reports is a row at once; when the reply names a trace, the trace is read and the row becomes the recorded action with its operations", async () => {
  const P = page({ mode: "real" });
  P.send({ egb: "ready", speed: 1, mode: "real" });
  assert.equal(P.d.state.connected, true);
  same(P.cmds(), [], "nothing is commanded of the real frame on ready: no speed, no snapshot, no prompts");
  P.request("rq-1");
  let rows = P.stages();
  assert.equal(rows.length, 1);
  same([rows[0].id, rows[0].label, rows[0].status, rows[0].observed, rows[0].untraced, rows[0].ops.length], ["req:rq-1", "onboarding · open", "running", true, true, 0]);
  assert.equal(P.d.renderVals().stages[0].dot, "#0070f3", "a running request is blue");
  // The reader opens the row and inspects it while it is still in flight.
  P.d.setState({ open: { "req:rq-1": true } }); P.d.select("live", "req:rq-1", null);
  P.response("rq-1", { trace_id: TRACE.open, body: { onboarding: { id: OB, status: "open", step: 1 }, credit: { status: "own" }, own_key: { set: true, last4: "1234" } } });
  rows = P.stages();
  same([rows[0].status, rows[0].code, rows[0].awaiting], ["ok", 200, "pending"], "answered, trace not yet read");
  assert.equal(P.d.renderVals().stages[0].tag, "reading trace…");
  await settle();
  rows = P.stages();
  const openRow = rows.find((s) => s.trace_id === TRACE.open);
  assert.equal(openRow.id, ROOTS.open, "the row is now the recorded workflow root");
  same([openRow.observed, openRow.real, openRow.requestId, openRow.code, openRow.browserMs, openRow.step], [true, true, "rq-1", 200, 120, "Name"]);
  same((openRow.ops.map((o) => o.name)), ["row.load", "db.insert", "calibrations.load", "turns.load"], "the operations the server recorded to answer it");
  same((openRow.request), { action: "open" });
  assert.equal(openRow.response.credit.status, "own");
  assert.equal(P.d.state.open[ROOTS.open], true, "the row stayed open across the change of id");
  same((P.d.state.sel), { run: "live", stage: ROOTS.open, op: null }, "and stayed selected");
  // The reply named the onboarding, so what was recorded for it before this page opened is drawn ahead, as history.
  assert.equal(P.d.state.real.onboardingId, OB);
  same((rows.map((s) => [s.label, !!s.earlier])), [["onboarding · step", true], ["onboarding · sources", true], ["onboarding · analysis (run)", true], ["onboarding · open", false]]);
  const V = P.d.renderVals();
  same(V.stages.map((s) => s.tag), ["earlier", "earlier", "background", ""]);
  same(V.stages.map((s) => s.modelPill), ["", "", "model", ""], "the one action that called a model is marked");
  assert.equal(V.stages[3].path, "POST /api/engelbart-onboarding");
  assert.equal(V.statTiles.find((t) => t.k === "model calls").v, "1");
  assert.equal(V.statTiles.find((t) => t.k === "tokens").v, (1843 + 1276).toLocaleString(), "tokens the model calls recorded, not an invented cost");
  assert.equal(P.d.state.recordings[0].name, "Speculative decoding", "the session is named for the onboarding once it is known");
  const insp = P.d.inspectorVM();
  same(insp.tabs.map((t) => t.label), ["Request", "Response", "Attributes"]);
  assert.equal(insp.json, JSON.stringify({ action: "open" }, null, 2), "the Request tab is what the browser sent");
  assert.ok(insp.meta.some((m) => m.k === "round trip" && m.v === "120 ms") && insp.meta.some((m) => m.k === "server time" && m.v === "47 ms"), "browser and server timings side by side");
  assert.ok(insp.meta.some((m) => m.k === "ops" && m.v === "4"));
  const reads = P.server.telemetry();
  assert.ok(reads.every((c) => c.method === "GET" && c.auth === "Bearer " + TOKEN), "telemetry is only ever read, as the member");
  assert.ok(reads.some((c) => c.url === "/api/engelbart-telemetry?trace=" + TRACE.open), "the trace the reply named was asked for by id");
  assert.ok(reads.some((c) => c.url === "/api/engelbart-telemetry?run=" + OB), "the onboarding's history was asked for once");
  assert.ok(!P.server.calls.some((c) => c.url.includes("engelbart-onboarding")), "the page never calls the onboarding endpoint itself");
});

test("a real model call's snapshots are inspectable: the request body sent to the model, the parsed reply and the raw reply, as recorded", async () => {
  const P = page({ mode: "real" });
  P.request("rq-1", { action: "analysis", body: { action: "analysis", run: true }, bg: true });
  P.response("rq-1", { trace_id: TRACE.analysis, body: { onboarding: { id: OB }, analysis: { status: "running" } } });
  await settle();
  const row = P.stages().find((s) => s.trace_id === TRACE.analysis);
  assert.equal(row.id, ROOTS.analysis);
  assert.equal(row.label, "onboarding · analysis (run)");
  const names = row.ops.map((o) => " ".repeat(o.depth) + o.name);
  same((names), ["row.load", "calibrations.load", "turns.load", "analysis.mark-running", "paper.download", "analysis.context", " project-page.fetch", "  page.extract-text", "analysis.construct-request", "model.analysis", "analysis.normalize", "analysis.check-superseded", "analysis.persist"]);
  P.d.select("live", ROOTS.analysis, MODEL_OP);
  let insp = P.d.inspectorVM();
  assert.equal(insp.kindLabel, "Model");
  assert.equal(insp.name, "model.analysis");
  assert.equal(insp.target, "claude-sonnet-4-5-20250929 via proxy.example.com");
  same(insp.tabs.map((t) => t.label), ["Input", "Output", "Raw reply", "Attributes", "Events"]);
  let body = JSON.parse(insp.json);
  assert.equal(body.body.model, "claude-sonnet-4-5-20250929"); assert.equal(body.body.max_tokens, 8192);
  assert.ok(Array.isArray(body.body.messages) && body.body.messages.length, "the model_request snapshot is the request as sent");
  assert.equal(insp.redacted, "1 secret redacted", "the stored request carries the server's redaction of its key, and the inspector counts it");
  assert.ok(!/sk-[A-Za-z0-9]{6}/.test(insp.json), "no key in the request as shown");
  assert.ok(insp.meta.some((m) => m.k === "in" && m.v === (1843).toLocaleString()) && insp.meta.some((m) => m.k === "out" && m.v === (1276).toLocaleString()) && insp.meta.some((m) => m.k === "cache write"));
  P.d.setState({ inspTab: "raw" }); insp = P.d.inspectorVM(); body = JSON.parse(insp.json);
  assert.equal(body.stop_reason, "end_turn", "the raw reply is the model's own message");
  P.d.setState({ inspTab: "output" }); insp = P.d.inspectorVM(); body = JSON.parse(insp.json);
  assert.equal(typeof body, "object");
  P.d.setState({ inspTab: "attrs" }); insp = P.d.inspectorVM(); body = JSON.parse(insp.json);
  assert.equal(body["gen_ai.usage.output_tokens"], 1276);
  assert.ok(!("authorization" in body) && !JSON.stringify(body).match(/sk-[A-Za-z0-9]{8}/), "no credential in the attributes");
  const persist = row.ops.find((o) => o.name === "analysis.persist");
  P.d.select("live", ROOTS.analysis, persist.id); P.d.setState({ inspTab: "input" });
  insp = P.d.inspectorVM();
  assert.equal(insp.kindLabel, "DB");
  assert.equal(insp.target, "PATCH /rest/v1/engelbart_onboardings?id=eq.?");
  assert.ok(JSON.parse(insp.json), "the database request snapshot is shown");
  const dl = row.ops.find((o) => o.name === "paper.download");
  P.d.select("live", ROOTS.analysis, dl.id);
  insp = P.d.inspectorVM();
  assert.equal(insp.kindLabel, "Storage");
  assert.equal(insp.tabs[0].label, "Attributes", "a storage read recorded no snapshot, so none is invented");
});

test("a snapshot the run left out is asked for once when its tab opens, and never twice", async () => {
  const server = telemetryServer({ inline: false });
  const P = page({ mode: "real", server });
  P.request("rq-1", { action: "analysis" }); P.response("rq-1", { trace_id: TRACE.analysis, body: { onboarding: { id: OB } } });
  await settle();
  P.d.select("live", ROOTS.analysis, MODEL_OP);
  let insp = P.d.inspectorVM();
  assert.match(insp.json, /^Loading \d+ KB…$/);
  P.d.inspectorVM(); P.d.inspectorVM();
  await settle();
  const modelReq = FIXTURE.operations.find((o) => o.operation_id === MODEL_OP).snapshots.model_request;
  assert.equal(server.telemetry().filter((c) => c.url === "/api/engelbart-telemetry?snapshot=" + modelReq).length, 1, "asked for once");
  insp = P.d.inspectorVM();
  assert.equal(JSON.parse(insp.json).body.max_tokens, 8192, "and shown once it arrived");
});

test("untraced requests are light rows of their own: consecutive status polls fold into one, the config read and the upload stand alone", async () => {
  const P = page({ mode: "real" });
  P.request("rq-1", { method: "GET", path: "/api/engelbart-config", action: "engelbart-config", body: null, step: null });
  P.response("rq-1", { body: { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "••••••••" } });
  for (const n of [2, 3, 4]) { P.request("rq-" + n, { action: "analysis", body: { action: "analysis" }, poll: true, step: "Paper" }); P.response("rq-" + n, { body: { analysis: { status: n === 4 ? "done" : "running" } } }); }
  P.request("rq-5", { method: "PUT", path: "/storage/v1/object/berkeley-papers/papers/p.pdf", where: "storage", action: "upload", body: { bytes: 1998042, type: "application/pdf" } });
  await settle();
  const rows = P.stages();
  same((rows.map((s) => [s.label, s.count || 1, s.status])), [["config · engelbart-config", 1, "ok"], ["onboarding · analysis (poll)", 3, "ok"], ["storage · upload", 1, "running"]]);
  const V = P.d.renderVals();
  same(V.stages.map((s) => s.tag), ["untraced", "poll ×3", "browser → storage"]);
  same(V.stages.map((s) => s.opsLabel), ["0 ops", "0 ops", "0 ops"], "nothing is invented under an untraced request");
  P.d.select("live", rows[1].id, null); P.d.setState({ inspTab: "output" });
  const insp = P.d.inspectorVM();
  same(JSON.parse(insp.json), { analysis: { status: "done" } }, "the latest poll's reply");
  assert.ok(insp.meta.some((m) => m.k === "trace" && m.v === "none: untraced request") && insp.meta.some((m) => m.k === "polls" && m.v === "3") && insp.meta.some((m) => m.k === "step" && m.v === "Paper"));
  P.d.select("live", rows[2].id, null);
  assert.ok(P.d.inspectorVM().meta.some((m) => m.k === "route" && m.v === "browser → Storage, no function"));
  assert.equal(P.server.telemetry().filter((c) => c.url.includes("trace=")).length, 0, "no trace is asked for when no reply named one");
});

test("a trace the server has nothing for is retried briefly, then said to be missing; the request row keeps what the browser saw", async () => {
  const P = page({ mode: "real" });
  const ghost = "ffffffffffffffffffffffffffffffff";
  P.request("rq-1", { action: "step", body: { action: "step", name: "Ada" } });
  P.response("rq-1", { trace_id: ghost, body: { onboarding: { id: OB, name: "Ada" } } });
  await settle();
  assert.equal(P.d.renderVals().stages.find((s) => s.label === "onboarding · step" && !s.tag.startsWith("earlier")).tag, "reading trace…");
  for (let i = 0; i < 3; i++) { assert.equal(P.timers.held.length, 1, "one retry is waiting"); P.timers.held.shift()(); await settle(); }
  assert.equal(P.timers.held.length, 0, "no more tries after the last delay");
  assert.equal(P.server.telemetry().filter((c) => c.url === "/api/engelbart-telemetry?trace=" + ghost).length, 4, "read once, then three more times");
  const row = P.stages().find((s) => s.trace_id === ghost);
  same([row.id, row.awaiting, row.status, row.code], ["req:rq-1", "missing", "ok", 200]);
  assert.match(row.traceError, /recorded nothing under this trace id/);
  const V = P.d.renderVals();
  assert.equal(V.stages.find((s) => s.id === "req:rq-1").tag, "trace not recorded");
  P.d.select("live", "req:rq-1", null); P.d.setState({ inspTab: "error" });
  const insp = P.d.inspectorVM();
  same(insp.tabs.map((t) => t.label), ["Request", "Response", "Error"]);
  assert.match(insp.json, /recorded nothing under this trace id/);
  assert.ok(insp.meta.some((m) => m.k === "trace" && m.v === "not recorded"));
  assert.equal(P.d.realVM().error, "", "a missing trace is the row's problem, not the page's");
});

test("the run picker opens an earlier run in the same panel and comes back to the session with what happened meanwhile counted", async () => {
  const P = page({ mode: "real" });
  P.request("rq-1"); P.response("rq-1", { trace_id: TRACE.open, body: { onboarding: { id: OB } } });
  await settle();
  let R = P.d.realVM();
  same(R.pickerOptions.map((o) => o.value), ["__current", "ob-older", "__refresh"], "this session, the other runs that recorded something (not the one the product is on, not one with nothing), refresh");
  assert.match(R.pickerOptions[1].label, /^Older project · .* · failed$/);
  assert.equal(R.pickerValue, "__current");
  const V0 = P.d.renderVals();
  assert.equal(find(P.d.renderTopBar(V0), (n) => n.type === "select" && n.props["data-run-picker"]).length, 1, "the picker is in the top bar");
  P.d.pickRun("ob-older");
  assert.equal(P.d.realVM().viewingPicked, true);
  await settle();
  assert.equal(P.d.state.real.loading, false);
  assert.equal(P.d.state.recordings[0].name, "Older project");
  same((P.stages().map((s) => [s.label, !!s.observed])), [["onboarding · analysis (run)", false]], "the picked run's own actions, none of them this session's");
  const V = P.d.renderVals();
  assert.equal(texts(P.d.renderLive(V)).some((t) => /^Earlier run · Older project/.test(t)), true);
  assert.equal(V.stages[0].modelPill, "model");
  assert.ok(P.server.telemetry().some((c) => c.url === "/api/engelbart-telemetry?run=ob-older"));
  // The product kept going on the left meanwhile.
  P.request("rq-2", { action: "step" }); P.response("rq-2", { trace_id: TRACE.step, body: { onboarding: { id: OB } } });
  await settle();
  assert.equal(P.stages().length, 1, "the picked run does not move");
  assert.equal(P.d.realVM().pickerOptions[0].label, "Current session · 1 new");
  P.d.pickRun("__current");
  await settle();
  assert.equal(P.d.realVM().viewingPicked, false);
  const back = P.stages();
  same((back.filter((s) => s.observed).map((s) => s.label)), ["onboarding · open", "onboarding · step"], "both requests, the second with its trace already in");
  assert.equal(back.find((s) => s.trace_id === TRACE.step).ops.length, 4);
  P.d.pickRun("__refresh");
  await settle();
  assert.equal(P.server.telemetry().filter((c) => c.url === "/api/engelbart-telemetry").length, 3, "the list was read on entry, when the onboarding became known, and on refresh");
});

test("switching modes keeps each side's state: the simulator's tabs survive a visit to Real mode, and Real mode's session survives a visit back", async () => {
  const P = page({});
  P.send({ egb: "ready", speed: 1, mode: "sim" });
  same(P.cmds(), ["speed", "snapshot", "prompts"], "the simulated frame is configured on ready");
  // A simulated request, from the real simulator, so its events are the genuine ones.
  const events = [];
  const sim = P.w.EngelbartSim.create({ emit: (ev) => events.push(plain(ev)), speed: 0 });
  await sim.handle("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "open" }) });
  events.forEach((ev) => P.send({ egb: "trace", event: ev }));
  await new Promise((r) => setTimeout(r, 80));
  const simStage = P.stages();
  assert.equal(simStage.length, 1);
  assert.equal(simStage[0].path, "/api/engelbart-onboarding");
  assert.ok(simStage[0].ops.length >= 3);
  assert.ok(simStage[0].ops.every((o) => Array.isArray(o.reads)), "the simulator's lineage is there");
  assert.equal(P.d.renderVals().flowHasNodes, true, "and the graph draws it");

  P.d.setMode("real");
  assert.equal(P.d.isReal(), true);
  assert.equal(P.store.get("egb.debugger.mode"), "real", "the choice is remembered");
  assert.equal(P.stages().length, 0, "Real mode starts on an empty session");
  P.request("rq-1"); P.response("rq-1", { trace_id: TRACE.open, body: { onboarding: { id: OB } } });
  await settle();
  assert.equal(P.stages().find((s) => s.trace_id === TRACE.open).ops.length, 4);
  const VR = P.d.renderVals();
  assert.equal(VR.flowHasNodes, false, "no lineage graph is drawn for real runs");
  assert.ok(texts(P.d.renderLineageUnavailable()).some((t) => /Lineage is not recorded for real runs/.test(t)));
  assert.equal(VR.views[1].label, "Requests · 4");
  P.send({ egb: "trace", event: events[0] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(P.stages().length, 4, "a simulator event means nothing to Real mode");

  P.d.setMode("sim");
  assert.equal(P.d.isReal(), false);
  assert.equal(P.stages().length, 1, "the simulator's tab is back as it was");
  assert.equal(P.stages()[0].id, simStage[0].id);
  P.d.setMode("real");
  assert.equal(P.stages().length, 4, "and the real session is still there");
  assert.equal(P.d.renderVals().frameSrc, "/engelbart/setup/test/frame?mode=real");
});

test("the frame's word on the session is shown: signed out means the product left for the sign-in page, so the pane says how to come back and how to reload", () => {
  const P = page({ mode: "real" });
  assert.equal(P.d.realVM().signedOut, false);
  P.send({ egb: "session", signedIn: false, email: "" });
  const R = P.d.realVM();
  assert.equal(R.signedOut, true);
  const overlay = texts(P.d.renderSignedOut(R));
  assert.ok(overlay.includes("Sign in to Engelbart to use Real mode") && overlay.includes("Reload the frame"));
  assert.equal(find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Signed out").length, 1, "the notice sits over the frame");
  const key = P.d.state.frameKey;
  R.reloadFrame();
  assert.equal(P.d.state.frameKey, key + 1, "reloading remounts the frame");
  assert.equal(P.d.realVM().signedOut, false, "and waits for its word again");
  P.send({ egb: "session", signedIn: true, email: "member@berkeley.edu" });
  assert.equal(P.d.realVM().signedOut, false);
  assert.equal(find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Signed out").length, 0);
  // Messages from anywhere but the frame are ignored.
  P.send({ egb: "session", signedIn: false }, { source: {} });
  P.send({ egb: "session", signedIn: false }, { origin: "https://evil.example" });
  assert.equal(P.d.realVM().signedOut, false);
});

test("an expired session is said plainly, and nothing is read without a token", async () => {
  const expired = page({ mode: "real", server: telemetryServer({ status: 401 }) });
  await settle();
  assert.match(expired.d.realVM().error, /session has expired.*sign in again/i);
  expired.request("rq-1"); expired.response("rq-1", { trace_id: TRACE.open, body: {} });
  await settle();
  const row = expired.stages()[0];
  assert.equal(row.awaiting, "missing");
  assert.match(row.traceError, /Sign in to Engelbart/);
  assert.ok(expired.server.telemetry().every((c) => c.method === "GET"));

  const out = page({ mode: "real", signedIn: false });
  await settle();
  assert.equal(out.server.telemetry().length, 0, "without a session, the endpoint is not called at all");
  assert.equal(out.d.realVM().error, "");
  assert.equal(out.d.state.real.runs, null);
  out.request("rq-1"); out.response("rq-1", { trace_id: TRACE.open, body: {} });
  await settle();
  assert.equal(out.stages()[0].awaiting, "missing");
  assert.match(out.stages()[0].traceError, /Sign in to Engelbart/);
  assert.equal(out.server.telemetry().length, 0);
});
