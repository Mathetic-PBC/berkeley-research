/* The real setup page (setup.js, install.js, setup.css, unmodified) run
 * against the simulated control plane. fetch() to /api and to the fake
 * Supabase host is answered in-page; supabase-js is replaced by a session
 * that is always signed in. Every operation is posted to the parent, which
 * is the debugger page on this same origin. */
(function () {
  "use strict";
  var ORIGIN = window.location.origin;
  function post(message) { window.parent.postMessage(message, ORIGIN); }
  var params = new URLSearchParams(window.location.search);
  var speed = Number(params.get("speed") || 1);
  // One simulated account per test environment: the record lives under the environment's key.
  var env = String(params.get("env") || "default").replace(/[^A-Za-z0-9_-]/g, "");
  var participant = null; try { participant = params.get("p") ? JSON.parse(params.get("p")) : null; } catch (e) { participant = null; }
  var sim = window.EngelbartSim.create({ persist: "egb.sim.db." + env, speed: speed, recordRaw: true, participant: participant,
    emit: function (ev) { post({ egb: "trace", event: ev }); } });
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, init) { return sim.isSim(url) ? sim.handle(url, init) : realFetch(url, init); };
  var session = { access_token: "eyJ" + "sim".repeat(20), user: sim.USER };
  window.supabase = { createClient: function () { return { auth: {
    getSession: function () {
      return sim.local("supabase-js auth.getSession", { store: "localStorage sb-*-auth-token", persistSession: true, autoRefreshToken: true },
        { session: { user: sim.USER.email, expires_in: 3600 } }).then(function () { return { data: { session: session }, error: null }; });
    },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
  } }; } };

  function fixturePdf() {
    var head = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n";
    var pad = new Uint8Array(1998042 - head.length - 6); // the fixture paper weighs 1.9 MB
    return new File([head, pad, "%%EOF\n"], "Inspectable Intent in Agentic Programming.pdf", { type: "application/pdf" });
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
    if (m.cmd === "speed") sim.setSpeed(Number(m.value));
    if (m.cmd === "prompts") sim.setPrompts(m.value);
    if (m.cmd === "pick") { picking = true; document.body.style.cursor = "crosshair"; }
    if (m.cmd === "cancelPick") stopPick();
    if (m.cmd === "triggers") triggers = Array.isArray(m.value) ? m.value : [];
    if (m.cmd === "auto") autoAll = !!m.value;
    if (m.cmd === "snapshot") post({ egb: "snapshot", state: sim.state() });
    if (m.cmd === "reset") { sim.reset(); window.location.reload(); }
    if (m.cmd === "reload") window.location.reload();
    if (m.cmd === "dropFixture") {
      var drop = document.querySelector(".ob-drop");
      if (!drop) { notice("The Paper step is not on screen; the fixture paper can only be dropped there."); return; }
      try {
        var dt = new DataTransfer(); dt.items.add(fixturePdf());
        drop.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      } catch (err) { notice("This browser would not let the page synthesize a drop: " + err.message); }
    }
  });
  post({ egb: "ready", speed: speed });

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
