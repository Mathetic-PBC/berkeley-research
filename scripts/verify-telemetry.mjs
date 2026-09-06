// Read-only check of what Bart telemetry persisted for one onboarding run.
// Exit 0 = every check passed (warnings allowed); 1 = something failed or
// nothing was found; 2 = usage.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RUN_ID=<onboarding uuid | test:<name>> npm run verify:telemetry
//
// Optional: ACTION (default analysis) picks which workflow's latest attempt is
// inspected; TRACE_ID pins one trace instead. The script only reads the three
// engelbart_telemetry_* tables. It starts no onboarding, calls no model, and
// writes nothing. It never prints captured content: snapshot bodies, model
// prompts and replies, row bodies and error messages stay on the server; the
// report names operations, kinds, ids, counts and sizes only.
//
// Events and snapshots are fetched by trace id and joined by operation id,
// never by run id: the first operations of a trace (the row loads) emit their
// events before the run id is known, and a run-id lookup would hide them.

const USAGE = [
  "usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RUN_ID=... node scripts/verify-telemetry.mjs",
  "",
  "Required environment:",
  "  SUPABASE_URL                 the project's https origin",
  "  SUPABASE_SERVICE_ROLE_KEY    the service role (the tables are service-role only)",
  "  RUN_ID                       the onboarding row id, or test:<test_run_id>",
  "Optional:",
  "  ACTION                       workflow to inspect (default analysis)",
  "  TRACE_ID                     inspect this trace instead of the latest attempt",
].join("\n");

const env = process.env;
const BASE = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
const RUN_ID = env.RUN_ID || "";
const ACTION = env.ACTION || "analysis";
const PINNED_TRACE = env.TRACE_ID || "";
// https only, except a loopback address, which is how the test suite serves the fixture to this script.
if (!/^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)/.test(BASE) || !KEY || (!RUN_ID && !PINNED_TRACE)) { console.error(USAGE); process.exit(2); }

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const LEVELS = ["workflow", "stage", "detail"];
const KINDS = ["model_request", "model_raw_response", "model_parsed_response", "normalized_result", "processing_input", "processing_output",
  "database_request", "database_response", "page_text", "error_detail"];
// The paper-analysis path, in order (docs/observability/data-contract.md). Other
// actions are checked for shape only.
const EXPECTED_CHILDREN = {
  analysis: ["row.load", "calibrations.load", "turns.load", "analysis.mark-running", "paper.download", "analysis.context",
    "analysis.construct-request", "model.analysis", "analysis.normalize", "analysis.check-superseded", "analysis.persist"],
  assets: ["row.load", "calibrations.load", "turns.load", "assets.mark-running", "model.assets", "assets.normalize", "assets.verify-links",
    "assets.check-superseded", "assets.persist"],
  leveled: ["row.load", "calibrations.load", "turns.load", "leveled.mark-running", "model.leveled", "leveled.normalize",
    "leveled.check-superseded", "leveled.persist"],
};
const EXPECTED_SNAPSHOTS = {
  "model.analysis": ["model_request", "model_raw_response", "model_parsed_response"],
  "model.assets": ["model_request", "model_raw_response", "model_parsed_response"],
  "model.leveled": ["model_request", "model_raw_response", "model_parsed_response"],
  "analysis.normalize": ["normalized_result"], "assets.normalize": ["normalized_result"], "leveled.normalize": ["normalized_result"],
  "analysis.persist": ["database_request", "database_response"], "assets.persist": ["database_request", "database_response"],
  "leveled.persist": ["database_request", "database_response"],
  "page.extract-text": ["page_text"],
};
// What must never appear in any stored record. The service key is checked as
// a literal; the rest are shapes.
const LEAKS = [
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/],
  ["sk- key", /\bsk-[A-Za-z0-9_-]{8,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["egb_ machine token", /\begb_[A-Za-z0-9_-]{8,}/],
  ["signed-url token", /[?&](?:token|apikey|api_key|access_token|signature|sig)=(?!\[redacted\])[^&\s"'<>]{8,}/i],
  ["PDF header", /%PDF-/],
  ["base64 PDF", /JVBERi0/],
  ["long base64 run", /[A-Za-z0-9+/]{4000,}={0,2}/],
];
const SECRET_KEYS = /^(?:authorization|apikey|api[-_]?key|service[-_]?role[-_]?key|paper[-_]?token|token|secret|password|signed[-_]?url|upload[-_]?url)$/i;

const report = { pass: 0, warn: 0, fail: 0 };
function line(kind, check, detail) {
  report[kind] += 1;
  console.log(`${kind.toUpperCase().padEnd(4)} ${check}${detail ? `: ${detail}` : ""}`);
}
const pass = (c, d) => line("pass", c, d);
const warn = (c, d) => line("warn", c, d);
const fail = (c, d) => line("fail", c, d);

async function get(path) {
  const response = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path.split("?")[0]} -> ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}
const enc = encodeURIComponent;

async function findOperations() {
  if (PINNED_TRACE) return get(`engelbart_telemetry_operations?trace_id=eq.${enc(PINNED_TRACE)}&order=started_at.asc&limit=1000`);
  let ops = await get(`engelbart_telemetry_operations?run_id=eq.${enc(RUN_ID)}&order=started_at.asc&limit=1000`);
  if (ops.length) return ops;
  if (RUN_ID.startsWith("test:")) ops = await get(`engelbart_telemetry_operations?test_run_id=eq.${enc(RUN_ID.slice(5))}&order=started_at.asc&limit=1000`);
  else if (/^[0-9a-f-]{36}$/i.test(RUN_ID)) ops = await get(`engelbart_telemetry_operations?onboarding_id=eq.${enc(RUN_ID)}&order=started_at.asc&limit=1000`);
  return ops;
}

function scanLeaks(label, value, secrets) {
  const json = JSON.stringify(value);
  if (json === undefined) return;
  const found = [];
  for (const secret of secrets) if (secret && json.includes(secret)) found.push("service role key (literal)");
  for (const [name, pattern] of LEAKS) if (pattern.test(json)) found.push(name);
  if (found.length) fail(`leak in ${label}`, found.join(", "));
  return found.length;
}

// Object keys that name a credential must hold "[redacted]" or nothing.
function unredactedKeys(value, path = "", out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => unredactedKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k) && v != null && v !== "[redacted]" && v !== "") out.push(`${path}.${k}`);
      unredactedKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const ms = (n) => (n == null ? "-" : `${Math.round(Number(n))}ms`);

async function main() {
  const all = await findOperations();
  if (!all.length) {
    fail("operations found", PINNED_TRACE ? `none for trace ${PINNED_TRACE}` : `none for run ${RUN_ID} (by run_id, onboarding_id or test_run_id)`);
    console.log("\nNothing was persisted for this run. Likely causes: ENGELBART_TELEMETRY_STORE=false on the deployment, the"
      + " deployment predates the telemetry release, the request ended before the pre-response flush, or this is not the run id.");
    return;
  }
  pass("operations found", `${all.length} operation(s), ${new Set(all.map((o) => o.trace_id)).size} trace(s), run_id ${all[0].run_id || "-"},`
    + ` mode ${(all[0].attributes || {})["engelbart.mode"] || "-"}, environment ${all[0].environment || "-"}, code ${all[0].code_version || "-"}`);

  // The attempt: the latest workflow root for the action (polls are named *.poll).
  let attempt;
  if (PINNED_TRACE) attempt = all.find((o) => !o.parent_span_id) || all[0];
  else {
    const roots = all.filter((o) => !o.parent_span_id && o.name === `onboarding.${ACTION}`)
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    attempt = roots[roots.length - 1];
    if (!attempt) {
      const names = [...new Set(all.filter((o) => !o.parent_span_id).map((o) => o.name))];
      fail(`latest onboarding.${ACTION} attempt`, `no such workflow; roots present: ${names.join(", ") || "none"}`);
      return;
    }
    if (roots.length > 1) warn(`onboarding.${ACTION} attempts`, `${roots.length} attempts; inspecting the latest (${attempt.started_at})`);
  }
  const traceId = attempt.trace_id;
  const [ops, events, snapshots] = await Promise.all([
    get(`engelbart_telemetry_operations?trace_id=eq.${enc(traceId)}&order=started_at.asc&limit=1000`),
    get(`engelbart_telemetry_events?trace_id=eq.${enc(traceId)}&order=at.asc,sequence.asc&limit=1000`),
    get(`engelbart_telemetry_snapshots?trace_id=eq.${enc(traceId)}&order=created_at.asc&limit=1000`),
  ]);
  console.log(`\ntrace ${traceId}: ${ops.length} operations, ${events.length} events, ${snapshots.length} snapshots\n`);

  // --- outcome -------------------------------------------------------------------------
  const root = ops.find((o) => o.operation_id === attempt.operation_id) || attempt;
  const outcome = (root.attributes || {})["engelbart.outcome"];
  const rootLine = `status ${root.status}, outcome ${outcome || "-"}, ${ms(root.duration_ms)}, started ${root.started_at}`;
  if (root.status === "completed" && (outcome === "done" || outcome == null)) pass(`${root.name} outcome`, rootLine);
  else if (root.status === "completed") warn(`${root.name} outcome`, rootLine);
  else if (root.status === "failed") fail(`${root.name} outcome`, `${rootLine}; error ${root.error ? `${root.error.name} (${root.error.status_code ?? "-"})` : "-"}`);
  else fail(`${root.name} outcome`, `${rootLine}; the workflow never ended in the store (flush missed?)`);

  // --- hierarchy -------------------------------------------------------------------------
  const bySpan = new Map(ops.map((o) => [o.span_id, o]));
  const byId = new Map(ops.map((o) => [o.operation_id, o]));
  const roots = ops.filter((o) => !o.parent_span_id);
  const orphans = ops.filter((o) => o.parent_span_id && !bySpan.has(o.parent_span_id));
  if (roots.length === 1 && !orphans.length) pass("hierarchy", `one root, every parent_span_id resolves`);
  else fail("hierarchy", `${roots.length} root(s), ${orphans.length} operation(s) whose parent is not in the trace: ${orphans.map((o) => o.name).join(", ")}`);
  const badLevel = ops.filter((o) => !LEVELS.includes(o.level));
  if (root.level === "workflow" && !badLevel.length) pass("levels", `root is workflow; ${ops.filter((o) => o.level === "stage").length} stage, ${ops.filter((o) => o.level === "detail").length} detail`);
  else fail("levels", `root level ${root.level}; invalid levels on ${badLevel.map((o) => o.name).join(", ") || "none"}`);

  const children = (op) => ops.filter((o) => o.parent_span_id === op.span_id).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const action = PINNED_TRACE ? String(root.name).replace(/^onboarding\./, "").replace(/\.poll$/, "") : ACTION;
  const expected = EXPECTED_CHILDREN[action];
  if (expected) {
    const names = children(root).map((o) => o.name);
    const persistAlt = `${action}.persist-error`;
    const missing = expected.filter((n) => !names.includes(n) && !(n.endsWith(".persist") && names.includes(persistAlt)));
    if (!missing.length) pass("expected stages", `all ${expected.length} present under ${root.name}`);
    else if (root.status !== "completed" || outcome === "superseded") warn("expected stages", `missing ${missing.join(", ")} (the attempt ended early: ${root.status}/${outcome || "-"})`);
    else fail("expected stages", `missing ${missing.join(", ")}`);
    const extra = names.filter((n) => !expected.includes(n) && n !== persistAlt);
    if (extra.length) warn("unexpected stages", extra.join(", "));
  } else warn("expected stages", `no expectation table for action ${action}; shape checks only`);

  const unended = ops.filter((o) => o.status === "running" || o.status === "waiting");
  if (!unended.length) pass("operations ended", `all ${ops.length} completed or failed`);
  else fail("operations ended", `${unended.length} still ${unended.map((o) => `${o.name}(${o.status})`).join(", ")}`);
  const failedOps = ops.filter((o) => o.status === "failed");
  if (failedOps.length) warn("failed operations", failedOps.map((o) => `${o.name} ${o.error ? `${o.error.name}/${o.error.status_code ?? "-"}` : ""}`).join(", "));

  // --- lifecycle events ---------------------------------------------------------------------
  const orphanEvents = events.filter((e) => !byId.has(e.operation_id));
  if (orphanEvents.length) fail("events join operations", `${orphanEvents.length} event(s) whose operation_id is not in the trace`);
  else pass("events join operations", `all ${events.length} events resolve by operation_id`);
  const idMismatch = events.filter((e) => { const o = byId.get(e.operation_id); return o && (e.trace_id !== o.trace_id || e.span_id !== o.span_id || (e.parent_span_id || null) !== (o.parent_span_id || null) || e.level !== o.level); });
  if (!idMismatch.length) pass("events share ids and level", "trace_id, span_id, parent_span_id and level match the operation on every event");
  else fail("events share ids and level", `${idMismatch.length} event(s) disagree with their operation: ${[...new Set(idMismatch.map((e) => e.name))].join(", ")}`);
  const noStart = []; const noEnd = []; const wrongEnd = [];
  for (const o of ops) {
    const mine = events.filter((e) => e.operation_id === o.operation_id);
    if (!mine.some((e) => e.type === "operation.started")) noStart.push(o.name);
    const ends = mine.filter((e) => e.type === "operation.completed" || e.type === "operation.failed");
    if (ends.length !== 1) noEnd.push(`${o.name}(${ends.length})`);
    else if (ends[0].type !== `operation.${o.status}`) wrongEnd.push(o.name);
  }
  if (!noStart.length && !noEnd.length && !wrongEnd.length) pass("lifecycle", "every operation has one started and one completed/failed event agreeing with its status");
  else fail("lifecycle", [noStart.length && `no started: ${noStart.join(", ")}`, noEnd.length && `end events != 1: ${noEnd.join(", ")}`,
    wrongEnd.length && `end type disagrees with status: ${wrongEnd.join(", ")}`].filter(Boolean).join("; "));
  const earlyNull = events.filter((e) => !e.run_id).length;
  if (earlyNull) pass("early events", `${earlyNull} event(s) emitted before the run id was known (expected; joined by operation_id)`);
  const progress = events.filter((e) => e.type === "operation.progress");
  if (progress.length) warn("progress events", progress.map((e) => `${e.name}: ${(e.progress || {}).message || "-"}`).join(", "));

  // --- snapshots --------------------------------------------------------------------------------
  if (!snapshots.length) {
    warn("snapshots", "none stored for this trace: content capture is off (ENGELBART_TRACE_CONTENT=false), or snapshots were not persisted");
  } else {
    const bySnap = new Map(snapshots.map((s) => [s.snapshot_id, s]));
    const dangling = [];
    for (const o of ops) for (const [kind, id] of Object.entries(o.snapshots || {})) if (!bySnap.has(id)) dangling.push(`${o.name}/${kind}`);
    const unowned = snapshots.filter((s) => !byId.has(s.operation_id));
    if (!dangling.length && !unowned.length) pass("snapshots join operations", `${snapshots.length} snapshot(s), every reference resolves both ways`);
    else fail("snapshots join operations", `${dangling.length} referenced but missing (${dangling.join(", ")}); ${unowned.length} stored without an operation`);
    const missing = [];
    for (const o of ops) for (const kind of EXPECTED_SNAPSHOTS[o.name] || []) if (!(o.snapshots || {})[kind]) missing.push(`${o.name}/${kind}`);
    if (!missing.length) pass("expected snapshots", `model stages, normalized result, persisted state and page text all present where their operations ran`);
    else (root.status === "completed" ? fail : warn)("expected snapshots", `missing ${missing.join(", ")}`);
    const badKind = snapshots.filter((s) => !KINDS.includes(s.kind));
    const badSize = snapshots.filter((s) => s.bytes !== Buffer.byteLength(JSON.stringify(s.content === undefined ? null : s.content)) || s.bytes > MAX_SNAPSHOT_BYTES);
    const notRedacted = snapshots.filter((s) => s.redacted !== true);
    if (!badKind.length && !badSize.length && !notRedacted.length) {
      const total = snapshots.reduce((n, s) => n + (s.bytes || 0), 0);
      pass("snapshot records", `kinds valid, redacted, bytes = UTF-8 size of content and <= ${MAX_SNAPSHOT_BYTES}; ${snapshots.filter((s) => s.truncated).length} truncated; ${total} bytes total`);
    } else {
      fail("snapshot records", [badKind.length && `unknown kinds: ${badKind.map((s) => s.kind).join(", ")}`,
        badSize.length && `bytes wrong or over cap on ${badSize.map((s) => `${(byId.get(s.operation_id) || {}).name}/${s.kind}`).join(", ")}`,
        notRedacted.length && `${notRedacted.length} not marked redacted`].filter(Boolean).join("; "));
    }
    const pdfOps = ops.filter((o) => o.name === "paper.download");
    for (const o of pdfOps) {
      const a = o.attributes || {};
      if (a["engelbart.storage.bytes"] && a["engelbart.storage.sha256"]) pass("paper by reference", `${a["engelbart.storage.bytes"]} bytes, sha256 ${String(a["engelbart.storage.sha256"]).slice(0, 12)}…, ${a["engelbart.storage.content_type"] || "-"}`);
      else warn("paper by reference", "paper.download has no bytes/sha256 attributes");
    }
  }

  // --- leakage ------------------------------------------------------------------------------------
  const secrets = [KEY];
  let leaks = 0;
  for (const o of ops) leaks += scanLeaks(`operation ${o.name} attributes`, o.attributes, secrets) || 0;
  for (const o of ops) if (o.error) leaks += scanLeaks(`operation ${o.name} error`, o.error, secrets) || 0;
  for (const e of events) leaks += scanLeaks(`event ${e.type} ${e.name}`, { attributes: e.attributes, progress: e.progress, error: e.error }, secrets) || 0;
  for (const s of snapshots) leaks += scanLeaks(`snapshot ${(byId.get(s.operation_id) || {}).name}/${s.kind}`, s.content, secrets) || 0;
  const keyLeaks = snapshots.flatMap((s) => unredactedKeys(s.content).map((p) => `${(byId.get(s.operation_id) || {}).name}/${s.kind}${p}`));
  if (keyLeaks.length) { leaks += keyLeaks.length; fail("credential keys", `${keyLeaks.length} credential-named field(s) hold a value: ${keyLeaks.slice(0, 5).join(", ")}${keyLeaks.length > 5 ? ", …" : ""}`); }
  const rawQuery = ops.filter((o) => o.type === "database" && o.attributes && o.attributes["url.query"] !== undefined);
  if (rawQuery.length) warn("filter values in attributes", `${rawQuery.length} database operation(s) carry url.query (a build before query-structure attributes)`);
  if (!leaks) pass("leakage", `no bearer/sk-/JWT/egb_/signed-url token, service key, PDF header or long base64 run in ${ops.length + events.length + snapshots.length} records`);

  // --- the tree, names only ---------------------------------------------------------------------------
  console.log("\noperations:");
  const show = (op, depth) => {
    const kinds = Object.keys(op.snapshots || {});
    console.log(`${"  ".repeat(depth)}${op.name}  [${op.type}/${op.level}] ${op.status} ${ms(op.duration_ms)}${kinds.length ? `  snapshots: ${kinds.join(", ")}` : ""}`);
    for (const c of children(op)) show(c, depth + 1);
  };
  for (const r of roots) show(r, 0);
}

main().then(() => {
  console.log(`\n${report.pass} passed, ${report.warn} warning(s), ${report.fail} failed`);
  process.exit(report.fail ? 1 : 0);
}).catch((error) => {
  console.error(`verify-telemetry: ${String(error && error.message || error).slice(0, 300)}`);
  process.exit(1);
});
