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
      fIdx: 0, fam: {}, fAnswers: {}, followUp: null, lastGrade: null,
      qIdx: 0, goalPick: "", goalOther: "", goalOtherOn: false, todos: [], newTodo: "", projName: "",
      askBtn: null, askOpen: false, askQuote: "", askText: "", asks: [], made: null
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
      if (was && (was.analysis_status === "done" || was.analysis_status === "error") && st.row.analysis_status !== "done") {
        st.row.analysis_status = was.analysis_status; st.row.analysis = was.analysis; st.row.analysis_error = was.analysis_error;
      }
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
          // A run the server superseded was reading a paper this row no longer
          // has: it answers about nothing, so nothing here changes.
          if (read.analysis_status === "superseded") return;
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

  function drawTopics(content) {
    var r = st.row;
    if (r.analysis_status === "none" && r.paper_id) {
      // The tab closed between the paper step's sources and its run.
      startReading({ run: true });
    }
    if (r.analysis_status === "error") {
      var box = stepBox(content, "Step 7 of 10", "The paper could not be read");
      box.appendChild(el("div", "ob-sub", r.analysis_error || "Something went wrong while reading it."));
      var acts = el("div", "ob-actions");
      acts.appendChild(cta("Try again", false, function () { startReading({ retry: true }); draw(); }));
      box.appendChild(acts); return;
    }
    if (r.analysis_status !== "done" || !r.analysis) {
      var w = el("div", "ob-wait"); w.appendChild(dots());
      w.appendChild(el("div", "ob-wait-t", "Still reading your paper"));
      w.appendChild(el("div", "ob-wait-s", "Questions about it come next."));
      content.appendChild(w); pollAnalysis(); return;
    }
    var a = r.analysis, areas = a.areas, fi = Math.min(st.ui.fIdx || 0, areas.length - 1), area = areas[fi];
    var box2 = el("div", "ob-step");
    box2.appendChild(el("div", "ob-count", "Step 7 of 10 · Topics"));
    box2.appendChild(el("div", "ob-title", "How familiar are you with what the paper leans on?"));
    var paper = el("div", "ob-paper"); paper.appendChild(el("div", "ob-paper-icon"));
    var pt = el("div", "ob-grow"), line = el("div", "ob-paper-line");
    line.appendChild(el("span", "ob-paper-title", a.title)); line.appendChild(el("span", "ob-paper-venue", a.date || ""));
    pt.appendChild(line); pt.appendChild(el("div", "ob-paper-sum", a.one_liner)); paper.appendChild(pt); box2.appendChild(paper);

    var card = el("div", "ob-area");
    var head = el("div", "ob-area-head");
    head.appendChild(el("span", "ob-area-n", (fi + 1) + " / " + areas.length));
    head.appendChild(el("div", "ob-area-name", area.area)); card.appendChild(head);
    if (area.project_role) card.appendChild(el("div", "ob-area-role", area.project_role));
    var follow = st.ui.followUp && st.ui.followUp.area === fi ? st.ui.followUp : null;
    var level = follow ? follow.question_level : levelOf(fi);
    var q = area.questions.filter(function (x) { return x.level === level; })[0] || area.questions[0];
    var key = fi + ":" + level, answer = st.ui.fAnswers[key] || "";
    // Only the question is shown; the sample answers in the analysis stay unseen.
    card.appendChild(slider({ stops: LADDER, pos: famOf(fi), ends: ["Beginner", "Expert"],
      onCommit: function (v) { if (follow) return; st.ui.fam[fi] = v; draw(); } }));
    var qbox = el("div");
    qbox.appendChild(el("div", "ob-q-label", follow ? "One more, at the level your answer showed" : "Question"));
    qbox.appendChild(el("div", "ob-q", q.question));
    var ab = attr(el("div", "ob-answer"), "data-filled", answer.trim() ? "1" : "0");
    var input = el("input"); input.value = answer; input.placeholder = "one sentence is enough…"; input.spellcheck = false; input.setAttribute("autofocus", "");
    on(input, "input", function () { st.ui.fAnswers[key] = input.value; ab.setAttribute("data-filled", input.value.trim() ? "1" : "0"); next.disabled = !input.value.trim() || !!st.busy; });
    on(input, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    ab.appendChild(input); qbox.appendChild(ab);
    var lastGrade = st.ui.lastGrade && st.ui.lastGrade.area === fi ? st.ui.lastGrade : null;
    if (lastGrade) { var g = el("div", "ob-grade"); g.appendChild(el("span", "tag", "Graded")); g.appendChild(el("span", "", lastGrade.text)); qbox.appendChild(g); }
    card.appendChild(qbox); box2.appendChild(card);

    var last = fi === areas.length - 1;
    function labelFor(lvl) { var hit = LADDER.filter(function (l) { return l.level === lvl; })[0]; return hit ? hit.label.toLowerCase() : String(lvl); }
    function advance() {
      st.ui.followUp = null; st.ui.lastGrade = null;
      if (last) save(7, {}).then(function () { go(7); }).catch(fail); else { st.ui.fIdx = fi + 1; draw(); }
    }
    function submit() {
      var said = (st.ui.fAnswers[key] || "").trim(); if (!said || st.busy) return;
      st.busy = "grading"; draw();
      api("answer", { area_index: fi, question_level: level, self_level: levelOf(fi), answer: said }).then(function (out) {
        st.busy = "";
        st.cals = st.cals.filter(function (c) { return !(Number(c.area_index) === fi && Number(c.question_level) === level); });
        st.cals.push({ area_index: fi, question_level: level, answered_at: new Date().toISOString(), graded_level: out.graded_level });
        if (out.follow_up && !follow) {
          st.ui.followUp = { area: fi, question_level: out.follow_up.question_level };
          st.ui.lastGrade = { area: fi, text: "Your answer read as “" + labelFor(out.graded_level) + "”" + (out.grade_rationale ? " — " + out.grade_rationale : "") };
          draw(); return;
        }
        advance();
      }).catch(fail);
    }
    var nav = el("div", "ob-nav");
    var back = el("button", "ob-arrow", "←"); back.type = "button";
    if (fi === 0) back.setAttribute("disabled", "disabled"); else on(back, "click", function () { st.ui.followUp = null; st.ui.fIdx = fi - 1; draw(); });
    nav.appendChild(back);
    var pd = el("span", "ob-pdots");
    areas.forEach(function (_, i) {
      var d = attr(attr(el("span", "ob-pdot"), "data-on", i === fi ? "1" : "0"), "data-done", answeredArea(i) ? "1" : "0");
      on(d, "click", function () { st.ui.followUp = null; st.ui.fIdx = i; draw(); }); pd.appendChild(d);
    });
    nav.appendChild(pd);
    var next = cta(st.busy === "grading" ? "Grading…" : last && !follow ? "On to the project" : "Next", !answer.trim() || !!st.busy, submit);
    nav.appendChild(next); box2.appendChild(nav); content.appendChild(box2);
  }

  // --- 7 Details ---------------------------------------------------------------

  function drawDetails(content) {
    var r = st.row;
    if (!r.details || !r.details.questions) {
      if (!st.busy) { st.busy = "details"; api("details").then(function (d) { st.busy = ""; st.row.details = d; st.ui.qIdx = 0; draw(); }).catch(fail); }
      generating(content, "Writing your questions"); return;
    }
    var qs = r.details.questions, qi = Math.min(st.ui.qIdx || 0, qs.length - 1), q = qs[qi], answers = r.details.answers || {};
    var ans = answers[q.id];
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Step 8 of 10 · Details")); head.appendChild(el("span", "ob-count", (qi + 1) + " of " + qs.length)); box.appendChild(head);
    if (r.details.intro) { var intro = el("div", "ob-intro"); intro.appendChild(el("span", "tag", "Taken into account")); intro.appendChild(el("span", "t", r.details.intro)); box.appendChild(intro); }
    box.appendChild(el("div", "ob-question", q.title));
    if (q.hint) box.appendChild(el("div", "ob-sub", q.hint));
    var lastQ = qi >= qs.length - 1;
    function empty(v) { return v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "string" && !v.trim()); }
    function persist(value) {
      var f = {}; f[q.id] = value == null ? null : value;
      return save(lastQ ? 8 : 7, { details_answers: f }).then(function () { if (lastQ) go(8); else { st.ui.qIdx = qi + 1; draw(); } }).catch(fail);
    }
    function setAns(v) { answers[q.id] = v; r.details.answers = answers; draw(); }
    var nextBtn;
    if (q.kind === "short") {
      var draft = typeof ans === "string" ? ans : "";
      box.appendChild(field(draft, q.placeholder || "", function (v) { draft = v; nextBtn.disabled = !v.trim(); }, function () { if (draft.trim()) persist(draft.trim()); }, true));
      nextBtn = cta(lastQ ? "Pick a focus" : "Next", !draft.trim(), function () { if (draft.trim()) persist(draft.trim()); });
    } else {
      var opts = el("div", "ob-opts"), multi = q.kind === "multi", cur = Array.isArray(ans) ? ans : [];
      (q.options || []).forEach(function (label) {
        var on_ = multi ? cur.indexOf(label) >= 0 : ans === label;
        opts.appendChild(option(label, on_, function () { if (multi) setAns(on_ ? cur.filter(function (x) { return x !== label; }) : cur.concat([label])); else setAns(on_ ? null : label); }, multi));
      });
      box.appendChild(opts);
      if (multi) box.appendChild(el("div", "ob-multi-note", "Pick all that apply."));
      nextBtn = cta(lastQ ? "Pick a focus" : "Next", empty(ans), function () { if (!empty(ans)) persist(ans); });
    }
    var nav = attr(el("div", "ob-nav"), "data-rule", "1");
    var back = el("button", "ob-arrow", "←"); back.type = "button";
    if (qi === 0) back.setAttribute("disabled", "disabled"); else on(back, "click", function () { st.ui.qIdx = qi - 1; draw(); });
    nav.appendChild(back);
    var pd = el("span", "ob-pdots");
    qs.forEach(function (_, i) { var d = attr(el("span", "ob-pdot"), "data-on", i === qi ? "1" : "0"); on(d, "click", function () { st.ui.qIdx = i; draw(); }); pd.appendChild(d); });
    nav.appendChild(pd);
    var end = el("div", "ob-nav-end");
    var skip = el("button", "ob-ghost", "Skip"); skip.type = "button";
    end.appendChild(on(skip, "click", function () { persist(null); }));
    end.appendChild(nextBtn); nav.appendChild(end); box.appendChild(nav);
    content.appendChild(box);
  }

  // --- 8 Focus -----------------------------------------------------------------

  function drawFocus(content) {
    var r = st.row;
    if (st.busy === "todos") { generating(content, "Writing todos"); return; }
    if (!r.goals || !r.goals.goals) {
      if (!st.busy) { st.busy = "goals"; api("goals").then(function (g) { st.busy = ""; st.row.goals = g; draw(); }).catch(fail); }
      generating(content, "Writing goals"); return;
    }
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Step 9 of 10 · Focus")); head.appendChild(el("span", "ob-count", "One goal")); box.appendChild(head);
    box.appendChild(el("div", "ob-question", "What should the first project be about?"));
    box.appendChild(el("div", "ob-sub", "Pick one. The rest can be later projects."));
    var list = el("div", "ob-opts");
    var rows = r.goals.goals.concat([{ label: "Something else", why: "tell it what to start on instead and it will use that", other: true }]);
    rows.forEach(function (g) {
      var on_ = g.other ? st.ui.goalOtherOn : (!st.ui.goalOtherOn && st.ui.goalPick === g.label);
      var row = attr(el("div", "ob-goal"), "data-on", on_ ? "1" : "0"); row.appendChild(el("span", "ob-mark"));
      var t = el("span", "ob-grow"); t.appendChild(el("span", "ob-goal-label", g.label)); t.appendChild(el("span", "ob-goal-why", g.why)); row.appendChild(t);
      on(row, "click", function () { if (g.other) { st.ui.goalOtherOn = !on_; st.ui.goalPick = ""; } else { st.ui.goalOtherOn = false; st.ui.goalPick = on_ ? "" : g.label; } draw(); });
      list.appendChild(row);
    });
    box.appendChild(list);
    var gen;
    if (st.ui.goalOtherOn) box.appendChild(field(st.ui.goalOther || "", "what to start on instead…", function (v) { st.ui.goalOther = v; gen.disabled = !v.trim(); }, null));
    var chosen = st.ui.goalOtherOn ? str(st.ui.goalOther).trim() : st.ui.goalPick;
    var acts = el("div", "ob-actions");
    gen = cta("Write todos", !chosen, function () {
      var goal = st.ui.goalOtherOn ? str(st.ui.goalOther).trim() : st.ui.goalPick;
      if (!goal) return;
      st.busy = "todos"; draw();
      api("todos", { goal: goal }).then(function (out) {
        st.busy = ""; st.row.goal_chosen = goal; st.ui.todos = out.todos.slice();
        st.ui.projName = st.ui.projName || out.name || ""; st.row.step = Math.max(st.row.step || 0, 9); go(9);
      }).catch(fail);
    });
    acts.appendChild(gen); box.appendChild(acts); content.appendChild(box);
  }

  // --- 9 Todos -----------------------------------------------------------------

  function issueCode() {
    return post(DEVICE_API, { action: "issue" }).then(function (v) {
      st.ui.made = { code: v.code, expiresInSeconds: v.expiresInSeconds }; return v;
    });
  }

  function drawTodos(content) {
    if (st.busy === "create") { generating(content, "Making " + (st.ui.projName || "your project")); return; }
    var todos = st.ui.todos || [], n = todos.length, canAdd = n < 4;
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Step 10 of 10 · Todos")); head.appendChild(el("span", "ob-count", n + " of 4")); box.appendChild(head);
    box.appendChild(el("div", "ob-cap", "Goal")); box.appendChild(el("div", "ob-goal-title", st.row.goal_chosen));
    var rows = el("div", "ob-rows");
    todos.forEach(function (t, i) {
      var row = el("div", "ob-trow"); row.appendChild(el("span", "dash", "–"));
      var input = el("input"); input.value = t; input.spellcheck = false;
      on(input, "input", function () { todos[i] = input.value; create.disabled = off(); }); row.appendChild(input);
      var x = el("button", "x", "×"); x.type = "button";
      row.appendChild(on(x, "click", function () { todos.splice(i, 1); draw(); })); rows.appendChild(row);
    });
    if (canAdd) {
      var add = el("div", "ob-trow"); add.appendChild(el("span", "dash", "–"));
      var ni = el("input"); ni.value = st.ui.newTodo || ""; ni.placeholder = "add a todo…"; ni.spellcheck = false;
      on(ni, "input", function () { st.ui.newTodo = ni.value; });
      on(ni, "keydown", function (e) { if (e.key === "Enter" && ni.value.trim()) { e.preventDefault(); todos.push(ni.value.trim()); st.ui.newTodo = ""; draw(); } });
      add.appendChild(ni); rows.appendChild(add);
    }
    box.appendChild(rows);
    box.appendChild(el("div", "ob-hint", n < 2 ? "At least two todos." : n >= 4 ? "Four is the cap — keep the first project small." : "Edit, remove, or add up to " + (4 - n) + " more."));
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
      api("create", { project_name: pname, goal_chosen: st.row.goal_chosen, todos: rowsClean })
        .then(function () { return issueCode(); })
        .then(function () { st.busy = ""; st.row.status = "created"; st.row.project_name = pname; st.row.todos = rowsClean; go(10); })
        .catch(fail);
    });
    name.appendChild(create); box.appendChild(name); content.appendChild(box);
  }

  // --- 10 Done -----------------------------------------------------------------

  function cmdRow(box, label, cmd) {
    box.appendChild(el("div", "ob-cap", label));
    var row = el("div", "ob-cmd");
    row.appendChild(el("span", "ob-cmd-text", cmd));
    var copy = el("button", "ob-cmd-copy", "Copy"); copy.type = "button";
    on(copy, "click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(cmd).then(function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1400); }, function () {});
    });
    row.appendChild(copy); box.appendChild(row);
  }

  function drawDone(content) {
    var r = st.row, box = el("div", "ob-step ob-done");
    box.appendChild(el("span", "ob-check", "✓"));
    box.appendChild(el("div", "ob-done-t", (r.project_name || "Your project") + " is made"));
    var d = DEPTHS.filter(function (x) { return x.key === r.depth; })[0];
    box.appendChild(el("div", "ob-done-s", "One goal and " + (r.todos || []).length + " todos, written for " + (r.name || "you") + " — explanations " + (d ? d.phrase : "in everyday language") + "."));
    if (!st.ui.made) {
      if (st.busy !== "code") { st.busy = "code"; issueCode().then(function () { st.busy = ""; draw(); }).catch(fail); }
      generating(box, "Getting your install code");
    } else {
      var code = st.ui.made.code;
      // Mac and Linux run the npm package through bun; Windows takes the
      // PowerShell installer, which redeems the same code (the npm package
      // does not install on Windows).
      cmdRow(box, "Mac or Linux", "bunx engelbart-cli --code " + code);
      cmdRow(box, "Windows (PowerShell)", "& ([scriptblock]::Create((irm https://berkeley.mathetic.com/engelbart/install.ps1))) --code " + code);
      var mins = Math.round((st.ui.made.expiresInSeconds || 900) / 60);
      box.appendChild(el("div", "ob-done-s", "Run the one for your machine in a terminal. It installs Engelbart, connects this account, and opens the project — no second sign-in. The code works once and expires in " + mins + " minutes."));
    }
    var acts = el("div", "ob-done-acts");
    var again = el("button", "ob-ghost", "Get a new code"); again.type = "button";
    acts.appendChild(on(again, "click", function () { st.ui.made = null; draw(); }));
    var another = el("button", "ob-ghost", "Set up another"); another.type = "button";
    acts.appendChild(on(another, "click", function () {
      api("open", { fresh: true }).then(function (o) {
        st.ui.fam = {}; st.ui.fAnswers = {}; st.ui.followUp = null; st.ui.lastGrade = null; st.ui.fIdx = 0; st.ui.qIdx = 0;
        st.ui.goalPick = ""; st.ui.goalOther = ""; st.ui.goalOtherOn = false; st.ui.todos = []; st.ui.projName = "";
        st.ui.asks = []; st.ui.made = null; st.ui.pfile = null; st.ui.draft = "";
        adopt(o); draw();
      }).catch(fail);
    }));
    box.appendChild(acts); content.appendChild(box);
  }

  // --- Ask about this ----------------------------------------------------------
  //
  // From Topics on, selecting text in the content column offers a question
  // about it; the answer comes back at the reader's register and can be
  // re-asked one stop simpler or deeper.

  var QUICK = ["What does this mean?", "Why does this matter?", "Give me an example", "Is this too much for a first project?"];
  if (document.addEventListener) document.addEventListener("mouseup", function (e) {
    if (e.target && e.target.closest && e.target.closest("[data-askbtn]")) return;
    setTimeout(function () {
      var sel = window.getSelection ? window.getSelection() : null, t = sel ? sel.toString().trim() : "", c = document.getElementById("content");
      if (!t || t.length < 3 || !c || !sel.rangeCount || !c.contains(sel.anchorNode) || st.step < 6 || st.step > 9) { if (st.ui.askBtn) { st.ui.askBtn = null; draw(); } return; }
      var r = sel.getRangeAt(0).getBoundingClientRect(), cr = c.getBoundingClientRect();
      st.ui.askBtn = { text: t.slice(0, 240), x: r.left - cr.left + r.width / 2, y: r.top - cr.top }; draw();
    }, 0);
  });

  function askPanel(body) {
    var content = body.children[0];
    if (st.ui.askBtn && !st.ui.askOpen && content) {
      var b = attr(el("button", "ob-askbtn", "Ask about this"), "data-askbtn", "1"); b.type = "button";
      b.style.left = st.ui.askBtn.x + "px"; b.style.top = st.ui.askBtn.y + "px";
      on(b, "click", function () {
        st.ui.askQuote = st.ui.askBtn.text; st.ui.askOpen = true; st.ui.askBtn = null; st.ui.askText = "";
        var s = window.getSelection ? window.getSelection() : null; if (s && s.removeAllRanges) s.removeAllRanges(); draw();
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
