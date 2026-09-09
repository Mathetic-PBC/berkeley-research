"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const P = require("../api/_lib/onboarding-prompts");
const OM = require("../api/_lib/onboarding-model");
const cases = require("./fixtures/subgoals/cases.json");
const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../engelbart/setup/test/prompts.js"), "utf8"), browser);
const BP = browser.window.EGB_PROMPTS;
const previous = [
  { label: "Build the complete engine", description: "Build a generalized pipeline and dashboard.", why: "MVP" },
  { label: "Add comparison frameworks", description: "Compare many rules and examples.", why: "V2" },
  { label: "Add aggregate analytics", description: "Group and cluster all examples.", why: "V3" },
];

// Contract tests verify what reaches the model, not a canned response's semantics.
// Actual output behavior is evaluated separately by scripts/eval-subgoals.cjs.
for (const { id, input } of cases) for (const revise of [false, true]) {
  test(`${id}: ${revise ? "revision" : "initial"} sends synchronized foothold constraints through the real model wrapper`, async () => {
    const args = { ...input, ...(revise ? { previous, feedback: "Make this easier to start." } : {}) };
    const before = JSON.stringify(args);
    const prompt = P.subgoalsPrompt(args);
    assert.equal(prompt, P.render("subgoalsPrompt", args));
    assert.equal(prompt, BP.render("subgoalsPrompt", args));
    assert.ok(prompt.includes(input.direction.what_you_would_make), "approved destination is retained");
    assert.ok(prompt.indexOf("1. ORIENT") < prompt.indexOf("2. DEMONSTRATE"));
    assert.ok(prompt.indexOf("2. DEMONSTRATE") < prompt.indexOf("3. MANIPULATE"));
    for (const constraint of [/same example/, /at most ONE substantial new conceptual burden/, /reuse what the previous subgoal created/, /agent selects a small real example/, /2–4 implementation Todos/, /unless the approved Direction explicitly requires/, /Without an external dataset/]) assert.match(prompt, constraint);
    for (const style of [/Every label begins with an active verb/, /usually 3–8 words/, /Descriptions are one concise sentence, usually 15–30 words/, /why is one short sentence, usually 10–25 words/, /Describe the capability\/result, not the UI implementation/, /Do not enumerate controls\/components/, /researcher's notebook as tomorrow's goal/, /Keep the same concrete example/]) assert.match(prompt, style);
    assert.doesNotMatch(prompt, /two sentences defining observable done conditions|"description": "two sentences"|an outcome, 3-10 words/);
    if (revise) assert.match(prompt, /shrink any inherited roadmap-sized subgoals/);
    assert.doesNotMatch(prompt, /The second builds the substance|third reaches toward the paper's actual contribution/);
    const reply = { subgoals: ["Inspect the concrete artifact", "Apply one representative idea", "Adjust one meaningful behavior"].map(label => ({ label, description: "Observable done condition.", why: "Dependency explanation." })) };
    for (const override of [false, true]) {
      const template = "Custom scope instruction\n{{direction_what}}\n{{task}}\n{{previous_json}}\n{{feedback_line}}";
      const overrides = override ? P.sanitizeOverrides({ subgoalsPrompt: template }) : null;
      let sent;
      const out = await OM.subgoals(args, { apiKey: "test", baseUrl: "https://invalid.test", models: ["all-proxy-models"] }, {
        env: {}, promptOverrides: overrides,
        fetchImpl: async (_url, init) => {
          sent = JSON.parse(init.body);
          return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(reply) }] }) };
        },
      });
      const expected = override ? P.render("subgoalsPrompt", args, overrides) : prompt;
      assert.equal(sent.messages[0].content[0].text, expected + "\n\n" + require("../api/_lib/plan-evidence").rules(args,"subgoals"));
      assert.equal(expected, BP.render("subgoalsPrompt", args, overrides));
      assert.deepEqual(out, reply, "normalization preserves order and the existing output schema");
    }
    assert.equal(JSON.stringify(args), before, "does not shrink/mutate Direction or prior work");
  });
}

test("subgoal normalization preserves bounded observable results without inventing scope", () => {
  const raw = { subgoals: [null, { label: " " }, ...[0, 1, 2, 3].map(i => ({ label: `  Result ${i}  `, description: "d".repeat(600), why: "w".repeat(400), stage: "ignored" }))] };
  const out = OM.normalizeSubgoals(raw);
  assert.deepEqual(out.subgoals.map(g => g.label), ["Result 0", "Result 1", "Result 2"]);
  for (const g of out.subgoals) {
    assert.deepEqual(Object.keys(g), ["label", "description", "why"]);
    assert.equal(g.description.length, 500);
    assert.equal(g.why.length, 300);
  }
  assert.equal(OM.normalizeSubgoals({ subgoals: out.subgoals.slice(0, 2) }), null);
});
