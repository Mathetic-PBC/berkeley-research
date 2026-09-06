"use strict";

// OpenTelemetry, loaded once per process and kept behind one small surface.
// It is the engine for trace ids, span ids, parent links, timing, status,
// exceptions and async context; nothing else in Engelbart imports it. The
// exporter is OTLP/HTTP and entirely environment-driven (the standard
// OTEL_EXPORTER_OTLP_* variables); with no endpoint set, spans are still
// created -- their ids are what the Bart records and live events carry --
// and simply never leave the process.
//
// Each Vercel function is its own bundle, so "once per process" is once per
// function instance. There is no auto-instrumentation here, so import order
// does not matter: the SDK is initialised on first use, and every span is one
// the telemetry layer starts by hand.
//
// Should the SDK fail to load at all, a tiny shim with the same surface takes
// its place, so telemetry degrades to local ids and onboarding is unaffected.

const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const STATE = Symbol.for("engelbart.telemetry.otel");
const INSTRUMENTATION = "engelbart.bart";
const INSTRUMENTATION_VERSION = "0.1.0";

function resourceAttributes(env) {
  const out = {
    "service.name": env.OTEL_SERVICE_NAME || env.ENGELBART_TELEMETRY_SERVICE_NAME || "engelbart-onboarding",
    "deployment.environment.name": env.VERCEL_ENV || env.NODE_ENV || "development",
  };
  if (env.VERCEL_GIT_COMMIT_SHA) out["service.version"] = String(env.VERCEL_GIT_COMMIT_SHA).slice(0, 12);
  if (env.VERCEL_DEPLOYMENT_ID) out["deployment.id"] = env.VERCEL_DEPLOYMENT_ID;
  if (env.VERCEL_REGION) out["cloud.region"] = env.VERCEL_REGION;
  return out;
}

function exportEndpoint(env) {
  return String(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim();
}

function loadSdk(env, options) {
  const api = require("@opentelemetry/api");
  const { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor } = require("@opentelemetry/sdk-trace-node");
  const { defaultResource, resourceFromAttributes } = require("@opentelemetry/resources");
  const spanProcessors = [...(options.spanProcessors || [])];
  const endpoint = exportEndpoint(env);
  if (endpoint && !options.spanProcessors) {
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    // The exporter reads the OTEL_EXPORTER_OTLP_* variables itself (endpoint,
    // headers, timeout). Batched, and flushed by hand at the end of every
    // request: a serverless function must not count on the batch timer.
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter(), {
      scheduledDelayMs: 1000, maxExportBatchSize: 256, exportTimeoutMillis: Number(env.ENGELBART_TELEMETRY_FLUSH_MS) || 2000,
    }));
  }
  if (options.exporter) spanProcessors.push(new SimpleSpanProcessor(options.exporter));
  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes(resourceAttributes(env))),
    spanProcessors,
  });
  // Global tracer provider, AsyncLocalStorage context manager and the W3C
  // propagators. Idempotent per process because this function runs once.
  provider.register();
  return {
    available: true,
    exporting: Boolean(endpoint),
    error: null,
    api: { trace: api.trace, context: api.context, SpanStatusCode: api.SpanStatusCode,
      ROOT_CONTEXT: api.ROOT_CONTEXT, createContextKey: api.createContextKey },
    tracer: provider.getTracer(INSTRUMENTATION, INSTRUMENTATION_VERSION),
    provider,
    forceFlush: () => provider.forceFlush(),
  };
}

// --- the shim: same surface, local ids, no export ----------------------------

function shim(error) {
  const storage = new AsyncLocalStorage();
  class Context {
    constructor(values = new Map()) { this.values = values; }
    getValue(key) { return this.values.get(key); }
    setValue(key, value) { const next = new Map(this.values); next.set(key, value); return new Context(next); }
  }
  const ROOT_CONTEXT = new Context();
  const SPAN_KEY = Symbol("shim.span");
  class Span {
    constructor(name, traceId) {
      this.name = name;
      this.ids = { traceId, spanId: crypto.randomBytes(8).toString("hex"), traceFlags: 1 };
      this.attributes = {};
      this.events = [];
      this.status = { code: 0 };
      this.ended = false;
    }
    spanContext() { return this.ids; }
    setAttribute(key, value) { this.attributes[key] = value; return this; }
    setAttributes(values) { Object.assign(this.attributes, values); return this; }
    addEvent(name, attributes) { this.events.push({ name, attributes }); return this; }
    setStatus(status) { this.status = status; return this; }
    recordException() { return this; }
    isRecording() { return !this.ended; }
    end() { this.ended = true; }
  }
  const trace = {
    getSpan: (ctx) => ctx.getValue(SPAN_KEY),
    setSpan: (ctx, span) => ctx.setValue(SPAN_KEY, span),
  };
  const context = {
    active: () => storage.getStore() || ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.apply(thisArg, args)),
  };
  const tracer = {
    startSpan(name, options = {}, ctx = context.active()) {
      const parent = trace.getSpan(ctx);
      const span = new Span(name, parent ? parent.spanContext().traceId : crypto.randomBytes(16).toString("hex"));
      if (options.attributes) span.setAttributes(options.attributes);
      return span;
    },
  };
  return {
    available: false,
    exporting: false,
    error,
    api: { trace, context, SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 }, ROOT_CONTEXT, createContextKey: (name) => Symbol(name) },
    tracer,
    provider: null,
    forceFlush: async () => {},
  };
}

// options.spanProcessors / options.exporter are for tests, honoured only on
// the first load in a process.
function load(options = {}) {
  if (global[STATE]) return global[STATE];
  const env = options.env || process.env;
  let state;
  try {
    state = loadSdk(env, options);
  } catch (error) {
    console.error("engelbart-telemetry: OpenTelemetry unavailable, using local ids:", String(error && error.message || error).slice(0, 200));
    state = shim(error);
  }
  global[STATE] = state;
  return state;
}

module.exports = { INSTRUMENTATION, exportEndpoint, load, resourceAttributes };
