"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "engelbart", "signin", "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "engelbart", "app.js"), "utf8");

test("signup asks for the invite code before the password", () => {
  assert.match(page, /id="invite-form"/);
  assert.match(page, /id="invite-code"/);
  assert.match(page, /id="signup-options" class="stack hidden"/);
  assert.ok(page.indexOf('id="invite-form"') < page.indexOf('id="password-signup-form"'));
});

test("the invite is reserved through engelbart_redeem_invite and signup lands on setup", () => {
  assert.match(app, /client\.rpc\("engelbart_redeem_invite"/);
  assert.match(app, /emailRedirectTo: window\.location\.origin \+ "\/engelbart\/setup"/);
  assert.match(app, /window\.location\.href = "\/engelbart\/setup"/);
});

test("a signup inside a pairing tab stays on the page for the pairing panel", () => {
  const branch = app.indexOf("if (pendingCode) {\n        showSession(result.data.session);");
  assert.ok(branch !== -1, "the signup handler must branch on the pending pairing code");
  const redirect = app.indexOf("leaveForSetup();", branch);
  assert.ok(redirect !== -1, "the pairing branch must come before the setup redirect");
  assert.match(app, /if \(pendingCode\) \{\n\s*showSession\(result\.data\.session\);/);
  // And the listener's early exit is keyed on the same code: a pairing signup
  // stays for the panel, and is never sent to setup from there either.
  assert.match(app, /if \(signingUp && session && session\.user && !pendingCode\)/);
});

// Supabase announces the new session to onAuthStateChange before signUp()
// resolves, and the page's answer to a session is the account panel. A
// member who has just signed up must never see it on the way to setup.
test("a signup leaves for setup from the auth listener, before the account panel can paint", () => {
  const guard = app.indexOf("if (signingUp && session && session.user && !pendingCode) { leaveForSetup(); return; }");
  const paint = app.indexOf('document.documentElement.removeAttribute("data-auth-mode")');
  assert.ok(guard !== -1, "showSession must bail out while a signup is in flight");
  assert.ok(guard < paint, "and it must do so before touching the page");
  const armed = app.indexOf("signingUp = !pendingCode;");
  const signUp = app.indexOf("await client.auth.signUp({");
  assert.ok(armed !== -1 && armed < signUp, "the flag is set before signUp is called, not after it returns");
  assert.match(app, /if \(result\.error\) \{\n\s*signingUp = false;/, "and cleared when the signup fails");
});
