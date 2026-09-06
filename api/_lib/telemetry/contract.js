"use strict";

// The Bart data contract's envelope: {run, operations, snapshots, events},
// built from the records the sinks receive. The Run is derived, not
// recorded: its id is the onboarding row's id (or a test run's name), and
// everything else about it is read off its operations. A reader -- the
// inspector, the simulator, a test -- never sees OpenTelemetry internals,
// only these four entities. See docs/observability/data-contract.md.

const CONTRACT_VERSION = "1";
const WORKFLOW = "workflow";
const MODES = ["live", "test", "simulation", "replay", "fixture"];

// The run's mode, as its operations recorded it (`engelbart.mode`); an
// explicit option wins, and a run that nothing marked is live unless a
// harness named it.
function modeOf(operations, options) {
  if (MODES.includes(options.mode)) return options.mode;
  for (const op of operations) {
    const mode = op.attributes && op.attributes["engelbart.mode"];
    if (MODES.includes(mode)) return mode;
  }
  return operations.some((op) => op.test_run_id) ? "test" : "live";
}

function first(values) {
  return values.filter(Boolean).sort()[0] || null;
}

function last(values) {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function pick(operations, key) {
  for (const op of operations) if (op && op[key] != null) return op[key];
  return null;
}

// The roots of a run's traces, in the order they started: one per action.
function roots(operations) {
  return operations
    .filter((op) => !op.parent_span_id)
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

function deriveRun(operations = [], options = {}) {
  const ops = operations.filter(Boolean);
  const workflows = roots(ops);
  const running = ops.some((op) => op.status === "running" || op.status === "waiting");
  const failed = workflows.some((op) => op.status === "failed");
  const runId = options.run_id || pick(ops, "run_id");
  return {
    run_id: runId,
    onboarding_id: pick(ops, "onboarding_id"),
    test_run_id: pick(ops, "test_run_id"),
    user_hash: pick(ops.map((op) => ({ user_hash: op.attributes && op.attributes["engelbart.user_hash"] })), "user_hash"),
    mode: modeOf(ops, options),
    environment: pick(ops, "environment"),
    code_version: pick(ops, "code_version"),
    deployment: pick(ops, "deployment"),
    status: running ? "running" : failed ? "failed" : "completed",
    started_at: first(ops.map((op) => op.started_at)),
    ended_at: running ? null : last(ops.map((op) => op.ended_at)),
    trace_ids: [...new Set(workflows.map((op) => op.trace_id))],
    actions: workflows.map((op) => op.action || (op.attributes && op.attributes["engelbart.action"]) || op.name),
    counts: {
      traces: new Set(ops.map((op) => op.trace_id)).size,
      operations: ops.length,
      workflows: ops.filter((op) => op.type === WORKFLOW).length,
      failed: ops.filter((op) => op.status === "failed").length,
    },
  };
}

const text = (value) => String(value == null ? "" : value);

// Events in a deterministic order that does not trust `sequence` across
// traces: `sequence` is a counter local to the process that emitted the
// event, and a run's traces come from separate requests whose counters
// overlap. So: wall-clock `at` first, then `trace_id` to keep a trace's
// same-millisecond events together, then `sequence` (meaningful within one
// trace), then `event_id` so equal keys still sort the same way every time.
// Same-time events from different traces sort by trace id, which says nothing
// about which happened first.
function compareEvents(a, b) {
  return text(a.at).localeCompare(text(b.at))
    || text(a.trace_id).localeCompare(text(b.trace_id))
    || (Number(a.sequence) || 0) - (Number(b.sequence) || 0)
    || text(a.event_id).localeCompare(text(b.event_id));
}

// The envelope, ordered: operations by start, snapshots by creation, events
// by compareEvents; every order has a unique final key.
function bundle(records = {}, options = {}) {
  const operations = [...(records.operations || [])].filter(Boolean)
    .sort((a, b) => text(a.started_at).localeCompare(text(b.started_at)) || text(a.span_id).localeCompare(text(b.span_id))
      || text(a.operation_id).localeCompare(text(b.operation_id)));
  const snapshots = [...(records.snapshots || [])].filter(Boolean)
    .sort((a, b) => text(a.created_at).localeCompare(text(b.created_at)) || text(a.snapshot_id).localeCompare(text(b.snapshot_id)));
  const events = [...(records.events || [])].filter(Boolean).sort(compareEvents);
  return {
    contract_version: CONTRACT_VERSION,
    run: deriveRun(operations, options),
    operations,
    snapshots,
    events,
  };
}

// The tree a graph draws: each operation with its `children`, roots first.
function tree(operations = []) {
  const bySpan = new Map();
  const nodes = operations.filter(Boolean).map((op) => ({ ...op, children: [] }));
  for (const node of nodes) bySpan.set(node.span_id, node);
  const out = [];
  for (const node of nodes) {
    const parent = node.parent_span_id ? bySpan.get(node.parent_span_id) : null;
    if (parent) parent.children.push(node); else out.push(node);
  }
  const byStart = (a, b) => String(a.started_at).localeCompare(String(b.started_at));
  const sortDeep = (list) => { list.sort(byStart); for (const n of list) sortDeep(n.children); };
  sortDeep(out);
  return out;
}

module.exports = { CONTRACT_VERSION, bundle, compareEvents, deriveRun, tree };
