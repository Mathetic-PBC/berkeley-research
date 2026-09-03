"use strict";

// Forgetting a password. The sign-in tab offers a reset; the email's link
// comes back here as a recovery session, and the only thing on screen for
// that session is the new-password form, until it is saved.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const shared = require("../engelbart/shared.js");

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "engelbart", "signin", "index.html"), "utf8");

function classList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) { if (force === undefined ? !values.has(value) : force) values.add(value); else values.delete(value); },
    has(value) { return values.has(value); },
  };
}

function node() {
  return {
    classList: classList(), dataset: {}, disabled: false, listeners: {}, style: {}, textContent: "", value: "",
    addEventListener(name, listener) { this.listeners[name] = listener; },
    querySelector() { return node(); },
    querySelectorAll() { return []; },
  };
}

async function flush() {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Mounts app.js on a stub document with a Supabase client whose auth calls
// are recorded, and whose listener the test can fire.
function signinPage(options = {}) {
  const elements = new Map();
  const auth = { calls: [], listener: null };
  const document = {
    body: { classList: classList() },
    documentElement: { removeAttribute() {}, setAttribute() {} },
    getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
  };
  const session = options.session || null;
  const history = { replaced: [] };
  const window = {
    EngelbartShared: shared,
    history: { replaceState(_s, _t, url) { history.replaced.push(url); } },
    location: { hash: "", pathname: "/engelbart/signin", search: "", origin: "https://berkeley.mathetic.com" },
    supabase: {
      createClient() {
        return { auth: {
          async getSession() { return { data: { session }, error: null }; },
          onAuthStateChange(fn) { auth.listener = fn; },
          async signOut() {},
          async resetPasswordForEmail(email, opts) { auth.calls.push(["reset", email, opts]); return options.resetError ? { error: options.resetError } : { data: {}, error: null }; },
          async updateUser(value) { auth.calls.push(["update", value]); return options.updateError ? { error: options.updateError } : { data: { user: session && session.user }, error: null }; },
        } };
      },
    },
  };
  async function fetch(url) {
    if (url === "/api/engelbart-config") return { ok: true, async json() { return { creditsEnabled: false }; } };
    throw new Error(`Unexpected request: ${url}`);
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "engelbart", "app.js"), "utf8"),
    { document, fetch, setTimeout, URLSearchParams, window });
  // Objects made inside the vm have another realm's prototypes; strict
  // deep-equal wants plain ones.
  const el = (id) => document.getElementById(id);
  const calls = () => JSON.parse(JSON.stringify(auth.calls));
  return { el, auth, calls, history, hidden: (id) => el(id).classList.has("hidden") };
}

test("the sign-in form offers a reset, and the reset form asks only for the email", () => {
  assert.match(page, /id="forgot-password"/);
  assert.match(page, /id="reset-view" class="hidden"/);
  assert.match(page, /id="reset-email"[^>]*type="email"/);
  assert.match(page, /id="recovery-panel" class="hidden"/);
  assert.match(page, /id="new-password"[^>]*autocomplete="new-password"/);
  assert.ok(page.indexOf('id="forgot-password"') > page.indexOf('id="login-form"'), "the link sits under the sign-in form");
});

test("forgot swaps the sign-in form for the email form, and the link goes to this page", async () => {
  const p = signinPage();
  await flush();
  assert.equal(p.hidden("reset-view"), true);
  p.el("login-email").value = "Member@Example.com";
  p.el("forgot-password").listeners.click();
  assert.equal(p.hidden("login-view"), true);
  assert.equal(p.hidden("reset-view"), false);
  assert.equal(p.el("reset-email").value, "Member@Example.com", "the email already typed is carried over");
  assert.equal(p.el("page-def").textContent, "Say which email, and a reset link is on its way.");

  p.el("reset-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(p.calls(), [["reset", "member@example.com", { redirectTo: "https://berkeley.mathetic.com/engelbart/signin" }]]);
  assert.match(p.el("reset-status").textContent, /on its way/);
  assert.equal(p.el("reset-status").dataset.kind, "success");

  p.el("reset-back").listeners.click();
  assert.equal(p.hidden("login-view"), false);
  assert.equal(p.hidden("reset-view"), true);
});

test("an implausible email never reaches Supabase; a rate limit is said plainly", async () => {
  const p = signinPage({ resetError: { message: "email rate limit exceeded" } });
  await flush();
  p.el("forgot-password").listeners.click();
  p.el("reset-email").value = "not-an-email";
  p.el("reset-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(p.auth.calls, []);
  assert.equal(p.el("reset-status").dataset.kind, "error");

  p.el("reset-email").value = "m@example.com";
  p.el("reset-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(p.auth.calls.length, 1);
  assert.match(p.el("reset-status").textContent, /Too many emails/);
});

test("a recovery session shows the new-password form and nothing else, then the account", async () => {
  const session = { access_token: "jwt", user: { id: "u", email: "m@example.com" } };
  const p = signinPage({ session });
  await flush();
  // The link lands: Supabase announces the session as a recovery.
  p.auth.listener("PASSWORD_RECOVERY", session);
  assert.equal(p.hidden("recovery-panel"), false);
  assert.equal(p.hidden("download-panel"), true, "the account panel waits");
  assert.equal(p.hidden("auth-panel"), true);
  assert.equal(p.el("page-def").textContent, "Choose a new password for this account.");

  p.el("new-password").value = "short";
  p.el("recovery-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(p.auth.calls.length, 0, "eight characters before anything is sent");
  assert.equal(p.el("recovery-status").dataset.kind, "error");

  p.el("new-password").value = "long enough now";
  p.el("recovery-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(p.calls(), [["update", { password: "long enough now" }]]);
  assert.equal(p.hidden("recovery-panel"), true);
  assert.equal(p.hidden("download-panel"), false, "and the account panel follows");
  assert.equal(p.el("new-password").value, "");
  assert.deepEqual(p.history.replaced, ["/engelbart/signin"], "the spent token leaves the address bar");
});

test("a refused password stays on the form with Supabase's reason", async () => {
  const session = { access_token: "jwt", user: { id: "u", email: "m@example.com" } };
  const p = signinPage({ session, updateError: { message: "New password should be different from the old password." } });
  await flush();
  p.auth.listener("PASSWORD_RECOVERY", session);
  p.el("new-password").value = "the same one again";
  p.el("recovery-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(p.hidden("recovery-panel"), false);
  assert.equal(p.el("recovery-status").textContent, "New password should be different from the old password.");
});

test("an ordinary sign-in never sees the recovery form", async () => {
  const session = { access_token: "jwt", user: { id: "u", email: "m@example.com" } };
  const p = signinPage({ session });
  await flush();
  p.auth.listener("SIGNED_IN", session);
  assert.equal(p.hidden("recovery-panel"), true);
  assert.equal(p.hidden("download-panel"), false);
});

test("the account panel has no accent rail and no tinted callouts", () => {
  const panel = page.slice(page.indexOf('id="download-panel"'), page.indexOf("</section>", page.indexOf('id="download-panel"')));
  assert.doesNotMatch(panel, /class="callout"/);
  assert.match(panel, /class="cap"/);
  assert.match(panel, /id="copy-key" class="cmd-copy"/);
  assert.match(panel, /id="setup-cmd" class="cmd-text"/);
  assert.match(panel, /href="\/engelbart\/setup"/);
});
