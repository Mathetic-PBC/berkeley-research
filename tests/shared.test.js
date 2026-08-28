const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../engelbart/shared.js");

test("normalizes emails before invite redemption", () => {
  assert.equal(shared.normalizeEmail("  Student@Berkeley.EDU "), "student@berkeley.edu");
  assert.equal(shared.isPlausibleEmail("student@berkeley.edu"), true);
  assert.equal(shared.isPlausibleEmail("student@berkeley"), false);
});

test("normalizes invite codes without changing their payload", () => {
  const raw = "egb a1b2 c3d4 e5f6 7788 9900";
  assert.equal(shared.normalizeInviteCode(raw), "EGB-A1B2-C3D4-E5F6-7788-9900");
  assert.equal(shared.isPlausibleInviteCode(raw), true);
  assert.equal(shared.isPlausibleInviteCode("EGB-short"), false);
});

test("maps expected auth failures without echoing arbitrary backend details", () => {
  assert.equal(
    shared.safeMessage({ message: "Invalid login credentials" }, "fallback"),
    "Email or password is incorrect."
  );
  assert.equal(shared.safeMessage({ message: "database exploded" }, "Could not sign in."), "Could not sign in.");
});

test("keeps recoverable signup failures actionable without exposing backend details", () => {
  assert.equal(
    shared.safeMessage({ message: "Email rate limit exceeded" }, "Could not create the account."),
    "Confirmation email limit reached. Your invite is still reserved; try again later."
  );
  assert.equal(
    shared.safeMessage({ message: "Database error saving new user" }, "Could not create the account."),
    "Account setup failed. Your invite is still reserved; try again."
  );
});
