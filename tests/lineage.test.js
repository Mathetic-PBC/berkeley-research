"use strict";

// The lineage vocabulary: one list of stored-value names, kept by the server in
// api/_lib/lineage.js, named in the contract, drawn by the simulator and the
// debugger from the same words, and the only names a recorded run may use.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Lineage = require("../api/_lib/lineage");
const OM = require("../api/_lib/onboarding-model");

const ROOT = path.join(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "observability", "example-onboarding-analysis-run.json"), "utf8"));
const CONTRACT = fs.readFileSync(path.join(ROOT, "docs", "observability", "data-contract.md"), "utf8");
const ATTRIBUTES = ["engelbart.lineage.reads", "engelbart.lineage.writes"];

function simulator() {
  const sandbox = { setTimeout, clearTimeout, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ["fixture.js", "prompts.js", "sim-backend.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "engelbart", "setup", "test", file), "utf8"), sandbox, { filename: file });
  }
  return sandbox.EngelbartSim;
}

// The contract's vocabulary table: the first cell of every row of the table under the Lineage heading.
function documented() {
  const section = CONTRACT.split(/^### Lineage: which stored values an operation read and wrote$/m)[1].split(/^### /m)[0];
  const rows = section.split("\n").filter((line) => /^\| `[a-zA-Z]+` \|/.test(line));
  return rows.map((line) => /^\| `([a-zA-Z]+)` \|/.exec(line)[1]);
}

test("the vocabulary is one list: the contract documents every name and no other, and each name is known", () => {
  assert.equal(Lineage.NAMES.length, new Set(Lineage.NAMES).size, "no name twice");
  assert.deepEqual(documented(), [...Lineage.NAMES], "the contract's table is the vocabulary, in its order");
  for (const name of Lineage.NAMES) assert.equal(Lineage.known(name), true, name);
  assert.equal(Lineage.known("row"), false);
  assert.equal(Lineage.known(""), false);
  assert.deepEqual(Lineage.VALUES.map(([name]) => name), [...Lineage.NAMES]);
  for (const [, what] of Lineage.VALUES) assert.ok(what && typeof what === "string", "every value says what it is");
  for (const column of Object.keys(Lineage.FIELD_VALUE)) assert.equal(Lineage.known(Lineage.FIELD_VALUE[column]), true, `${column} maps to a known value`);
});

test("the simulator draws the same words: every value is a node of its graph, and its column map is the server's", () => {
  const Sim = simulator();
  assert.deepEqual([...Sim.FLOW.nodes.map((n) => n.id)].sort(), [...Lineage.NAMES].sort(), "one node per value, no node for anything else");
  // Values built inside the sandbox have that realm's prototypes; compared as plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(Sim.FIELD_NODE)), JSON.parse(JSON.stringify(Lineage.FIELD_VALUE)), "a column is the same value on both sides");
  for (const edge of Sim.FLOW.edges || []) for (const end of [edge.from, edge.to]) if (end !== undefined) assert.equal(Lineage.known(end), true, `edge end ${end}`);
});

test("a row write is one write per stored value it set: bookkeeping columns and clears are none, and a value set twice is one", () => {
  assert.deepEqual(Lineage.writesOf({ analysis: { areas: [] }, analysis_status: "done", analysis_error: null, paper_title: "Zebra Tuning", step: 4, assets: null, todos: [], project_name: "", name: "A", year: "2", major: "" }),
    ["analysis", "todos", "profile"], "in the order the columns were given");
  assert.deepEqual(Lineage.writesOf({ analysis: null, assets_status: "running", assets_started_at: "t", project_draft: {} }), []);
  assert.deepEqual(Lineage.writesOf({ paper_id: "p", paper_familiarity: 2, project_url: "https://x", repo_url: "" }), ["paper", "links"]);
  assert.deepEqual(Lineage.writesOf({ pending_setup_id: "s", goal_chosen: 1, asset_chosen: { title: "t" } }), ["payload", "todos", "chosen"]);
  assert.deepEqual(Lineage.writesOf({}), []);
  assert.deepEqual(Lineage.writesOf(null), []);
  assert.deepEqual(Lineage.writesOf(undefined), []);
});

test("the model purposes declare their lineage in the vocabulary, and every purpose that produces a stored value writes it", () => {
  const purposes = Object.keys(OM.LINEAGE);
  for (const purpose of purposes) {
    const { reads, writes } = OM.LINEAGE[purpose];
    for (const name of [...reads, ...writes]) assert.equal(Lineage.known(name), true, `${purpose}: ${name}`);
    assert.equal(new Set(reads).size, reads.length, `${purpose} reads a value once`);
  }
  for (const [purpose, value] of [["analysis", "analysis"], ["assets", "assets"], ["leveled", "leveled"], ["direction", "direction"], ["subgoals", "subgoals"],
    ["details", "details"], ["goals", "goals"], ["todos", "todos"], ["ask", "asks"], ["brainstorm", "interest"], ["grade", "calibrations"], ["follow_up", "calibrations"]]) {
    assert.ok(OM.LINEAGE[purpose].writes.includes(value), `${purpose} writes ${value}`);
  }
  assert.deepEqual(OM.LINEAGE.rewrite.writes, [], "a rewrite returns text; the row write that stores the register is the write");
  assert.ok(!OM.LINEAGE.grade.reads.includes("profile"), "grading is not given the reader, so it does not claim to read the profile");
});

test("the recorded example uses only the vocabulary, as clean lists, and records the analysis path's reads and writes", () => {
  const byName = {};
  for (const op of FIXTURE.operations) {
    for (const key of ATTRIBUTES) {
      const list = op.attributes[key];
      if (list === undefined) continue;
      assert.ok(Array.isArray(list) && list.length > 0, `${op.name} ${key} is a non-empty list`);
      assert.equal(new Set(list).size, list.length, `${op.name} ${key} names a value once`);
      for (const name of list) assert.equal(Lineage.known(name), true, `${op.name} ${key}: ${name}`);
    }
    if (op.type === "workflow") for (const key of ATTRIBUTES) assert.equal(op.attributes[key], undefined, `${op.name} declares nothing`);
    (byName[op.name] = byName[op.name] || []).push(op);
  }
  const declared = FIXTURE.operations.filter((op) => ATTRIBUTES.some((key) => op.attributes[key] !== undefined));
  assert.ok(declared.length >= 12, `most of the path declares something (${declared.length} of ${FIXTURE.operations.length})`);
  const model = byName["model.analysis"][0];
  assert.deepEqual(model.attributes["engelbart.lineage.reads"], ["paper", "links", "profile"]);
  assert.deepEqual(model.attributes["engelbart.lineage.writes"], ["analysis"]);
  assert.deepEqual(byName["analysis.persist"][0].attributes["engelbart.lineage.writes"], ["analysis"]);
  assert.deepEqual(byName["paper.download"][0].attributes["engelbart.lineage.reads"], ["paper"]);
  for (const load of byName["row.load"]) assert.deepEqual(load.attributes["engelbart.lineage.reads"], ["session"]);
  const patches = byName["db.patch"].map((op) => op.attributes["engelbart.lineage.writes"]);
  assert.deepEqual(patches, [["profile"], ["paper", "links"]], "the step stored the profile; the sources stored the paper and the links");
});
