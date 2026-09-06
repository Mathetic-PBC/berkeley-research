"use strict";

// The debugger's frame (frame.js) hosts the real setup page in one of two modes.
// In Real mode it must intercept nothing: the page's own fetch still reaches
// the real endpoints and supabase-js still reads the member's real session. It
// may only watch, and what it reports to the debugger must carry no credential.
// In Simulated mode it must keep doing what it did: route /api into the
// in-page simulator and hand the page a session that is always signed in.
// Run under Node with a minimal window, so the wiring is checked without a
// browser or a network.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "test", "frame.js"), "utf8");
const ORIGIN = "https://app.example";

function plain(x) { return JSON.parse(JSON.stringify(x)); }
function same(a, b, msg) { assert.deepEqual(plain(a), plain(b), msg); }

// A window with the few things frame.js touches: location, parent, document, fetch, supabase-js, the simulator.
function frame(opts) {
  const posted = [], listeners = { window: {}, document: {} };
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams,
    reloaded: 0,
    location: { origin: ORIGIN, search: opts.search || (opts.mode === "real" ? "?mode=real" : "?env=default"), reload() { sandbox.reloaded += 1; } },
    parent: { postMessage(m, origin) { posted.push({ m: plain(m), origin }); } },
    addEventListener(type, fn) { listeners.window[type] = fn; },
    document: { addEventListener(type, fn) { listeners.document[type] = fn; }, getElementById() { return null; }, querySelector() { return null; }, body: { style: {} } },
    fetch: opts.fetch,
  };
  if ("supabase" in opts) sandbox.supabase = opts.supabase;
  // The simulator's globals, as frame.html loads them; the real page (frame-real.html) loads neither.
  if (opts.sim) { sandbox.EngelbartSim = opts.sim; sandbox.EGB_FIXTURES = opts.fixtures || { "inspectable-intent": { id: "inspectable-intent", name: "Inspectable Intent in Agentic Programming" } }; }
  if (opts.fixtureOnly) sandbox.EGB_FIXTURE = { PAPER: {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "frame.js" });
  return {
    w: sandbox, posted, listeners,
    messages: (kind) => posted.filter((p) => p.m.egb === kind).map((p) => p.m),
    command: (cmd, value, from) => listeners.window.message(Object.assign({ origin: ORIGIN, source: sandbox.parent, data: { egb: "cmd", cmd, value } }, from || {})),
  };
}

// What a real fetch would resolve to, as far as frame.js reads it.
function reply(status, body, headers) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h = {}; Object.keys(headers || {}).forEach((k) => { h[k.toLowerCase()] = headers[k]; });
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) }, clone() { return { text: async () => text }; }, json: async () => JSON.parse(text) };
}

const JWT = "eyJ" + "a".repeat(60) + ".payload.signature";
function supabaseWith(session) {
  const made = [];
  return { made, lib: { createClient(url, key, options) { made.push({ url, key, options }); return { auth: { getSession: async () => ({ data: { session }, error: null }) } }; } } };
}

test("real mode: the page's request reaches the real fetch untouched, and the debugger is told what was sent and what came back, redacted, with the trace the reply named", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return reply(200, {
      onboarding: { id: "e20372db-45a2-491b-a67b-7b005db3bbf0", name: "Ada", step: 2 },
      own_key: { set: true, key: "sk-live-should-not-leak", last4: "1234" },
      upload: { uploadUrl: "https://x.supabase.co/storage/v1/object/upload/sign/berkeley-papers/p.pdf?token=SIGNEDUPLOADTOKEN" },
      access_token: JWT, note: "kept",
    }, { "X-Engelbart-Trace-Id": "A7552EC53C282068E729FEF8B025B8D6" });
  };
  const F = frame({ mode: "real", fetch, supabase: supabaseWith(null).lib });
  assert.deepEqual(F.messages("ready"), [{ egb: "ready", speed: 1, mode: "real", backend: "RealBackend", fixture: null, refused: null }], "the frame announces its mode and its backend: real, with no test case");

  const init = { method: "POST", headers: { Authorization: "Bearer " + JWT, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "step", name: "Ada", key: "sk-ant-secret", token: "t0k", nested: { apikey: "anon-key", note: "fine", link: "https://x.supabase.co/f?token=abc&x=1" } }) };
  const out = await F.w.fetch("/api/engelbart-onboarding?debug=1", init);
  assert.equal(out.status, 200, "the caller gets the real response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/engelbart-onboarding?debug=1", "the URL is passed through as given");
  assert.equal(calls[0].init, init, "the request is passed through as given, credentials included");

  const rq = F.messages("request");
  assert.equal(rq.length, 1);
  const { id, at, ...req } = rq[0];
  assert.ok(/^rq-1-/.test(id)); assert.ok(at > 0);
  assert.deepEqual(req, { egb: "request", method: "POST", path: "/api/engelbart-onboarding", where: "api", action: "step", step: null, bg: false, poll: false,
    body: { action: "step", name: "Ada", key: "••••••••", token: "••••••••", nested: { apikey: "••••••••", note: "fine", link: "https://x.supabase.co/f?token=••••••••&x=1" } } });

  const rs = F.messages("response");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].id, id, "the reply names the request it answers");
  assert.equal(rs[0].status, 200); assert.equal(rs[0].ok, true); assert.ok(rs[0].ms >= 0);
  assert.equal(rs[0].trace_id, "a7552ec53c282068e729fef8b025b8d6", "the trace id from the reply header, normalized");
  assert.deepEqual(rs[0].body, { onboarding: { id: "e20372db-45a2-491b-a67b-7b005db3bbf0", name: "Ada", step: 2 }, own_key: { set: true, key: "••••••••", last4: "1234" },
    upload: { uploadUrl: "••••••••" }, access_token: "••••••••", note: "kept" });

  const everything = JSON.stringify(F.posted);
  for (const secret of ["sk-live", "sk-ant", "SIGNEDUPLOADTOKEN", "Bearer", "anon-key", JWT.slice(0, 20), "t0k"]) assert.ok(!everything.includes(secret), secret + " never leaves the frame");
  assert.ok(F.posted.every((p) => p.origin === ORIGIN), "messages go only to this origin");
});

test("real mode: only same-origin /api requests and the paper's PUT to Storage are reported; everything else passes unseen", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(url); return /storage/.test(String(url)) ? reply(200, {}) : reply(200, { ok: true }); };
  const F = frame({ mode: "real", fetch, supabase: supabaseWith(null).lib });
  const before = F.posted.length;
  await F.w.fetch("https://x.supabase.co/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: "r" }) });
  await F.w.fetch("/engelbart/setup/setup.css");
  await F.w.fetch(ORIGIN + "/engelbart/signin");
  await F.w.fetch("https://fonts.googleapis.com/css2?family=Inter");
  await F.w.fetch("https://x.supabase.co/storage/v1/object/berkeley-papers/papers/p.pdf", { method: "GET" });
  assert.equal(seen.length, 5, "every request still went out");
  assert.equal(F.posted.length, before, "none of them was reported");

  await F.w.fetch(ORIGIN + "/api/engelbart-config", { headers: { Accept: "application/json" } });
  const cfg = F.messages("request").pop();
  assert.equal(cfg.path, "/api/engelbart-config"); assert.equal(cfg.method, "GET"); assert.equal(cfg.action, "engelbart-config"); assert.equal(cfg.body, null);
  assert.equal(F.messages("response").pop().trace_id, null, "a reply without the header names no trace");

  await F.w.fetch("https://x.supabase.co/storage/v1/object/berkeley-papers/papers/3f9c.pdf?token=SIGNEDUPLOADTOKEN", { method: "PUT", headers: { apikey: "anon", Authorization: "Bearer anon" }, body: { size: 1998042, type: "application/pdf", name: "paper.pdf" } });
  const up = F.messages("request").pop();
  assert.deepEqual([up.method, up.path, up.where, up.action, up.body], ["PUT", "/storage/v1/object/berkeley-papers/papers/3f9c.pdf", "storage", "upload", { bytes: 1998042, type: "application/pdf", name: "paper.pdf" }], "the upload is reported by size and path; the signed token and the bytes are not");
  const upDone = F.messages("response").pop();
  assert.deepEqual([upDone.id, upDone.status, upDone.trace_id, upDone.body], [up.id, 200, null, { ok: true, status: 200 }]);
  assert.ok(!JSON.stringify(F.posted).includes("SIGNEDUPLOADTOKEN"));
});

test("real mode: a background reading is marked by the flag the page sent, a status read is a poll, and a reply's trace id is taken only when well-formed", async () => {
  let header = null;
  const fetch = async () => reply(202, { analysis: { status: "running" } }, header ? { "x-engelbart-trace-id": header } : {});
  const F = frame({ mode: "real", fetch, supabase: supabaseWith(null).lib });
  const send = (body) => F.w.fetch("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify(body) });
  await send({ action: "analysis" });
  await send({ action: "analysis", run: true });
  await send({ action: "assets", retry: true });
  await send({ action: "leveled" });
  await send({ action: "open" });
  await send({ action: "answer", text: "x" });
  const flags = F.messages("request").map((m) => [m.action, m.bg, m.poll]);
  assert.deepEqual(flags, [["analysis", false, true], ["analysis", true, false], ["assets", true, false], ["leveled", false, true], ["open", false, false], ["answer", false, false]]);
  assert.deepEqual(F.messages("response").map((m) => m.trace_id), [null, null, null, null, null, null], "an untraced poll's reply carries no id, and none is made up");
  header = "not-a-trace"; await send({ action: "open" });
  assert.equal(F.messages("response").pop().trace_id, null, "a malformed header is not a trace id");
  header = "6c6cd3de585d8089a590a9234d570d61"; await send({ action: "sources" });
  assert.equal(F.messages("response").pop().trace_id, "6c6cd3de585d8089a590a9234d570d61");
  const last = F.messages("response").pop();
  assert.equal(last.status, 202);
  assert.deepEqual(last.body, { analysis: { status: "running" } });
  await send({ action: "step", text: "abc" });
  const body = F.messages("request").pop().body;
  assert.equal(body.text, "abc", "ordinary values are kept as sent");
});

test("real mode: a request that never got an answer is reported as such, and the page still sees the failure", async () => {
  const fetch = async () => { throw new TypeError("Failed to fetch"); };
  const F = frame({ mode: "real", fetch, supabase: supabaseWith(null).lib });
  await assert.rejects(F.w.fetch("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "open" }) }), /Failed to fetch/);
  const rs = F.messages("response").pop();
  assert.equal(rs.status, 0); assert.equal(rs.ok, false); assert.equal(rs.trace_id, null); assert.equal(rs.body, null); assert.equal(rs.error, "Failed to fetch");
  assert.equal(rs.id, F.messages("request").pop().id);
});

test("real mode: supabase-js is the real one, and whether it found a session is reported, without the session itself", async () => {
  const session = { access_token: JWT, refresh_token: "refresh-me", user: { id: "u-1", email: "member@berkeley.edu" } };
  const S = supabaseWith(session);
  const F = frame({ mode: "real", fetch: async () => reply(200, {}), supabase: S.lib });
  assert.equal(F.messages("session").length, 0, "nothing is said until the page asks");
  const client = F.w.supabase.createClient("https://x.supabase.co", "anon", { auth: { persistSession: true } });
  assert.deepEqual(plain(S.made), [{ url: "https://x.supabase.co", key: "anon", options: { auth: { persistSession: true } } }], "the page's own client, made with the page's own arguments");
  const got = await client.auth.getSession();
  assert.equal(got.data.session.access_token, JWT, "the page gets the real session back");
  assert.deepEqual(F.messages("session"), [{ egb: "session", signedIn: true, email: "member@berkeley.edu" }]);
  assert.ok(!JSON.stringify(F.posted).includes("refresh-me") && !JSON.stringify(F.posted).includes(JWT.slice(0, 20)), "the tokens stay in the frame");

  const none = frame({ mode: "real", fetch: async () => reply(200, {}), supabase: supabaseWith(null).lib });
  await none.w.supabase.createClient("u", "k").auth.getSession();
  assert.deepEqual(none.messages("session"), [{ egb: "session", signedIn: false, email: "" }]);

  const missing = frame({ mode: "real", fetch: async () => reply(200, {}) });
  assert.deepEqual(missing.messages("session"), [{ egb: "session", signedIn: false, email: "", error: "supabase-js did not load" }]);
});

test("real mode: the simulator's commands do nothing but say so; picking and reloading still work; strangers are ignored", () => {
  const F = frame({ mode: "real", fetch: async () => reply(200, {}), supabase: supabaseWith(null).lib });
  F.command("snapshot");
  assert.deepEqual(F.messages("snapshot"), [{ egb: "snapshot", state: null }], "there is no simulator state to report");
  F.command("reset"); F.command("speed", 0.25);
  assert.equal(F.messages("notice").length, 2);
  F.command("dropFixture");
  assert.equal(F.messages("notice").length, 2, "there is no fixture paper to drop, in either mode: the command is gone");
  assert.ok(F.messages("notice").every((n) => /simulator control; it does nothing in Real mode/.test(n.text)));
  assert.equal(F.w.reloaded, 0, "reset did not reload the real page: there was nothing to reset");
  F.command("pick");
  assert.equal(F.w.document.body.style.cursor, "crosshair");
  F.command("cancelPick");
  assert.equal(F.w.document.body.style.cursor, "");
  F.command("reload");
  assert.equal(F.w.reloaded, 1);
  const before = F.posted.length;
  F.command("snapshot", null, { origin: "https://evil.example" });
  F.command("snapshot", null, { source: {} });
  assert.equal(F.posted.length, before, "commands from another origin or window are not obeyed");
});

test("real mode: the edited prompts the debugger sends ride on the model actions only, as the page's own body plus prompt_overrides; the report names them, never their text", async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return reply(200, { ok: true }); };
  const F = frame({ mode: "real", fetch, supabase: supabaseWith(null).lib });
  const post = (body) => { const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; return F.w.fetch("/api/engelbart-onboarding", init).then(() => init); };
  await post({ action: "answer", area: 0, text: "before any prompts were chosen" });
  F.command("prompts", { gradePrompt: "Grade {{answer}} kindly", askPrompt: "Answer briefly" });
  const original = await post({ action: "answer", area: 0, text: "an answer" });
  await post({ action: "step", step: 2, fields: { name: "Ada" } });
  await post({ action: "analysis" });
  await post({ action: "analysis", run: true });
  F.command("prompts", {});
  await post({ action: "answer", area: 1, text: "later" });
  const sent = calls.map((c) => JSON.parse(c.init.body));
  same(sent.map((b) => b.prompt_overrides), [undefined, { gradePrompt: "Grade {{answer}} kindly", askPrompt: "Answer briefly" }, undefined, undefined, { gradePrompt: "Grade {{answer}} kindly", askPrompt: "Answer briefly" }, undefined],
    "a model action carries them once chosen; a step, a poll, and everything after they are cleared do not");
  assert.deepEqual(sent[1], { action: "answer", area: 0, text: "an answer", prompt_overrides: { gradePrompt: "Grade {{answer}} kindly", askPrompt: "Answer briefly" } }, "the page's body, plus the overrides");
  assert.equal(JSON.parse(original.body).prompt_overrides, undefined, "the page's own request object is not touched");
  const reported = F.messages("request").map((m) => m.body.prompt_overrides);
  same(reported, [undefined, ["gradePrompt", "askPrompt"], undefined, undefined, ["gradePrompt", "askPrompt"], undefined], "the debugger is told which prompts went, not their text");
  assert.ok(!JSON.stringify(F.posted).includes("Grade {{answer}} kindly"));
  assert.equal(F.messages("notice").length, 0, "prompts is not a simulator control any more");
});

test("simulated mode is unchanged: /api goes to the in-page simulator, the session is the fake one, and the simulator's commands work", async () => {
  const created = [], handled = [], speeds = [];
  const sim = { create(opts) { created.push(opts); return { fixture: { id: "inspectable-intent", name: "Inspectable Intent in Agentic Programming", file: "Inspectable Intent in Agentic Programming.pdf" }, USER: { id: "sim-user", email: "reader@sim.local" }, isSim: (u) => /^\/api\//.test(String(u)), handle: (u, init) => { handled.push([u, init && init.method]); return Promise.resolve("simulated"); },
    local: () => Promise.resolve(), setSpeed: (v) => speeds.push(v), setPrompts() {}, state: () => ({ onboardings: 1 }), reset() { created.push("reset"); } }; } };
  const passed = [];
  const F = frame({ mode: "sim", search: "?env=lab-1&speed=4", fetch: async (u) => { passed.push(u); return "real"; }, sim });
  assert.equal(created.length, 1);
  assert.equal(created[0].persist, "egb.sim.db.lab-1", "the simulated account lives under the environment's key");
  assert.equal(created[0].speed, 4);
  assert.equal(created[0].fixture, null, "no test case named on the URL: the simulator's default");
  assert.deepEqual(F.messages("ready"), [{ egb: "ready", speed: 4, mode: "sim", backend: "SimulatedBackend", refused: null,
    fixture: { id: "inspectable-intent", name: "Inspectable Intent in Agentic Programming", file: "Inspectable Intent in Agentic Programming.pdf" } }], "the frame names the test case it answers from");
  assert.equal(await F.w.fetch("/api/engelbart-onboarding", { method: "POST" }), "simulated");
  assert.deepEqual(handled, [["/api/engelbart-onboarding", "POST"]]);
  assert.equal(await F.w.fetch("https://fonts.googleapis.com/css"), "real");
  assert.deepEqual(passed, ["https://fonts.googleapis.com/css"]);
  assert.equal(F.messages("request").length, 0, "the simulator reports its own events; the observer is not installed");
  const got = await F.w.supabase.createClient().auth.getSession();
  assert.match(got.data.session.access_token, /^eyJ/);
  assert.equal(got.data.session.user.email, "reader@sim.local");
  assert.equal(F.messages("session").length, 0);
  F.command("snapshot");
  assert.deepEqual(F.messages("snapshot"), [{ egb: "snapshot", state: { onboardings: 1 } }]);
  F.command("speed", 0.25);
  assert.deepEqual(speeds, [0.25]);
  F.command("reset");
  assert.equal(created[created.length - 1], "reset");
  assert.equal(F.w.reloaded, 1, "a simulator reset reloads the page on the fresh account");
  created.length = 0;
  frame({ mode: "sim", search: "?env=../etc", fetch: async () => "real", sim });
  assert.equal(created[0].persist, "egb.sim.db.etc", "the environment key is sanitized");
  created.length = 0;
  frame({ mode: "sim", search: "?env=lab-1&fixture=tutortrace", fetch: async () => "real", sim });
  assert.equal(created[0].fixture, "tutortrace", "the test case named on the URL is the simulator's");
});

// The guarantee: the two backends are adapters with no path between them. The real one refuses to run in
// a frame that carries the simulator, and answers nothing itself; the simulated one answers only from the
// test case it was asked for, and refuses one it does not have rather than running another.
test("real mode refuses to boot beside the simulator: no request is answered, the reason is posted, and the real fetch is never touched", async () => {
  const calls = [];
  const created = [];
  const sim = { create(opts) { created.push(opts); return {}; } };
  const F = frame({ mode: "real", fetch: async (u) => { calls.push(u); return reply(200, { onboarding: {} }); }, supabase: supabaseWith(null).lib, sim });
  const ready = F.messages("ready")[0];
  assert.equal(ready.backend, "RealBackend");
  assert.equal(ready.fixture, null);
  assert.match(ready.refused, /Real mode refused to start: simulator scripts .* are loaded in this frame/);
  assert.equal(created.length, 0, "the simulator was not created");
  await assert.rejects(F.w.fetch("/api/engelbart-onboarding", { method: "POST", body: "{}" }), /Real mode refused to start/);
  await assert.rejects(F.w.fetch("https://x.supabase.co/storage/v1/object/upload/sign/p.pdf?token=t", { method: "PUT" }), /Real mode refused to start/);
  await assert.rejects(F.w.supabase.createClient().auth.getSession(), /Real mode refused to start/);
  assert.equal(calls.length, 0, "nothing reached the real backend either: the frame is unusable, not half real");
  assert.equal(F.messages("request").length, 0, "and nothing was reported as a request");
  F.command("reset");
  assert.match(F.messages("notice")[0].text, /refused to start/);
  // The fixture alone, without the simulator, is enough to refuse: nothing that could answer for the model may be present.
  const G = frame({ mode: "real", fetch: async () => reply(200, {}), supabase: supabaseWith(null).lib, fixtureOnly: true });
  assert.match(G.messages("ready")[0].refused, /Real mode refused to start/);
});

test("real mode: a backend failure is the failure the page sees; nothing stands in for it", async () => {
  const F = frame({ mode: "real", fetch: async () => { throw new Error("proxy is down"); }, supabase: supabaseWith(null).lib });
  await assert.rejects(F.w.fetch("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "analysis", run: true }) }), /proxy is down/);
  const ended = F.messages("response");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].ok, false);
  assert.equal(ended[0].status, 0);
  assert.equal(ended[0].error, "proxy is down");
  assert.equal(ended[0].body, null, "no body was invented for the failed request");
  const G = frame({ mode: "real", fetch: async () => reply(502, { error: "The model did not answer" }), supabase: supabaseWith(null).lib });
  const r = await G.w.fetch("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "analysis", run: true }) });
  assert.equal(r.status, 502, "the caller gets the real 502");
  assert.deepEqual(G.messages("response")[0].body, { error: "The model did not answer" });
});

test("simulated mode: a test case the simulator does not have is refused, not replaced by another", async () => {
  const sim = { create(opts) { if (opts.fixture === "nope") throw new Error("No simulated test case named “nope”"); return {}; } };
  const F = frame({ mode: "sim", search: "?env=lab-1&fixture=nope", fetch: async () => "real", sim });
  const ready = F.messages("ready")[0];
  assert.equal(ready.backend, "SimulatedBackend");
  assert.match(ready.refused, /No simulated test case named “nope”/);
  await assert.rejects(F.w.fetch("/api/engelbart-onboarding", { method: "POST" }), /No simulated test case named/);
  const G = frame({ mode: "sim", fetch: async () => "real" }); // frame-real.html opened without ?mode=real: no simulator to answer
  assert.match(G.messages("ready")[0].refused, /The simulator did not load/);
});
