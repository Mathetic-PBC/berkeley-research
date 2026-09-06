"use strict";

// The Bart telemetry layer on its own: parent links, statuses, the run, the
// events, redaction, the capture flag, and the one rule above the rest --
// nothing in here may break the work it observes.

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../api/_lib/telemetry");
const Redaction = require("../api/_lib/telemetry/redaction");

const ENV = { SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0000", LITELLM_MASTER_KEY: "sk-master-000000", VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_SHA: "abcdef0123456789", VERCEL_DEPLOYMENT_ID: "dpl_1" };

function make(settings = {}, env = ENV) {
  const sink = new T.MemorySink();
  const telemetry = T.createTelemetry({ env, sinks: [sink], settings: { captureContent: false, ...settings } });
  return { telemetry, sink };
}

test("operations nest through async context: children carry the parent's span id and trace id", async () => {
  const { telemetry, sink } = make();
  await telemetry.runOperation({ name: "onboarding.analysis", type: "workflow" }, async () => {
    await telemetry.runOperation({ name: "paper.download", type: "storage" }, async () => {});
    await telemetry.runOperation({ name: "analysis.context", type: "processing" }, async () => {
      await Promise.all([
        telemetry.runOperation({ name: "project-page.fetch", type: "http" }, async () => {}),
        telemetry.runOperation({ name: "repo-page.fetch", type: "http" }, async () => {}),
      ]);
    });
  });
  const root = sink.one("onboarding.analysis");
  assert.equal(root.parent_span_id, null);
  assert.equal(root.type, "workflow");
  assert.equal(sink.one("paper.download").parent_span_id, root.span_id);
  const context = sink.one("analysis.context");
  assert.equal(context.parent_span_id, root.span_id);
  for (const name of ["project-page.fetch", "repo-page.fetch"]) {
    assert.equal(sink.one(name).parent_span_id, context.span_id);
    assert.equal(sink.one(name).trace_id, root.trace_id);
  }
  assert.match(root.trace_id, /^[0-9a-f]{32}$/);
  assert.match(root.span_id, /^[0-9a-f]{16}$/);
  assert.ok(sink.operations.every((o) => o.status === "completed" && o.ended_at && o.duration_ms >= 0));
  // The semantic level, decided centrally from name and type.
  assert.equal(root.level, "workflow");
  assert.equal(sink.one("paper.download").level, "stage");
  assert.equal(sink.one("analysis.context").level, "stage");
  assert.equal(sink.one("project-page.fetch").level, "detail");
  assert.equal(sink.one("repo-page.fetch").level, "detail");
  for (const [name, type, want] of [["onboarding.analysis", "workflow", "workflow"], ["model.analysis", "model", "stage"],
    ["analysis.normalize", "processing", "stage"], ["analysis.persist", "database", "stage"], ["row.load", "database", "detail"],
    ["calibrations.load", "database", "detail"], ["turns.load", "database", "detail"], ["db.select", "database", "detail"],
    ["db.upsert", "database", "detail"], ["page.fetch", "http", "detail"], ["page.extract-text", "processing", "detail"],
    ["link.check", "http", "detail"], ["assets.verify-links", "processing", "stage"], ["storage.sign-upload", "storage", "stage"]]) {
    assert.equal(T.levelOf(name, type), want, name);
  }
  assert.equal(T.levelOf("db.select", "database", "stage"), "stage");   // an explicit level wins
  assert.equal(T.levelOf("db.select", "database", "huge"), "detail");   // an unknown one does not
  assert.deepEqual(T.LEVELS, ["workflow", "stage", "detail"]);
  // The manual form: started by hand, parented explicitly, completed by hand.
  const parent = telemetry.startOperation({ name: "manual.parent", type: "workflow" });
  const child = telemetry.startOperation({ name: "manual.child", type: "processing", parent });
  child.complete(); parent.complete();
  assert.equal(sink.one("manual.child").parent_span_id, parent.span_id);
  // Every trace has a workflow root: a boundary operation with nothing above it is untraced,
  // so an endpoint that opens no workflow (and awaits no flush) records nothing at all.
  const before = { ops: sink.started.length, events: sink.events.length };
  for (const type of ["database", "storage", "http", "model", "processing"]) {
    const out = await telemetry.runOperation({ name: `rootless.${type}`, type }, async (op) => { assert.equal(op.enabled, false); return type; });
    assert.equal(out, type);
    assert.equal(telemetry.startOperation({ name: `rootless.${type}`, type }).enabled, false);
  }
  assert.deepEqual({ ops: sink.started.length, events: sink.events.length }, before);
  assert.equal(sink.operations.some((o) => o.name.startsWith("rootless.")), false);
  // The tree the graph draws.
  const tree = T.tree(sink.operations);
  const analysis = tree.find((n) => n.name === "onboarding.analysis");
  assert.deepEqual(analysis.children.map((c) => c.name), ["paper.download", "analysis.context"]);
  assert.equal(analysis.children[1].children.length, 2);
});

test("a failing operation is marked failed with a sanitized error and the original error is rethrown untouched", async () => {
  const { telemetry, sink } = make();
  const boom = new Error("gateway sk-abcdefghijklmnop refused with Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl");
  boom.statusCode = 502;
  let caught = null;
  try {
    await telemetry.runOperation({ name: "onboarding.analysis", type: "workflow" }, async () => {
      await telemetry.runOperation({ name: "model.analysis", type: "model" }, async () => { throw boom; });
    });
  } catch (error) { caught = error; }
  assert.equal(caught, boom);                       // the same object, not a wrapper
  assert.equal(caught.message, boom.message);       // and not edited
  const model = sink.one("model.analysis");
  assert.equal(model.status, "failed");
  assert.equal(model.error.status_code, 502);
  assert.doesNotMatch(model.error.message, /sk-abcdefghijklmnop|eyJhbGci/);
  assert.match(model.error.message, /\[redacted\]/);
  assert.equal(sink.one("onboarding.analysis").status, "failed");
  const failed = sink.events.filter((e) => e.type === "operation.failed");
  assert.deepEqual(failed.map((e) => e.name), ["model.analysis", "onboarding.analysis"]);
  assert.equal(failed[0].error.status_code, 502);
});

test("telemetry failure never breaks the work: throwing sinks, a broken tracer, a hanging flush", async () => {
  const angry = { onOperationStart() { throw new Error("no"); }, onOperationEnd() { throw new Error("no"); },
    onSnapshot() { throw new Error("no"); }, onEvent() { throw new Error("no"); },
    flush() { return new Promise(() => {}); } };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const telemetry = T.createTelemetry({ env: ENV, sinks: [angry], settings: { captureContent: true, flushMs: 50 } });
    const out = await telemetry.runOperation({ name: "onboarding.step", type: "workflow" }, async (op) => {
      op.snapshot("processing_output", { a: 1 });
      op.event("progress");
      return "worked";
    });
    assert.equal(out, "worked");
    assert.equal(await telemetry.flush(), "timeout");
    // A tracer that cannot start a span: the operation is a no-op and fn still runs.
    const broken = T.createTelemetry({ env: ENV, sinks: [] });
    broken.otel = { ...broken.otel, tracer: { startSpan() { throw new Error("tracer down"); } } };
    const again = await broken.runOperation({ name: "x", type: "processing" }, async (op) => { assert.equal(op.enabled, false); return 42; });
    assert.equal(again, 42);
  } finally {
    console.error = original;
  }
  assert.ok(errors.length > 0 && errors.every((e) => e.startsWith("engelbart-telemetry:")));
});

test("redaction strips credentials by key, by pattern and by known value, and references bytes instead of copying them", () => {
  const secrets = Redaction.secretValues(ENV, ["sk-member-key-000000"]);
  const out = Redaction.redact({
    headers: { Authorization: "Bearer abc.def.ghi", apikey: "service-role-key-0000", "x-upsert": "true" },
    note: "sent Authorization: Bearer service-role-key-0000 and key sk-member-key-000000 and sk-master-000000",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    signed: "https://p.supabase.co/storage/v1/object/upload/sign/b/papers/x.pdf?token=eyJraWQiOiJzdG9yYWdlIn0&x=1",
    machine: "egb_machine_token_0000000",
    nested: { paper_token: "t0k3n", password: "p", ok: "fine" },
    doc: { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.4 hello").toString("base64") } },
    bytes: Buffer.from("raw"),
    huge: "x".repeat(100000),
  }, { secrets });
  assert.equal(out.headers.Authorization, "[redacted]");
  assert.equal(out.headers.apikey, "[redacted]");
  assert.equal(out.headers["x-upsert"], "true");
  assert.equal(out.note, "sent Authorization: [redacted] and key [redacted] and [redacted]");
  assert.equal(out.jwt, "[redacted]");
  assert.equal(out.signed, "https://p.supabase.co/storage/v1/object/upload/sign/b/papers/x.pdf?token=[redacted]&x=1");
  assert.equal(out.machine, "[redacted]");
  assert.deepEqual(out.nested, { paper_token: "[redacted]", password: "[redacted]", ok: "fine" });
  assert.equal(out.doc.source.data, "[redacted]");
  assert.equal(out.doc.source.source_ref["[bytes]"], 14);
  assert.equal(out.doc.source.source_ref.sha256, Redaction.sha256(Buffer.from("%PDF-1.4 hello")));
  assert.equal(out.doc.source.media_type, "application/pdf");
  assert.deepEqual(Object.keys(out.bytes), ["[bytes]", "sha256"]);
  assert.ok(out.huge.length < 70000 && /more chars truncated/.test(out.huge));
  assert.doesNotMatch(JSON.stringify(out), /service-role-key-0000|sk-member|sk-master|JVBERi0xLjQ/);
  // Errors and URLs.
  const e = new Error("Bearer zzzzzzzzzz failed"); e.statusCode = 401; e.detail = "apikey sk-abcdefghij";
  assert.deepEqual(Redaction.sanitizeError(e, { secrets }), { name: "Error", message: "[redacted] failed", statusCode: 401, detail: "apikey [redacted]" });
  assert.equal(Redaction.safeUrl("https://x.org/p?token=abc#frag"), "https://x.org/p");
  assert.equal(Redaction.hostOf("https://x.org/p"), "x.org");
});

test("detailed capture respects the flag: off records metadata only, on records redacted bounded snapshots", async () => {
  const off = make({ captureContent: false });
  const root = (t, fn) => t.runOperation({ name: "onboarding.analysis", type: "workflow" }, fn);
  await root(off.telemetry, () => off.telemetry.runOperation({ name: "model.analysis", type: "model" }, async (op) => {
    assert.equal(op.snapshot("model_request", { body: { messages: [] } }), null);
    op.setAttribute("gen_ai.request.model", "claude-sonnet");
    throw Object.assign(new Error("shape"), { statusCode: 502 });
  })).catch(() => {});
  const quiet = off.sink.one("model.analysis");
  assert.deepEqual(quiet.snapshots, {});
  assert.equal(off.sink.snapshots.length, 0);
  assert.equal(quiet.attributes["gen_ai.request.model"], "claude-sonnet");
  assert.equal(quiet.error.message, "shape");

  const on = make({ captureContent: true });
  await root(on.telemetry, () => on.telemetry.runOperation({ name: "model.analysis", type: "model" }, async (op) => {
    // Six 60 KiB strings survive the per-string cap and together pass the 256 KiB bound.
    const id = op.snapshot("model_request", { headers: { Authorization: "Bearer sk-1234567890" }, body: { big: Array.from({ length: 6 }, () => "y".repeat(60000)) } });
    assert.match(id, /^[0-9a-f-]{36}$/);
    op.snapshot("model_raw_response", { content: [{ type: "text", text: "{}" }] });
  }));
  const loud = on.sink.one("model.analysis");
  assert.deepEqual(Object.keys(loud.snapshots), ["model_request", "model_raw_response"]);
  assert.equal(loud.attributes["bart.snapshot.model_request"], loud.snapshots.model_request);
  const request = on.sink.snapshots.find((s) => s.kind === "model_request");
  assert.equal(request.operation_id, loud.operation_id);
  assert.equal(request.trace_id, loud.trace_id);
  assert.equal(request.content.headers.Authorization, "[redacted]");
  assert.equal(request.truncated, true);
  assert.ok(request.bytes <= 256 * 1024);
  assert.equal(request.redacted, true);
  // Every record the sink holds is free of the secret.
  assert.doesNotMatch(JSON.stringify(on.sink), /sk-1234567890/);
});

test("concurrent runs do not share trace context or run ids", async () => {
  const { telemetry, sink } = make();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function request(rowId) {
    return telemetry.withRun({ action: "analysis" }, () => telemetry.runOperation({ name: "onboarding.analysis", type: "workflow" }, async (op) => {
      telemetry.setRun({ onboarding_id: rowId, user_id: `user-${rowId}` });
      await gate;                                        // both requests in flight at once
      await telemetry.runOperation({ name: "model.analysis", type: "model" }, async () => {});
      return { trace: op.trace_id, span: op.span_id, current: telemetry.current().span_id };
    }));
  }
  const pending = [request("row-a"), request("row-b")];
  setTimeout(release, 5);
  const [a, b] = await Promise.all(pending);
  assert.notEqual(a.trace, b.trace);
  assert.equal(a.current, a.span);
  assert.equal(b.current, b.span);
  const models = sink.byName("model.analysis");
  assert.equal(models.length, 2);
  for (const model of models) {
    const root = sink.operations.find((o) => o.span_id === model.parent_span_id);
    assert.equal(root.trace_id, model.trace_id);
    assert.equal(model.run_id, root.run_id);
    assert.equal(model.onboarding_id, root.onboarding_id);
  }
  assert.deepEqual(sink.byName("onboarding.analysis").map((o) => o.onboarding_id).sort(), ["row-a", "row-b"]);
  assert.deepEqual(sink.byName("onboarding.analysis").map((o) => o.action), ["analysis", "analysis"]);
  // The run: derived from the records, with the environment the process ran in.
  const run = T.deriveRun(sink.operations.filter((o) => o.onboarding_id === "row-a"));
  assert.equal(run.run_id, "row-a");
  assert.equal(run.environment, "preview");
  assert.equal(run.code_version, "abcdef012345");
  assert.equal(run.deployment, "dpl_1");
  assert.equal(run.status, "completed");
  assert.equal(run.mode, "live");                    // a real request, nothing said otherwise
  assert.deepEqual(run.actions, ["analysis"]);
  assert.match(run.user_hash, /^[0-9a-f]{16}$/);
  assert.equal(run.counts.operations, 2);
});

test("untraced work produces nothing, and events share the operation's ids in lifecycle order", async () => {
  const { telemetry, sink } = make();
  const out = await telemetry.untraced(() => telemetry.runOperation({ name: "onboarding.analysis.poll", type: "workflow" }, async (op) => {
    assert.equal(op.enabled, false);
    await telemetry.runOperation({ name: "db.select", type: "database" }, async (inner) => { assert.equal(inner.enabled, false); });
    return "polled";
  }));
  assert.equal(out, "polled");
  assert.equal(sink.operations.length, 0);
  assert.equal(sink.events.length, 0);

  await telemetry.runOperation({ name: "onboarding.assets", type: "workflow" }, () => telemetry.runOperation({ name: "assets.verify-links", type: "processing" }, async (op) => {
    op.event("model.retry-without-search", { reason: "tool refused" });
  }));
  const op = sink.one("assets.verify-links");
  const events = sink.events.filter((e) => e.operation_id === op.operation_id);
  assert.deepEqual(events.map((e) => e.type), ["operation.started", "operation.progress", "operation.completed"]);
  for (const e of events) {
    assert.equal(e.trace_id, op.trace_id);
    assert.equal(e.span_id, op.span_id);
    assert.equal(e.parent_span_id, op.parent_span_id);
    assert.equal(e.name, op.name);
    assert.equal(e.operation_type, "processing");
  }
  assert.deepEqual(events[1].progress, { message: "model.retry-without-search", reason: "tool refused" });
  assert.equal(events[0].status, "running");
  assert.equal(events[2].status, "completed");
  assert.equal(typeof events[2].duration_ms, "number");
  assert.ok(events[0].sequence < events[1].sequence && events[1].sequence < events[2].sequence);
  // The contract envelope, in order.
  const envelope = T.bundle(sink);
  assert.equal(envelope.contract_version, "1");
  assert.deepEqual(Object.keys(envelope), ["contract_version", "run", "operations", "snapshots", "events"]);
  assert.deepEqual(envelope.events.map((e) => e.sequence), [...envelope.events].map((e) => e.sequence).sort((x, y) => x - y));
});

test("settings come from the environment, and the run learns its ids from later database reads", async () => {
  const settings = T.readSettings({ ENGELBART_TRACE_CONTENT: "true", ENGELBART_TRACE_POLLS: "1", ENGELBART_TELEMETRY_STORE: "no", ENGELBART_TELEMETRY_FLUSH_MS: "750" });
  assert.deepEqual(settings, { captureContent: true, tracePolls: true, store: false, log: false, flushMs: 750 });
  // Unset: capture is on, and persistence is on exactly when the service role is there to write with.
  assert.deepEqual(T.readSettings({}), { captureContent: true, tracePolls: false, store: false, log: false, flushMs: 2000 });
  const creds = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
  assert.deepEqual(T.readSettings(creds), { captureContent: true, tracePolls: false, store: true, log: false, flushMs: 2000 });
  // ...and an explicit `false` switches either off.
  const quiet = T.readSettings({ ...creds, ENGELBART_TRACE_CONTENT: "false", ENGELBART_TELEMETRY_STORE: "off" });
  assert.equal(quiet.store, false);
  assert.equal(quiet.captureContent, false);
  const { telemetry, sink } = make();
  await telemetry.withRun({ action: "open", test_run_id: "t-1" }, () => telemetry.runOperation({ name: "onboarding.open", type: "workflow" }, async () => {
    await telemetry.runOperation({ name: "db.select", type: "database" }, async () => {});
    telemetry.setRun({ onboarding_id: "row-9" });
    await telemetry.runOperation({ name: "db.patch", type: "database" }, async () => {});
  }));
  // The row load ended before the row was known; its live record was back-filled.
  const early = sink.one("db.select");
  assert.equal(early.run_id, "row-9");
  const earlyEvents = sink.events.filter((e) => e.name === "db.select");
  assert.deepEqual(earlyEvents.map((e) => e.type), ["operation.started", "operation.completed"]);
  assert.deepEqual(earlyEvents.map((e) => e.run_id), ["test:t-1", "test:t-1"]);   // the events keep what was known then
  // ...and operation_id alone reconciles them with the back-filled record.
  for (const e of earlyEvents) assert.equal(e.operation_id, early.operation_id);
  const byOperation = new Map(sink.operations.map((o) => [o.operation_id, o]));
  for (const e of sink.events) {
    const op = byOperation.get(e.operation_id);
    assert.ok(op, `event ${e.type} for ${e.name} joins an operation by operation_id`);
    assert.equal(op.name, e.name);
    assert.equal(op.level, e.level);
  }
  assert.equal(byOperation.get(earlyEvents[0].operation_id).run_id, "row-9");
  assert.equal(sink.one("db.patch").run_id, "row-9");
  assert.equal(sink.one("onboarding.open").run_id, "row-9");
  assert.equal(sink.one("onboarding.open").attributes["engelbart.onboarding_id"], "row-9");
  assert.equal(sink.one("onboarding.open").test_run_id, "t-1");
  // A named test run is mode "test" unless the harness says otherwise; garbage is not a mode.
  assert.equal(sink.one("onboarding.open").attributes["engelbart.mode"], "test");
  assert.equal(T.deriveRun(sink.operations).mode, "test");
  const fixture = make();
  await fixture.telemetry.withRun({ test_run_id: "f", mode: "fixture" }, () => fixture.telemetry.runOperation({ name: "onboarding.open", type: "workflow" }, async () => {}));
  assert.equal(T.deriveRun(fixture.sink.operations).mode, "fixture");
  const bogus = make();
  await bogus.telemetry.withRun({ mode: "dream" }, () => bogus.telemetry.runOperation({ name: "onboarding.open", type: "workflow" }, async () => {}));
  assert.equal(T.deriveRun(bogus.sink.operations).mode, "live");
  assert.equal(T.deriveRun(bogus.sink.operations, { mode: "replay" }).mode, "replay");   // an explicit reader option wins
  assert.deepEqual(T.MODES, ["live", "test", "simulation", "replay", "fixture"]);
});

test("an explicit level overrides the central default through runOperation and startOperation, on the operation and its events", async () => {
  const { telemetry, sink } = make();
  await telemetry.runOperation({ name: "onboarding.analysis", type: "workflow" }, async () => {
    await telemetry.runOperation({ name: "db.select", type: "database", level: "stage" }, async () => {});   // a detail promoted
    const manual = telemetry.startOperation({ name: "paper.download", type: "storage", level: "detail" });   // a stage demoted
    manual.complete();
    await telemetry.runOperation({ name: "model.analysis", type: "model", level: "huge" }, async () => {});  // unknown: the default
    await telemetry.runOperation({ name: "analysis.context", type: "processing" }, async () => {});           // unset: the default
  });
  assert.equal(sink.one("db.select").level, "stage");
  assert.equal(sink.one("paper.download").level, "detail");
  assert.equal(sink.one("model.analysis").level, "stage");
  assert.equal(sink.one("analysis.context").level, "stage");
  assert.equal(sink.started.find((o) => o.name === "db.select").level, "stage");
  for (const [name, level] of [["db.select", "stage"], ["paper.download", "detail"], ["model.analysis", "stage"]]) {
    const events = sink.events.filter((e) => e.name === name);
    assert.deepEqual(events.map((e) => e.type), ["operation.started", "operation.completed"], name);
    assert.deepEqual(events.map((e) => e.level), [level, level], name);
  }
});

test("bundle() orders events by time, trace, sequence and id, not by the process-local sequence alone", () => {
  // Two traces from two function instances whose counters overlap: trace B's
  // events carry LOWER sequence numbers although they happened LATER.
  const A = "a".repeat(32); const B = "b".repeat(32);
  const ev = (trace, sequence, at, id) => ({ event_id: id, sequence, at, trace_id: trace, operation_id: `op-${trace[0]}`, type: "operation.progress" });
  const events = [
    ev(A, 10, "2026-09-05T10:00:00.000Z", "e1"), ev(A, 11, "2026-09-05T10:00:00.400Z", "e2"), ev(A, 12, "2026-09-05T10:00:01.000Z", "e3"),
    ev(B, 1, "2026-09-05T10:00:00.900Z", "e4"), ev(B, 2, "2026-09-05T10:00:01.000Z", "e5"), ev(B, 3, "2026-09-05T10:00:02.000Z", "e6"),
    ev(A, 13, "2026-09-05T10:00:01.000Z", "e0"),   // same instant as e3 and e5: trace, then sequence, then id
    ev(A, 13, "2026-09-05T10:00:01.000Z", "e7"),
  ];
  const want = ["e1", "e2", "e4", "e3", "e0", "e7", "e5", "e6"];
  assert.deepEqual(T.bundle({ events }).events.map((e) => e.event_id), want);
  assert.deepEqual(T.bundle({ events: [...events].reverse() }).events.map((e) => e.event_id), want);   // deterministic
  assert.notDeepEqual(want, [...events].sort((x, y) => x.sequence - y.sequence).map((e) => e.event_id));  // and not what sequence alone says
  // Within one trace the order still agrees with sequence.
  const a = T.bundle({ events }).events.filter((e) => e.trace_id === A).map((e) => e.sequence);
  assert.deepEqual(a, [...a].sort((x, y) => x - y));
  // Snapshots and operations also end on a unique key.
  const snaps = [{ snapshot_id: "s2", created_at: "t" }, { snapshot_id: "s1", created_at: "t" }];
  assert.deepEqual(T.bundle({ snapshots: snaps }).snapshots.map((s) => s.snapshot_id), ["s1", "s2"]);
});

test("a snapshot's bytes is the UTF-8 size of its stored content, and the stored content fits the cap even in the preview case", async () => {
  const Snapshots = require("../api/_lib/telemetry/snapshots");
  const CAP = Snapshots.MAX_SNAPSHOT_BYTES;
  const consistent = (out) => {
    assert.equal(out.bytes, Buffer.byteLength(JSON.stringify(out.content)));
    assert.ok(out.bytes <= CAP, `${out.bytes} > ${CAP}`);
  };
  // Rule 1: whole.
  consistent(Snapshots.bound({ a: "é".repeat(10) }));
  assert.equal(Snapshots.bound({ a: "é".repeat(10) }).truncated, false);
  // Rule 2: strings shortened, and the total measured after shortening.
  const rule2 = Snapshots.bound({ big: Array.from({ length: 6 }, () => "y".repeat(60000)) });
  consistent(rule2); assert.equal(rule2.truncated, true); assert.ok(!("[truncated]" in rule2.content));
  // Rule 3, the hard case: many short strings of 4-byte characters (surrogate pairs) plus
  // quotes and backslashes that JSON must escape twice inside the preview string.
  const noisy = Array.from({ length: 120 }, () => `${"😀".repeat(2500)}"\\"\\${"\u00e9".repeat(200)}`);   // 5,000+ units each: rule 2 shortens, still too big
  const rule3 = Snapshots.bound({ noisy });
  consistent(rule3);
  assert.equal(rule3.truncated, true);
  assert.equal(rule3.content["[truncated]"], true);
  assert.ok(rule3.content.original_bytes > rule3.content.shrunk_bytes && rule3.content.shrunk_bytes > CAP);
  assert.ok(rule3.content.preview.length > 1000);
  assert.ok(rule3.content.preview.length <= Math.floor(CAP / 2));
  const last = rule3.content.preview.charCodeAt(rule3.content.preview.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "the preview does not end in a lone high surrogate");
  assert.equal(JSON.stringify(rule3.content).length, JSON.stringify(JSON.parse(JSON.stringify(rule3.content))).length);  // round-trips
  // The same holds for a small cap, where the wrapper's own keys matter.
  for (const cap of [200, 300, 1000]) {
    const small = Snapshots.bound({ noisy }, cap);
    assert.equal(small.bytes, Buffer.byteLength(JSON.stringify(small.content)));
    assert.ok(small.bytes <= cap, `${small.bytes} > ${cap}`);
  }
  // And through the layer: the recorded snapshot says the same about itself.
  const { telemetry, sink } = make({ captureContent: true });
  await telemetry.runOperation({ name: "onboarding.analysis", type: "workflow" }, () =>
    telemetry.runOperation({ name: "model.analysis", type: "model" }, async (op) => { op.snapshot("model_raw_response", { noisy }); }));
  const recorded = sink.snapshots[0];
  assert.equal(recorded.bytes, Buffer.byteLength(JSON.stringify(recorded.content)));
  assert.ok(recorded.bytes <= CAP);
  assert.equal(recorded.truncated, true);
});

test("tests never persist or export: the shared layer stores nothing under the test runner, whatever the shell holds", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "node --test marks its processes");
  assert.equal(T.telemetry.settings.store, false);
  const creds = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
  assert.equal(T.readSettings({ ...creds, NODE_TEST_CONTEXT: "child-v8" }).store, false);
  assert.equal(T.readSettings({ ...creds, NODE_TEST_CONTEXT: "child-v8", ENGELBART_TELEMETRY_STORE: "true" }).store, true);  // unless asked in so many words
  assert.equal(T.readSettings(creds).store, true);
  assert.equal(T.readSettings(creds).captureContent, true);
  assert.equal(T.telemetry.sinks.some((s) => s instanceof T.SupabaseStoreSink), false);
});
