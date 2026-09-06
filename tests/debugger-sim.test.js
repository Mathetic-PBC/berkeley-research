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

test("the debugger and its frames load only same-origin files besides the pinned React and supabase-js builds, with no inline script", () => {
  for (const file of ["index.html", "frame.html", "frame-real.html"]) {
    const html = fs.readFileSync(path.join(DIR, file), "utf8");
    const scripts = scriptSources(html);
    assert.ok(scripts.length >= 4, file + " loads its scripts");
    for (const s of scripts) {
      assert.equal(s.inline, "", file + " has no inline script (the Engelbart CSP forbids it)");
      if (/^https:\/\/cdn\.jsdelivr\.net\/npm\/(react|react-dom|@supabase\/supabase-js)@/.test(s.src)) assert.ok(s.integrity, s.src + " is pinned by integrity");
      else assert.match(s.src, /^\/engelbart\/setup\//, file + " loads " + s.src + " from this origin");
      const local = s.src.startsWith("/") ? path.join(ROOT, s.src) : null;
      if (local) assert.ok(fs.existsSync(local), s.src + " exists");
    }
    assert.doesNotMatch(html, /\bon[a-z]+="/, file + " has no inline event handlers");
  }
  // The two frames are the two backends. The simulated one carries the simulator and its test cases; the real
  // one carries neither, so nothing in it can answer for the model.
  const srcs = (file) => scriptSources(fs.readFileSync(path.join(DIR, file), "utf8")).map((x) => x.src);
  assert.deepEqual(srcs("frame.html").filter((x) => /fixture|sim-backend|prompts/.test(x)), ["/engelbart/setup/test/fixture.js", "/engelbart/setup/test/prompts.js", "/engelbart/setup/test/sim-backend.js"]);
  assert.deepEqual(srcs("frame-real.html").filter((x) => x.startsWith("/")), ["/engelbart/setup/test/frame.js", "/engelbart/setup/install.js", "/engelbart/setup/setup.js"], "the real frame: the observer and the product, nothing simulated");
  assert.ok(srcs("frame-real.html").some((x) => /@supabase\/supabase-js@/.test(x)), "and the pinned supabase-js, for the member's real session");
});

test("vercel serves the debugger and lets only the frame page be embedded, by this origin", () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  assert.ok(v.rewrites.some((r) => r.source === "/engelbart/setup/test" && r.destination === "/engelbart/setup/test/index.html"));
  const setup = v.headers.find((r) => r.source === "/engelbart/(.*)");
  assert.match(setup.headers.find((h) => h.key === "Content-Security-Policy").value, /frame-ancestors 'none'/, "the setup page still cannot be framed");
  assert.equal(setup.headers.find((h) => h.key === "X-Frame-Options").value, "DENY");
  for (const source of ["/engelbart/setup/test/frame", "/engelbart/setup/test/frame-real"]) {
    const frame = v.headers.find((r) => r.source === source);
    assert.ok(frame, source + " has its own header rule");
    assert.ok(v.headers.indexOf(frame) > v.headers.indexOf(setup), "the frame rule comes after the general rule, so it wins");
    const csp = frame.headers.find((h) => h.key === "Content-Security-Policy").value;
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
    assert.doesNotMatch(csp, /unsafe-(inline|eval)/);
    assert.equal(frame.headers.find((h) => h.key === "X-Frame-Options").value, "SAMEORIGIN");
  }
  assert.deepEqual(v.headers.find((r) => r.source === "/engelbart/setup/test/frame").headers, v.headers.find((r) => r.source === "/engelbart/setup/test/frame-real").headers, "the two frame pages are served alike");
});

// The simulated backend is a test case: deterministic, named, and never a reading of the uploaded file.
async function uploadAndAnalyze(sim, fileName) {
  const post = async (path, body) => { const r = await sim.handle(path, { method: "POST", body: JSON.stringify(body) }); const out = await r.json(); assert.equal(r.ok, true, JSON.stringify(out)); return out; };
  const opened = await post("/api/engelbart-onboarding", { action: "open" });
  await post("/api/engelbart-onboarding", { action: "step", step: 4, fields: { name: "Ada", year: "Third year", major: "Biology", depth: "some" } });
  const paper = await post("/api/engelbart-setup", { action: "own_paper", title: fileName.replace(/\.pdf$/i, ""), wantsUpload: true });
  await sim.handle(paper.upload.uploadUrl, { method: "PUT", body: { size: 4321 } });
  await post("/api/engelbart-setup", { action: "own_paper_saved", id: paper.id, token: paper.token });
  await post("/api/engelbart-onboarding", { action: "sources", paper_id: paper.id, paper_token: paper.token, paper_familiarity: 1 });
  const out = await post("/api/engelbart-onboarding", { action: "analysis", run: true });
  return { onboarding: opened.onboarding, paperId: paper.id, analysis: out.analysis };
}

test("the simulator answers from its test case whatever file is uploaded, says so in every operation, and names the case it was created with", async () => {
  const w = browserish();
  const A = [], B = [];
  const simA = w.EngelbartSim.create({ emit: (ev) => A.push(JSON.parse(JSON.stringify(ev))), speed: 0 });
  const simB = w.EngelbartSim.create({ emit: (ev) => B.push(JSON.parse(JSON.stringify(ev))), speed: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(simA.fixture)), { id: "inspectable-intent", name: "Inspectable Intent in Agentic Programming", file: "Inspectable Intent in Agentic Programming.pdf" });
  const a = await uploadAndAnalyze(simA, "TutorTrace.pdf");
  const b = await uploadAndAnalyze(simB, "Cytokine responses.pdf");
  assert.equal(a.analysis.title, "Inspectable Intent in Agentic Programming", "the reading is the test case's, not the file's");
  assert.deepEqual(a.analysis, b.analysis, "deterministic: two different uploads, the same answer");
  // The operations say where the answer came from: the download names the uploaded file and that it is not read;
  // the model call's meta and its context name the test case.
  const download = A.filter((e) => e.type === "op" && e.name === "download paper (service role)").pop();
  assert.equal(download.output.uploaded_file, "TutorTrace.pdf");
  assert.equal(download.output.object, "papers/" + a.paperId + ".pdf");
  assert.match(download.output.simulated, /the object's bytes are not read; the model answers from the test case “Inspectable Intent in Agentic Programming”/);
  const model = A.filter((e) => e.type === "op" && e.name === "analyze the paper").pop();
  assert.equal(model.meta.answered_from, "fixture inspectable-intent");
  assert.match(model.input.context.answered_from, /^the test case “Inspectable Intent in Agentic Programming” \(inspectable-intent\): saved model output; the uploaded PDF is not read$/);
  assert.ok(A.filter((e) => e.type === "op" && e.kind === "model").every((e) => e.meta.answered_from === "fixture inspectable-intent"), "every model call says so");
  assert.equal(simA.state().fixture, "inspectable-intent", "the record names its case");
});

test("a test case is chosen by id from the registry; an unknown id is refused, and a record made on another case starts over", async () => {
  const w = browserish();
  w.EGB_FIXTURES.tutortrace = { id: "tutortrace", name: "TutorTrace", file: "TutorTrace.pdf", bytes: 10,
    data: Object.assign({}, w.EGB_FIXTURE, { PAPER: Object.assign({}, w.EGB_FIXTURE.PAPER, { title: "TutorTrace", one_liner: "Traces of tutoring." }) }) };
  assert.throws(() => w.EngelbartSim.create({ emit() {}, speed: 0, fixture: "nope" }), /No simulated test case named “nope”/);
  const first = w.EngelbartSim.create({ emit() {}, speed: 0, persist: "egb.sim.db.lab" });
  await uploadAndAnalyze(first, "Anything.pdf");
  assert.equal(first.state().onboardings.length, 1);
  const second = w.EngelbartSim.create({ emit() {}, speed: 0, persist: "egb.sim.db.lab", fixture: "tutortrace" });
  assert.equal(second.fixture.name, "TutorTrace");
  assert.equal(second.state().onboardings.length, 0, "the old case's record is not this case's");
  const out = await uploadAndAnalyze(second, "Anything.pdf");
  assert.equal(out.analysis.title, "TutorTrace", "the second case answers with its own data");
  const same = w.EngelbartSim.create({ emit() {}, speed: 0, persist: "egb.sim.db.lab", fixture: "tutortrace" });
  assert.equal(same.state().onboardings.length, 1, "reopening on the same case keeps the record");
});

// A row at the brainstorm with the paper read and the resources still being fitted.
function brainstormSeed(w, turns) {
  const user = w.EGB_FIXTURE.USER;
  const t = "2026-09-06T00:00:00.000Z";
  return { n: 10, calibrations: [], asks: [], profiles: [], papers: [], codes: [],
    credit: { user_id: user.id, email: user.email, status: "ready", blocked: false, budget_usd: 25, spend_usd: 0, models: ["all-proxy-models"], synced_at: null },
    onboardings: [{ id: "ob-seed", user_id: user.id, status: "open", step: 7, name: "Ada", year: "Third year", major: "Biology", depth: "some",
      project_url: "", repo_url: "", paper_familiarity: 1, paper_id: null, paper_title: "Cytokine responses",
      analysis: { title: "Cytokine responses", one_liner: "How innate immune cells answer cytokines.", areas: [] }, analysis_status: "done",
      assessment: { areas: [], mean: 0, depth: "some", depth_shift: 0 }, assets_brief: [], assets_status: "running", leveled_status: "running",
      created_at: t, updated_at: t }],
    turns: (turns || []).map((x, i) => ({ id: "turn-" + i, onboarding_id: "ob-seed", stage: "brainstorm", asset_key: "", role: x.role, content: x.content, card: x.card || null, created_at: t })) };
}

async function brainstormTurn(sim, body) {
  const response = await sim.handle("/api/engelbart-onboarding", { method: "POST", body: JSON.stringify({ action: "brainstorm", ...body }) });
  const out = await response.json();
  assert.equal(response.ok, true, JSON.stringify(out));
  return out;
}

test("the simulated brainstorm says ready while the resources are still being fitted, and never asks a third round", async () => {
  const w = browserish();
  const sim = w.EngelbartSim.create({ emit() {}, speed: 0, seed: brainstormSeed(w) });
  const opening = await brainstormTurn(sim, {});
  assert.equal(opening.card, "questions");
  assert.equal(opening.ready, false);
  assert.equal(opening.leveled_status, "running");
  const second = await brainstormTurn(sim, { answers: { pull: "Reading goals out of a transcript" } });
  assert.equal(second.card, "focus", "a second round, because the answers changed the picture");
  assert.equal(second.ready, false);
  const third = await brainstormTurn(sim, { pick: "Make a wrong inferred goal easy to fix" });
  assert.equal(third.ready, true, "ready on the turn the model said so");
  assert.equal(third.leveled_status, "running", "the fitted list is not a condition of it; the page waits for that");
  assert.equal(third.card, "none");

  // A model that would keep asking is closed by the state: two rounds already stored, the third is refused.
  const asked = [{ role: "assistant", content: "(asked) One?", card: { card: "questions", questions: { eyebrow: "a", items: [{ id: "one", type: "free", title: "One?" }] }, ready: false } },
    { role: "user", content: "One? yes" },
    { role: "assistant", content: "(offered) A / B", card: { card: "focus", focus: { title: "Which?", options: [{ label: "A" }, { label: "B" }] }, ready: false } },
    { role: "user", content: "Focus: A" }];
  const capped = w.EngelbartSim.create({ emit() {}, speed: 0, seed: brainstormSeed(w, asked) });
  const more = await brainstormTurn(capped, { again: true });
  assert.equal(more.card, "none", "the canned reply asks on; the state closes the turn");
  assert.equal(more.ready, true);
  assert.equal(more.leveled_status, "running");
  const yetMore = await brainstormTurn(capped, { text: "but wait" });
  assert.equal(yetMore.card, "none");
  assert.equal(yetMore.ready, true);
  assert.equal(w.EGB_PROMPTS.BRAINSTORM_ROUNDS, 2, "the debugger's copy of the cap is the server's");
});
