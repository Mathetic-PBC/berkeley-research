"use strict";

// The Install and Done steps, run. install.js is plain DOM under the same CSP
// as setup.js, so it mounts on the hand-rolled document from
// setup-page-smoke.test.js and is driven by firing the listeners it set.
// What is pinned: which screen is up, which command a reader is given for
// their OS, which callbacks the buttons reach, and that no animation outlives
// the screen that started it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "install.js"), "utf8");

// --- the smallest document install.js can be drawn on -------------------------

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
  };
  Object.defineProperty(node, "textContent", {
    get() { return node._text != null ? node._text : node.children.map((c) => c.textContent).join(""); },
    set(value) { node.children = []; node._text = String(value); },
  });
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
function optionTexts(app) { return byClass(app, "ob-opt-text").map(textOf); }
function pick(app, label) { const row = byClass(app, "ob-opt").find((r) => textOf(one(r, "ob-opt-text")) === label); assert.ok(row, `option ${label}`); row.fire("click"); }
function back(app) { const b = one(app, "ob-arrow"); assert.ok(b, "a back arrow"); b.fire("click"); }
function cta(app) { const b = byClass(app, "ob-cta").pop(); assert.ok(b, "a primary button"); return b; }
function cmds(app) { return byClass(app, "ob-cmd-text").map(textOf); }

// Mounts the module on a fresh document with counted intervals, so a test can
// tell how many animations are still running.
function mount(options = {}) {
  const win = makeEl("window");
  const timers = { live: new Set(), next: 1 };
  const sandbox = {
    window: win, console, setTimeout, clearTimeout, navigator: options.navigator || {},
    setInterval: () => { const id = timers.next++; timers.live.add(id); return id; },
    clearInterval: (id) => { timers.live.delete(id); },
    document: { createElement: makeEl },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, sandbox, { filename: "engelbart/setup/install.js" });
  const app = makeEl("div");
  return { app, api: win.EngelbartInstall, timers, render: (opts) => win.EngelbartInstall.render(app, opts) };
}

const CODE = "ABCD-EFGH-IJKL";
const walk = (page, os, arch, opts = {}) => {
  page.render({ variant: "install", code: CODE, expiresInSeconds: 900, ...opts });
  pick(page.app, os); pick(page.app, arch);
};

// --- what a reader sees -------------------------------------------------------

test("the OS picker offers macOS, Windows and Linux, and each OS its two chips", () => {
  const page = mount();
  page.render({ variant: "install", code: CODE });
  assert.equal(textOf(one(page.app, "ob-title")), "Which computer are you on?");
  assert.deepEqual(optionTexts(page.app), ["macOS", "Windows", "Linux"]);

  pick(page.app, "macOS");
  assert.equal(textOf(one(page.app, "ob-title")), "Which Mac?");
  assert.deepEqual(optionTexts(page.app), ["Apple Silicon", "Intel"]);

  back(page.app); pick(page.app, "Windows");
  assert.deepEqual(optionTexts(page.app), ["x64", "ARM"]);
  back(page.app); pick(page.app, "Linux");
  assert.deepEqual(optionTexts(page.app), ["x64", "ARM64"]);
});

test("a Mac walks terminal, Claude Code, then the connect command with the code and --no-open", () => {
  const page = mount();
  walk(page, "macOS", "Apple Silicon");
  assert.equal(textOf(one(page.app, "ob-title")), "Open a terminal");
  assert.match(textOf(one(page.app, "ob-sub")), /⌘ Space.*Terminal.*⏎/);
  assert.equal(byClass(page.app, "ob-pdot").length, 3);
  assert.ok(byClass(page.app, "ob-ins-key").length > 30, "a keyboard of keys");

  cta(page.app).fire("click");
  assert.equal(textOf(one(page.app, "ob-title")), "Install Claude Code");
  assert.deepEqual(cmds(page.app), ["curl -fsSL https://claude.ai/install.sh | bash"]);

  cta(page.app).fire("click");
  assert.equal(textOf(one(page.app, "ob-title")), "Install Engelbart and connect this account");
  assert.deepEqual(cmds(page.app), ["curl -fsSL https://berkeley.mathetic.com/engelbart/install.sh | sh -s -- --code " + CODE + " --no-open"]);
  assert.match(textOf(one(page.app, "ob-hint")), /works once and expires in 15 minutes/);
});

test("Windows is given the PowerShell installers", () => {
  const page = mount();
  walk(page, "Windows", "x64");
  assert.match(textOf(one(page.app, "ob-sub")), /⊞.*PowerShell/);
  cta(page.app).fire("click");
  assert.deepEqual(cmds(page.app), ["irm https://claude.ai/install.ps1 | iex"]);
  cta(page.app).fire("click");
  assert.deepEqual(cmds(page.app), ["& ([scriptblock]::Create((irm https://berkeley.mathetic.com/engelbart/install.ps1))) --code " + CODE + " --no-open"]);
});

test("Linux opens the terminal with Ctrl Alt T and pastes with Ctrl Shift V", () => {
  const page = mount();
  walk(page, "Linux", "ARM64");
  assert.equal(textOf(one(page.app, "ob-sub")), "Press Ctrl Alt T.");
  cta(page.app).fire("click");
  const lit = () => byClass(page.app, "ob-ins-key").filter((k) => k.attrs["data-on"] === "1").map((k) => k.attrs["data-key"]).sort();
  assert.deepEqual(lit(), ["ctrl", "shift", "v"], "the first frame is the paste chord");
});

test("Back walks steps, then the chip, then the OS", () => {
  const page = mount();
  walk(page, "macOS", "Intel");
  cta(page.app).fire("click"); cta(page.app).fire("click");
  assert.equal(textOf(one(page.app, "ob-title")), "Install Engelbart and connect this account");
  back(page.app);
  assert.equal(textOf(one(page.app, "ob-title")), "Install Claude Code");
  back(page.app);
  assert.equal(textOf(one(page.app, "ob-title")), "Open a terminal");
  back(page.app);
  assert.equal(textOf(one(page.app, "ob-title")), "Which Mac?");
  assert.equal(byClass(page.app, "ob-opt").find((r) => r.attrs["data-on"] === "1").textContent, "Intel2020 and earlier");
  back(page.app);
  assert.equal(textOf(one(page.app, "ob-title")), "Which computer are you on?");
});

test("the final screen's button reaches onDone, and Get a new code reaches onNewCode", () => {
  const page = mount();
  let done = 0, fresh = 0;
  walk(page, "macOS", "Apple Silicon", { onDone: () => { done += 1; }, onNewCode: () => { fresh += 1; } });
  cta(page.app).fire("click"); cta(page.app).fire("click");
  const again = byClass(page.app, "ob-ghost").find((b) => textOf(b) === "Get a new code");
  assert.ok(again, "a Get a new code button"); again.fire("click");
  assert.equal(fresh, 1);

  cta(page.app).fire("click");
  assert.equal(textOf(one(page.app, "ob-done-t")), "Engelbart is connected.");
  assert.equal(textOf(cta(page.app)), "I've run it›");   // label and arrow spans; the gap is CSS
  cta(page.app).fire("click");
  assert.equal(done, 1);
});

test("the bart variant runs claude, then /bart, then Done", () => {
  const page = mount();
  let done = 0;
  page.render({ variant: "bart", os: "windows", arch: "arm64", onDone: () => { done += 1; } });
  assert.equal(textOf(one(page.app, "ob-title")), "Open a new terminal");
  cta(page.app).fire("click");
  assert.deepEqual(cmds(page.app), ["claude"]);
  cta(page.app).fire("click");
  assert.deepEqual(cmds(page.app), ["/bart"]);
  assert.match(textOf(one(page.app, "ob-sub")), /picks up the project you just set up/);
  cta(page.app).fire("click");
  assert.equal(textOf(cta(page.app)), "Done›");
  cta(page.app).fire("click");
  assert.equal(done, 1);
});

test("Copy writes the command and says so for a moment", async () => {
  const written = [];
  const page = mount({ navigator: { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } } });
  walk(page, "Linux", "x64");
  cta(page.app).fire("click");
  const copy = one(page.app, "ob-cmd-copy");
  assert.equal(textOf(copy), "Copy");
  copy.fire("click");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(written, ["curl -fsSL https://claude.ai/install.sh | bash"]);
  assert.equal(textOf(copy), "Copied");
  await new Promise((r) => setTimeout(r, 1450));
  assert.equal(textOf(copy), "Copy");

  const bare = mount();
  walk(bare, "Linux", "x64"); cta(bare.app).fire("click");
  one(bare.app, "ob-cmd-copy").fire("click");   // no clipboard: nothing happens, nothing throws
  assert.equal(textOf(one(bare.app, "ob-cmd-copy")), "Copy");
});

test("rendering again replaces the screen and stops the old animation; stop() clears the last one", () => {
  const page = mount();
  page.render({ variant: "install", code: CODE, os: "mac", arch: "arm64" });
  assert.equal(page.timers.live.size, 1, "one animation on a step");
  page.render({ variant: "bart", os: "linux", arch: "x64" });
  assert.equal(page.timers.live.size, 1, "the first animation was cleared");
  assert.equal(page.app.children.length, 1, "one screen in the container");
  assert.equal(textOf(one(page.app, "ob-sub")), "Press Ctrl Alt T.");

  cta(page.app).fire("click"); cta(page.app).fire("click"); cta(page.app).fire("click");
  assert.equal(page.timers.live.size, 0, "the final screen has no keyboard, so no timer");

  page.render({ variant: "install", code: CODE, os: "mac", arch: "arm64" });
  assert.equal(page.timers.live.size, 1);
  page.api.stop(page.app);
  assert.equal(page.timers.live.size, 0);
  page.render({ variant: "install", code: CODE });
  assert.equal(page.timers.live.size, 0, "the picker animates nothing");
});

test("a bad stored pick falls back to the picker; a good one skips it", () => {
  const page = mount();
  page.render({ variant: "install", code: CODE, os: "amiga" });
  assert.equal(textOf(one(page.app, "ob-title")), "Which computer are you on?");
  page.render({ variant: "install", code: CODE, os: "mac" });
  assert.equal(textOf(one(page.app, "ob-title")), "Which Mac?");
  assert.deepEqual(page.api.commands("mac", "X").engelbart, "curl -fsSL https://berkeley.mathetic.com/engelbart/install.sh | sh -s -- --code X --no-open");
});
