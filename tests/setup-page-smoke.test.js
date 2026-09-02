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
    querySelector(selector) {
      assert.equal(selector, "[autofocus]", "the stub only knows the autofocus lookup");
      let hit = null;
      (function walk(n) { if (hit) return; if (n.hasAttribute && n.hasAttribute("autofocus")) { hit = n; return; } (n.children || []).forEach(walk); })(node);
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

// A row far enough along that any step can be drawn from it.
function fullRow(extra) {
  return { step: 0, name: "Ada", year: "First year", major: "Physics", depth: "some",
    paper_id: PAPER, paper_title: "Zebra Tuning", paper_familiarity: 2, project_draft: "a thing",
    analysis: ANALYSIS, analysis_status: "done", details: DETAILS,
    goal_chosen: "a goal", todos: ["one", "two"], ...extra };
}

// Mounts the page. `replies` overrides one action's answer; `refuse` makes one
// action fail with a status and a message, the way the endpoint does.
function mount(options = {}) {
  const app = makeEl("div");
  const actions = [];
  const bodies = [];
  let row = { step: 0, status: "open", analysis_status: "none", ...options.row };
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
      if (body.action === "open") return answer({ onboarding: row, calibrations: [] });
      if (body.action === "step") { row = { ...row, ...body.fields, step: body.step }; return answer({ onboarding: row }); }
      if (body.action === "sources") return answer({ ok: true, analysis_status: "none" });
      if (body.action === "analysis") return answer({ analysis_status: "done", analysis: ANALYSIS });
      if (body.action === "answer") return answer({ graded_level: 50, grade_confidence: 0.8, grade_rationale: "fine" });
      if (body.action === "details") return answer(DETAILS);
      if (body.action === "goals") return answer(GOALS);
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
  win.location = { href: "" };
  win.supabase = { createClient: () => ({ auth: {
    onAuthStateChange() {},
    getSession: () => Promise.resolve({ data: { session: { access_token: "jwt" } } }),
  } }) };

  const sandbox = { window: win, fetch: fetchStub, setTimeout, clearTimeout, setInterval, clearInterval, console, URL,
    navigator: {}, document: { getElementById: () => app, createElement: makeEl } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, sandbox, { filename: "engelbart/setup/setup.js" });

  return { app, actions, bodies, win,
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
    "How technical should explanations be?", "Which paper are you building on?", "What's your project?",
    "How familiar are you with what the paper leans on?", "Who is it for?", "What should the first project be about?", "a goal"];
  for (let step = 0; step < titles.length; step += 1) {
    const page = mount({ row: fullRow({ step }) });
    await settle();
    assert.equal(page.title(), titles[step], `step ${step}`);
  }
  const done = mount({ row: fullRow({ step: 9, status: "created" }) });
  await settle();
  assert.equal(done.title(), "Your project is made");
});

test("the walk from Name to Project writes every step as it goes", async () => {
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

  assert.equal(page.title(), "What's your project?");
  const draft = page.input();
  draft.value = "a tool that reads a paper"; draft.fire("input");
  page.cta().fire("click");
  await settle();

  assert.equal(page.title(), "How familiar are you with what the paper leans on?");
  assert.deepEqual(page.actions, ["open", "step", "step", "step", "step",
    "own_paper", "own_paper_saved", "sources", "analysis", "step", "step"]);
  assert.equal(page.row().name, "Ada");
  assert.equal(page.row().year, "Second year");
  assert.equal(page.row().depth, "technical");
  assert.equal(page.row().project_draft, "a tool that reads a paper");
  assert.equal(page.row().step, 6);
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
  assert.equal(page.title(), "What's your project?");
  assert.deepEqual(page.actions, ["open", "sources", "analysis", "step"]);
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
    row: fullRow({ step: 6, details: null, goals: null, todos: null, goal_chosen: "" }),
    replies: { answer: () => { calls += 1; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
      calls === 1 ? { graded_level: 25, grade_rationale: "recognises only", follow_up: { question_level: 25, question: "A question at 25" } }
                 : { graded_level: 50 }) }); } },
  });
  await settle();
  assert.equal(page.title(), "How familiar are you with what the paper leans on?");
  assert.equal(textOf(one(page.app, "ob-q")), "A question at 0");
  assert.doesNotMatch(page.app.textContent, /SAMPLE-/, "sample answers stay unseen");
  const answerBox = () => find(page.app, (n) => n.tagName === "input" && n.placeholder === "one sentence is enough…")[0];
  answerBox().value = "attention weights"; answerBox().fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(textOf(one(page.app, "ob-q")), "A question at 25", "the follow-up is asked at the graded level");
  assert.match(textOf(one(page.app, "ob-grade")), /can follow it/);
  answerBox().value = "it weights inputs"; answerBox().fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(textOf(one(page.app, "ob-area-name")), "B", "after the follow-up the next area is up");
  assert.deepEqual(page.bodies.filter((b) => b.action === "answer").map((b) => [b.area_index, b.question_level]), [[0, 0], [0, 25]]);
  answerBox().value = "tensors"; answerBox().fire("input");
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "Who is it for?", "the last area leads to the details questions");
  assert.equal(page.actions.filter((a) => a === "details").length, 1);
});

test("details, focus, todos and done reach the install code", async () => {
  const page = mount({ row: fullRow({ step: 7, goals: null, todos: null, goal_chosen: "", project_name: "" }) });
  await settle();
  assert.equal(page.title(), "Who is it for?");
  byClass(page.app, "ob-opt")[0].fire("click");
  await settle();
  page.cta().fire("click");
  await settle();
  assert.equal(page.title(), "What should the first project be about?");
  assert.equal(page.bodies.find((b) => b.action === "step" && b.fields.details_answers).fields.details_answers.who, "Just me");
  byClass(page.app, "ob-goal")[1].fire("click");
  await settle();
  page.cta().fire("click");
  await settle();
  assert.equal(page.bodies.find((b) => b.action === "todos").goal, "Goal 2");
  assert.equal(page.title(), "Goal 2");
  const rows = find(page.app, (n) => n.tagName === "input" && n.placeholder !== "add a todo…" && n.placeholder !== "project name…");
  assert.equal(rows.length, 2);
  const nameBox = find(page.app, (n) => n.placeholder === "project name…")[0];
  assert.equal(nameBox.value, "zebra-runner");
  const create = one(page.app, "ob-pill");
  assert.equal(create.disabled, false);
  create.fire("click");
  await settle();
  assert.equal(page.title(), "zebra-runner is made");
  assert.match(textOf(one(page.app, "ob-cmd-text")), /^bunx engelbart-cli --code ABCD-EFGH-IJKL$/);
  const made = page.bodies.find((b) => b.action === "create");
  assert.deepEqual(made.todos, ["do a", "do b"]);
  assert.equal(made.goal_chosen, "Goal 2");
});
