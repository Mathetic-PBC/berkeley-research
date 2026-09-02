/* Setting up a first project, after an account exists.
 *
 * Ten steps, one row on the server: every Continue writes what was typed,
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

  var LABELS = ["Name", "Year", "Major", "Explanations", "Paper", "Project", "Topics", "Details", "Focus", "Todos"];
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
    credit: null,
    step: 0,            // the step on screen (row.step is the furthest reached)
    ui: {
      yearOther: false, yearText: "",
      depthPos: 0.25, depthTouched: false,
      pfile: null,      // { name, meta, id, token } once uploaded; { name, meta, uploading } meanwhile
      pover: false, popen: null, plink: "", prepo: "", pfam: 0.2, psending: false,
      draft: "",
      // Task 8 adds: fIdx, fam{}, fAnswer, followUp, qIdx, answers{}, goalPick, goalOther, todos[], newTodo, projName,
      // askBtn, askOpen, askQuote, askText, asks[], made
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
      st.row = out.onboarding;
      return out;
    });
  }

  function go(n) {
    st.step = n;
    st.error = "";
    if (st.ui.askOpen) st.ui.askOpen = false;
    st.ui.askBtn = null;
    draw();
  }

  function adopt(out) {
    st.row = out.onboarding;
    st.cals = out.calibrations || [];
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
    st.step = r.status === "created" ? 10 : Math.min(9, r.step || 0);
  }

  // --- the rail ----------------------------------------------------------------

  function depthIndex() { return snap(st.ui.depthPos, 4); }
  function railValues() {
    var r = st.row || {}, u = st.ui;
    return [str(r.name), str(r.year), str(r.major), r.depth ? DEPTHS[depthIndex()].label : "",
      u.pfile ? trunc(u.pfile.name, 26) : "", trunc(str(r.project_draft), 26),
      r.analysis && st.step > 6 ? r.analysis.areas.length + " areas" : "",
      r.details && st.step > 7 ? Object.keys(r.details.answers || {}).length + " of " + r.details.questions.length + " answered" : "",
      st.step > 8 ? trunc(str(r.goal_chosen), 26) : "", st.step >= 10 ? (r.todos || []).length + " todos" : ""];
  }

  function railView() {
    var rail = el("div", "ob-rail");
    rail.appendChild(el("div", "ob-brand", "Engelbart"));
    rail.appendChild(el("div", "ob-caption", "Setting up your first project"));
    var steps = el("div", "ob-steps");
    var vals = railValues(), reach = (st.row && st.row.step) || 0;
    LABELS.forEach(function (label, i) {
      var wrap = el("div");
      if (i > 0) wrap.appendChild(attr(el("span", "ob-con"), "data-on", st.step >= i ? "1" : "0"));
      var done = !!vals[i] && st.step > i, active = st.step === i, reachable = i <= reach && st.step < 10;
      var row = el("div", "ob-row");
      attr(row, "data-active", active ? "1" : "0");
      attr(row, "data-reach", reachable && !active ? "1" : "0");
      if (reachable && !active) on(row, "click", function () { go(i); });
      var circle = el("span", "ob-circle", done ? "✓" : String(i + 1));
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
    if (st.row && st.row.analysis_status === "running") {
      var reading = el("div", "ob-reading");
      reading.appendChild(dots());
      reading.appendChild(el("span", "", "Reading your paper in the background"));
      rail.appendChild(reading);
    }
    return rail;
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

  function draw() {
    app.textContent = "";
    if (st.screen === "loading") { app.appendChild(el("div", "ob-wait", st.error || "Waking up…")); return; }
    if (st.screen === "signin") { window.location.href = "/engelbart/signin"; return; }
    if (st.screen === "error") { var e = el("div", "ob-wait"); e.appendChild(el("div", "ob-err", st.error)); app.appendChild(e); return; }
    app.appendChild(railView());
    var main = el("div", "ob-main"), body = el("div", "ob-body"), content = el("div", "ob-content");
    content.id = "content";
    var drawers = [drawName, drawYear, drawMajor, drawDepth, drawPaper, drawProject, drawTopics, drawDetails, drawFocus, drawTodos, drawDone];
    drawers[st.step](content);
    if (st.error) content.appendChild(el("div", "ob-err", st.error));
    body.appendChild(content);
    if (typeof askPanel === "function") askPanel(body);
    main.appendChild(body); app.appendChild(main);
    var focus = content.querySelector("[autofocus]"); if (focus) focus.focus();
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
    var box = stepBox(content, "Step 1 of 10", "What is your name?");
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
    var box = stepBox(content, "Step 2 of 10", "What year are you?");
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
    var box = stepBox(content, "Step 3 of 10", "What is your major?");
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
    var box = stepBox(content, "Step 4 of 10", "How technical should explanations be?");
    var panel = el("div", "ob-panel");
    panel.appendChild(slider({ stops: DEPTHS, pos: st.ui.depthPos, grid: true,
      onCommit: function (p) {
        st.ui.depthPos = p; st.ui.depthTouched = true; st.row.depth = DEPTHS[snap(p, DEPTHS.length)].key; draw();
      } }));
    box.appendChild(panel);
    var acts = attr(el("div", "ob-actions"), "data-between", "1");
    acts.appendChild(el("span", "ob-hint", st.ui.depthTouched ? "You can change this later." : "Everyday is the default · drag to change · you can adjust it later"));
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
    var box = stepBox(content, "Step 5 of 10", "Which paper are you building on?");
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
        // Not awaited: the reader has left this step by the time it answers,
        // so it reports into the rail and never through fail().
        api("analysis", { run: true }).then(function (read) {
          st.row.analysis_status = read.analysis_status;
          if (read.analysis) st.row.analysis = read.analysis;
          st.row.analysis_error = read.analysis_error || "";
          draw();
        }).catch(function (e) {
          st.row.analysis_status = "error"; st.row.analysis_error = e.message; draw();
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

  // 5 Project
  function drawProject(content) {
    var box = stepBox(content, "Step 6 of 10", "What's your project?");
    var next = function () { if (!st.ui.draft.trim()) return; save(6, { project_draft: st.ui.draft.trim() }).then(function () { go(6); }).catch(fail); };
    var acts = el("div", "ob-actions"), button = cta("Continue", !st.ui.draft.trim(), next);
    box.appendChild(field(st.ui.draft, "e.g. a command-line tool that reads a paper and turns its method into runnable code",
      function (v) { st.ui.draft = v; button.disabled = !v.trim(); }, next, true));
    acts.appendChild(button); box.appendChild(acts);
  }

  // Steps 6-10 are drawn by the second half of this file (Task 8); until then
  // they show the generating indicator.
  function generating(content, text) { var w = el("div", "ob-wait"); w.appendChild(dots()); w.appendChild(el("div", "ob-wait-t", text)); content.appendChild(w); }
  // Task 8: a reload can land here with a paper on the row and
  // analysis_status === "none" (the tab closed between the paper step's
  // sources and its analysis run) -- send api("analysis", {run: true}) then.
  function drawTopics(c) { generating(c, "Still reading your paper"); }
  function drawDetails(c) { generating(c, "Writing your questions"); }
  function drawFocus(c) { generating(c, "Writing goals"); }
  function drawTodos(c) { generating(c, "Writing todos"); }
  function drawDone(c) { generating(c, "Done"); }
  var askPanel = null;

  // --- boot --------------------------------------------------------------------

  function boot() {
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
