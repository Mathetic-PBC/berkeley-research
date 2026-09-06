"use strict";

// Where Bart records go. A sink is any object with some of:
//
//   onOperationStart(operation)   the Operation entity, status "running"
//   onOperationEnd(operation)     the Operation entity, completed or failed
//   onSnapshot(snapshot)          the Snapshot entity
//   onEvent(event)                the Event entity (a LiveEventSink)
//   flush()                       settle anything buffered; awaited, bounded
//
// Every call is made through the telemetry layer's `safely`, so a sink that
// throws costs a log line and nothing else. Three are provided: memory (tests,
// the simulator), console (JSON lines in the function log), and the Supabase
// store (three tables, on wherever the service role is configured).

const MEMORY_LIMIT = 5000;

class MemorySink {
  constructor(limit = MEMORY_LIMIT) {
    this.limit = limit;
    this.clear();
  }
  clear() {
    this.started = [];
    this.operations = [];
    this.snapshots = [];
    this.events = [];
  }
  keep(list, item) {
    list.push(item);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
  }
  onOperationStart(operation) { this.keep(this.started, operation); }
  onOperationEnd(operation) { this.keep(this.operations, operation); }
  onSnapshot(snapshot) { this.keep(this.snapshots, snapshot); }
  onEvent(event) { this.keep(this.events, event); }
  async flush() {}

  byName(name) { return this.operations.filter((o) => o.name === name); }
  one(name) {
    const found = this.byName(name);
    if (found.length !== 1) throw new Error(`expected one operation named ${name}, found ${found.length}`);
    return found[0];
  }
  childrenOf(operation) { return this.operations.filter((o) => o.parent_span_id === operation.span_id); }
  snapshotsOf(operation) { return this.snapshots.filter((s) => s.operation_id === operation.operation_id); }
  // The whole record set for one trace, in the contract's envelope shape.
  trace(traceId) {
    return {
      operations: this.operations.filter((o) => o.trace_id === traceId),
      snapshots: this.snapshots.filter((s) => s.trace_id === traceId),
      events: this.events.filter((e) => e.trace_id === traceId),
    };
  }
}

class ConsoleSink {
  constructor(options = {}) {
    this.write = options.write || ((line) => console.log(line));
  }
  onOperationEnd(operation) {
    this.write(`engelbart-telemetry operation ${JSON.stringify(operation)}`);
  }
  onEvent(event) {
    if (event.type === "operation.progress" || event.type === "operation.failed") {
      this.write(`engelbart-telemetry event ${JSON.stringify(event)}`);
    }
  }
  async flush() {}
}

// The four entities persisted through the shared PostgREST boundary. Writes
// are batched: events soon after they happen (a timer, so a minute-long
// model call shows up as running while it runs), operations and snapshots
// at flush(), which the request handler awaits before it responds. Its own
// requests are `trace: false`, or the store would trace itself forever.
class SupabaseStoreSink {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl || null;
    this.eventDelayMs = Number(options.eventDelayMs) || 250;
    this.log = options.log || ((message) => console.error(message));
    this.operations = new Map();
    this.snapshots = [];
    this.events = [];
    this.pending = new Set();
    this.timer = null;
  }
  onOperationEnd(operation) { this.operations.set(operation.operation_id, operation); }
  onSnapshot(snapshot) { this.snapshots.push(snapshot); }
  onEvent(event) {
    this.events.push(event);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.track(this.flushEvents()); }, this.eventDelayMs);
      if (typeof this.timer.unref === "function") this.timer.unref();
    }
  }
  track(promise) {
    const p = Promise.resolve(promise).catch((error) => {
      this.log(`engelbart-telemetry: store write failed: ${String(error && error.message || error).slice(0, 200)}`);
    }).finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }
  async write(table, rows, query) {
    if (!rows.length) return;
    const { serviceRequest } = require("../supabase");
    await serviceRequest(`/rest/v1/${table}${query ? `?${query}` : ""}`, {
      method: "POST", body: rows, trace: false, env: this.env, fetchImpl: this.fetchImpl || undefined,
      headers: { Prefer: query ? "resolution=merge-duplicates,return=minimal" : "return=minimal" },
    });
  }
  async flushEvents() {
    const events = this.events.splice(0);
    await this.write("engelbart_telemetry_events", events);
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const operations = [...this.operations.values()];
    this.operations.clear();
    const snapshots = this.snapshots.splice(0);
    this.track(this.flushEvents());
    this.track(this.write("engelbart_telemetry_operations", operations, "on_conflict=operation_id"));
    this.track(this.write("engelbart_telemetry_snapshots", snapshots));
    await Promise.all([...this.pending]);
  }
}

module.exports = { ConsoleSink, MemorySink, SupabaseStoreSink };
