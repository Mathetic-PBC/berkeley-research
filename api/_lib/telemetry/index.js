"use strict";

// Bart telemetry: the one small API the rest of Engelbart talks to.
//
//   const { telemetry } = require("./telemetry");
//
//   await telemetry.runOperation({ name: "assets.normalize", type: "processing" }, async (op) => {
//     op.setAttribute("engelbart.assets", assets.length);
//     op.snapshot("normalized_result", assets);
//     return assets;
//   });
//
// or, by hand:
//
//   const op = telemetry.startOperation({ name: "paper.download", type: "storage" });
//   try { ...; op.complete(); } catch (error) { op.fail(error); throw error; }
//
// Underneath, an operation is an OpenTelemetry span (otel.js), and the layer
// takes care of the parent link through async context, the redaction of
// everything recorded (redaction.js), the payload snapshots (snapshots.js),
// the live lifecycle events (live.js) and where all of it goes (sinks.js).
//
// Observability is subordinate to the product: nothing in here may throw into
// onboarding. Every sink and span call runs through `safely`; a start that
// fails hands back a no-op operation and the work proceeds untraced.

const crypto = require("node:crypto");
const Contract = require("./contract");
const Otel = require("./otel");
const Live = require("./live");
const Redaction = require("./redaction");
const Sinks = require("./sinks");
const Snapshots = require("./snapshots");
const { LEVELS, NoopOperation, Operation, STATUS, TYPES, levelOf } = require("./operation");

const MAX_LOGGED_ERRORS = 20;
const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

// An explicit `true`/`false` wins; anything else (unset, blank, a typo) is
// the default the caller names.
function flag(env, name, fallback = false) {
  const value = String(env[name] || "").trim().toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  return fallback;
}

// Persistence needs the service role; without it there is nowhere to write.
// Under the node test runner (which sets NODE_TEST_CONTEXT in every test
// process) nothing is written by default either: a test suite that inherits
// real credentials from its shell must not record itself into production.
function canStore(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && !env.NODE_TEST_CONTEXT);
}

// Everything the environment decides. Capture and persistence are on wherever
// they can work, so a deployment records itself without configuration. Set
// `ENGELBART_TRACE_CONTENT=false` to keep prompts, replies, page text and row
// bodies out of storage (operations, relationships, timing, safe metadata and
// sanitized errors are still recorded), or `ENGELBART_TELEMETRY_STORE=false`
// to persist nothing at all.
function readSettings(env) {
  return {
    captureContent: flag(env, "ENGELBART_TRACE_CONTENT", true),
    tracePolls: flag(env, "ENGELBART_TRACE_POLLS", false),
    store: flag(env, "ENGELBART_TELEMETRY_STORE", canStore(env)),
    log: flag(env, "ENGELBART_TELEMETRY_LOG", false),
    flushMs: Number(env.ENGELBART_TELEMETRY_FLUSH_MS) || 2000,
  };
}

// How a run came to be. Real member requests are `live`; a harness that names
// its run is `test`; the generated example is `fixture`. `simulation` and
// `replay` are reserved for the contract's future and produce nothing today.
const MODES = Object.freeze(["live", "test", "simulation", "replay", "fixture"]);

function runDefaults(env) {
  return {
    run_id: null,
    onboarding_id: null,
    test_run_id: null,
    user_hash: null,
    action: null,
    mode: "live",
    environment: env.VERCEL_ENV || env.NODE_ENV || "development",
    code_version: env.VERCEL_GIT_COMMIT_SHA ? String(env.VERCEL_GIT_COMMIT_SHA).slice(0, 12) : null,
    deployment: env.VERCEL_DEPLOYMENT_ID || null,
  };
}

function runAttributes(run) {
  const out = {};
  for (const key of ["run_id", "onboarding_id", "test_run_id", "action", "user_hash", "mode"]) {
    if (run && run[key] != null) out[`engelbart.${key}`] = run[key];
  }
  return out;
}

// A member is named in telemetry by a short hash of their id, never by email.
function userHash(userId) {
  if (!userId) return null;
  return crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 16);
}

class Telemetry {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.otel = options.otel || Otel.load({ env: this.env, spanProcessors: options.spanProcessors, exporter: options.exporter });
    this.settings = { ...readSettings(this.env), ...(options.settings || {}) };
    this.sinks = [];
    this.logged = 0;
    this.extraSecrets = new Set();
    this.secretCache = null;
    const { createContextKey } = this.otel.api;
    this.RUN_KEY = createContextKey("engelbart.telemetry.run");
    this.OPERATION_KEY = createContextKey("engelbart.telemetry.operation");
    this.SUPPRESS_KEY = createContextKey("engelbart.telemetry.suppress");
    if (options.sinks) for (const sink of options.sinks) this.addSink(sink);
    if (this.settings.log && !options.sinks) this.addSink(new Sinks.ConsoleSink());
    if (this.settings.store && !options.sinks) this.addSink(new Sinks.SupabaseStoreSink({ env: this.env }));
  }

  // --- configuration -----------------------------------------------------------

  configure(settings) {
    Object.assign(this.settings, settings || {});
    return this;
  }

  addSink(sink) {
    this.sinks.push(sink);
    return () => { this.sinks = this.sinks.filter((s) => s !== sink); };
  }

  // A secret learned at runtime (a member's model key) joins the redaction set.
  protect(value) {
    const s = String(value || "");
    if (s.length >= 8) { this.extraSecrets.add(s); this.secretCache = null; }
    return this;
  }

  secrets() {
    if (!this.secretCache) this.secretCache = Redaction.secretValues(this.env, [...this.extraSecrets]);
    return this.secretCache;
  }

  redact(value, options = {}) {
    return Redaction.redact(value, { secrets: this.secrets(), ...options });
  }

  redactScalar(value) {
    if (typeof value !== "string") return value;
    return Redaction.redact(value, { secrets: this.secrets(), maxString: 4000 });
  }

  // --- never into the product ----------------------------------------------------

  log(message) {
    if (this.logged >= MAX_LOGGED_ERRORS) return;
    this.logged += 1;
    console.error(`engelbart-telemetry: ${message}`);
  }

  safely(what, fn) {
    try {
      const out = fn();
      if (out && typeof out.then === "function") {
        out.catch((error) => this.log(`${what} failed: ${String(error && error.message || error).slice(0, 200)}`));
      }
      return out;
    } catch (error) {
      this.log(`${what} failed: ${String(error && error.message || error).slice(0, 200)}`);
      return undefined;
    }
  }

  fanout(method, record) {
    for (const sink of this.sinks) {
      if (typeof sink[method] === "function") this.safely(`sink ${method}`, () => sink[method](record));
    }
  }

  // --- context -----------------------------------------------------------------------

  active() { return this.otel.api.context.active(); }
  current() { return this.active().getValue(this.OPERATION_KEY) || null; }
  suppressed() { return this.active().getValue(this.SUPPRESS_KEY) === true; }
  run() { return this.active().getValue(this.RUN_KEY) || null; }

  // Run everything inside `fn` with tracing off: no operations, no events.
  // Routine polls go through here so fifteen identical status checks do not
  // become fifteen identical nodes.
  untraced(fn) {
    return this.otel.api.context.with(this.active().setValue(this.SUPPRESS_KEY, true), fn);
  }

  // Run `fn` inside a fresh run context (the Bart Run). Operations started
  // within inherit its ids as attributes and in their records.
  withRun(seed, fn) {
    const run = { ...runDefaults(this.env), ...(seed || {}) };
    // A mode the caller named stands; otherwise a named test run is `test`.
    if (!MODES.includes(seed && seed.mode)) run.mode = run.test_run_id ? "test" : "live";
    if (!run.run_id) run.run_id = run.onboarding_id || (run.test_run_id ? `test:${run.test_run_id}` : null);
    return this.otel.api.context.with(this.active().setValue(this.RUN_KEY, run), fn);
  }

  // Learn something about the current run after it started (the onboarding
  // id, once the row is read). The shared run object updates for every child
  // started from here on, and the current operation records it too.
  setRun(patch) {
    const run = this.run();
    if (!run) return null;
    const values = { ...(patch || {}) };
    if (values.user_id) { values.user_hash = userHash(values.user_id); delete values.user_id; }
    Object.assign(run, values);
    if (!run.run_id || (values.onboarding_id && run.run_id.startsWith("test:"))) {
      run.run_id = run.onboarding_id || (run.test_run_id ? `test:${run.test_run_id}` : null);
    }
    const op = this.current();
    if (op) op.setAttributes(runAttributes(run));
    // Operations that ended before the row was read (the row loads
    // themselves) learn the run id now: their records are live objects.
    this.safely("run back-fill", () => { for (const earlier of run.operations || []) earlier.toJSON(); });
    return run;
  }

  // --- operations ---------------------------------------------------------------------

  // spec = { name, type, level?, attributes?, parent? }. `parent` is an
  // Operation, for the manual form when the caller is not inside
  // runOperation; `level` overrides the central default (levelOf).
  startOperation(spec) {
    if (this.suppressed()) return new NoopOperation();
    try {
      const { trace, context } = this.otel.api;
      let ctx = context.active();
      if (spec.parent && spec.parent.enabled) ctx = trace.setSpan(ctx, spec.parent.span);
      const parentSpan = trace.getSpan(ctx);
      const run = (spec.parent && spec.parent.run) || ctx.getValue(this.RUN_KEY) || runDefaults(this.env);
      const span = this.otel.tracer.startSpan(String(spec.name), {}, ctx);
      const op = new Operation(this, {
        span, name: spec.name, type: spec.type, level: spec.level, run,
        parentSpanId: parentSpan ? parentSpan.spanContext().spanId : null,
        attributes: { ...runAttributes(run), ...(spec.attributes || {}) },
      });
      this.fanout("onOperationStart", op.toJSON());
      this.emit("operation.started", op);
      return op;
    } catch (error) {
      this.log(`could not start operation ${spec && spec.name}: ${String(error && error.message || error).slice(0, 200)}`);
      return new NoopOperation();
    }
  }

  contextFor(op) {
    const { trace } = this.otel.api;
    return trace.setSpan(this.active(), op.span).setValue(this.OPERATION_KEY, op).setValue(this.RUN_KEY, op.run);
  }

  // The preferred form. `fn(op)` runs with `op` as the active parent, is
  // completed when it returns and failed when it throws; the original error is
  // rethrown untouched.
  async runOperation(spec, fn) {
    const op = this.startOperation(spec);
    if (!op.enabled) return fn(op);
    return this.otel.api.context.with(this.contextFor(op), async () => {
      try {
        const out = await fn(op);
        op.complete();
        return out;
      } catch (error) {
        op.fail(error);
        throw error;
      }
    });
  }

  // --- records ----------------------------------------------------------------------------

  captureSnapshot(operation, kind, value, options = {}) {
    if (!operation.enabled) return null;
    if (!this.settings.captureContent && !options.force) return null;
    if (value === undefined) return null;
    return this.safely("snapshot", () => {
      const snapshot = Snapshots.build(operation, kind, this.redact(value), options);
      this.fanout("onSnapshot", snapshot);
      return snapshot.snapshot_id;
    }) || null;
  }

  emit(type, operation, extra) {
    if (!operation.enabled) return;
    this.safely("event", () => this.fanout("onEvent", Live.lifecycleEvent(type, operation, extra)));
  }

  ended(operation) {
    this.fanout("onOperationEnd", operation.toJSON());
  }

  // Settle exported spans and buffered records, within a bound. The request
  // handler awaits this before it responds, because a Vercel function is
  // frozen once the response is out and a batch left in memory never lands.
  async flush(timeoutMs) {
    const budget = Number(timeoutMs) || this.settings.flushMs;
    const work = Promise.all([
      this.safely("otel flush", () => this.otel.forceFlush()),
      ...this.sinks.map((sink) => (typeof sink.flush === "function" ? this.safely("sink flush", () => sink.flush()) : null)),
    ]);
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), budget); });
    try {
      const outcome = await Promise.race([work.then(() => "flushed"), deadline]);
      if (outcome === "timeout") this.log(`flush exceeded ${budget} ms; continuing without waiting`);
      return outcome;
    } catch (error) {
      this.log(`flush failed: ${String(error && error.message || error).slice(0, 200)}`);
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }
}

function createTelemetry(options) {
  return new Telemetry(options);
}

const telemetry = new Telemetry();

module.exports = {
  Telemetry,
  LEVELS,
  MODES,
  STATUS,
  TYPES,
  levelOf,
  ConsoleSink: Sinks.ConsoleSink,
  MemorySink: Sinks.MemorySink,
  SupabaseStoreSink: Sinks.SupabaseStoreSink,
  LiveEventSink: Live.LiveEventSink,
  MemoryLiveSink: Live.MemoryLiveSink,
  EVENT_TYPES: Live.EVENT_TYPES,
  SNAPSHOT_KINDS: Snapshots.KINDS,
  CONTRACT_VERSION: Contract.CONTRACT_VERSION,
  bundle: Contract.bundle,
  compareEvents: Contract.compareEvents,
  deriveRun: Contract.deriveRun,
  tree: Contract.tree,
  MAX_SNAPSHOT_BYTES: Snapshots.MAX_SNAPSHOT_BYTES,
  createTelemetry,
  readSettings,
  telemetry,
  userHash,
};
