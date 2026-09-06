"use strict";

// Lineage: the stored values of one onboarding, by name, and which column of
// the row holds each. An operation that reads or writes one of them says so
// (`reads` / `writes` in its telemetry spec, or `op.reads()` / `op.writes()`),
// and the record keeps the names as the attributes `engelbart.lineage.reads`
// and `engelbart.lineage.writes` (docs/observability/data-contract.md,
// *Lineage*). The names are the boxes of the debugger's Data flow view
// (engelbart/setup/test/sim-backend.js, NODES): the simulator and the real
// backend describe the same flow in the same words, so a real run draws the
// same graph the simulation does.
//
// A value is read when the operation consumed it and written when the
// operation produced or stored it. Clearing a column (writing null) is not a
// write: the value is gone, not made.

const VALUES = Object.freeze([
  ["session", "the signed-in member; the row is theirs"],
  ["credit", "the credit key and its ledger"],
  ["profile", "name, year, major and register (`depth`)"],
  ["paper", "the paper: its PDF in Storage, `paper_id`, `paper_familiarity`"],
  ["links", "`project_url`, `repo_url`"],
  ["code", "the one-use connect code (the device endpoint's; not emitted by onboarding)"],
  ["analysis", "the paper reading (`analysis`)"],
  ["assets", "the asset hunt (`assets`)"],
  ["brief", "`assets_brief`"],
  ["asks", "rows of `engelbart_onboarding_asks`"],
  ["calibrations", "rows of `engelbart_onboarding_calibrations`"],
  ["assessment", "`assessment`"],
  ["turns", "rows of `engelbart_onboarding_turns`"],
  ["interest", "`interest`"],
  ["leveled", "the fitted resources (`leveled`)"],
  ["chosen", "`asset_chosen`"],
  ["direction", "`direction`"],
  ["subgoals", "`subgoals`"],
  ["details", "`details`"],
  ["goals", "`goals`"],
  ["todos", "`todos`, `project_name`, `goal_chosen`"],
  ["payload", "the pending setup (`engelbart_save_pending_setup`, `pending_setup_id`)"],
  ["profileRecord", "the reader's row in `hc_profiles`"],
]);
const NAMES = Object.freeze(VALUES.map(([name]) => name));

// Which value each column of engelbart_onboardings belongs to. Columns absent
// here (`step`, the `*_status` and `*_error` fields, `paper_title`) are
// bookkeeping about a value, not the value.
const FIELD_VALUE = Object.freeze({
  name: "profile", year: "profile", major: "profile", depth: "profile",
  paper_id: "paper", paper_familiarity: "paper",
  project_url: "links", repo_url: "links",
  analysis: "analysis", assets: "assets", assets_brief: "brief", assessment: "assessment", leveled: "leveled",
  interest: "interest", asset_chosen: "chosen", direction: "direction", subgoals: "subgoals",
  details: "details", goals: "goals",
  todos: "todos", project_name: "todos", goal_chosen: "todos",
  pending_setup_id: "payload",
});

// The values a row write touches: one per column written with a value.
function writesOf(values) {
  const out = [];
  for (const [column, value] of Object.entries(values || {})) {
    const name = FIELD_VALUE[column];
    if (name && value !== null && value !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

function known(name) {
  return NAMES.includes(name);
}

module.exports = { FIELD_VALUE, NAMES, VALUES, known, writesOf };
