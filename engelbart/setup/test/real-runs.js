/* Real mode for the Engelbart debugger: the member's own recorded onboarding
 * telemetry, read through /api/engelbart-telemetry and shaped into the runs,
 * stages and operations the debugger already draws.
 *
 * The source of truth is the telemetry contract (docs/observability/
 * data-contract.md): a workflow root becomes a request row, the operations
 * beneath it become that row's operation rows, and snapshots of every kind
 * become the inspector's tabs, and the lineage attributes
 * (engelbart.lineage.reads / .writes) become the operation's reads and
 * writes, which the Data flow view draws. Nothing is added that was not
 * recorded: no cost, no request bodies the server did not keep, and no edge
 * for a run recorded before lineage was.
 *
 * What the browser saw is a second source: in Real mode the frame reports
 * every request the product makes, and the reply names its trace
 * (x-engelbart-trace-id). A reported request joins the trace's root row by
 * that id, carrying the request and reply as the browser sent and received
 * them; a request the server did not trace (a status poll, the config read,
 * the upload straight to Storage) is a row of its own with no operations,
 * and a run of polls folds into one row.
 *
 * Reading telemetry never changes anything. Loads under Node as well as in
 * the browser, so the mapping is testable. */
(function (root) {
  "use strict";

  // The contract's operation types, as the debugger's kinds.
  var KIND_OF_TYPE = { workflow: "api", model: "model", database: "db", storage: "storage", http: "web", processing: "processing" };
  // Which snapshot kinds are the operation's input, and which its output; the
  // rest keep their own tab, named by kind, so nothing recorded is hidden.
  var INPUT_KINDS = ["model_request", "database_request", "processing_input"];
  var OUTPUT_KINDS = ["model_parsed_response", "database_response", "processing_output", "normalized_result", "page_text"];
  // The endpoints the product talks to, as the surfaces the simulator names.
  var SURFACES = [[/engelbart-onboarding/, "onboarding"], [/engelbart-device/, "device"], [/engelbart-setup/, "setup"], [/engelbart-config/, "config"], [/engelbart-telemetry/, "telemetry"]];

  function kindOf(op) {
    if (op.type === "http" && /^(litellm|credit|key)\b/.test(String(op.name || ""))) return "api";
    return KIND_OF_TYPE[op.type] || "processing";
  }
  function statusOf(status) { return status === "completed" ? "ok" : status === "failed" ? "error" : "running"; }
  function when(iso) { var t = Date.parse(iso || ""); return isNaN(t) ? 0 : t; }
  function durationOf(op) {
    if (op.duration_ms != null && !isNaN(Number(op.duration_ms))) return Number(op.duration_ms);
    if (op.started_at && op.ended_at) return Math.max(0, when(op.ended_at) - when(op.started_at));
    return 0;
  }
  function join(parts, sep) { return parts.filter(function (p) { return p != null && p !== ""; }).join(sep || " "); }

  // The one line under an operation's name: where it went, from the attributes the boundary recorded.
  function targetOf(op) {
    var a = op.attributes || {};
    switch (op.type) {
      case "database": return join([a["http.request.method"] || a["db.operation.name"], join([a["url.path"], a["db.query.summary"]], "?")]);
      case "model": return join([a["gen_ai.request.model"], a["server.address"] ? "via " + a["server.address"] : null]);
      case "storage": return join([a["http.request.method"], join([a["engelbart.storage.bucket"], a["engelbart.storage.object"]], "/")]);
      case "http": return join([a["http.request.method"], a["url.full"] || a["server.address"]]);
      case "workflow": return join([a["engelbart.action"] ? "action " + a["engelbart.action"] : null]);
      default: return a["engelbart.model.purpose"] || "";
    }
  }
  function tokensOf(a) {
    var t = {};
    var pick = function (key, attr) { var v = a[attr]; if (v != null && !isNaN(Number(v))) t[key] = Number(v); };
    pick("input", "gen_ai.usage.input_tokens"); pick("output", "gen_ai.usage.output_tokens");
    pick("cache_read", "engelbart.model.cache_read_input_tokens"); pick("cache_write", "engelbart.model.cache_creation_input_tokens");
    pick("web_searches", "engelbart.model.web_searches");
    return t;
  }
  function metaOf(op) {
    var a = op.attributes || {}, m = {};
    if (op.type === "model") {
      m.model = a["gen_ai.response.model"] || a["gen_ai.request.model"] || null;
      m.family = a["engelbart.model.family"] || null;
      m.purpose = a["engelbart.model.purpose"] || null;
      m.gateway = a["engelbart.model.gateway"] || null;
      m.tokens = tokensOf(a);
      m.finish = Array.isArray(a["gen_ai.response.finish_reasons"]) ? a["gen_ai.response.finish_reasons"].join(", ") : null;
    }
    if (a["http.response.status_code"] != null) m.code = a["http.response.status_code"];
    return m;
  }
  // Snapshot ids by role. `snapshots` on an operation is {kind: snapshot_id}.
  function snapsOf(op) {
    var ids = op.snapshots || {}, out = { input: null, output: null, raw: null, error: null, extra: [] };
    Object.keys(ids).forEach(function (kind) {
      var id = ids[kind]; if (!id) return;
      if (INPUT_KINDS.indexOf(kind) >= 0 && !out.input) out.input = id;
      else if (OUTPUT_KINDS.indexOf(kind) >= 0 && !out.output) out.output = id;
      else if (kind === "model_raw_response") out.raw = id;
      else if (kind === "error_detail") out.error = id;
      else out.extra.push({ kind: kind, id: id });
    });
    // A model reply that was never parsed is still the reply.
    if (!out.output && out.raw) { out.output = out.raw; out.raw = null; }
    return out;
  }

  // The stored values an operation read and wrote, as the contract records them: an attribute per kind,
  // a list of names. Anything that is not a list of strings is no lineage at all.
  var LINEAGE = { reads: "engelbart.lineage.reads", writes: "engelbart.lineage.writes" };
  function lineageOf(attributes, kind) {
    var v = (attributes || {})[LINEAGE[kind]];
    return Array.isArray(v) ? v.filter(function (n) { return typeof n === "string" && n; }) : [];
  }
  function hasLineage(op) {
    var a = op && op.attributes;
    return !!a && (Array.isArray(a[LINEAGE.reads]) || Array.isArray(a[LINEAGE.writes]));
  }

  function opVM(op, seq, depth) {
    return { id: op.operation_id, seq: seq, at: when(op.started_at), kind: kindOf(op), name: op.name, target: targetOf(op), status: statusOf(op.status),
      input: undefined, output: undefined, ms: durationOf(op), meta: metaOf(op), error: op.error || null,
      reads: lineageOf(op.attributes, "reads"), writes: lineageOf(op.attributes, "writes"),
      real: true, type: op.type, level: op.level, depth: depth, trace_id: op.trace_id, span_id: op.span_id, parent_span_id: op.parent_span_id,
      started_at: op.started_at, ended_at: op.ended_at, attributes: op.attributes || {}, snaps: snapsOf(op), events: [] };
  }

  // Depth-first in start order beneath one root, so a row's implementation follows the row.
  function descendants(rootOp, ops) {
    var bySpan = {}; ops.forEach(function (o) { if (o.span_id) bySpan[o.span_id] = o; });
    var children = {}; ops.forEach(function (o) { var p = o.parent_span_id || "__none"; (children[p] = children[p] || []).push(o); });
    var order = function (a, b) { return when(a.started_at) - when(b.started_at) || String(a.operation_id).localeCompare(String(b.operation_id)); };
    var out = [];
    var walk = function (span, depth) { (children[span] || []).sort(order).forEach(function (o) { if (o === rootOp) return; out.push({ op: o, depth: depth }); walk(o.span_id, depth + 1); }); };
    walk(rootOp.span_id, 0);
    // Anything in the trace whose parent was never recorded still belongs to it.
    var seen = {}; out.forEach(function (x) { seen[x.op.operation_id] = true; });
    ops.filter(function (o) { return o !== rootOp && !seen[o.operation_id] && (!o.parent_span_id || !bySpan[o.parent_span_id]); }).sort(order)
      .forEach(function (o) { out.push({ op: o, depth: 0 }); walk(o.span_id, 1); });
    return out;
  }

  // "onboarding · analysis (run)": the surface the root name starts with, the action it recorded,
  // and the way the simulator marks a background run or a poll.
  function labelOf(surface, action, flags) {
    return surface + " · " + action + (flags.bg ? " (run)" : flags.poll ? " (poll)" : "");
  }
  function surfaceOfPath(path) {
    for (var i = 0; i < SURFACES.length; i++) if (SURFACES[i][0].test(String(path || ""))) return SURFACES[i][1];
    return /storage/.test(String(path || "")) ? "storage" : "client";
  }

  function stageVM(rootOp, ops, index, events) {
    var a = rootOp.attributes || {};
    var rows = descendants(rootOp, ops).map(function (x, i) { return opVM(x.op, i + 1, x.depth); });
    var byOp = {}; rows.forEach(function (r) { byOp[r.id] = r; });
    (events || []).forEach(function (ev) { var r = byOp[ev.operation_id]; if (r) r.events.push({ type: ev.type, at: ev.at, status: ev.status, progress: ev.progress || null, error: ev.error || null }); });
    var action = rootOp.action || a["engelbart.action"] || null;
    var surface = String(rootOp.name || "").indexOf(".") > 0 ? String(rootOp.name).split(".")[0] : "onboarding";
    var bg = a["engelbart.run_flag"] === true || a["engelbart.retry"] === true, poll = a["engelbart.poll"] === true;
    // A recorded onboarding action was one POST to the endpoint; a root the server never recorded keeps its own name.
    var endpoint = surface === "onboarding" && rootOp.synthetic !== true;
    return { id: rootOp.operation_id, seq: index + 1, at: when(rootOp.started_at), path: endpoint ? "/api/engelbart-onboarding" : rootOp.name, method: endpoint ? "POST" : "ACTION",
      surface: surface, action: action, label: action ? labelOf(surface, action, { bg: bg, poll: poll }) : rootOp.name, bg: bg,
      poll: poll, direct: false, request: null, status: statusOf(rootOp.status), ops: rows, ms: durationOf(rootOp),
      code: a["http.response.status_code"] != null ? a["http.response.status_code"] : null, response: null,
      real: true, synthetic: rootOp.synthetic === true, trace_id: rootOp.trace_id, root: rootOp.name, attributes: a, error: rootOp.error || null,
      started_at: rootOp.started_at, ended_at: rootOp.ended_at, outcome: a["engelbart.outcome"] || null, modelCount: rows.filter(function (r) { return r.kind === "model"; }).length };
  }

  // A request the browser made that the server did not trace, or whose trace has not arrived: a row
  // with what the browser sent and got back, and no operations.
  function observedStage(rq) {
    var surface = rq.where === "storage" ? "storage" : surfaceOfPath(rq.path);
    var action = rq.action || (rq.method === "PUT" ? "upload" : String(rq.path || "").split("/").pop());
    var awaiting = rq.trace_id ? (rq.trace === "missing" ? "missing" : "pending") : null;
    return { id: "req:" + rq.id, seq: 0, at: rq.at, path: rq.path, method: rq.method, surface: surface, action: action,
      label: labelOf(surface, action, { bg: !!rq.bg, poll: !!rq.poll }), bg: !!rq.bg, poll: !!rq.poll, direct: rq.where === "storage",
      request: rq.request === undefined ? null : rq.request, status: rq.status || "running", ops: [], ms: rq.ms || 0, code: rq.code == null ? null : rq.code,
      response: rq.response === undefined ? null : rq.response, real: false, observed: true, untraced: !rq.trace_id, awaiting: awaiting, trace_id: rq.trace_id || null,
      requestId: rq.id, step: rq.step || null, error: rq.error || null, traceError: rq.traceError || null, modelCount: 0 };
  }

  // Consecutive untraced polls of one action are one row: the waiting, not the work.
  function foldPolls(stages) {
    var out = [];
    stages.forEach(function (s) {
      var prev = out[out.length - 1];
      if (s.observed && s.untraced && s.poll && prev && prev.observed && prev.untraced && prev.poll && prev.action === s.action && prev.path === s.path) {
        prev.polls = (prev.polls || [{ id: prev.id, at: prev.at, status: prev.status, code: prev.code, ms: prev.ms }]).concat([{ id: s.id, at: s.at, status: s.status, code: s.code, ms: s.ms }]);
        prev.count = prev.polls.length; prev.request = s.request; prev.response = s.response; prev.status = s.status; prev.code = s.code; prev.ms = s.ms; prev.last = s.at;
        return;
      }
      out.push(s);
    });
    return out;
  }

  // The envelope, as one debugger run: one stage per workflow root, in start order, and -- when
  // the browser's own reports are given -- those reports joined to their traces by id, with the
  // untraced ones as rows of their own, in the order the browser made them.
  function adapt(envelope, options) {
    var opts = options || {};
    var ops = (envelope.operations || []).filter(Boolean);
    var events = (envelope.events || []).filter(Boolean);
    var byTrace = {}; ops.forEach(function (o) { (byTrace[o.trace_id || ""] = byTrace[o.trace_id || ""] || []).push(o); });
    var eventsByTrace = {}; events.forEach(function (e) { (eventsByTrace[e.trace_id || ""] = eventsByTrace[e.trace_id || ""] || []).push(e); });
    var roots = [];
    Object.keys(byTrace).forEach(function (trace) {
      var inTrace = byTrace[trace];
      var found = inTrace.filter(function (o) { return o.type === "workflow" || (!o.parent_span_id && o.level === "workflow"); });
      if (!found.length) {
        // A trace without a recorded root (older records) is shown as one, named for what it is.
        var first = inTrace.slice().sort(function (a, b) { return when(a.started_at) - when(b.started_at); })[0];
        found = [{ operation_id: "trace:" + trace, trace_id: trace, span_id: null, parent_span_id: null, name: "(no workflow root recorded) trace " + String(trace).slice(0, 8),
          type: "workflow", level: "workflow", status: inTrace.some(function (o) { return o.status === "failed"; }) ? "failed" : inTrace.some(function (o) { return o.status === "running" || o.status === "waiting"; }) ? "running" : "completed",
          started_at: first.started_at, ended_at: null, duration_ms: null, attributes: {}, snapshots: {}, error: null, action: first.action || null, synthetic: true }];
      }
      found.forEach(function (r) { roots.push({ root: r, trace: trace }); });
    });
    roots.sort(function (a, b) { return when(a.root.started_at) - when(b.root.started_at) || String(a.root.operation_id).localeCompare(String(b.root.operation_id)); });
    var traced = roots.map(function (x, i) { return stageVM(x.root, byTrace[x.trace], i, eventsByTrace[x.trace]); });
    var stages = traced;
    var requests = Array.isArray(opts.requests) ? opts.requests : null;
    if (requests) {
      var byTraceId = {}; traced.forEach(function (s) { if (s.trace_id && !byTraceId[s.trace_id]) byTraceId[s.trace_id] = s; });
      var session = [], taken = {};
      requests.forEach(function (rq) {
        var hit = rq.trace_id && byTraceId[rq.trace_id];
        if (hit && !taken[hit.id]) {
          // The browser's side of the same action: what it sent, what came back, and when.
          taken[hit.id] = true; hit.observed = true; hit.requestId = rq.id; hit.at = rq.at || hit.at; hit.step = rq.step || null;
          hit.request = rq.request === undefined ? null : rq.request; hit.response = rq.response === undefined ? null : rq.response;
          if (rq.code != null) hit.code = rq.code; hit.browserMs = rq.ms || 0;
          if (rq.status === "running" && hit.status !== "running") hit.status = hit.status; // the server's word stands once the trace is in
          session.push(hit); return;
        }
        session.push(observedStage(rq));
      });
      var earlier = traced.filter(function (s) { return !taken[s.id]; });
      earlier.forEach(function (s) { s.earlier = session.length > 0; });
      stages = earlier.concat(foldPolls(session));
    }
    stages.forEach(function (s, i) { s.seq = i + 1; });
    var snapshots = {}; (envelope.snapshots || []).forEach(function (s) { if (s && s.snapshot_id) snapshots[s.snapshot_id] = s; });
    var run = envelope.run || {}, ob = envelope.onboarding || opts.onboarding || {};
    // A run recorded before lineage was has no operation that names what it read or wrote; the graph
    // then says so rather than draw nothing as if nothing happened.
    var lineage = ops.some(hasLineage);
    return { id: "real-" + (run.run_id || ob.onboarding_id || "run"), name: opts.name || runLabel(ob, run), real: true, knobs: {}, stages: stages, requests: [], startedAt: when(run.started_at) || null,
      seed: null, trigger: null, presses: 0, run: run, onboarding: ob, snapshots: snapshots, snapshotsInline: envelope.snapshots_inline !== false, contract: envelope.contract_version || null,
      lineage: lineage };
  }

  // Two envelopes as one: a trace read after its request, folded into the run it belongs to. The
  // later record of an operation wins; a snapshot that carries its content beats one that does not.
  function mergeEnvelope(into, add) {
    var a = into || {}, b = add || {};
    var byId = function (list, key) { var m = {}; (list || []).forEach(function (x) { if (x && x[key]) m[x[key]] = x; }); return m; };
    var ops = byId(a.operations, "operation_id"); Object.assign(ops, byId(b.operations, "operation_id"));
    var evs = byId(a.events, "event_id"); Object.assign(evs, byId(b.events, "event_id"));
    var snaps = byId(a.snapshots, "snapshot_id");
    (b.snapshots || []).forEach(function (s) { if (!s || !s.snapshot_id) return; var have = snaps[s.snapshot_id]; if (!have || have.content === undefined || s.content !== undefined) snaps[s.snapshot_id] = s; });
    var values = function (m) { return Object.keys(m).map(function (k) { return m[k]; }); };
    var out = { contract_version: b.contract_version || a.contract_version || null, run: b.run || a.run || null, onboarding: b.onboarding || a.onboarding || null,
      operations: values(ops), snapshots: values(snaps), events: values(evs),
      snapshots_inline: a.snapshots_inline !== false && b.snapshots_inline !== false };
    return out;
  }

  function runLabel(ob, run) {
    var id = (ob && ob.onboarding_id) || (run && run.run_id) || "";
    return (ob && (ob.project_name || ob.paper_title)) || (id ? "onboarding " + String(id).slice(0, 8) : "run");
  }

  // Snapshot content for an operation's tab: ready when the run carried it, otherwise the id to ask for.
  function snapshotOf(recording, id) {
    if (!id) return { state: "none" };
    var s = recording.snapshots[id];
    if (!s) return { state: "missing", id: id };
    if (s.unavailable) return { state: "unavailable", id: id };
    if (s.content_omitted && s.content === undefined) return { state: "pending", id: id, bytes: s.bytes, truncated: !!s.truncated };
    return { state: "ready", id: id, content: s.content, bytes: s.bytes, truncated: !!s.truncated, redacted: s.redacted !== false, kind: s.kind };
  }

  // --- the browser side: the member's session and the endpoint --------------------------------------------------
  function client(options) {
    var o = options || {}, fetchImpl = o.fetch || (root.fetch ? root.fetch.bind(root) : null), supabaseLib = "supabase" in o ? o.supabase : root.supabase, base = o.base || "/api/engelbart-telemetry";
    var authClient = null, configPromise = null;
    function config() {
      if (!configPromise) configPromise = fetchImpl("/api/engelbart-config", { headers: { Accept: "application/json" } }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      return configPromise;
    }
    // The same session the setup page holds: supabase-js persists it under this origin.
    function session() {
      if (!supabaseLib || typeof supabaseLib.createClient !== "function") return Promise.resolve(null);
      return config().then(function (cfg) {
        if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
        if (!authClient) authClient = supabaseLib.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
        return authClient.auth.getSession().then(function (res) { var s = res && res.data && res.data.session; return s && s.access_token ? { token: s.access_token, email: s.user && s.user.email || "" } : null; });
      });
    }
    function get(params, token) {
      var url = base + (params ? "?" + params : "");
      return fetchImpl(url, { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + token } }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) { var e = new Error(body && body.error || ("Request failed (" + r.status + ")")); e.status = r.status; throw e; }
          return body;
        });
      });
    }
    return { session: session, list: function (token) { return get("", token); }, run: function (token, id) { return get("run=" + encodeURIComponent(id), token); },
      trace: function (token, id) { return get("trace=" + encodeURIComponent(id), token); },
      snapshot: function (token, id) { return get("snapshot=" + encodeURIComponent(id), token); } };
  }

  root.EGB_REAL = { adapt: adapt, mergeEnvelope: mergeEnvelope, observedStage: observedStage, foldPolls: foldPolls, kindOf: kindOf, statusOf: statusOf, targetOf: targetOf, tokensOf: tokensOf,
    snapsOf: snapsOf, snapshotOf: snapshotOf, runLabel: runLabel, surfaceOfPath: surfaceOfPath, client: client, INPUT_KINDS: INPUT_KINDS, OUTPUT_KINDS: OUTPUT_KINDS };
})(typeof window !== "undefined" ? window : this);
