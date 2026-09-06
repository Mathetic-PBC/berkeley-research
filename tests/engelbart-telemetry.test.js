"use strict";

// The read-only telemetry endpoint behind the debugger's Real runs mode. The
// handler is exercised with an injected row reader, so what the tests see is
// its own job: naming the member, refusing everyone else's runs, ordering,
// and never issuing anything but a read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const handler = require("../api/engelbart-telemetry");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "observability", "example-onboarding-analysis-run.json"), "utf8"));
const ALICE = { id: "11111111-1111-1111-1111-111111111111", email: "alice@example.com" };
const BOB = { id: "22222222-2222-2222-2222-222222222222", email: "bob@example.com" };
const RUN = FIXTURE.run.onboarding_id;
const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOBS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// A PostgREST stand-in over the fixture: three telemetry tables and the
// onboarding rows, answering the filters the handler writes, and keeping a
// log of every query so a write would show.
function store() {
  const log = [];
  const rows = {
    engelbart_onboardings: [
      { id: RUN, user_id: ALICE.id, status: "open", step: 4, project_name: "Speculative decoding", paper_title: "Fast Inference from Transformers", created_at: "2026-09-06T02:40:00.000Z", updated_at: "2026-09-06T02:49:01.600Z" },
      { id: OLD, user_id: ALICE.id, status: "created", step: 9, project_name: null, paper_title: null, created_at: "2026-08-01T10:00:00.000Z", updated_at: "2026-08-01T11:00:00.000Z" },
      { id: BOBS, user_id: BOB.id, status: "open", step: 1, project_name: "Bob's project", paper_title: null, created_at: "2026-09-06T03:00:00.000Z", updated_at: "2026-09-06T03:00:00.000Z" },
    ],
    engelbart_telemetry_operations: FIXTURE.operations.concat([
      { operation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", trace_id: "bobtrace", span_id: "b1", parent_span_id: null, run_id: BOBS, onboarding_id: BOBS, action: "open", name: "onboarding.open", type: "workflow", level: "workflow", status: "completed", started_at: "2026-09-06T03:00:01.000Z", ended_at: "2026-09-06T03:00:01.200Z", duration_ms: 200, attributes: {}, snapshots: {}, error: null },
    ]),
    engelbart_telemetry_snapshots: FIXTURE.snapshots,
    engelbart_telemetry_events: FIXTURE.events,
  };
  // eq and in filters, PostgREST's or=(a.eq.x,b.in.(y)) and the select list: the shapes the handler writes.
  const match = (row, key, raw) => {
    const m = /^(eq|in)\.(.*)$/s.exec(raw);
    assert.ok(m, "only eq and in filters are expected: " + key + "=" + raw);
    if (m[1] === "eq") return String(row[key]) === m[2];
    const set = new Set(m[2].slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")));
    return set.has(String(row[key]));
  };
  const filter = (list, query) => {
    let out = list;
    let select = null;
    for (const [key, raw] of new URLSearchParams(query)) {
      if (key === "select") { select = raw === "*" ? null : raw.split(","); continue; }
      if (["order", "limit", "offset"].includes(key)) continue;
      if (key === "or") {
        const clauses = [...raw.slice(1, -1).matchAll(/([a-z_]+)\.((?:eq\.[^,]+)|(?:in\.\([^)]*\)))/g)].map((c) => [c[1], c[2]]);
        assert.ok(clauses.length, "an or filter names its clauses: " + raw);
        out = out.filter((r) => clauses.some(([k, v]) => match(r, k, v)));
        continue;
      }
      out = out.filter((r) => match(r, key, raw));
    }
    return select ? out.map((r) => Object.fromEntries(select.map((c) => [c, r[c]]))) : out;
  };
  return {
    log,
    rows: async (table, query) => { log.push({ table, query }); return filter(rows[table] || [], query); },
  };
}

function params(q) { return new URLSearchParams(q || ""); }

function fakeRes() {
  const res = { headers: {}, statusCode: 0, payload: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; } };
  return res;
}

test("a request without a session is refused before anything is read", async () => {
  const res = fakeRes();
  await handler({ method: "GET", url: "/api/engelbart-telemetry", headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.payload.error, /sign in/i);
});

test("only GET is allowed: the endpoint has nothing to write", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const res = fakeRes();
    await handler({ method, url: "/api/engelbart-telemetry", headers: { authorization: "Bearer x" } }, res);
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers.Allow, "GET");
  }
});

test("the run list holds only the member's own onboardings, newest first, with the recorded summary", async () => {
  const s = store();
  const out = await handler.query(ALICE, params(), s);
  assert.deepEqual(out.runs.map((r) => r.onboarding_id), [RUN, OLD], "Alice's two rows, Bob's absent, newest first");
  const [recent, old] = out.runs;
  assert.equal(recent.project_name, "Speculative decoding");
  assert.equal(recent.paper_title, "Fast Inference from Transformers");
  assert.equal(recent.telemetry.status, "completed");
  assert.deepEqual(recent.telemetry.actions, ["open", "step", "sources", "analysis"]);
  assert.equal(recent.telemetry.counts.operations, FIXTURE.operations.length);
  assert.equal(recent.telemetry.counts.failed, 0);
  assert.ok(recent.telemetry.server_ms > 0, "the workflow roots' durations are summed");
  assert.equal(recent.telemetry.last_error, null);
  assert.equal(old.telemetry, null, "a row that predates telemetry is listed with nothing recorded");
  assert.equal(old.project_name, null);
});

test("one member cannot list or open another member's run, and the refusal does not say it exists", async () => {
  const s = store();
  const bobs = await handler.query(BOB, params(), s);
  assert.deepEqual(bobs.runs.map((r) => r.onboarding_id), [BOBS]);
  await assert.rejects(handler.query(BOB, params("run=" + RUN), s), (e) => e.statusCode === 404);
  const bobSnapshot = FIXTURE.snapshots[0].snapshot_id;
  await assert.rejects(handler.query(BOB, params("snapshot=" + bobSnapshot), s), (e) => e.statusCode === 404);
  await assert.rejects(handler.query(ALICE, params("run=not-a-uuid"), s), (e) => e.statusCode === 404);
  await assert.rejects(handler.query(ALICE, params("run=" + BOBS), s), (e) => e.statusCode === 404);
});

test("opening a run returns the contract envelope for that onboarding, with its snapshots inline when they fit", async () => {
  const s = store();
  const out = await handler.query(ALICE, params("run=" + RUN), s);
  assert.equal(out.contract_version, FIXTURE.contract_version);
  assert.equal(out.run.run_id, RUN);
  assert.equal(out.operations.length, FIXTURE.operations.length);
  assert.equal(out.events.length, FIXTURE.events.length);
  assert.equal(out.snapshots.length, FIXTURE.snapshots.length);
  assert.equal(out.snapshots_inline, true);
  assert.ok(out.snapshots.every((x) => x.content !== undefined), "every snapshot carries its content");
  assert.equal(out.onboarding.project_name, "Speculative decoding");
  assert.equal(out.onboarding.user_id, undefined, "the row's owner id is not echoed");
  const model = out.operations.find((op) => op.type === "model");
  assert.ok(model.snapshots.model_request && model.snapshots.model_raw_response && model.snapshots.model_parsed_response, "the model operation still names its three snapshots");
  const db = out.operations.find((op) => op.name === "analysis.persist");
  assert.ok(db.snapshots.database_request && db.snapshots.database_response);
});

test("a run whose snapshots outgrow one response carries their metadata, and each is read on its own", async () => {
  const s = store();
  // Every snapshot reports the whole budget in bytes, so together they cannot travel with the run.
  const rows = s.rows;
  s.rows = async (table, query) => { const out = await rows(table, query); return table === "engelbart_telemetry_snapshots" ? out.map((x) => ({ ...x, bytes: handler.INLINE_SNAPSHOT_BYTES })) : out; };
  const out = await handler.query(ALICE, params("run=" + RUN), s);
  assert.equal(out.snapshots_inline, false);
  assert.ok(out.snapshots.every((x) => x.content === undefined && x.content_omitted === true && x.kind), "metadata only, by kind");
  const one = await handler.query(ALICE, params("snapshot=" + out.snapshots[0].snapshot_id), s);
  assert.equal(one.snapshot.snapshot_id, out.snapshots[0].snapshot_id);
  assert.notEqual(one.snapshot.content, undefined);
});

test("every query the endpoint makes is a read of the four tables, and none is traced", async () => {
  const s = store();
  await handler.query(ALICE, params(), s);
  await handler.query(ALICE, params("run=" + RUN), s);
  await handler.query(ALICE, params("snapshot=" + FIXTURE.snapshots[0].snapshot_id), s);
  const tables = new Set(s.log.map((q) => q.table));
  assert.deepEqual([...tables].sort(), ["engelbart_onboardings", "engelbart_telemetry_events", "engelbart_telemetry_operations", "engelbart_telemetry_snapshots"]);
  for (const q of s.log) assert.match(q.query, /^([a-z_]+=(eq|in)\.|or=\()/, "every query filters by a key: " + q.query);
  // The production reader passes trace:false to the service client; the source says so, in one place.
  const source = fs.readFileSync(path.join(__dirname, "..", "api", "engelbart-telemetry.js"), "utf8");
  assert.match(source, /selectRows\(table, query, \{ trace: false \}\)/);
  assert.doesNotMatch(source, /insertRows|deleteRows|patch|upsert|method:\s*"(POST|PATCH|DELETE)"/i, "no write helper is even imported");
});
