"use strict";

// Live lifecycle events. OpenTelemetry exports a span when it ends, which is
// too late for a graph that wants to show an operation the moment it starts.
// So every operation also emits `operation.started`, `operation.progress`,
// `operation.completed` and `operation.failed` -- the Bart Event entity
// (docs/observability/data-contract.md) -- carrying the SAME trace id, span
// id and parent span id as the span, so an event and its span are one thing.
//
// Transport is deliberately thin: a LiveEventSink is anything with
// `onEvent(event)`. The in-process memory sink below is what tests and the
// simulator consume; the Supabase store sink (sinks.js) persists events for a
// poller. Push delivery to a browser is the one piece not built here; see
// the contract document for what it needs.

const crypto = require("node:crypto");
const { nextSequence } = require("./operation");

const EVENT_TYPES = Object.freeze(["operation.started", "operation.progress", "operation.completed", "operation.failed"]);

function lifecycleEvent(type, operation, extra = {}) {
  const run = operation.run || {};
  const event = {
    event_id: crypto.randomUUID(),
    sequence: nextSequence(),
    type: EVENT_TYPES.includes(type) ? type : "operation.progress",
    at: new Date().toISOString(),
    operation_id: operation.operation_id,
    trace_id: operation.trace_id,
    span_id: operation.span_id,
    parent_span_id: operation.parent_span_id,
    run_id: run.run_id || null,
    onboarding_id: run.onboarding_id || null,
    test_run_id: run.test_run_id || null,
    action: run.action || null,
    name: operation.name,
    operation_type: operation.type,
    level: operation.level,
    status: operation.status,
  };
  if (type === "operation.started" || type === "operation.completed" || type === "operation.failed") {
    event.attributes = { ...operation.attributes };
  }
  if (type === "operation.completed" || type === "operation.failed") {
    event.duration_ms = operation.duration_ms == null ? null : Math.round(operation.duration_ms * 1000) / 1000;
    event.snapshots = { ...operation.snapshots };
  }
  if (extra.progress) event.progress = extra.progress;
  if (extra.error) {
    event.error = { name: extra.error.name, message: extra.error.message,
      status_code: extra.error.statusCode == null ? null : extra.error.statusCode };
  }
  return event;
}

// The interface. Subclass or duck-type it; `onEvent` may return a promise,
// which the telemetry layer tracks but never waits on in the request path.
class LiveEventSink {
  onEvent(event) { void event; } // eslint-disable-line class-methods-use-this
  async flush() {} // eslint-disable-line class-methods-use-this
}

class MemoryLiveSink extends LiveEventSink {
  constructor(limit = 5000) {
    super();
    this.limit = limit;
    this.events = [];
  }
  onEvent(event) {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }
  ofType(type) { return this.events.filter((e) => e.type === type); }
  forOperation(operationId) { return this.events.filter((e) => e.operation_id === operationId); }
  clear() { this.events = []; }
}

module.exports = { EVENT_TYPES, LiveEventSink, MemoryLiveSink, lifecycleEvent };
