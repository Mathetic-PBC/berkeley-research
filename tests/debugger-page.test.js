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
// The fixture is regenerated from the real code, so its ids and timings are read from it, never copied.
const TRACE = {}; FIXTURE.operations.filter((o) => o.type === "workflow").forEach((o) => { TRACE[o.action] = o.trace_id; });
const ROOTS = {}; FIXTURE.operations.filter((o) => o.type === "workflow").forEach((o) => { ROOTS[o.action] = o.operation_id; });
const OPEN_MS = FIXTURE.operations.find((o) => o.name === "onboarding.open").duration_ms;
const MODEL_OP = FIXTURE.operations.find((o) => o.type === "model").operation_id;
const TOKEN = "member-token";

function plain(x) { return JSON.parse(JSON.stringify(x)); }
// Values built in the sandbox have that realm's prototypes: compared as plain data.
function same(actual, expected, message) { assert.deepEqual(plain(actual), plain(expected), message); }
async function settle(rounds = 8) { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); }
// The stand-in React applies queued updates in a microtask; this lets exactly that happen, and nothing that
// waits on a reply or a timer.
const flush = () => Promise.resolve();

// React, as far as the component uses it: a base class with setState/forceUpdate, createElement as a plain tree, refs.
function fakeReact() {
  // Updates queue and apply together in a later microtask, as React 18 batches them: an object patch lands as
  // its caller computed it, from whatever state the caller read; a function patch runs against the state as it
  // is when the queue drains. Callbacks run after the drain. This is what makes a stale read a lost update.
  class Component {
    constructor(props) { this.props = props; this.state = {}; this.queue = []; this.draining = null; }
    setState(patch, after) {
      this.queue.push([patch, after]);
      if (!this.draining) this.draining = Promise.resolve().then(() => { this.draining = null; this.drain(); });
    }
    drain() {
      const q = this.queue; this.queue = []; const afters = [];
      for (const [patch, after] of q) { const p = typeof patch === "function" ? patch(this.state) : patch; if (p) this.state = Object.assign({}, this.state, p); if (after) afters.push(after); }
      afters.forEach((f) => f());
    }
    forceUpdate(after) { if (after) Promise.resolve().then(after); }
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
// An operation as a build before lineage recorded it: the same record without the two attributes.
function preLineage(op) { const attributes = { ...op.attributes }; delete attributes["engelbart.lineage.reads"]; delete attributes["engelbart.lineage.writes"]; return { ...op, attributes }; }

function telemetryServer(options = {}) {
  const calls = [];
  const sub = (filter, onboarding, map = (op) => op) => ({ contract_version: FIXTURE.contract_version, run: FIXTURE.run, onboarding, operations: FIXTURE.operations.filter(filter).map(map),
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
      // The older run was recorded by a build before lineage: its operations carry no reads or writes.
      if (id === "ob-older") return json(200, sub((o) => o.trace_id === TRACE.analysis, row("ob-older", { project_name: "Older project" }), preLineage));
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
    location: { origin: ORIGIN, search: options.search ?? (options.mode === "real" ? "?test=true" : "?mode=sim&test=true"), href: ORIGIN + "/engelbart/setup/test" },
    document: { getElementById: () => ({ innerHTML: "" }), createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {}, style: {} }, addEventListener() {} },
    addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {},
    confirm: () => true, navigator: {},
    fetch: server.fetch,
    supabase: { createClient: () => ({ auth: { getSession: async () => (options.signedIn === false ? { data: { session: null } } : { data: { session: { access_token: TOKEN, user: { email: "member@berkeley.edu" } } } }) } }) },
    React, ReactDOM: { createRoot: () => ({ render(el) { mounted = new el.type(el.props); mounted.componentDidMount(); } }) },
  };
  // The mode is named on the URL, as the frame's is; the page stores nothing about it.
  if (options.mode === "real") sandbox.location.search += (sandbox.location.search ? "&" : "?") + "mode=real";
  // What this browser already held: environments, their saved state, simulated accounts.
  Object.entries(options.seed || {}).forEach(([k, v]) => store.set(k, typeof v === "string" ? v : JSON.stringify(v)));
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

test("the URL decides the mode; Real mode never hands the frame the product's test switch, and hides the simulator's reset; nothing in the page switches modes", async () => {
  const P = page({ mode: "real" });
  assert.equal(P.d.isReal(), true);
  const V = P.d.renderVals();
  assert.equal(V.frameSrc, "/engelbart/setup/test/frame?mode=real", "no env, no participant, and never test=true, although the page itself was opened with it");
  assert.equal(P.d.props.productTestMode, true);
  const bar = texts(P.d.renderTopBar(V));
  assert.ok(!bar.includes("Simulated") && !bar.includes("Real"), "no mode toggle: the mode is the URL's");
  assert.ok(!bar.includes("real actions"), "no warning badge");
  assert.ok(bar.includes("Reset test environment"), "the test debugger offers a real setup reset");
  assert.ok(!bar.some((t) => /Configure this environment/.test(t)), "no environment menu in Real mode");
  assert.equal(find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Real mode notice").length, 0, "no strip under the bar");
  assert.equal(P.d.setMode, undefined, "and no way to switch");
  assert.ok(texts(P.d.render()).includes("Engelbart setup, running against the real backend"), "the frame is on the page in Real mode");
  assert.equal(find(P.d.render(), (n) => n.type === "iframe").length, 1);
  assert.equal(V.isRequestsView, true, "Real mode opens on Requests, where the work shows");
  assert.equal(V.stages.length, 0);
  await settle();
  same((P.server.telemetry()), [{ url: "/api/engelbart-telemetry", method: "GET", auth: "Bearer " + TOKEN }], "on entering, the run list is read for the picker, with the member's token");
  assert.equal(P.d.realVM().email, "member@berkeley.edu");

  const S = page({});
  assert.equal(S.d.isReal(), false);
  assert.equal(S.d.renderVals().isDashboard, true, "Simulated mode lands on the environments dashboard");
  S.d.createEnv("Lab"); await settle();
  const VS = S.d.renderVals();
  assert.match(VS.frameSrc, /^\/engelbart\/setup\/test\/frame\?mode=sim&env=env-[a-z0-9]+&test=true$/, "Simulated mode still passes the test switch through");
  const sbar = texts(S.d.renderTopBar(VS));
  assert.ok(sbar.includes("Reset test environment") && !sbar.includes("real actions") && !sbar.includes("Real"));
  assert.equal(S.server.telemetry().length, 0, "the simulator never reads telemetry");
  assert.equal(S.store.has("egb.debugger.mode"), false, "nothing about the mode is stored");
});

test("Simulated mode lands on the environments dashboard: no frame and no simulated backend until one is opened; New environment creates one and opens it", async () => {
  const P = page({});
  let V = P.d.renderVals();
  assert.equal(V.isDashboard, true);
  assert.equal(V.envsEmpty, true);
  assert.equal(P.store.has("egb.debugger.envs.v1"), false, "no environment is invented on load");
  assert.equal(V.frameSrc, "", "no frame source without an environment");
  let tree = P.d.render();
  assert.equal(find(tree, (n) => n.type === "iframe").length, 0, "no product frame is mounted");
  assert.equal(find(tree, (n) => n.props && n.props["data-screen-label"] === "Product").length, 0);
  assert.equal(find(tree, (n) => n.props && n.props["data-screen-label"] === "Execution graph").length, 0);
  const dash = find(tree, (n) => n.props && n.props["data-screen-label"] === "Environments");
  assert.equal(dash.length, 1);
  const copy = texts(dash[0]);
  assert.ok(copy.includes("Test environments"));
  assert.ok(copy.includes("Each environment is isolated: its own simulated account, step tabs, notes and graph layout. Open one to pick up where you left off, or start a new one with its own participant and prompts."));
  assert.ok(copy.includes("New environment"));
  assert.ok(copy.includes("No environments yet. Create one to open the product against a fresh simulated account."), "the empty state");
  const bar = texts(P.d.renderTopBar(V));
  same(bar.filter(Boolean), ["Engelbart", "Simulated · fixed sample results"], "the backend mode is visible");
  assert.ok(!bar.includes("Reset test environment") && !bar.includes("switch environment"), "no environment controls on the dashboard");
  // New environment: the popup in "new" mode; Create makes the environment and opens it.
  V.newEnv(); await flush();
  V = P.d.renderVals();
  same([V.cfg.open, V.cfg.title, V.cfg.saveLabel, P.d.state.config.envId], [true, "New environment", "Create environment", null]);
  V.cfg.setName({ target: { value: "Physics major" } }); await flush();
  P.d.renderVals().cfg.save(); await settle();
  V = P.d.renderVals();
  assert.equal(V.cfg.open, false);
  assert.equal(V.isDashboard, false, "the new environment is open");
  let envs = JSON.parse(P.store.get("egb.debugger.envs.v1"));
  assert.equal(envs.length, 1);
  assert.equal(envs[0].name, "Physics major");
  assert.equal(P.d.state.envId, envs[0].id);
  assert.equal(V.frameSrc, "/engelbart/setup/test/frame?mode=sim&env=" + envs[0].id + "&test=true", "the frame runs against this environment's simulated account");
  tree = P.d.render();
  assert.equal(find(tree, (n) => n.type === "iframe").length, 1);
  assert.equal(find(tree, (n) => n.props && n.props["data-screen-label"] === "Environments").length, 0);
  const inBar = texts(P.d.renderTopBar(V));
  assert.ok(inBar.includes("Reset test environment") && inBar.includes("switch environment"), "inside an environment the bar has its controls");
  same(V.envOptions.map((o) => o.label), ["Physics major", "All environments…", "Configure this environment…", "New environment…", "Delete this environment…"]);
  assert.equal(V.envId, envs[0].id);
  // New environment… from the dropdown, left unnamed: Environment {n}, opened; the first was saved on the way out.
  V.envSelect({ target: { value: "__new" } }); await flush();
  P.d.renderVals().cfg.save(); await settle();
  envs = JSON.parse(P.store.get("egb.debugger.envs.v1"));
  same(envs.map((e) => e.name), ["Environment 2", "Physics major"], "prepended");
  assert.equal(P.d.state.envId, envs[0].id);
  assert.ok(P.store.has("egb.debugger.env." + envs[1].id), "the environment that was open was saved");
  assert.equal(P.server.telemetry().length, 0, "the simulator never reads telemetry");
});

test("the dashboard's cards: most recently opened first, saying when, how the participant starts and what was recorded; the card opens, Configure edits and Reset clears without opening, × deletes", async () => {
  const opened = Date.now() - 60_000, older = new Date(2025, 2, 4, 15, 9, 0).getTime();
  const fresh = { id: "env-a", name: "Fresh", createdAt: opened - 60_000, lastUsedAt: opened, stats: { steps: 0, requests: 0, model: 0, cost: 0, ms: 0 }, config: { description: "", notes: "", prompts: {}, participant: { enabled: false } } };
  const prefilled = { id: "env-b", name: "Ada, third year", createdAt: older, lastUsedAt: 0, stats: { steps: 3, requests: 12, model: 4, cost: 0.0042, ms: 1900 },
    config: { description: "Skips the profile steps.", notes: "", prompts: { analyzePrompt: "custom", gradePrompt: "custom" }, participant: { enabled: true, name: "Ada", year: "Third year", major: "", depth: "some", paperFamiliarity: 2, projectUrl: "", repoUrl: "", paper: null } } };
  const P = page({ seed: { "egb.debugger.envs.v1": [prefilled, fresh], "egb.debugger.env.env-b": { recordings: [], notes: { start: "kept" } }, "egb.sim.db.env-b": { accounts: 1 } } });
  let V = P.d.renderVals();
  same([V.isDashboard, V.envsEmpty], [true, false]);
  same(V.envCards.map((c) => c.name), ["Fresh", "Ada, third year"], "most recently opened first, then by creation");
  const [a, b] = V.envCards;
  assert.match(a.meta, /^Last opened \d{1,2}:\d\d:\d\d [AP]M$/, "opened today: the time, with seconds");
  assert.equal(a.meta, "Last opened " + P.d.clock(opened));
  assert.equal(a.participant, "Fresh participant · opens at the Start step");
  assert.equal(a.hasDescription, false);
  same(a.stats, [{ k: "steps", v: "0" }, { k: "requests", v: "0" }, { k: "model calls", v: "0" }, { k: "est. cost", v: "$0" }, { k: "server time", v: "0 ms" }]);
  assert.ok(b.meta.startsWith("Created ") && b.meta.endsWith(", 3:09 PM · 2 prompts edited"), "never opened: the creation date, without seconds: " + b.meta);
  assert.equal(b.participant, "Ada · Third year · opens at the Paper step", "empty parts are skipped");
  same([b.hasDescription, b.description], [true, "Skips the profile steps."]);
  same(b.stats.map((s) => s.v), ["3", "12", "4", "$0.0042", "1.9 s"]);
  same(P.d.envCard({ id: "x", name: "x", createdAt: older, stats: { cost: 0.123, ms: 128 }, config: { prompts: { askPrompt: "y" } } }).stats.map((s) => s.v), ["0", "0", "0", "$0.123", "128 ms"]);
  assert.ok(P.d.envCard({ id: "x", name: "x", createdAt: older, config: { prompts: { askPrompt: "y" } } }).meta.endsWith(" · 1 prompt edited"));
  const copy = texts(find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Environments")[0]);
  ["Fresh", "Ada, third year", "Skips the profile steps.", "Open ›", "Configure", "Reset", "×", "Delete this environment"].forEach((t) => assert.ok(copy.includes(t), t));
  assert.ok(!copy.includes("No environments yet. Create one to open the product against a fresh simulated account."));
  // Configure on a card edits that environment, open or not; the click does not open the card.
  let stopped = 0; const ev = { stopPropagation() { stopped += 1; } };
  b.configure(ev); await flush();
  assert.equal(stopped, 1);
  V = P.d.renderVals();
  same([V.cfg.open, V.cfg.title, V.cfg.name, V.isDashboard, P.d.state.config.envId], [true, "Configure environment", "Ada, third year", true, "env-b"]);
  V.cfg.setName({ target: { value: "Ada, third year, no links" } }); await flush();
  P.d.renderVals().cfg.save(); await flush();
  V = P.d.renderVals();
  same([V.cfg.open, V.isDashboard], [false, true], "saved, still on the dashboard");
  assert.equal(JSON.parse(P.store.get("egb.debugger.envs.v1")).find((e) => e.id === "env-b").name, "Ada, third year, no links");
  assert.equal(V.envCards[1].name, "Ada, third year, no links");
  same(P.cmds(), [], "no prompts were pushed: no product is running");
  // Reset on a card asks first, in the environment's name; it drops the simulated account and the step tabs and
  // keeps the name, participant, prompts and notes. Nothing runs, so nothing reloads.
  const asked = []; P.w.confirm = (msg) => { asked.push(msg); return false; };
  V.envCards[1].reset(ev); await flush();
  assert.equal(stopped, 2);
  same(asked, ["Reset “Ada, third year, no links”? Its simulated account's setup is dropped and every step tab is cleared; its name, participant, prompts and notes stay."]);
  assert.ok(P.store.has("egb.sim.db.env-b"), "declined: the account stays");
  P.w.confirm = () => true;
  P.d.renderVals().envCards[1].reset(ev); await flush();
  assert.equal(P.store.has("egb.sim.db.env-b"), false, "the simulated account is gone; the frame makes a fresh one when the environment opens");
  const kept = JSON.parse(P.store.get("egb.debugger.env.env-b"));
  same([kept.recordings.map((r) => r.id), kept.notes, kept.flowPos], [["start"], { start: "kept" }, {}]);
  const rb = P.d.renderVals().envCards[1];
  same([rb.name, rb.stats.map((s) => s.v)], ["Ada, third year, no links", ["0", "0", "0", "$0", "0 ms"]]);
  assert.equal(JSON.parse(P.store.get("egb.debugger.envs.v1")).find((e) => e.id === "env-b").config.prompts.analyzePrompt, "custom", "prompts stay");
  same([P.cmds(), P.d.renderVals().isDashboard, P.d.state.envId], [[], true, null]);
  // × asks first too; declining keeps everything.
  asked.length = 0; P.w.confirm = (msg) => { asked.push(msg); return false; };
  V.envCards[1].remove(ev); await flush();
  same(asked, ["Delete “Ada, third year, no links”? Its simulated account, steps and notes are removed."]);
  assert.equal(P.d.renderVals().envCards.length, 2);
  P.w.confirm = () => true;
  P.d.renderVals().envCards[1].remove(ev); await flush();
  same(JSON.parse(P.store.get("egb.debugger.envs.v1")).map((e) => e.id), ["env-a"]);
  assert.equal(P.store.has("egb.debugger.env.env-b"), false, "its saved state is gone");
  assert.equal(P.store.has("egb.sim.db.env-b"), false, "and its simulated account");
  assert.equal(P.d.renderVals().isDashboard, true);
  // The card opens its environment; All environments… saves it and comes back.
  P.d.renderVals().envCards[0].open(); await flush();
  V = P.d.renderVals();
  same([V.isDashboard, P.d.state.envId], [false, "env-a"]);
  assert.equal(V.frameSrc, "/engelbart/setup/test/frame?mode=sim&env=env-a&test=true");
  assert.ok(JSON.parse(P.store.get("egb.debugger.envs.v1"))[0].lastUsedAt > opened, "opening is what Last opened means");
  V.envSelect({ target: { value: "__all" } }); await flush();
  V = P.d.renderVals();
  same([V.isDashboard, P.d.state.envId], [true, null]);
  assert.ok(P.store.has("egb.debugger.env.env-a"), "saved on the way out");
  assert.equal(find(P.d.render(), (n) => n.type === "iframe").length, 0);
  // Delete this environment… on the open one returns to the dashboard, and invents nothing in its place.
  P.d.renderVals().envCards[0].open(); await flush();
  P.d.renderVals().envSelect({ target: { value: "__delete" } }); await flush();
  V = P.d.renderVals();
  same([V.isDashboard, V.envsEmpty, P.d.state.envId], [true, true, null]);
  assert.equal(P.store.get("egb.debugger.envs.v1"), "[]");
  assert.equal(P.store.has("egb.debugger.env.env-a"), false);
  // Configure this environment… on the open one pushes its prompts to the running product at once.
  P.d.createEnv("Lab"); await settle();
  P.d.renderVals().envSelect({ target: { value: "__configure" } }); await flush();
  assert.equal(P.d.state.config.envId, P.d.state.envId);
  P.d.renderVals().cfg.save(); await flush();
  same(P.cmds(), ["prompts"]);
});

test("leaving an environment keeps what the frame had just reported: pending events are drawn and saved before the dashboard comes back", async () => {
  const P = page({});
  P.d.createEnv("Lab"); await settle();
  const id = P.d.state.envId;
  P.send({ egb: "ready", speed: 1, mode: "sim" }); await flush();
  const events = [];
  const sim = P.w.EngelbartSim.create({ emit: (ev) => events.push(plain(ev)), speed: 0 });
  await sim.handle("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "open" }) });
  events.forEach((ev) => P.send({ egb: "trace", event: ev }));
  P.d.closeEnv(); await flush();
  assert.equal(P.d.renderVals().isDashboard, true);
  const saved = JSON.parse(P.store.get("egb.debugger.env." + id));
  assert.equal(saved.recordings[0].stages.length, 1, "the request the frame had just reported was saved, not lost to the flush timer");
  const card = P.d.renderVals().envCards[0];
  assert.equal(card.stats.find((s) => s.k === "requests").v, "1", "and the card counts it");
  card.open(); await flush();
  assert.equal(P.stages().length, 1, "reopening restores it");
  assert.equal(P.stages()[0].path, "/api/engelbart-onboarding");
});

test("a request the frame reports is a row at once; when the reply names a trace, the trace is read and the row becomes the recorded action with its operations", async () => {
  const P = page({ mode: "real" });
  P.send({ egb: "ready", speed: 1, mode: "real" });
  await flush();
  assert.equal(P.d.state.connected, true);
  same(P.cmds(), [], "nothing is commanded of the real frame on ready: no speed, no snapshot, no prompts");
  P.request("rq-1");
  await flush();
  let rows = P.stages();
  assert.equal(rows.length, 1);
  same([rows[0].id, rows[0].label, rows[0].status, rows[0].observed, rows[0].untraced, rows[0].ops.length], ["req:rq-1", "onboarding · open", "running", true, true, 0]);
  assert.equal(P.d.renderVals().stages[0].dot, "#0070f3", "a running request is blue");
  // The reader opens the row and inspects it while it is still in flight.
  P.d.setState({ open: { "req:rq-1": true } }); P.d.select("live", "req:rq-1", null);
  await flush();
  P.response("rq-1", { trace_id: TRACE.open, body: { onboarding: { id: OB, status: "open", step: 1 }, credit: { status: "own" }, own_key: { set: true, last4: "1234" } } });
  await flush();
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
  assert.ok(insp.meta.some((m) => m.k === "round trip" && m.v === "120 ms") && insp.meta.some((m) => m.k === "server time" && m.v === P.d.fmtMs(OPEN_MS)), "browser and server timings side by side");
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
  await flush();
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
  P.d.setState({ inspTab: "raw" }); await flush(); insp = P.d.inspectorVM(); body = JSON.parse(insp.json);
  assert.equal(body.stop_reason, "end_turn", "the raw reply is the model's own message");
  P.d.setState({ inspTab: "output" }); await flush(); insp = P.d.inspectorVM(); body = JSON.parse(insp.json);
  assert.equal(typeof body, "object");
  P.d.setState({ inspTab: "attrs" }); await flush(); insp = P.d.inspectorVM(); body = JSON.parse(insp.json);
  assert.equal(body["gen_ai.usage.output_tokens"], 1276);
  assert.ok(!("authorization" in body) && !JSON.stringify(body).match(/sk-[A-Za-z0-9]{8}/), "no credential in the attributes");
  const persist = row.ops.find((o) => o.name === "analysis.persist");
  P.d.select("live", ROOTS.analysis, persist.id); P.d.setState({ inspTab: "input" });
  await flush();
  insp = P.d.inspectorVM();
  assert.equal(insp.kindLabel, "DB");
  assert.equal(insp.target, "PATCH /rest/v1/engelbart_onboardings?id=eq.?");
  assert.ok(JSON.parse(insp.json), "the database request snapshot is shown");
  const dl = row.ops.find((o) => o.name === "paper.download");
  P.d.select("live", ROOTS.analysis, dl.id);
  await flush();
  insp = P.d.inspectorVM();
  assert.equal(insp.kindLabel, "Storage");
  assert.equal(insp.tabs[0].label, "Attributes", "a storage read recorded no snapshot, so none is invented");
});

test("in Real mode the Data flow view draws what the run recorded reading and writing, and a value's panel shows its producer's recorded payloads by their snapshots", async () => {
  const P = page({ mode: "real" });
  P.request("rq-1", { action: "analysis", body: { action: "analysis", run: true }, bg: true });
  P.response("rq-1", { trace_id: TRACE.analysis, body: { onboarding: { id: OB }, analysis: { status: "running" } } });
  await settle();
  let V = P.d.renderVals();
  assert.equal(V.lineageUnavailable, false);
  const ids = V.flowNodes.map((n) => n.id);
  for (const id of ["session", "calibrations", "turns", "paper", "links", "profile", "analysis"]) assert.ok(ids.includes(id), `${id} was read or written, so it is drawn`);
  for (const id of ["assets", "direction", "todos", "payload"]) assert.ok(!ids.includes(id), `${id} was not touched, so it is not`);
  assert.ok(V.flowEdges.length > 0, "an arrow from what was read to what was written");
  const analysisNode = V.flowNodes.find((n) => n.id === "analysis");
  assert.equal(analysisNode.wroteHere, true, "the reading was written on this step");
  assert.match(analysisNode.title, /written on this step/);
  assert.match(V.flowNodes.find((n) => n.id === "paper").title, /written on this step · read on this step/, "the run's earlier sources action stored the paper, and the analysis read it");
  // The value's panel: its producer is the recorded model call, and its tabs are the snapshots that call kept.
  P.d.setState({ flowSel: "analysis", flowTab: null });
  await flush();
  V = P.d.renderVals();
  let d = V.flowDetail;
  assert.equal(d.label, "Paper reading");
  same(d.tabs.map((t) => t.label), ["Prompt", "Model output", "Raw reply", "Request", "Response"], "the three recorded snapshots, then what the browser saw of the request");
  assert.match(d.status, /^Last written on .* by “analysis\.persist” · 3 writes so far$/, "the last writer stored it; the model call, its normalize step and the persist all wrote it");
  const parsed = FIXTURE.snapshots.find((x) => x.kind === "model_parsed_response");
  assert.ok(d.hasValue && d.json.includes(JSON.stringify(Object.keys(parsed.content)[0])), "Model output is the recorded parsed reply, inline");
  assert.equal(d.tabNote, "redacted before it was stored", "the snapshot says how it was kept");
  d.tabs[0].select();
  await flush();
  d = P.d.renderVals().flowDetail;
  assert.ok(d.json.includes('"max_tokens"'), "Prompt is the recorded model request");
  assert.doesNotMatch(d.json, /sk-[A-Za-z0-9]/, "with no key in it");
  // A value the run only read has no producer to show, and nothing is invented for it.
  P.d.setState({ flowSel: "session", flowTab: null });
  await flush();
  d = P.d.renderVals().flowDetail;
  assert.equal(d.label, "Session");
  same(d.tabs.map((t) => t.label), ["Value"]);
  assert.equal(d.hasValue, false);
  assert.equal(d.status, "");
  // A value a row write stored: its producer is the database operation, whose payloads are its request and response.
  P.request("rq-2", { action: "step", body: { action: "step", step: 1, fields: { name: "A" } } });
  P.response("rq-2", { trace_id: TRACE.step, body: { onboarding: { id: OB } } });
  await settle();
  P.d.setState({ flowSel: "profile", flowTab: null });
  await flush();
  d = P.d.renderVals().flowDetail;
  assert.equal(d.label, "Reader profile");
  same(d.tabs.map((t) => t.label), ["Input", "Output", "Request", "Response"]);
  assert.match(d.status, /by “db\.patch”/);
  assert.ok(d.json.includes('"name"'), "Output is the recorded database response, with the columns the write set");
  assert.equal(P.server.telemetry().filter((c) => c.url.includes("snapshot=")).length, 0, "inline snapshots were never asked for again");
});

test("a snapshot the run left out is asked for once when its tab opens, and never twice", async () => {
  const server = telemetryServer({ inline: false });
  const P = page({ mode: "real", server });
  P.request("rq-1", { action: "analysis" }); P.response("rq-1", { trace_id: TRACE.analysis, body: { onboarding: { id: OB } } });
  await settle();
  P.d.select("live", ROOTS.analysis, MODEL_OP);
  await flush();
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
  await flush();
  const insp = P.d.inspectorVM();
  same(JSON.parse(insp.json), { analysis: { status: "done" } }, "the latest poll's reply");
  assert.ok(insp.meta.some((m) => m.k === "trace" && m.v === "none: untraced request") && insp.meta.some((m) => m.k === "polls" && m.v === "3") && insp.meta.some((m) => m.k === "step" && m.v === "Paper"));
  P.d.select("live", rows[2].id, null);
  await flush();
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
  await flush();
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
  await flush();
  assert.equal(P.d.realVM().viewingPicked, true);
  await settle();
  assert.equal(P.d.state.real.loading, false);
  assert.equal(P.d.state.recordings[0].name, "Older project");
  same((P.stages().map((s) => [s.label, !!s.observed])), [["onboarding · analysis (run)", false]], "the picked run's own actions, none of them this session's");
  const V = P.d.renderVals();
  assert.equal(texts(P.d.renderLive(V)).some((t) => /^Earlier run · Older project/.test(t)), true);
  assert.equal(V.stages[0].modelPill, "model");
  assert.ok(P.server.telemetry().some((c) => c.url === "/api/engelbart-telemetry?run=ob-older"));
  // Recorded before the server kept lineage: its operations are all there, and the graph guesses nothing.
  assert.ok(P.stages()[0].ops.every((o) => Array.isArray(o.reads) && o.reads.length === 0 && Array.isArray(o.writes) && o.writes.length === 0));
  assert.equal(V.lineageUnavailable, true);
  assert.equal(V.flowHasNodes, false, "no edge is drawn for a run recorded without lineage");
  assert.ok(texts(P.d.renderLineageUnavailable()).some((t) => /Lineage was not recorded for this run/.test(t)));
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

test("each mode keeps its own state and the URL says which one runs: a Real session leaves the simulator's environment alone, and a stored choice from an earlier build moves nothing", async () => {
  const P = page({ seed: { "egb.debugger.mode": "real" } });
  assert.equal(P.d.isReal(), false, "the stored choice is ignored: the explicit simulator URL selects fixtures");
  assert.equal(P.d.renderVals().isDashboard, true);
  P.d.createEnv("Lab"); await settle();
  P.send({ egb: "ready", speed: 1, mode: "sim" });
  await flush();
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
  P.d.closeEnv(); await flush();
  const envId = JSON.parse(P.store.get("egb.debugger.envs.v1"))[0].id;
  const saved = P.store.get("egb.debugger.env." + envId);
  assert.equal(P.store.get("egb.debugger.mode"), "real", "the stale key is neither read nor rewritten");

  // The same browser at ?mode=real: an empty session, nothing of the environment touched.
  const R = page({ mode: "real", seed: Object.fromEntries(P.store) });
  assert.equal(R.d.isReal(), true);
  assert.equal(R.stages().length, 0, "Real mode starts on an empty session");
  R.request("rq-1"); R.response("rq-1", { trace_id: TRACE.open, body: { onboarding: { id: OB } } });
  await settle();
  assert.equal(R.stages().find((s) => s.trace_id === TRACE.open).ops.length, 4);
  const VR = R.d.renderVals();
  assert.equal(VR.lineageUnavailable, false, "the recorded run names what it read and wrote");
  assert.equal(VR.flowHasNodes, true, "so the graph draws a real run from its recorded reads and writes, with nothing guessed");
  assert.equal(VR.views[1].label, "Requests · 4");
  assert.equal(VR.frameSrc, "/engelbart/setup/test/frame?mode=real");
  R.send({ egb: "trace", event: events[0] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(R.stages().length, 4, "a simulator event means nothing to Real mode");
  assert.equal(R.store.get("egb.debugger.env." + envId), saved, "the environment's saved state is as the simulator left it");

  // And at the simulator URL again: the environment opens with its tab as it was.
  const S = page({ seed: Object.fromEntries(R.store) });
  assert.equal(S.d.isReal(), false);
  S.d.openEnv(envId); await flush();
  assert.equal(S.stages().length, 1, "the simulator's tab is back as it was");
  assert.equal(S.stages()[0].id, simStage[0].id);
});

test("the frame's word on the session is shown: signed out means the product left for the sign-in page, so the pane says how to come back and how to reload", async () => {
  const P = page({ mode: "real" });
  assert.equal(P.d.realVM().signedOut, false);
  P.send({ egb: "session", signedIn: false, email: "" });
  await flush();
  const R = P.d.realVM();
  assert.equal(R.signedOut, true);
  const overlay = texts(P.d.renderSignedOut(R));
  assert.ok(overlay.includes("Sign in to Engelbart to use Real mode") && overlay.includes("Reload the frame"));
  assert.equal(find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Signed out").length, 1, "the notice sits over the frame");
  const key = P.d.state.frameKey;
  R.reloadFrame();
  await flush();
  assert.equal(P.d.state.frameKey, key + 1, "reloading remounts the frame");
  assert.equal(P.d.realVM().signedOut, false, "and waits for its word again");
  P.send({ egb: "session", signedIn: true, email: "member@berkeley.edu" });
  await flush();
  assert.equal(P.d.realVM().signedOut, false);
  assert.equal(find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Signed out").length, 0);
  // Messages from anywhere but the frame are ignored.
  P.send({ egb: "session", signedIn: false }, { source: {} });
  P.send({ egb: "session", signedIn: false }, { origin: "https://evil.example" });
  await flush();
  assert.equal(P.d.realVM().signedOut, false);
});

test("requests and replies that land in one turn all survive: nothing a later message says loses what an earlier one said", async () => {
  // The product fires three requests from one click (the step, then analysis and assets in the background) and
  // the storage upload's reply can land in the same turn as the next request. React applies the updates from one
  // turn together, so each must build on the state as it stands then, not on what its handler read.
  const P = page({ mode: "real" });
  P.request("rq-1", { action: "step", body: { action: "step", sources: [] }, step: "Paper" });
  P.request("rq-2", { action: "analysis", body: { action: "analysis", run: true }, bg: true, step: "Paper" });
  P.request("rq-3", { action: "assets", body: { action: "assets", run: true }, bg: true, step: "Paper" });
  P.request("rq-4", { method: "PUT", path: "/storage/v1/object/berkeley-papers/papers/p.pdf", where: "storage", action: "upload", body: { bytes: 2059, type: "application/pdf" } });
  P.response("rq-4", { status: 200, ms: 310, body: { ok: true, status: 200 } });
  P.request("rq-5", { action: "own_paper_saved", body: { action: "own_paper_saved", id: "p" }, step: "Paper" });
  await flush();
  let rows = P.stages();
  same((rows.map((s) => [s.label, s.status])), [["onboarding · step", "running"], ["onboarding · analysis (run)", "running"], ["onboarding · assets (run)", "running"], ["storage · upload", "ok"], ["onboarding · own_paper_saved", "running"]], "every request is a row, and the upload has its reply");
  same([rows[3].ms, rows[3].code], [310, 200], "the upload's reply landed in the same turn as the next request and was not lost");
  // Replies to the three arrive together too; two of them name traces.
  P.response("rq-1", { trace_id: TRACE.step, body: { onboarding: { id: OB } } });
  P.response("rq-2", { trace_id: TRACE.analysis, body: { onboarding: { id: OB }, analysis: { status: "running" } } });
  P.response("rq-3", { ms: 90, body: { onboarding: { id: OB }, assets: { status: "running" } } });
  P.response("rq-5", { ms: 40, body: { onboarding: { id: OB } } });
  await settle();
  rows = P.stages().filter((s) => s.observed);
  same((rows.map((s) => [s.label, s.status, s.ops.length])), [["onboarding · step", "ok", 4], ["onboarding · analysis (run)", "ok", 13], ["onboarding · assets (run)", "ok", 0], ["storage · upload", "ok", 0], ["onboarding · own_paper_saved", "ok", 0]], "both traces were read and joined; the untraced replies kept theirs");
  const reads = P.server.telemetry().map((c) => c.url);
  assert.ok(reads.includes("/api/engelbart-telemetry?trace=" + TRACE.step) && reads.includes("/api/engelbart-telemetry?trace=" + TRACE.analysis));
  assert.equal(reads.filter((u) => u === "/api/engelbart-telemetry?run=" + OB).length, 1, "the onboarding's history was read once, although four replies named it in one turn");
  assert.equal(P.d.state.real.onboardingId, OB);
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

// --- prompts: edited on tabs, chosen for a real run, and reviewed call by call --------------------------------

test("the configure popup edits one prompt at a time, on a tab per prompt that marks the edited ones", async () => {
  const P = page({});
  P.d.openConfig("new"); await flush();
  let V = P.d.renderVals();
  assert.equal(V.cfg.promptTabs.length, 11);
  same(V.cfg.promptTabs.map((t) => t.label), P.w.EGB_PROMPTS.ORDER.map((k) => P.w.EGB_PROMPTS.LABELS[k]), "every editable prompt, in the order the reader meets them");
  same([V.cfg.promptTabs[0].on, V.cfg.prompt.key, V.cfg.prompt.changed, V.cfg.editedCount], [true, "analyzePrompt", false, 0], "the first prompt is open to begin with");
  V.cfg.sections[2].select(); await flush();
  V = P.d.renderVals();
  const dialog = find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Configure environment")[0];
  assert.equal(find(dialog, (n) => n.type === "textarea").length, 1, "one editor on screen, not eleven");
  assert.equal(find(dialog, (n) => n.props && n.props["data-prompt-tabs"]).length, 1);
  assert.ok(texts(dialog).includes("Read the paper") && texts(dialog).includes("Grade an answer"));
  V.cfg.promptTabs.find((t) => t.key === "gradePrompt").select(); await flush();
  V = P.d.renderVals();
  same([V.cfg.prompt.key, V.cfg.prompt.label, V.cfg.prompt.value === P.w.EGB_PROMPTS.TEMPLATES.gradePrompt], ["gradePrompt", "Grade an answer", true]);
  V.cfg.prompt.set({ target: { value: "Grade {{answer}} kindly." } }); await flush();
  V = P.d.renderVals();
  same([V.cfg.prompt.changed, V.cfg.prompt.badge, V.cfg.prompt.resetLabel, V.cfg.editedCount], [true, "edited", "reset to default", 1]);
  same(V.cfg.promptTabs.filter((t) => t.changed).map((t) => t.key), ["gradePrompt"], "the tab says which prompt is edited");
  V.cfg.promptTabs[0].select(); await flush();
  V = P.d.renderVals();
  same([V.cfg.prompt.key, V.cfg.promptTabs.find((t) => t.key === "gradePrompt").changed], ["analyzePrompt", true], "switching tabs keeps the edit");
  V.cfg.setName({ target: { value: "Kind grader" } }); await flush();
  P.d.renderVals().cfg.save(); await settle();
  same(JSON.parse(P.store.get("egb.debugger.envs.v1"))[0].config.prompts, { gradePrompt: "Grade {{answer}} kindly." }, "saved as the one override");
  P.d.openConfig("edit"); await flush();
  V = P.d.renderVals();
  V.cfg.promptTabs.find((t) => t.key === "gradePrompt").select(); await flush();
  P.d.renderVals().cfg.prompt.reset(); await flush();
  same([P.d.renderVals().cfg.prompt.changed, P.d.renderVals().cfg.editedCount], [false, 0], "reset to default drops the override");
});

test("in Real mode an environment's edited prompts can be chosen for the run: the frame is told on ready and on every change, and the choice is remembered", async () => {
  const envs = [{ id: "env-x", name: "Kind grader", createdAt: 1, config: { prompts: { gradePrompt: "Grade {{answer}} kindly.", askPrompt: "Answer briefly." } } }, { id: "env-y", name: "Plain", createdAt: 2, config: { prompts: {} } }];
  const P = page({ mode: "real", seed: { "egb.debugger.envs.v1": envs } });
  P.send({ egb: "ready", speed: 1, mode: "real" }); await flush();
  same(P.cmds(), [], "the server's own prompts to begin with: nothing to tell the frame");
  let R = P.d.realVM();
  same(R.promptOptions, [{ value: "", label: "Server prompts" }, { value: "env-x", label: "Kind grader · 2 edited" }, { value: "env-y", label: "Plain · no edits" }]);
  same([R.promptValue, R.promptsApplied], ["", ""]);
  const bar = P.d.renderTopBar(P.d.renderVals());
  assert.equal(find(bar, (n) => n.props && n.props["data-prompt-picker"]).length, 1, "the picker sits in the bar");
  assert.ok(texts(bar).includes("Server prompts") && texts(bar).includes("Kind grader · 2 edited"));
  R.pickPrompts({ target: { value: "env-x" } }); await flush();
  same(P.cmds(), ["prompts"]);
  same(P.toFrame[0].m.value, envs[0].config.prompts, "the environment's overrides go to the frame, which adds them to the model actions");
  assert.equal(P.store.get("egb.debugger.realPrompts"), "env-x", "remembered");
  R = P.d.realVM();
  same([R.promptValue, R.promptsApplied], ["env-x", "2 edited prompts"]);
  assert.match(R.promptsTitle, /Kind grader/);
  // The same browser, opened again: the choice holds and the frame is told as soon as it is ready.
  const Q = page({ mode: "real", seed: Object.fromEntries(P.store) });
  assert.equal(Q.d.realVM().promptValue, "env-x");
  Q.send({ egb: "ready", speed: 1, mode: "real" }); await flush();
  same(Q.cmds(), ["prompts"]);
  same(Q.toFrame[0].m.value, envs[0].config.prompts);
  // An environment with no edits, or the server's own: the frame is told to use the server's prompts.
  Q.d.realVM().pickPrompts({ target: { value: "env-y" } }); await flush();
  same(Q.toFrame[1].m, { egb: "cmd", cmd: "prompts", value: {} });
  same([Q.d.realVM().promptValue, Q.d.realVM().promptsApplied], ["env-y", ""]);
  Q.d.realVM().pickPrompts({ target: { value: "" } }); await flush();
  same(Q.toFrame[2].m.value, {});
  assert.equal(Q.store.has("egb.debugger.realPrompts"), false);
  // A chosen environment that no longer exists means the server's prompts.
  const Z = page({ mode: "real", seed: { "egb.debugger.realPrompts": "env-gone", "egb.debugger.envs.v1": envs } });
  Z.send({ egb: "ready", speed: 1, mode: "real" }); await flush();
  same([Z.d.realVM().promptValue, Z.cmds()], ["", []]);
});

test("the Prompts view groups the simulator's model calls by the prompt they sent, shows each call's message and reply, and opens the call in the session", async () => {
  const P = page({});
  P.d.createEnv("Lab"); await settle();
  P.send({ egb: "ready", speed: 1, mode: "sim" }); await flush();
  let V = P.d.renderVals();
  same([V.views[2].label, V.promptsEmpty, V.promptTabs.length], ["Prompts", true, 0]);
  assert.match(V.promptsEmptyText, /No model calls on this step yet/);
  // The events a simulated answer emits: a request, a grading call with an edited prompt, a follow-up, done.
  const at = 1_700_000_000_000;
  const req = (text, key, edited, out) => ({ template: key, template_edited: edited || undefined, body: { model: "claude-haiku-4-5", max_tokens: 300, messages: [{ role: "user", content: [{ type: "text", text }] }] }, timeout_ms: 90000, out });
  const events = [
    { type: "stage", id: "st-1", seq: 1, at, path: "/api/engelbart-onboarding", method: "POST", surface: "onboarding", action: "answer", label: "onboarding · answer" },
    { type: "op", id: "op-1", stage: "st-1", seq: 2, at: at + 5, kind: "db", name: "row.load", target: "GET /rest/v1/x", status: "ok", input: {}, output: {}, ms: 3, meta: {} },
    { type: "op", id: "op-2", stage: "st-1", seq: 3, at: at + 10, kind: "model", name: "grade the answer", target: "haiku", status: "ok", input: req("Grade this answer kindly.", "gradePrompt", true), output: { level: 50, rationale: "fair" }, ms: 120, meta: { family: "haiku", model: "claude-haiku-4-5", tokens: { input: 210, output: 12 }, cost: 0.0004 } },
    { type: "op", id: "op-3", stage: "st-1", seq: 4, at: at + 140, kind: "model", name: "write one follow-up", target: "sonnet", status: "ok", input: req("Write a follow-up.", "followUpPrompt"), output: { question: "And then?" }, ms: 400, meta: { family: "sonnet", model: "claude-sonnet-4-5", tokens: { input: 900, output: 40 }, cost: 0.004 } },
    { type: "op", id: "op-4", stage: "st-1", seq: 5, at: at + 560, kind: "model", name: "grade the answer", target: "haiku", status: "ok", input: req("Grade the second answer kindly.", "gradePrompt", true), output: { level: 75, rationale: "good" }, ms: 110, meta: { family: "haiku", model: "claude-haiku-4-5", tokens: { input: 220, output: 12 }, cost: 0.0004 } },
    { type: "stage.end", id: "st-1", at: at + 700, status: "ok", code: 200, ms: 700, response: { ok: true } },
  ];
  events.forEach((ev) => P.send({ egb: "trace", event: ev }));
  await new Promise((r) => setTimeout(r, 80));
  V = P.d.renderVals();
  assert.equal(V.views[2].label, "Prompts · 3", "three model calls");
  same(V.promptTabs.map((t) => [t.key, t.label, t.count, t.edited, t.on]), [["gradePrompt", "Grade an answer", "2", true, true], ["followUpPrompt", "Write a follow-up", "1", false, false]], "grouped by prompt, in the order the reader meets them, the first open");
  assert.equal(V.promptSelLabel, "Grade an answer");
  same(V.promptCalls.map((c) => [c.when, c.where, c.badge, c.meta, c.input, JSON.parse(c.output)]), [
    [P.d.clock(at + 10), "onboarding · answer", "edited prompt", "claude-haiku-4-5 · 210 in · 12 out · $0.0004 · 120 ms", "Grade this answer kindly.", { level: 50, rationale: "fair" }],
    [P.d.clock(at + 560), "onboarding · answer", "edited prompt", "claude-haiku-4-5 · 220 in · 12 out · $0.0004 · 110 ms", "Grade the second answer kindly.", { level: 75, rationale: "good" }]]);
  V.promptTabs[1].select(); await flush();
  V = P.d.renderVals();
  same(V.promptCalls.map((c) => [c.badge, c.input, c.output]), [["", "Write a follow-up.", JSON.stringify({ question: "And then?" }, null, 2)]]);
  P.d.setState({ view: "prompts" }); await flush();
  const view = find(P.d.render(), (n) => n.props && n.props["data-screen-label"] === "Prompts");
  assert.equal(view.length, 1);
  assert.ok(texts(view[0]).includes("Write a follow-up.") && texts(view[0]).includes("Input · as the model received it") && texts(view[0]).includes("Response · as parsed"));
  assert.equal(find(view[0], (n) => n.props && n.props["data-prompt-call"]).length, 1);
  V.promptCalls[0].open(); await flush();
  same([P.d.state.view, P.d.state.sel, P.d.state.open["st-1"], P.d.state.inspTab], ["requests", { run: "live", stage: "st-1", op: "op-3" }, true, "input"], "the call opens in the Requests view, its request unfolded and the call selected");
  assert.equal(P.d.inspectorVM().name, "write one follow-up");
});

test("in Real mode the Prompts view reads each call's request and reply from its recorded snapshots and names the prompt from the record", async () => {
  const P = page({ mode: "real" });
  P.request("rq-1", { action: "analysis", body: { action: "analysis", run: true }, bg: true });
  P.response("rq-1", { trace_id: TRACE.analysis, body: { onboarding: { id: OB }, analysis: { status: "running" } } });
  await settle();
  let V = P.d.renderVals();
  assert.equal(V.views[2].label, "Prompts · 1");
  same(V.promptTabs.map((t) => [t.key, t.label, t.count, t.edited]), [["analyzePrompt", "Read the paper", "1", false]], "named by the record's engelbart.prompt.template");
  const call = V.promptCalls[0];
  same([call.where, call.badge, call.status], ["onboarding · analysis (run) · Name", "", "ok"], "the request, and the step it was sent from");
  assert.match(call.meta, /^claude-sonnet-4-5-20250929 · 1,843 in · 1,276 out · /);
  assert.ok(call.input.startsWith("The PhD student's paper follows as an attached document."), "the message as the model received it, from the model_request snapshot");
  assert.ok(call.input.includes("[the paper, as a PDF document block · 24 KB]"), "the paper is named, not pasted");
  assert.ok(call.input.includes("<phd_student_paper>"));
  assert.equal(JSON.parse(call.output).title, "Speculative Decoding for Fast LLM Inference", "the reply as parsed, from the model_parsed_response snapshot");
  assert.equal(call.note, "credentials redacted before it was stored");
  // A run recorded before prompts were named is placed by the call's purpose.
  const older = P.d.state.recordings[0];
  older.stages.forEach((s) => s.ops.forEach((o) => { if (o.kind === "model") { delete o.attributes["engelbart.prompt.template"]; delete o.attributes["engelbart.prompt.edited"]; } }));
  V = P.d.renderVals();
  same(V.promptTabs.map((t) => [t.key, t.edited]), [["analyzePrompt", false]]);
  call.open(); await flush();
  same([P.d.state.view, P.d.state.sel.op], ["requests", MODEL_OP]);
  assert.equal(P.d.inspectorVM().name, "model.analysis");
});

test("the plain test link and unknown modes use live uploads, never fixture environments", async () => {
  for (const search of ["", "?test=true", "?mode=unknown"]) {
    const P = page({ search, seed: { "egb.debugger.mode": "sim" } });
    assert.equal(P.d.isReal(), true);
    assert.equal(P.d.renderVals().frameSrc, "/engelbart/setup/test/frame?mode=real");
    assert.ok(!texts(P.d.renderTopBar(P.d.renderVals())).includes("Live · your uploads and model results"));
    await settle();
  }
});

test("live reset requires confirmation, sends the member-scoped project reset once, and reloads on success", async () => {
  const P = page({ search: "" }); await settle();
  const calls = []; let reloads = 0, resolve;
  P.w.location.reload = () => { reloads++; };
  P.w.fetch = (url, init) => { calls.push({ url, init }); return new Promise(r => { resolve = r; }); };
  const button = () => find(P.d.renderTopBar(P.d.renderVals()), n => n.type === "button" && texts(n).includes("Reset test environment"))[0];
  assert.equal(button().props.disabled, false);
  P.w.confirm = () => false;
  await button().props.onClick();
  assert.equal(calls.length, 0);
  P.w.confirm = () => true;
  const pending = button().props.onClick(); await settle();
  await P.d.resetReal();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/engelbart-onboarding");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + TOKEN);
  same(JSON.parse(calls[0].init.body), { action: "reset", scope: "project" });
  assert.equal(reloads, 0);
  resolve({ ok: true, json: async () => ({ onboarding: { id: "fresh-setup" }, calibrations: [], profile_reused: false }) }); await pending; await flush();
  assert.equal(reloads, 1);
  assert.equal(P.d.state.real.resetting, false);
});

test("live reset preserves the screen on failure and cannot reset a historical run or signed-out session", async () => {
  const P = page({ search: "" }); await settle();
  let reloads = 0;
  P.w.location.reload = () => { reloads++; };
  P.w.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "Reset unavailable" }) });
  await P.d.resetReal(); await flush();
  assert.equal(P.d.state.real.error, "Reset unavailable");
  assert.equal(P.d.state.real.resetting, false);
  assert.equal(reloads, 0);
  P.d.state.real.picked = { onboarding_id: "older" };
  P.w.fetch = () => { throw new Error("Must not send a reset"); };
  await P.d.resetReal();
  const Q = page({ search: "", signedIn: false }); await settle();
  Q.w.fetch = () => { throw new Error("Must not send a reset"); };
  await Q.d.resetReal(); await flush();
  assert.match(Q.d.state.real.error, /Sign in/);
});
