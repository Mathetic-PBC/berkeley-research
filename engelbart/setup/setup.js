/* Setting up a first project, after an account exists.
 *
 * Twelve steps, one row on the server: every Continue writes what was typed,
 * so a closed tab loses nothing and a reload redraws at the stored step.
 * The paper is read in the background from the moment it is submitted;
 * the reader keeps going and meets its questions two steps later.
 *
 * The rendering follows docs/superpowers/reference/onboarding-flow/
 * markup.html, flattened to plain DOM under the /engelbart CSP: no inline
 * <style>, no style attribute in markup, every look in setup.css. The only
 * styles set from here are the geometry this file computes (bar heights,
 * fill widths, the slider thumb, the dot delays). */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var API = "/api/engelbart-onboarding";
  var SETUP_API = "/api/engelbart-setup";
  var DEVICE_API = "/api/engelbart-device";

  var LABELS = ["Name", "Year", "Major", "Explanations", "Paper", "Install", "Topics", "Brainstorm", "Assets", "Direction", "Subgoals", "Todos"];
  var DONE = LABELS.length;  // the step after the last label
  var YEARS = ["First year", "Second year", "Third year", "Fourth year"];
  var MAJORS = ["Computer Science", "Electrical Engineering & Computer Sciences", "Data Science", "Cognitive Science",
    "Molecular & Cell Biology", "Bioengineering", "Mechanical Engineering", "Applied Mathematics", "Statistics", "Physics",
    "Economics", "Business Administration", "Political Science", "Psychology", "Public Health", "English", "History",
    "Sociology", "Architecture", "Undeclared"];
  var DEPTHS = [
    { key: "everyday", label: "Everyday", phrase: "in everyday language", desc: "Plain words, no jargon, analogies where they help." },
    { key: "some", label: "Some detail", phrase: "with some technical detail", desc: "Uses some technical language when necessary; assumes some familiarity." },
    { key: "technical", label: "Technical", phrase: "technical", desc: "Assumes you know the field well; explanations of niche concepts." },
    { key: "expert", label: "Expert", phrase: "expert-level", desc: "Terse and precise; uses specific jargon and references advanced concepts." }
  ];
  var FAMILIARITY = [
    { label: "I'm completely lost", desc: "I wouldn't understand what the project does or what to learn first." },
    { label: "I wouldn't know where to start", desc: "I follow the main ideas, but wouldn't know how to start building or contributing." },
    { label: "I can get oriented", desc: "I grasp the general ideas, but need heavy guidance on the paper, code, or methods." },
    { label: "I can get started", desc: "I can navigate the paper and code, spot what to learn, and begin a task with little guidance." },
    { label: "I can extend it", desc: "I can independently implement, troubleshoot, compare approaches, and design extensions." }
  ];
  var LADDER = [
    { level: 0, label: "Wouldn't know where to start", desc: "I wouldn't recognize most of the important concepts." },
    { level: 25, label: "I can follow it", desc: "I recognize the main ideas when someone explains them." },
    { level: 50, label: "I can explain it", desc: "I could explain the core ideas in my own words, from memory." },
    { level: 75, label: "I can use it", desc: "I could use the ideas to solve a new problem or make a design decision." },
    { level: 100, label: "I can reason with it", desc: "I could spot mistakes, compare approaches, and explain when an idea would or wouldn't work." }
  ];
  var MAX_PDF = 20 * 1024 * 1024;

  var client = null;    // supabase client
  var session = null;   // the member's session

  // The row is the truth; `ui` is what only this tab knows.
  var st = {
    screen: "loading",  // loading | signin | flow | error
    row: null,          // the onboarding row as the server last returned it
    cals: [],           // calibration rows
    turns: [],          // the brainstorm transcript, as stored
    credit: null,
    step: 0,            // the step on screen (row.step is the furthest reached)
    base: 0,            // 4 once the profile steps are behind them: Paper is then the first of six
    test: false,        // ?test=true: every step is a click away, and the record can be cleared
    ui: {
      yearOther: false, yearText: "",
      depthPos: 0.25, depthTouched: false,
      pfile: null,      // { name, meta, id, token } once uploaded; { name, meta, uploading } meanwhile
      pover: false, popen: null, plink: "", prepo: "", pfam: 0.2, psending: false,
      draft: "",
      fIdx: 0, fam: {}, fAnswers: {},
      qIdx: 0, goalPick: "", goalOther: "", goalOtherOn: false, todos: [], newTodo: "", projName: "",
      askBtn: null, askOpen: false, askQuote: "", askText: "", asks: [], made: null,
      bs: { answers: {}, pick: "", note: "", text: "", thinking: false, planAsked: false },   // brainstorm
      as: { open: {}, picked: "" },     // assets
      reg: { open: false, pos: null, busy: false, rewrites: {} },   // the register control: unfolded, pending slider position, in-flight, rewritten text by step
      todoConfirm: -1,                  // the todo row whose × was pressed once
      tour: false,                      // the one-time tour between Install and Topics
      change: { open: false, text: "", thinking: false, log: [] }                             // direction / subgoals
    },
    busy: "",           // what is being generated, for the indicator
    error: ""
  };

  // --- helpers ---------------------------------------------------------------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function on(node, event, fn) { node.addEventListener(event, fn); return node; }
  function attr(node, name, value) { node.setAttribute(name, value); return node; }
  function str(v) { return v == null ? "" : String(v); }
  function trunc(t, n) { t = str(t); return t.length > n ? t.slice(0, n - 1).trim() + "…" : t; }
  function snap(pos, n) { return Math.max(0, Math.min(n - 1, Math.ceil(pos * n) - 1)); }

  // One POST, one JSON answer, one error with the server's words in it.
  function post(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (session && session.access_token) },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (value) {
        if (!r.ok) { var e = new Error(value.error || "the request failed"); e.status = r.status; throw e; }
        return value;
      });
    });
  }

  // api("step", { … }) is the form every step uses; api({ action: "sources", … })
  // is the same call written out when the body is the whole request.
  function api(action, body) {
    return post(API, typeof action === "string" ? Object.assign({ action: action }, body || {}) : action);
  }

  function setupApi(payload) { return post(SETUP_API, payload); }

  // One write per Continue. The row comes back and replaces ours.
  function save(step, fields) {
    return api("step", { step: step, fields: fields || {} }).then(function (out) {
      // A reply read before the paper's reading landed must not un-finish
      // it: the reading reports straight into this state, and the row it
      // was read from may be older than what this tab already knows.
      var was = st.row;
      st.row = out.onboarding;
      if (was) keepFinished(was, st.row, "analysis"), keepFinished(was, st.row, "assets"), keepFinished(was, st.row, "leveled");
      return out;
    });
  }

  function keepFinished(was, now, name) {
    var status = name + "_status", error = name + "_error";
    if ((was[status] === "done" || was[status] === "error") && now[status] !== "done") {
      now[status] = was[status]; now[name] = was[name]; now[error] = was[error];
      if (name === "assets") now.assets_brief = was.assets_brief;
    }
  }

  function go(n) {
    st.step = n;
    st.error = "";
    st.ui.todoConfirm = -1; st.ui.reg.pos = null; st.ui.reg.open = false;
    if (st.ui.askOpen) st.ui.askOpen = false;
    st.ui.askBtn = null;
    draw();
  }

  function adopt(out) {
    st.row = out.onboarding;
    st.cals = out.calibrations || [];
    st.turns = out.turns || [];
    if (out.credit) st.credit = out.credit;
    var r = st.row;
    st.ui.yearOther = !!r.year && YEARS.indexOf(r.year) < 0;
    st.ui.yearText = st.ui.yearOther ? r.year : "";
    var d = DEPTHS.map(function (x) { return x.key; }).indexOf(r.depth);
    if (d >= 0) { st.ui.depthPos = (d + 1) / 4; st.ui.depthTouched = true; }
    st.ui.plink = r.project_url || ""; st.ui.prepo = r.repo_url || "";
    if (r.paper_id) st.ui.pfile = { name: r.paper_title || "Your paper", meta: "PDF", id: r.paper_id, token: st.ui.pfile && st.ui.pfile.token };
    if (typeof r.paper_familiarity === "number") st.ui.pfam = (r.paper_familiarity + 1) / 5;
    st.ui.draft = r.project_draft || "";
    st.ui.goalPick = r.goal_chosen || ""; st.ui.todos = (r.todos || []).slice(); st.ui.projName = r.project_name || "";
    // The profile is asked once. A member who has finished a setup before
    // starts the next one at the paper, and the rail counts from there.
    st.base = out.profile_reused ? 4 : 0;
    st.step = r.status === "created" ? DONE : Math.max(st.base, Math.min(DONE - 1, r.step || 0));
  }

  // What only this tab knew about the record it is leaving behind.
  function forgetUi() {
    st.ui.fam = {}; st.ui.fAnswers = {}; st.ui.fIdx = 0; st.ui.qIdx = 0;
    st.ui.goalPick = ""; st.ui.goalOther = ""; st.ui.goalOtherOn = false; st.ui.todos = []; st.ui.newTodo = ""; st.ui.projName = "";
    st.ui.asks = []; st.ui.made = null; st.ui.pfile = null; st.ui.draft = "";
    st.ui.bs = { answers: {}, pick: "", note: "", text: "", thinking: false, planAsked: false };
    st.ui.as = { open: {}, picked: "", threads: {}, drafts: {}, chatOpen: {}, thinking: {} };
    st.ui.change = { open: false, text: "", thinking: false, log: [] };
    st.turns = [];
    st.ui.yearOther = false; st.ui.yearText = ""; st.ui.depthPos = 0.25; st.ui.depthTouched = false;
    st.ui.plink = ""; st.ui.prepo = ""; st.ui.pfam = 0.2; st.ui.psending = false; st.ui.popen = null;
  }

  // The paper is the fifth step of ten on a first setup, and the first of six
  // once the profile is behind them: the count on screen says which.
  function count(i, suffix) {
    return "Step " + (i - st.base + 1) + " of " + (DONE - st.base) + (suffix ? " \u00b7 " + suffix : "");
  }

  // --- the rail ----------------------------------------------------------------

  function depthIndex() { return snap(st.ui.depthPos, 4); }
  function railValues() {
    var r = st.row || {}, u = st.ui;
    return [str(r.name), str(r.year), str(r.major), r.depth ? DEPTHS[depthIndex()].label : "",
      u.pfile ? trunc(u.pfile.name, 26) : "", st.step > 5 ? "Connected" : "",
      r.assessment && st.step > 6 ? r.assessment.areas.length + " areas" : "",
      st.step > 7 ? trunc(str(r.interest) || "Brainstormed", 26) : "",
      r.asset_chosen && st.step > 8 ? trunc(str(r.asset_chosen.title), 26) : "",
      r.direction && st.step > 9 ? trunc(str(r.direction.title), 26) : "",
      r.subgoals && st.step > 10 ? r.subgoals.length + " pieces" : "",
      st.step >= DONE ? (r.todos || []).length + " todos" : ""];
  }

  function railView() {
    var rail = el("div", "ob-rail");
    rail.appendChild(el("div", "ob-brand", "Engelbart"));
    rail.appendChild(el("div", "ob-caption", st.base ? "Setting up another project" : "Setting up your first project"));
    var vals = railValues(), reach = (st.row && st.row.step) || 0;
    if (st.base) {
      // The four answers the rail no longer walks through, and the way back to them.
      var profile = el("div", "ob-profile");
      profile.appendChild(el("div", "ob-profile-line", vals.slice(0, 4).filter(Boolean).join(" \u00b7 ")));
      var change = el("button", "ob-link", "Change who this is for"); change.type = "button";
      profile.appendChild(on(change, "click", function () { st.base = 0; go(0); }));
      rail.appendChild(profile);
    }
    var steps = el("div", "ob-steps");
    LABELS.forEach(function (label, i) {
      if (i < st.base) return;
      var wrap = el("div");
      if (i > st.base) wrap.appendChild(attr(el("span", "ob-con"), "data-on", st.step >= i ? "1" : "0"));
      var done = !!vals[i] && st.step > i, active = st.step === i;
      // In test mode every step is a click away, whatever the record holds.
      var reachable = st.test || (i <= reach && st.step < DONE);
      var row = el("div", "ob-row");
      attr(row, "data-active", active ? "1" : "0");
      attr(row, "data-reach", reachable && !active ? "1" : "0");
      if (reachable && !active) on(row, "click", function () { go(i); });
      var circle = el("span", "ob-circle", done ? "✓" : String(i - st.base + 1));
      attr(circle, "data-state", done ? "done" : active ? "now" : "todo");
      row.appendChild(circle);
      var text = el("span", "ob-grow");
      var lab = el("span", "ob-label", label);
      attr(lab, "data-active", active ? "1" : "0");
      attr(lab, "data-done", done && !active ? "1" : "0");
      text.appendChild(lab);
      if (done && !active) text.appendChild(el("span", "ob-value", vals[i]));
      row.appendChild(text); wrap.appendChild(row); steps.appendChild(wrap);
    });
    rail.appendChild(steps);
    var r0 = st.row || {};
    var working = r0.analysis_status === "running" ? "Reading your paper in the background"
      : r0.assets_status === "running" ? "Finding what the paper rests on"
      : r0.leveled_status === "running" ? "Fitting the resources to you" : "";
    if (working) {
      var reading = el("div", "ob-reading");
      reading.appendChild(dots());
      reading.appendChild(el("span", "", working));
      rail.appendChild(reading);
    }
    if (st.test) rail.appendChild(testBar());
    return rail;
  }

  // --- test mode -----------------------------------------------------------------
  //
  // ?test=true on the URL. The rail's steps all answer a click, and two
  // buttons clear the record on the server: this project, or everything the
  // account has said here (the account itself stays).

  function testBar() {
    var bar = el("div", "ob-test");
    bar.appendChild(el("div", "ob-test-cap", "Test mode"));
    bar.appendChild(el("div", "ob-hint", "Every step above is clickable."));
    [{ label: "Clear this project", scope: "project", ask: "Delete this setup and start a new one?" },
      { label: "Clear everything", scope: "all", ask: "Delete every setup, its answers, and the saved profile? The account stays." }]
      .forEach(function (b) {
        var bt = el("button", "ob-ghost", b.label); bt.type = "button";
        on(bt, "click", function () {
          if (window.confirm && !window.confirm(b.ask)) return;
          st.busy = "reset"; draw();
          api("reset", { scope: b.scope }).then(function (o) { st.busy = ""; forgetUi(); adopt(o); draw(); }).catch(fail);
        });
        bar.appendChild(bt);
      });
    return bar;
  }

  function dots() {
    var grid = el("span", "ob-dots");
    for (var i = 0; i < 9; i++) { var d = el("span", "ob-dot"); d.style.animationDelay = (i * 90) + "ms"; grid.appendChild(d); }
    return grid;
  }

  // --- the bar slider ----------------------------------------------------------
  // opts = { stops: [{label, desc}], pos: 0-1, onCommit(p), ends: [a,b], grid: bool }
  //
  // The slider owns its drag. Redrawing the page on every pointermove would
  // destroy the element under the finger mid-gesture, so nothing in here calls
  // draw(): the bars, the rule, the thumb and the caption are repainted in
  // place, and only the release -- which may land anywhere on the page, hence
  // the window listeners -- reports the snapped position back to the step.
  function slider(opts) {
    var n = opts.stops.length, pos = opts.pos, box = el("div", "ob-slider");
    var head = el("div"), name = el("div", "ob-slider-name"), desc = el("div", "ob-slider-desc");
    head.appendChild(name); head.appendChild(desc); box.appendChild(head);
    var track = attr(el("div", "ob-track"), "data-drag", "0");
    if (opts.locked) attr(box, "data-locked", "1");
    var bars = el("div", "ob-bars"), fills = [];
    for (var b = 0; b < n; b++) {
      var bar = el("div", "ob-bar"); bar.style.height = (25 + 75 * (b / (n - 1))) + "%";
      var fill = el("div", "ob-bar-fill"); fills.push(fill);
      bar.appendChild(fill); bars.appendChild(bar);
    }
    track.appendChild(bars);
    track.appendChild(el("div", "ob-line"));
    var lineOn = el("div", "ob-line-on"); track.appendChild(lineOn);
    var thumb = el("div", "ob-thumb"); track.appendChild(thumb);
    box.appendChild(track);
    var stopButtons = [];
    if (opts.grid) {
      var stops = attr(el("div", "ob-stops"), "data-n", String(n));
      opts.stops.forEach(function (s, i) {
        var bt = el("button", "ob-stop", s.label); bt.type = "button";
        on(bt, "click", function () { pos = (i + 1) / n; paint(); opts.onCommit(pos); });
        stopButtons.push(bt); stops.appendChild(bt);
      });
      box.appendChild(stops);
    } else {
      var ends = el("div", "ob-ends"); ends.appendChild(el("span", "", opts.ends[0])); ends.appendChild(el("span", "", opts.ends[1])); box.appendChild(ends);
    }

    function paint() {
      var idx = snap(pos, n);
      name.textContent = opts.stops[idx].label;
      desc.textContent = opts.stops[idx].desc;
      fills.forEach(function (f, i) { f.style.width = (Math.min(1, Math.max(0, pos * n - i)) * 100).toFixed(1) + "%"; });
      lineOn.style.width = (pos * 100).toFixed(2) + "%";
      thumb.style.left = (pos * 100).toFixed(2) + "%";
      stopButtons.forEach(function (bt, i) { bt.setAttribute("data-on", i === idx ? "1" : "0"); });
    }
    paint();

    function at(e) { var r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
    var dragging = false;
    function move(e) { if (!dragging) return; pos = at(e); paint(); }
    function end() {
      if (!dragging) return;
      dragging = false;
      track.setAttribute("data-drag", "0");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      pos = Math.max(1, Math.min(n, Math.ceil(pos * n))) / n;
      paint();
      opts.onCommit(pos);
    }
    on(track, "pointerdown", function (e) {
      if (opts.locked) return;
      dragging = true;
      track.setAttribute("data-drag", "1");
      pos = at(e); paint();
      // On window, not on the track: a finger that has left the track still
      // has to be able to let go, and the release is what commits.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
    return box;
  }

  // --- drawing -----------------------------------------------------------------

  // A redraw within a step must not look like a new page: the entry animation
  // is for arriving, and every click, pick and slider release redraws. The
  // stylesheet reads this flag and holds the animation while it is set.
  var drawn = { screen: "", step: -1 }, lastMain = null, draws = 0;

  var lastContent = null;

  function draw() {
    var still = drawn.screen === st.screen && drawn.step === st.step;
    drawn = { screen: st.screen, step: st.step }; draws += 1;
    // The main column is the scroll container and it is rebuilt on every
    // redraw, so its position has to be carried over by hand.
    var keep = still && lastMain ? lastMain.scrollTop : 0;
    if (lastContent && window.EngelbartInstall) window.EngelbartInstall.stop(lastContent);
    app.setAttribute("data-still", still ? "1" : "0");
    app.setAttribute("data-test", st.test ? "1" : "0");
    app.textContent = "";
    if (st.screen === "loading") { app.appendChild(el("div", "ob-wait", st.error || "Waking up…")); return; }
    if (st.screen === "signin") { window.location.href = "/engelbart/signin"; return; }
    if (st.screen === "error") { var e = el("div", "ob-wait"); e.appendChild(el("div", "ob-err", st.error)); app.appendChild(e); return; }
    app.appendChild(railView());
    var main = el("div", "ob-main"), body = el("div", "ob-body"), content = el("div", "ob-content");
    content.id = "content";
    lastContent = content;
    var drawers = [drawName, drawYear, drawMajor, drawDepth, drawPaper, drawInstall, drawTopics, drawBrainstorm, drawAssets,
      drawDirection, drawSubgoals, drawTodos, drawDone];
    drawers[Math.min(st.step, drawers.length - 1)](content);
    if (st.error) content.appendChild(el("div", "ob-err", st.error));
    applyRewrites(content);
    body.appendChild(content);
    if (typeof askPanel === "function") askPanel(body);
    main.appendChild(body); app.appendChild(main);
    // From the paper on: the steps before it ask about the reader and have
    // nothing generated to rewrite, and the Explanations step is the slider.
    if (st.step >= 4 && st.step <= 11) app.appendChild(registerView());
    lastMain = main; main.scrollTop = keep;
    // Something on the page asked to be brought into view: shown a little
    // below the top of the pane, with the lines before it still readable,
    // rather than at the bottom edge where a new turn would otherwise land.
    if (st.ui.scrollTo) {
      var target = st.ui.scrollTo === "thinking" ? content.querySelector("[data-thinking]") : content.querySelector("[data-latest]");
      st.ui.scrollTo = null;
      if (target && target.getBoundingClientRect && main.getBoundingClientRect) {
        var d = target.getBoundingClientRect().top - main.getBoundingClientRect().top - 160;
        if (d > 0) main.scrollTop = keep + d;
      }
    }
    var focus = content.querySelector("[autofocus]"); if (focus) focus.focus();
    // A redraw rebuilds the text the reader highlighted, which drops the
    // browser's selection. While they are asking about it, select it again so
    // the highlight stays on what the question is about.
    if (st.ui.askOpen && st.ui.askQuote) reselect(content, st.ui.askQuote);
  }

  function reselect(root, quote) {
    if (!window.getSelection || !document.createRange || !root.childNodes) return;
    var want = String(quote).replace(/\s+/g, " ").trim(); if (!want) return;
    var hit = null, offset = -1;
    (function walk(n) {
      if (hit) return;
      if (n.nodeType === 3) { var i = String(n.nodeValue).indexOf(want); if (i >= 0) { hit = n; offset = i; } return; }
      var kids = n.childNodes || []; for (var k = 0; k < kids.length && !hit; k++) walk(kids[k]);
    })(root);
    if (!hit) return;
    try {
      var range = document.createRange(); range.setStart(hit, offset); range.setEnd(hit, offset + want.length);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } catch (e) { /* a selection is a nicety */ }
  }

  // --- the register control ---------------------------------------------------
  //
  // Top right on every step: the same four-stop slider as the Explanations
  // step. Move it and press Regenerate, and what is on the screen is rewritten
  // at that register -- one Haiku call with the passages as they stand -- and
  // the profile's depth follows, so what comes next is written there too.

  var PROSE = ["ob-title", "ob-sub", "ob-q", "ob-question", "ob-area-role", "ob-area-name", "ob-paper-sum", "ob-goal-label", "ob-goal-why",
    "ob-goal-title", "ob-dir-body", "ob-dir-why", "ob-dir-first", "ob-sg-label", "ob-sg-desc", "ob-sg-why", "ob-as-h1", "ob-as-sub", "ob-as-title",
    "ob-as-desc", "ob-as-why", "ob-bs-said", "ob-slider-name", "ob-slider-desc", "ob-cap", "ob-q-label", "ob-wait-t", "ob-done-t", "ob-done-s", "ob-hint"];
  function proseNodes(root) {
    var out = [];
    (function walk(n) {
      if (!n || !n.children) return;
      var cs = String(n.className || "").split(/\s+/);
      var hit = PROSE.some(function (k) { return cs.indexOf(k) >= 0; });
      if (cs.indexOf("ob-bs-text") >= 0) { for (var i = 0; i < n.children.length; i++) if (String(n.children[i].tagName).toLowerCase() === "p") out.push(n.children[i]); return; }
      if (hit) {
        // A prose node with children (a "Why · " label and its text) yields
        // its text leaves; the label itself is furniture and stays.
        if (n.children.length === 0) { out.push(n); return; }
        (function leaves(m) {
          for (var i = 0; i < m.children.length; i++) {
            var c = m.children[i], cc = String(c.className || "").split(/\s+/), tag = String(c.tagName || "").toLowerCase();
            if (tag === "button" || tag === "input" || tag === "textarea" || cc.indexOf("ob-as-lead") >= 0 || cc.indexOf("ob-tiny") >= 0) continue;
            if (c.children && c.children.length) leaves(c); else out.push(c);
          }
        })(n);
        return;
      }
      for (var j = 0; j < n.children.length; j++) walk(n.children[j]);
    })(root);
    return out.filter(function (n) { return str(n.textContent).trim().length >= 12; });
  }
  function regDepth() { return st.row && st.row.depth ? st.row.depth : "everyday"; }
  function regIndex(key) { var i = DEPTHS.map(function (d) { return d.key; }).indexOf(key); return i < 0 ? 0 : i; }
  function registerView() {
    var reg = st.ui.reg, cur = regDepth(), pos = reg.pos != null ? reg.pos : (regIndex(cur) + 1) / DEPTHS.length;
    var next = DEPTHS[snap(pos, DEPTHS.length)].key, changed = next !== cur;
    // Folded, it is one word: the current register. That word opens it.
    var box = attr(attr(el("div", "ob-reg"), "data-busy", reg.busy ? "1" : "0"), "data-open", reg.open || reg.busy ? "1" : "0");
    var word = el("button", "ob-reg-word", DEPTHS[regIndex(cur)].label); word.type = "button";
    word.setAttribute("aria-label", reg.open ? "hide the explanations slider" : "change how technical the page is");
    on(word, "click", function () { reg.open = !reg.open; if (!reg.open) reg.pos = null; draw(); });
    box.appendChild(word);
    if (!reg.open && !reg.busy) return box;
    box.appendChild(slider({ stops: DEPTHS, pos: pos, grid: true, onCommit: function (p) { reg.pos = p; draw(); } }));
    var acts = el("div", "ob-reg-acts");
    if (reg.busy) { acts.appendChild(dots()); acts.appendChild(el("span", "ob-hint", "Rewriting")); }
    else if (changed) {
      var go_ = el("button", "ob-pill ob-reg-go", "Regenerate"); go_.type = "button";
      on(go_, "click", regenerate); acts.appendChild(go_);
    }
    box.appendChild(acts);
    return box;
  }
  function regenerate() {
    var reg = st.ui.reg, cur = regDepth(), to = DEPTHS[snap(reg.pos, DEPTHS.length)].key;
    if (reg.busy || to === cur) return;
    var content = document.getElementById("content"); if (!content) return;
    var nodes = proseNodes(content), texts = [], seen = {};
    nodes.forEach(function (n) { var t = str(n.textContent).replace(/\s+/g, " ").trim(); if (!seen[t]) { seen[t] = true; texts.push(t); } });
    texts = texts.slice(0, 40);
    reg.busy = true; st.error = ""; draw();
    api("rewrite", { from: cur, to: to, texts: texts }).then(function (out) {
      reg.busy = false; reg.pos = null; reg.open = false;
      var map = reg.rewrites[st.step] || (reg.rewrites[st.step] = {});
      texts.forEach(function (t, i) { var r = str(out.texts && out.texts[i]).trim(); if (r && r !== t) map[t] = r; });
      st.row.depth = out.level || to;
      draw();
    }).catch(function (e) { reg.busy = false; fail(e); });
  }
  // After each draw the screen is rebuilt from the record, which is still at
  // the register it was written in; the rewrites are laid back over it.
  function applyRewrites(content) {
    var map = st.ui.reg.rewrites[st.step]; if (!map) return;
    proseNodes(content).forEach(function (n) {
      var t = str(n.textContent).replace(/\s+/g, " ").trim();
      if (map[t]) n.textContent = map[t];
    });
  }

  function stepBox(content, count, title) {
    var box = el("div", "ob-step");
    box.appendChild(el("div", "ob-count", count));
    if (title) box.appendChild(el("div", "ob-title", title));
    content.appendChild(box);
    return box;
  }

  // The click is always bound: a disabled button fires none, and the steps
  // enable this one by clearing `disabled` once something has been typed.
  function cta(label, disabled, fn) {
    var b = el("button", "ob-cta"); b.type = "button";
    b.appendChild(el("span", "", label));
    b.appendChild(el("span", "ob-cta-arrow", "›"));
    if (disabled) b.setAttribute("disabled", "disabled");
    on(b, "click", function () { if (!b.disabled) fn(); });
    return b;
  }

  function field(value, placeholder, oninput, onenter, multiline) {
    var box = el("div", "ob-field"), input = el(multiline ? "textarea" : "input");
    input.value = value; input.placeholder = placeholder; input.spellcheck = false; input.setAttribute("autofocus", "");
    if (multiline) input.rows = 3;
    on(input, "input", function () { oninput(input.value); });
    on(input, "keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && onenter) { e.preventDefault(); onenter(); } });
    box.appendChild(input); return box;
  }

  function option(label, on_, pick, square) {
    var row = attr(el("div", "ob-opt"), "data-on", on_ ? "1" : "0");
    var mark = el("span", "ob-mark"); if (square) attr(mark, "data-square", "1"); row.appendChild(mark);
    row.appendChild(el("span", "ob-opt-text", label)); on(row, "click", pick); return row;
  }

  // A session that has expired mid-setup is not an error to read: the record
  // is safe on the server, and signing in again comes back to this step.
  function fail(error) {
    st.busy = "";
    if (error && error.status === 401) { st.screen = "signin"; st.error = ""; draw(); return; }
    st.error = (error && error.message) || "something went wrong";
    draw();
  }

  // 0 Name
  function drawName(content) {
    var box = stepBox(content, count(0), "What is your name?");
    var name = str(st.row.name);
    var next = function () { if (!name.trim()) return; save(1, { name: name.trim() }).then(function () { go(1); }).catch(fail); };
    // The button exists before the field that enables it can be typed into.
    var acts = el("div", "ob-actions"), button = cta("Continue", !name.trim(), next);
    box.appendChild(field(name, "type your name…", function (v) {
      name = v; st.row.name = v; button.disabled = !v.trim();
    }, next));
    acts.appendChild(button); box.appendChild(acts);
  }

  // 1 Year
  function drawYear(content) {
    var box = stepBox(content, count(1), "What year are you?");
    var opts = el("div", "ob-opts");
    YEARS.forEach(function (label) {
      opts.appendChild(option(label, !st.ui.yearOther && st.row.year === label, function () {
        st.ui.yearOther = false; st.row.year = label; draw();
        setTimeout(function () { save(2, { year: label }).then(function () { go(2); }).catch(fail); }, 180);
      }));
    });
    opts.appendChild(option("Something else", st.ui.yearOther, function () { st.ui.yearOther = !st.ui.yearOther; st.row.year = ""; draw(); }));
    box.appendChild(opts);
    if (st.ui.yearOther) {
      var next = function () { if (!st.ui.yearText.trim()) return; save(2, { year: st.ui.yearText.trim() }).then(function () { go(2); }).catch(fail); };
      var acts = el("div", "ob-actions"), button = cta("Continue", !st.ui.yearText.trim(), next);
      box.appendChild(field(st.ui.yearText, "transferring, fifth-year, grad…", function (v) {
        st.ui.yearText = v; button.disabled = !v.trim();
      }, next));
      acts.appendChild(button); box.appendChild(acts);
    }
  }

  // 2 Major
  function drawMajor(content) {
    var box = stepBox(content, count(2), "What is your major?");
    var major = str(st.row.major);
    var next = function () { if (!major.trim()) return; save(3, { major: major.trim() }).then(function () { go(3); }).catch(fail); };
    var seeds = el("div", "ob-seeds");
    var acts = el("div", "ob-actions"), button = cta("Continue", !major.trim(), next);
    // Only the seeds change as they type. Redrawing the step per keystroke
    // would replace the field under the cursor and put the caret at the end.
    function fillSeeds() {
      seeds.textContent = "";
      var typed = major.trim().toLowerCase();
      MAJORS.filter(function (m) { var low = m.toLowerCase(); return low !== typed && (!typed || low.indexOf(typed) >= 0); }).slice(0, 6)
        .forEach(function (m) {
          var bt = el("button", "ob-seed", m); bt.type = "button";
          on(bt, "click", function () {
            st.row.major = m; draw(); setTimeout(function () { save(3, { major: m }).then(function () { go(3); }).catch(fail); }, 180);
          });
          seeds.appendChild(bt);
        });
    }
    box.appendChild(field(major, "start typing…", function (v) {
      major = v; st.row.major = v; button.disabled = !v.trim(); fillSeeds();
    }, next));
    fillSeeds();
    box.appendChild(seeds);
    acts.appendChild(button); box.appendChild(acts);
  }

  // 3 Explanations
  function drawDepth(content) {
    var box = stepBox(content, count(3), "How technical should explanations be?");
    var panel = el("div", "ob-panel");
    panel.appendChild(slider({ stops: DEPTHS, pos: st.ui.depthPos, grid: true,
      onCommit: function (p) {
        st.ui.depthPos = p; st.ui.depthTouched = true; st.row.depth = DEPTHS[snap(p, DEPTHS.length)].key; draw();
      } }));
    box.appendChild(panel);
    var acts = attr(el("div", "ob-actions"), "data-between", "1");
    acts.appendChild(el("span", "ob-hint", st.ui.depthTouched ? "" : "Drag to change."));
    acts.appendChild(cta("Continue", false, function () {
      save(4, { depth: DEPTHS[depthIndex()].key }).then(function () { go(4); }).catch(fail);
    }));
    box.appendChild(acts);
  }

  // 4 Paper -- the PDF goes to Storage first; the row learns its id at Continue.
  function upload(file) {
    if (!file || file.type !== "application/pdf") { st.error = "Drop a PDF."; draw(); return; }
    if (file.size > MAX_PDF) { st.error = "That PDF is larger than 20 MB."; draw(); return; }
    var name = file.name.replace(/\.pdf$/i, ""), meta = "PDF · " + (file.size / 1024 / 1024).toFixed(1) + " MB";
    st.ui.pfile = { name: name, meta: meta, uploading: true }; st.error = ""; draw();
    setupApi({ action: "own_paper", title: name, wantsUpload: true }).then(function (made) {
      // Straight from the browser to Storage, with the anon key the curator's
      // uploader also sends; the token proves this paper was made for us.
      if (!made.upload || !made.upload.uploadUrl) throw new Error("the server did not offer an upload");
      var key = made.upload.anonKey;
      return fetch(made.upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf", "x-upsert": "true", apikey: key, Authorization: "Bearer " + key },
        body: file
      })
        .then(function (r) { if (!r.ok) throw new Error("the upload failed"); return setupApi({ action: "own_paper_saved", id: made.id, token: made.token }); })
        .then(function () { st.ui.pfile = { name: name, meta: meta, id: made.id, token: made.token }; draw(); });
    }).catch(function (e) { st.ui.pfile = null; fail(e); });
  }

  function drawPaper(content) {
    var box = stepBox(content, count(4), "Which paper are you building on?");
    var card = el("div", "ob-card"), stack = el("div", "ob-stack"), p = st.ui.pfile;
    if (!p) {
      var drop = attr(el("label", "ob-drop"), "data-over", st.ui.pover ? "1" : "0");
      drop.appendChild(el("div", "ob-drop-icon", "+"));
      var t = el("div", "ob-drop-text");
      t.appendChild(el("div", "ob-drop-title", "Add the PhD student's paper"));
      t.appendChild(el("div", "ob-drop-sub", "Drop a PDF or click to choose"));
      drop.appendChild(t);
      var input = el("input", "ob-hide"); input.type = "file"; input.accept = "application/pdf";
      on(input, "change", function () { upload(input.files[0]); }); drop.appendChild(input);
      on(drop, "dragover", function (e) { e.preventDefault(); if (!st.ui.pover) { st.ui.pover = true; drop.setAttribute("data-over", "1"); } });
      on(drop, "dragleave", function () { st.ui.pover = false; drop.setAttribute("data-over", "0"); });
      on(drop, "drop", function (e) { e.preventDefault(); st.ui.pover = false; upload(e.dataTransfer.files[0]); });
      stack.appendChild(drop);
    } else {
      var row = el("div", "ob-file"); row.appendChild(fileIcon());
      var txt = el("div", "ob-file-text");
      txt.appendChild(el("div", "ob-file-name", p.name));
      txt.appendChild(el("div", "ob-file-meta", p.uploading ? "Uploading…" : p.meta));
      row.appendChild(txt);
      var replace = el("button", "ob-link", "Replace"); replace.type = "button";
      row.appendChild(on(replace, "click", function () { st.ui.pfile = null; draw(); }));
      stack.appendChild(row);
    }
    [{ key: "plink", label: "Project page" }, { key: "prepo", label: "GitHub" }].forEach(function (r) {
      var wrap = el("div", "ob-urlrow"), open_ = st.ui.popen === r.key, val = st.ui[r.key];
      var btn = attr(el("button", "ob-urlbtn"), "data-open", open_ ? "1" : "0"); btn.type = "button";
      btn.appendChild(el("span", "", r.label)); btn.appendChild(el("span", "h", "optional"));
      btn.appendChild(el("span", "s", val.trim() && !open_ ? hostOf(val) : "")); btn.appendChild(el("span", "c", "›"));
      on(btn, "click", function () { st.ui.popen = open_ ? null : r.key; draw(); });
      wrap.appendChild(btn);
      var body = attr(el("div", "ob-urlbody"), "data-open", open_ ? "1" : "0"), inner = el("div");
      var input = el("input"); input.value = val; input.placeholder = "https://"; input.tabIndex = open_ ? 0 : -1; if (open_) input.setAttribute("autofocus", "");
      on(input, "input", function () { st.ui[r.key] = input.value; });
      on(input, "keydown", function (e) { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); st.ui.popen = null; draw(); } });
      inner.appendChild(input); body.appendChild(inner); wrap.appendChild(body); stack.appendChild(wrap);
    });
    card.appendChild(stack);
    // The slider keeps its own position while it is being dragged; this only
    // has to hear the stop it settled on.
    card.appendChild(slider({ stops: FAMILIARITY, pos: st.ui.pfam, ends: ["Beginner", "Expert"],
      onCommit: function (v) { st.ui.pfam = v; } }));
    var acts = el("div", "ob-actions");
    var ready = !!(p && p.id && !p.uploading) && !st.ui.psending;
    acts.appendChild(cta(st.ui.psending ? "Sending" : "Continue", !ready, function () {
      // Accepting the paper is awaited -- it is quick, and a refusal has to
      // keep the reader here, on the step that can fix it. Reading the paper
      // is not: that is a minute of model, and they walk on through it.
      var sources = { action: "sources", paper_id: p.id, paper_token: p.token,
        project_url: st.ui.plink.trim(), repo_url: st.ui.prepo.trim(), paper_familiarity: snap(st.ui.pfam, 5) };
      st.ui.psending = true; st.error = ""; draw();
      api(sources).then(function (out) {
        st.ui.psending = false;
        if (out && out.onboarding) st.row = out.onboarding;
        else {
          st.row.paper_id = sources.paper_id;
          st.row.project_url = sources.project_url;
          st.row.repo_url = sources.repo_url;
          st.row.paper_familiarity = sources.paper_familiarity;
        }
        st.row.analysis_status = "running";
        st.row.analysis_error = "";
        st.row.assets_status = "running";
        st.row.assets_error = "";
        // Neither awaited: the reader has left this step by the time they
        // answer, so they report into the rail and never through fail().
        // The reading and the hunt run side by side.
        api("analysis", { run: true }).then(readingUpdate).catch(function (e) {
          st.row.analysis_status = "error"; st.row.analysis_error = e.message; draw();
        });
        api("assets", { run: true }).then(huntUpdate).catch(function (e) {
          st.row.assets_status = "error"; st.row.assets_error = e.message; draw();
        });
        return save(5, {}).then(function () { go(5); });
      }).catch(function (e) { st.ui.psending = false; fail(e); });
    }));
    card.appendChild(acts); box.appendChild(card);
  }

  // The little page glyph beside an attached PDF.
  function fileIcon() {
    var icon = el("div", "ob-file-icon");
    icon.appendChild(attr(el("div", "ob-file-line"), "data-lead", "1"));
    icon.appendChild(el("div", "ob-file-line"));
    icon.appendChild(el("div", "ob-file-line"));
    icon.appendChild(attr(el("div", "ob-file-line"), "data-short", "1"));
    return icon;
  }

  function hostOf(u) { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }

  function huntUpdate(read) {
    // A run the server superseded was hunting for a paper this row no longer
    // has: it answers about nothing, so nothing here changes.
    if (!read || read.assets_status === "superseded") return;
    st.row.assets_status = read.assets_status;
    if (read.assets) st.row.assets = read.assets;
    if (read.assets_brief) st.row.assets_brief = read.assets_brief;
    st.row.assets_error = read.assets_error || "";
    draw();
  }

  // 5 Install -- the connect code is issued here, and the module draws the
  // OS pick, the variant pick, and the steps with the keyboard.
  function drawInstall(content) {
    if (!st.ui.made) {
      if (st.busy !== "code") { st.busy = "code"; issueCode().then(function () { st.busy = ""; draw(); }).catch(fail); }
      var box = stepBox(content, count(5), "Install Engelbart on your machine");
      generating(box, "Getting your connect code"); return;
    }
    if (!window.EngelbartInstall) { stepBox(content, count(5), "Install Engelbart on your machine"); return; }
    window.EngelbartInstall.render(content, { variant: "install", code: st.ui.made.code, expiresInSeconds: st.ui.made.expiresInSeconds,
      onDone: function () { save(6, {}).then(function () { st.ui.tour = true; go(6); }).catch(fail); },
      onNewCode: function () { st.ui.made = null; draw(); } });
  }

  function generating(content, text) { var w = el("div", "ob-wait"); w.appendChild(dots()); w.appendChild(el("div", "ob-wait-t", text)); content.appendChild(w); }

  // --- 6 Topics ------------------------------------------------------------------
  //
  // Per area: a familiarity slider and the question at its level. Answering
  // sends it for grading; a grade that disagrees brings one follow-up at the
  // level it found. Two questions per area is the cap.

  var poll = null;
  function readingUpdate(read) {
    if (!read || read.analysis_status === "superseded") return;
    st.row.analysis_status = read.analysis_status;
    if (read.analysis) st.row.analysis = read.analysis;
    st.row.analysis_error = read.analysis_error || "";
    draw();
  }
  function startReading(body) {
    st.row.analysis_status = "running"; st.row.analysis_error = "";
    api("analysis", body).then(readingUpdate).catch(function (e) {
      st.row.analysis_status = "error"; st.row.analysis_error = e.message; draw();
    });
  }
  function pollAnalysis() {
    if (poll) return;
    poll = setInterval(function () {
      if (st.step !== 6 || (st.row && st.row.analysis_status === "done")) { clearInterval(poll); poll = null; return; }
      api("analysis").then(function (out) {
        if (out.analysis_status !== "running") { clearInterval(poll); poll = null; }
        readingUpdate(out);
      }).catch(function () {});
    }, 3000);
  }

  function famOf(i) { var v = st.ui.fam[i]; return typeof v === "number" ? v : 0.2; }
  function levelOf(i) { return LADDER[snap(famOf(i), 5)].level; }
  function answeredArea(i) { return st.cals.some(function (c) { return Number(c.area_index) === i && c.answered_at; }); }
  // A follow-up row: written for this area, its own question, not answered yet.
  function pendingFollow(i) { return st.cals.filter(function (c) { return Number(c.area_index) === i && !c.answered_at && c.question; })[0] || null; }

  // Between Install and Topics, once: the two things the rest of the page can
  // do. A short animation, then Continue or Skip.
  function drawTour(content) {
    var box = el("div", "ob-step ob-tour");
    box.appendChild(el("div", "ob-count", "Before the questions"));
    box.appendChild(el("div", "ob-title", "Two things you can do on every screen"));
    var demo1 = el("div", "ob-tour-demo"); demo1.appendChild(el("div", "ob-cap", "Ask about anything"));
    var line = el("p", "ob-tour-line");
    line.appendChild(el("span", "", "Highlight any words, like "));
    line.appendChild(el("mark", "ob-tour-hl", "a term you have not met"));
    line.appendChild(el("span", "", ", and a link appears in the margin."));
    var ask = el("span", "ob-tour-ask", "Ask about this");
    demo1.appendChild(ask); demo1.appendChild(line);
    demo1.appendChild(el("div", "ob-sub", "The answer comes back at your level, and you can ask for it simpler or deeper."));
    box.appendChild(demo1);
    var demo2 = el("div", "ob-tour-demo"); demo2.appendChild(el("div", "ob-cap", "Change how technical the page is"));
    var reg = el("div", "ob-tour-reg");
    var bars = el("div", "ob-tour-bars");
    for (var i = 0; i < 4; i++) bars.appendChild(attr(el("span", "ob-tour-bar"), "data-i", String(i)));
    reg.appendChild(bars); reg.appendChild(el("span", "ob-tour-thumb"));
    reg.appendChild(el("span", "ob-tour-regen", "Regenerate"));
    demo2.appendChild(reg);
    demo2.appendChild(el("div", "ob-sub", "The slider in the top right rewrites what is on the screen at the level you drag it to."));
    box.appendChild(demo2);
    var acts = attr(el("div", "ob-actions"), "data-between", "1");
    var skip = el("button", "ob-ghost", "Skip"); skip.type = "button";
    acts.appendChild(on(skip, "click", function () { st.ui.tour = false; draw(); }));
    acts.appendChild(cta("Continue", false, function () { st.ui.tour = false; draw(); }));
    box.appendChild(acts);
    content.appendChild(box);
  }

  function drawTopics(content) {
    var r = st.row;
    if (st.ui.tour) { drawTour(content); return; }
    if (r.analysis_status === "none" && r.paper_id) {
      // The tab closed between the paper step's sources and its run.
      startReading({ run: true });
    }
    if (r.analysis_status === "error") {
      var box = stepBox(content, count(6), "The paper could not be read");
      box.appendChild(el("div", "ob-sub", r.analysis_error || "Something went wrong while reading it."));
      var acts = el("div", "ob-actions");
      acts.appendChild(cta("Try again", false, function () { startReading({ retry: true }); draw(); }));
      box.appendChild(acts); return;
    }
    if (r.analysis_status !== "done" || !r.analysis) {
      var w = el("div", "ob-wait"); w.appendChild(dots());
      w.appendChild(el("div", "ob-wait-t", "Still reading your paper"));
      content.appendChild(w); pollAnalysis(); return;
    }
    var a = r.analysis, areas = a.areas, fi = Math.min(st.ui.fIdx || 0, areas.length - 1), area = areas[fi];
    var box2 = el("div", "ob-step");
    box2.appendChild(el("div", "ob-count", count(6, "Topics")));
    box2.appendChild(el("div", "ob-title", "How familiar are you with the paper's concepts?"));
    var paper = el("div", "ob-paper"); paper.appendChild(el("div", "ob-paper-icon"));
    var pt = el("div", "ob-grow"), line = el("div", "ob-paper-line");
    line.appendChild(el("span", "ob-paper-title", a.title)); line.appendChild(el("span", "ob-paper-venue", a.date || ""));
    pt.appendChild(line); pt.appendChild(el("div", "ob-paper-sum", a.one_liner)); paper.appendChild(pt); box2.appendChild(paper);

    var card = el("div", "ob-area");
    var head = el("div", "ob-area-head");
    head.appendChild(el("span", "ob-area-n", (fi + 1) + " / " + areas.length));
    head.appendChild(el("div", "ob-area-name", area.area)); card.appendChild(head);
    if (area.project_role) card.appendChild(el("div", "ob-area-role", area.project_role));
    // The follow-up is a stored row: written from their first answer, waiting
    // unanswered at the level the grade found. It is the same question after a
    // reload or a walk to another area and back, and while it waits the
    // slider is locked -- the self-rating stage of this area is over.
    var follow = pendingFollow(fi);
    var level = follow ? Number(follow.question_level) : levelOf(fi);
    var q = follow ? { question: follow.question } : area.questions.filter(function (x) { return x.level === level; })[0] || area.questions[0];
    var key = fi + ":" + level, answer = st.ui.fAnswers[key] || "";
    // Only the question is shown; the sample answers in the analysis stay unseen.
    card.appendChild(slider({ stops: LADDER, pos: famOf(fi), ends: ["Beginner", "Expert"], locked: !!follow,
      onCommit: function (v) { st.ui.fam[fi] = v; draw(); } }));
    var qbox = el("div");
    qbox.appendChild(el("div", "ob-q-label", follow ? "One more, from what you said" : "Question"));
    qbox.appendChild(el("div", "ob-q", q.question));
    var ab = attr(el("div", "ob-answer"), "data-filled", answer.trim() ? "1" : "0");
    var input = el("textarea"); input.value = answer; input.placeholder = "one sentence is enough…"; input.spellcheck = false; input.rows = 1; input.setAttribute("autofocus", "");
    // The box grows with the answer instead of scrolling one line sideways.
    function grow() { if (typeof input.scrollHeight !== "number") return; input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
    on(input, "input", function () { st.ui.fAnswers[key] = input.value; grow(); ab.setAttribute("data-filled", input.value.trim() ? "1" : "0"); next.disabled = !input.value.trim() || !!st.busy; });
    on(input, "keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
    setTimeout(grow, 0);
    ab.appendChild(input); qbox.appendChild(ab);
    // The grade is kept, never shown: the follow-up is the only sign of it.
    card.appendChild(qbox); box2.appendChild(card);

    var last = fi === areas.length - 1;
    function labelFor(lvl) { var hit = LADDER.filter(function (l) { return l.level === lvl; })[0]; return hit ? hit.label.toLowerCase() : String(lvl); }
    function advance() {
      if (!last) { st.ui.fIdx = fi + 1; draw(); return; }
      // The last answer compiles the assessment; the fitting of the resources
      // to them starts at once and reports into the brainstorm.
      st.busy = "compiling"; draw();
      api("topics_done").then(function (out) {
        st.busy = "";
        st.row.assessment = out.assessment;
        startLeveled();
        go(7);
      }).catch(fail);
    }
    function submit() {
      var said = (st.ui.fAnswers[key] || "").trim(); if (!said || st.busy) return;
      st.busy = "grading"; draw();
      api("answer", { area_index: fi, question_level: level, self_level: follow ? Number(follow.self_level) : levelOf(fi), answer: said }).then(function (out) {
        st.busy = "";
        // The rows the server touched replace what this tab held: the graded
        // answer, and the follow-up it may have written.
        var touched = Array.isArray(out.calibrations) && out.calibrations.length ? out.calibrations
          : [{ area_index: fi, question_level: level, answered_at: new Date().toISOString(), graded_level: out.graded_level }];
        touched.forEach(function (c) {
          st.cals = st.cals.filter(function (x) { return !(Number(x.area_index) === Number(c.area_index) && Number(x.question_level) === Number(c.question_level)); });
          st.cals.push(c);
        });
        if (out.follow_up && !follow) {
          if (!pendingFollow(fi)) st.cals.push({ area_index: fi, question_level: out.follow_up.question_level, question: out.follow_up.question, answered_at: null, self_level: levelOf(fi) });
          draw(); return;
        }
        advance();
      }).catch(fail);
    }
    var nav = el("div", "ob-nav");
    var back = el("button", "ob-arrow", "←"); back.type = "button";
    if (fi === 0) back.setAttribute("disabled", "disabled"); else on(back, "click", function () { st.ui.fIdx = fi - 1; draw(); });
    nav.appendChild(back);
    var pd = el("span", "ob-pdots");
    areas.forEach(function (_, i) {
      var d = attr(attr(el("span", "ob-pdot"), "data-on", i === fi ? "1" : "0"), "data-done", answeredArea(i) ? "1" : "0");
      on(d, "click", function () { st.ui.fIdx = i; draw(); }); pd.appendChild(d);
    });
    nav.appendChild(pd);
    var next = cta(st.busy === "grading" ? "Sending…" : st.busy === "compiling" ? "One moment…" : last && !follow ? "On to brainstorming" : "Next", !answer.trim() || !!st.busy, submit);
    nav.appendChild(next); box2.appendChild(nav); content.appendChild(box2);
  }

  // --- the leveled resources, fitted to them in the background ------------------
  //
  // Started when the topics are answered. Until the hunt has finished it is
  // told to wait; the brainstorm asks again every few seconds, and the
  // "ready to plan?" card appears once it is done.

  var levelTimer = null;
  function leveledUpdate(out) {
    if (!out || out.leveled_status === "superseded") return;
    if (out.assets_status) st.row.assets_status = out.assets_status;
    if (out.assets_error) st.row.assets_error = out.assets_error;
    if (out.leveled_status === "waiting") { st.row.leveled_status = st.row.leveled_status === "done" ? "done" : "none"; return; }
    st.row.leveled_status = out.leveled_status;
    if (out.leveled) st.row.leveled = out.leveled;
    st.row.leveled_error = out.leveled_error || "";
  }
  function startLeveled() {
    if (!st.row.assessment) return;
    if (st.row.leveled_status === "done") return;
    st.row.leveled_status = st.row.assets_status === "done" ? "running" : st.row.leveled_status;
    api("leveled", { run: true }).then(function (out) { leveledUpdate(out); draw(); }).catch(function (e) {
      st.row.leveled_status = "error"; st.row.leveled_error = e.message; draw();
    });
  }
  function pollLeveled() {
    if (levelTimer) return;
    levelTimer = setInterval(function () {
      var r = st.row;
      if (!r || (st.step !== 7 && st.step !== 8) || r.leveled_status === "done") { clearInterval(levelTimer); levelTimer = null; return; }
      if (r.leveled_status === "running") {
        api("leveled").then(function (out) { leveledUpdate(out); if (out.leveled_status !== "running") draw(); }).catch(function () {});
      } else if (r.assets_status === "error" || r.leveled_status === "error") {
        // Nothing to wait for; the card offers a retry.
      } else {
        startLeveled();
      }
    }, 6000);
  }

  // --- 7 Brainstorm ---------------------------------------------------------------
  //
  // A conversation, one card at a time, about what in this paper is worth
  // building on. The transcript is the server's; this draws it and sends
  // each turn as it is made.

  function sayOf(turn) {
    // The stored assistant turn is what it said plus what it asked, one line
    // each; only the prose is shown, the card draws the rest.
    var text = str(turn.content);
    var cut = text.indexOf("\n(");
    return turn.role === "assistant" && cut >= 0 ? text.slice(0, cut) : text;
  }

  function sendTurn(body) {
    var bs = st.ui.bs;
    bs.thinking = true; bs.planAsked = false; st.error = "";
    // Shown at once; the server writes it in the same call. The answers ride
    // on the turn so the answered card can be drawn with them marked.
    var said = [];
    if (body.text) said.push(body.text);
    if (body.pick) said.push("Focus: " + body.pick + (body.note ? " — " + body.note : ""));
    if (body.answers) {
      var last = lastCard();
      if (last && last.questions) last.questions.items.forEach(function (q) {
        var a = body.answers[q.id]; if (a == null || a === "" || (Array.isArray(a) && !a.length)) return;
        said.push(q.title + " " + (Array.isArray(a) ? a.join("; ") : a));
      });
    }
    if (said.length) st.turns.push({ role: "user", content: said.join("\n"), card: userCard(body), local: true });
    st.ui.scrollTo = "thinking"; draw();
    api("brainstorm", body).then(function (out) {
      bs.thinking = false; bs.answers = {}; bs.pick = ""; bs.note = ""; bs.text = "";
      st.turns.push({ id: out.turn_id, role: "assistant", content: out.say, card: { card: out.card, questions: out.questions, focus: out.focus, ready: out.ready === true } });
      if (out.interest) st.row.interest = out.interest;
      if (out.leveled_status) st.row.leveled_status = out.leveled_status === "done" ? "done" : st.row.leveled_status;
      st.ui.scrollTo = "latest"; draw();
    }).catch(function (e) { bs.thinking = false; fail(e); });
  }
  function userCard(body) {
    var c = {};
    if (body.answers) c.answers = body.answers;
    if (body.pick) c.pick = body.pick;
    if (body.note) c.note = body.note;
    if (body.text) c.text = body.text;
    return c;
  }

  // A user turn written before the answers travelled with it: the text is
  // "question title answer" per line, so the answers can be read back off it.
  function legacyGiven(card, content) {
    var lines = str(content).split("\n"), answers = {}, rest = [], hit = false;
    var items = card && card.card === "questions" && card.questions ? card.questions.items : [];
    lines.forEach(function (line) {
      var q = items.filter(function (x) { return line.indexOf(x.title + " ") === 0; })[0];
      if (!q) { if (line.trim()) rest.push(line); return; }
      var a = line.slice(q.title.length + 1).trim(); hit = true;
      if (q.type === "mcq" || q.type === "select_all") {
        var labels = (q.options || []).map(function (o) { return o.label; }), parts = a.split("; ").filter(function (x) { return labels.indexOf(x) >= 0; });
        answers[q.id] = q.type === "select_all" ? parts : (parts[0] || a);
      } else answers[q.id] = a;
    });
    if (card && card.card === "focus" && lines[0] && lines[0].indexOf("Focus: ") === 0) {
      var f = lines[0].slice(7).split(" — "); return { pick: f[0], note: f.slice(1).join(" — ") };
    }
    return hit ? { answers: answers, text: rest.join("\n") || undefined } : { text: str(content) };
  }

  function lastCard() {
    for (var i = st.turns.length - 1; i >= 0; i--) if (st.turns[i].role === "assistant") return st.turns[i].card || { card: "none" };
    return null;
  }

  function drawBrainstorm(content) {
    var r = st.row, bs = st.ui.bs;
    if (r.analysis_status !== "done" || !r.assessment) {
      var w = el("div", "ob-wait"); w.appendChild(dots());
      w.appendChild(el("div", "ob-wait-t", r.analysis_status !== "done" ? "Still reading your paper" : "Answer the topic questions first"));
      content.appendChild(w); if (r.analysis_status !== "done") pollAnalysis(); return;
    }
    if (!st.turns.length && !bs.thinking) { sendTurn({}); return; }
    if (r.leveled_status !== "done") pollLeveled();
    var box = el("div", "ob-step ob-bs-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", count(7, "Brainstorm")));
    head.appendChild(el("span", "ob-count", r.leveled_status === "done" ? "resources ready" : "fitting resources to you")); box.appendChild(head);
    box.appendChild(el("div", "ob-title", "What do you want to build?"));
    var thread = el("div", "ob-bs");
    // Each assistant turn: its prose (if any), then its card. A card that has
    // been answered is drawn again with the answers marked, from the user
    // turn that follows it; only the last, unanswered card is live.
    st.turns.forEach(function (t, i) {
      if (t.role !== "assistant") {
        // What they said is drawn inside the card it answered; only a reply to
        // a prose-only turn is shown as prose of its own.
        var prev = st.turns[i - 1], answeredCard = prev && prev.role === "assistant" && prev.card && prev.card.card && prev.card.card !== "none";
        var free = answeredCard ? "" : (t.card && t.card.text ? t.card.text : str(t.content));
        if (free) {
          var urow = attr(el("div", "ob-bs-turn"), "data-who", "user");
          urow.appendChild(el("span", "ob-bs-who", "you"));
          var ub = el("div", "ob-bs-text"); free.split("\n").forEach(function (line) { if (line.trim()) ub.appendChild(el("p", "", line)); });
          urow.appendChild(ub); thread.appendChild(urow);
        }
        return;
      }
      var say = sayOf(t), latest = i === st.turns.length - 1;
      if (say.trim()) {
        var row = attr(el("div", "ob-bs-turn"), "data-who", "assistant");
        if (latest) attr(row, "data-latest", "1");
        row.appendChild(el("span", "ob-bs-who", "claude"));
        var body = el("div", "ob-bs-text");
        say.split("\n").forEach(function (line) { if (line.trim()) body.appendChild(el("p", "", line)); });
        row.appendChild(body); thread.appendChild(row);
      }
      var next = st.turns[i + 1], live = latest && !bs.thinking;
      if (live) { var before = thread.children.length; drawCard(thread, t.card || { card: "none" }, null); if (!say.trim() && thread.children[before]) attr(thread.children[before], "data-latest", "1"); }
      else if (next && next.role === "user") drawCard(thread, t.card || { card: "none" }, next.card || legacyGiven(t.card, next.content));
    });
    if (bs.thinking) { var th = attr(el("div", "ob-bs-turn"), "data-thinking", "1"); th.appendChild(el("span", "ob-bs-who", "claude")); th.appendChild(dots()); thread.appendChild(th); }
    box.appendChild(thread);
    var last = lastCard();
    // The plan is offered when the model, asked only once the resources were
    // fitted, said they are ready -- not on a timer and not by this page.
    if (!bs.thinking && last && last.ready && r.leveled_status === "done" && !bs.planAsked) drawPlanOffer(box);
    else if (!bs.thinking && last && last.card === "none") {
      var go_ = el("div", "ob-actions"); go_.appendChild(cta("Go on", false, function () { sendTurn({ again: true }); })); box.appendChild(go_);
    }
    if (!bs.thinking && (r.leveled_status === "error" || r.assets_status === "error")) {
      var bad = el("div", "ob-grade"); bad.appendChild(el("span", "tag", "Resources"));
      bad.appendChild(el("span", "", (r.assets_status === "error" ? r.assets_error : r.leveled_error) || "Something went wrong finding the resources."));
      var retry = el("button", "ob-tiny", "try again"); retry.type = "button";
      on(retry, "click", function () {
        if (r.assets_status === "error") { r.assets_status = "running"; api("assets", { retry: true }).then(huntUpdate).catch(function (e) { r.assets_status = "error"; r.assets_error = e.message; draw(); }); }
        else { r.leveled_status = "running"; api("leveled", { retry: true }).then(function (o) { leveledUpdate(o); draw(); }).catch(function (e) { r.leveled_status = "error"; r.leveled_error = e.message; draw(); }); }
        draw();
      });
      bad.appendChild(retry); box.appendChild(bad);
    }
    content.appendChild(box);
  }

  // Engelbart's question shapes: mcq, select_all, free, open; and focus.
  // `given` is null for the live card; for an answered one it is what they
  // answered with, and the card is drawn still, with those marked.
  function drawCard(thread, card, given) {
    var bs = st.ui.bs, done = given !== null;
    var answers = done ? (given.answers || {}) : bs.answers;
    if (card.card === "questions" && card.questions) {
      var qcard = attr(el("div", "ob-bs-card"), "data-done", done ? "1" : "0");
      qcard.appendChild(el("div", "ob-cap", card.questions.eyebrow || "a few questions"));
      var sendBtn;
      function ready() { return card.questions.items.some(function (q) { var a = bs.answers[q.id]; return Array.isArray(a) ? a.length : str(a).trim(); }); }
      card.questions.items.forEach(function (q) {
        var qb = el("div", "ob-bs-q");
        qb.appendChild(el("div", "ob-question", q.title));
        if (q.subtitle) qb.appendChild(el("div", "ob-sub", q.subtitle));
        else if (q.type === "select_all") qb.appendChild(el("div", "ob-sub", "select all that apply"));
        if (q.type === "mcq" || q.type === "select_all") {
          var opts = el("div", "ob-opts"), many = q.type === "select_all";
          (q.options || []).forEach(function (o) {
            var cur = answers[q.id], on_ = many ? (Array.isArray(cur) && cur.indexOf(o.label) >= 0) : cur === o.label;
            var rowEl = attr(el("div", "ob-goal"), "data-on", on_ ? "1" : "0");
            var mark = el("span", "ob-mark"); if (many) attr(mark, "data-square", "1"); rowEl.appendChild(mark);
            var t = el("span", "ob-grow"); t.appendChild(el("span", "ob-goal-label", o.label)); if (o.why) t.appendChild(el("span", "ob-goal-why", o.why)); rowEl.appendChild(t);
            if (!done) on(rowEl, "click", function () {
              if (many) { var list = Array.isArray(cur) ? cur.slice() : []; bs.answers[q.id] = on_ ? list.filter(function (x) { return x !== o.label; }) : list.concat([o.label]); }
              else bs.answers[q.id] = on_ ? "" : o.label;
              draw();
            });
            opts.appendChild(rowEl);
          });
          qb.appendChild(opts);
        } else if (done) {
          var said = str(answers[q.id]);
          if (said.trim()) qb.appendChild(el("div", "ob-bs-said", said));
        } else {
          qb.appendChild(field(str(bs.answers[q.id]), q.placeholder || "", function (v) { bs.answers[q.id] = v; sendBtn.disabled = !ready(); }, null, q.type === "open"));
        }
        qcard.appendChild(qb);
      });
      if (done) {
        var skipped = !given.answers && (!given.text || given.text === "(skipped those)");
        if (skipped) qcard.appendChild(el("div", "ob-cap ob-bs-skipped", "skipped"));
        else if (given.text && !given.answers) qcard.appendChild(el("div", "ob-bs-said", given.text));
      } else {
        var acts = attr(el("div", "ob-actions"), "data-between", "1");
        // Skipping once the resources are ready means "enough brainstorming":
        // it goes on to choosing what to build on. Before that, it asks again.
        var fitted = st.row.leveled_status === "done";
        var skip = el("button", "ob-ghost", fitted ? "Skip to resources" : "Skip"); skip.type = "button";
        acts.appendChild(on(skip, "click", function () {
          if (fitted) { save(8, {}).then(function () { go(8); }).catch(fail); return; }
          sendTurn({ text: "(skipped those)" });
        }));
        sendBtn = cta("Send answers", !ready(), function () { sendTurn({ answers: bs.answers }); });
        acts.appendChild(sendBtn); qcard.appendChild(acts);
      }
      thread.appendChild(qcard);
    } else if (card.card === "focus" && card.focus) {
      var fcard = attr(el("div", "ob-bs-card"), "data-done", done ? "1" : "0");
      fcard.appendChild(el("div", "ob-cap", "focus"));
      fcard.appendChild(el("div", "ob-question", card.focus.title || "What should we focus on?"));
      var list = el("div", "ob-opts"), pick = done ? str(given.pick) : bs.pick;
      card.focus.options.forEach(function (o) {
        var on_ = pick === o.label;
        var rowEl = attr(el("div", "ob-goal"), "data-on", on_ ? "1" : "0"); rowEl.appendChild(el("span", "ob-mark"));
        var t = el("span", "ob-grow"); t.appendChild(el("span", "ob-goal-label", o.label)); if (o.why) t.appendChild(el("span", "ob-goal-why", o.why)); rowEl.appendChild(t);
        if (!done) on(rowEl, "click", function () { bs.pick = on_ ? "" : o.label; draw(); });
        list.appendChild(rowEl);
      });
      fcard.appendChild(list);
      if (done) {
        var added = given.note || (!given.pick && given.text ? given.text : "");
        if (added) { fcard.appendChild(el("div", "ob-cap", "you added")); fcard.appendChild(el("div", "ob-bs-said", added)); }
      } else {
        fcard.appendChild(el("div", "ob-cap", "anything else it should know"));
        fcard.appendChild(field(bs.note, "constraints, what to leave alone, where to start…", function (v) { bs.note = v; }, null, true));
        var facts = el("div", "ob-actions");
        facts.appendChild(cta("Continue", !bs.pick, function () { sendTurn({ pick: bs.pick, note: bs.note.trim() }); }));
        fcard.appendChild(facts);
      }
      thread.appendChild(fcard);
    }
  }

  // Offered when the model has said they are ready.
  function drawPlanOffer(box) {
    var card = el("div", "ob-bs-card ob-bs-offer");
    card.appendChild(el("div", "ob-cap", "ready when you are"));
    card.appendChild(el("div", "ob-question", "Ready to start planning your project?"));
    var acts = attr(el("div", "ob-actions"), "data-between", "1");
    var later = el("button", "ob-ghost", "Keep brainstorming"); later.type = "button";
    acts.appendChild(on(later, "click", function () { st.ui.bs.planAsked = true; draw(); }));
    acts.appendChild(cta("Yes, let's plan", false, function () { save(8, {}).then(function () { go(8); }).catch(fail); }));
    card.appendChild(acts); box.appendChild(card);
  }

  // --- 8 Assets ------------------------------------------------------------------
  //
  // What the paper rests on, fitted to them: one list, expand for the
  // description, the links, and a place to ask; children sit under their
  // parent, marked "at your level". They pick one to build on.

  function keyOf(asset, parent) { return parent ? parent.title + " :: " + asset.title : asset.title; }

  function drawAssets(content) {
    var r = st.row, as = st.ui.as;
    if (r.leveled_status !== "done" || !r.leveled) {
      if (!r.assessment) { stepBox(content, count(8), "Answer the topic questions first"); return; }
      var w = el("div", "ob-wait"); w.appendChild(dots());
      w.appendChild(el("div", "ob-wait-t", r.assets_status === "done" ? "Fitting the resources to you" : "Finding what the paper rests on"));
      if (r.assets_status === "error" || r.leveled_status === "error") {
        w.appendChild(el("div", "ob-err", (r.assets_status === "error" ? r.assets_error : r.leveled_error) || "Something went wrong."));
        var acts0 = el("div", "ob-actions");
        acts0.appendChild(cta("Try again", false, function () {
          if (r.assets_status === "error") { r.assets_status = "running"; api("assets", { retry: true }).then(huntUpdate).then(startLeveled).catch(function (e) { r.assets_status = "error"; r.assets_error = e.message; draw(); }); }
          else { r.leveled_status = "running"; api("leveled", { retry: true }).then(function (o) { leveledUpdate(o); draw(); }).catch(function (e) { r.leveled_status = "error"; r.leveled_error = e.message; draw(); }); }
          draw();
        }));
        w.appendChild(acts0);
      } else { if (r.leveled_status !== "running") startLeveled(); pollLeveled(); }
      content.appendChild(w); return;
    }
    var lv = r.leveled, list = lv.assets || [];
    if (!as.picked && r.asset_chosen) as.picked = r.asset_chosen.key;
    var box = el("div", "ob-step ob-as-step");
    var head = el("div", "ob-as-header");
    head.appendChild(el("div", "ob-count", count(8, "Assets")));
    head.appendChild(el("h1", "ob-as-h1", "What do you want to build on?"));
    head.appendChild(el("div", "ob-as-sub", "Pick one. Rows with a › have simpler starting points inside."));
    box.appendChild(head);
    var group = el("div", "ob-as-list");
    list.forEach(function (a, i) {
      var kids = a.children || [], childPicked = kids.some(function (k) { return keyOf(k, a) === as.picked; });
      var open_ = !!as.open[a.title] || childPicked;
      group.appendChild(assetRow(a, null, { first: i === 0, open: open_, childPicked: childPicked }));
      if (open_) kids.forEach(function (k) { group.appendChild(assetRow(k, a, {})); });
    });
    box.appendChild(group);
    var picked = as.picked ? findLocal(list, as.picked) : null;
    var acts = el("div", "ob-actions");
    acts.appendChild(cta("Continue", !picked || st.busy === "choose", function () {
      st.busy = "choose"; draw();
      api("choose_asset", { key: as.picked }).then(function (out) {
        st.busy = ""; st.row.asset_chosen = out.asset_chosen; st.row.direction = null; st.row.subgoals = null; st.row.todos = null;
        st.ui.change = { open: false, text: "", thinking: false, log: [] }; go(9);
      }).catch(fail);
    }));
    box.appendChild(acts);
    content.appendChild(box);
  }

  function findLocal(list, key) {
    for (var i = 0; i < list.length; i++) {
      if (keyOf(list[i]) === key) return list[i];
      var kids = list[i].children || [];
      for (var j = 0; j < kids.length; j++) if (keyOf(kids[j], list[i]) === key) return kids[j];
    }
    return null;
  }

  // One row. A parent folds its simpler stand-ins behind an "N simpler"
  // toggle; picking a row opens it and shows what it is and where it lives.
  function assetRow(a, parent, o) {
    var as = st.ui.as, key = keyOf(a, parent), picked = as.picked === key, shown = picked || !!o.childPicked;
    var kids = a.children || [];
    var row = attr(attr(el("div", "ob-as-row"), "data-child", parent ? "1" : "0"), "data-first", o.first ? "1" : "0");
    attr(row, "data-on", picked ? "1" : "0");
    if (parent) row.appendChild(el("span", "ob-as-elbow"));
    row.appendChild(attr(el("span", "ob-mark"), "data-on", picked ? "1" : "0"));
    var text = el("span", "ob-as-text");
    var line = el("span", "ob-as-line");
    line.appendChild(el("span", "ob-as-title", a.title));
    line.appendChild(el("span", "ob-as-meta", a.type || ""));
    if (parent) line.appendChild(el("span", "ob-as-level", "simpler"));
    text.appendChild(line);
    if (shown) {
      var said = a.description || a.one_liner || "";
      if (said) text.appendChild(el("span", "ob-as-desc", said));
      if (parent && a.why) text.appendChild(el("span", "ob-as-why", a.why));
      var links = (a.links || []).filter(function (l) { return l && l.url; });
      if (links.length) {
        var lrow = el("span", "ob-as-links");
        links.forEach(function (l) {
          var link = el("a", "ob-as-link", String(l.kind || "link").replace(/_/g, " ") + " ↗"); link.href = l.url; link.target = "_blank"; link.rel = "noopener";
          on(link, "click", function (e) { if (e && e.stopPropagation) e.stopPropagation(); });
          lrow.appendChild(link);
        });
        text.appendChild(lrow);
      }
    }
    row.appendChild(text);
    if (!parent && kids.length) {
      var toggle = el("button", "ob-as-toggle"); toggle.type = "button"; toggle.setAttribute("aria-label", "show simpler options");
      toggle.appendChild(el("span", "", kids.length + " simpler"));
      toggle.appendChild(el("span", "ob-as-caret", o.open ? "⌃" : "›"));
      on(toggle, "click", function (e) { if (e && e.stopPropagation) e.stopPropagation(); as.open = o.open ? {} : {}; if (!o.open) as.open[a.title] = true; draw(); });
      row.appendChild(toggle);
    }
    on(row, "click", function () { as.picked = key; as.open = {}; as.open[parent ? parent.title : a.title] = true; draw(); });
    return row;
  }

  // --- 9 Direction, 10 Subgoals ---------------------------------------------------
  //
  // One proposal, not a choice of three. "Looks good" moves on; "Change
  // something" unfolds a box, and what is typed there revises the proposal.

  function changeBox(box, action, onRevised) {
    var ch = st.ui.change;
    var acts = attr(el("div", "ob-actions"), "data-between", "1");
    var change = el("button", "ob-ghost", ch.open ? "Never mind" : "Change something"); change.type = "button";
    acts.appendChild(on(change, "click", function () { ch.open = !ch.open; draw(); }));
    acts.appendChild(cta("Looks good", ch.thinking, function () { onRevised(); }));
    box.appendChild(acts);
    if (!ch.open) return;
    var panel = el("div", "ob-ask");
    ch.log.forEach(function (c) {
      var t = attr(el("div", "ob-bs-turn"), "data-who", c.role); t.appendChild(el("span", "ob-bs-who", c.role === "user" ? "you" : "claude"));
      t.appendChild(el("div", "ob-bs-text", c.content)); panel.appendChild(t);
    });
    if (ch.thinking) { var th = el("div", "ob-bs-turn"); th.appendChild(el("span", "ob-bs-who", "claude")); th.appendChild(dots()); panel.appendChild(th); }
    panel.appendChild(el("div", "ob-ask-cap", "What should be different?"));
    var row = el("div", "ob-ask-row"), input = el("input");
    input.value = ch.text; input.placeholder = "smaller, closer to the paper, use the other dataset, drop the…"; input.setAttribute("autofocus", "");
    var send = el("button", "ob-pill", "Send"); send.type = "button";
    if (!ch.text.trim() || ch.thinking) send.setAttribute("disabled", "disabled");
    function go_() {
      var text = ch.text.trim(); if (!text || ch.thinking) return;
      ch.log.push({ role: "user", content: text }); ch.text = ""; ch.thinking = true; draw();
      api(action, { revise: text }).then(function (out) {
        ch.thinking = false;
        if (out.direction) { st.row.direction = out.direction; st.row.subgoals = null; st.row.todos = null; ch.log.push({ role: "assistant", content: "Revised: " + out.direction.title }); }
        if (out.subgoals) { st.row.subgoals = out.subgoals; st.row.todos = null; ch.log.push({ role: "assistant", content: "Revised the three pieces." }); }
        draw();
      }).catch(function (e) { ch.thinking = false; ch.log.push({ role: "assistant", content: e.message }); draw(); });
    }
    on(input, "input", function () { ch.text = input.value; send.disabled = !input.value.trim() || ch.thinking; });
    on(input, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go_(); } if (e.key === "Escape") { ch.open = false; draw(); } });
    on(send, "click", go_);
    row.appendChild(input); row.appendChild(send); panel.appendChild(row);
    box.appendChild(panel);
  }

  function drawDirection(content) {
    var r = st.row;
    if (!r.asset_chosen) { stepBox(content, count(9), "Pick what to build on first"); return; }
    if (!r.direction) {
      if (st.busy !== "direction") { st.busy = "direction"; api("direction").then(function (out) { st.busy = ""; st.row.direction = out.direction; draw(); }).catch(fail); }
      generating(content, "Choosing a direction"); return;
    }
    var d = r.direction, box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", count(9, "Direction"))); head.appendChild(el("span", "ob-count", "one direction")); box.appendChild(head);
    box.appendChild(el("div", "ob-question", d.title));
    box.appendChild(el("div", "ob-dir-body", d.what_you_would_make));
    if (d.first_visible_result) { var fv = el("div", "ob-dir-line"); fv.appendChild(el("span", "ob-as-lead", "First thing you'd see · ")); fv.appendChild(el("span", "", d.first_visible_result)); box.appendChild(fv); }
    if (d.why_it_fits) { var wf = el("div", "ob-dir-line"); wf.appendChild(el("span", "ob-as-lead", "Why this one · ")); wf.appendChild(el("span", "", d.why_it_fits)); box.appendChild(wf); }
    changeBox(box, "direction", function () { st.ui.change = { open: false, text: "", thinking: false, log: [] }; save(10, {}).then(function () { go(10); }).catch(fail); });
    content.appendChild(box);
  }

  function drawSubgoals(content) {
    var r = st.row;
    if (!r.direction) { stepBox(content, count(10), "Settle the direction first"); return; }
    if (!r.subgoals) {
      if (st.busy !== "subgoals") { st.busy = "subgoals"; api("subgoals").then(function (out) { st.busy = ""; st.row.subgoals = out.subgoals; draw(); }).catch(fail); }
      generating(content, "Breaking it into three pieces"); return;
    }
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", count(10, "Subgoals"))); head.appendChild(el("span", "ob-count", "three pieces")); box.appendChild(head);
    box.appendChild(el("div", "ob-cap", "Direction")); box.appendChild(el("div", "ob-goal-title", r.direction.title));
    var list = el("div", "ob-sg-list");
    r.subgoals.forEach(function (g, i) {
      var row = el("div", "ob-sg");
      row.appendChild(attr(el("span", "ob-circle"), "data-state", i === 0 ? "now" : "todo")).textContent = String(i + 1);
      var t = el("div", "ob-grow");
      t.appendChild(el("div", "ob-sg-label", g.label));
      if (g.description) t.appendChild(el("div", "ob-sg-desc", g.description));
      if (g.why) { var w = el("div", "ob-sg-why"); w.appendChild(el("span", "ob-as-lead", "Why here · ")); w.appendChild(el("span", "", g.why)); t.appendChild(w); }
      if (i === 0) t.appendChild(el("div", "ob-sg-first", "todos are written for this one"));
      row.appendChild(t); list.appendChild(row);
    });
    box.appendChild(list);
    changeBox(box, "subgoals", function () { st.ui.change = { open: false, text: "", thinking: false, log: [] }; save(11, {}).then(function () { go(11); }).catch(fail); });
    content.appendChild(box);
  }

  // --- 11 Todos -----------------------------------------------------------------

  function issueCode() {
    return post(DEVICE_API, { action: "issue" }).then(function (v) {
      st.ui.made = { code: v.code, expiresInSeconds: v.expiresInSeconds }; return v;
    });
  }

  function drawTodos(content) {
    var r = st.row;
    if (!r.direction || !r.subgoals) { stepBox(content, count(11), "Settle the pieces first"); return; }
    if (st.busy === "create") { generating(content, "Making " + (st.ui.projName || "your project")); return; }
    if (!r.todos || !r.todos.length) {
      if (st.busy !== "todos") {
        st.busy = "todos";
        api("todos").then(function (out) { st.busy = ""; st.row.todos = out.todos; st.ui.todos = out.todos.slice(); st.ui.projName = st.ui.projName || out.name || ""; draw(); }).catch(fail);
      }
      generating(content, "Writing todos for “" + r.subgoals[0].label + "”"); return;
    }
    if (!st.ui.todos.length) st.ui.todos = r.todos.slice();
    var todos = st.ui.todos, n = todos.length, canAdd = n < 4;
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", count(11, "Todos"))); head.appendChild(el("span", "ob-count", n + " of 4")); box.appendChild(head);
    box.appendChild(el("div", "ob-title", r.subgoals[0].label));
    var rows = el("div", "ob-rows");
    todos.forEach(function (t, i) {
      var row = el("div", "ob-trow"); row.appendChild(el("span", "dash", "–"));
      // A textarea that grows: a todo is a sentence, and a sentence should
      // not be read through a one-line slot.
      var input = el("textarea"); input.value = t; input.spellcheck = false; input.rows = 1;
      function grow() { if (typeof input.scrollHeight !== "number") return; input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
      on(input, "input", function () { todos[i] = input.value; grow(); create.disabled = off(); });
      on(input, "keydown", function (e) { if (e.key === "Enter") e.preventDefault(); });
      setTimeout(grow, 0); row.appendChild(input);
      // Deleting takes two presses: the × asks, and only "Delete" removes.
      if (st.ui.todoConfirm === i) {
        var sure = el("button", "ob-tiny ob-tdel", "Delete"); sure.type = "button";
        row.appendChild(on(sure, "click", function () { todos.splice(i, 1); st.ui.todoConfirm = -1; draw(); }));
        var keep = el("button", "ob-tiny", "Keep"); keep.type = "button";
        row.appendChild(on(keep, "click", function () { st.ui.todoConfirm = -1; draw(); }));
      } else {
        var x = el("button", "x", "×"); x.type = "button"; x.setAttribute("aria-label", "delete this todo");
        row.appendChild(on(x, "click", function () { st.ui.todoConfirm = i; draw(); }));
      }
      rows.appendChild(row);
    });
    if (canAdd) {
      var add = el("div", "ob-trow"); add.appendChild(el("span", "dash", "–"));
      var ni = el("input"); ni.value = st.ui.newTodo || ""; ni.placeholder = "add a todo…"; ni.spellcheck = false;
      on(ni, "input", function () { st.ui.newTodo = ni.value; });
      on(ni, "keydown", function (e) { if (e.key === "Enter" && ni.value.trim()) { e.preventDefault(); todos.push(ni.value.trim()); st.ui.newTodo = ""; draw(); } });
      add.appendChild(ni); rows.appendChild(add);
    }
    box.appendChild(rows);
    if (n < 2 || n >= 4) box.appendChild(el("div", "ob-hint", n < 2 ? "At least two todos." : "Four is the cap — keep the first piece small."));
    function clean() { return todos.map(function (t) { return str(t).trim(); }).filter(Boolean); }
    function off() { var c = clean(); return c.length < 2 || c.length > 4 || !str(st.ui.projName).trim(); }
    var name = el("div", "ob-namerow");
    var input = el("input"); input.value = st.ui.projName || ""; input.placeholder = "project name…"; input.spellcheck = false;
    on(input, "input", function () { st.ui.projName = input.value; create.disabled = off(); }); name.appendChild(input);
    var create = el("button", "ob-pill"); create.type = "button";
    create.appendChild(el("span", "", "Create project ")); create.appendChild(el("span", "", "›"));
    if (off()) create.setAttribute("disabled", "disabled");
    on(create, "click", function () {
      if (off()) return;
      var rowsClean = clean(), pname = st.ui.projName.trim();
      st.busy = "create"; draw();
      api("create", { project_name: pname, todos: rowsClean })
        .then(function () { st.busy = ""; st.row.status = "created"; st.row.project_name = pname; st.row.todos = rowsClean; st.row.goal_chosen = r.direction.title; go(DONE); })
        .catch(fail);
    });
    name.appendChild(create); box.appendChild(name); content.appendChild(box);
  }

  // --- 12 Done: open a new chat and run /bart -----------------------------------------

  function drawDone(content) {
    var r = st.row;
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Done")); head.appendChild(el("span", "ob-count", (r.project_name || "your project") + " is saved")); box.appendChild(head);
    content.appendChild(box);
    var host = el("div", "ob-ins-host"); content.appendChild(host);
    if (window.EngelbartInstall) window.EngelbartInstall.render(host, { variant: "bart", onDone: function () { draw(); } });
    var acts = el("div", "ob-done-acts");
    var back = el("button", "ob-ghost", "Didn't install Engelbart? Back to install"); back.type = "button";
    acts.appendChild(on(back, "click", function () { go(5); }));
    var another = el("button", "ob-ghost", "Set up another"); another.type = "button";
    acts.appendChild(on(another, "click", function () {
      api("open", { fresh: true }).then(function (o) { forgetUi(); adopt(o); draw(); }).catch(fail);
    }));
    content.appendChild(acts);
  }

  // --- Ask about this ----------------------------------------------------------
  //
  // From Topics on, selecting text in the content column offers a question
  // about it; the answer comes back at the reader's register and can be
  // re-asked one stop simpler or deeper.

  // ⏎ anywhere that is not a text box presses the step's own button: the
  // last enabled primary in the content column, which is the one the
  // reader would click. Inputs keep their own ⏎ handling (above), buttons
  // keep the browser's, and a modifier means the key was meant for a chord.
  if (document.addEventListener) document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    var t = e.target, tag = t && t.tagName ? String(t.tagName).toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button" || tag === "a" || (t && t.isContentEditable)) return;
    var c = document.getElementById("content"); if (!c || !c.querySelectorAll) return;
    var all = c.querySelectorAll(".ob-cta"), b = null;
    for (var i = all.length - 1; i >= 0; i--) { if (!all[i].disabled) { b = all[i]; break; } }
    if (!b) return;
    e.preventDefault(); b.click();
  });

  var QUICK = ["What does this mean?", "Why does this matter?", "Give me an example", "Is this too much for a first project?"];
  function askable() { return st.screen === "flow" && st.step <= 11; }
  if (document.addEventListener) document.addEventListener("mouseup", function (e) {
    if (e.target && e.target.closest && e.target.closest("[data-askbtn]")) return;
    setTimeout(function () {
      var sel = window.getSelection ? window.getSelection() : null, t = sel ? sel.toString().trim() : "", c = document.getElementById("content");
      if (!t || t.length < 3 || !c || !sel.rangeCount || !c.contains(sel.anchorNode) || !askable()) { if (st.ui.askBtn && !st.ui.askBtn.gutter) { st.ui.askBtn = null; draw(); } return; }
      var r = sel.getRangeAt(0).getBoundingClientRect(), cr = c.getBoundingClientRect();
      st.ui.askBtn = { text: t.slice(0, 240), gutter: true, y: r.top - cr.top + r.height / 2 }; draw();
    }, 0);
  });

  // Anything clicked can be asked about: the nearest block of text under the
  // click gets an "Ask about this" button in the left margin, aligned to it.
  // Captured before the click reaches the element, because the element's own
  // handler redraws the page and the node would be gone by the bubble.
  var ASK_BLOCKS = ["ob-goal", "ob-opt", "ob-question", "ob-q", "ob-bs-text", "ob-title", "ob-sub", "ob-as-row", "ob-goal-title", "ob-dir-body", "ob-sg-row", "ob-todo", "ob-area-role", "ob-paper-sum", "ob-bs-said", "ob-ask-item"];
  function classes(node) { return String((node && node.className) || "").split(/\s+/); }
  function askBlock(node) {
    var c = document.getElementById("content");
    for (var n = node; n && n !== c; n = n.parentNode) {
      var tag = String(n.tagName || "").toLowerCase();
      if (tag === "button" || tag === "input" || tag === "textarea" || tag === "a") return null;
      var cs = classes(n); if (cs.indexOf("ob-askbtn") >= 0 || cs.indexOf("ob-ask") >= 0) return null;
      if (ASK_BLOCKS.some(function (k) { return cs.indexOf(k) >= 0; })) return n;
    }
    return null;
  }
  // The words of a block, one space between its parts, without the glyphs
  // that are furniture (a caret, a check) rather than something to ask about.
  function blockText(node) {
    var parts = [];
    (function walk(n) {
      if (!n) return;
      var tag = String(n.tagName || "").toLowerCase();
      if (tag === "button" || tag === "input" || tag === "textarea") return;
      var kids = n.childNodes && n.childNodes.length ? n.childNodes : n.children;
      if (!kids || !kids.length) { var t = str(n.textContent).trim(); if (t) parts.push(t); return; }
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(node);
    return parts.join(" ").replace(/[›‹✓·]/g, " ").replace(/\s+/g, " ").trim();
  }
  if (document.addEventListener) document.addEventListener("click", function (e) {
    var c = document.getElementById("content"), t = e.target;
    if (!c || !askable() || st.ui.askOpen) return;
    var inside = false; for (var n = t; n; n = n.parentNode) if (n === c) { inside = true; break; }
    var block = inside ? askBlock(t) : null;
    if (!block) {
      if (st.ui.askBtn && st.ui.askBtn.gutter && !(t && classes(t).indexOf("ob-askbtn") >= 0)) { st.ui.askBtn = null; var w0 = draws; setTimeout(function () { if (draws === w0) draw(); }, 0); }
      return;
    }
    var text = blockText(block); if (text.length < 3) return;
    var r = block.getBoundingClientRect(), cr = c.getBoundingClientRect();
    st.ui.askBtn = { text: text.slice(0, 240), gutter: true, y: r.top - cr.top + r.height / 2 };
    // The element's own handler usually redraws; when nothing does, draw here.
    var was = draws; setTimeout(function () { if (draws === was) draw(); }, 0);
  }, true);

  function askPanel(body) {
    var content = body.children[0];
    if (st.ui.askBtn && !st.ui.askOpen && content) {
      var b = attr(el("button", "ob-askbtn", "Ask about this"), "data-askbtn", "1"); b.type = "button";
      attr(b, "data-gutter", "1"); b.style.top = st.ui.askBtn.y + "px";
      on(b, "click", function () {
        // The highlight stays: it is what the question is about, and the
        // redraw puts it back (see draw).
        st.ui.askQuote = st.ui.askBtn.text; st.ui.askOpen = true; st.ui.askBtn = null; st.ui.askText = ""; draw();
      });
      content.appendChild(b);
    }
    if (st.ui.askOpen) {
      var panel = el("div", "ob-ask"); panel.appendChild(el("div", "ob-ask-cap", "Asking about"));
      panel.appendChild(el("div", "ob-ask-quote", "“" + st.ui.askQuote + "”"));
      var quick = el("div", "ob-seeds");
      QUICK.forEach(function (q) { var bt = el("button", "ob-seed", q); bt.type = "button"; quick.appendChild(on(bt, "click", function () { sendAsk(q); })); });
      panel.appendChild(quick);
      var row = el("div", "ob-ask-row"), input = el("input");
      input.value = st.ui.askText || ""; input.placeholder = "or ask your own question…"; input.setAttribute("autofocus", "");
      var send = el("button", "ob-pill", "Ask"); send.type = "button";
      if (!(st.ui.askText || "").trim()) send.setAttribute("disabled", "disabled");
      on(input, "input", function () { st.ui.askText = input.value; send.disabled = !input.value.trim(); });
      on(input, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendAsk(); } if (e.key === "Escape") { st.ui.askOpen = false; draw(); } });
      on(send, "click", function () { sendAsk(); });
      row.appendChild(input); row.appendChild(send); panel.appendChild(row);
      var cancelRow = el("div", "ob-ask-cancel"), cancel = el("button", "ob-tiny", "cancel"); cancel.type = "button";
      cancelRow.appendChild(on(cancel, "click", function () { st.ui.askOpen = false; draw(); })); panel.appendChild(cancelRow);
      body.appendChild(panel);
    }
    var asks = st.ui.asks || [];
    if (asks.length) {
      var list = el("div", "ob-asked"); list.appendChild(el("div", "ob-asked-cap", "Asked"));
      asks.forEach(function (k) {
        var item = el("div", "ob-ask-item"); item.appendChild(el("div", "quote", "“" + k.quote + "”")); item.appendChild(el("div", "q", k.question));
        if (k.thinking) { var th = el("div", "ob-ask-think"); th.appendChild(dots()); item.appendChild(th); }
        else {
          item.appendChild(el("div", "a", k.answer));
          var tools = el("div", "ob-ask-tools"), keys = DEPTHS.map(function (x) { return x.key; }), di = Math.max(0, keys.indexOf(k.level));
          tools.appendChild(el("span", "ob-tiny", DEPTHS[di].label));
          var simpler = el("button", "ob-tiny", "simpler"); simpler.type = "button";
          if (di === 0) simpler.setAttribute("disabled", "disabled"); else on(simpler, "click", function () { reask(k, DEPTHS[di - 1].key); });
          var deeper = el("button", "ob-tiny", "more detail"); deeper.type = "button";
          if (di === DEPTHS.length - 1) deeper.setAttribute("disabled", "disabled"); else on(deeper, "click", function () { reask(k, DEPTHS[di + 1].key); });
          tools.appendChild(simpler); tools.appendChild(deeper);
          var rm = el("button", "ob-tiny ob-ask-rm", "×"); rm.type = "button";
          on(rm, "click", function () { st.ui.asks = st.ui.asks.filter(function (x) { return x !== k; }); draw(); }); tools.appendChild(rm);
          item.appendChild(tools);
        }
        list.appendChild(item);
      });
      body.appendChild(list);
    }
  }

  function sendAsk(text) {
    var question = str(text || st.ui.askText).trim(); if (!question) return;
    var k = { quote: st.ui.askQuote, question: question, thinking: true, level: st.row.depth || "everyday" };
    st.ui.asks = [k].concat(st.ui.asks || []); st.ui.askOpen = false; st.ui.askText = ""; draw();
    api("ask", { step: st.step, quote: k.quote, question: question }).then(function (out) { k.thinking = false; k.answer = out.answer; k.level = out.level || k.level; draw(); })
      .catch(function (e) { k.thinking = false; k.answer = e.message; draw(); });
  }

  function reask(k, level) {
    k.thinking = true; draw();
    api("ask", { step: st.step, quote: k.quote, question: k.question, level: level }).then(function (out) { k.thinking = false; k.answer = out.answer; k.level = out.level || level; draw(); })
      .catch(function (e) { k.thinking = false; k.answer = e.message; draw(); });
  }

  // --- boot --------------------------------------------------------------------

  function boot() {
    st.test = /[?&]test=(true|1)(&|$)/.test(String((window.location && window.location.search) || ""));
    draw();
    fetch("/api/engelbart-config", { headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("Engelbart is not configured on this deployment"); return r.json(); })
      .then(function (config) {
        client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey,
          { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
        client.auth.onAuthStateChange(function (_e, next) { if (!next && session) { session = null; st.screen = "signin"; draw(); } });
        return client.auth.getSession();
      })
      .then(function (out) {
        session = out.data && out.data.session;
        if (!session) { st.screen = "signin"; draw(); return; }
        return api("open").then(function (opened) { adopt(opened); st.screen = "flow"; draw(); });
      })
      .catch(function (e) { st.screen = "error"; st.error = e.message; draw(); });
  }

  boot();
})();
