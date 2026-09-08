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
// The bracket behind the mock-up comparison ships beside the page, and
// index.html loads it the same way.
const TOURNAMENT = fs.readFileSync(path.join(ROOT, "engelbart", "mockups", "tournament.js"), "utf8");

// --- the smallest document setup.js can be drawn on ---------------------------

function makeEl(tag) {
  const node = {
    tagName: tag, children: [], attrs: {}, listeners: {}, style: {}, _text: null, parentNode: null,
    appendChild(child) { node._text = null; node.children.push(child); child.parentNode = node; return child; },
    removeChild(child) { node.children = node.children.filter(c => c !== child); child.parentNode = null; return child; },
    setAttribute(key, value) { node.attrs[key] = String(value); },
    getAttribute(key) { return key in node.attrs ? node.attrs[key] : null; },
    removeAttribute(key) { delete node.attrs[key]; },
    hasAttribute(key) { return key in node.attrs; },
    addEventListener(name, fn) { (node.listeners[name] = node.listeners[name] || []).push(fn); },
    removeEventListener(name, fn) { node.listeners[name] = (node.listeners[name] || []).filter((f) => f !== fn); },
    fire(name, event) { (node.listeners[name] || []).slice().forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, ...event })); },
    focus() { node.focused = true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 56 }; },
    click() { node.fire("click", { target: node }); },
    querySelectorAll(selector) {
      assert.equal(selector, ".ob-cta", "the stub only knows the primary-button lookup");
      return byClass(node, "ob-cta");
    },
    contains(other) { for (let n=other;n;n=n.parentNode) if(n===node) return true; return false; },
    closest(selector) { for(let n=node;n;n=n.parentNode) if(selector === "[data-askbtn]" && n.hasAttribute("data-askbtn")) return n; return null; },
    querySelector(selector) {
      if (selector.startsWith(".")) return one(node, selector.slice(1)) || null;
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
  const mockSaves = [];
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
    if (String(url).indexOf("/api/engelbart-mockups") === 0) {
      if (options.mockupsFail) return answer({ error: "the mock-ups are not available" }, 503);
      const have = options.mockups || [];
      if (body) {
        mockSaves.push(body);
        if (options.mockupsSaveFail) return answer({ error: "the placing could not be saved" }, 503);
        return answer({ saved: { entrants: body.entrants, updated_at: "2026-09-08T00:00:00.000Z",
          top: body.top.map((t, i) => ({ rank: i + 1, id: t.id, name: (have.find((m) => m.id === t.id) || {}).name || t.id })) } });
      }
      return answer({ mockups: have, saved: options.mockupSaved || null });
    }
    if (body && body.action === "plan") {
      const planned = { ...body, action: body.kind };
      const response = replies.plan ? replies.plan(body) : fetchStub(url, { ...init, body: JSON.stringify(planned) });
      return Promise.resolve(response).then(async r => ({ ...r, json: async () => ({ status: "complete", ...await r.json() }) }));
    }
    if (body) { actions.push(body.action); bodies.push(body); }
    if (body && refuse[body.action]) {
      const no = refuse[body.action];
      return answer({ error: no.error }, no.status);
    }
    if (body && replies[body.action]) return replies[body.action](body);
    if (url === "/api/engelbart-onboarding") {
      if (body.action === "open") return answer({ onboarding: row, calibrations: options.calibrations || [], turns, profile_reused: Boolean(options.profileReused), own_key: options.ownKey || { set: false } });
      if (body.action === "reset") { row = { step: 0, status: "open", analysis_status: "none" }; return answer({ onboarding: row, calibrations: [], profile_reused: false }); }
      if (body.action === "step") { row = { ...row, ...body.fields, step: body.step }; return answer({ onboarding: row }); }
      if (body.action === "sources") return answer({ ok: true, analysis_status: "none" });
      if (body.action === "paper_grounding") return answer({grounding_status:"done",grounding:{contribution:"Pose geometry",evidence:[{kind:"method",claim:"Compare angles",quote:"Compare angles",location:"Methods"}]}});
      if (body.action === "analysis") return answer({ analysis_status: "done", analysis: ANALYSIS });
      if (body.action === "assets") return answer({ assets_status: "done", assets: { assets: LEVELED.assets }, assets_brief: row.assets_brief || [] });
      if (body.action === "answer") return answer({ graded_level: 50, grade_confidence: 0.8, grade_rationale: "fine" });
      if (body.action === "topics_done") { row = { ...row, assessment: ASSESSMENT, step: 9 }; return answer({ assessment: ASSESSMENT }); }
      if (body.action === "leveled") return answer({ leveled_status: "done", leveled: LEVELED, assets_status: "done" });
      if (body.action === "brainstorm") return answer(body.text || body.answers || body.pick || body.again
        ? { turn_id: "t2", say: "Good. Angles it is.", card: "none", interest: "the geometry of poses", leveled_status: row.leveled_status, ready: true }
        : { turn_id: "t1", say: "", card: "questions", leveled_status: row.leveled_status,
            questions: { eyebrow: "first", items: [{ id: "drew", type: "mcq", title: "What drew you?", options: [{ label: "The dancing" }, { label: "The math", why: "w" }] }] } });
      if (body.action === "asset_ask") return answer({ answer: "Start with the toy.", turn_id: "a1" });
      if (body.action === "choose_asset") { row = { ...row, asset_chosen: { key: body.key, title: body.key.split(" :: ").pop() }, step: 10 }; return answer({ asset_chosen: row.asset_chosen }); }
      if (body.action === "paper_grounding") return answer({ grounding: {} });
      if (body.action === "direction") { const d = body.revise ? { ...DIRECTION, title: "Pose to angles, live" } : DIRECTION; row = { ...row, direction: d }; return answer({ direction: d }); }
      if (body.action === "subgoals") { row = { ...row, subgoals: SUBGOALS }; return answer({ subgoals: SUBGOALS }); }
      if (body.action === "todos") return answer({ todos: ["do a", "do b"], name: "zebra-runner" });
      if (body.action === "ask") return answer({ answer: "Because.", level: "some" });
      if (body.action === "rewrite") { row = { ...row, depth: body.to }; return answer({ texts: body.texts.map((t) => "★ " + t), level: body.to }); }
      if (body.action === "create") return answer({ ok: true, pending_setup_id: "p" });
    }
    if (url === "/api/engelbart-device") return answer({ code: "ABCD-EFGH-IJKL", expiresInSeconds: 900 });
    if (url === "/api/engelbart-setup") {
      if (body.action === "own_paper") {
        return answer({ id: PAPER, token: "tok", title: "paper",
          upload: { uploadUrl: "https://x.supabase.co/storage/v1/object/upload/sign/papers/p", anonKey: "anon" } });
      }
      if (body.action === "own_paper_saved") return answer({ saved: true });
      if (body.action === "own_key") return answer({ set: true, last4: String(body.key).slice(-4) });
      if (body.action === "own_key_clear") return answer({ set: false });
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
  const loose = (fn, ms) => { if (options.captureIntervals) { options.captureIntervals.push(fn); return { unref() {} }; } const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; };
  const doc = makeEl("document");
  doc.getElementById = (id) => (id === "app" ? app : (find(app, (n) => n.id === id || n.attrs.id === id)[0] || null));
  doc.createElement = makeEl;
  const sandbox = { window: win, fetch: fetchStub, setTimeout: (fn, ms) => { const t=setTimeout(fn,ms); if(ms>=1500) t.unref(); return t; }, clearTimeout, setInterval: loose, clearInterval, console, URL,
    navigator: {}, document: doc };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(TOURNAMENT, sandbox, { filename: "engelbart/mockups/tournament.js" });
  vm.runInNewContext(INSTALL, sandbox, { filename: "engelbart/setup/install.js" });
  vm.runInNewContext(SRC, sandbox, { filename: "engelbart/setup/setup.js" });

  return { app, actions, bodies, mockSaves, win, doc,
    row: () => row,
    title: () => textOf(one(app, "ob-title")) || textOf(one(app, "ob-as-h1")) || textOf(one(app, "ob-question")) || textOf(one(app, "ob-goal-title"))
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
    "Which of these two is better?", "What do you want to build?", "How familiar are you with the paper's concepts?",
    "Select which resource to start with", "Pose to angles", "Pose to angles", "One pose drawn"];
  for (let step = 0; step < titles.length; step += 1) {
    const page = mount({ row: fullRow({ step }), mockups: MOCKUPS,
      turns: [{ role: "assistant", content: "Hello.", card: { card: "none" } }] });
    await settle();
    assert.equal(page.title(), titles[step], `step ${step}`);
  }
  const done = mount({ row: fullRow({ step: 13, status: "created" }) });
  await settle();
  assert.doesNotMatch(textOf(done.app), /Open a new Claude chat|written for/, "the done screen carries no summary sentence");
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
    "own_paper", "own_paper_saved", "sources", "analysis", "assets", "step", "brainstorm", "paper_grounding", "issue"]);
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
  // Install writes step 6, the mock-ups; the bucket is empty here, so the step
  // takes itself out of the way and writes the brainstorm behind it.
  assert.equal(page.row().step, 7);
  assert.doesNotMatch(textOf(page.app), /Two things you can do on every screen/);
  assert.equal(page.title(), "What do you want to build?");
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

test("Ask about this is persistent only on steps 6 through 11; Explanations keeps its slider", async () => {
  for (const step of [3,4,5,6,7,8,9,10,11,12]) {
    const page=mount({row:fullRow({step,status:step===12 ? "created" : "open"}),turns:[{role:"assistant",content:"Ready",card:{card:"none",ready:true}}]});
    await settle();
    assert.equal(!!one(page.app,"ob-ask-open"),step>=6 && step<=11);
    assert.equal(page.app.attrs["data-askable"],step>=6 && step<=11 ? "1" : "0");
    assert.equal(one(page.app,"ob-reg"),undefined);
    if(step===3) assert.ok(one(page.app,"ob-slider"));
    assert.equal(page.actions.includes("rewrite"),false);
  }
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
  assert.equal(page.bodies.filter(b=>b.action==="paper_grounding" && b.run).length,1,"Analysis completion starts grounding while still on Install");
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
  assert.equal(page.actions.filter(a => a !== "brainstorm" && a !== "paper_grounding").length, 1, "a drag writes nothing");

  // The release lands on the window: a finger that left the track still lets go.
  page.win.fire("pointerup", {});
  await settle();
  assert.equal(one(page.app, "ob-thumb").style.left, "75.00%", "and snaps to the stop");
  assert.equal(one(page.app, "ob-track").attrs["data-drag"], "0");
  assert.equal(textOf(one(page.app, "ob-hint")), "", "no hint once they have moved it");
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
    row: fullRow({ step: 8, assessment: null, leveled_status: "none", leveled: null, todos: null, goal_chosen: "" }),
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
  assert.equal(page.title(), "Select which resource to start with", "the last area compiles the assessment and opens resources");
  assert.deepEqual(page.actions.slice(-4), ["answer", "answer", "topics_done", "leveled"]);
  assert.equal(page.bodies.find((b) => b.action === "leveled").run, true);
});

test("a follow-up is a stored row: it survives a reload, the slider cannot move it, and the next area is untouched", async () => {
  const page = mount({
    row: fullRow({ step: 8, assessment: null }),
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
  assert.ok(one(page.app, "ob-bs-offer"), "human readiness ends the questions while resources load");
  assert.doesNotMatch(textOf(page.app), /Keep brainstorming|Go on/);
  page.cta().fire("click");
  await settle();
  assert.equal(page.row().step, 8, "Topics follows Brainstorm");
  assert.equal(page.actions.filter((a) => a === "brainstorm").length, 2, "no filler model call");

});

test("the main column keeps its scroll across redraws, a sent turn scrolls to the thinking row, and Skip goes to Topics regardless of resource readiness", async () => {
  const page = mount({ row: fullRow({ step: 7, leveled_status: "done", leveled: LEVELED }) });
  await settle();
  one(page.app, "ob-main").scrollTop = 300;
  byClass(page.app, "ob-goal")[0].fire("click");                       // redraws in place
  assert.equal(one(page.app, "ob-main").scrollTop, 300, "the pane did not jump back to the top");
  assert.equal(textOf(byClass(page.app, "ob-ghost").find((b) => /Skip/.test(textOf(b)))), "Skip to Topics");
  byClass(page.app, "ob-ghost").find((b) => /Skip/.test(textOf(b))).fire("click");
  await settle();
  assert.equal(page.title(), "How familiar are you with the paper's concepts?", "skipping Brainstorm still goes through Topics");
  assert.equal(page.bodies.filter((b) => b.action === "brainstorm").length, 1, "no extra turn was asked for");

  const early = mount({ row: fullRow({ step: 7, leveled_status: "running", leveled: null }) });
  await settle();
  assert.equal(textOf(byClass(early.app, "ob-ghost").find((b) => /Skip/.test(textOf(b)))), "Skip to Topics");
  byClass(early.app, "ob-ghost").find((b) => /Skip/.test(textOf(b))).fire("click");
  await settle();
  assert.equal(early.row().step, 8);
  assert.equal(early.bodies.filter((b) => b.action === "brainstorm").length, 1, "skipping never asks filler questions");
});

async function highlight(page, text) {
  const content=page.doc.getElementById("content");
  page.win.getSelection=()=>({toString:()=>text,rangeCount:1,anchorNode:content.children[0],focusNode:content.children[0]});
  page.doc.fire("mouseup",{target:content.children[0]});
  await settle();
}
function openRemembered(page) {
  const button=one(page.app,"ob-ask-open");
  page.win.getSelection=()=>({toString:()=>"",rangeCount:0});
  page.doc.fire("mouseup",{target:button});
  button.fire("click");
}
test("the empty modal has only Cancel and dismisses by Escape or scrim, not the card",async()=>{
  const page=mount({row:fullRow({step:8})}); await settle();
  one(page.app,"ob-ask-open").fire("click");
  assert.match(textOf(one(page.app,"ob-modal")),/Highlight a sentence in the step first/);
  assert.equal(one(page.app,"ob-ask-row"),undefined);
  assert.equal(one(page.app,"ob-ask-quick"),undefined);
  assert.equal(textOf(one(one(page.app,"ob-modal"),"ob-tiny")),"Cancel");
  let stopped=false;
  one(page.app,"ob-modal").fire("click",{stopPropagation(){stopped=true;}});
  assert.equal(stopped,true); assert.ok(one(page.app,"ob-modal"));
  page.doc.fire("keydown",{key:"Escape"});
  assert.equal(one(page.app,"ob-modal"),undefined);
  one(page.app,"ob-ask-open").fire("click");
  page.doc.fire("keydown",{key:"Enter",target:page.app});
  assert.ok(one(page.app,"ob-modal"),"Enter must not advance the underlying step");
  one(page.app,"ob-scrim").fire("click");
  assert.equal(one(page.app,"ob-modal"),undefined);
});
test("the remembered quote survives button mouseup; answers and follow-ups stay in the modal",async()=>{
  let release;
  const page=mount({row:fullRow({step:8,depth:"some"}),replies:{ask:()=>new Promise(resolve=>{release=resolve;})}});
  await settle(); await highlight(page,"A highlighted mechanism");
  openRemembered(page); await settle();
  assert.equal(textOf(one(page.app,"ob-ask-quote")),"“A highlighted mechanism”");
  assert.equal(one(page.app,"ob-askbtn"),undefined);
  one(page.app,"ob-seed").fire("click");
  assert.ok(one(one(page.app,"ob-modal"),"ob-ask-think"));
  page.doc.fire("keydown",{key:"Escape"});
  assert.ok(one(page.app,"ob-modal"),"do not discard a pending exchange");
  release({ok:true,json:async()=>({answer:"It transforms the input.",level:"some"})}); await settle();
  assert.match(textOf(one(one(page.app,"ob-modal"),"ob-ask-turn")),/It transforms the input/);
  assert.ok(one(page.app,"ob-ask-row"));
  assert.equal(textOf(one(one(page.app,"ob-ask-cancel"),"ob-tiny")),"Done");
  assert.match(textOf(one(page.app,"ob-asked")),/It transforms the input/);
  const input=find(one(page.app,"ob-modal"),n=>n.tagName==="input")[0];
  input.value="Why that input?";input.fire("input");one(one(page.app,"ob-modal"),"ob-pill").fire("click");
  release({ok:true,json:async()=>({answer:"It isolates one variable.",level:"some"})}); await settle();
  assert.equal(byClass(one(page.app,"ob-modal"),"ob-ask-turn").length,2);
  const simpler=byClass(one(page.app,"ob-ask-turn"),"ob-tiny").find(n=>textOf(n)==="simpler");
  simpler.fire("click");
  assert.equal(page.bodies.filter(b=>b.action==="ask").pop().level,"everyday");
  release({ok:true,json:async()=>({answer:"One thing changes.",level:"everyday"})}); await settle();
  assert.match(textOf(one(page.app,"ob-ask-turn")),/One thing changes/);
  one(one(page.app,"ob-ask-turn"),"ob-ask-rm").fire("click");
  assert.equal(byClass(one(page.app,"ob-modal"),"ob-ask-turn").length,1);
  one(one(page.app,"ob-ask-cancel"),"ob-tiny").fire("click");
  assert.equal(one(page.app,"ob-modal"),undefined);
  assert.ok(one(page.app,"ob-asked"));
  assert.equal(page.row().depth,"some","re-asking does not change the Explanations preference");
});
test("plain clicks and short or outside selections do not supply a quote",async()=>{
  const page=mount({row:fullRow({step:8})});await settle();
  await highlight(page,"ok");openRemembered(page);
  assert.ok(one(page.app,"ob-ask-empty"));
  one(page.app,"ob-scrim").fire("click");
  page.win.getSelection=()=>({toString:()=>"Outside the step",rangeCount:1,anchorNode:page.app});
  page.doc.fire("mouseup",{target:page.app});await settle();
  one(page.app,"ob-ask-open").fire("click");
  assert.ok(one(page.app,"ob-ask-empty"));
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

test("the assets list folds simpler stand-ins behind a toggle; picking a row shows what it is; the pick resets the plan", async () => {
  const page = mount({ row: fullRow({ step: 9, asset_chosen: null, direction: null, subgoals: null, todos: null }) });
  await settle();
  assert.equal(page.title(), "Select which resource to start with");
  assert.deepEqual(byClass(page.app, "ob-as-title").map(textOf), ["Pose viewer", "Toy poses", "Dance corpus"], "the first resource starts expanded");
  assert.equal(textOf(one(page.app, "ob-as-toggle")), "1 simpler⌃");
  assert.equal(page.cta().disabled, true, "nothing picked yet");
  assert.match(textOf(one(page.app, "ob-as-desc")), /A viewer/, "the first resource is described without selecting it");
  one(page.app, "ob-as-toggle").fire("click");
  assert.deepEqual(byClass(page.app, "ob-as-title").map(textOf), ["Pose viewer", "Dance corpus"], "the default expansion can be closed");
  one(page.app, "ob-as-toggle").fire("click");
  assert.deepEqual(byClass(page.app, "ob-as-title").map(textOf), ["Pose viewer", "Toy poses", "Dance corpus"]);
  assert.match(textOf(byClass(page.app, "ob-as-row")[1]), /simpler/);
  byClass(page.app, "ob-as-row")[1].fire("click");
  assert.equal(byClass(page.app, "ob-as-row")[1].attrs["data-on"], "1", "the child is picked");
  assert.match(textOf(byClass(page.app, "ob-as-row")[0]), /A viewer\./, "the parent of a picked child shows its text");
  assert.match(textOf(byClass(page.app, "ob-as-row")[1]), /ten poses[\s\S]*small first/, "the picked child shows its line and why");
  assert.equal(find(page.app, (n) => n.tagName === "a")[0].href, "https://x.org/demo");
  assert.equal(byClass(page.app, "ob-as-chatbtn").length, 0, "no per-row chat: Ask about this is the page's");
  assert.equal(page.cta().disabled, false);
  page.cta().fire("click");
  await settle();
  assert.equal(page.bodies.find((b) => b.action === "choose_asset").key, "Pose viewer :: Toy poses");
  assert.equal(page.title(), "Pose to angles", "the direction is generated and shown");
  assert.equal(page.actions.filter((a) => a === "direction").length, 1);
});

test("direction and subgoals are one proposal each; a change request revises in place; todos come for the first piece", async () => {
  const page = mount({ row: fullRow({ step: 10, direction: null, subgoals: null, todos: null, project_name: "" }) });
  await settle();
  assert.equal(page.title(), "Pose to angles");
  assert.match(textOf(page.app), /A page that turns a pose into angles\./, "the direction is its title and what they would make");
  assert.doesNotMatch(textOf(page.app), /First thing you|Why this one/, "and nothing after them");
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
  const rows = find(page.app, (n) => n.tagName === "textarea" && n.parentNode && String(n.parentNode.className).includes("ob-trow"));
  assert.equal(rows.length, 2);
  assert.match(textOf(page.app), /One pose drawn/);
  assert.doesNotMatch(textOf(page.app), /First piece|The other two pieces/);
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
  assert.match(textOf(page.app), /Trust the folder/, "Claude Code's first-run question sits between claude and /bart");
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

test("a second setup starts at the paper and counts nine steps from there", async () => {
  const page = mount({ profileReused: true, row: fullRow({ step: 4, paper_id: null, analysis: null, analysis_status: "none" }) });
  await settle();
  assert.equal(page.title(), "Which paper are you building on?");
  assert.equal(textOf(one(page.app, "ob-count")), "Step 1 of 9");
  assert.deepEqual(byClass(page.app, "ob-label").map(textOf),
    ["Paper", "Install", "Mock-ups", "Brainstorm", "Topics", "Assets", "Direction", "Subgoals", "Todos"]);
  assert.equal(textOf(one(page.app, "ob-caption")), "Setting up another project");
  assert.equal(textOf(one(page.app, "ob-profile-line")), "Ada · First year · Physics · Some detail");
  // The way back to the four answers, for the member whose situation changed.
  one(page.app, "ob-profile").children.find((n) => n.tagName === "button").fire("click");
  assert.equal(page.title(), "What is your name?");
  assert.equal(textOf(one(page.app, "ob-count")), "Step 1 of 13");
  assert.equal(byClass(page.app, "ob-label").length, 13);
});

test("a first setup still counts every step", async () => {
  const page = mount({ row: fullRow({ step: 4 }) });
  await settle();
  assert.equal(textOf(one(page.app, "ob-count")), "Step 5 of 13");
  assert.equal(byClass(page.app, "ob-label").length, 13);
  assert.equal(one(page.app, "ob-profile"), undefined);
});

// --- test mode ------------------------------------------------------------------

test("?test=true makes every step clickable and offers the two clears", async () => {
  const page = mount({ search: "?test=true", row: fullRow({ step: 2 }) });
  await settle();
  assert.equal(page.app.attrs["data-test"], "1");
  const rows = byClass(page.app, "ob-row");
  assert.equal(rows.length, 13);
  assert.deepEqual(rows.map((r) => r.attrs["data-reach"]),
    ["1", "1", "0", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1"], "all but the active step answer a click");
  rows[9].fire("click");
  await settle();
  assert.equal(page.title(), "Select which resource to start with", "a step ahead of the record opens");
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
  assert.deepEqual(rows.map((r) => r.attrs["data-reach"]), ["1", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"]);
});

// --- the member's own Anthropic key --------------------------------------------

const keyBox = (page) => one(page.app, "ob-key");
const keyLine = (page) => textOf(one(keyBox(page), "ob-key-line"));
const keyLink = (page, label) => byClass(keyBox(page), "ob-link").filter((b) => textOf(b) === label)[0];

test("the rail takes the member's own Anthropic key, shows only its tail, and can hand it back", async () => {
  const page = mount({ row: fullRow({ step: 4 }) });
  await settle();
  const title = page.title();
  assert.equal(keyLine(page), "Claude runs on Mathetic credit");
  keyLink(page, "Use your own Anthropic key").click();
  const input = find(keyBox(page), (n) => n.tagName === "input")[0];
  assert.equal(input.type, "password");
  input.value = "  sk-ant-api03-test-key-0123456789abcdef  "; input.fire("input", { target: input });
  one(keyBox(page), "ob-key-save").click();
  await settle();
  const sent = page.bodies.find((b) => b.action === "own_key");
  assert.equal(sent.key, "sk-ant-api03-test-key-0123456789abcdef");
  assert.equal(keyLine(page), "Claude runs on your own Anthropic key (…cdef)");
  assert.equal(find(page.app, (n) => n.tagName === "input" && n.type === "password").length, 0, "the key is gone from the page");
  assert.equal(page.title(), title, "the step on screen is untouched");
  // Remove puts them back on the pool.
  keyLink(page, "Change or remove the key").click();
  keyLink(page, "Remove").click();
  await settle();
  assert.equal(page.bodies.filter((b) => b.action === "own_key_clear").length, 1);
  assert.equal(keyLine(page), "Claude runs on Mathetic credit");
});

test("a key Anthropic refuses is reported beside the field, not as a page error", async () => {
  const page = mount({ row: fullRow({ step: 4 }), refuse: { own_key: { status: 400, error: "Anthropic did not accept that key" } } });
  await settle();
  keyLink(page, "Use your own Anthropic key").click();
  const input = find(keyBox(page), (n) => n.tagName === "input")[0];
  input.value = "sk-ant-api03-bad-key-0123456789abcdef"; input.fire("input", { target: input });
  one(keyBox(page), "ob-key-save").click();
  await settle();
  assert.equal(textOf(one(keyBox(page), "ob-key-err")), "Anthropic did not accept that key");
  assert.equal(page.error(), "");
  assert.equal(find(keyBox(page), (n) => n.tagName === "input")[0].value, "", "the refused key is not kept in the field");
  assert.equal(keyLine(page), "Use your own Anthropic key", "the form stays open for another try");
});

test("a member who arrives with a key sees it named in the rail", async () => {
  const page = mount({ row: fullRow({ step: 4 }), ownKey: { set: true, last4: "9zzz" } });
  await settle();
  assert.equal(keyLine(page), "Claude runs on your own Anthropic key (…9zzz)");
  assert.ok(keyLink(page, "Change or remove the key"));
});

test("reloading an old three-response Brainstorm hides another question even if its stored ready is false", async () => {
  const question = { card: "questions", ready: false, questions: { items: [{ id: "q", type: "free", title: "Another intake question?" }] } };
  const page = mount({ row: fullRow({ step: 7, leveled_status: "running", leveled: null }), turns: [
    { role: "assistant", content: "(asked) Another intake question?", card: question },
    { role: "user", content: "Something visual", card: { text: "Something visual" } },
    { role: "assistant", content: "(asked) Another intake question?", card: question },
    { role: "user", content: "Compare before and after help", card: { text: "Compare before and after help" } },
    { role: "assistant", content: "", card: question },
    { role: "user", content: "Repeated attempts", card: { text: "Repeated attempts" } },
    { role: "assistant", content: "(asked) Another intake question?", card: question },
  ] });
  await settle();
  assert.ok(one(page.app, "ob-bs-offer"));
  assert.doesNotMatch(textOf(page.app), /\(asked\)/, "stored transcript annotations are not shown as prose");
  assert.equal(find(page.app, n => n.tagName === "textarea").length, 0, "no unanswered question composer after the cap");
  assert.equal(page.actions.filter(a => a === "brainstorm").length, 0, "reload does not restart the interview");
});

test('Assets renders persisted access progress and restrictions without a new step',async()=>{
  const pending={assets:[{title:'Real events',type:'dataset',links:[],access:{state:'checking'}}]};
  const timers=[];
  const page=mount({row:fullRow({step:9,leveled_status:'done',leveled:pending}),captureIntervals:timers,
    replies:{leveled:()=>Promise.resolve({ok:true,json:async()=>({leveled_status:'done',leveled:{assets:[{...pending.assets[0],access:{state:'available',format:'csv',size:1200}}]}})})}});
  await settle();
  assert.match(textOf(page.app),/Checking access…/);
  assert.equal(byClass(page.app,'ob-as-row').length,1);
  timers.forEach(fn=>fn()); await settle();
  assert.match(textOf(page.app),/✓ Available/);
  assert.doesNotMatch(textOf(page.app),/Checking access/);
  const restricted=mount({row:fullRow({step:9,leveled_status:'done',leveled:{assets:[{...pending.assets[0],access:{state:'restricted',reason:'Requires author approval'}}]}})});
  await settle();
  byClass(restricted.app,'ob-as-row')[0].click(); await settle();
  assert.match(textOf(restricted.app),/! Restricted/);
  assert.match(textOf(restricted.app),/Requires author approval/);
});

test('a blocked resource direction shows the existing error and does not automatically retry forever',async()=>{
  const page=mount({row:fullRow({step:10,direction:null,asset_chosen:{title:'Restricted records',type:'dataset'}}),
    refuse:{direction:{status:409,error:'This dataset needs a verified alternative'}}});
  await settle(); await settle();
  assert.equal(page.actions.filter(a=>a==='direction').length,1);
  assert.match(textOf(page.app),/Back to Assets/);
  assert.match(textOf(page.app),/verified alternative/);
});


test('Assets shows access fallbacks separately from the restricted original and pedagogical children',async()=>{
  for (const kind of ['authors_example','synthetic_fallback']) {
    const original={title:'Original ICU records',type:'dataset',links:[],access:{state:'restricted',reason:'Requires author approval'}};
    const child={title:kind === 'synthetic_fallback'?'Synthetic stand-in for ICU records':'Authors released subset',type:'dataset',links:[],access:{state:'available'},fallbackOf:{title:original.title,kind,access:original.access}};
    const chosen={...child,key:original.title+' :: '+child.title};
    const page=mount({row:fullRow({step:9,asset_chosen:chosen,leveled_status:'done',leveled:{assets:[{...original,children:[child]}]}})});
    await settle();
    assert.match(textOf(page.app),/! Restricted/);assert.match(textOf(page.app),/✓ Available/);
    assert.match(textOf(page.app),/instead of Original ICU records/);
    assert.equal(textOf(one(page.app,'ob-as-level')),kind === 'synthetic_fallback'?'synthetic':'fallback');
  }
});


test("Direction waits for paper grounding and offers a retry when grounding fails", async () => {
  const page = mount({ row: fullRow({ step: 10, direction: null, asset_chosen: LEVELED.assets[0] }),
    refuse: { direction: { status: 502, error: "Paper grounding failed" } } });
  await settle(); await settle();
  assert.equal(page.actions.filter(a => a === "direction").length, 1);
  assert.match(textOf(page.app), /Paper grounding failed/);
  assert.match(textOf(page.app), /Try again/);
});

test("the browser advances a saved draft through review before showing Direction", async () => {
  let count=0;
  const page=mount({row:fullRow({step:10,direction:null,asset_chosen:LEVELED.assets[0]}),replies:{plan:body=>{
    assert.equal(body.kind,'direction');count++;
    const result=count===1?{status:'pending',stage:'review',message:'Checking the proposal'}:{status:'complete',direction:DIRECTION};
    return Promise.resolve({ok:true,status:200,json:async()=>result});
  }}});
  await settle();await settle();
  assert.equal(count,2);assert.match(textOf(page.app),/Pose to angles/);
});


test("Brainstorm starts before any Topics answers and continues into Topics", async () => {
  const page = mount({row:fullRow({step:7,assessment:null,leveled_status:"none",leveled:null})});
  await settle();
  assert.equal(page.title(),"What do you want to build?");
  assert.equal(page.actions.filter(a=>a==="brainstorm").length,1);
  assert.equal(page.actions.filter(a=>a==="leveled").length,0);
  byClass(page.app,"ob-ghost").find(b=>textOf(b)==="Skip to Topics").fire("click");
  await settle();
  assert.equal(page.title(),"How familiar are you with the paper's concepts?");
  assert.equal(page.row().step,8);
});

test("Topics prewarms once without interrupting input, and Skip Topics opens resources with no assessment",async()=>{
  const page=mount({row:fullRow({step:8,assessment:null,leveled:null,leveled_status:"none"}),
    replies:{topics_done:()=>Promise.resolve({ok:true,json:async()=>({assessment:null})})}});
  await settle();
  assert.equal(page.bodies.filter(b=>b.action==="brainstorm" && b.prewarm).length,1);
  const input=find(page.app,n=>n.tagName === "textarea")[0];
  input.value="A partial draft"; input.fire("input");
  byClass(page.app,"ob-skip")[0].fire("click");
  await settle();
  assert.equal(page.bodies.find(b=>b.action==="topics_done").skip,true);
  assert.equal(page.bodies.filter(b=>b.action==="answer").length,0);
  assert.equal(page.title(),"Select which resource to start with");
  assert.ok(page.bodies.some(b=>b.action==="leveled" && b.run));
  assert.equal(page.bodies.filter(b=>b.action==="brainstorm").length,1);
});

test("a failed background opening waits for explicit retry",async()=>{
  let calls=0;
  const page=mount({row:fullRow({step:7,assessment:null}),replies:{brainstorm:()=> {
    calls++;
    return Promise.resolve({ok:true,json:async()=>({initial_status:"error",initial_error:"Timed out"})});
  }}});
  await settle();
  assert.equal(calls,1);
  assert.match(textOf(page.app),/Timed out/);
  page.cta().fire("click"); await settle();
  assert.equal(calls,2);
  assert.equal(page.bodies.filter(b=>b.action==="brainstorm")[1].retry,true);
});

test("grounding remains non-blocking across Install, Brainstorm, Topics, Skip Topics and Assets",async()=>{
  const page=mount({search:"?test=true",row:fullRow({step:5,assessment:null}),replies:{
    paper_grounding:()=>new Promise(()=>{})
  }});
  await settle();
  assert.equal(page.bodies.filter(b=>b.action==="paper_grounding" && b.run).length,1);
  for(const [step,title] of [[7,"What do you want to build?"],[8,"How familiar are you with the paper's concepts?"]]){
    byClass(page.app,"ob-row")[step].fire("click");await settle();
    assert.equal(page.title(),title);
  }
  one(page.app,"ob-skip").fire("click");await settle();
  assert.equal(page.title(),"Select which resource to start with");
  assert.equal(page.bodies.filter(b=>b.action==="paper_grounding").length,1);
  assert.equal(page.bodies.filter(b=>b.action==="plan").length,0);
});
test("grounding reload joins running work, reuses legacy evidence, and never loops on an error",async()=>{
  for(const status of ["running","error","legacy"]){
    const row=fullRow({step:8,planning:{paper_grounding:{status,error:{message:"Timed out"}}}});
    if(status==="legacy") row.analysis={...ANALYSIS,grounding:{contribution:"Angles",evidence:[{kind:"method",claim:"Compare",quote:"Compare",location:"Methods"}]}};
    const page=mount({row,replies:{paper_grounding:()=>Promise.resolve({ok:true,json:async()=>({grounding_status:status})})}});
    await settle();
    const calls=page.bodies.filter(b=>b.action==="paper_grounding");
    assert.equal(calls.length,status==="running"?1:0);
    if(calls.length) assert.equal(calls[0].run,undefined,"reload polls rather than restarting");
    assert.equal(page.title(),"How familiar are you with the paper's concepts?");
  }
});

test("reopening Direction does not implicitly retry failed grounding; Try again opts in",async()=>{
  const requests=[];
  const page=mount({row:fullRow({step:10,direction:null,planning:{paper_grounding:{status:"error"}}}),replies:{
    plan:body=>{
      requests.push(body);
      return Promise.resolve({ok:true,json:async()=>body.grounding_retry ? {status:"complete",direction:DIRECTION}
        : {status:"error",stage:"grounding",error:{type:"timeout",message:"Reading the paper timed out"}}});
    }
  }});
  await settle();
  assert.equal(requests.length,1);assert.equal(requests[0].grounding_retry,false);
  byClass(page.app,"ob-cta").find(b=>textOf(b).startsWith("Try again")).fire("click");await settle();
  assert.equal(requests.length,2);assert.equal(requests[1].grounding_retry,true);
  assert.equal(page.title(),DIRECTION.title);
});

// --- the mock-up comparison, between Install and Brainstorm ------------------
// Mock-ups: the sixth step, between Install and Brainstorm. Two mock-ups side
// by side, the better one picked, a bracket to four places. What is pinned
// here is that it is a step of its own — numbered in the rail, walked into and
// out of like any other — and that it is never a wall: an empty bucket, one
// mock-up, a failure, or Skip, and it carries itself into the brainstorm.

const MOCKUPS = [
  { id: "m1", name: "01 Rail" }, { id: "m2", name: "02 Stepper" },
  { id: "m3", name: "03 Dark side" }, { id: "m4", name: "04 Terminal" },
];
const AT_MOCKUPS = { row: fullRow({ step: 6 }), turns: [{ role: "assistant", content: "Hello.", card: { card: "none" } }] };
const visibleMockNodes = (page, cls) => byClass(page.app, "ob-mk-pane")
  .filter(p => p.attrs["data-preview"] !== "warm")
  .sort((a,b) => a.attrs["data-side"] === "left" ? -1 : 1)
  .flatMap(p => cls === "iframe" ? find(p, n => n.tagName === "iframe") : byClass(p, cls));
const picks = (page) => visibleMockNodes(page, "ob-mk-pick");
const frames = (page) => visibleMockNodes(page, "iframe");

test("Mock-ups is the sixth step in the rail, and each pick is between two of the bucket's mock-ups", async () => {
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS });
  await settle();

  assert.equal(page.title(), "Which of these two is better?", "the comparison is the step Install leads into");
  assert.match(textOf(page.app), /Semifinal · pick 1 of 4/, "four entrants: two semifinals, third place, final");
  assert.equal(picks(page).length, 2, "two mock-ups, one pick each");

  // Each frame is the endpoint's own page, sandboxed onto an opaque origin.
  const shown = frames(page);
  assert.equal(shown.length, 2);
  for (const f of shown) {
    assert.match(f.attrs.src, /^\/api\/engelbart-mockups\?html=m[1-4]$/);
    assert.equal(f.attrs.sandbox, "allow-scripts allow-popups allow-forms");
    assert.doesNotMatch(f.attrs.sandbox, /allow-same-origin/);
  }
  const names = visibleMockNodes(page, "ob-mk-name").map(textOf);
  assert.equal(new Set(names).size, 2, "a pick is never a mock-up against itself");
  for (const n of names) assert.ok(MOCKUPS.some((m) => m.name === n), `${n} is one of the bucket's, named by the server`);

  // Sixth in the rail, numbered, between Install and Brainstorm.
  const labels = byClass(page.app, "ob-label").map(textOf);
  assert.deepEqual(labels.slice(5, 8), ["Install", "Mock-ups", "Brainstorm"], "it has a place of its own in the rail");
  assert.equal(textOf(byClass(page.app, "ob-circle")[6]), "7", "and a number, counting the profile in");
  assert.match(textOf(page.app), /Step 7 of 13 · Mock-ups/, "the step says which one it is");
});

test("picking through the bracket saves the placing the member chose, then goes on to the brainstorm", async () => {
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS });
  await settle();

  const chosen = [];
  for (let i = 0; i < 4; i += 1) {
    assert.equal(page.title(), "Which of these two is better?", `pick ${i + 1} is still the comparison`);
    chosen.push(textOf(visibleMockNodes(page, "ob-mk-name")[0]));
    picks(page)[0].fire("click");           // always the left one
    await settle();
  }

  assert.equal(page.mockSaves.length, 1, "the placing is written once, at the end");
  const saved = page.mockSaves[0];
  assert.equal(saved.picks.length, 4, "every comparison is kept, in order");
  assert.equal(saved.entrants, 4);
  assert.equal(saved.top.length, 4, "four places");
  assert.equal(new Set(saved.top.map((t) => t.id)).size, 4, "no mock-up placed twice");
  for (const t of saved.top) assert.ok(MOCKUPS.some((m) => m.id === t.id), "a placed mock-up is one of the bucket's");
  for (const p of saved.picks) assert.ok(p.winner === p.a || p.winner === p.b, "a pick's winner is one of its two");

  assert.equal(page.title(), "Your top four", "the placing is shown before moving on");
  const named = saved.top.map((t) => MOCKUPS.find((m) => m.id === t.id).name);
  assert.deepEqual(byClass(page.app, "ob-mk-place-name").map(textOf), named, "the placing is shown in the order it was decided");
  assert.equal(byClass(page.app, "ob-mk-rank").map(textOf).join(""), "1234");

  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build?", "Continue lands on the brainstorm");
  assert.equal(page.mockSaves.length, 1, "moving on writes nothing more");
});

test("Skip carries the step into the brainstorm and writes no placing", async () => {
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS });
  await settle();
  assert.equal(page.title(), "Which of these two is better?");

  byClass(page.app, "ob-ghost").find((b) => textOf(b) === "Skip").fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build?");
  assert.equal(page.row().step, 7, "the step is behind them, so a reload lands on the brainstorm");
  assert.equal(page.mockSaves.length, 0, "a skipped comparison is not a placing");
});

test("with nothing to compare the step carries itself into the brainstorm", async () => {
  for (const [why, options] of [
    ["an empty bucket", {}],
    ["a single mock-up", { mockups: [MOCKUPS[0]] }],
    ["a request that failed", { mockups: MOCKUPS, mockupsFail: true }],
  ]) {
    const page = mount({ ...AT_MOCKUPS, ...options });
    await settle();
    assert.equal(page.title(), "What do you want to build?", `${why}: the brainstorm draws as it always did`);
    assert.equal(frames(page).length, 0, `${why}: nothing is framed`);
    assert.equal(page.mockSaves.length, 0, `${why}: nothing is written`);
    assert.equal(page.row().step, 7, `${why}: and the step is not asked for again`);
  }
});

test("a placing already made is shown back, not asked for again", async () => {
  const saved = { entrants: 4, updated_at: "2026-09-08T00:00:00.000Z",
    top: MOCKUPS.map((m, i) => ({ rank: i + 1, id: m.id, name: m.name })) };
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS, mockupSaved: saved });
  await settle();

  assert.equal(page.title(), "Your top four", "the step shows what they chose last time");
  assert.deepEqual(byClass(page.app, "ob-mk-place-name").map(textOf), MOCKUPS.map((m) => m.name));
  assert.equal(frames(page).length, 0, "and asks for no more picks");

  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build?");
  assert.equal(page.mockSaves.length, 0, "showing a placing writes no placing");
});

test("the step fills the wait while the paper is still being read", async () => {
  const page = mount({ row: fullRow({ step: 6, analysis_status: "running" }), turns: [], mockups: MOCKUPS });
  await settle();
  assert.equal(page.title(), "Which of these two is better?", "it does not wait on the paper");
  assert.match(textOf(page.app), /reading your paper/, "and it says the paper is still being read");
});

test("the arrow keys pick the mock-up on that side, and are left alone once the comparison is done", async () => {
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS });
  await settle();
  const left = textOf(visibleMockNodes(page, "ob-mk-name")[0]);
  const right = textOf(visibleMockNodes(page, "ob-mk-name")[1]);

  page.doc.fire("keydown", { key: "ArrowRight", target: page.app });
  await settle();
  assert.notEqual(textOf(visibleMockNodes(page, "ob-mk-name")[0]), left, "→ picked the right one and moved on");

  page.doc.fire("keydown", { key: "ArrowLeft", target: page.app });
  await settle();
  assert.equal(picks(page).length, 2, "← picked the left one and the bracket went on");

  // A modifier is a chord, not a pick.
  const before = textOf(visibleMockNodes(page, "ob-mk-name")[0]);
  page.doc.fire("keydown", { key: "ArrowLeft", metaKey: true, target: page.app });
  await settle();
  assert.equal(textOf(visibleMockNodes(page, "ob-mk-name")[0]), before, "⌘← is left to the browser");
  assert.ok(right, "both sides were named");
});

test("a placing the server refused is offered again, and can be left behind", async () => {
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS, mockupsSaveFail: true });
  await settle();
  for (let i = 0; i < 4; i += 1) { picks(page)[0].fire("click"); await settle(); }

  assert.equal(page.mockSaves.length, 1, "the placing was attempted");
  assert.equal(page.title(), "Your top four could not be saved", "not a blank step");
  assert.equal(page.error(), "the placing could not be saved", "in the server's own words");

  page.cta().fire("click");                    // Try again
  await settle();
  assert.equal(page.mockSaves.length, 2, "the same placing is written again");
  assert.deepEqual(page.mockSaves[1].top, page.mockSaves[0].top, "and it is the placing they chose");

  byClass(page.app, "ob-ghost").find((b) => textOf(b) === "Continue anyway").fire("click");
  await settle();
  assert.equal(page.title(), "What do you want to build?", "a refused placing never traps the member");
});


test("preview lookahead stays bounded through a sixteen-design bracket", async () => {
  const mockups = Array.from({ length: 16 }, (_, i) => ({ id: "design" + i, name: "Design " + i }));
  const page = mount({ ...AT_MOCKUPS, mockups });
  await settle();
  let rounds = 0;
  while (picks(page).length) {
    const panes = byClass(page.app, "ob-mk-pane");
    assert.ok(panes.length <= 6, "at most six live previews");
    assert.equal(frames(page).length, 2, "exactly two visible choices");
    for (const pane of panes.filter(p => p.attrs["data-preview"] === "warm")) {
      assert.equal(pane.attrs["aria-hidden"], "true");
      assert.ok(pane.hasAttribute("inert"), "preloads are not interactive");
    }
    picks(page)[rounds % 2].fire("click");
    rounds++; await settle();
    assert.ok(rounds <= 16);
  }
  assert.equal(rounds, 16);
  assert.equal(page.title(), "Your top four");
});


test("a saved ranking can be redone without overwriting it until the new bracket finishes", async () => {
  const saved = { top: MOCKUPS.map((m, i) => ({ rank: i + 1, id: m.id, name: m.name })) };
  const page = mount({ ...AT_MOCKUPS, mockups: MOCKUPS, mockupSaved: saved });
  await settle();
  const again = byClass(page.app, "ob-ghost").find(n => textOf(n) === "Rank again");
  assert.ok(again); again.fire("click"); await settle();
  assert.equal(page.title(), "Which of these two is better?");
  assert.match(textOf(page.app), /pick 1 of 4/);
  assert.equal(page.mockSaves.length, 0);
  for (let i = 0; i < 4; i++) { picks(page)[1].fire("click"); await settle(); }
  assert.equal(page.mockSaves.length, 1);
  assert.equal(page.mockSaves[0].picks.length, 4);
  assert.equal(page.title(), "Your top four");
  assert.ok(byClass(page.app, "ob-ghost").some(n => textOf(n) === "Rank again"));
});
