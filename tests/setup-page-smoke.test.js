"use strict";

// The setup page, run. `setup.js` is plain DOM under a strict CSP, so it can be
// mounted on a hand-rolled document -- no jsdom, no dependency -- and driven by
// firing the listeners it registered. What is pinned here is what a reader can
// tell: which step is on screen, what the page sent, and in which order.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "setup.js"), "utf8");
// The install module ships beside the page and draws two of its steps.
const INSTALL = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "install.js"), "utf8");

// --- the smallest document setup.js can be drawn on ---------------------------

function makeEl(tag) {
  const node = {
    tagName: tag, children: [], attrs: {}, listeners: {}, style: {}, _text: null, parentNode: null,
    appendChild(child) { node._text = null; node.children.push(child); child.parentNode = node; return child; },
    setAttribute(key, value) { node.attrs[key] = String(value); },
    getAttribute(key) { return key in node.attrs ? node.attrs[key] : null; },
    removeAttribute(key) { delete node.attrs[key]; },
    hasAttribute(key) { return key in node.attrs; },
    addEventListener(name, fn) { (node.listeners[name] = node.listeners[name] || []).push(fn); },
    removeEventListener(name, fn) { node.listeners[name] = (node.listeners[name] || []).filter((f) => f !== fn); },
    fire(name, event) { (node.listeners[name] || []).slice().forEach((fn) => fn({ preventDefault() {}, ...event })); },
    focus() { node.focused = true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 56 }; },
    click() { node.fire("click", { target: node }); },
    querySelectorAll(selector) {
      assert.equal(selector, ".ob-cta", "the stub only knows the primary-button lookup");
      return byClass(node, "ob-cta");
    },
    querySelector(selector) {
      // The stub knows one attribute-presence lookup, "[name]".
      const m = /^\[([a-z-]+)\]$/.exec(selector);
      assert.ok(m, `the stub only knows [attribute] lookups, not ${selector}`);
      let hit = null;
      (function walk(n) { if (hit) return; if (n.hasAttribute && n.hasAttribute(m[1])) { hit = n; return; } (n.children || []).forEach(walk); })(node);
      return hit;
    },
  };
  Object.defineProperty(node, "textContent", {
    get() { return node._text != null ? node._text : node.children.map((c) => c.textContent).join(""); },
    set(value) { node.children = []; node._text = String(value); },
  });
  // A button's `disabled` property is its attribute, and a disabled button
  // fires no click -- both of which the page's Continue buttons rely on.
  Object.defineProperty(node, "disabled", {
    get() { return "disabled" in node.attrs; },
    set(value) { if (value) node.attrs.disabled = "disabled"; else delete node.attrs.disabled; },
  });
  Object.defineProperty(node, "className", {
    get() { return node.attrs.class || ""; },
    set(value) { node.attrs.class = value; },
  });
  return node;
}

function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  (node.children || []).forEach((child) => find(child, pred, out));
  return out;
}
function byClass(node, name) { return find(node, (n) => String(n.attrs.class || "").split(/\s+/).includes(name)); }
function one(node, name) { return byClass(node, name)[0]; }
function textOf(node) { return node ? node.textContent.replace(/\s+/g, " ").trim() : ""; }
const settle = async (turns = 8) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };
// Picking an option lets the choice show for 180ms before it is written.
const afterThePause = async () => { await new Promise((r) => setTimeout(r, 220)); await settle(); };

function five(tag) { return [0, 25, 50, 75, 100].map((level) => ({ level, question: `${tag} question at ${level}`, sample_response: `SAMPLE-${tag}-${level}` })); }
const ANALYSIS = { title: "Zebra Tuning", one_liner: "It tunes zebras.", date: "2024",
  areas: [{ area: "A", project_role: "core", questions: five("A") }, { area: "B", project_role: "code", questions: five("B") }] };
const DETAILS = { intro: "", questions: [{ id: "who", kind: "choice", title: "Who is it for?", options: ["Just me", "A team"] }], answers: {} };
const GOALS = { goals: [1, 2, 3, 4].map((n) => ({ label: `Goal ${n}`, short: `g${n}`, why: `why ${n}` })) };
const PAPER = "22222222-2222-2222-2222-222222222222";

const LEVELED = { locus: "the geometry", sticky: ["angles"], assets: [
  { title: "Pose viewer", one_liner: "views poses", description: "A viewer.", type: "demo", availability: "usable",
    links: [{ kind: "live_demo", url: "https://x.org/demo" }], what_you_can_do_with_it: "play",
    children: [{ title: "Toy poses", one_liner: "ten poses", type: "dataset", why: "small first", links: [] }] },
  { title: "Dance corpus", one_liner: "videos", type: "dataset", availability: "partial", links: [] },
] };
const ASSESSMENT = { areas: [{ area: "A", graded_level: 50 }, { area: "B", graded_level: 25 }], mean: 38, depth: "some" };
const DIRECTION = { title: "Pose to angles", what_you_would_make: "A page that turns a pose into angles.", uses: ["Pose viewer"],
  why_it_fits: "Geometry is the point.", first_visible_result: "one labelled skeleton" };
const SUBGOALS = [{ label: "One pose drawn", description: "d1", why: "w1" }, { label: "Angles computed", description: "d2", why: "w2" },
  { label: "A sequence compared", description: "d3", why: "w3" }];

// A row far enough along that any step can be drawn from it.
function fullRow(extra) {
  return { step: 0, name: "Ada", year: "First year", major: "Physics", depth: "some",
    paper_id: PAPER, paper_title: "Zebra Tuning", paper_familiarity: 2,
    analysis: ANALYSIS, analysis_status: "done", assets_status: "done", assets: { assets: LEVELED.assets },
    assets_brief: [{ title: "Pose viewer", type: "demo", one_liner: "views poses" }],
    assessment: ASSESSMENT, leveled_status: "done", leveled: LEVELED, interest: "geometry",
    asset_chosen: { key: "Pose viewer", title: "Pose viewer" }, direction: DIRECTION, subgoals: SUBGOALS,
    goal_chosen: "Pose to angles", todos: ["one", "two"], ...extra };
}

// Mounts the page. `replies` overrides one action's answer; `refuse` makes one
// action fail with a status and a message, the way the endpoint does.
function mount(options = {}) {
  const app = makeEl("div");
  const actions = [];
  const bodies = [];
  let row = { step: 0, status: "open", analysis_status: "none", assets_status: "none", leveled_status: "none", ...options.row };
  const turns = options.turns || [];
  const refuse = options.refuse || {};
  const replies = options.replies || {};

  const answer = (value, status = 200) => Promise.resolve({
    ok: status < 300, status, json: () => Promise.resolve(value),
  });

  function fetchStub(url, init = {}) {
    const headers = (init && init.headers) || {};
    const isJson = headers["Content-Type"] === "application/json";
    const body = isJson && init.body ? JSON.parse(init.body) : null;
    if (url === "/api/engelbart-config") return answer({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" });
    if (body) { actions.push(body.action); bodies.push(body); }
    if (body && refuse[body.action]) {
      const no = refuse[body.action];
      return answer({ error: no.error }, no.status);
    }
    if (body && replies[body.action]) return replies[body.action](body);
    if (url === "/api/engelbart-onboarding") {
      if (body.action === "open") return answer({ onboarding: row, calibrations: options.calibrations || [], turns, profile_reused: Boolean(options.profileReused) });
      if (body.action === "reset") { row = { step: 0, status: "open", analysis_status: "none" }; return answer({ onboarding: row, calibrations: [], profile_reused: false }); }
      if (body.action === "step") { row = { ...row, ...body.fields, step: body.step }; return answer({ onboarding: row }); }
      if (body.action === "sources") return answer({ ok: true, analysis_status: "none" });
      if (body.action === "analysis") return answer({ analysis_status: "done", analysis: ANALYSIS });
      if (body.action === "assets") return answer({ assets_status: "done", assets: { assets: LEVELED.assets }, assets_brief: row.assets_brief || [] });
      if (body.action === "answer") return answer({ graded_level: 50, grade_confidence: 0.8, grade_rationale: "fine" });
      if (body.action === "topics_done") { row = { ...row, assessment: ASSESSMENT, step: 7 }; return answer({ assessment: ASSESSMENT }); }
      if (body.action === "leveled") return answer({ leveled_status: "done", leveled: LEVELED, assets_status: "done" });
      if (body.action === "brainstorm") return answer(body.text || body.answers || body.pick || body.again
        ? { turn_id: "t2", say: "Good. Angles it is.", card: "none", interest: "the geometry of poses", leveled_status: row.leveled_status, ready: row.leveled_status === "done" }
        : { turn_id: "t1", say: "", card: "questions", leveled_status: row.leveled_status,
            questions: { eyebrow: "first", items: [{ id: "drew", type: "mcq", title: "What drew you?", options: [{ label: "The dancing" }, { label: "The math", why: "w" }] }] } });
      if (body.action === "asset_ask") return answer({ answer: "Start with the toy.", turn_id: "a1" });
      if (body.action === "choose_asset") { row = { ...row, asset_chosen: { key: body.key, title: body.key.split(" :: ").pop() }, step: 9 }; return answer({ asset_chosen: row.asset_chosen }); }
      if (body.action === "direction") { const d = body.revise ? { ...DIRECTION, title: "Pose to angles, live" } : DIRECTION; row = { ...row, direction: d }; return answer({ direction: d }); }
      if (body.action === "subgoals") { row = { ...row, subgoals: SUBGOALS }; return answer({ subgoals: SUBGOALS }); }
      if (body.action === "todos") return answer({ todos: ["do a", "do b"], name: "zebra-runner" });
      if (body.action === "ask") return answer({ answer: "Because.", level: "some" });
      if (body.action === "create") return answer({ ok: true, pending_setup_id: "p" });
    }
    if (url === "/api/engelbart-device") return answer({ code: "ABCD-EFGH-IJKL", expiresInSeconds: 900 });
    if (url === "/api/engelbart-setup") {
      if (body.action === "own_paper") {
        return answer({ id: PAPER, token: "tok", title: "paper",
          upload: { uploadUrl: "https://x.supabase.co/storage/v1/object/upload/sign/papers/p", anonKey: "anon" } });
      }
      if (body.action === "own_paper_saved") return answer({ saved: true });
    }
    if (/supabase\.co/.test(url)) return answer({});           // the PDF's PUT to Storage
    return Promise.reject(new Error(`unrouted ${url}`));
  }

  const win = makeEl("window");
  win.location = { href: "", search: options.search || "" };
  win.confirm = () => true;
  win.supabase = { createClient: () => ({ auth: {
    onAuthStateChange() {},
    getSession: () => Promise.resolve({ data: { session: { access_token: "jwt" } } }),
  } }) };

  // Timers that do not hold the process open: a test may end on a step whose
  // keyboard is still animating, or whose poll has not fired yet.
  const loose = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; };
  const doc = makeEl("document");
  doc.getElementById = (id) => (id === "app" ? app : (find(app, (n) => n.id === id || n.attrs.id === id)[0] || null));
  doc.createElement = makeEl;
  const sandbox = { window: win, fetch: fetchStub, setTimeout, clearTimeout, setInterval: loose, clearInterval, console, URL,
    navigator: {}, document: doc };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(INSTALL, sandbox, { filename: "engelbart/setup/install.js" });
  vm.runInNewContext(SRC, sandbox, { filename: "engelbart/setup/setup.js" });

  return { app, actions, bodies, win, doc,
    row: () => row,
    title: () => textOf(one(app, "ob-title")) || textOf(one(app, "ob-question")) || textOf(one(app, "ob-goal-title"))
      || textOf(one(app, "ob-done-t")) || textOf(one(app, "ob-wait-t")),
    error: () => textOf(one(app, "ob-err")),
    cta: () => byClass(app, "ob-cta").pop(),
    input: () => find(app, (n) => n.tagName === "input" || n.tagName === "textarea")[0],
  };
}

// --- what a reader sees -------------------------------------------------------

test("every step draws from the record, and none of them throws", async () => {
  const titles = ["What is your name?", "What year are you?", "What is your major?",
    "How technical should explanations be?", "Which paper are you building on?", "Which computer are you on?",
    "How familiar are you with the paper's concepts?", "What do you want to build?",
    "What do you want to build on?", "Pose to angles", "Pose to angles", "Pose to angles"];
  for (let step = 0; step < titles.length; step += 1) {
    const page = mount({ row: fullRow({ step }), turns: [{ role: "assistant", content: "Hello.", card: { card: "none" } }] });
    await settle();
    assert.equal(page.title(), titles[step], `step ${step}`);
  }
  const done = mount({ row: fullRow({ step: 12, status: "created" }) });
  await settle();
  assert.match(textOf(done.app), /Open a new Claude chat on your machine/);
});

test("the walk from Name to Install writes every step as it goes, and fires the reading and the hunt", async () => {
  const page = mount();
  await settle();

  assert.equal(page.title(), "What is your name?");
  const name = page.input();
  name.value = "Ada"; name.fire("input");
  assert.equal(page.cta().disabled, false, "Continue is live once a name is typed");
  page.cta().fire("click");
  await settle();

  assert.equal(page.title(), "What year are you?");
  byClass(page.app, "ob-opt")[1].fire("click");
  await afterThePause();

  assert.equal(page.title(), "What is your major?");
  byClass(page.app, "ob-seed")[0].fire("click");
  await afterThePause();

  assert.equal(page.title(), "How technical should explanations be?");
  byClass(page.app, "ob-stop")[2].fire("click");
  await settle();
  page.cta().fire("click");
  await settle();

  assert.equal(page.title(), "Which paper are you building on?");
  const chooser = one(page.app, "ob-hide");
  chooser.files = [{ name: "paper.pdf", type: "application/pdf", size: 1024 * 1024 }];
  chooser.fire("change");
  await settle();
  assert.equal(textOf(one(page.app, "ob-file-name")), "paper");
  assert.equal(textOf(one(page.app, "ob-file-meta")), "PDF · 1.0 MB");
  page.cta().fire("click");
  await settle();

  assert.equal(page.title(), "Which computer are you on?", "the install step follows the paper");
  assert.deepEqual(page.actions, ["open", "step", "step", "step", "step",
    "own_paper", "own_paper_saved", "sources", "analysis", "assets", "step", "issue"]);
  assert.equal(page.row().name, "Ada");
  assert.equal(page.row().year, "Second year");
  assert.equal(page.row().depth, "technical");
  assert.equal(page.row().step, 5);
  // Through the module: macOS, Apple Silicon, two steps, then done.
  byClass(page.app, "ob-opt")[0].fire("click");
  byClass(page.app, "ob-opt")[0].fire("click");
  page.cta().fire("click");
  assert.match(textOf(page.app), /--code ABCD-EFGH-IJKL --no-open/, "the connect command carries the issued code");
  assert.doesNotMatch(textOf(page.app), /claude\.ai\/install/, "no separate Claude Code command: the installer brings it");
  page.cta().fire("click");
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "How familiar are you with the paper's concepts?");
  assert.equal(page.row().step, 6);
});

// ⏎ is Continue. A reader who has just clicked an option should not have to
// find the button; a reader typing in a box keeps the box's own ⏎.
test("Enter presses the step's button unless a text box has it", async () => {
  const page = mount({ row: fullRow({ step: 0, name: "Ada" }) });
  await settle();
  assert.equal(page.title(), "What is your name?");
  page.doc.fire("keydown", { key: "Enter", target: byClass(page.app, "ob-step")[0] });
  await settle();
  assert.equal(page.row().step, 1, "⏎ with focus outside a text box pressed Continue");
  assert.equal(page.title(), "What year are you?");

  const major = mount({ row: fullRow({ step: 2, major: "" }) });
  await settle();
  const before = major.actions.length;
  major.doc.fire("keydown", { key: "Enter", target: major.input() });
  await settle();
  assert.equal(major.actions.length, before, "⏎ inside a text box is left to the box");
  major.doc.fire("keydown", { key: "Enter", shiftKey: true, target: byClass(major.app, "ob-step")[0] });
  await settle();
  assert.equal(major.actions.length, before, "a modified ⏎ is not Continue");
  major.doc.fire("keydown", { key: "Enter", target: byClass(major.app, "ob-step")[0] });
  await settle();
  assert.equal(major.actions.length, before, "a disabled Continue stays unpressed");
});

// The two halves of the paper step: accepting it is awaited, reading it is not.
test("an accepted paper starts the reading and moves on without waiting for it", async () => {
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const page = mount({
    row: fullRow({ step: 4, analysis: null, analysis_status: "none", paper_title: "" }),
    replies: { analysis: () => held.then(() => ({ ok: true, status: 200, json: () => Promise.resolve({ analysis_status: "done", analysis: ANALYSIS }) })) },
  });
  await settle();
  assert.equal(page.title(), "Which paper are you building on?");
  page.cta().fire("click");
  await settle();

  // The reading has not answered yet, and the reader is already a step on.
  assert.equal(page.title(), "Which computer are you on?");
  assert.deepEqual(page.actions, ["open", "sources", "analysis", "assets", "step", "issue"]);
  assert.equal(page.bodies.find((b) => b.action === "analysis").run, true);
  assert.equal(page.bodies.find((b) => b.action === "sources").paper_id, PAPER);
  assert.equal(page.bodies.find((b) => b.action === "sources").paper_familiarity, 2);
  assert.ok(one(page.app, "ob-reading"), "the rail says the paper is being read");

  release();
  await settle();
  assert.equal(one(page.app, "ob-reading"), undefined, "and stops saying so once it is");
});

test("a refused paper keeps the reader on the paper step, with the reason", async () => {
  const page = mount({
    row: fullRow({ step: 4, analysis: null, analysis_status: "none" }),
    refuse: { sources: { status: 403, error: "That paper is not yours to analyse" } },
  });
  await settle();
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "Which paper are you building on?");
  assert.equal(page.error(), "That paper is not yours to analyse");
  assert.deepEqual(page.actions, ["open", "sources"], "nothing was read and no step was written");
  assert.equal(page.cta().disabled, false, "and they can try again");
});

test("an upload the server will not sign is reported, not swallowed", async () => {
  const page = mount({ row: fullRow({ step: 4, paper_id: null, analysis: null, analysis_status: "none" }),
    replies: { own_paper: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: PAPER }) }) } });
  await settle();
  const chooser = one(page.app, "ob-hide");
  chooser.files = [{ name: "paper.pdf", type: "application/pdf", size: 1024 }];
  chooser.fire("change");
  await settle();
  assert.equal(page.error(), "the server did not offer an upload");
  assert.ok(one(page.app, "ob-drop"), "and the chooser is back");
});

test("a session that has expired sends the reader to sign in, not to an error", async () => {
  const page = mount({ refuse: { step: { status: 401, error: "Sign in first" } } });
  await settle();
  const name = page.input();
  name.value = "Ada"; name.fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(page.win.location.href, "/engelbart/signin");
});

// --- the two controls that used to fight the redraw ---------------------------

test("the slider paints itself while it is dragged and only commits on release", async () => {
  const page = mount({ row: fullRow({ step: 3 }) });
  await settle();
  const track = one(page.app, "ob-track");
  track.fire("pointerdown", { clientX: 40, pointerId: 1 });
  page.win.fire("pointermove", { clientX: 280 });
  assert.equal(track.attrs["data-drag"], "1");
  assert.equal(one(page.app, "ob-track"), track, "the element under the finger survives the move");
  assert.equal(one(page.app, "ob-thumb").style.left, "70.00%");
  assert.equal(textOf(one(page.app, "ob-slider-name")), "Technical");
  assert.equal(page.actions.length, 1, "a drag writes nothing");

  // The release lands on the window: a finger that left the track still lets go.
  page.win.fire("pointerup", {});
  await settle();
  assert.equal(one(page.app, "ob-thumb").style.left, "75.00%", "and snaps to the stop");
  assert.equal(one(page.app, "ob-track").attrs["data-drag"], "0");
  assert.equal(textOf(one(page.app, "ob-hint")), "You can change this later.");
  page.cta().fire("click");
  await settle();
  assert.equal(page.row().depth, "technical");
});

test("typing a major narrows the seeds without replacing the field", async () => {
  const page = mount({ row: fullRow({ step: 2, major: "" }) });
  await settle();
  const field = page.input();
  assert.equal(byClass(page.app, "ob-seed").length, 6);
  field.value = "cog"; field.fire("input");
  assert.equal(page.input(), field, "the field the caret is in is the field that stays");
  assert.deepEqual(byClass(page.app, "ob-seed").map(textOf), ["Cognitive Science"]);
  assert.equal(page.cta().disabled, false);
  field.value = ""; field.fire("input");
  assert.equal(byClass(page.app, "ob-seed").length, 6, "and they come back");
  assert.equal(page.cta().disabled, true);
});

// --- the second half: topics, details, focus, todos, done -----------------------

test("topics are answered one area at a time, a disagreeing grade asks once more, and samples never show", async () => {
  let calls = 0;
  const page = mount({
    row: fullRow({ step: 6, assessment: null, leveled_status: "none", leveled: null, todos: null, goal_chosen: "" }),
    replies: { answer: () => { calls += 1; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
      calls === 1 ? { graded_level: 25, grade_rationale: "recognises only", follow_up: { question_level: 25, question: "You said weights: weights of what?", generated: true },
                     calibrations: [{ id: "c1", area_index: 0, question_level: 0, answered_at: "2026-09-03T00:00:00Z", graded_level: 25 },
                       { id: "c2", area_index: 0, question_level: 25, question: "You said weights: weights of what?", sample_response: "SAMPLE-F", answered_at: null, self_level: 0 }] }
                 : { graded_level: 50, calibrations: [{ id: "c" + calls, area_index: calls === 2 ? 0 : 1, question_level: calls === 2 ? 25 : 0, answered_at: "2026-09-03T00:01:00Z", graded_level: 50 }] }) }); } },
  });
  await settle();
  assert.equal(page.title(), "How familiar are you with the paper's concepts?");
  assert.equal(textOf(one(page.app, "ob-q")), "A question at 0");
  assert.doesNotMatch(page.app.textContent, /SAMPLE-/, "sample answers stay unseen");
  const answerBox = () => find(page.app, (n) => n.tagName === "textarea" && n.placeholder === "one sentence is enough…")[0];
  answerBox().value = "attention weights"; answerBox().fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(textOf(one(page.app, "ob-q")), "You said weights: weights of what?", "the follow-up is the generated question, not the ladder's");
  assert.equal(one(page.app, "ob-grade"), undefined, "and the grade itself is never shown");
  assert.doesNotMatch(textOf(page.app), /can follow it/);
  assert.doesNotMatch(page.app.textContent, /SAMPLE-/, "the follow-up's sample stays unseen too");
  assert.equal(one(page.app, "ob-slider").attrs["data-locked"], "1", "the slider is locked while the follow-up waits");
  answerBox().value = "it weights inputs"; answerBox().fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(textOf(one(page.app, "ob-area-name")), "B", "after the follow-up the next area is up");
  assert.deepEqual(page.bodies.filter((b) => b.action === "answer").map((b) => [b.area_index, b.question_level]), [[0, 0], [0, 25]]);
  answerBox().value = "tensors"; answerBox().fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build?", "the last area compiles the assessment and opens the brainstorm");
  assert.deepEqual(page.actions.slice(-4), ["answer", "topics_done", "leveled", "brainstorm"]);
  assert.equal(page.bodies.find((b) => b.action === "leveled").run, true);
});

test("a follow-up is a stored row: it survives a reload, the slider cannot move it, and the next area is untouched", async () => {
  const page = mount({
    row: fullRow({ step: 6, assessment: null }),
    calibrations: [{ id: "c1", area_index: 0, question_level: 50, answered_at: "2026-09-03T00:00:00Z", graded_level: 25, self_level: 50 },
      { id: "c2", area_index: 0, question_level: 25, question: "From what you said: which part is learned?", answered_at: null, self_level: 50 }],
    replies: { answer: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
      { graded_level: 25, calibrations: [{ id: "c2", area_index: 0, question_level: 25, question: "From what you said: which part is learned?", answered_at: "2026-09-03T00:02:00Z", graded_level: 25 }] }) }) },
  });
  await settle();
  assert.equal(textOf(one(page.app, "ob-q")), "From what you said: which part is learned?", "the waiting follow-up is what a reload shows");
  assert.match(textOf(one(page.app, "ob-q-label")), /One more/);
  const slider = one(page.app, "ob-slider");
  assert.equal(slider.attrs["data-locked"], "1");
  byClass(page.app, "ob-track")[0].fire("pointerdown", { clientX: 300, pointerId: 1 });
  page.win.fire("pointerup", {});
  await settle();
  assert.equal(textOf(one(page.app, "ob-q")), "From what you said: which part is learned?", "the slider does not swap the question");
  // Walking to the next area and back finds the same follow-up waiting.
  byClass(page.app, "ob-pdot")[1].fire("click");
  assert.equal(textOf(one(page.app, "ob-area-name")), "B");
  assert.equal(one(page.app, "ob-slider").attrs["data-locked"], undefined, "the next area's slider is free");
  byClass(page.app, "ob-pdot")[0].fire("click");
  assert.equal(textOf(one(page.app, "ob-q")), "From what you said: which part is learned?");
  const answerBox = find(page.app, (n) => n.tagName === "textarea" && n.placeholder === "one sentence is enough…")[0];
  answerBox.value = "the weights"; answerBox.fire("input");
  page.cta().fire("click");
  await settle();
  const sent = page.bodies.filter((b) => b.action === "answer").pop();
  assert.deepEqual([sent.area_index, sent.question_level, sent.self_level], [0, 25, 50], "answered at the follow-up's level, with the rating that produced it");
  assert.equal(textOf(one(page.app, "ob-area-name")), "B", "and the next area is up");
});

test("the brainstorm opens on the card, keeps answered cards as cards, and offers the plan only when the model says ready", async () => {
  const page = mount({ row: fullRow({ step: 7, leveled_status: "running", leveled: null }) });
  await settle();
  assert.equal(page.title(), "What do you want to build?");
  assert.equal(page.actions.filter((a) => a === "brainstorm").length, 1, "the opening turn is asked for once");
  assert.equal(page.bodies.find((b) => b.action === "brainstorm").text, undefined);
  assert.equal(byClass(page.app, "ob-bs-turn").length, 0, "no prose before the opening card");
  assert.match(textOf(page.app), /What drew you\?/);
  assert.equal(find(page.app, (n) => n.tagName === "textarea").length, 0, "no free-text composer: the card is the conversation");
  assert.equal(one(page.app, "ob-bs-offer"), undefined, "no plan offer while the resources are being fitted");
  byClass(page.app, "ob-goal")[1].fire("click");
  assert.equal(byClass(page.app, "ob-goal")[1].attrs["data-on"], "1", "the pick is marked");
  page.cta().fire("click");
  await settle();
  const sent = page.bodies.filter((b) => b.action === "brainstorm")[1];
  assert.deepEqual(sent.answers, { drew: "The math" });
  // The answered card stays a card, with the answer marked; not a flattened line.
  const done = byClass(page.app, "ob-bs-card").filter((c) => c.attrs["data-done"] === "1");
  assert.equal(done.length, 1);
  assert.equal(byClass(done[0], "ob-goal").find((g) => g.attrs["data-on"] === "1").textContent, "The mathw");
  assert.equal(byClass(done[0], "ob-cta").length, 0, "an answered card has no buttons");
  assert.doesNotMatch(textOf(page.app), /What drew you\? The math/, "the answer is not repeated as prose");
  assert.match(textOf(page.app), /Angles it is/);
  assert.equal(one(page.app, "ob-bs-offer"), undefined, "the model was not asked about readiness yet");
  assert.equal(textOf(page.cta()), "Go on›", "a prose-only turn gets a way to continue");
  // The fitting finishes; the next turn carries the model's verdict.
  page.row().leveled_status = "done"; page.row().leveled = LEVELED;
  page.cta().fire("click");
  await settle();
  assert.equal(page.bodies.filter((b) => b.action === "brainstorm").pop().again, true);
  assert.ok(one(page.app, "ob-bs-offer"), "ready to plan is offered when the model said ready");
  byClass(page.app, "ob-ghost").find((b) => textOf(b) === "Keep brainstorming").fire("click");
  assert.equal(one(page.app, "ob-bs-offer"), undefined);
  page.cta().fire("click");
  await settle();
  assert.ok(one(page.app, "ob-bs-offer"), "and offered again after the next turn");
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build on?");
});

test("the main column keeps its scroll across redraws, a sent turn scrolls to the thinking row, and Skip goes to the resources once they are ready", async () => {
  const page = mount({ row: fullRow({ step: 7, leveled_status: "done", leveled: LEVELED }) });
  await settle();
  one(page.app, "ob-main").scrollTop = 300;
  byClass(page.app, "ob-goal")[0].fire("click");                       // redraws in place
  assert.equal(one(page.app, "ob-main").scrollTop, 300, "the pane did not jump back to the top");
  assert.equal(textOf(byClass(page.app, "ob-ghost").find((b) => /Skip/.test(textOf(b)))), "Skip to resources");
  byClass(page.app, "ob-ghost").find((b) => /Skip/.test(textOf(b))).fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build on?", "skipping with the resources ready is choosing to plan");
  assert.equal(page.bodies.filter((b) => b.action === "brainstorm").length, 1, "no extra turn was asked for");

  const early = mount({ row: fullRow({ step: 7, leveled_status: "running", leveled: null }) });
  await settle();
  assert.equal(textOf(byClass(early.app, "ob-ghost").find((b) => /Skip/.test(textOf(b)))), "Skip");
  byClass(early.app, "ob-ghost").find((b) => /Skip/.test(textOf(b))).fire("click");
  assert.ok(one(early.app, "ob-bs-turn") && find(early.app, (n) => n.attrs["data-thinking"] === "1")[0], "the thinking row is marked for the scroll");
  await settle();
  assert.equal(early.bodies.filter((b) => b.action === "brainstorm").pop().text, "(skipped those)");
});

test("clicking a block offers Ask about this in the gutter, and the button opens the ask panel on that text", async () => {
  const page = mount({ row: fullRow({ step: 7, leveled_status: "done", leveled: LEVELED }) });
  await settle();
  const option = byClass(page.app, "ob-goal")[1];
  page.doc.fire("click", { target: option });                          // capture: the document sees it first
  option.fire("click", { target: option });                            // then the option's own handler redraws
  await settle();
  const btn = one(page.app, "ob-askbtn");
  assert.ok(btn, "a gutter button appeared");
  assert.equal(btn.attrs["data-gutter"], "1");
  assert.equal(byClass(page.app, "ob-goal")[1].attrs["data-on"], "1", "the click still picked the option");
  btn.fire("click");
  page.doc.fire("click", { target: btn });
  await settle();
  assert.ok(one(page.app, "ob-ask"), "the ask panel opened");
  assert.equal(textOf(one(page.app, "ob-ask-quote")), "“The math w”", "the block's words, spaced, not its glyphs");
  // A click on empty space puts the button away.
  const fresh = mount({ row: fullRow({ step: 7, leveled_status: "done", leveled: LEVELED }) });
  await settle();
  fresh.doc.fire("click", { target: byClass(fresh.app, "ob-goal")[0] });
  await settle();
  assert.ok(one(fresh.app, "ob-askbtn"));
  fresh.doc.fire("click", { target: one(fresh.app, "ob-main") });
  await settle();
  assert.equal(one(fresh.app, "ob-askbtn"), undefined);
});

test("a reloaded brainstorm redraws every answered card with its answers, from the stored user turns", async () => {
  const page = mount({
    row: fullRow({ step: 7, leveled_status: "done", leveled: LEVELED }),
    turns: [
      { id: "t1", role: "assistant", content: "", card: { card: "questions", questions: { eyebrow: "first", items: [
        { id: "drew", type: "mcq", title: "What drew you?", options: [{ label: "The dancing" }, { label: "The math" }] },
        { id: "why", type: "free", title: "Why?" }] } } },
      { id: "u1", role: "user", content: "What drew you? The math\nWhy? I like angles", card: { answers: { drew: "The math", why: "I like angles" } } },
      { id: "t2", role: "assistant", content: "Angles it is.", card: { card: "focus", focus: { title: "Which?", options: [{ label: "Angles" }, { label: "Timing" }] }, ready: false } },
    ],
  });
  await settle();
  const cards = byClass(page.app, "ob-bs-card");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].attrs["data-done"], "1");
  assert.equal(byClass(cards[0], "ob-goal").find((g) => g.attrs["data-on"] === "1").textContent, "The math");
  assert.equal(textOf(one(cards[0], "ob-bs-said")), "I like angles", "a typed answer is shown in place");
  assert.equal(cards[1].attrs["data-done"], "0", "the last card is live");
  assert.equal(one(page.app, "ob-bs-offer"), undefined, "ready was false");
  assert.equal(page.actions.filter((a) => a === "brainstorm").length, 0, "nothing was asked: the transcript was enough");
});

test("the assets list expands, asks, and a child can be picked; the pick resets the plan", async () => {
  const page = mount({ row: fullRow({ step: 8, asset_chosen: null, direction: null, subgoals: null, todos: null }) });
  await settle();
  const rows = byClass(page.app, "ob-as-row");
  assert.equal(rows.length, 3, "two assets and one child");
  assert.deepEqual(byClass(page.app, "ob-as-title").map(textOf), ["Pose viewer", "Toy poses", "Dance corpus"]);
  assert.match(textOf(rows[1]), /at your level[\s\S]*small first/);
  assert.equal(page.cta().disabled, true, "nothing picked yet");
  byClass(page.app, "ob-as-caret")[0].fire("click");
  assert.match(textOf(page.app), /What you can do with it · play/);
  assert.equal(find(page.app, (n) => n.tagName === "a")[0].href, "https://x.org/demo");
  byClass(page.app, "ob-as-chatbtn")[0].fire("click");
  byClass(page.app, "ob-seed")[0].fire("click");
  await settle();
  assert.equal(page.bodies.find((b) => b.action === "asset_ask").key, "Pose viewer");
  assert.match(textOf(page.app), /Start with the toy/);
  byClass(page.app, "ob-as-head")[1].fire("click");
  assert.match(textOf(one(page.app, "ob-hint")), /building on · Toy poses/);
  page.cta().fire("click");
  await settle();
  assert.equal(page.bodies.find((b) => b.action === "choose_asset").key, "Pose viewer :: Toy poses");
  assert.equal(page.title(), "Pose to angles", "the direction is generated and shown");
  assert.equal(page.actions.filter((a) => a === "direction").length, 1);
});

test("direction and subgoals are one proposal each; a change request revises in place; todos come for the first piece", async () => {
  const page = mount({ row: fullRow({ step: 9, direction: null, subgoals: null, todos: null, project_name: "" }) });
  await settle();
  assert.equal(page.title(), "Pose to angles");
  assert.match(textOf(page.app), /First thing you'd see · one labelled skeleton/);
  byClass(page.app, "ob-ghost").find((b) => textOf(b) === "Change something").fire("click");
  const box = find(page.app, (n) => n.tagName === "input" && /smaller, closer/.test(n.placeholder))[0];
  box.value = "make it live"; box.fire("input");
  box.fire("keydown", { key: "Enter" });
  await settle();
  assert.equal(page.bodies.filter((b) => b.action === "direction")[1].revise, "make it live");
  assert.equal(page.title(), "Pose to angles, live");
  page.cta().fire("click");
  await settle();
  assert.deepEqual(byClass(page.app, "ob-sg-label").map(textOf), ["One pose drawn", "Angles computed", "A sequence compared"]);
  assert.match(textOf(page.app), /todos are written for this one/);
  page.cta().fire("click");
  await settle();
  const rows = find(page.app, (n) => n.tagName === "input" && n.placeholder !== "add a todo…" && n.placeholder !== "project name…");
  assert.equal(rows.length, 2);
  assert.match(textOf(page.app), /First piece[\s\S]*One pose drawn/);
  const nameBox = find(page.app, (n) => n.placeholder === "project name…")[0];
  assert.equal(nameBox.value, "zebra-runner");
  const create = one(page.app, "ob-pill");
  assert.equal(create.disabled, false);
  create.fire("click");
  await settle();
  const made = page.bodies.find((b) => b.action === "create");
  assert.deepEqual(made.todos, ["do a", "do b"]);
  assert.equal(made.goal_chosen, undefined, "the direction is the goal; the page does not name it");
  assert.match(textOf(page.app), /zebra-runner is saved/);
  // The last screen: the same keyboard walk, now to a new chat and /bart.
  byClass(page.app, "ob-opt")[0].fire("click");
  byClass(page.app, "ob-opt")[0].fire("click");
  page.cta().fire("click");
  assert.match(textOf(page.app), /claude/);
  page.cta().fire("click");
  assert.match(textOf(page.app), /\/bart/, "and the last screen walks them to /bart");
});

// --- a redraw within a step is not an arrival ------------------------------------

test("only a change of step replays the entry animation; a pick or a slider release holds it", async () => {
  const page = mount({ row: fullRow({ step: 3 }) });
  await settle();
  assert.equal(page.app.attrs["data-still"], "0", "arriving on the step animates");
  byClass(page.app, "ob-stop")[1].fire("click");
  assert.equal(page.app.attrs["data-still"], "1", "a slider release redraws in place");
  assert.equal(textOf(one(page.app, "ob-slider-name")), "Some detail");
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "Which paper are you building on?");
  assert.equal(page.app.attrs["data-still"], "0", "the next step animates in");
  const year = mount({ row: fullRow({ step: 1, year: "" }) });
  await settle();
  byClass(year.app, "ob-opt")[4].fire("click");
  assert.equal(year.app.attrs["data-still"], "1", "toggling Something else redraws in place");
});

// --- the profile is asked once ----------------------------------------------------

test("a second setup starts at the paper and counts six steps from there", async () => {
  const page = mount({ profileReused: true, row: fullRow({ step: 4, paper_id: null, analysis: null, analysis_status: "none" }) });
  await settle();
  assert.equal(page.title(), "Which paper are you building on?");
  assert.equal(textOf(one(page.app, "ob-count")), "Step 1 of 8");
  assert.deepEqual(byClass(page.app, "ob-label").map(textOf), ["Paper", "Install", "Topics", "Brainstorm", "Assets", "Direction", "Subgoals", "Todos"]);
  assert.equal(textOf(one(page.app, "ob-caption")), "Setting up another project");
  assert.equal(textOf(one(page.app, "ob-profile-line")), "Ada · First year · Physics · Some detail");
  // The way back to the four answers, for the member whose situation changed.
  one(page.app, "ob-profile").children.find((n) => n.tagName === "button").fire("click");
  assert.equal(page.title(), "What is your name?");
  assert.equal(textOf(one(page.app, "ob-count")), "Step 1 of 12");
  assert.equal(byClass(page.app, "ob-label").length, 12);
});

test("a first setup still counts twelve", async () => {
  const page = mount({ row: fullRow({ step: 4 }) });
  await settle();
  assert.equal(textOf(one(page.app, "ob-count")), "Step 5 of 12");
  assert.equal(byClass(page.app, "ob-label").length, 12);
  assert.equal(one(page.app, "ob-profile"), undefined);
});

// --- test mode ------------------------------------------------------------------

test("?test=true makes every step clickable and offers the two clears", async () => {
  const page = mount({ search: "?test=true", row: fullRow({ step: 2 }) });
  await settle();
  assert.equal(page.app.attrs["data-test"], "1");
  const rows = byClass(page.app, "ob-row");
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((r) => r.attrs["data-reach"]), ["1", "1", "0", "1", "1", "1", "1", "1", "1", "1", "1", "1"], "all but the active step answer a click");
  rows[8].fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build on?", "a step ahead of the record opens");
  assert.deepEqual(byClass(page.app, "ob-test").length, 1);
  const buttons = byClass(one(page.app, "ob-test"), "ob-ghost");
  assert.deepEqual(buttons.map(textOf), ["Clear this project", "Clear everything"]);
  buttons[1].fire("click");
  await settle();
  assert.equal(page.bodies.find((b) => b.action === "reset").scope, "all");
  assert.equal(page.title(), "What is your name?", "and the page redraws from the fresh record");
  assert.equal(page.input().value, "");
});

test("without ?test the rail only reaches back", async () => {
  const page = mount({ row: fullRow({ step: 2 }) });
  await settle();
  assert.equal(page.app.attrs["data-test"], "0");
  assert.equal(one(page.app, "ob-test"), undefined);
  const rows = byClass(page.app, "ob-row");
  assert.deepEqual(rows.map((r) => r.attrs["data-reach"]), ["1", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"]);
});
