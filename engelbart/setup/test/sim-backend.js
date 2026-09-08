/* A simulated Engelbart control plane that mirrors, operation for operation,
 * what api/engelbart-onboarding.js, api/_lib/onboarding.js, credits.js,
 * storage.js and onboarding-model.js do for each request: the auth check,
 * the credit read and LiteLLM ledger refresh, every Supabase read and write,
 * the Storage download, the model call with its cached paper prefix, the
 * link checks. Each operation is emitted to a tracer as it runs, with
 * sanitized inputs and outputs. Model replies come from debugger/fixture.js.
 *
 *   var sim = EngelbartSim.create({ emit, speed, knobs, persist })
 *   sim.handle(url, init) -> Promise<{ ok, status, json() }>
 *   sim.local(name, input, output)   // a client-side step worth a row
 *   sim.setSpeed(x); sim.reset(); sim.knobs
 */
(function () {
  "use strict";
  var FX = window.EGB_FIXTURE, PR = window.EGB_PROMPTS;
  // The real prompt text for one call, with the environment's edits if it made any.
  function promptText(key, vars, knobs) { return PR.render(key, vars, knobs.prompts || null); }
  var USER = FX.USER;
  var DEPTHS = ["everyday", "some", "technical", "expert"];
  var LEVELS = FX.LEVELS;
  var SUPA = "https://sim.supabase.local";
  var LITELLM = "https://engelbart-litellm.up.railway.app";
  var MODEL_ID = { sonnet: "claude-sonnet-4-5-20250929", haiku: "claude-haiku-4-5-20251001" };
  var PRICE = { sonnet: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, haiku: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 } };
  var SEARCH_PRICE = 0.01;
  var LAT = { auth: 140, db: 70, dbw: 95, rpc: 120, storage: 260, storageDl: 420, web: 190, proc: 4, haiku: 900, sonnet: 2100, analyze: 5200, hunt: 6400, level: 3600, litellm: 160 };
  var MODEL_ACTIONS = ["sources", "analysis", "paper_grounding", "assets", "leveled", "answer", "brainstorm", "asset_ask", "direction", "subgoals", "details", "goals", "todos", "ask", "rewrite"];
  var POLLED = ["analysis", "assets", "leveled"];
  var RUNNING_STALE_MS = 180000;
  var P_FAM = ["I'm completely lost", "I wouldn't know where to start", "I can get oriented", "I can get started", "I can extend it"];
  var DEFAULT_KNOBS = { gradeModel: "haiku", followUpGap: 25, linkChecks: true, readyGate: "model", depthShift: true, cachePaper: true, reconcileBlock: true };

  // --- the data flow: what the setup stores, and which operation turns one thing into another -----
  // Nodes are the values on the record (plus the two inputs every request carries); an operation
  // declares what it read and what it wrote, and an edge is a read that fed a write.
  var NODES = [
    { id: "session", label: "Session", sub: "Supabase Auth", col: 0, row: 0 },
    { id: "credit", label: "Credit key", sub: "LiteLLM ledger", col: 0, row: 1 },
    { id: "profile", label: "Reader profile", sub: "name · year · major · register", col: 0, row: 2 },
    { id: "paper", label: "Paper PDF", sub: "Storage object", col: 0, row: 3 },
    { id: "links", label: "Project links", sub: "page · repo", col: 0, row: 4 },
    { id: "code", label: "Connect code", sub: "one use · 15 min", col: 0, row: 5 },
    { id: "analysis", label: "Paper reading", sub: "areas · ladders", col: 1, row: 3 },
    { id: "assets", label: "Asset hunt", sub: "≤5 things · links", col: 1, row: 4 },
    { id: "asks", label: "Asked questions", sub: "selected text", col: 2, row: 0 },
    { id: "calibrations", label: "Graded answers", sub: "per area · per level", col: 2, row: 2 },
    { id: "brief", label: "Asset brief", sub: "names · one-liners", col: 2, row: 4 },
    { id: "assessment", label: "Assessment", sub: "levels · register shift", col: 3, row: 2 },
    { id: "turns", label: "Brainstorm turns", sub: "cards · answers", col: 3, row: 3 },
    { id: "interest", label: "Interest", sub: "one line", col: 4, row: 3 },
    { id: "leveled", label: "Fitted resources", sub: "locus · sticky · stand-ins", col: 5, row: 4 },
    { id: "chosen", label: "Chosen thing", sub: "one asset", col: 6, row: 4 },
    { id: "details", label: "Project details", sub: "questions · answers", col: 7, row: 1 },
    { id: "goals", label: "Goals", sub: "four options", col: 8, row: 1 },
    { id: "direction", label: "Direction", sub: "one proposal", col: 7, row: 3 },
    { id: "subgoals", label: "Subgoals", sub: "three pieces", col: 8, row: 3 },
    { id: "todos", label: "Todos + name", sub: "first piece", col: 9, row: 3 },
    { id: "payload", label: "Project payload", sub: "what /bart claims", col: 10, row: 3 },
    { id: "profileRecord", label: "Saved profile", sub: "hc_profiles", col: 10, row: 2 }
  ];
  var DECL = {
    "auth.getUser": { reads: ["session"] }, "select engelbart_members": { reads: ["session"] },
    "select engelbart_credit_accounts": { reads: ["credit"] }, "LiteLLM key/info": { reads: ["credit"] }, "patch engelbart_credit_accounts": { writes: ["credit"] }, "LiteLLM key/unblock": { reads: ["credit"] },
    "rpc engelbart_curator_upsert_paper": { writes: ["paper"] }, "PUT the PDF": { writes: ["paper"] }, "rpc engelbart_curator_set_paper_pdf": { writes: ["paper"] },
    "download paper": { reads: ["paper"] }, "fetchPageText": { reads: ["links"] },
    "analyze the paper": { reads: ["paper", "links", "profile"], writes: ["analysis"] },
    "hunt for the paper's things": { reads: ["paper"], writes: ["assets"] }, "briefOf": { reads: ["assets"], writes: ["brief"] }, "HEAD link check": { reads: ["assets"] },
    "resolve the question graded against": { reads: ["analysis", "calibrations"] },
    "upsert engelbart_onboarding_calibrations": { writes: ["calibrations"] }, "patch engelbart_onboarding_calibrations": { writes: ["calibrations"] },
    "grade the answer": { reads: ["analysis", "profile"], writes: ["calibrations"] }, "write one follow-up": { reads: ["calibrations", "analysis"], writes: ["calibrations"] },
    "compileAssessment": { reads: ["calibrations", "analysis", "profile"], writes: ["assessment"] },
    "fit the resources to the reader": { reads: ["assets", "assessment", "profile", "interest"], writes: ["leveled"] },
    "userTurnText": { reads: ["turns"] }, "insert engelbart_onboarding_turns": { writes: ["turns"] },
    "brainstorm turn": { reads: ["profile", "analysis", "assessment", "brief", "turns"], writes: ["turns", "interest"] },
    "findAsset": { reads: ["leveled"], writes: ["chosen"] },
    "propose one direction": { reads: ["profile", "analysis", "interest", "assessment", "turns", "chosen", "leveled"], writes: ["direction"] },
    "revise the direction": { reads: ["profile", "analysis", "interest", "assessment", "turns", "chosen", "leveled", "direction"], writes: ["direction"] },
    "break the direction into three pieces": { reads: ["profile", "analysis", "direction", "chosen", "leveled"], writes: ["subgoals"] },
    "revise the three pieces": { reads: ["profile", "analysis", "direction", "chosen", "leveled", "subgoals"], writes: ["subgoals"] },
    "write todos for the first piece": { reads: ["profile", "analysis", "direction", "subgoals", "leveled"], writes: ["todos"] },
    "answer a question about selected text": { reads: ["profile", "analysis"], writes: ["asks"] }, "insert engelbart_onboarding_asks": { writes: ["asks"] },
    "rewrite the screen at another register": { reads: ["profile"], writes: ["profile"] },
    "validate, then toPayload": { reads: ["profile", "analysis", "calibrations", "direction", "subgoals", "todos", "chosen", "interest", "paper"], writes: ["payload"] },
    "rpc engelbart_save_pending_setup": { writes: ["payload"] }, "upsert hc_profiles": { reads: ["profile", "calibrations"], writes: ["profileRecord"] },
    "mint setup code": { writes: ["code"] }, "rpc engelbart_issue_setup_code": { writes: ["code"] }
  };
  var FIELD_NODE = { name: "profile", year: "profile", major: "profile", depth: "profile", paper_id: "paper", paper_familiarity: "paper", project_url: "links", repo_url: "links",
    analysis: "analysis", assets: "assets", assets_brief: "brief", assessment: "assessment", leveled: "leveled", interest: "interest", asset_chosen: "chosen",
    direction: "direction", subgoals: "subgoals", details: "details", goals: "goals", todos: "todos", project_name: "todos", goal_chosen: "todos", pending_setup_id: "payload" };
  function declare(name, input) {
    var keys = Object.keys(DECL), hit = null;
    for (var i = 0; i < keys.length; i++) if (name.indexOf(keys[i]) === 0) { hit = DECL[keys[i]]; break; }
    var d = { reads: (hit && hit.reads || []).slice(), writes: (hit && hit.writes || []).slice() };
    if (name === "patch engelbart_onboardings" && input && typeof input === "object") {
      Object.keys(input).forEach(function (k) { var n = FIELD_NODE[k]; if (n && input[k] != null && d.writes.indexOf(n) < 0) d.writes.push(n); });
    }
    return d;
  }
  var EDGES = [];
  Object.keys(DECL).forEach(function (name) {
    var d = DECL[name]; (d.reads || []).forEach(function (r) { (d.writes || []).forEach(function (w) {
      if (r === w) return; if (!EDGES.some(function (e) { return e.from === r && e.to === w; })) EDGES.push({ from: r, to: w, via: [name] }); else EDGES.filter(function (e) { return e.from === r && e.to === w; })[0].via.push(name);
    }); });
  });

  function fail(message, statusCode) { var e = new Error(message); e.statusCode = statusCode || 500; return e; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function one(v, cap) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, cap); }
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function snapLevel(n) { return LEVELS.reduce(function (b, l) { return Math.abs(l - n) < Math.abs(b - n) ? l : b; }, 0); }
  function tokens(text) { return Math.round(String(text || "").length / 4); }

  // --- sanitizing: nothing secret leaves the simulation, even a fake one ------
  var SECRET_KEYS = /^(authorization|apikey|anonkey|servicerolekey|masterkey|key_ciphertext|key_iv|key_tag|access_token|paper_token|token|p_payload_token)$/i;
  function redact(v, key, depth) {
    depth = depth || 0;
    if (depth > 12) return "…";
    if (v == null) return v;
    if (typeof v === "string") {
      if (key && SECRET_KEYS.test(key)) return "••••••••";
      if (/^sk-/.test(v)) return "sk-••••••••";
      if (/^egb_/.test(v)) return "egb_••••••••";
      if (/^eyJ[A-Za-z0-9._-]{16,}/.test(v)) return "eyJ•••••••• (jwt)";
      if (v.length > 400 && /^[A-Za-z0-9+/=\s]+$/.test(v)) return "<base64 " + Math.round(v.length * 0.75 / 1024) + " KB omitted>";
      return v;
    }
    if (Array.isArray(v)) return v.map(function (x) { return redact(x, null, depth + 1); });
    if (typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = redact(v[k], k, depth + 1); }); return o; }
    return v;
  }

  function create(opts) {
    opts = opts || {};
    var emit = opts.emit || function () {};
    var speed = opts.speed == null ? 1 : opts.speed;
    var knobs = Object.assign({}, DEFAULT_KNOBS, opts.knobs || {});
    var persist = opts.persist || null;
    var seq = 0, stageSeq = 0;
    var db = (opts.seed ? clone(opts.seed) : null) || load() || fresh();
    // A configured participant: the account has finished a setup before, so the profile is on record and
    // the next setup starts at the paper with their links and familiarity already filled in.
    var participant = opts.participant || null;
    function seedParticipant() {
      if (!participant || db.onboardings.length) return;
      // The profile steps are already answered on the open row itself, so the product opens at the paper
      // with the first four steps checked off; a paper named in the configuration is attached too.
      var p = participant, t = new Date().toISOString(), paperId = null;
      if (p.paper && p.paper.name) { paperId = uid("paper"); db.papers.push({ id: paperId, title: String(p.paper.name).replace(/\.pdf$/i, ""), bytes: Number(p.paper.size) || 0, owner: USER.id, pdf_path: "papers/" + paperId + ".pdf" }); }
      db.onboardings.push({ id: uid("ob"), user_id: USER.id, status: "open", step: 4, name: p.name || "Reader", year: p.year || "Second year", major: p.major || "Undeclared", depth: p.depth || "some",
        project_url: p.projectUrl || "", repo_url: p.repoUrl || "", paper_familiarity: Number.isInteger(Number(p.paperFamiliarity)) ? Number(p.paperFamiliarity) : 0,
        paper_id: paperId, paper_title: paperId ? db.papers[db.papers.length - 1].title : "",
        analysis_status: "none", assets_status: "none", leveled_status: "none", created_at: t, updated_at: t });
      save();
    }
    seedParticipant();

    function fresh() {
      return { n: 0, onboardings: [], calibrations: [], turns: [], asks: [], profiles: [], papers: [], codes: [],
        credit: { user_id: USER.id, email: USER.email, status: "ready", blocked: false, budget_usd: 25, spend_usd: 0.4187, models: ["all-proxy-models"], synced_at: null } };
    }
    function load() { if (!persist) return null; try { var raw = window.localStorage.getItem(persist); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
    function save() { if (!persist) return; try { window.localStorage.setItem(persist, JSON.stringify(db)); } catch (e) {} }
    function uid(prefix) { db.n += 1; return prefix + "-" + String(db.n).padStart(4, "0") + "-" + hash(prefix + db.n).toString(16).slice(0, 6); }
    function now() { return new Date().toISOString(); }
    function wait(ms) { return speed ? new Promise(function (r) { setTimeout(r, ms * speed); }) : Promise.resolve(); }
    function jitter(name) { return (hash(name) % 31) - 15; }

    // --- the tracer --------------------------------------------------------------
    function latencyFor(kind, name, meta) {
      if (meta && meta.lat) return LAT[meta.lat];
      if (kind === "model") return LAT[meta && meta.family === "haiku" ? "haiku" : "sonnet"];
      if (kind === "db") return /^(patch|insert|delete|upsert)/.test(name) ? LAT.dbw : /^rpc/.test(name) ? LAT.rpc : LAT.db;
      if (kind === "storage") return /download|GET/.test(name) ? LAT.storageDl : LAT.storage;
      if (kind === "web") return LAT.web;
      if (kind === "api") return LAT.litellm;
      return LAT.proc;
    }
    function stage(req) {
      var ctx = { id: "st-" + (++stageSeq) + "-" + hash(req.path + stageSeq).toString(16).slice(0, 4), simMs: 0, ops: 0 };
      var action = req.body && req.body.action ? String(req.body.action) : (req.method === "PUT" ? "upload" : req.path.split("/").pop());
      var surface = /onboarding/.test(req.path) ? "onboarding" : /device/.test(req.path) ? "device" : /setup/.test(req.path) ? "setup" : /storage/.test(req.path) ? "storage" : /config/.test(req.path) ? "config" : "client";
      var bg = ["analysis", "assets", "leveled"].indexOf(action) >= 0 && req.body && (req.body.run || req.body.retry);
      var poll = ["analysis", "assets", "leveled"].indexOf(action) >= 0 && !bg;
      emit({ type: "stage", id: ctx.id, seq: stageSeq, at: Date.now(), path: req.path, method: req.method, surface: surface, action: action,
        label: surface + " · " + action + (bg ? " (run)" : poll ? " (poll)" : ""), bg: !!bg, poll: !!poll, direct: surface === "storage",
        request: redact(req.body === undefined ? (req.bytes != null ? { bytes: req.bytes } : null) : req.body), status: "running",
        raw: opts.recordRaw && req.url ? { url: req.url, method: req.method, body: req.rawBody == null ? null : req.rawBody, bytes: req.bytes } : null });
      ctx.op = function (kind, name, target, input, work, meta) {
        meta = meta || {};
        var lat = Math.max(2, latencyFor(kind, name, meta) + jitter(name + target));
        var o = { type: "op", id: "op-" + (++seq), stage: ctx.id, seq: seq, at: Date.now(), kind: kind, name: name, target: target, status: "running",
          input: redact(input), output: null, ms: 0, meta: clone(meta) || {} };
        var decl = declare(name, input); o.reads = decl.reads; o.writes = decl.writes;
        delete o.meta.lat;
        ctx.ops += 1;
        emit(clone(o));
        return wait(lat).then(function () {
          var out;
          try { out = typeof work === "function" ? work() : work; } catch (e) {
            o.status = "error"; o.error = e.message; o.ms = lat; ctx.simMs += lat; emit(clone(o)); throw e;
          }
          o.status = "ok"; o.output = redact(out); o.ms = lat; ctx.simMs += lat;
          if (o.meta.cost != null) o.meta.cost = Math.round(o.meta.cost * 10000) / 10000;
          emit(clone(o)); return out;
        });
      };
      ctx.end = function (status, code, value) {
        emit({ type: "stage.end", id: ctx.id, at: Date.now(), status: status, code: code, ms: ctx.simMs, ops: ctx.ops, response: redact(value) });
      };
      return ctx;
    }

    // --- model call accounting -----------------------------------------------------
    function modelMeta(family, io) {
      var p = PRICE[family];
      var cost = (io.input || 0) * p.input / 1e6 + (io.output || 0) * p.output / 1e6 + (io.cache_read || 0) * p.cache_read / 1e6 + (io.cache_write || 0) * p.cache_write / 1e6 + (io.web_searches || 0) * SEARCH_PRICE;
      db.credit.spend_usd = Math.round((db.credit.spend_usd + cost) * 10000) / 10000;
      return { family: family, model: MODEL_ID[family], tokens: io, cost: cost, lat: io.lat };
    }
    function modelRequest(family, content, maxTokens, extra) {
      var body = { model: MODEL_ID[family], max_tokens: maxTokens, messages: [{ role: "user", content: content }] };
      if (extra && extra.tools) body.tools = extra.tools;
      // `context` names what the prompt was assembled from, so the debugger can show it beside the request.
      // An environment may override a prompt's text by its name (analyzePrompt, gradePrompt, …).
      var key = extra && extra.key, override = key && knobs.prompts && knobs.prompts[key] != null;
      return { url: "POST " + LITELLM + "/v1/messages", headers: { Authorization: "Bearer sk-…" }, template: key, template_edited: override || undefined, summary: extra && extra.prompt || undefined, context: extra && extra.context || undefined, body: body, timeout_ms: extra && extra.timeoutMs || 90000 };
    }
    function paperPrefix() {
      return [{ type: "text", text: PR.PAPER_PREFIX },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "<base64 1.9 MB>" }, cache_control: knobs.cachePaper ? { type: "ephemeral" } : undefined }];
    }
    var PAPER_TOKENS = 24800;
    function paperIO(first) { return knobs.cachePaper ? (first ? { cache_write: PAPER_TOKENS } : { cache_read: PAPER_TOKENS }) : { input: PAPER_TOKENS }; }
    function io(base, extra) { var o = Object.assign({ input: 0, output: 0 }, base); Object.keys(extra || {}).forEach(function (k) { o[k] = (o[k] || 0) + extra[k]; }); return o; }

    // --- the prelude every request runs ----------------------------------------------
    function verifyUser(ctx) {
      return ctx.op("db", "auth.getUser", "GET " + SUPA + "/auth/v1/user", { headers: { apikey: "anon", Authorization: "Bearer eyJ…" } },
        function () { return { id: USER.id, email: USER.email, aud: "authenticated", role: "authenticated" }; }, { lat: "auth" })
        .then(function () {
          return ctx.op("db", "select engelbart_members", "GET /rest/v1/engelbart_members?user_id=eq." + USER.id + "&select=user_id", { headers: { apikey: "service_role" } },
            function () { return [{ user_id: USER.id }]; });
        }).then(function () { return USER; });
    }
    function creditRow() { return clone(db.credit); }
    function credentials(ctx) {
      var row;
      return ctx.op("db", "select engelbart_credit_accounts", "GET /rest/v1/engelbart_credit_accounts?user_id=eq." + USER.id + "&select=*", {},
        function () { row = creditRow(); return [Object.assign({}, row, { key_ciphertext: "••••", key_iv: "••••", key_tag: "••••" })]; })
        .then(function () {
          return ctx.op("processing", "decryptSecret", "AES-256-GCM with ENGELBART_CREDENTIAL_KEY", { ciphertext: "••••", iv: "••••", tag: "••••" }, function () { return { apiKey: "sk-••••" }; });
        }).then(function () {
          return ctx.op("api", "LiteLLM key/info", "GET " + LITELLM + "/key/info?key=sk-…", { headers: { Authorization: "Bearer <LITELLM_MASTER_KEY>" } },
            function () { return { info: { key_alias: "engelbart:" + USER.id, spend: db.credit.spend_usd, max_budget: db.credit.budget_usd, models: ["all-proxy-models"] } }; });
        }).then(function () {
          return ctx.op("db", "patch engelbart_credit_accounts", "PATCH /rest/v1/engelbart_credit_accounts?user_id=eq." + USER.id, { spend_usd: db.credit.spend_usd, synced_at: now() },
            function () { db.credit.synced_at = now(); save(); return [creditRow()]; });
        }).then(function () {
          // /key/info does not report `blocked`; absent is unknown, so the gate is asserted again (credits.js reconcileBlock).
          if (!knobs.reconcileBlock) return null;
          return ctx.op("api", "LiteLLM key/unblock (reconcile)", "POST " + LITELLM + "/key/unblock", { key: "sk-…", reason: "key/info carried no `blocked`; asserting the ledger's verdict" }, function () { return { key: "sk-…", blocked: false }; });
        }).then(function () {
          var spent = db.credit.spend_usd >= db.credit.budget_usd - 0.0001;
          if (spent || db.credit.blocked) throw fail("Your Engelbart Claude credit is used up, so setup cannot run right now. Reach out to us to top it up.", 409);
          return { status: "active", apiKey: "sk-••••", baseUrl: LITELLM, budgetUsd: db.credit.budget_usd, spendUsd: db.credit.spend_usd, models: ["all-proxy-models"] };
        });
    }

    // --- the onboarding row --------------------------------------------------------
    var PROFILE_FIELDS = ["name", "year", "major", "depth"];
    function hasProfile(r) { return !!r && PROFILE_FIELDS.every(function (k) { return r[k]; }); }
    function publicRow(r) { var o = clone(r); delete o.user_id; return o; }
    function findRow(id) { return db.onboardings.filter(function (r) { return r.id === id; })[0]; }
    function calsOf(row) { return db.calibrations.filter(function (c) { return c.onboarding_id === row.id; }).sort(function (a, b) { return String(a.asked_at).localeCompare(String(b.asked_at)); }); }
    function turnsOf(row, stage_, assetKey) { return db.turns.filter(function (t) { return t.onboarding_id === row.id && t.stage === stage_ && (assetKey ? t.asset_key === assetKey : true); }); }
    function publicTurn(t) { return { id: t.id, stage: t.stage, asset_key: t.asset_key || "", role: t.role, content: t.content, card: t.card || null, created_at: t.created_at }; }
    function patchRow(ctx, row, values, why) {
      var keys = Object.keys(values);
      return ctx.op("db", "patch engelbart_onboardings", "PATCH /rest/v1/engelbart_onboardings?id=eq." + row.id + " · " + (why || keys.join(", ")),
        Object.assign({}, values, { updated_at: now() }), function () { Object.assign(row, values, { updated_at: now() }); save(); return [publicRow(row)]; });
    }
    function openRow(ctx, body) {
      var rows, row, prior;
      return ctx.op("db", "select engelbart_onboardings", "GET /rest/v1/engelbart_onboardings?user_id=eq." + USER.id + "&select=*&order=created_at.desc", {},
        function () { rows = db.onboardings.filter(function (r) { return r.user_id === USER.id; }).slice().reverse(); return rows.map(publicRow); })
        .then(function () {
          row = rows.filter(function (r) { return r.status === "open"; })[0];
          if (!row && !(body && body.fresh)) row = rows.filter(function (r) { return r.status === "created"; })[0];
          prior = rows.filter(function (r) { return r.status === "created" && hasProfile(r) && (!row || r.id !== row.id); })[0] || null;
          if (!row) {
            var seed = { user_id: USER.id, status: "open", step: 0, analysis_status: "none", assets_status: "none", leveled_status: "none" };
            if (prior) { PROFILE_FIELDS.forEach(function (k) { seed[k] = prior[k]; }); seed.step = 4; }
            return ctx.op("db", "insert engelbart_onboardings", "POST /rest/v1/engelbart_onboardings · Prefer: return=representation", [seed], function () {
              row = Object.assign({ id: uid("ob"), created_at: now(), updated_at: now() }, seed); db.onboardings.push(row); save(); return [publicRow(row)];
            });
          }
          if (prior && row.status === "open" && (!hasProfile(row) || (Number(row.step) || 0) < 4)) {
            var values = {}; PROFILE_FIELDS.forEach(function (k) { values[k] = row[k] || prior[k]; }); values.step = Math.max(Number(row.step) || 0, 4);
            return patchRow(ctx, row, values, "carry the profile over");
          }
          return null;
        }).then(function () {
          return ctx.op("db", "select engelbart_onboarding_calibrations", "GET /rest/v1/engelbart_onboarding_calibrations?onboarding_id=eq." + row.id + "&select=*&order=asked_at.asc", {}, function () { return calsOf(row).map(publicRow); });
        }).then(function () {
          return ctx.op("db", "select engelbart_onboarding_turns", "GET /rest/v1/engelbart_onboarding_turns?onboarding_id=eq." + row.id + "&stage=eq.brainstorm&select=*&order=created_at.asc", {}, function () { return turnsOf(row, "brainstorm").map(publicTurn); });
        }).then(function () {
          if (row.status === "open") {
            if (Number(row.step) === 7 && !row.assessment) return patchRow(ctx, row, { step: 6 }, "resume Topics before Brainstorm");
            if (Number(row.step) === 6 && row.assessment) return patchRow(ctx, row, { step: 7 }, "resume Brainstorm after Topics");
          }
        }).then(function () {
          return { row: row, onboarding: publicRow(row), calibrations: calsOf(row).map(publicRow), turns: turnsOf(row, "brainstorm").map(publicTurn), profile_reused: !!prior };
        });
    }
    function addTurn(ctx, row, stage_, assetKey, role, content, card) {
      var t = { onboarding_id: row.id, user_id: USER.id, stage: stage_, asset_key: assetKey || "", role: role, content: one(content, 4000), card: card || null };
      return ctx.op("db", "insert engelbart_onboarding_turns", "POST /rest/v1/engelbart_onboarding_turns · " + stage_ + "/" + role, [t], function () {
        var made = Object.assign({ id: uid("turn"), created_at: now() }, t); db.turns.push(made); save(); return [publicTurn(made)];
      }).then(function (rows) { return db.turns.filter(function (x) { return x.id === rows[0].id; })[0]; });
    }

    // --- the reader, as every prompt sees them -----------------------------------------
    function areaLevels(row, cals) {
      var areas = row.analysis && row.analysis.areas || [];
      return areas.map(function (_, i) {
        var mine = cals.filter(function (c) { return Number(c.area_index) === i && c.answered_at; });
        if (!mine.length) return null;
        var graded = mine.filter(function (c) { return c.graded_level != null; });
        return graded.length ? Number(graded[graded.length - 1].graded_level) : Number(mine[mine.length - 1].self_level);
      });
    }
    function assessedDepth(depthKey, levels) {
      var known = levels.filter(function (l) { return l != null; }), index = Math.max(0, DEPTHS.indexOf(depthKey));
      if (!known.length || !knobs.depthShift) return { key: DEPTHS[index], shift: 0, weakest: -1 };
      var mean = known.reduce(function (a, b) { return a + b; }, 0) / known.length;
      var shift = mean <= 25 ? -1 : mean >= 75 ? 1 : 0, to = Math.max(0, Math.min(3, index + shift)), weakest = -1;
      levels.forEach(function (l, i) { if (l != null && (weakest < 0 || l < levels[weakest])) weakest = i; });
      return { key: DEPTHS[to], shift: to - index, weakest: weakest };
    }
    function readerOf(row, cals) {
      var levels = areaLevels(row, cals), assessed = assessedDepth(row.depth, levels);
      return { name: row.name, year: row.year, major: row.major, depth: assessed.key, assessed: assessed,
        knowledge: levels.map(function (l, i) { return l == null ? null : { area: row.analysis.areas[i].area, level: l, project_role: row.analysis.areas[i].project_role }; }).filter(Boolean) };
    }
    function paperOf(row) { var a = row.analysis || {}; return { title: one(a.title || row.paper_title, 60), one_liner: one(a.one_liner, 300), grounding: a.grounding || null }; }

    // --- actions ------------------------------------------------------------------------
    var A = {};
    function requireOpen(row) { if (!row || row.status !== "open") throw fail("This setup is already finished", 409); }
    var STEP_CAP = { name: 60, year: 40, major: 80, project_draft: 2000, goal_chosen: 200, project_name: 80 };

    A.step = function (ctx, row, cals, body) {
      requireOpen(row);
      var fields = body.fields || {}, values = {};
      Object.keys(STEP_CAP).forEach(function (k) { if (k in fields) values[k] = one(fields[k], STEP_CAP[k]); });
      if ("depth" in fields && DEPTHS.indexOf(String(fields.depth)) >= 0) values.depth = String(fields.depth);
      if (Array.isArray(fields.todos)) values.todos = fields.todos.map(function (t) { return one(t, 300); }).filter(Boolean).slice(0, 4);
      var asked = Number(body.step);
      if (Number.isInteger(asked)) values.step = Math.max(Number(row.step) || 0, Math.min(12, Math.max(0, asked)));
      return patchRow(ctx, row, values).then(function () { return { onboarding: publicRow(row) }; });
    };

    A.sources = function (ctx, row, cals, body) {
      requireOpen(row);
      if (!body.paper_id) throw fail("Add the paper first", 400);
      return ctx.op("processing", "verify own-paper token", "HMAC-SHA256(paper_id, user_id) · crypto.timingSafeEqual", { paper_id: body.paper_id, paper_token: body.paper_token, proven_by_row: row.paper_id === body.paper_id },
        function () {
          var paper = db.papers.filter(function (p) { return p.id === body.paper_id; })[0];
          if (!paper && row.paper_id !== body.paper_id) throw fail("That paper is not yours to analyse", 403);
          var fam = Number(body.paper_familiarity);
          if (!Number.isInteger(fam) || fam < 0 || fam > 4) throw fail("Say how familiar you are with the paper", 400);
          return { ok: true, familiarity: fam };
        })
        .then(function () {
          return ctx.op("processing", "validate optional links", "PageFetch.safeHttpUrl", { project_url: body.project_url || "", repo_url: body.repo_url || "" }, function () {
            [body.project_url, body.repo_url].forEach(function (u) { if (u && !/^https?:\/\//i.test(String(u).trim())) throw fail("Links must be public http(s) pages", 400); });
            return { ok: true };
          });
        }).then(function () {
          return patchRow(ctx, row, { paper_id: body.paper_id, project_url: one(body.project_url, 500), repo_url: one(body.repo_url, 500), paper_familiarity: Number(body.paper_familiarity),
            analysis: null, paper_title: "", analysis_status: "none", analysis_error: "", analysis_started_at: null,
            assets: null, assets_brief: null, assets_status: "none", assets_error: "", assets_started_at: null,
            assessment: null, leveled: null, leveled_status: "none", leveled_error: "", leveled_started_at: null,
            asset_chosen: null, direction: null, subgoals: null, todos: null }, "accept the paper, reset everything derived from it");
        }).then(function () { return { ok: true, analysis_status: "none", assets_status: "none" }; });
    };

    function running(row, prefix) {
      if (row[prefix + "_status"] !== "running") return false;
      return Date.now() - (Date.parse(row[prefix + "_started_at"] || "") || 0) < RUNNING_STALE_MS;
    }
    function downloadPaper(ctx, row) {
      var paper = db.papers.filter(function (p) { return p.id === row.paper_id; })[0];
      return ctx.op("storage", "download paper (service role)", "GET " + SUPA + "/storage/v1/object/berkeley-papers/papers/" + row.paper_id + ".pdf", { maxBytes: 20971520, headers: { Authorization: "Bearer <service_role>" } },
        function () { return { bytes: paper ? paper.bytes : 1998042, content_type: "application/pdf" }; });
    }
    function supersededBy(ctx, row, paperId) {
      return ctx.op("db", "select engelbart_onboardings (superseded?)", "GET /rest/v1/engelbart_onboardings?id=eq." + row.id + "&select=id,paper_id&limit=1", {}, function () { return [{ id: row.id, paper_id: row.paper_id }]; })
        .then(function (rows) { return rows[0] && String(rows[0].paper_id) !== String(paperId); });
    }
    function verifyLinks(ctx, assets) {
      if (!knobs.linkChecks) return ctx.op("processing", "verifyLinks skipped", "knob linkChecks=false", { links: countLinks(assets) }, function () { return { kept: countLinks(assets) }; }).then(function () { return assets; });
      var budget = 40, chain = Promise.resolve();
      function check(asset) {
        (asset.links || []).forEach(function (l) {
          chain = chain.then(function () {
            if (budget <= 0) return;
            budget -= 1;
            return ctx.op("web", "HEAD link check", "HEAD " + l.url, { redirect: "follow", timeout_ms: 5000 }, function () { return { status: 200, kept: true }; });
          });
        });
        (asset.children || []).forEach(check);
      }
      assets.forEach(check);
      return chain.then(function () { return assets; });
    }
    function countLinks(assets) { var n = 0; (function walk(list) { list.forEach(function (a) { n += (a.links || []).length; walk(a.children || []); }); })(assets); return n; }

    A.analysis = function (ctx, row, cals, body) {
      if (!(body.run || body.retry)) {
        var out = { analysis_status: row.analysis_status };
        if (row.analysis_status === "done") out.analysis = row.analysis;
        if (row.analysis_status === "error") out.analysis_error = row.analysis_error;
        return Promise.resolve(out);
      }
      if (!row.paper_id) throw fail("Add the paper first", 400);
      if (running(row, "analysis")) return Promise.resolve({ analysis_status: "running" });
      var mine = row.paper_id, pages = [];
      return patchRow(ctx, row, { analysis_status: "running", analysis_started_at: now(), analysis_error: "" }, "mark the reading running")
        .then(function () { return downloadPaper(ctx, row); })
        .then(function () {
          var chain = Promise.resolve();
          [row.project_url, row.repo_url].filter(Boolean).forEach(function (url) {
            chain = chain.then(function () {
              return ctx.op("web", "fetchPageText", "GET " + url, { timeout_ms: 15000, max_chars: 20000 }, function () { var t = { url: url, chars: 6000 + (hash(url) % 9000) }; pages.push(t); return t; });
            });
          });
          return chain;
        }).then(function () {
          var content = paperPrefix().concat([{ type: "text", text: promptText("analyzePrompt", { familiarityLabel: (PR.FAMILIARITY[Number(row.paper_familiarity) || 0]).label, familiarityDesc: (PR.FAMILIARITY[Number(row.paper_familiarity) || 0]).desc, depthLabel: (PR.depthOf(row.depth) || PR.DEPTHS[0]).label, depthDesc: (PR.depthOf(row.depth) || PR.DEPTHS[0]).desc, urls: pages.length ? pages.map(function (p) { return p.url + "\n(" + p.chars + " characters of fetched page text)"; }).join("\n\n") : "" }, knobs) }]);
          var tok = io({ input: 1900 + pages.reduce(function (n, p) { return n + Math.round(p.chars / 4); }, 0), output: 3400 }, paperIO(true));
          return ctx.op("model", "analyze the paper", "sonnet · 8192 max tokens · paper as cached document", modelRequest("sonnet", content, 8192, { key: "analyzePrompt", timeoutMs: 100000, prompt: "analyzePrompt (the founder's diagnostic, kept verbatim): read the paper, pick 2–4 areas of prior knowledge that change how the project is explained, and for each write a ladder of five questions with sample answers, one per stop of familiarity.",
              context: { paper: "the PDF as a document block, base64, " + (knobs.cachePaper ? "cache_control ephemeral (shared with the asset hunt)" : "no cache_control"), project_pages: pages.length ? pages.map(function (p) { return p.url + " · " + p.chars + " chars of fetched text"; }) : "(none supplied)", paper_familiarity: P_FAM[Number(row.paper_familiarity) || 0], register: row.depth, not_included: "name, year, major, grades (none exist yet)" } }),
            function () { var a = clone(FX.PAPER); a.areas.forEach(function (x) { delete x.keywords; }); return a; },
            modelMeta("sonnet", Object.assign(tok, { lat: "analyze" })));
        }).then(function () {
          return ctx.op("processing", "normalizeAnalysis", "bound title 60, one_liner 300, 2–4 areas × 5 levels", { raw: "model JSON" }, function () { return { areas: FX.PAPER.areas.map(function (a) { return a.area; }) }; });
        }).then(function () { return supersededBy(ctx, row, mine); })
        .then(function (gone) {
          if (gone) return { analysis_status: "superseded" };
          var analysis = clone(FX.PAPER); analysis.areas.forEach(function (a) { delete a.keywords; });
          return patchRow(ctx, row, { analysis: analysis, analysis_status: "done", paper_title: analysis.title }, "store the reading").then(function () { return { analysis_status: "done", analysis: analysis }; });
        });
    };

    A.assets = function (ctx, row, cals, body) {
      if (!(body.run || body.retry)) {
        var out = { assets_status: row.assets_status };
        if (row.assets_status === "done") { out.assets = row.assets; out.assets_brief = row.assets_brief; }
        if (row.assets_status === "error") out.assets_error = row.assets_error;
        return Promise.resolve(out);
      }
      if (!row.paper_id) throw fail("Add the paper first", 400);
      if (running(row, "assets")) return Promise.resolve({ assets_status: "running" });
      var mine = row.paper_id, found;
      return patchRow(ctx, row, { assets_status: "running", assets_started_at: now(), assets_error: "" }, "mark the hunt running")
        .then(function () { return downloadPaper(ctx, row); })
        .then(function () {
          var content = paperPrefix().concat([{ type: "text", text: promptText("assetsPrompt", {}, knobs) }]);
          var tok = io({ input: 1500, output: 2600, web_searches: 9 }, paperIO(false));
          return ctx.op("model", "hunt for the paper's things", "sonnet · web_search (max 12) · cached paper prefix", modelRequest("sonnet", content, 8192, { key: "assetsPrompt", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }], timeoutMs: 100000, prompt: "assetsPrompt: name the concrete inputs and outputs of the work (datasets, code, tools, demos, simulations, instruments), at most five, in the paper's own register, and search the web for where each lives.",
              context: { paper: "the same PDF block as the reading" + (knobs.cachePaper ? ", read from its cache" : ""), reader: "nothing about the reader: the hunt is about the paper", tools: "web_search, up to 12 uses; every returned link is HEAD-checked afterwards" } }),
            function () { found = clone(FX.ASSETS); return { assets: found, searched: true }; },
            modelMeta("sonnet", Object.assign(tok, { lat: "hunt" })));
        }).then(function () {
          return ctx.op("processing", "normalizeAssets", "≤5 assets, ≤6 links each, kinds and availability bounded", { raw: "model JSON" }, function () { return { assets: found.length, links: countLinks(found) }; });
        }).then(function () { return verifyLinks(ctx, found); })
        .then(function () { return supersededBy(ctx, row, mine); })
        .then(function (gone) {
          if (gone) return { assets_status: "superseded" };
          var brief = found.map(function (a) { return { title: a.title, type: a.type, one_liner: a.one_liner }; });
          return ctx.op("processing", "briefOf", "names and one-liners only, for the brainstorm", { assets: found.length }, function () { return brief; })
            .then(function () { return patchRow(ctx, row, { assets: { assets: found, searched: true }, assets_brief: brief, assets_status: "done" }, "store the hunt"); })
            .then(function () { return { assets_status: "done", assets: row.assets, assets_brief: brief }; });
        });
    };

    function simGrade(area, answer, level) {
      var words = answer.trim().split(/\s+/).filter(Boolean).length, low = answer.toLowerCase();
      var hits = (area.keywords || []).filter(function (k) { return low.indexOf(k) >= 0; }).length;
      var score = level; if (words < 8) score -= 25; if (words < 4) score -= 25; if (hits >= 2) score += 25; if (words >= 40 && hits >= 1) score += 25;
      score = snapLevel(Math.max(0, Math.min(100, score)));
      var conf = Math.max(0.3, Math.min(0.95, 0.5 + 0.1 * Math.min(hits, 3) + (words >= 15 ? 0.1 : 0) - (words < 8 ? 0.1 : 0) + (knobs.gradeModel === "sonnet" ? 0.05 : 0)));
      return { level: score, confidence: Math.round(conf * 100) / 100, words: words, hits: hits,
        rationale: words + " words, " + hits + " of the area's core ideas named" + (score < level ? "; thinner than the level asked" : score > level ? "; more than the level asked" : "; matches the level asked") };
    }
    A.answer = function (ctx, row, cals, body, creds) {
      requireOpen(row);
      if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
      var areaIndex = Number(body.area_index), level = Number(body.question_level), self = Number(body.self_level), said = one(body.answer, 2000);
      var area = row.analysis.areas[areaIndex], fxArea = FX.PAPER.areas[areaIndex];
      var prior = cals.filter(function (c) { return Number(c.area_index) === areaIndex; });
      var existing = prior.filter(function (c) { return Number(c.question_level) === level; })[0];
      var source, cal, graded;
      return ctx.op("processing", "resolve the question graded against", "ladder question, or the stored follow-up for this level", { area_index: areaIndex, question_level: level, self_level: self, answer_chars: said.length },
        function () {
          if (LEVELS.indexOf(level) < 0 || LEVELS.indexOf(self) < 0) throw fail("That level is not on the ladder", 400);
          if (!said) throw fail("Write an answer first", 400);
          if (!area) throw fail("That area is not in this analysis", 400);
          var ladder = area.questions.filter(function (q) { return q.level === level; })[0];
          source = existing && existing.question && !existing.answered_at ? { question: existing.question, sample_response: existing.sample_response } : ladder;
          var answered = prior.filter(function (c) { return c.answered_at; });
          if (answered.length >= 2 && !answered.some(function (c) { return Number(c.question_level) === level; })) throw fail("That area has been asked enough", 400);
          return { question: source.question, follow_up: !!(existing && !existing.answered_at) };
        })
        .then(function () {
          var values = { area: area.area, parent_field: area.parent_field, self_level: self, question: source.question, sample_response: source.sample_response, answer: said, answered_at: now(), graded_level: null, grade_confidence: null, grade_rationale: "" };
          if (existing) return ctx.op("db", "patch engelbart_onboarding_calibrations", "PATCH /rest/v1/engelbart_onboarding_calibrations?id=eq." + existing.id, values, function () { Object.assign(existing, values); save(); cal = existing; return [publicRow(cal)]; });
          return ctx.op("db", "upsert engelbart_onboarding_calibrations", "POST /rest/v1/engelbart_onboarding_calibrations?on_conflict=onboarding_id,area_index,question_level · resolution=merge-duplicates",
            [Object.assign({ onboarding_id: row.id, user_id: USER.id, area_index: areaIndex, question_level: level }, values)], function () {
              cal = Object.assign({ id: uid("cal"), asked_at: now(), onboarding_id: row.id, user_id: USER.id, area_index: areaIndex, question_level: level }, values); db.calibrations.push(cal); save(); return [publicRow(cal)];
            });
        }).then(function () {
          var fam = knobs.gradeModel;
          return ctx.op("model", "grade the answer", fam + " · 300 max tokens · against the sample answer", modelRequest(fam, [{ type: "text", text: promptText("gradePrompt", { area: area.area, level: level, sample: source.sample_response, answer: said }, knobs) }], 300, { key: "gradePrompt", prompt: "gradePrompt: place the answer on the 0–100 ladder against the sample answer written for this question; return level, confidence, one-line rationale.",
              context: { area: area.area, question_level: level, question: source.question, sample_response: source.sample_response, answer: said, not_included: "the reader's self-rating, name, or profile: the grade is about the area, not the person" } }),
            function () { graded = simGrade(fxArea, said, level); return { level: graded.level, confidence: graded.confidence, rationale: graded.rationale }; },
            modelMeta(fam, { input: 700 + tokens(said), output: 90 }));
        }).then(function () {
          return ctx.op("db", "patch engelbart_onboarding_calibrations (grade)", "PATCH /rest/v1/engelbart_onboarding_calibrations?id=eq." + cal.id, { graded_level: graded.level, grade_confidence: graded.confidence, grade_rationale: graded.rationale },
            function () { cal.graded_level = graded.level; cal.grade_confidence = graded.confidence; cal.grade_rationale = graded.rationale; save(); return [publicRow(cal)]; });
        }).then(function () {
          var out = { graded_level: cal.graded_level, grade_confidence: cal.grade_confidence, grade_rationale: cal.grade_rationale, calibrations: [publicRow(cal)] };
          var first = prior.length === 0 || (prior.length === 1 && prior[0].id === cal.id);
          if (!(first && Math.abs(graded.level - self) >= knobs.followUpGap && graded.level !== level)) return out;
          var made;
          return ctx.op("model", "write one follow-up", "sonnet · 500 max tokens · from the reader's own answer, at the graded level", modelRequest("sonnet", [{ type: "text", text: promptText("followUpPrompt", { reader: readerOf(row, cals), area: area.area, parent_field: area.parent_field, question: source.question, level: level, self_level: self, answer: said, graded_level: graded.level, graded_rationale: graded.rationale, sample: source.sample_response }, knobs) }], 500, { key: "followUpPrompt", prompt: "followUpPrompt: write one new question at the graded level, from what the reader just said, probing the specific gap or strength the grade found; include a sample answer for the grader.",
              context: { reader: readerOf(row, cals), area: area.area, first_question: source.question, self_level: self, graded_level: graded.level, grade_rationale: graded.rationale, answer: said, sample_response: source.sample_response } }),
            function () {
              var q = fxArea.questions.filter(function (x) { return x.level === graded.level; })[0];
              made = { question: "You wrote “" + one(said, 48) + (said.length > 48 ? "…" : "") + "”. Building on that: " + q.question.charAt(0).toLowerCase() + q.question.slice(1), sample_response: q.sample_response };
              return made;
            }, Object.assign(modelMeta("sonnet", { input: 1100 + tokens(said), output: 160 }), { why: "graded " + graded.level + " vs self-rated " + self + ": apart by " + Math.abs(graded.level - self) + " ≥ " + knobs.followUpGap + ", and this was the area's first question, so one follow-up at the graded level" }))
            .then(function () {
              var values = { area: area.area, parent_field: area.parent_field, self_level: self, question: made.question, sample_response: made.sample_response, answer: "", answered_at: null, graded_level: null, grade_confidence: null, grade_rationale: "" };
              return ctx.op("db", "upsert engelbart_onboarding_calibrations (pending follow-up)", "POST /rest/v1/engelbart_onboarding_calibrations?on_conflict=onboarding_id,area_index,question_level",
                [Object.assign({ onboarding_id: row.id, area_index: areaIndex, question_level: graded.level }, values)], function () {
                  var pending = db.calibrations.filter(function (c) { return c.onboarding_id === row.id && Number(c.area_index) === areaIndex && Number(c.question_level) === graded.level; })[0];
                  if (pending) Object.assign(pending, values); else { pending = Object.assign({ id: uid("cal"), asked_at: now(), onboarding_id: row.id, user_id: USER.id, area_index: areaIndex, question_level: graded.level }, values); db.calibrations.push(pending); }
                  save(); return [publicRow(pending)];
                });
            }).then(function (rows) { out.follow_up = { question_level: graded.level, question: made.question, generated: true }; out.calibrations.push(rows[0]); return out; });
        });
    };

    A.topics_done = function (ctx, row, cals) {
      requireOpen(row);
      if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
      var assessment;
      return ctx.op("processing", "compileAssessment (no model call)", "grades on the calibration rows → per-area level, mean, register shift", { calibrations: cals.length, depth: row.depth }, function () {
        var levels = areaLevels(row, cals), assessed = assessedDepth(row.depth, levels);
        var areas = row.analysis.areas.map(function (a, i) {
          var mine = cals.filter(function (c) { return Number(c.area_index) === i && c.answered_at; });
          var lastGraded = mine.filter(function (c) { return c.graded_level != null; }).pop() || null;
          return { area: a.area, parent_field: a.parent_field, project_role: a.project_role, self_level: mine.length ? Number(mine[mine.length - 1].self_level) : null,
            graded_level: levels[i], confidence: lastGraded ? lastGraded.grade_confidence : null, rationale: lastGraded ? lastGraded.grade_rationale : "", questions_asked: mine.length,
            answers: mine.map(function (c) { return c.answer; }) };
        });
        if (!areas.some(function (a) { return a.questions_asked > 0; })) throw fail("Answer the topic questions first", 400);
        var known = levels.filter(function (l) { return l != null; });
        assessment = { areas: areas, mean: known.length ? Math.round(known.reduce(function (a, b) { return a + b; }, 0) / known.length) : null, depth: assessed.key, depth_shift: assessed.shift, compiled_at: now() };
        return assessment;
      }, { why: "no model call: each area's level is its last graded answer; the mean sets the register (≤25 drops a stop, ≥75 raises one" + (knobs.depthShift ? ")" : ", disabled by knob depthShift)") }).then(function () { return patchRow(ctx, row, { assessment: assessment, step: Math.max(Number(row.step) || 0, 7) }, "store the assessment"); })
        .then(function () { return { assessment: assessment }; });
    };

    A.leveled = function (ctx, row, cals, body) {
      if (!(body.run || body.retry)) {
        var out = { leveled_status: row.leveled_status, assets_status: row.assets_status };
        if (row.leveled_status === "done") out.leveled = row.leveled;
        if (row.leveled_status === "error") out.leveled_error = row.leveled_error;
        return Promise.resolve(out);
      }
      if (!row.assessment) throw fail("Answer the topic questions first", 409);
      if (row.assets_status !== "done" || !row.assets) return Promise.resolve({ leveled_status: "waiting", assets_status: row.assets_status, assets_error: row.assets_error || undefined });
      if (running(row, "leveled")) return Promise.resolve({ leveled_status: "running" });
      if (row.leveled_status === "done" && row.leveled && !body.retry) return Promise.resolve({ leveled_status: "done", leveled: row.leveled });
      var mine = row.paper_id, leveled;
      return patchRow(ctx, row, { leveled_status: "running", leveled_started_at: now(), leveled_error: "" }, "mark the fitting running")
        .then(function () {
          var reader = readerOf(row, cals);
          return ctx.op("model", "fit the resources to the reader", "sonnet · web_search (max 8) · locus, sticky knowledge, stand-ins", modelRequest("sonnet", [{ type: "text", text: promptText("levelPrompt", { reader: reader, assessment: row.assessment, assets: row.assets.assets, interest: row.interest || "" }, knobs) }], 8192, { key: "levelPrompt", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }], timeoutMs: 100000, prompt: "levelPrompt: decide where the locus of problem solving lies for this reader and which knowledge is sticky; add beginner stand-ins as children only where the sticky part is one the grades show the reader lacks; rewrite every description at the reader's register.",
              context: { reader: reader, assessment: row.assessment, assets: row.assets.assets, interest: row.interest || "", tools: "web_search, up to 8 uses, for the stand-ins' links" } }),
            function () { leveled = clone(FX.LEVELED); return leveled; },
            modelMeta("sonnet", { input: 5200, output: 2300, web_searches: 4, lat: "level" }));
        }).then(function () {
          return ctx.op("processing", "normalizeLeveled", "locus 300, ≤5 sticky, assets with ≤3 children each", { raw: "model JSON" }, function () { return { assets: leveled.assets.length, children: leveled.assets.reduce(function (n, a) { return n + (a.children || []).length; }, 0) }; });
        }).then(function () { return verifyLinks(ctx, leveled.assets); })
        .then(function () { return supersededBy(ctx, row, mine); })
        .then(function (gone) {
          if (gone) return { leveled_status: "superseded" };
          return patchRow(ctx, row, { leveled: leveled, leveled_status: "done" }, "store the fitted list").then(function () { return { leveled_status: "done", leveled: leveled }; });
        });
    };

    function publicReply(turn) {
      var card = turn && turn.card ? turn.card : { card: "none" };
      return { turn_id: turn ? turn.id : null, say: turn ? String(turn.content || "").split(/(?:^|\n)\((?:asked|offered)\)/)[0] : "", card: card.card || "none", questions: card.questions, focus: card.focus, ready: card.ready === true };
    }
    A.brainstorm = function (ctx, row, cals, body) {
      requireOpen(row);
      if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
      var turns, lastAssistant, said, reply, made;
      return ctx.op("db", "select engelbart_onboarding_turns", "GET /rest/v1/engelbart_onboarding_turns?onboarding_id=eq." + row.id + "&stage=eq.brainstorm&select=*&order=created_at.asc", {}, function () { turns = turnsOf(row, "brainstorm").slice(); return turns.map(publicTurn); })
        .then(function () {
          lastAssistant = turns.slice().reverse().filter(function (t) { return t.role === "assistant"; })[0];
          return ctx.op("processing", "userTurnText", "typed text + card answers + focus pick → one transcript line", { text: body.text || "", answers: body.answers || null, pick: body.pick || "", note: body.note || "" }, function () {
            var parts = []; if (body.text) parts.push(one(body.text, 2000));
            if (body.answers && lastAssistant && lastAssistant.card && lastAssistant.card.card === "questions") lastAssistant.card.questions.items.forEach(function (q) {
              var a = body.answers[q.id]; var s = Array.isArray(a) ? a.join("; ") : one(a, 1000); if (s) parts.push(q.title + " " + s);
            });
            if (body.pick) parts.push("Focus: " + one(body.pick, 160)); if (body.note) parts.push(one(body.note, 1000));
            said = parts.join("\n"); return { said: said };
          });
        }).then(function () {
          if (lastAssistant && lastAssistant.card && lastAssistant.card.ready) return true;
          if (said) {
            var card = {}; if (body.answers) card.answers = body.answers; if (body.pick) card.pick = body.pick; if (body.note) card.note = body.note; if (body.text) card.text = body.text;
            return addTurn(ctx, row, "brainstorm", "", "user", said, Object.keys(card).length ? card : null).then(function (t) { turns.push(t); return false; });
          }
          return !!(turns.length && turns.filter(function (t) { return t.role === "user" && t.content && t.content.trim() !== "(skipped those)"; }).length < 3);
        }).then(function (short) {
          if (short) return Object.assign(publicReply(lastAssistant), { leveled_status: row.leveled_status, interest: row.interest || "" });
          var readyAsked = true;
          var rounds = turns.filter(function (t) { return t.role === "user" && String(t.content || "").trim() && t.content.trim() !== "(skipped those)"; }).length;
          var assistants = turns.filter(function (t) { return t.role === "assistant"; }).length;
          var reader = readerOf(row, cals);
          return ctx.op("model", "brainstorm turn", "sonnet · " + turns.length + " turns of transcript · ready asked: " + readyAsked, modelRequest("sonnet", [{ type: "text", text: promptText("brainstormPrompt", { reader: reader, paper: paperOf(row), assessment: row.assessment, brief: row.assets_brief || [], turns: turns.map(function (t) { return { role: t.role, content: t.content }; }), readyAsked: readyAsked }, knobs) }], 4096, { key: "brainstormPrompt", prompt: "brainstormPrompt: grounded possibilities, at most one preference question, three distinct preference signals and at most three responses; human readiness is independent of resource fitting" + (readyAsked ? "; also say whether the reader is ready to plan." : "."),
              context: { reader: reader, paper: paperOf(row), assessment: row.assessment ? { depth: row.assessment.depth, depth_shift: row.assessment.depth_shift, areas: row.assessment.areas.map(function (a) { return a.area + " = " + a.graded_level; }) } : null, brief: row.assets_brief || [], transcript: turns.map(function (t) { return { role: t.role, content: t.content }; }), ready_asked: readyAsked, not_included: "the assets' links and descriptions (only the brief)" } }),
            function () {
              var B = FX.BRAINSTORM;
              reply = clone(rounds === 0 ? B.opening : rounds === 1 ? B.focus : rounds === 2 ? B.inquiry : B.ready);
              if (knobs.readyGate === "always" && readyAsked) reply.ready = true;
              return reply;
            }, Object.assign(modelMeta("sonnet", { input: 2600 + 120 * turns.length + Math.round(tokens(JSON.stringify(reader))), output: assistants === 0 ? 420 : assistants === 1 ? 300 : 120 }),
              { why: "human readiness is independent of resources, with a hard cap of three user responses" }))
            .then(function () {
              if (rounds >= 3 || reply.ready || reply.card === "none") {
                if (reply.card !== "none" || !reply.say) reply.say = "Got it — I have enough to propose a direction.";
                reply.card = "none"; reply.ready = true; delete reply.questions; delete reply.focus;
              } else {
                reply.say = "";
                if (reply.questions) { reply.questions.items = reply.questions.items.slice(0, 1); reply.questions.items.forEach(function (q) { if (q.options) q.options = q.options.slice(0, 4); }); }
                if (reply.focus) reply.focus.options = reply.focus.options.slice(0, 4);
              }
              if (!reply.interest && rounds) reply.interest = row.interest || one(turns.filter(function (t) { return t.role === "user"; }).slice(-1)[0].content, 240);
              var card = { card: reply.card, questions: reply.questions, focus: reply.focus, ready: reply.ready === true };
              var text = [reply.say]; if (reply.card === "questions") text = text.concat(reply.questions.items.map(function (q) { return "(asked) " + q.title + (q.options ? " Options: " + q.options.map(function (o) { return o.label; }).join(" / ") : ""); }));
              if (reply.card === "focus") text.push("(offered) " + reply.focus.options.map(function (o) { return o.label; }).join(" / "));
              return addTurn(ctx, row, "brainstorm", "", "assistant", text.filter(Boolean).join("\n"), card);
            }).then(function (t) { made = t; var values = { step: Math.max(Number(row.step) || 0, 7) }; if (reply.interest) values.interest = reply.interest; return patchRow(ctx, row, values, "step, interest"); })
            .then(function () { return Object.assign(publicReply(made), { leveled_status: row.leveled_status, interest: row.interest || "" }); });
        });
    };

    function findAsset(row, key) {
      var list = row.leveled && row.leveled.assets || row.assets && row.assets.assets || [];
      var parts = String(key || "").split(" :: "), parent = list.filter(function (a) { return a.title === parts[0]; })[0];
      if (!parent) return null; if (!parts[1]) return { asset: parent, parent: null };
      var child = (parent.children || []).filter(function (c) { return c.title === parts[1]; })[0];
      return child ? { asset: child, parent: parent } : null;
    }
    A.choose_asset = function (ctx, row, cals, body) {
      requireOpen(row);
      var chosen;
      return ctx.op("processing", "findAsset", "key “title” or “parent :: child” in the fitted list", { key: body.key }, function () {
        var found = findAsset(row, body.key); if (!found) throw fail("Pick one of the things on the list", 400);
        var a = clone(found.asset); delete a.children; chosen = Object.assign({ key: body.key }, a, { parent: found.parent ? found.parent.title : "" }); return chosen;
      }).then(function () { return patchRow(ctx, row, { asset_chosen: chosen, direction: null, subgoals: null, todos: null, step: Math.max(Number(row.step) || 0, 9) }, "store the choice, drop the plan"); })
        .then(function () { return { asset_chosen: chosen }; });
    };

    A.paper_grounding = function (ctx, row) {
      requireOpen(row);
      if (row.analysis && row.analysis.grounding) return Promise.resolve({ grounding: row.analysis.grounding });
      return ctx.op("model", "ground the paper", "sonnet · contribution, methods, experiments, evidence, limitations",
        modelRequest("sonnet", paperPrefix().concat([{ type: "text", text: "Extract paper grounding for project planning from the full paper." }]), 4000),
        function () { return { version: 1, contribution: "Infer an editable goal tree from conversation turns.",
          evidence: [{ id: "p1", kind: "method", claim: "Infer goals from conversation turns.", quote: "Authored simulation fixture", location: "Simulator" }],
          limits: "Authored fixture; no empirical results are supplied." }; }, modelMeta("sonnet", io({ input: 200, output: 650 }, paperIO(false))))
        .then(function (grounding) { return patchRow(ctx, row, { analysis: Object.assign({}, row.analysis, { grounding: grounding }) }, "store paper grounding").then(function () { return { grounding: grounding }; }); });
    };

    A.direction = function (ctx, row, cals, body) {
      requireOpen(row);
      if (!row.asset_chosen) throw fail("Pick what to build on first", 409);
      var feedback = one(body.revise, 1000);
      if (row.direction && !feedback && !body.regenerate) return Promise.resolve({ direction: row.direction });
      var made;
      return ctx.op("db", "select engelbart_onboarding_turns", "GET /rest/v1/engelbart_onboarding_turns?…&stage=eq.brainstorm", {}, function () { return turnsOf(row, "brainstorm").map(publicTurn); })
        .then(function (turns) {
          return ctx.op("model", feedback ? "revise the direction" : "propose one direction", "sonnet · reader, paper, interest, transcript, chosen thing, locus/sticky" + (feedback ? ", previous + feedback" : ""),
            modelRequest("sonnet", [{ type: "text", text: promptText("directionPrompt", { reader: readerOf(row, cals), paper: paperOf(row), interest: row.interest || "", assessment: row.assessment, turns: turns.map(function (t) { return { role: t.role, content: t.content }; }), asset: row.asset_chosen, leveled: row.leveled ? { locus: row.leveled.locus, sticky: row.leveled.sticky } : null, previous: feedback ? row.direction : null, feedback: feedback }, knobs) }], 4096, { key: "directionPrompt", prompt: "directionPrompt: propose one direction (title, what you would make, first visible result, why it fits, what it uses), at the reader's register" + (feedback ? "; revise the previous one according to the feedback." : "."),
              context: { reader: readerOf(row, cals), paper: paperOf(row), interest: row.interest || "", assessment: row.assessment ? { depth: row.assessment.depth, areas: row.assessment.areas.map(function (a) { return a.area + " = " + a.graded_level; }) } : null, transcript: turns.map(function (t) { return { role: t.role, content: t.content }; }), chosen_asset: row.asset_chosen, locus_and_sticky: row.leveled ? { locus: row.leveled.locus, sticky: row.leveled.sticky } : null, previous: feedback ? row.direction : undefined, feedback: feedback || undefined } }),
            function () { made = clone(feedback ? FX.REVISED_DIRECTION : FX.DIRECTION); return made; }, modelMeta("sonnet", { input: 3300 + tokens(feedback), output: 360 }));
        }).then(function () { return feedback ? addTurn(ctx, row, "direction", "", "user", feedback, null) : null; })
        .then(function () { return addTurn(ctx, row, "direction", "", "assistant", made.title + " -- " + made.what_you_would_make, made); })
        .then(function () { return patchRow(ctx, row, { direction: made, subgoals: null, todos: null, step: Math.max(Number(row.step) || 0, 9) }, "store the direction"); })
        .then(function () { return { direction: made }; });
    };

    A.subgoals = function (ctx, row, cals, body) {
      requireOpen(row);
      if (!row.direction) throw fail("Settle the direction first", 409);
      var feedback = one(body.revise, 1000);
      if (row.subgoals && !feedback && !body.regenerate) return Promise.resolve({ subgoals: row.subgoals });
      var made;
      return ctx.op("model", feedback ? "revise the three pieces" : "break the direction into three pieces", "sonnet · direction, chosen thing, locus/sticky" + (feedback ? ", previous + feedback" : ""),
        modelRequest("sonnet", [{ type: "text", text: promptText("subgoalsPrompt", { reader: readerOf(row, cals), paper: paperOf(row), direction: row.direction, asset: row.asset_chosen, leveled: row.leveled ? { locus: row.leveled.locus, sticky: row.leveled.sticky } : null, previous: feedback ? row.subgoals : null, feedback: feedback }, knobs) }], 4096, { key: "subgoalsPrompt", prompt: "subgoalsPrompt: three small human capability gains (label, description, why here): see one real thing, see one idea work, change one meaningful thing; reuse the same artifact and minimize prerequisites; active-verb labels and concise notebook-style descriptions and reasons" + (feedback ? "; revise the previous three according to the feedback." : "."),
              context: { reader: readerOf(row, cals), paper: paperOf(row), direction: row.direction, chosen_asset: row.asset_chosen, locus_and_sticky: row.leveled ? { locus: row.leveled.locus, sticky: row.leveled.sticky } : null, previous: feedback ? row.subgoals : undefined, feedback: feedback || undefined, not_included: "the brainstorm transcript" } }),
        function () { made = { subgoals: clone(feedback ? FX.REVISED_SUBGOALS : FX.SUBGOALS) }; return made; }, modelMeta("sonnet", { input: 3000 + tokens(feedback), output: 330 }))
        .then(function () { return feedback ? addTurn(ctx, row, "subgoals", "", "user", feedback, null) : null; })
        .then(function () { return addTurn(ctx, row, "subgoals", "", "assistant", made.subgoals.map(function (g) { return g.label; }).join(" / "), made); })
        .then(function () { return patchRow(ctx, row, { subgoals: made.subgoals, todos: null, step: Math.max(Number(row.step) || 0, 10) }, "store the pieces"); })
        .then(function () { return { subgoals: made.subgoals }; });
    };

    A.todos = function (ctx, row, cals, body) {
      requireOpen(row);
      if (!row.direction || !row.subgoals) throw fail("Settle the subgoals first", 409);
      if (Array.isArray(row.todos) && row.todos.length && !body.regenerate) return Promise.resolve({ todos: row.todos, name: row.project_name });
      var made;
      return ctx.op("model", "write todos for the first piece", "sonnet · direction, first subgoal, fitted resources", modelRequest("sonnet", [{ type: "text", text: promptText("todosPrompt", { reader: readerOf(row, cals), paper: paperOf(row), direction: row.direction, subgoal: row.subgoals[0], resources: row.leveled ? row.leveled.assets : [] }, knobs) }], 4096, { key: "todosPrompt", prompt: "todosPrompt: two to four todos for the first piece only, each a concrete action, plus a short project name.",
              context: { reader: readerOf(row, cals), paper: paperOf(row), direction: row.direction, first_subgoal: row.subgoals[0], resources: row.leveled ? row.leveled.assets.map(function (a) { return a.title; }) : [], not_included: "the other two subgoals, the transcript" } }),
        function () { made = clone(FX.TODOS); return made; }, modelMeta("sonnet", { input: 2800, output: 190 }))
        .then(function () { return patchRow(ctx, row, { todos: made.todos, goal_chosen: row.direction.title, project_name: row.project_name || made.name, step: Math.max(Number(row.step) || 0, 11) }, "store the todos and a name"); })
        .then(function () { return { todos: made.todos, name: row.project_name }; });
    };

    A.ask = function (ctx, row, cals, body) {
      requireOpen(row);
      var quote = one(body.quote, 240), question = one(body.question, 300);
      if (!question) throw fail("Ask something first", 400);
      var reader = readerOf(row, cals); if (DEPTHS.indexOf(String(body.level)) >= 0) reader.depth = String(body.level);
      var answer;
      return ctx.op("model", "answer a question about selected text", "sonnet · at the " + reader.depth + " register", modelRequest("sonnet", [{ type: "text", text: promptText("askPrompt", { reader: reader, paper: paperOf(row), quote: quote, question: question }, knobs) }], 4096, { key: "askPrompt", prompt: "askPrompt: answer the question about the selected text at the reader's register, in the context of this paper.",
              context: { reader: reader, paper: paperOf(row), quote: quote, question: question, register_override: DEPTHS.indexOf(String(body.level)) >= 0 ? String(body.level) : undefined } }),
        function () { answer = FX.ASK[reader.depth].replace("{quote_short}", "“" + one(quote, 40) + (quote.length > 40 ? "…" : "") + "”") + (question ? " You asked: " + question.replace(/\?$/, "") + " — the short answer is that this is the piece the project's first subgoal exercises." : ""); return { answer: answer }; },
        modelMeta("sonnet", { input: 1300 + tokens(quote + question), output: 240 }))
        .then(function () {
          return ctx.op("db", "insert engelbart_onboarding_asks", "POST /rest/v1/engelbart_onboarding_asks", [{ onboarding_id: row.id, step: Number(body.step) || 0, quote: quote, question: question, level: reader.depth, answer: answer }],
            function () { db.asks.push({ id: uid("ask"), onboarding_id: row.id, step: body.step, quote: quote, question: question, level: reader.depth, answer: answer }); save(); return [{ id: db.asks[db.asks.length - 1].id }]; });
        }).then(function () { return { answer: answer, level: reader.depth }; });
    };

    A.rewrite = function (ctx, row, cals, body) {
      requireOpen(row);
      var to = String(body.to); if (DEPTHS.indexOf(to) < 0) throw fail("That register is not on the slider", 400);
      var texts = (Array.isArray(body.texts) ? body.texts : []).map(function (t) { return one(t, 2400); }).filter(Boolean).slice(0, 40);
      if (!texts.length) throw fail("Nothing on the screen to rewrite", 400);
      var from = DEPTHS.indexOf(String(body.from)) >= 0 ? String(body.from) : (row.depth || "everyday"), out;
      var inTok = 400 + texts.reduce(function (n, t) { return n + tokens(t); }, 0);
      return ctx.op("model", "rewrite the screen at another register", "haiku · 6000 max tokens · " + texts.length + " passages, same count back", modelRequest("haiku", [{ type: "text", text: promptText("rewritePrompt", { reader: readerOf(row, cals), from: from, to: to, texts: texts }, knobs) }], 6000, { key: "rewritePrompt", prompt: "rewritePrompt: rewrite each passage from one register to another, same meaning, same count back, same order.",
              context: { reader: readerOf(row, cals), from: from, to: to, passages: texts } }),
        function () { out = texts.map(function (t) { var r = FX.REWRITES[t]; return r && r[to] ? r[to] : t; }); return { texts: out }; },
        modelMeta("haiku", { input: inTok, output: inTok - 300 }))
        .then(function () { return ctx.op("processing", "normalizeRewrite", "exactly " + texts.length + " strings back, else 502", { count: texts.length }, function () { return { ok: true }; }); })
        .then(function () { return row.depth !== to ? patchRow(ctx, row, { depth: to }, "the register follows") : null; })
        .then(function () { return { texts: out, level: to }; });
    };

    A.create = function (ctx, row, cals, body) {
      if (row.status === "created") return Promise.resolve({ ok: true, pending_setup_id: row.pending_setup_id });
      var values = {}, payload, pendingId;
      if ("project_name" in body) values.project_name = one(body.project_name, 80);
      if (Array.isArray(body.todos)) values.todos = body.todos.map(function (t) { return one(t, 300); }).filter(Boolean).slice(0, 4);
      return ctx.op("processing", "validate, then toPayload + normalizePayload", "name, direction, 3 subgoals, 2–4 todos → the payload /bart claims", values, function () {
        var merged = Object.assign({}, row, values);
        if (!merged.project_name) throw fail("Name this project first", 400);
        if (!merged.direction) throw fail("Settle the direction first", 400);
        if (!Array.isArray(merged.subgoals) || merged.subgoals.length < 3) throw fail("Settle the subgoals first", 400);
        if (!Array.isArray(merged.todos) || merged.todos.length < 2) throw fail("At least two todos", 400);
        values.goal_chosen = merged.direction.title;
        var reader = readerOf(row, cals), paper = paperOf(row), d = merged.direction;
        payload = { name: merged.project_name,
          plan: { description: [d.what_you_would_make, d.why_it_fits, "Building on “" + paper.title + "” — " + paper.one_liner, row.asset_chosen ? "Starting from " + row.asset_chosen.title + "." : "", row.interest ? "What drew them: " + row.interest : ""].filter(Boolean).join("\n\n"), unsure: [] },
          goals: [{ label: d.title, why: d.why_it_fits }], chosen: d.title, todos: [],
          subgoals: merged.subgoals.map(function (g, i) { return { label: g.label, description: g.description, why: g.why, todos: i === 0 ? merged.todos : [] }; }),
          reader: { name: reader.name, year: reader.year, major: reader.major, level: reader.depth, knowledge: reader.knowledge },
          paper: { paper_id: row.paper_id, title: paper.title, url: row.project_url || "" },
          provenance: { papers: [{ paper_id: row.paper_id, title: paper.title }], idea: { title: d.title, inspired: paper.title } } };
        return payload;
      }).then(function () {
        return ctx.op("db", "rpc engelbart_save_pending_setup", "POST /rest/v1/rpc/engelbart_save_pending_setup", { p_user_id: USER.id, p_payload: payload }, function () { pendingId = uid("pending"); return pendingId; });
      }).then(function () {
        return ctx.op("db", "upsert hc_profiles (best effort)", "POST /rest/v1/hc_profiles?on_conflict=user_id · a failure here never blocks the project", { user_id: USER.id, display_name: payload.reader.name, year: payload.reader.year, major: payload.reader.major, tech_level: payload.reader.level, knowledge: payload.reader.knowledge },
          function () { db.profiles = [{ user_id: USER.id, display_name: payload.reader.name, tech_level: payload.reader.level }]; save(); return [{ user_id: USER.id }]; });
      }).then(function () { return patchRow(ctx, row, Object.assign({}, values, { status: "created", step: 12, pending_setup_id: pendingId }), "finish the setup"); })
        .then(function () { return { ok: true, pending_setup_id: pendingId, profile_saved: true }; });
    };

    function reset(ctx, body) {
      var scope = body.scope === "all" ? "all" : "project";
      return ctx.op("db", "delete engelbart_onboardings", "DELETE /rest/v1/engelbart_onboardings?user_id=eq." + USER.id + (scope === "project" ? "&status=eq.open" : ""), { scope: scope }, function () {
        var keep = db.onboardings.filter(function (r) { return scope === "project" ? r.status !== "open" : false; });
        var gone = db.onboardings.filter(function (r) { return keep.indexOf(r) < 0; }).map(function (r) { return r.id; });
        db.onboardings = keep; db.calibrations = db.calibrations.filter(function (c) { return gone.indexOf(c.onboarding_id) < 0; }); db.turns = db.turns.filter(function (t) { return gone.indexOf(t.onboarding_id) < 0; }); db.asks = db.asks.filter(function (a) { return gone.indexOf(a.onboarding_id) < 0; });
        save(); return { deleted: gone.length };
      }).then(function () {
        if (scope !== "all") return null;
        return ctx.op("db", "delete hc_profiles", "DELETE /rest/v1/hc_profiles?user_id=eq." + USER.id, {}, function () { db.profiles = []; save(); return {}; });
      });
    }

    function onboarding(ctx, body) {
      var action = String(body.action || "");
      return verifyUser(ctx).then(function () {
        if (action === "reset") return reset(ctx, body).then(function () { return openRow(ctx, { fresh: true }); }).then(function (o) { delete o.row; return o; });
        if (action === "open") return openRow(ctx, body).then(function (o) {
          var created = o.onboarding.status === "created"; delete o.row;
          return credentials(ctx).then(function (c) { return Object.assign(o, { credit: { status: c.status, budgetUsd: c.budgetUsd, spendUsd: c.spendUsd } }); }, function (e) { if (!created) throw e; return Object.assign(o, { credit: { status: "unavailable" } }); });
        });
        var needsModel = MODEL_ACTIONS.indexOf(action) >= 0 && !(POLLED.indexOf(action) >= 0 && !(body.run || body.retry));
        return (needsModel ? credentials(ctx) : Promise.resolve(null)).then(function (creds) {
          return openRow(ctx, {}).then(function (o) {
            var fn = A[action]; if (!fn) throw fail("Unknown Engelbart onboarding action", 400);
            return fn(ctx, o.row, calsOf(o.row), body, creds);
          });
        });
      });
    }

    function device(ctx, body) {
      if (body.action !== "issue") return Promise.reject(fail("Unknown Engelbart device action", 400));
      return verifyUser(ctx).then(function () {
        return ctx.op("processing", "mint setup code", "crypto.randomBytes → XXXX-XXXX-XXXX, stored as SHA-256", {}, function () {
          var alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", code = "", h = hash("code" + db.codes.length);
          for (var i = 0; i < 12; i++) { code += alphabet[(h = (h * 1103515245 + 12345) >>> 0) % alphabet.length]; if (i % 4 === 3 && i < 11) code += "-"; }
          db.codes.push({ code: code, at: now() }); save(); return { code: code };
        });
      }).then(function (made) {
        return ctx.op("db", "rpc engelbart_issue_setup_code", "POST /rest/v1/rpc/engelbart_issue_setup_code", { p_user_id: USER.id, p_code_hash: "sha256:••••", p_expires_in: 900 }, function () { return { ok: true }; })
          .then(function () { return { code: made.code, expiresInSeconds: 900 }; });
      });
    }

    function setup(ctx, body) {
      var action = String(body.action || "");
      return verifyUser(ctx).then(function () {
        if (action === "own_paper") {
          var id;
          return ctx.op("db", "rpc engelbart_curator_upsert_paper", "POST /rest/v1/rpc/engelbart_curator_upsert_paper · an unlisted paper owned by this member", { p_title: one(body.title, 200), p_owner: USER.id, p_listed: false },
            function () { id = uid("paper"); db.papers.push({ id: id, title: one(body.title, 200), bytes: 0, owner: USER.id, pdf_path: "" }); save(); return { id: id }; })
            .then(function () { return ctx.op("storage", "sign an upload URL", "POST " + SUPA + "/storage/v1/object/upload/sign/berkeley-papers/papers/" + id + ".pdf · x-upsert: true", { headers: { Authorization: "Bearer <service_role>" } }, function () { return { url: "/object/upload/sign/berkeley-papers/papers/" + id + ".pdf?token=••••" }; }); })
            .then(function () { return ctx.op("processing", "ownPaperToken", "HMAC-SHA256(paper_id · user_id) — proof this member made this paper just now", { paper_id: id, user_id: USER.id }, function () { return { token: "hmac-••••" }; }); })
            .then(function () { return { id: id, token: "hmac-" + hash(id).toString(16), upload: { uploadUrl: SUPA + "/storage/v1/object/upload/sign/berkeley-papers/papers/" + id + ".pdf?token=sim", anonKey: "anon" } }; });
        }
        if (action === "own_paper_saved") {
          return ctx.op("processing", "verify own-paper token", "HMAC-SHA256 · timingSafeEqual", { id: body.id, token: body.token }, function () {
            var p = db.papers.filter(function (x) { return x.id === body.id; })[0]; if (!p || body.token !== "hmac-" + hash(p.id).toString(16)) throw fail("That paper is not yours", 403); return { ok: true };
          }).then(function () {
            return ctx.op("db", "rpc engelbart_curator_set_paper_pdf", "POST /rest/v1/rpc/engelbart_curator_set_paper_pdf", { p_id: body.id, p_pdf_path: "papers/" + body.id + ".pdf" }, function () {
              db.papers.forEach(function (p) { if (p.id === body.id) p.pdf_path = "papers/" + p.id + ".pdf"; }); save(); return { ok: true };
            });
          }).then(function () { return { ok: true }; });
        }
        throw fail("Unknown setup action", 400);
      });
    }

    function storagePut(ctx, path, init) {
      var id = (path.match(/papers\/([^/]+)\.pdf/) || [])[1], bytes = init.body && (init.body.size || init.body.byteLength || init.body.bytes) || 0;
      return ctx.op("storage", "PUT the PDF (browser → Storage, signed URL)", "PUT " + SUPA + path + " · never through a Vercel function", { bytes: bytes, content_type: "application/pdf", "x-upsert": "true", headers: { apikey: "anon" } },
        function () { db.papers.forEach(function (p) { if (p.id === id) p.bytes = bytes; }); save(); return { Key: "berkeley-papers/papers/" + id + ".pdf" }; });
    }

    function config(ctx) {
      return ctx.op("processing", "browser-safe runtime config", "SUPABASE_URL, SUPABASE_ANON_KEY, LITELLM_BASE_URL present?", { env: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "LITELLM_BASE_URL"] },
        function () { return { supabaseUrl: SUPA, supabaseAnonKey: "anon", creditsEnabled: true }; });
    }

    function response(status, value) {
      return { ok: status < 300, status: status, headers: { get: function () { return "application/json"; } },
        json: function () { return Promise.resolve(clone(value)); }, text: function () { return Promise.resolve(JSON.stringify(value)); } };
    }
    function handle(url, init) {
      init = init || {};
      var method = String(init.method || "GET").toUpperCase(), u = String(url), path = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0], body;
      if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (e) { body = {}; } }
      // A replayed upload carries only its size: { bytes } stands in for the File.
      var bytes = init.body && typeof init.body !== "string" ? (init.body.size || init.body.byteLength || init.body.bytes || 0) : undefined;
      var ctx = stage({ path: path, method: method, body: body, bytes: bytes, url: u, rawBody: typeof init.body === "string" ? init.body : null }), p;
      try {
        if (path === "/api/engelbart-config") p = config(ctx);
        else if (path === "/api/engelbart-device") p = device(ctx, body || {});
        else if (path === "/api/engelbart-setup") p = setup(ctx, body || {});
        else if (path === "/api/engelbart-onboarding") p = onboarding(ctx, body || {});
        else if (/^\/storage\/v1\/object\/upload\/sign\//.test(path)) p = storagePut(ctx, path, init);
        else p = Promise.reject(fail("not found", 404));
      } catch (e) { p = Promise.reject(e); }
      return p.then(function (value) { ctx.end("ok", 200, value); return response(200, value); }, function (e) {
        var status = e.statusCode || 500, message = status >= 500 && !e.statusCode ? "something went wrong" : e.message;
        ctx.end("error", status, { error: message }); return response(status, { error: message });
      });
    }
    function local(name, input, output) {
      var ctx = stage({ path: "(browser)", method: "LOCAL", body: { action: name } });
      return ctx.op("processing", name, "in the page, no network", input, function () { return output; }).then(function (v) { ctx.end("ok", 0, v); return v; });
    }
    function isSim(url) { var u = String(url); return /^\/api\//.test(u) || u.indexOf(SUPA) === 0; }

    return { handle: handle, local: local, isSim: isSim, knobs: knobs, setSpeed: function (x) { speed = x; }, setPrompts: function (p) { knobs.prompts = p && typeof p === "object" ? p : null; }, reset: function () { db = fresh(); seedParticipant(); save(); },
      state: function () { return clone(db); }, USER: USER, DEFAULT_KNOBS: DEFAULT_KNOBS };
  }

  window.EngelbartSim = { create: create, redact: redact, DEFAULT_KNOBS: DEFAULT_KNOBS, FLOW: { nodes: NODES, edges: EDGES }, FIELD_NODE: FIELD_NODE };
})();
