"use strict";

// Read-only access to a member's own onboarding telemetry, for the Real runs
// mode of the debugger at /engelbart/setup/test. Three GET shapes:
//
//   GET /api/engelbart-telemetry                 the member's recent onboarding runs, newest first
//   GET /api/engelbart-telemetry?run=<id>        one run: the contract envelope for that onboarding
//   GET /api/engelbart-telemetry?snapshot=<id>   one snapshot's content, when the run left it out
//
// The member is named by their Supabase session, exactly as the onboarding
// endpoint names them, and sees a run only when the onboarding row it belongs
// to is theirs. The service role stays in this function. Nothing here writes:
// no onboarding state changes, no model is called, no credit is spent, and the
// reads themselves run untraced so looking at telemetry produces none.
//
// The records come back in the shapes docs/observability/data-contract.md
// defines, straight from the three telemetry tables; the debugger's adapter
// (engelbart/setup/test/real-runs.js) reads that contract and nothing else.

const { allowMethods, bearerToken, publicError, sendJson } = require("./_lib/http");
const { selectRows, verifyUser } = require("./_lib/supabase");
const { telemetry } = require("./_lib/telemetry");
const Contract = require("./_lib/telemetry/contract");

const TABLES = Object.freeze({
  onboardings: "engelbart_onboardings",
  operations: "engelbart_telemetry_operations",
  snapshots: "engelbart_telemetry_snapshots",
  events: "engelbart_telemetry_events",
});

// Recent means the member's last onboarding rows; each row is one run.
const RUN_LIMIT = 50;
// PostgREST answers at most this many rows per request, so longer runs are read page by page.
const PAGE = 1000;
const MAX_PAGES = 10;
// A run's snapshots travel with it while they fit comfortably in one response;
// past this, the run carries their metadata and the page asks for each one.
const INLINE_SNAPSHOT_BYTES = 2500000;

const OPERATION_LIST_COLUMNS = "operation_id,trace_id,span_id,parent_span_id,run_id,onboarding_id,action,name,type,level,status,started_at,ended_at,duration_ms,error";
const SNAPSHOT_META_COLUMNS = "snapshot_id,operation_id,trace_id,span_id,run_id,onboarding_id,test_run_id,kind,bytes,truncated,redacted,created_at";
const ONBOARDING_COLUMNS = "id,user_id,status,step,project_name,paper_title,created_at,updated_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isUuid(value) {
  return UUID.test(String(value || ""));
}

// Every read goes through here: the service role, and never a trace of its own.
function reader(d) {
  const rows = d.rows || ((table, query) => selectRows(table, query, { trace: false }));
  return async function pageAll(table, query) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await rows(table, `${query}&limit=${PAGE}&offset=${page * PAGE}`);
      out.push(...batch);
      if (batch.length < PAGE) break;
    }
    return out;
  };
}

function inList(values) {
  return `in.(${values.map((v) => `"${String(v).replace(/"/g, "")}"`).join(",")})`;
}

async function ownedRows(read, user) {
  return read(TABLES.onboardings, `user_id=eq.${encodeURIComponent(user.id)}&select=${ONBOARDING_COLUMNS}&order=created_at.desc`);
}

async function ownedRow(read, user, id) {
  if (!isUuid(id)) throw fail("No such run", 404);
  const rows = await read(TABLES.onboardings, `id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&select=${ONBOARDING_COLUMNS}`);
  const row = rows.find((r) => r && r.id === id && r.user_id === user.id);
  if (!row) throw fail("No such run", 404);
  return row;
}

function publicRow(row) {
  return {
    onboarding_id: row.id,
    onboarding_status: row.status,
    step: row.step,
    project_name: row.project_name || null,
    paper_title: row.paper_title || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// What the list says about a run's telemetry: the contract's derived Run,
// plus the time the server spent and the last failure, both read from the
// operations as recorded.
function summarize(operations) {
  if (!operations.length) return null;
  const run = Contract.deriveRun(operations, { run_id: operations[0].run_id || operations[0].onboarding_id });
  const workflows = operations.filter((op) => op.type === "workflow" || !op.parent_span_id);
  const server_ms = workflows.reduce((n, op) => n + (Number(op.duration_ms) || 0), 0);
  const failed = operations.filter((op) => op.status === "failed" && op.error)
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const last = failed.length ? failed[failed.length - 1] : null;
  return {
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at,
    actions: run.actions,
    trace_ids: run.trace_ids,
    counts: run.counts,
    server_ms,
    last_error: last ? { name: last.error.name || null, message: last.error.message || null, status_code: last.error.status_code ?? null, operation: last.name } : null,
  };
}

async function listRuns(user, d) {
  const read = reader(d);
  const rows = (await ownedRows(read, user)).filter((r) => r && r.user_id === user.id).slice(0, RUN_LIMIT);
  if (!rows.length) return { runs: [] };
  const ids = inList(rows.map((r) => r.id));
  const ops = await read(TABLES.operations, `or=(onboarding_id.${ids},run_id.${ids})&select=${OPERATION_LIST_COLUMNS}&order=started_at.asc`);
  const byRow = new Map();
  for (const op of ops) {
    const key = op && (op.onboarding_id || op.run_id);
    if (!key) continue;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(op);
  }
  const runs = rows.map((row) => ({ run_id: row.id, ...publicRow(row), telemetry: summarize(byRow.get(row.id) || []) }));
  // Newest first, by when the run last did anything: the row's own clock, or its latest operation.
  const latest = (r) => Math.max(Date.parse(r.updated_at || r.created_at) || 0, r.telemetry && r.telemetry.ended_at ? Date.parse(r.telemetry.ended_at) || 0 : 0,
    r.telemetry && r.telemetry.started_at ? Date.parse(r.telemetry.started_at) || 0 : 0);
  runs.sort((a, b) => latest(b) - latest(a));
  return { runs };
}

async function loadRun(user, id, d) {
  const read = reader(d);
  const row = await ownedRow(read, user, id);
  const rowId = encodeURIComponent(row.id);
  const operations = (await read(TABLES.operations, `or=(onboarding_id.eq.${rowId},run_id.eq.${rowId})&select=*&order=started_at.asc`))
    .filter((op) => op && (op.onboarding_id === row.id || op.run_id === row.id));
  const traceIds = [...new Set(operations.map((op) => op.trace_id).filter(Boolean))];
  let events = [];
  let snapshots = [];
  let inline = true;
  if (traceIds.length) {
    const traces = inList(traceIds);
    const inTrace = (x) => x && traceIds.includes(x.trace_id);
    events = (await read(TABLES.events, `trace_id=${traces}&select=*&order=at.asc,sequence.asc`)).filter(inTrace);
    const meta = (await read(TABLES.snapshots, `trace_id=${traces}&select=${SNAPSHOT_META_COLUMNS}&order=created_at.asc`)).filter(inTrace);
    const bytes = meta.reduce((n, s) => n + (Number(s.bytes) || 0), 0);
    inline = bytes <= INLINE_SNAPSHOT_BYTES;
    snapshots = inline
      ? (await read(TABLES.snapshots, `trace_id=${traces}&select=*&order=created_at.asc`)).filter(inTrace)
      : meta.map((s) => ({ ...s, content_omitted: true }));
  }
  const envelope = Contract.bundle({ operations, snapshots, events }, { run_id: row.id });
  return { ...envelope, snapshots_inline: inline, onboarding: publicRow(row) };
}

async function loadSnapshot(user, id, d) {
  const read = reader(d);
  if (!isUuid(id)) throw fail("No such snapshot", 404);
  const rows = await read(TABLES.snapshots, `snapshot_id=eq.${encodeURIComponent(id)}&select=*`);
  const snapshot = rows.find((s) => s && s.snapshot_id === id);
  if (!snapshot) throw fail("No such snapshot", 404);
  // The snapshot is the member's only through the onboarding it belongs to: named on it, or on an
  // operation of its trace when it was written before the row was known.
  // A test run's id is a name, not a row, so only a row id counts.
  const rowIdOf = (x) => (x && isUuid(x.onboarding_id) ? x.onboarding_id : x && isUuid(x.run_id) ? x.run_id : null);
  let owner = rowIdOf(snapshot);
  if (!owner && snapshot.trace_id) {
    const ops = await read(TABLES.operations, `trace_id=eq.${encodeURIComponent(snapshot.trace_id)}&select=operation_id,trace_id,onboarding_id,run_id`);
    const named = ops.find((op) => op && op.trace_id === snapshot.trace_id && rowIdOf(op));
    owner = named ? rowIdOf(named) : null;
  }
  if (!owner) throw fail("No such snapshot", 404);
  await ownedRow(read, user, owner);
  return { snapshot };
}

function queryOf(req) {
  const url = new URL(String(req.url || "/"), "http://localhost");
  return url.searchParams;
}

// The one entry point the handler and the tests share: an authenticated member and the query.
async function query(user, params, d = {}) {
  const run = params.get("run");
  const snapshot = params.get("snapshot");
  if (run && snapshot) throw fail("Ask for a run or a snapshot, not both", 400);
  if (snapshot) return loadSnapshot(user, snapshot, d);
  if (run) return loadRun(user, run, d);
  return listRuns(user, d);
}

async function handler(req, res) {
  if (!allowMethods(req, res, ["GET"])) return undefined;
  try {
    const user = await telemetry.untraced(() => verifyUser(bearerToken(req)));
    const out = await telemetry.untraced(() => query(user, queryOf(req)));
    return sendJson(res, 200, out);
  } catch (error) {
    const { status, message } = publicError(error);
    if (status >= 500) console.error("engelbart-telemetry failed", error);
    return sendJson(res, status, { error: message });
  }
}

module.exports = handler;
module.exports.query = query;
module.exports.listRuns = listRuns;
module.exports.loadRun = loadRun;
module.exports.loadSnapshot = loadSnapshot;
module.exports.summarize = summarize;
module.exports.INLINE_SNAPSHOT_BYTES = INLINE_SNAPSHOT_BYTES;
