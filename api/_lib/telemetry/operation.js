"use strict";

// One operation: an execution with a lifetime (running -> completed/failed),
// backed by one OpenTelemetry span. Events happen INSIDE an operation and are
// span events plus live lifecycle events; they are never operations of their
// own. The record an operation renders (`toJSON`) is the Bart Operation
// entity described in docs/observability/data-contract.md.

const crypto = require("node:crypto");
const { sanitizeError } = require("./redaction");

const STATUS = Object.freeze({ running: "running", completed: "completed", failed: "failed", waiting: "waiting" });
const TYPES = Object.freeze(["workflow", "model", "database", "storage", "http", "processing"]);
const LEVELS = Object.freeze(["workflow", "stage", "detail"]);
const MAX_ATTRIBUTE_STRING = 2000;

// How much an operation means to a reader of the graph. A workflow is the
// root; a stage is a step of it worth showing on its own (the model call, the
// normalization, the persist); a detail is implementation the stage is made
// of (a row load, a generic db.* call, one page or link fetch). Decided here,
// once, from the name and type, so no consumer keeps a name map; a caller may
// still say `level` explicitly.
const DETAIL_NAMES = [
  /^db\./,                             // generic PostgREST operations
  /^(?:row|calibrations|turns)\.load$/, // the row and its companions, loaded on every action
  /^(?:[a-z-]+-)?page\.fetch$/,        // page.fetch, project-page.fetch, repo-page.fetch
  /^page\.extract-text$/,
  /^link\.check$/,
  /^(?:storage|auth)\.request$/,
];

function levelOf(name, type, given) {
  if (LEVELS.includes(given)) return given;
  if (type === "workflow") return "workflow";
  return DETAIL_NAMES.some((pattern) => pattern.test(String(name))) ? "detail" : "stage";
}

let sequence = 0;
function nextSequence() {
  sequence += 1;
  return sequence;
}

// Span attributes are scalars or arrays of scalars. Anything else is
// described briefly rather than dropped silently.
function attributeValue(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value.length > MAX_ATTRIBUTE_STRING ? `${value.slice(0, MAX_ATTRIBUTE_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v)));
  }
  return String(value).slice(0, MAX_ATTRIBUTE_STRING);
}

// Lineage names: the stored values an operation read or wrote, as the caller
// named them (the vocabulary is the application's, in the contract's
// *Lineage* section). Strings only, trimmed, deduplicated, in the order
// given; the attribute cap of 50 applies as to any array.
const LINEAGE_ATTRIBUTES = Object.freeze({ reads: "engelbart.lineage.reads", writes: "engelbart.lineage.writes" });
function lineageNames(names, have = []) {
  const out = have.slice();
  for (const name of [names].flat(Infinity)) {
    if (typeof name !== "string") continue;
    const clean = name.trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

class Operation {
  constructor(telemetry, spec) {
    this.telemetry = telemetry;
    this.enabled = true;
    this.span = spec.span;
    const ids = spec.span.spanContext();
    this.operation_id = crypto.randomUUID();
    this.trace_id = ids.traceId;
    this.span_id = ids.spanId;
    this.parent_span_id = spec.parentSpanId || null;
    this.name = String(spec.name);
    this.type = TYPES.includes(spec.type) ? spec.type : "processing";
    this.level = levelOf(this.name, this.type, spec.level);
    this.status = STATUS.running;
    this.started_at = new Date().toISOString();
    this.startedNs = process.hrtime.bigint();
    this.ended_at = null;
    this.duration_ms = null;
    this.attributes = {};
    this.snapshots = {};
    this.error = null;
    // The run is a shared, mutable object: a workflow learns its onboarding
    // id after its first database read, and every child started after that
    // sees it through this same reference.
    this.run = spec.run;
    // One record object per operation, updated in place by toJSON(): a sink
    // that keeps it sees the run id arrive even after the operation ended.
    this.record = null;
    if (this.run) (this.run.operations || (this.run.operations = [])).push(this);
    this.setAttributes({ "bart.operation_id": this.operation_id, "bart.type": this.type, ...(spec.attributes || {}) });
    if (spec.reads) this.reads(spec.reads);
    if (spec.writes) this.writes(spec.writes);
  }

  get ended() { return this.status !== STATUS.running && this.status !== STATUS.waiting; }

  // Lineage: which stored values this operation read and wrote, by name.
  // Recorded as two attributes so the store needs no new column; a name
  // given twice is kept once, and names accumulate across calls.
  reads(...names) { return this.lineage("reads", names); }
  writes(...names) { return this.lineage("writes", names); }
  lineage(kind, names) {
    const key = LINEAGE_ATTRIBUTES[kind];
    const list = lineageNames(names, Array.isArray(this.attributes[key]) ? this.attributes[key] : []);
    if (list.length) this.setAttribute(key, list);
    return this;
  }

  setAttribute(key, value) {
    const safe = attributeValue(this.telemetry.redactScalar(value));
    if (safe === undefined) return this;
    this.attributes[key] = safe;
    this.telemetry.safely("span attribute", () => this.span.setAttribute(key, safe));
    return this;
  }

  setAttributes(values) {
    for (const [key, value] of Object.entries(values || {})) this.setAttribute(key, value);
    return this;
  }

  // Something that happened inside the operation: a retry, a fallback, a
  // stage reached. A span event, and an `operation.progress` live event.
  event(name, attributes = {}) {
    if (this.ended) return this;
    const safe = {};
    for (const [key, value] of Object.entries(attributes || {})) {
      const v = attributeValue(this.telemetry.redactScalar(value));
      if (v !== undefined) safe[key] = v;
    }
    this.telemetry.safely("span event", () => this.span.addEvent(name, safe));
    this.telemetry.emit("operation.progress", this, { progress: { message: String(name), ...safe } });
    return this;
  }

  // Mark the operation as waiting on something outside it (a poll that finds
  // a reader still running, a leveled run waiting for the hunt).
  waiting(reason) {
    if (this.ended) return this;
    this.status = STATUS.waiting;
    if (reason) this.setAttribute("bart.waiting_reason", reason);
    return this;
  }

  // A payload snapshot attached to this operation, by kind. Returns the
  // snapshot id, or null when detailed capture is off or the value is empty.
  snapshot(kind, value, options = {}) {
    const id = this.telemetry.captureSnapshot(this, kind, value, options);
    if (id) {
      this.snapshots[kind] = id;
      this.setAttribute(`bart.snapshot.${kind}`, id);
    }
    return id;
  }

  complete(attributes) {
    if (this.ended) return this;
    if (attributes) this.setAttributes(attributes);
    this.status = STATUS.completed;
    this.finish();
    this.telemetry.safely("span status", () => this.span.setStatus({ code: this.telemetry.otel.api.SpanStatusCode.OK }));
    this.telemetry.safely("span end", () => this.span.end());
    this.telemetry.ended(this);
    this.telemetry.emit("operation.completed", this);
    return this;
  }

  fail(error, attributes) {
    if (this.ended) return this;
    if (attributes) this.setAttributes(attributes);
    this.status = STATUS.failed;
    this.error = sanitizeError(error, { secrets: this.telemetry.secrets() }) || { name: "Error", message: "failed" };
    this.finish();
    this.telemetry.safely("span exception", () => {
      this.span.recordException({ name: this.error.name, message: this.error.message });
      this.span.setStatus({ code: this.telemetry.otel.api.SpanStatusCode.ERROR, message: this.error.message });
    });
    this.setAttributes({ "error.type": this.error.name, "bart.error.status_code": this.error.statusCode });
    this.snapshot("error_detail", sanitizeError(error, { secrets: this.telemetry.secrets(), stack: true }));
    this.telemetry.safely("span end", () => this.span.end());
    this.telemetry.ended(this);
    this.telemetry.emit("operation.failed", this, { error: this.error });
    return this;
  }

  finish() {
    this.ended_at = new Date().toISOString();
    this.duration_ms = Number(process.hrtime.bigint() - this.startedNs) / 1e6;
  }

  // The Bart Operation entity. The same object every time, refreshed.
  toJSON() {
    const run = this.run || {};
    this.record = this.record || {};
    return Object.assign(this.record, {
      operation_id: this.operation_id,
      trace_id: this.trace_id,
      span_id: this.span_id,
      parent_span_id: this.parent_span_id,
      run_id: run.run_id || null,
      onboarding_id: run.onboarding_id || null,
      test_run_id: run.test_run_id || null,
      action: run.action || null,
      name: this.name,
      type: this.type,
      level: this.level,
      status: this.status,
      started_at: this.started_at,
      ended_at: this.ended_at,
      duration_ms: this.duration_ms == null ? null : Math.round(this.duration_ms * 1000) / 1000,
      attributes: { ...this.attributes },
      snapshots: { ...this.snapshots },
      error: this.error ? { name: this.error.name, message: this.error.message,
        status_code: this.error.statusCode == null ? null : this.error.statusCode,
        code: this.error.code || null, detail: this.error.detail || null } : null,
      environment: run.environment || null,
      code_version: run.code_version || null,
      deployment: run.deployment || null,
    });
  }
}

// What an operation is when tracing is suppressed (a routine poll) or when
// the telemetry layer itself failed to start one: every method is safe to
// call and does nothing.
class NoopOperation {
  constructor() {
    this.enabled = false;
    this.operation_id = null;
    this.trace_id = "";
    this.span_id = "";
    this.parent_span_id = null;
    this.name = "";
    this.type = "processing";
    this.level = "detail";
    this.status = STATUS.running;
    this.attributes = {};
    this.snapshots = {};
    this.error = null;
    this.run = null;
  }
  get ended() { return false; }
  setAttribute() { return this; }
  setAttributes() { return this; }
  reads() { return this; }
  writes() { return this; }
  event() { return this; }
  waiting() { return this; }
  snapshot() { return null; }
  complete() { return this; }
  fail() { return this; }
  toJSON() { return null; }
}

module.exports = { LEVELS, LINEAGE_ATTRIBUTES, NoopOperation, Operation, STATUS, TYPES, attributeValue, levelOf, lineageNames, nextSequence };
