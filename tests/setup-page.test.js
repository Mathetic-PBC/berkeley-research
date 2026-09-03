"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "setup.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "setup.css"), "utf8");

test("the setup page ships no inline script or style and loads its own files", () => {
  assert.doesNotMatch(html, /<script>[^<]/);
  assert.doesNotMatch(html, /<style>/);
  assert.match(html, /href="\/engelbart\/setup\/setup\.css"/);
  assert.match(html, /src="\/engelbart\/setup\/setup\.js"/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@/);
});

test("the page talks to the onboarding endpoint and the paper upload", () => {
  assert.match(js, /"\/api\/engelbart-onboarding"/);
  assert.match(js, /action: "own_paper"/);
  assert.match(js, /action: "own_paper_saved"/);
  assert.match(js, /action: "sources"/);
  assert.match(js, /"\/engelbart\/signin"/);
});

test("the rail names the twelve steps in order", () => {
  const labels = ["Name", "Year", "Major", "Explanations", "Paper", "Install", "Topics", "Brainstorm", "Assets", "Direction", "Subgoals", "Todos"];
  const found = /var LABELS = \[([^\]]*)\]/.exec(js);
  assert.ok(found, "LABELS array");
  assert.deepEqual(JSON.parse("[" + found[1] + "]"), labels);
});

test("the stylesheet carries the reference tokens", () => {
  assert.match(css, /--blue-600:#0070f3/);
  assert.match(css, /--gray-900:#171717/);
  assert.match(css, /@keyframes rise/);
});

test("the second half asks, grades, generates and creates", () => {
  for (const action of ["analysis", "assets", "answer", "topics_done", "leveled", "brainstorm", "asset_ask", "choose_asset", "direction", "subgoals", "todos", "ask", "create"]) {
    assert.match(js, new RegExp(`api\\("${action}"`), action);
  }
  assert.match(js, /action: "issue"/);
  assert.match(html, /src="\/engelbart\/setup\/install\.js"/);
  assert.match(js, /Ask about this/);
});
