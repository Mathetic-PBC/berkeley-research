/* Mock-ups, head to head. Two of the design mock-ups from the `mock-us`
 * bucket side by side; the member picks the better one, and a single-
 * elimination bracket (tournament.js) runs until four places are decided.
 * The placing goes to their row in engelbart_mockup_rankings through
 * /api/engelbart-mockups, which also lists the mock-ups and serves each
 * one's HTML into a sandboxed frame. The bracket lives in localStorage
 * between picks, so a refresh resumes it; the Supabase auth boot is the
 * one every setup page uses. */
(function () {
  "use strict";

  var T = window.EngelbartTournament;
  var app = document.getElementById("app");

  var client = null;   // supabase client, once config is fetched
  var session = null;  // the member's session, once signed in

  var st = {
    screen: "loading",  // loading | signin | play | saving | done | empty | error
    error: "",
    mockups: [],        // [{id, name}] from the bucket
    byId: {},
    t: null,            // the bracket in play, or null
    saved: null,        // the member's saved placing, or null
    busy: false,        // a save is in flight
    arm: false,         // Start over pressed once, waiting for the second press
  };

  // --- little DOM helpers ---------------------------------------------------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function on(node, event, fn) { node.addEventListener(event, fn); return node; }
  function dark() {
    try { return window.localStorage && window.localStorage.getItem("hc-setup-theme") === "dark"; }
    catch (e) { return false; }
  }
  function nameOf(id) { var m = st.byId[id]; return m ? m.name : String(id); }
  function htmlUrl(id) { return "/api/engelbart-mockups?html=" + encodeURIComponent(id); }

  // --- the bracket between visits ------------------------------------------

  function storeKey() { return "engelbart-mockups:" + (session && session.user ? session.user.id : "anon"); }
  function remember() {
    try {
      if (st.t) window.localStorage.setItem(storeKey(), JSON.stringify(st.t));
      else window.localStorage.removeItem(storeKey());
    } catch (e) { /* a private window keeps it in memory only */ }
  }
  function recall() {
    try { return JSON.parse(window.localStorage.getItem(storeKey()) || "null"); }
    catch (e) { return null; }
  }

  // --- the server -----------------------------------------------------------

  function api(method, body) {
    var init = { method: method, headers: { Accept: "application/json", Authorization: "Bearer " + (session && session.access_token) } };
    if (body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch("/api/engelbart-mockups", init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (value) {
        if (!r.ok) throw new Error(value.error || "the request failed");
        return value;
      });
    });
  }

  function load() {
    st.screen = "loading"; st.error = ""; draw();
    return api("GET").then(function (out) {
      st.mockups = (out.mockups || []).filter(function (m) { return m && m.id; });
      st.byId = {};
      st.mockups.forEach(function (m) { st.byId[m.id] = m; });
      st.saved = out.saved || null;
      var ids = st.mockups.map(function (m) { return m.id; });
      var held = T.restore(recall(), ids);
      if (held && T.done(held)) { st.t = held; finish(); return; }   // decided, not yet saved
      if (held) { st.t = held; st.screen = "play"; draw(); return; }
      if (st.saved) { st.t = null; st.screen = "done"; draw(); return; }
      if (!ids.length) { st.screen = "empty"; draw(); return; }
      start();
    }).catch(function (e) { st.screen = "error"; st.error = e.message; draw(); });
  }

  function start() {
    st.arm = false;
    st.t = T.create(T.shuffle(st.mockups.map(function (m) { return m.id; })));
    remember();
    if (T.done(st.t)) { finish(); return; }
    st.screen = "play"; draw();
  }

  function choose(id) {
    if (st.busy || st.screen !== "play" || !st.t || !T.pick(st.t, id)) return;
    st.arm = false;
    remember();
    if (T.done(st.t)) finish(); else draw();
  }

  function finish() {
    var placing = T.placing(st.t) || [];
    st.busy = true; st.error = ""; st.screen = "saving"; draw();
    api("POST", { top: placing.map(function (id) { return { id: id }; }), picks: st.t.picks, entrants: st.t.entrants.length })
      .then(function (out) {
        st.saved = out.saved || null; st.t = null; remember();
        st.busy = false; st.screen = "done"; draw();
      })
      .catch(function (e) { st.busy = false; st.error = e.message || "the placing could not be saved"; draw(); });
  }

  // --- drawing --------------------------------------------------------------

  function draw() {
    app.setAttribute("data-dark", dark() ? "true" : "false");
    app.textContent = "";
    drawTop();
    if (st.screen === "play") { drawPlay(); return; }
    var mid = el("div", "mk-mid");
    var box = el("div", "mk-box in");
    mid.appendChild(box);
    app.appendChild(mid);
    if (st.screen === "loading") drawLoading(box);
    else if (st.screen === "signin") drawSignin(box);
    else if (st.screen === "saving") drawSaving(box);
    else if (st.screen === "done") drawDone(box);
    else if (st.screen === "empty") drawEmpty(box);
    else drawError(box);
  }

  function dots() {
    var d = el("span", "mk-dots");
    d.appendChild(el("i", "", "·")); d.appendChild(el("i", "", "·")); d.appendChild(el("i", "", "·"));
    return d;
  }

  function drawTop() {
    var top = el("div", "mk-top");
    var brand = el("a", "mk-brand");
    brand.setAttribute("href", "/engelbart");
    brand.appendChild(document.createTextNode("Engelbart "));
    brand.appendChild(el("span", "", "· mock-ups"));
    top.appendChild(brand);
    if (st.screen === "play" && st.t) {
      var cur = T.current(st.t), p = T.progress(st.t);
      var round = el("div", "mk-round");
      round.appendChild(el("span", "mk-round-name", T.roundName(st.t, cur)));
      if (cur && cur.of > 1) round.appendChild(el("span", "mk-round-of", "match " + (cur.index + 1) + " of " + cur.of));
      top.appendChild(round);
      var bar = el("div", "mk-bar"), fill = el("i");
      fill.style.width = (p.total ? Math.round(100 * p.made / p.total) : 0) + "%";
      bar.appendChild(fill); top.appendChild(bar);
      top.appendChild(el("span", "mk-count", p.made + " / " + p.total + " picks"));
      var over = el("button", "mk-ghost", st.arm ? "Really start over?" : "Start over");
      over.type = "button";
      if (st.arm) over.setAttribute("data-arm", "1");
      on(over, "click", function () {
        if (!st.arm) { st.arm = true; draw(); setTimeout(function () { if (st.arm) { st.arm = false; draw(); } }, 3000); return; }
        start();
      });
      top.appendChild(over);
    } else {
      top.appendChild(el("div", "mk-bar"));
    }
    if (session) {
      var acct = el("div", "mk-acct");
      acct.appendChild(el("span", "", session.user && session.user.email || "signed in"));
      var out = el("button", "", "Sign out"); out.type = "button";
      on(out, "click", function () {
        if (client) client.auth.signOut();
        window.location.href = "/engelbart/signin";
      });
      acct.appendChild(out);
      top.appendChild(acct);
    }
    app.appendChild(top);
  }

  function pane(side, id) {
    var box = el("div", "mk-pane");
    var head = el("div", "mk-pane-head");
    head.appendChild(el("span", "mk-side", side === "a" ? "left" : "right"));
    head.appendChild(el("span", "mk-name", nameOf(id)));
    var open = el("a", "mk-open", "open ↗");
    open.setAttribute("href", htmlUrl(id)); open.setAttribute("target", "_blank"); open.setAttribute("rel", "noopener");
    head.appendChild(open);
    var pick = el("button", "mk-pick", side === "a" ? "◀ This one" : "This one ▶");
    pick.type = "button";
    on(pick, "click", function () { choose(id); });
    head.appendChild(pick);
    box.appendChild(head);
    var frame = el("iframe", "mk-frame");
    // Scripts, popups and forms, and nothing of our origin: the mock-up runs
    // on an opaque origin and cannot see the session beside it.
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-forms");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", nameOf(id));
    frame.setAttribute("src", htmlUrl(id));
    box.appendChild(frame);
    return box;
  }

  function drawPlay() {
    var cur = T.current(st.t);
    if (!cur) { finish(); return; }
    var arena = el("div", "mk-arena");
    arena.appendChild(pane("a", cur.a));
    arena.appendChild(pane("b", cur.b));
    app.appendChild(arena);
    var hint = el("div", "mk-hint");
    hint.appendChild(document.createTextNode("Pick the better one. "));
    hint.appendChild(el("kbd", "", "←")); hint.appendChild(document.createTextNode(" left, "));
    hint.appendChild(el("kbd", "", "→")); hint.appendChild(document.createTextNode(" right."));
    app.appendChild(hint);
  }

  function drawLoading(box) {
    box.appendChild(el("h1", "mk-title", "Mock-ups"));
    var p = el("p", "mk-lede", "Waking up "); p.appendChild(dots()); box.appendChild(p);
  }

  function drawSignin(box) {
    box.appendChild(el("h1", "mk-title", "Mock-ups, head to head"));
    box.appendChild(el("p", "mk-lede",
      "Two design mock-ups at a time; pick the better one. A bracket runs until"
      + " four places are decided, and your top four are kept with your account."));
    var go = el("a", "mk-cta");
    go.setAttribute("href", "/engelbart/signin");
    go.appendChild(el("span", "", "Sign in to begin ›"));
    box.appendChild(go);
  }

  function drawSaving(box) {
    var placing = st.t ? T.placing(st.t) || [] : [];
    box.appendChild(el("h1", "mk-title", "Your top four"));
    box.appendChild(placesList(placing));
    if (st.error) {
      box.appendChild(el("p", "mk-error", st.error));
      var acts = el("div", "mk-actions");
      var again = el("button", "mk-cta", "Try saving again"); again.type = "button";
      on(again, "click", function () { if (!st.busy) finish(); });
      acts.appendChild(again);
      box.appendChild(acts);
    } else {
      var p = el("p", "mk-note", "Saving "); p.appendChild(dots()); box.appendChild(p);
    }
  }

  function placesList(ids) {
    var list = el("ol", "mk-places");
    ids.forEach(function (id, i) {
      var row = el("li", "mk-place");
      row.appendChild(el("span", "mk-rank", String(i + 1)));
      row.appendChild(el("span", "mk-place-name", nameOf(id)));
      var open = el("a", "mk-open", "open ↗");
      open.setAttribute("href", htmlUrl(id)); open.setAttribute("target", "_blank"); open.setAttribute("rel", "noopener");
      row.appendChild(open);
      list.appendChild(row);
    });
    return list;
  }

  function drawDone(box) {
    var top = (st.saved && st.saved.top) || [];
    box.appendChild(el("h1", "mk-title", "Your top four"));
    top.forEach(function (t) { if (t && t.id && !st.byId[t.id]) st.byId[t.id] = { id: t.id, name: t.name || t.id }; });
    box.appendChild(placesList(top.map(function (t) { return t.id; })));
    var when = st.saved && st.saved.updated_at ? new Date(st.saved.updated_at) : null;
    box.appendChild(el("p", "mk-note", "Saved" + (when && !isNaN(when.getTime()) ? " " + when.toLocaleString() : "")
      + (st.saved && st.saved.entrants ? " · " + st.saved.entrants + " mock-ups in the bracket" : "") + "."));
    var acts = el("div", "mk-actions");
    var again = el("button", "mk-cta", "Rank again ›"); again.type = "button";
    on(again, "click", start);
    acts.appendChild(again);
    box.appendChild(acts);
  }

  function drawEmpty(box) {
    box.appendChild(el("h1", "mk-title", "No mock-ups yet"));
    box.appendChild(el("p", "mk-lede", "The bucket has no HTML pages in it. Upload some and come back."));
  }

  function drawError(box) {
    box.appendChild(el("h1", "mk-title", "Mock-ups"));
    box.appendChild(el("p", "mk-error", st.error || "Something went wrong."));
    var acts = el("div", "mk-actions");
    var again = el("button", "mk-cta", "Try again"); again.type = "button";
    on(again, "click", function () { if (session) load(); else boot(); });
    acts.appendChild(again);
    box.appendChild(acts);
  }

  on(document, "keydown", function (e) {
    if (st.screen !== "play" || !st.t || e.metaKey || e.ctrlKey || e.altKey) return;
    var cur = T.current(st.t);
    if (!cur) return;
    if (e.key === "ArrowLeft" || e.key === "1") { e.preventDefault(); choose(cur.a); }
    else if (e.key === "ArrowRight" || e.key === "2") { e.preventDefault(); choose(cur.b); }
  });

  try {
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
  } catch (e) { /* an old browser keeps the theme it opened with */ }

  // --- boot -----------------------------------------------------------------

  function enter(next) {
    var had = session;
    session = next;
    if (!session) { st.screen = "signin"; st.t = null; draw(); return; }
    if (!had || st.screen === "signin" || st.screen === "loading") load();
  }

  function boot() {
    st.screen = "loading"; st.error = ""; draw();
    fetch("/api/engelbart-config", { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("configuration unavailable");
        return r.json();
      })
      .then(function (config) {
        if (client) return client.auth.getSession();
        client = window.supabase.createClient(
          config.supabaseUrl, config.supabaseAnonKey,
          { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
        client.auth.onAuthStateChange(function (_event, next) { enter(next); });
        return client.auth.getSession();
      })
      .then(function (held) {
        if (held.error) throw held.error;
        enter(held.data.session);
      })
      .catch(function () {
        st.screen = "error";
        st.error = "Engelbart is not available on this deployment yet.";
        draw();
      });
  }

  boot();
  window.__engelbartMockups = { state: function () { return st; }, draw: draw };
})();
