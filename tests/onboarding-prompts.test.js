"use strict";
// The prompts as templates: the server's render of a default template must be
// the very string the prompt's own function builds, for every editable prompt
// and every shape of input, and the debugger's copy of the templates must be
// the server's. Overrides are bounded and named, and nothing else gets in.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const P = require("../api/_lib/onboarding-prompts");

const reader = { name: "Ada", year: "Third year", major: "Physics", depth: "some", knowledge: [{ area: "Attention", level: 50 }, { area: "Sampling", level: 25 }] };
const paper = { title: "Fast Inference from Transformers", one_liner: "Decode several tokens per step and verify them." };
const assessment = { areas: [{ area: "Attention", self_level: 25, graded_level: 50, rationale: "knew the shapes", answers: ["It weights the values."] }, { area: "Sampling", self_level: 50, answers: [] }] };
const assets = [{ title: "Reference code", type: "code", one_liner: "the decoder", links: [{ url: "https://x.org/code" }], children: [{ title: "Toy script", type: "demo", what_you_can_do_with_it: "run it", links: [] }] }];
const turns = [{ role: "assistant", content: "What draws you?" }, { role: "user", content: "The speedup." }];
const direction = { title: "A decoder", what_you_would_make: "A GUI", first_visible_result: "tokens appearing" };

// Every editable prompt, with the inputs its function takes: the plain case and the branches.
const CASES = {
  analyzePrompt: [
    { familiarityLabel: P.FAMILIARITY[1].label, familiarityDesc: P.FAMILIARITY[1].desc, depthLabel: P.DEPTHS[0].label, depthDesc: P.DEPTHS[0].desc, urls: "https://x.org\npage text" },
    { familiarityLabel: "Lost", familiarityDesc: "", depthLabel: "Expert", depthDesc: "", urls: "" },
  ],
  gradePrompt: [{ area: "Attention", question: "What does it do?", level: 50, sample: "It weights values.", answer: "It mixes." }],
  followUpPrompt: [
    { reader, area: "Attention", parent_field: "Deep learning", question: "q", level: 50, self_level: 25, answer: "a", graded_level: 50, graded_rationale: "knew the shapes", sample: "s" },
    { reader: {}, area: "Attention", parent_field: "", question: "q", level: 0, self_level: 0, answer: "a", graded_level: 0, graded_rationale: "", sample: "" },
  ],
  assetsPrompt: [{}],
  levelPrompt: [{ reader, assessment, assets, interest: "the speedup" }, { reader, assessment: { areas: [] }, assets: [], interest: "" }],
  brainstormPrompt: [
    { reader, paper, assessment, brief: [{ title: "Reference code", type: "code", one_liner: "the decoder" }], turns: [], round: 0 },
    { reader, paper, assessment, brief: [], turns, round: 1 },
    { reader, paper, assessment: { areas: [] }, brief: [], turns, round: 2 },
  ],
  directionPrompt: [
    { reader, paper, interest: "the speedup", assessment, turns, asset: assets[0], leveled: { locus: "the verifier", sticky: ["shapes", "masks"] }, previous: null, feedback: "" },
    { reader, paper, interest: "", assessment, turns: [], asset: assets[0], leveled: null, previous: direction, feedback: "smaller" },
  ],
  subgoalsPrompt: [
    { reader, paper, direction, asset: assets[0], leveled: { locus: "the verifier", sticky: [] }, previous: null, feedback: "" },
    { reader, paper, direction: { title: "d", what_you_would_make: "" }, asset: assets[0], leveled: null, previous: { subgoals: [] }, feedback: "more" },
  ],
  todosPrompt: [{ reader, paper, direction, subgoal: { label: "A video can be uploaded", description: "and previewed" }, resources: assets }, { reader, paper, direction, subgoal: { label: "x" }, resources: [] }],
  askPrompt: [{ reader, paper, quote: "the verifier", question: "why?", resources: assets }],
  rewritePrompt: [{ reader, from: "some", to: "technical", texts: ["one passage", "another"] }, { reader: {}, from: "everyday", to: "expert", texts: [] }],
};

function expected(key, input) {
  if (key !== "analyzePrompt") return P[key](input);
  // analyze's function returns the text around the paper; the model layer joins it and pastes the urls in.
  const { before, after } = P.analyzePrompt(input);
  return before + "(the paper attached above)" + after.replace("%URLS%", () => input.urls || "(none supplied)");
}

test("rendering a default template gives exactly the prompt the function builds, for every editable prompt", () => {
  assert.deepEqual(Object.keys(CASES).sort(), P.ORDER.slice().sort(), "every editable prompt is covered");
  for (const key of P.ORDER) {
    for (const input of CASES[key]) {
      assert.equal(P.render(key, input), expected(key, input), key);
    }
  }
});

test("an override is rendered with the same slots; a slot the template does not use is simply absent", () => {
  const out = P.render("gradePrompt", CASES.gradePrompt[0], { gradePrompt: "Grade {{area}} at {{level}}: {{answer}} vs {{sample}}. {{missing}}" });
  assert.equal(out, "Grade Attention at 50: It mixes. vs It weights values.. ");
  assert.equal(P.render("analyzePrompt", CASES.analyzePrompt[0], { analyzePrompt: "urls: {{urls}}" }), "urls: https://x.org\npage text");
  // Slot values are data: a $& in a page's text is pasted, not interpreted.
  assert.equal(P.render("askPrompt", { reader: {}, paper, quote: "$& $1", question: "q" }, { askPrompt: "[{{quote}}]" }), "[$& $1]");
  assert.equal(P.render("noSuchPrompt", {}), "");
});

test("the debugger's copy of the templates is the server's", () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "engelbart", "setup", "test", "prompts.js"), "utf8"), sandbox);
  // Plain values from the other realm, so the comparison is of content, not prototypes.
  const copy = JSON.parse(JSON.stringify(sandbox.window.EGB_PROMPTS));
  assert.deepEqual(copy.TEMPLATES, P.TEMPLATES);
  assert.deepEqual(copy.LABELS, P.LABELS);
  assert.deepEqual(copy.ORDER, P.ORDER);
  // And its rendering is the server's: the same slots from the same inputs.
  for (const key of P.ORDER) for (const input of CASES[key]) assert.equal(sandbox.window.EGB_PROMPTS.render(key, JSON.parse(JSON.stringify(input))), P.render(key, input), key);
});

test("overrides are the editable prompts only, as bounded strings that differ from the default; anything else is dropped, and nothing usable is null", () => {
  assert.equal(P.sanitizeOverrides(null), null);
  assert.equal(P.sanitizeOverrides("gradePrompt"), null);
  assert.equal(P.sanitizeOverrides([]), null);
  assert.equal(P.sanitizeOverrides({}), null);
  assert.equal(P.sanitizeOverrides({ detailsPrompt: "x", nope: "y", gradePrompt: 5, askPrompt: "   " }), null, "not editable, unknown, not a string, blank");
  assert.equal(P.sanitizeOverrides({ gradePrompt: P.TEMPLATES.gradePrompt }), null, "the default text is no override");
  assert.equal(P.sanitizeOverrides({ gradePrompt: "x".repeat(P.OVERRIDE_MAX_CHARS + 1) }), null, "past the bound");
  assert.deepEqual(P.sanitizeOverrides({ gradePrompt: "Grade\r\n{{answer}}", askPrompt: "a", __proto__: { levelPrompt: "inherited" } }), { gradePrompt: "Grade\n{{answer}}", askPrompt: "a" });
});
