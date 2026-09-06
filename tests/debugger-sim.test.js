"use strict";

// The debugger at /engelbart/setup/test runs the real setup page against a
// simulated control plane that lives entirely in the browser. These tests run
// that simulator under Node, the way the debugger's isolated replay does, and
// check the shipped page reaches nothing but same-origin files and the pinned
// React builds. Nothing here touches a network or a real Supabase project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "engelbart", "setup", "test");

function browserish() {
  const store = new Map();
  const sandbox = {
    setTimeout, clearTimeout, console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ["fixture.js", "prompts.js", "sim-backend.js"]) {
    vm.runInContext(fs.readFileSync(path.join(DIR, file), "utf8"), sandbox, { filename: file });
  }
  return sandbox;
}

function simulator() {
  const w = browserish();
  const events = [];
  const sim = w.EngelbartSim.create({ emit: (ev) => events.push(JSON.parse(JSON.stringify(ev))), speed: 0 });
  return { w, sim, events };
}

test("the simulator answers the page's first request and traces every operation of it", async () => {
  const { sim, events } = simulator();
  assert.equal(sim.isSim("/api/engelbart-config"), true);
  assert.equal(sim.isSim("https://example.com/x"), false);
  const response = await sim.handle("/api/engelbart-config");
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body, "object");
  const stage = events.find((e) => e.type === "stage");
  assert.ok(stage, "a stage event opens the request");
  assert.equal(stage.path, "/api/engelbart-config");
  assert.equal(stage.method, "GET");
  const end = events.find((e) => e.type === "stage.end" && e.id === stage.id);
  assert.ok(end, "the request is closed");
  assert.equal(end.status, "ok");
  assert.equal(end.code, 200);
});

test("opening the onboarding runs the auth, credit and database operations the real server runs", async () => {
  const { sim, events } = simulator();
  const response = await sim.handle("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "open" }) });
  assert.equal(response.ok, true, JSON.stringify(await response.json()));
  const ops = events.filter((e) => e.type === "op" && e.status === "ok");
  assert.ok(ops.length >= 3, "several operations answered the request");
  const kinds = new Set(ops.map((o) => o.kind));
  assert.ok(kinds.has("db"), "database operations are traced");
  for (const op of ops) {
    assert.ok(Array.isArray(op.reads) && Array.isArray(op.writes), "every operation names what it read and wrote");
    assert.ok(typeof op.name === "string" && op.name, "every operation is named");
  }
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{20}/, "no JWT-shaped token reaches the trace");
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9]/, "no bearer credential reaches the trace");
  const end = events.filter((e) => e.type === "stage.end").pop();
  assert.equal(end.status, "ok");
});

test("the simulator's state persists under the environment's key and reset clears it", async () => {
  const w = browserish();
  const sim = w.EngelbartSim.create({ emit() {}, speed: 0, persist: "egb.sim.db.test-env" });
  await sim.handle("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "open" }) });
  const stored = w.localStorage.getItem("egb.sim.db.test-env");
  assert.ok(stored, "the account is written under the environment's key");
  assert.ok(JSON.parse(stored).onboardings.length >= 1, "the onboarding row is stored");
  sim.reset();
  assert.equal(JSON.parse(w.localStorage.getItem("egb.sim.db.test-env")).onboardings.length, 0, "reset drops the row");
});

test("prompt templates render with every slot filled, and an environment's edit is honoured", () => {
  const w = browserish();
  const P = w.EGB_PROMPTS;
  assert.equal(P.ORDER.length, 11);
  for (const key of P.ORDER) assert.equal(typeof P.TEMPLATES[key], "string", key + " has a template");
  const text = P.render("gradePrompt", { area: "Goal inference", level: 50, sample: "a sample", answer: "an answer" });
  assert.match(text, /"Goal inference"/);
  assert.match(text, /an answer/);
  assert.doesNotMatch(text, /\{\{/, "no slot is left unfilled");
  const edited = P.render("gradePrompt", { area: "X", level: 0, sample: "s", answer: "a" }, { gradePrompt: "Grade {{area}} at {{level}}." });
  assert.equal(edited, "Grade X at 0.");
});

function scriptSources(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    out.push({ src: src ? src[1] : null, inline: m[2].trim(), integrity: /\bintegrity="/.test(m[1]) });
  }
  return out;
}

test("the debugger and its frame load only same-origin files besides the pinned React builds, with no inline script", () => {
  for (const file of ["index.html", "frame.html"]) {
    const html = fs.readFileSync(path.join(DIR, file), "utf8");
    const scripts = scriptSources(html);
    assert.ok(scripts.length >= 4, file + " loads its scripts");
    for (const s of scripts) {
      assert.equal(s.inline, "", file + " has no inline script (the Engelbart CSP forbids it)");
      if (s.src.startsWith("https://cdn.jsdelivr.net/npm/react")) assert.ok(s.integrity, s.src + " is pinned by integrity");
      else assert.match(s.src, /^\/engelbart\/setup\//, file + " loads " + s.src + " from this origin");
      const local = s.src.startsWith("/") ? path.join(ROOT, s.src) : null;
      if (local) assert.ok(fs.existsSync(local), s.src + " exists");
    }
    assert.doesNotMatch(html, /\bon[a-z]+="/, file + " has no inline event handlers");
  }
});

test("vercel serves the debugger and lets only the frame page be embedded, by this origin", () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  assert.ok(v.rewrites.some((r) => r.source === "/engelbart/setup/test" && r.destination === "/engelbart/setup/test/index.html"));
  const setup = v.headers.find((r) => r.source === "/engelbart/(.*)");
  assert.match(setup.headers.find((h) => h.key === "Content-Security-Policy").value, /frame-ancestors 'none'/, "the setup page still cannot be framed");
  assert.equal(setup.headers.find((h) => h.key === "X-Frame-Options").value, "DENY");
  const frame = v.headers.find((r) => r.source === "/engelbart/setup/test/frame");
  assert.ok(frame, "the frame page has its own header rule");
  assert.ok(v.headers.indexOf(frame) > v.headers.indexOf(setup), "the frame rule comes after the general rule, so it wins");
  const csp = frame.headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(csp, /unsafe-(inline|eval)/);
  assert.equal(frame.headers.find((h) => h.key === "X-Frame-Options").value, "SAMEORIGIN");
});
