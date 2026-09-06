/* The real setup page (setup.js, install.js, setup.css, unmodified) inside the
 * debugger, on one of two backends named on the URL. Each is an adapter of its
 * own, and there is no path from one to the other: nothing the real backend
 * fails to do is answered by the simulator, and nothing the simulator answers
 * is a reading of the uploaded file.
 *
 * SimulatedBackend (frame.html, the default): fetch() to /api and to the fake
 * Supabase host is answered in-page by sim-backend.js from one saved test case
 * (fixture.js, EGB_FIXTURES, chosen by ?fixture=), supabase-js is replaced by
 * a session that is always signed in, and every simulated operation is posted
 * to the parent. The test case is named in the ready message, so the debugger
 * can say on screen what the answers are.
 *
 * RealBackend (frame-real.html, ?mode=real): nothing is replaced and, with one
 * addition, nothing is intercepted: the page's own fetch is watched, and the
 * edited prompts the debugger chose for this run ride along on the model
 * actions (`prompt_overrides`), for the member's own onboarding. The page
 * boots on the pinned supabase-js, reads the member's own session from this
 * origin's storage, and talks to the real endpoints, which do real work: model
 * calls spend credit, writes land in the member's onboarding, uploads go to
 * Storage and are read back by the model. What this file adds is observation
 * only: each request the page makes to /api or to Storage is reported to the
 * parent as it starts and as it ends, with the trace id the server names in
 * its reply (x-engelbart-trace-id), so the debugger can read that trace's
 * telemetry and put it under the request. Bodies are redacted here, before
 * they leave the frame. A failure is reported as the failure it was.
 *
 * The real page loads no fixture and no simulator. Should one be present all
 * the same (frame.html opened with ?mode=real, say), the real backend refuses
 * to boot rather than run beside it: every /api request is failed with a
 * message that says why.
 *
 * In both modes the parent is the debugger page on this same origin. */
(function () {
  "use strict";
  var ORIGIN = window.location.origin;
  function post(message) { window.parent.postMessage(message, ORIGIN); }
  var params = new URLSearchParams(window.location.search);
  var MODE = params.get("mode") === "real" ? "real" : "sim";
  // Real mode: the edited prompts the debugger chose for this run, or null for the server's own.
  var promptOverrides = null;
  var speed = Number(params.get("speed") || 1);
  var sim = null;
  // What the parent is told about the backend on ready: which adapter, and for the simulator, which test case.
  var backend = null;

  /* Anything that could be a credential is replaced before a body is posted:
   * by the name of the field it sits in, or by its shape. The same names the
   * simulator hides, plus the ones the real endpoints exchange (a member's own
   * model key, the signed upload URL, the anon key that goes with it). */
  var SECRET_KEYS = /^(authorization|apikey|anonkey|anon_key|servicerolekey|service_role_key|supabaseanonkey|masterkey|key|api_key|key_ciphertext|key_iv|key_tag|access_token|refresh_token|provider_token|paper_token|token|p_payload_token|uploadurl|upload_url|password|secret)$/i;
  function redact(v, key, depth) {
    depth = depth || 0;
    if (depth > 12) return "…";
    if (v == null) return v;
    if (typeof v === "string") {
      if (key && SECRET_KEYS.test(key)) return "••••••••";
      if (/^sk-/.test(v)) return "sk-••••••••";
      if (/^egb_/.test(v)) return "egb_••••••••";
      if (/^eyJ[A-Za-z0-9._-]{16,}/.test(v)) return "eyJ•••••••• (jwt)";
      if (/[?&]token=/.test(v)) return v.replace(/([?&]token=)[^&#]*/g, "$1••••••••");
      if (v.length > 400 && /^[A-Za-z0-9+/=\s]+$/.test(v)) return "<base64 " + Math.round(v.length * 0.75 / 1024) + " KB omitted>";
      return v.length > 20000 ? v.slice(0, 20000) + "… (" + v.length + " chars)" : v;
    }
    if (Array.isArray(v)) return v.map(function (x) { return redact(x, null, depth + 1); });
    if (typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = redact(v[k], k, depth + 1); }); return o; }
    return v;
  }

  // The simulator's globals: what the simulated backend needs, and what the real one must not find.
  function simulatorPresent() { return !!(window.EngelbartSim || window.EGB_FIXTURE || window.EGB_FIXTURES); }

  /* SimulatedBackend: one simulated account per test environment, answered from one test case. */
  function SimulatedBackend() {
    if (!window.EngelbartSim || !window.EGB_FIXTURES) return refuse("sim", "The simulator did not load; this frame cannot simulate anything.");
    var env = String(params.get("env") || "default").replace(/[^A-Za-z0-9_-]/g, "");
    var participant = null; try { participant = params.get("p") ? JSON.parse(params.get("p")) : null; } catch (e) { participant = null; }
    try {
      sim = window.EngelbartSim.create({ persist: "egb.sim.db." + env, speed: speed, recordRaw: true, participant: participant, fixture: params.get("fixture") || null,
        emit: function (ev) { post({ egb: "trace", event: ev }); } });
    } catch (e) { return refuse("sim", String(e && e.message || e)); }
    var simFetch = window.fetch.bind(window);
    window.fetch = function (url, init) { return sim.isSim(url) ? sim.handle(url, init) : simFetch(url, init); };
    var session = { access_token: "eyJ" + "sim".repeat(20), user: sim.USER };
    window.supabase = { createClient: function () { return { auth: {
      getSession: function () {
        return sim.local("supabase-js auth.getSession", { store: "localStorage sb-*-auth-token", persistSession: true, autoRefreshToken: true },
          { session: { user: sim.USER.email, expires_in: 3600 } }).then(function () { return { data: { session: session }, error: null }; });
      },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
    } }; } };
    return { name: "SimulatedBackend", fixture: sim.fixture };
  }

  /* RealBackend: the page's own fetch and session, watched and never answered here. */
  function RealBackend() {
    if (simulatorPresent()) return refuse("real", "Real mode refused to start: simulator scripts (fixture.js or sim-backend.js) are loaded in this frame. Open the real frame page, which loads neither.");
    observeReal();
    return { name: "RealBackend", fixture: null };
  }

  /* A backend that cannot be what the URL asked for does not become the other one: every /api request
   * and every Storage request fails with the reason, the page shows that error, and the parent is told. */
  function refuse(mode, why) {
    window.fetch = function () { return Promise.reject(new Error(why)); };
    window.supabase = { createClient: function () { return { auth: {
      getSession: function () { return Promise.reject(new Error(why)); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } } }; } };
    // The product's own error screen shows the reason (its first request fails with it); this note stays
    // beside it, outside the container the product redraws.
    try {
      var note = document.createElement("div");
      note.setAttribute("data-egb-refused", mode);
      note.style.cssText = "margin:24px;padding:14px 16px;border:1px solid #e70022;border-radius:8px;font:13px/1.5 system-ui,sans-serif;color:#171717";
      note.textContent = why;
      document.body.appendChild(note);
    } catch (e) { /* no document to write into; the fetch failure carries the reason */ }
    return { name: mode === "real" ? "RealBackend" : "SimulatedBackend", fixture: null, refused: why };
  }

  backend = MODE === "real" ? RealBackend() : SimulatedBackend();

  /* Real mode: the page's own fetch, watched. Only same-origin /api requests and
   * the browser's PUT of a paper to Storage are reported; anything else (fonts,
   * supabase-js talking to Auth) passes through unseen. */
  function observeReal() {
    var realFetch = window.fetch.bind(window);
    var seq = 0;
    var BACKGROUND = ["analysis", "assets", "leveled"];
    // The actions that ask the model, so the edited prompts go only where they are read.
    var MODEL_ACTIONS = ["sources", "analysis", "assets", "leveled", "answer", "brainstorm", "asset_ask", "direction", "subgoals", "details", "goals", "todos", "ask", "rewrite"];
    function pathOf(u) {
      if (u.indexOf("/") === 0) return u.split("#")[0];
      if (u.indexOf(ORIGIN + "/") === 0) return u.slice(ORIGIN.length).split("#")[0];
      return null;
    }
    function bodyOf(init, req) {
      var raw = init && init.body != null ? init.body : null;
      if (raw == null && req && typeof req.text === "function") return Promise.resolve(null); // a Request's body is not re-read here
      if (typeof raw === "string") { try { return Promise.resolve(JSON.parse(raw)); } catch (e) { return Promise.resolve({ text: raw.slice(0, 2000) }); } }
      if (raw && typeof raw.size === "number") return Promise.resolve({ bytes: raw.size, type: raw.type || null, name: raw.name || null });
      if (raw && raw.byteLength != null) return Promise.resolve({ bytes: raw.byteLength });
      return Promise.resolve(raw == null ? null : { body: "(not a JSON string)" });
    }
    window.fetch = function (url, init) {
      var isReq = typeof Request !== "undefined" && url instanceof Request;
      var u = String(isReq ? url.url : url);
      var method = String((init && init.method) || (isReq && url.method) || "GET").toUpperCase();
      var same = pathOf(u);
      var isApi = same && /^\/api\//.test(same);
      var isStorage = !same && method === "PUT" && /\/storage\/v1\/object\//.test(u);
      if (!isApi && !isStorage) return realFetch(url, init);
      var id = "rq-" + (++seq) + "-" + Date.now().toString(36);
      var started = Date.now();
      // A signed upload URL carries its token in the query; the path alone is reported.
      var path = isApi ? same.split("?")[0] : u.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
      var where = isApi ? "api" : "storage";
      return bodyOf(init, isReq ? url : null).then(function (body) {
        var action = body && typeof body === "object" && body.action ? String(body.action) : (isStorage ? "upload" : path.split("/").pop());
        var background = BACKGROUND.indexOf(action) >= 0 && body && (body.run || body.retry);
        var poll = BACKGROUND.indexOf(action) >= 0 && !background;
        var reported = body;
        // The debugger's edited prompts, added to a model action's JSON body as the page sent it; the
        // report names which prompts went, not their text.
        if (promptOverrides && isApi && path === "/api/engelbart-onboarding" && method === "POST" && !poll && MODEL_ACTIONS.indexOf(action) >= 0 && init && typeof init.body === "string" && body && typeof body === "object") {
          init = Object.assign({}, init, { body: JSON.stringify(Object.assign({}, body, { prompt_overrides: promptOverrides })) });
          reported = Object.assign({}, body, { prompt_overrides: Object.keys(promptOverrides) });
        }
        post({ egb: "request", id: id, at: started, method: method, path: path, where: where, action: action, body: redact(reported), step: lastStep, bg: !!background, poll: !!poll });
        return realFetch(url, init).then(function (r) {
          var traceId = null; try { traceId = r.headers.get("x-engelbart-trace-id"); } catch (e) { traceId = null; }
          var done = function (reply) { post({ egb: "response", id: id, at: Date.now(), ms: Date.now() - started, status: r.status, ok: r.ok, trace_id: traceId && /^[0-9a-f]{32}$/i.test(traceId) ? traceId.toLowerCase() : null, body: reply }); return r; };
          if (isStorage) return done({ ok: r.ok, status: r.status });
          var copy; try { copy = r.clone(); } catch (e) { copy = null; }
          if (!copy) return done(null);
          return copy.text().then(function (text) { var parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text ? { text: text.slice(0, 2000) } : null; } return done(redact(parsed)); }, function () { return done(null); });
        }, function (err) {
          post({ egb: "response", id: id, at: Date.now(), ms: Date.now() - started, status: 0, ok: false, trace_id: null, body: null, error: String(err && err.message || err) });
          throw err;
        });
      });
    };
    // The member's session, as setup.js reads it: reported so the debugger can say when there is none
    // (the page then leaves for /engelbart/signin, which refuses to be framed).
    var lib = window.supabase;
    if (lib && typeof lib.createClient === "function") {
      window.supabase = { createClient: function () {
        var client = lib.createClient.apply(lib, arguments);
        var getSession = client.auth.getSession.bind(client.auth);
        client.auth.getSession = function () {
          return getSession().then(function (out) {
            var s = out && out.data && out.data.session;
            post({ egb: "session", signedIn: !!s, email: s && s.user && s.user.email || "" });
            return out;
          });
        };
        return client;
      } };
    } else {
      post({ egb: "session", signedIn: false, email: "", error: "supabase-js did not load" });
    }
  }

  function notice(text) { post({ egb: "notice", text: text }); }

  /* Triggers: a button in the product that starts a new recording when it is
   * pressed. Picked by pointing at it; matched afterwards by its class and
   * text, because setup.js rebuilds the DOM on every redraw. The click is
   * seen in the capture phase, so the message reaches the debugger before
   * the handler's own requests do. */
  var picking = false, hovered = null, triggers = [], autoAll = false;
  var CLICKABLE = "button, .ob-opt, .ob-goal, .ob-as-row, .ob-row, .ob-seed, .ob-stop, .ob-pdot, .ob-drop";
  function keyOf(target) {
    var b = target && target.closest ? target.closest(CLICKABLE) : null; if (!b) return null;
    var cls = String(b.className || "").split(/\s+/).filter(function (c) { return /^ob-/.test(c); })[0] || b.tagName.toLowerCase();
    // The label is the first text leaf of the control, not everything inside it: a rail row is
    // "Name", not "Name" glued to the value it shows; an option is its label, not its "why".
    var leaves = [];
    (function walk(n) { if (leaves.length > 4) return; if (n.nodeType === 3) { var t = String(n.nodeValue).replace(/[›‹✓·×⌃←↓]/g, " ").replace(/\s+/g, " ").trim(); if (t) leaves.push(t); return; } var kids = n.childNodes || []; for (var i = 0; i < kids.length; i++) walk(kids[i]); })(b);
    var first = leaves.filter(function (t) { return /[A-Za-z0-9]/.test(t); })[0] || leaves[0] || "";
    return { cls: cls, text: first.slice(0, 40) };
  }
  function matches(t, k) { return !!k && t.cls === k.cls && (!t.text || t.text === k.text); }
  function unhover() { if (hovered) { hovered.style.outline = ""; hovered.style.outlineOffset = ""; hovered = null; } }
  function stopPick() { picking = false; unhover(); document.body.style.cursor = ""; }
  document.addEventListener("mousemove", function (e) {
    if (!picking) return; var b = e.target && e.target.closest ? e.target.closest(CLICKABLE) : null;
    if (b === hovered) return; unhover(); if (b) { hovered = b; b.style.outline = "2px solid #0070f3"; b.style.outlineOffset = "2px"; }
  }, true);
  document.addEventListener("keydown", function (e) { if (picking && e.key === "Escape") { e.stopPropagation(); stopPick(); post({ egb: "pickCancel" }); } }, true);
  document.addEventListener("click", function (e) {
    var k = keyOf(e.target);
    if (k && !picking) post({ egb: "press", at: Date.now(), trigger: k, step: lastStep });
    if (picking) { e.preventDefault(); e.stopPropagation(); stopPick(); if (k) post({ egb: "picked", trigger: k }); else post({ egb: "pickCancel" }); return; }
    if (k && (autoAll || triggers.some(function (t) { return matches(t, k); }))) post({ egb: "trigger", trigger: k });
  }, true);
  window.addEventListener("message", function (e) {
    // Commands come only from the debugger page that embeds this frame.
    if (e.origin !== ORIGIN || e.source !== window.parent) return;
    var m = e.data; if (!m || m.egb !== "cmd") return;
    if (m.cmd === "pick") { picking = true; document.body.style.cursor = "crosshair"; }
    if (m.cmd === "cancelPick") stopPick();
    if (m.cmd === "triggers") triggers = Array.isArray(m.value) ? m.value : [];
    if (m.cmd === "auto") autoAll = !!m.value;
    if (m.cmd === "reload") window.location.reload();
    if (!sim) {
      // Edited prompts are the one control that reaches the real backend: kept here, sent with each
      // model action, for the member's own run. The simulator's other controls do not exist here:
      // nothing to speed up, and no record to reset, because the record is the member's real onboarding.
      if (m.cmd === "prompts") { promptOverrides = m.value && typeof m.value === "object" && !Array.isArray(m.value) && Object.keys(m.value).length ? m.value : null; return; }
      if (m.cmd === "snapshot") post({ egb: "snapshot", state: null });
      if (m.cmd === "reset" || m.cmd === "speed") notice(backend.refused ? "The frame refused to start: " + backend.refused : "That is a simulator control; it does nothing in Real mode.");
      return;
    }
    if (m.cmd === "speed") sim.setSpeed(Number(m.value));
    if (m.cmd === "prompts") sim.setPrompts(m.value);
    if (m.cmd === "snapshot") post({ egb: "snapshot", state: sim.state() });
    if (m.cmd === "reset") { sim.reset(); window.location.reload(); }
  });
  post({ egb: "ready", speed: speed, mode: MODE, backend: backend.name, fixture: backend.fixture, refused: backend.refused || null });

  /* Which step is on screen. setup.js marks the rail's active row; the Done screen has no rail
   * row, so it is read from its own heading. Reported whenever it changes. */
  var lastStep = null;
  function reportStep() {
    var row = document.querySelector('.ob-row[data-active="1"] .ob-label');
    var label = row ? String(row.textContent || "").trim() : (document.querySelector(".ob-done-t, .ob-ins-host") ? "Done" : null);
    if (label && label !== lastStep) { lastStep = label; post({ egb: "step", label: label }); }
  }
  var app = document.getElementById("app");
  if (app && window.MutationObserver) new MutationObserver(function () { reportStep(); }).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-active"] });
  reportStep();
})();
