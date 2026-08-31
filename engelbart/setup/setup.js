/* The web onboarding: a research exploration.
 *
 * A member unfolds from their own interest out to a real Berkeley lab, shapes a
 * concrete first project with the model, edits the four-lane path it proposes,
 * and leaves with one command -- `npx engelbart-cli --code XXXX-XXXX-XXXX` --
 * that installs Engelbart on their machine and pulls the project down without a
 * second sign-in.
 *
 * This is a vanilla-JS port of the "Engelbart Onboarding v3" design canvas: the
 * same monospace, ink-on-white unfolding, the same black idea pills, tree
 * lines, and entrance animations (see setup.css), translated out of the design
 * runtime into the same plain el()/on()/btn() idiom the old setup page used.
 * Where the reference simulated data with fixtures and setTimeout, this talks
 * to the real endpoints:
 *   /api/engelbart-research  lab                      (read-only browsing)
 *   /api/engelbart-setup     areas | ideas | refine | path | save_path  (model-backed)
 *   /api/engelbart-device    issue                   (the install code)
 * The Supabase auth boot and the install-code handoff are carried over intact
 * from the conversation page this replaces. */
(function () {
  "use strict";

  var app = document.getElementById("app");

  var client = null;   // supabase client, once config is fetched
  var session = null;  // the member's session, once signed in

  // Progress rail: interest -> area -> lab -> project. Each phase sits at one
  // of these depths; steps shallower than the current one are walkable back.
  var RAIL = [
    { label: "Interest", phase: "interest", depth: 0 },
    { label: "Area", phase: "direction", depth: 1 },
    { label: "Lab", phase: "lab", depth: 2 },
    { label: "Project", phase: "project", depth: 3 }
  ];
  var DEPTH = {
    interest: 0, direction: 1, lab: 2, explore: 2,
    project: 3, generating: 3, path: 3, done: 3
  };

  var LANES = ["brainstorm", "understand", "implement", "apply"];
  var LANE_LABEL = {
    brainstorm: "Brainstorm", understand: "Understand",
    implement: "Implement", apply: "Apply"
  };
  var LANE_NOTE = {
    brainstorm: "Open questions to explore first — these can change as you learn.",
    understand: "What to read or reproduce, grounded in the lab's real work.",
    implement: "Concrete steps to a first working version.",
    apply: "How to share it back with the lab."
  };

  var CURL_INSTALL = "https://berkeley.mathetic.com/engelbart/install.sh";

  // `screen` gates loading/sign-in; within `flow`, `phase` is what is drawn.
  var st = {
    screen: "loading",   // loading | signin | flow
    phase: "interest",   // interest | direction | lab | explore | project | generating | path | done
    thinking: false,     // a phase transition is in flight
    error: "",
    menu: false,         // account menu open

    draft0: "",          // the interest textarea
    interest: "",        // the submitted interest

    areas: [],
    areaIdx: -1,

    labs: [],
    labSel: null,        // chosen pi_id

    lab: null,           // { pi, members, projects }
    ideas: [],
    ideasLoading: false,
    ideasError: "",
    hoverIdea: -1,

    idea: null,          // the chosen, editable idea { title, description, why, inspired }

    refMsgs: [],         // [{ who: 'you' | 'engelbart', text }]
    refDraft: "",
    refining: false,

    path: null,          // { name, objective } as returned
    lanes: null,         // editable { brainstorm: [{id,text}], ... }
    name: "",
    saving: false,

    made: null,          // { name, code, expiresInSeconds }
    installKind: "curl", // curl | npx — curl first: needs nothing on the machine

    profile: null        // the open researcher/lab modal, or null
  };

  function dark() {
    try {
      return window.localStorage
        && window.localStorage.getItem("hc-setup-theme") === "dark";
    } catch (e) { return false; }
  }

  // --- little DOM helpers ---------------------------------------------------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function on(node, event, fn) { node.addEventListener(event, fn); return node; }
  function str(value) { return value == null ? "" : String(value); }
  function fresh() { return "x" + Math.random().toString(36).slice(2, 8); }
  function row(text) { return { id: fresh(), text: str(text) }; }

  function btn(label, cls, fn, opts) {
    opts = opts || {};
    var b = el("button", "btn " + (cls || ""));
    b.appendChild(el("span", "", label));
    if (opts.arrow) b.appendChild(el("span", "go", "›"));
    if (opts.disabled) b.setAttribute("disabled", "disabled");
    else on(b, "click", fn);
    return b;
  }

  function initials(name) {
    var parts = str(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "·";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function grow(area) {
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight, 260) + "px";
  }

  // --- the server -----------------------------------------------------------

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (session && session.access_token)
      },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (value) {
        if (!r.ok) throw new Error(value.error || "the request failed");
        return value;
      });
    });
  }
  function research(action, body) {
    return post("/api/engelbart-research", Object.assign({ action: action }, body || {}));
  }
  function setup(action, body) {
    return post("/api/engelbart-setup", Object.assign({ action: action }, body || {}));
  }
  function issueCode() {
    return post("/api/engelbart-device", { action: "issue" });
  }

  // --- moving through the exploration --------------------------------------

  function fail(error) {
    st.thinking = false;
    st.error = (error && error.message) || "something went wrong";
    draw();
  }

  function submitInterest() {
    var interest = st.draft0.trim();
    if (!interest || st.thinking) return;
    st.interest = interest;
    st.error = "";
    st.thinking = true;
    draw();
    // The areas are semantic clusters the model draws over the real labs the
    // interest retrieved -- a model-backed setup call, not a plain read -- and
    // each area already carries the real labs beneath it.
    setup("areas", { interest: interest }).then(function (out) {
      st.thinking = false;
      // Curated areas lead (the backend returns them first); interest-discovered
      // areas follow. Keep a few of each so a curated participant still sees
      // discovery beyond what was hand-picked, rather than only their curation.
      st.areas = (out.areas || []).slice(0, 6);
      if (!st.areas.length) {
        st.error = "Nothing matched that yet — try describing it a little differently.";
        draw();
        return;
      }
      st.phase = "direction";
      draw();
    }, fail);
  }

  function pickArea(i) {
    if (st.thinking) return;
    var area = st.areas[i];
    if (!area) return;
    st.areaIdx = i;
    st.error = "";
    // The labs are already embedded in the chosen area -- no second round-trip.
    st.labs = area.labs || [];
    if (!st.labs.length) {
      st.error = "No labs surfaced for that area — pick another.";
      draw();
      return;
    }
    st.phase = "lab";
    draw();
  }

  function pickLab(piId) {
    if (st.thinking) return;
    st.labSel = piId;
    st.error = "";
    st.thinking = true;
    draw();
    research("lab", { piId: piId }).then(function (detail) {
      st.thinking = false;
      st.lab = detail;
      st.phase = "explore";
      st.hoverIdea = -1;
      draw();
      loadIdeas();
    }, fail);
  }

  // Ideas are model-backed and billed to the member; a spent key is a friendly
  // 409, so a failure here leaves the lab tree standing with a retry rather
  // than throwing the whole screen away.
  function loadIdeas() {
    st.ideas = [];
    st.ideasError = "";
    st.ideasLoading = true;
    draw();
    setup("ideas", { piId: st.labSel, interest: st.interest }).then(function (out) {
      st.ideasLoading = false;
      st.ideas = out.ideas || [];
      if (!st.ideas.length) st.ideasError = "No ideas came back — try again.";
      draw();
    }, function (error) {
      st.ideasLoading = false;
      st.ideasError = (error && error.message) || "could not reach Claude";
      draw();
    });
  }

  function pickIdea(i) {
    var idea = st.ideas[i];
    st.idea = {
      title: str(idea.title),
      description: str(idea.what),
      why: str(idea.why),
      inspired: str(idea.inspired)
    };
    st.refMsgs = [];
    st.refDraft = "";
    st.phase = "project";
    draw();
  }

  function sendRefine() {
    var note = st.refDraft.trim();
    if (!note || st.refining) return;
    st.refMsgs.push({ who: "you", text: note });
    st.refDraft = "";
    st.refining = true;
    st.error = "";
    draw();
    setup("refine", {
      piId: st.labSel,
      idea: { title: st.idea.title, description: st.idea.description },
      note: note
    }).then(function (out) {
      st.refining = false;
      if (out.title) st.idea.title = out.title;
      if (out.description) st.idea.description = out.description;
      st.refMsgs.push({ who: "engelbart", text: out.say || "Updated the idea above." });
      draw();
    }, function (error) {
      st.refining = false;
      st.refMsgs.push({
        who: "engelbart",
        text: (error && error.message) || "I couldn't reach Claude just then."
      });
      draw();
    });
  }

  function generatePath() {
    if (st.thinking) return;
    st.error = "";
    st.thinking = true;
    st.phase = "generating";
    draw();
    setup("path", {
      piId: st.labSel,
      idea: { title: st.idea.title, description: st.idea.description },
      interest: st.interest
    }).then(function (out) {
      st.thinking = false;
      st.path = { name: out.name || st.idea.title, objective: out.objective || st.idea.description };
      st.lanes = {};
      LANES.forEach(function (lane) {
        st.lanes[lane] = ((out.lanes && out.lanes[lane]) || []).map(row);
      });
      st.name = st.path.name;
      st.phase = "path";
      draw();
    }, function (error) {
      st.thinking = false;
      st.phase = "project";
      st.error = (error && error.message) || "the path could not be charted";
      draw();
    });
  }

  // The one write: save the edited path, then mint the install code.
  function createProject() {
    if (!st.name.trim() || st.saving) return;
    st.saving = true;
    st.error = "";
    draw();
    var lanes = {};
    LANES.forEach(function (lane) {
      lanes[lane] = st.lanes[lane]
        .map(function (r) { return r.text; })
        .filter(function (t) { return t.trim(); });
    });
    setup("save_path", {
      piId: st.labSel,
      // The student's original interest, so Generate can ground the structured
      // project (and its Brainstorm document) in what they actually asked for.
      interest: st.interest,
      name: st.name,
      objective: st.path.objective,
      idea: {
        title: st.idea.title,
        description: st.idea.description,
        inspired: st.idea.inspired
      },
      lanes: lanes
    }).then(function () {
      return issueCode();
    }).then(function (issued) {
      st.saving = false;
      st.made = {
        name: st.name.trim(),
        code: issued.code,
        expiresInSeconds: issued.expiresInSeconds
      };
      st.phase = "done";
      draw();
    }).catch(function (error) {
      st.saving = false;
      st.error = (error && error.message) || "the project could not be saved";
      draw();
    });
  }

  function goBackTo(phase) {
    if (st.thinking) return;
    st.error = "";
    st.phase = phase;
    st.menu = false;
    draw();
  }

  function restart() {
    st.phase = "interest";
    st.draft0 = "";
    st.interest = "";
    st.areas = []; st.areaIdx = -1;
    st.labs = []; st.labSel = null;
    st.lab = null; st.ideas = []; st.ideasError = ""; st.hoverIdea = -1;
    st.idea = null; st.refMsgs = []; st.refDraft = "";
    st.path = null; st.lanes = null; st.name = "";
    st.made = null; st.error = ""; st.profile = null;
    draw();
  }

  // --- the modal: a researcher, or the lab -----------------------------------

  function openPI() {
    var pi = st.lab && st.lab.pi;
    if (!pi) return;
    st.profile = {
      name: pi.name,
      role: pi.title || "Principal investigator",
      lab: [pi.lab_name, pi.department].filter(Boolean).join(" · "),
      bio: pi.bio,
      interests: pi.interests || [],
      works: (st.lab.projects || []).slice(0, 6),
      worksLabel: "The lab's work",
      url: pi.url || pi.lab_url || ""
    };
    draw();
  }

  function openMember(m) {
    var pi = (st.lab && st.lab.pi) || {};
    // Scraped students are thin records that inherit the PI's interests, not
    // their own stated focus, so interests stay empty and we never present a
    // fabricated personal research area. Bio, site, and the "why" note appear
    // only when a curator wrote them for this student.
    st.profile = {
      name: m.name,
      role: m.title || "PhD researcher",
      lab: [pi.lab_name, pi.name ? "advised by " + pi.name : ""].filter(Boolean).join(" · "),
      bio: m.bio || "",
      why: m.why || "",
      interests: [],
      interestsNote: m.bio ? "" : "Advised in " + (pi.lab_name || "this lab")
        + ". We shape project ideas around the lab's work, not a student's individual focus.",
      works: [],
      url: m.url || ""
    };
    draw();
  }

  function closeModal() { st.profile = null; draw(); }

  // --- chrome ---------------------------------------------------------------

  function brandNode() { app.appendChild(el("div", "brand", "Engelbart")); }

  function acctNode() {
    if (!session || !session.user) return;
    var wrap = el("div", "acct-wrap");
    var b = el("button", "acct", initials(session.user.email || "?"));
    on(b, "click", function () { st.menu = !st.menu; draw(); });
    wrap.appendChild(b);
    if (st.menu) {
      var menu = el("div", "menu");
      menu.appendChild(el("div", "menu-email", session.user.email || "signed in"));
      var theme = el("button", "menu-btn", dark() ? "Switch to light" : "Switch to dark");
      on(theme, "click", function () {
        try {
          window.localStorage.setItem("hc-setup-theme", dark() ? "light" : "dark");
        } catch (e) { /* private windows keep the default */ }
        st.menu = false;
        draw();
      });
      menu.appendChild(theme);
      var out = el("button", "menu-btn", "Sign out");
      on(out, "click", function () {
        if (client) client.auth.signOut();
        window.location.href = "/engelbart/signin";
      });
      menu.appendChild(out);
      wrap.appendChild(menu);
      var scrim = el("div", "scrim");
      on(scrim, "click", function () { st.menu = false; draw(); });
      app.appendChild(scrim);
    }
    app.appendChild(wrap);
  }

  function railNode() {
    var cur = DEPTH[st.phase];
    var reachable = {
      interest: true,
      direction: st.areas.length > 0,
      lab: st.labs.length > 0,
      project: !!st.idea
    };
    var rail = el("div", "rail");
    var inner = el("div", "rail-inner");
    inner.appendChild(el("div", "rail-line"));
    RAIL.forEach(function (stepDef) {
      var back = stepDef.depth < cur && reachable[stepDef.phase];
      var here = stepDef.depth === cur;
      var stepEl = el("div", "rail-step" + (here ? " cur" : back ? " go" : ""));
      stepEl.appendChild(el("span", "rail-dot"));
      stepEl.appendChild(el("span", "rail-lbl", stepDef.label));
      if (back) on(stepEl, "click", function () { goBackTo(stepDef.phase); });
      inner.appendChild(stepEl);
    });
    rail.appendChild(inner);
    app.appendChild(rail);
  }

  // --- drawing --------------------------------------------------------------

  function draw() {
    app.setAttribute("data-dark", dark() ? "true" : "false");
    app.textContent = "";
    if (st.screen === "loading") return drawLoading();
    if (st.screen === "signin") return drawSignin();
    brandNode();
    acctNode();
    if (st.phase === "done") { drawDone(); return; }
    railNode();
    drawFlow();
    if (st.profile) drawModal();
  }

  function drawLoading() {
    var wrap = el("div", "wrap");
    var box = el("div", "loading");
    box.appendChild(el("div", "done-word", "Engelbart"));
    box.appendChild(el("div", "done-note", st.error || "Waking up…"));
    wrap.appendChild(box);
    app.appendChild(wrap);
  }

  function drawSignin() {
    brandNode();
    var wrap = el("div", "wrap");
    var gate = el("div", "gate in");
    gate.appendChild(el("div", "gate-title", "Find your first research project"));
    gate.appendChild(el("div", "gate-lede",
      "Start from what you're curious about. Engelbart walks you out to a real"
      + " Berkeley lab, shapes a concrete first project, and hands you one"
      + " command to install it on your machine. It starts with your account."));
    var go = el("a", "btn btn-dark gate-cta");
    go.setAttribute("href", "/engelbart/signin");
    go.appendChild(el("span", "", "Sign in to begin"));
    go.appendChild(el("span", "go", "›"));
    gate.appendChild(go);
    wrap.appendChild(gate);
    app.appendChild(wrap);
  }

  function drawFlow() {
    var wrap = el("div", "wrap");
    var stage = el("div", "stage");
    wrap.appendChild(stage);
    app.appendChild(wrap);

    if (st.phase === "interest") { phaseInterest(stage); return; }

    contextLine(stage);
    if (st.phase === "direction") phaseDirection(stage);
    else if (st.phase === "lab") phaseLab(stage);
    else if (st.phase === "explore") phaseExplore(stage);
    else if (st.phase === "project") phaseProject(stage);
    else if (st.phase === "generating") phaseGenerating(stage);
    else if (st.phase === "path") phasePath(stage);
  }

  function contextLine(stage) {
    var wrap = el("div", "ctx-wrap");
    var line = el("div", "ctx");
    line.appendChild(el("span", "cap", "you"));
    line.appendChild(el("span", "ctx-txt", st.interest));
    on(line, "click", function () { goBackTo("interest"); });
    wrap.appendChild(line);
    var join = el("div", "ctx-join");
    join.appendChild(el("i")); join.appendChild(el("b")); join.appendChild(el("i"));
    wrap.appendChild(join);
    stage.appendChild(wrap);
  }

  function generating(label) {
    var box = el("div", "generating");
    var dots = el("span", "dots");
    for (var i = 0; i < 9; i++) {
      var d = el("span");
      d.style.animationDelay = (i % 3 + Math.floor(i / 3)) * 90 + "ms";
      dots.appendChild(d);
    }
    box.appendChild(dots);
    box.appendChild(el("span", "", label || "thinking"));
    return box;
  }

  function errorNode(stage) {
    if (st.error) stage.appendChild(el("div", "err center", st.error));
  }

  // --- interest -------------------------------------------------------------

  function phaseInterest(stage) {
    stage.appendChild(el("div", "spacer"));
    stage.appendChild(el("div", "q0 in", "What are you interested in, and why?"));
    var wrap = el("div", "field-wrap in");
    var line = el("div", "eb-line");
    var area = el("textarea", "eb-f eb-interest");
    area.setAttribute("rows", "1");
    area.setAttribute("spellcheck", "false");
    area.setAttribute("placeholder",
      "e.g. I like machine learning and medicine — using models to read scans…");
    area.value = st.draft0;
    on(area, "input", function () { st.draft0 = area.value; grow(area); });
    on(area, "keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitInterest();
      }
    });
    line.appendChild(area);
    wrap.appendChild(line);
    wrap.appendChild(el("div", "hint", st.draft0.trim() ? "Return to continue" : ""));
    stage.appendChild(wrap);
    if (st.thinking) stage.appendChild(generating("reading Berkeley"));
    errorNode(stage);
    focusInto(area);
  }

  // --- area -----------------------------------------------------------------

  function phaseDirection(stage) {
    stage.appendChild(el("div", "reveal-label in",
      "That points toward a few research areas at Berkeley. Which pulls you most?"));
    var grid = el("div", "area-grid");
    st.areas.forEach(function (area, i) {
      var col = el("div", "area-col in");
      col.style.animationDelay = (i * 80) + "ms";
      var node = el("button", "area-node", area.label);
      on(node, "click", function () { pickArea(i); });
      col.appendChild(node);
      var n = (area.labs || []).length;
      var desc = area.summary
        ? clip(area.summary, 90)
        : n + (n === 1 ? " lab" : " labs");
      col.appendChild(el("div", "area-desc", desc));
      grid.appendChild(col);
    });
    stage.appendChild(grid);
    if (st.thinking) stage.appendChild(generating("finding labs"));
    errorNode(stage);
  }

  // --- lab ------------------------------------------------------------------

  function phaseLab(stage) {
    var area = st.areas[st.areaIdx];
    stage.appendChild(el("div", "reveal-label in",
      "In " + (area ? area.label : "that area")
      + ", these labs work closest to what you described."));
    var grid = el("div", "labs-grid");
    st.labs.forEach(function (lab, i) {
      var name = lab.labName || ((lab.piName || "") + " Lab");
      var card = el("button", "lab-card in");
      card.style.animationDelay = (i * 70) + "ms";
      card.appendChild(el("div", "lab-logo", initials(name)));
      card.appendChild(el("span", "lab-name", name));
      var desc = lab.bio
        ? clip(lab.bio, 96)
        : (lab.interests || []).slice(0, 3).join(", ");
      if (desc) card.appendChild(el("div", "lab-desc", desc));
      var pi = (lab.piName || "") + (lab.title ? " · " + lab.title : "");
      card.appendChild(el("div", "lab-pi", pi));
      on(card, "click", function () { pickLab(lab.piId); });
      grid.appendChild(card);
    });
    stage.appendChild(grid);
    if (st.thinking) stage.appendChild(generating("opening the lab"));
    errorNode(stage);
  }

  function clip(text, n) {
    text = str(text).replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
  }

  // --- explore: the lab tree ------------------------------------------------

  function phaseExplore(stage) {
    var pi = (st.lab && st.lab.pi) || {};
    var members = (st.lab && st.lab.members) || [];

    stage.appendChild(el("div", "cap", "The lab"));
    stage.appendChild(el("div", "stem draw", "")).style.height = "18px";

    var piBtn = el("button", "node-pi in");
    piBtn.appendChild(el("div", "avatar avatar-pi", initials(pi.name)));
    var line = el("div", "person-line");
    line.appendChild(el("span", "person-name", pi.name));
    line.appendChild(el("span", "person-tag", "PI"));
    piBtn.appendChild(line);
    if (pi.lab_name) piBtn.appendChild(el("div", "person-focus", pi.lab_name));
    on(piBtn, "click", openPI);
    stage.appendChild(piBtn);

    if (members.length) {
      stage.appendChild(el("div", "members-label", "PhD researchers"));
      var mrow = el("div", "members-row");
      members.slice(0, 6).forEach(function (m, i) {
        var mBtn = el("button", "member in");
        mBtn.style.animationDelay = (i * 60) + "ms";
        mBtn.appendChild(el("div", "avatar avatar-m", initials(m.name)));
        var ml = el("div", "person-line");
        ml.appendChild(el("span", "person-name", m.name));
        mBtn.appendChild(ml);
        // Verified role only -- students inherit the PI's interests in the data,
        // so we never render those as a personal research focus.
        if (m.title) mBtn.appendChild(el("div", "person-focus", clip(m.title, 60)));
        on(mBtn, "click", function () { openMember(m); });
        mrow.appendChild(mBtn);
      });
      stage.appendChild(mrow);
    }

    stage.appendChild(el("div", "ideas-label", "Project ideas for this lab"));

    if (st.ideasLoading) { stage.appendChild(generating("shaping ideas")); return; }
    if (st.ideasError) {
      stage.appendChild(el("div", "err center", st.ideasError));
      var again = el("div", "actions");
      again.style.justifyContent = "center";
      again.appendChild(btn("Try again", "btn-ghost", loadIdeas));
      stage.appendChild(again);
      return;
    }

    var grid = el("div", "ideas-grid" + (st.hoverIdea >= 0 ? " hovering" : ""));
    st.ideas.forEach(function (idea, i) {
      var col = el("div", "idea-col in" + (st.hoverIdea === i ? " hot" : ""));
      col.style.animationDelay = (i * 70) + "ms";
      var pill = el("button", "idea-pill", idea.title);
      on(pill, "click", function () { pickIdea(i); });
      on(col, "mouseenter", function () { setHover(i); });
      on(col, "mouseleave", function () { setHover(-1); });
      col.appendChild(pill);
      if (idea.what) col.appendChild(el("div", "idea-desc", idea.what));
      grid.appendChild(col);
    });
    stage.appendChild(grid);
  }

  // Hover is a light touch: rerender only the ideas grid's hot/dim classes,
  // not the whole tree, so pointing at a pill stays cheap.
  function setHover(i) {
    if (st.hoverIdea === i) return;
    st.hoverIdea = i;
    var grid = app.querySelector(".ideas-grid");
    if (!grid) return;
    grid.classList.toggle("hovering", i >= 0);
    var cols = grid.querySelectorAll(".idea-col");
    for (var k = 0; k < cols.length; k++) cols[k].classList.toggle("hot", k === i);
  }

  // --- project idea detail + inline refine ----------------------------------

  function phaseProject(stage) {
    var pi = (st.lab && st.lab.pi) || {};
    var focus = el("div", "focus in");

    focus.appendChild(el("div", "cap", "Your project"));

    var titleLine = el("div", "focus-title-line");
    var title = el("textarea", "eb-f focus-title");
    title.setAttribute("rows", "1");
    title.setAttribute("spellcheck", "false");
    title.value = st.idea.title;
    on(title, "input", function () { st.idea.title = title.value; grow(title); });
    titleLine.appendChild(title);
    focus.appendChild(titleLine);

    var descLine = el("div", "focus-desc-line");
    var desc = el("textarea", "eb-f focus-desc");
    desc.setAttribute("rows", "2");
    desc.setAttribute("spellcheck", "false");
    desc.value = st.idea.description;
    on(desc, "input", function () { st.idea.description = desc.value; grow(desc); });
    descLine.appendChild(desc);
    focus.appendChild(descLine);

    if (st.idea.why) {
      focus.appendChild(el("div", "cap focus-cap", "Why this project"));
      focus.appendChild(el("div", "focus-why", st.idea.why));
    }

    focus.appendChild(el("div", "cap focus-cap", "Connected to"));
    var meta = el("div", "focus-meta");
    var link = el("button", "focus-link", pi.lab_name || ((pi.name || "the lab")));
    on(link, "click", openPI);
    meta.appendChild(link);
    focus.appendChild(meta);
    if (st.idea.inspired) {
      focus.appendChild(el("div", "focus-sub", "Builds on " + st.idea.inspired + "."));
    }

    // Inline refine: a quiet conversation that edits the idea in place.
    var refine = el("div", "ref-block");
    st.refMsgs.forEach(function (m) {
      var msg = el("div", "ref-msg");
      msg.appendChild(el("div", "ref-who", m.who === "you" ? "you" : "engelbart"));
      msg.appendChild(el("div", "ref-text " + m.who, m.text));
      refine.appendChild(msg);
    });
    if (st.refining) refine.appendChild(generating("refining"));
    var inputLine = el("div", "ref-input-line");
    var input = el("textarea", "eb-f ref-input");
    input.setAttribute("rows", "1");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("placeholder", "Ask for a change — smaller scope, a different angle…");
    input.value = st.refDraft;
    on(input, "input", function () { st.refDraft = input.value; grow(input); });
    on(input, "keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendRefine();
      }
    });
    inputLine.appendChild(input);
    refine.appendChild(inputLine);
    focus.appendChild(refine);

    var acts = el("div", "actions");
    acts.appendChild(btn("Chart the path", "btn-dark", generatePath, { arrow: true }));
    acts.appendChild(btn("Back to ideas", "btn-ghost", function () { goBackTo("explore"); }));
    focus.appendChild(acts);

    errorNode(focus);
    stage.appendChild(focus);
  }

  // --- generating -----------------------------------------------------------

  function phaseGenerating(stage) {
    stage.appendChild(el("div", "focus in"))
      .appendChild(el("div", "cap", "Your project"));
    stage.appendChild(generating("charting a path through “" + clip(st.idea.title, 40) + "”"));
  }

  // --- the path -------------------------------------------------------------

  function phasePath(stage) {
    var path = el("div", "path");
    path.appendChild(el("div", "path-head", "Your path"));
    if (st.path.objective) {
      path.appendChild(el("div", "path-target", "Toward: " + st.path.objective));
    }

    LANES.forEach(function (lane) {
      var block = el("div", "lane");
      block.appendChild(el("div", "lane-name", LANE_LABEL[lane]));
      block.appendChild(el("div", "lane-note", LANE_NOTE[lane]));
      var rows = el("div", "lane-rows");
      st.lanes[lane].forEach(function (r) {
        rows.appendChild(laneRow(lane, r));
      });
      rows.appendChild(laneAdder(lane));
      block.appendChild(rows);
      path.appendChild(block);
    });

    var namerow = el("div", "namerow");
    var name = el("input", "eb-f");
    name.setAttribute("type", "text");
    name.setAttribute("spellcheck", "false");
    name.setAttribute("placeholder", "name this project");
    name.value = st.name;
    on(name, "input", function () { st.name = name.value; syncCreate(); });
    namerow.appendChild(name);
    var create = btn(st.saving ? "Saving…" : "Create project",
      st.name.trim() && !st.saving ? "btn-dark" : "btn-dark",
      createProject, { arrow: true, disabled: !st.name.trim() || st.saving });
    create.setAttribute("data-create", "1");
    namerow.appendChild(create);
    path.appendChild(namerow);

    var acts = el("div", "actions");
    acts.appendChild(btn("Back to the idea", "btn-ghost", function () { goBackTo("project"); }));
    path.appendChild(acts);

    errorNode(path);
    stage.appendChild(path);
  }

  // Toggle the Create button without redrawing the whole path (which would
  // blur the name field mid-type).
  function syncCreate() {
    var b = app.querySelector("[data-create]");
    if (!b) return;
    if (st.name.trim() && !st.saving) {
      b.removeAttribute("disabled");
      if (!b.querySelector(".go")) b.appendChild(el("span", "go", "›"));
      b.onclick = createProject;
    } else {
      b.setAttribute("disabled", "disabled");
      b.onclick = null;
    }
  }

  function laneRow(lane, r) {
    var line = el("div", "eb-row");
    line.appendChild(el("span", "eb-row-dot", "·"));
    var body = el("div", "eb-row-body");
    var parts = str(r.text).split("\n");
    body.appendChild(el("div", "eb-row-main", parts[0]));
    if (parts.length > 1 && parts.slice(1).join(" ").trim()) {
      body.appendChild(el("div", "eb-row-sub", parts.slice(1).join(" ")));
    }
    line.appendChild(body);
    var x = el("button", "eb-x", "×");
    on(x, "click", function () {
      st.lanes[lane] = st.lanes[lane].filter(function (o) { return o !== r; });
      draw();
    });
    line.appendChild(x);
    return line;
  }

  function laneAdder(lane) {
    var line = el("div", "lane-add");
    line.appendChild(el("span", "eb-row-dot", "·"));
    var input = el("input", "eb-f");
    input.setAttribute("type", "text");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("placeholder", "add a step…");
    on(input, "keydown", function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      st.lanes[lane].push(row(text));
      draw();
    });
    line.appendChild(input);
    return line;
  }

  // --- the researcher / lab modal -------------------------------------------

  function drawModal() {
    var p = st.profile;
    var overlay = el("div", "overlay");
    on(overlay, "click", function (event) {
      if (event.target === overlay) closeModal();
    });
    var modal = el("div", "modal");
    var close = el("button", "modal-close", "×");
    on(close, "click", closeModal);
    modal.appendChild(close);

    modal.appendChild(el("div", "modal-av", initials(p.name)));
    modal.appendChild(el("div", "modal-name", p.name));
    if (p.role) modal.appendChild(el("div", "modal-role", p.role));
    if (p.lab) modal.appendChild(el("div", "modal-lab", p.lab));

    if (p.bio) {
      var s1 = el("div", "modal-sec");
      s1.appendChild(el("div", "modal-cap", "About"));
      s1.appendChild(el("div", "modal-bio", p.bio));
      modal.appendChild(s1);
    }
    if (p.why) {
      var sw = el("div", "modal-sec");
      sw.appendChild(el("div", "modal-cap", "Why this person"));
      sw.appendChild(el("div", "modal-bio", p.why));
      modal.appendChild(sw);
    }
    if (p.interests && p.interests.length) {
      var s2 = el("div", "modal-sec");
      s2.appendChild(el("div", "modal-cap", "Interests"));
      s2.appendChild(el("div", "modal-interests", p.interests.join(" · ")));
      if (p.interestsNote) s2.appendChild(el("div", "modal-lab", p.interestsNote));
      modal.appendChild(s2);
    } else if (p.interestsNote) {
      var s2b = el("div", "modal-sec");
      s2b.appendChild(el("div", "modal-cap", "Focus"));
      s2b.appendChild(el("div", "modal-lab", p.interestsNote));
      modal.appendChild(s2b);
    }
    if (p.works && p.works.length) {
      var s3 = el("div", "modal-sec");
      s3.appendChild(el("div", "modal-cap", p.worksLabel || "Selected work"));
      p.works.forEach(function (w) {
        var item = el("div", "modal-work");
        item.appendChild(el("div", "modal-work-t", w.title));
        if (w.description) item.appendChild(el("div", "modal-work-v", clip(w.description, 130)));
        s3.appendChild(item);
      });
      modal.appendChild(s3);
    }
    if (p.url) {
      var link = el("a", "modal-link", "Visit site");
      link.setAttribute("href", p.url);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      modal.appendChild(link);
    }

    overlay.appendChild(modal);
    app.appendChild(overlay);
  }

  // --- done: the install code -----------------------------------------------

  function command() {
    if (st.installKind === "curl") {
      return "curl -fsSL " + CURL_INSTALL + " | sh -s -- --code " + st.made.code;
    }
    return "npx engelbart-cli --code " + st.made.code;
  }

  function commandRow() {
    var cmd = command();
    var line = el("div", "cmd");
    line.appendChild(el("span", "cmd-text", cmd));
    var copy = el("button", "cmd-copy", "copy");
    on(copy, "click", function () {
      var done = function () {
        copy.textContent = "copied";
        setTimeout(function () { copy.textContent = "copy"; }, 1400);
      };
      var fallback = function () {
        var probe = document.createElement("textarea");
        probe.value = cmd;
        document.body.appendChild(probe);
        probe.select();
        try { document.execCommand("copy"); done(); }
        catch (e2) { copy.textContent = "select it"; }
        document.body.removeChild(probe);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(cmd).then(done, fallback);
        } else fallback();
      } catch (e) { fallback(); }
    });
    line.appendChild(copy);
    return line;
  }

  function drawDone() {
    var wrap = el("div", "wrap");
    var done = el("div", "done");

    var heroBox = el("div", "done-hero");
    heroBox.appendChild(el("div", "done-word", "Ready."));
    heroBox.appendChild(el("div", "done-note",
      "“" + str(st.made.name) + "” is saved to your account."));
    done.appendChild(heroBox);

    var card = el("div", "card");
    var head = el("div", "card-head");
    head.appendChild(el("div", "cap cap-l", "Install it"));
    head.appendChild(el("div", "card-rule"));
    card.appendChild(head);
    var body = el("div", "card-body");
    body.appendChild(el("div", "card-lede",
      "Run this in a terminal on the machine you build on. It installs"
      + " Engelbart, connects this account, and opens your project — no"
      + " second sign-in."));
    body.appendChild(commandRow());

    var seg = el("div", "seg-row");
    ["curl", "npx"].forEach(function (kind) {
      var b = el("button", "seg " + (st.installKind === kind ? "on" : "off"), kind);
      on(b, "click", function () { st.installKind = kind; draw(); });
      seg.appendChild(b);
    });
    body.appendChild(seg);

    // What each install command needs, so the reader knows why to pick one.
    // curl is a self-contained binary (nothing preinstalled); npx needs Node.
    var mins = Math.round((st.made.expiresInSeconds || 900) / 60);
    var note = st.installKind === "curl"
      ? "No Node, npm, or Python needed."
      : "Uses Node, which you already have if you run npx.";
    body.appendChild(el("div", "step-t",
      note + " The code works once and expires in " + mins
      + (mins === 1 ? " minute." : " minutes.")));

    var acts = el("div", "actions");
    acts.appendChild(btn("Get a new code", "btn-ghost", function () {
      issueCode().then(function (issued) {
        st.made.code = issued.code;
        st.made.expiresInSeconds = issued.expiresInSeconds;
        draw();
      }).catch(function (error) { st.error = error.message; draw(); });
    }));
    acts.appendChild(btn("Explore another", "btn-ghost", restart));
    body.appendChild(acts);
    if (st.error) body.appendChild(el("div", "err", st.error));
    card.appendChild(body);
    done.appendChild(card);

    var next = el("div", "card");
    var nhead = el("div", "card-head");
    nhead.appendChild(el("div", "cap cap-l", "Then, on your machine"));
    nhead.appendChild(el("div", "card-rule"));
    next.appendChild(nhead);
    var nbody = el("div", "card-body");
    stepNode(nbody, "1", "Run the command above. Engelbart installs and connects this account.");
    stepNode(nbody, "2", "Your project opens in the local workspace — its path already there.");
    next.appendChild(nbody);
    done.appendChild(next);

    wrap.appendChild(done);
    app.appendChild(wrap);
  }

  function stepNode(parent, n, text) {
    var line = el("div", "step");
    line.appendChild(el("div", "step-n", n));
    line.appendChild(el("div", "step-t", text));
    parent.appendChild(line);
  }

  // Focus a freshly-drawn field only if nothing else is focused, so a redraw
  // never steals the caret mid-type.
  function focusInto(node) {
    if (document.activeElement === document.body) {
      try { node.focus(); } catch (e) { /* not focusable yet */ }
    }
  }

  try {
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
    }
  } catch (e) { /* an old browser keeps the theme it opened with */ }

  // --- boot -----------------------------------------------------------------

  function enter(next) {
    session = next;
    if (!session) {
      st.screen = "signin";
      draw();
      return;
    }
    if (st.screen === "loading" || st.screen === "signin") {
      st.screen = "flow";
      st.phase = "interest";
    }
    draw();
  }

  function boot() {
    draw();
    fetch("/api/engelbart-config", { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("configuration unavailable");
        return r.json();
      })
      .then(function (config) {
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
        st.screen = "loading";
        st.error = "Engelbart setup is not available on this deployment yet.";
        draw();
      });
  }

  boot();
  window.__engelbartSetup = { state: function () { return st; }, draw: draw };
})();
