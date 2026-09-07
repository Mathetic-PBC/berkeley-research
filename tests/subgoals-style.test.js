"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { STYLE_CRITERIA, styleMeasurements, withinStyleTargets } = require("../scripts/lib/subgoals-style.cjs");
const examples = require("./fixtures/subgoals/style-examples.json");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../engelbart/setup/test/fixture.js"), "utf8"), sandbox);
const fixture = sandbox.window.EGB_FIXTURE;

// Authored examples and simulator fixtures, NOT live model evidence. This
// varied verb vocabulary checks these fixtures only. Live output grammar is
// judged in context by the semantic evaluator, without a verb whitelist.
const fixtureVerb = /^(?:Inspect|Highlight|Adjust|Apply|Measure|Run|Render|Test|Flag|Compare|Reproduce|Explore|Verify|Visualize)\b/u;
for (const [domain, subgoals] of Object.entries({ ...examples, simulator: fixture.SUBGOALS, "simulator-revised": fixture.REVISED_SUBGOALS })) {
  test(`${domain}: example labels are verb-led and prose meets concise notebook targets`, () => {
    assert.equal(subgoals.length, 3);
    for (const [i, m] of styleMeasurements(subgoals).entries()) {
      assert.match(subgoals[i].label, fixtureVerb);
      assert.ok(withinStyleTargets(m), JSON.stringify({ subgoal: i, ...m }));
      assert.equal(m.productPhrasing, false);
    }
  });
}

test("style measurements expose verbosity and product phrasing without exact label matching", () => {
  const good = examples.tutortrace[0];
  for (const field of ["label", "description", "why"]) {
    const [m] = styleMeasurements([{ ...good, [field]: "word ".repeat(40) }]);
    assert.equal(withinStyleTargets(m), false, field);
  }
  for (const field of ["description", "why"]) {
    const [m] = styleMeasurements([{ ...good, [field]: "Inspect the example. Then add another." }]);
    assert.equal(m[field + "Sentences"], 2);
    assert.equal(withinStyleTargets(m), false);
  }
  for (const phrase of ["A panel displays", "The interface allows", "The window shows", "Checkboxes let", "A ranked list appears", "The system provides", "Users can"]) {
    const [m] = styleMeasurements([{ ...good, description: phrase + " several controls for selecting filters and comparing every session in the dataset." }]);
    assert.equal(m.productPhrasing, true, phrase);
  }
  for (const label of ["A scrollable table displays results", "Multiple rules can be toggled", "A summary panel counts events", "An interface enables comparisons"]) assert.doesNotMatch(label, fixtureVerb);
});

test("live style rubric requires grammatical verbs, natural prose, and the same-example progression", () => {
  const rubric = STYLE_CRITERIA.join("\n");
  assert.match(rubric, /Every label begins with an active verb in context/);
  assert.match(rubric, /not membership in a list/);
  assert.match(rubric, /not a UI component/);
  assert.match(rubric, /orient, demonstrate, manipulate on the same concrete example/);
  assert.match(rubric, /without repeating its description/);
});
