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
