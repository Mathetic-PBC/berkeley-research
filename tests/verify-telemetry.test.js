"use strict";

// The read-only verifier, run as a process against a loopback PostgREST that
// serves the example fixture's records: it must pass a clean run, fail a run
// with a planted leak, report a missing run honestly, and never print what a
// snapshot holds.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const FIXTURE = require("../docs/observability/example-onboarding-analysis-run.json");
const SCRIPT = path.resolve(__dirname, "../scripts/verify-telemetry.mjs");
const KEY = "service-role-key-for-the-test-000000";

// The three tables, filtered by the handful of PostgREST operators the script uses.
function serve(tables) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const table = url.pathname.replace("/rest/v1/", "");
    if (req.method !== "GET" || !tables[table]) { res.writeHead(404); res.end("{}"); return; }
    if (req.headers.authorization !== `Bearer ${KEY}` || req.headers.apikey !== KEY) { res.writeHead(401); res.end('{"message":"no"}'); return; }
    let rows = tables[table];
    for (const [k, v] of url.searchParams) {
      if (["order", "limit", "select"].includes(k)) continue;
      const m = /^eq\.(.*)$/.exec(v);
      if (m) rows = rows.filter((r) => String(r[k]) === m[1]);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(url, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: KEY, ...extraEnv } });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const tablesOf = (fixture) => ({ engelbart_telemetry_operations: fixture.operations, engelbart_telemetry_snapshots: fixture.snapshots, engelbart_telemetry_events: fixture.events });

test("the verifier passes the example run, reports its shape, and prints no captured content", async () => {
  const { server, url } = await serve(tablesOf(FIXTURE));
  try {
    const { code, out } = await run(url, { RUN_ID: FIXTURE.run.run_id });
    assert.equal(code, 0, out);
    for (const check of ["operations found", "onboarding.analysis outcome", "hierarchy", "levels", "expected stages", "operations ended",
      "events join operations", "events share ids and level", "lifecycle", "snapshots join operations", "expected snapshots",
      "snapshot records", "paper by reference", "leakage"]) {
      assert.match(out, new RegExp(`^PASS ${check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), check);
    }
    assert.doesNotMatch(out, /^FAIL/m);
    assert.match(out, /\d+ passed, \d+ warning\(s\), 0 failed/);
    // The tree, names only...
    assert.match(out, /^onboarding\.analysis {2}\[workflow\/workflow\] completed/m);
    assert.match(out, /^ {2}model\.analysis {2}\[model\/stage\] completed \d+ms {2}snapshots: model_request, model_raw_response, model_parsed_response/m);
    // ...and nothing a snapshot holds: not the prompt, not the reply, not a row body.
    const request = FIXTURE.snapshots.find((s) => s.kind === "model_request");
    assert.doesNotMatch(out, /Speculative Decoding|one_liner|granularity_rationale|reader@example\.edu/);
    assert.ok(!out.includes(request.content.body.model));
  } finally { server.close(); }
});

test("the verifier fails a run with a planted credential or PDF bytes, and names the record without printing it", async () => {
  const fixture = clone(FIXTURE);
  const reply = fixture.snapshots.find((s) => s.kind === "model_raw_response");
  reply.content.content[0].text += " Bearer sk-planted-secret-value-1234567890";
  const persist = fixture.operations.find((o) => o.name === "analysis.persist");
  persist.attributes["engelbart.leak"] = `%PDF-1.7 ${"QUJD".repeat(1200)}`;
  const { server, url } = await serve(tablesOf(fixture));
  try {
    const { code, out } = await run(url, { RUN_ID: fixture.run.run_id });
    assert.equal(code, 1);
    assert.match(out, /^FAIL leak in snapshot model\.analysis\/model_raw_response: bearer token, sk- key/m);
    assert.match(out, /^FAIL leak in operation analysis\.persist attributes: PDF header, long base64 run/m);
    assert.doesNotMatch(out, /sk-planted|QUJDQUJD/);
  } finally { server.close(); }
});

test("the verifier reports a missing run, a still-running workflow and wrong snapshot sizes honestly", async () => {
  const fixture = clone(FIXTURE);
  const root = fixture.operations.find((o) => o.name === "onboarding.analysis");
  root.status = "running"; root.ended_at = null;
  fixture.events = fixture.events.filter((e) => !(e.operation_id === root.operation_id && e.type === "operation.completed"));
  const page = fixture.snapshots.find((s) => s.kind === "page_text");
  page.bytes += 1;
  const { server, url } = await serve(tablesOf(fixture));
  try {
    const none = await run(url, { RUN_ID: "00000000-0000-0000-0000-000000000000" });
    assert.equal(none.code, 1);
    assert.match(none.out, /^FAIL operations found: none for run/m);
    assert.match(none.out, /Nothing was persisted for this run/);
    const broken = await run(url, { RUN_ID: fixture.run.run_id });
    assert.equal(broken.code, 1);
    assert.match(broken.out, /^FAIL onboarding\.analysis outcome: status running.*never ended in the store/m);
    assert.match(broken.out, /^FAIL operations ended: 1 still onboarding\.analysis\(running\)/m);
    assert.match(broken.out, /^FAIL lifecycle: end events != 1: onboarding\.analysis\(0\)/m);
    assert.match(broken.out, /^FAIL snapshot records: bytes wrong or over cap on page\.extract-text\/page_text/m);
    // No credentials, no run: usage, exit 2.
    const usage = await run("", {});
    assert.equal(usage.code, 2);
    assert.match(usage.err, /^usage:/);
  } finally { server.close(); }
});
