// Flattened by hand from the Claude Design project "Mathetic Demo.dc.html".
// The design-canvas runtime (support.js, React) is not shipped: the <x-dc>
// template became markup in index.html, and the DCLogic component became the
// state machine below. To change copy or behaviour, edit here — or re-export
// from the design and re-flatten, the same way the homepage was built.
(function runEngelbartDemo() {
  "use strict";

  var ORDER = ["todo", "doing", "done"];

  var BASE_GOALS = [
    { id: "core", label: "Build a PWR core simulator", indent: 0, status: "doing",
      notes: "# Objective\nA driveable PWR core: point kinetics with temperature feedback, control rods with real consequences, and a live dashboard.\n\n# Decisions\nAgents write all the code. I review physics and feel, not diffs.\n\n# Open questions\nHow greedy can a visitor get before it melts down?",
      sources: [], prompts: [],
      todos: [ { text: "Point kinetics that passes textbook transients", done: true }, { text: "Temperature feedback with real consequences", done: true }, { text: "A dashboard a visitor can drive without a manual", done: false } ] },
    { id: "kinetics", label: "Point kinetics solver", indent: 1, status: "done",
      notes: "# In my words\nSix delayed-neutron groups are what make a reactor steerable instead of a bomb. The prompt jump is instant; the tail is what you actually drive.",
      sources: ["kinetics.py"], prompts: [],
      todos: [ { text: "Six delayed groups, not one", done: true }, { text: "Match a textbook step transient", done: true } ] },
    { id: "feedback", label: "Temperature feedback", indent: 1, status: "done",
      notes: "# In my words\nHotter fuel absorbs more neutrons, so power pushes back on itself. Negative feedback is the whole reason this is safe to hand a visitor.",
      sources: ["thermal.py"], prompts: [],
      todos: [ { text: "Doppler coefficient on fuel temperature", done: true }, { text: "Moderator feedback on coolant", done: true } ] },
    { id: "rods", label: "Control rod dynamics", indent: 1, status: "doing",
      notes: "# Objective\nSee how a 10\u00a2 reactivity insertion moves power over 60 s \u2014 and make over-pulling the rods end badly.",
      sources: ["rods.py"], prompts: [],
      todos: [ { text: "S-curve rod worth, not linear", done: true }, { text: "Rod speed limits", done: true }, { text: "Make a greedy pull actually scram", done: false }, { text: "Compare a 10\u00a2 and a 50\u00a2 insertion", done: false } ] },
    { id: "dashboard", label: "Live dashboard", indent: 1, status: "todo",
      notes: "# Objective\nPower, temperature, and reactivity on one screen at 60 fps, driveable with the rods.",
      sources: [], prompts: [],
      todos: [ { text: "Power and temperature traces", done: true }, { text: "Draggable rod control", done: false }, { text: "Scram button that means it", done: false } ] }
  ];

  // The rail in the recording is three named agents working at once, each with
  // its own log. A single run line could not show that they are parallel.
  var BASE_AGENTS = [
    { id: "agent-1", task: "rods & feedback", state: "idle", lines: [] },
    { id: "agent-2", task: "dashboard", state: "idle", lines: [] },
    { id: "agent-3", task: "scenarios", state: "idle", lines: [] }
  ];

  var UNDERSTANDING = "What this project is really about:\n\n"
    + "A reactor is a chain reaction you are allowed to steer. Every term in the model either adds reactivity or takes it away, and the delayed neutrons are what give you time to act.\n\n"
    + "Open: how greedy can a visitor get before it melts down?";

  // ---------------------------------------------------------------- act one
  // What Engelbart asks before a project exists. The copy is the recording's.
  var PITCH_MS = 2900;

  var PITCH = "An interactive nuclear reactor simulation \u2014 pull the control rods, "
    + "watch power and temperature fight back, melt it down if I get greedy. "
    + "Agents build it; I steer the physics.";

  var PHYSICS = [
    "Point kinetics \u2014 fast, qualitatively right, runs in a browser",
    "Full thermal-hydraulics \u2014 research-grade, slow"
  ];

  var BUILD_FIRST = [
    "The core solver (kinetics + feedback)",
    "The live dashboard (power, temp, reactivity)",
    "Scenario library (SCRAM, xenon pit, load-follow)"
  ];

  var READBACK = [
    "A driveable PWR core: point kinetics with temperature feedback, control rods with real consequences, and a live dashboard.",
    "Agents write all the code. You review physics and feel, not diffs."
  ];

  var UNSURE = "which reactor type first \u00b7 how the agents prove the physics \u00b7 who it's for";

  var SUBGOALS = [
    "Point kinetics solver that passes textbook transients",
    "Temperature feedback and rods with real consequences",
    "A live dashboard a visitor can drive without a manual"
  ];

  var AGENT_TODOS = [
    "Scaffold repo: solver module, dashboard shell, test harness",
    "Point-kinetics ODEs, 6 delayed groups, tests vs textbook transients",
    "Fuel/coolant feedback with Doppler coefficient",
    "Rod worth curve + rate limit; meltdown past threshold",
    "Live dashboard: power, temps, reactivity at 60 fps"
  ];

  var STATUS_LABEL = { todo: "active", doing: "in progress", done: "done" };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function byId(id) { return document.getElementById(id); }

  var panel = byId("demo");
  if (!panel) return;

  var el = {
    stageIntake: byId("dm-stage-intake"),
    stageApp: byId("dm-stage-app"),
    intakeScroll: byId("dm-intake-scroll"),
    filters: byId("dm-filters"),
    count: byId("dm-count"),
    goals: byId("dm-goals"),
    goalForm: byId("dm-goal-form"),
    goalInput: byId("dm-goal-input"),
    goalTitle: byId("dm-goal-title"),
    chip: byId("dm-chip"),
    sources: byId("dm-sources"),
    addSource: byId("dm-add-source"),
    notes: byId("dm-notes"),
    addPrompt: byId("dm-add-prompt"),
    prompts: byId("dm-prompts"),
    railTitle: byId("dm-rail-title"),
    railChip: byId("dm-rail-chip"),
    progress: byId("dm-progress"),
    todosView: byId("dm-todos-view"),
    todos: byId("dm-todos"),
    todoForm: byId("dm-todo-form"),
    todoInput: byId("dm-todo-input"),
    understandingView: byId("dm-understanding-view"),
    agents: byId("dm-agents"),
    copyNote: byId("dm-copy-note"),
    toast: byId("dm-toast"),
    copyCmd: byId("copy-cmd"),
    copyCmdIcon: byId("copy-cmd-icon"),
  };

  var state = {
    stage: "intake",
    // One monotonically rising cursor drives act one: every card decides for
    // itself how much of it has arrived yet.
    beat: 0,
    typed: 0,
    filter: "all",
    rail: "todos",
    selected: "rods",
    toast: false,
    agents: clone(BASE_AGENTS),
    goals: clone(BASE_GOALS),
  };

  function active() {
    var found = null;
    state.goals.forEach(function (g) { if (g.id === state.selected) found = g; });
    return found || state.goals[0];
  }

  function patch(id, fn) {
    state.goals = state.goals.map(function (g) { return g.id === id ? fn(g) : g; });
  }

  function assign(target, extra) {
    var copy = {};
    Object.keys(target).forEach(function (k) { copy[k] = target[k]; });
    Object.keys(extra).forEach(function (k) { copy[k] = extra[k]; });
    return copy;
  }

  // ---------------------------------------------------------------- rendering

  var FILTERS = [
    { key: "all", label: "All" },
    { key: "todo", label: "Active" },
    { key: "doing", label: "In progress" },
    { key: "done", label: "Done" },
  ];

  function renderFilters() {
    el.filters.replaceChildren();
    FILTERS.forEach(function (f) {
      var n = f.key === "all"
        ? state.goals.length
        : state.goals.filter(function (g) { return g.status === f.key; }).length;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "dm-filter" + (state.filter === f.key ? " on" : "");
      button.textContent = f.label + " " + n;
      button.addEventListener("click", function () { stopPlay(); state.filter = f.key; render(); });
      el.filters.appendChild(button);
    });
  }

  function visibleGoals() {
    return state.goals.filter(function (g) {
      return state.filter === "all" || g.status === state.filter;
    });
  }

  function renderGoals() {
    var visible = visibleGoals();
    el.count.textContent = String(visible.length);
    el.goals.replaceChildren();
    visible.forEach(function (g) {
      var row = document.createElement("div");
      row.className = "dm-goal" + (g.id === state.selected ? " on" : "");
      row.style.marginLeft = g.indent * 20 + "px";

      var mark = document.createElement("button");
      mark.type = "button";
      mark.className = "dm-goal-mark is-" + g.status;
      mark.textContent = g.status === "done" ? "✓" : "";
      mark.setAttribute("aria-label", "Cycle status of " + g.label);
      mark.addEventListener("click", function () {
        stopPlay();
        patch(g.id, function (x) {
          return assign(x, { status: ORDER[(ORDER.indexOf(x.status) + 1) % ORDER.length] });
        });
        render();
      });

      var label = document.createElement("button");
      label.type = "button";
      label.className = "dm-goal-label is-" + g.status;
      label.textContent = g.label;
      label.addEventListener("click", function () { stopPlay(); state.selected = g.id; render(); });

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dm-goal-del";
      remove.innerHTML = "&times;";
      remove.setAttribute("aria-label", "Delete " + g.label);
      remove.addEventListener("click", function () {
        stopPlay();
        state.goals = state.goals.filter(function (x) { return x.id !== g.id; });
        if (state.selected === g.id && state.goals.length) state.selected = state.goals[0].id;
        render();
      });

      row.append(mark, label, remove);
      el.goals.appendChild(row);
    });
  }

  function renderChip(node, goal) {
    node.textContent = STATUS_LABEL[goal.status];
    node.className = "dm-chip" + (goal.status === "done" ? " done" : "");
  }

  function renderDetail() {
    var goal = active();
    el.goalTitle.textContent = goal.label;
    el.railTitle.textContent = goal.label;
    renderChip(el.chip, goal);
    renderChip(el.railChip, goal);

    el.sources.replaceChildren();
    (goal.sources || []).forEach(function (name) {
      var span = document.createElement("span");
      span.className = "dm-source";
      span.textContent = name;
      el.sources.appendChild(span);
    });

    // Never clobber the caret while a visitor is typing their own notes.
    if (document.activeElement !== el.notes) el.notes.value = goal.notes;

    el.prompts.replaceChildren();
    var prompts = goal.prompts || [];
    if (!prompts.length) {
      var empty = document.createElement("div");
      empty.className = "dm-prompt-empty";
      empty.textContent = "No prompts tied to this goal yet.";
      el.prompts.appendChild(empty);
    }
    prompts.forEach(function (text) {
      var card = document.createElement("div");
      card.className = "dm-prompt";
      var head = document.createElement("div");
      head.className = "dm-prompt-head";
      var when = document.createElement("span");
      when.textContent = "Aug 24, 2026";
      var how = document.createElement("span");
      how.className = "dm-prompt-tag";
      how.textContent = "automatic";
      head.append(when, how);
      card.append(head, document.createTextNode(text));
      el.prompts.appendChild(card);
    });
  }

  function renderRail() {
    var goal = active();
    var todos = goal.todos || [];
    var showTodos = state.rail === "todos";

    el.todosView.classList.toggle("hidden", !showTodos);
    el.understandingView.classList.toggle("hidden", showTodos);
    el.understandingView.textContent = UNDERSTANDING;
    el.progress.textContent = todos.length
      ? todos.filter(function (t) { return t.done; }).length + "/" + todos.length
      : "";

    Array.prototype.forEach.call(document.querySelectorAll(".dm-rail-tab"), function (tab) {
      tab.classList.toggle("on", tab.dataset.rail === state.rail);
    });

    el.todos.replaceChildren();
    todos.forEach(function (t, i) {
      var row = document.createElement("div");
      row.className = "dm-todo";
      var dash = document.createElement("span");
      dash.className = "dm-todo-dash";
      dash.innerHTML = "&ndash;";
      var text = document.createElement("button");
      text.type = "button";
      text.className = "dm-todo-text" + (t.done ? " done" : "");
      text.textContent = t.text;
      text.addEventListener("click", function () {
        stopPlay();
        patch(goal.id, function (g) {
          return assign(g, {
            todos: g.todos.map(function (x, j) { return j === i ? assign(x, { done: !x.done }) : x; }),
          });
        });
        render();
      });
      var tag = document.createElement("span");
      tag.className = "dm-todo-tag" + (t.done ? " on" : "");
      tag.textContent = "done";
      row.append(dash, text, tag);
      el.todos.appendChild(row);
    });

    el.agents.replaceChildren();
    state.agents.forEach(function (agent) {
      var card = document.createElement("div");
      card.className = "dm-agent";

      var head = document.createElement("div");
      head.className = "dm-agent-head";
      var dot = document.createElement("span");
      dot.className = "dm-agent-dot is-" + agent.state;
      var name = document.createElement("span");
      name.className = "dm-agent-name";
      name.textContent = agent.id;
      var sep = document.createElement("span");
      sep.className = "dm-agent-sep";
      sep.textContent = "\u00b7";
      var task = document.createElement("span");
      task.className = "dm-agent-task";
      task.textContent = agent.task;
      var spacer = document.createElement("span");
      spacer.className = "dm-spacer";
      var badge = document.createElement("span");
      badge.className = "dm-agent-state is-" + agent.state;
      badge.textContent = agent.state === "running" ? "RUNNING"
        : agent.state === "done" ? "DONE" : "IDLE";
      head.append(dot, name, sep, task, spacer, badge);

      var log = document.createElement("div");
      log.className = "dm-agent-log";
      agent.lines.forEach(function (text) {
        var line = document.createElement("div");
        line.className = "dm-run-line";
        line.textContent = text;
        log.appendChild(line);
      });

      card.append(head, log);
      el.agents.appendChild(card);
    });
  }

  // ---------------------------------------------------- act one: the intake

  function elem(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function card(eyebrow, meta) {
    var box = elem("div", "dm-card");
    if (eyebrow || meta) {
      var head = elem("div", "dm-card-head");
      head.append(elem("span", "dm-eyebrow", eyebrow || ""));
      head.append(elem("span", "dm-spacer"));
      if (meta) head.append(elem("span", "dm-card-meta", meta));
      box.appendChild(head);
    }
    return box;
  }

  // A choice the visitor already made: filled when chosen, greyed when passed
  // over. Nothing here is interactive - it is a replay, not a form.
  function choice(label, kind, picked, dimmed) {
    var row = elem("div", "dm-choice" + (picked ? " is-picked" : "") + (dimmed ? " is-dim" : ""));
    row.append(elem("span", "dm-choice-mark is-" + kind + (picked ? " is-on" : "")));
    row.append(elem("span", "dm-choice-label", label));
    return row;
  }

  function pill(label, solid) {
    return elem("span", "dm-pill" + (solid ? " is-solid" : ""), label);
  }

  function renderIntake() {
    var b = state.beat;
    var scroll = el.intakeScroll;
    scroll.replaceChildren();

    // 1. new work, or work you already have
    if (b >= 1) {
      var one = card();
      one.appendChild(elem("h3", "dm-ask", "Is this new work, or work you already have?"));
      var row = elem("div", "dm-pill-row");
      row.append(pill(b >= 2 ? "START A NEW PROJECT \u2713" : "START A NEW PROJECT", b >= 2));
      row.append(pill("RESUME AN EXISTING ONE"));
      one.appendChild(row);
      scroll.appendChild(one);
    }

    // 2. describe it, and the answer typing itself in
    if (b >= 3) {
      var two = card("DESCRIBE THE PROJECT");
      two.appendChild(elem("h3", "dm-ask", "Tell me what you're trying to make happen."));
      scroll.appendChild(two);
    }
    if (b >= 4) {
      var said = elem("div", "dm-said");
      said.appendChild(elem("span", "dm-eyebrow dm-said-eyebrow", "YOU"));
      var line = elem("p", "dm-said-text", PITCH.slice(0, state.typed));
      if (state.typed < PITCH.length) line.appendChild(elem("span", "dm-caret"));
      said.appendChild(line);
      scroll.appendChild(said);
    }

    // 3. scope check
    if (b >= 5) {
      var answered = (b >= 6 ? 1 : 0) + (b >= 7 ? 1 : 0);
      var three = card("SCOPE CHECK", "ANSWERED \u00b7 " + answered + " OF 2");
      three.appendChild(elem("h3", "dm-ask", "How real does the physics need to be?"));
      three.appendChild(elem("div", "dm-eyebrow dm-sub", "PICK ONE"));
      three.appendChild(choice(PHYSICS[0], "radio", b >= 6, false));
      three.appendChild(choice(PHYSICS[1], "radio", false, b >= 6));

      if (b >= 6) {
        three.appendChild(elem("h3", "dm-ask dm-ask-next", "What should the agents build first?"));
        three.appendChild(elem("div", "dm-eyebrow dm-sub", "SELECT ALL THAT APPLY"));
        three.appendChild(choice(BUILD_FIRST[0], "check", b >= 7, false));
        three.appendChild(choice(BUILD_FIRST[1], "check", b >= 7, false));
        three.appendChild(choice(BUILD_FIRST[2], "check", false, b >= 7));
      }
      scroll.appendChild(three);
    }

    // 4. Engelbart says the project back, including what it is unsure of
    if (b >= 8) {
      var four = card("READING YOU BACK");
      four.appendChild(elem("h3", "dm-ask", "Here's what I think you're working on"));
      READBACK.forEach(function (text) { four.appendChild(elem("p", "dm-readback", text)); });
      if (b >= 9) {
        var unsure = elem("div", "dm-unsure");
        unsure.appendChild(elem("em", "dm-unsure-head", "I'm less sure about:"));
        unsure.appendChild(elem("div", "dm-unsure-body", UNSURE));
        four.appendChild(unsure);
      }
      if (b >= 9) {
        var acts = elem("div", "dm-pill-row dm-pill-row-end");
        acts.append(pill("EDIT"), pill("ADD SOMETHING"), pill(b >= 10 ? "CONTINUE \u2713" : "CONTINUE", b >= 10));
        four.appendChild(acts);
      }
      scroll.appendChild(four);
    }

    // 5. the goal tree those answers became
    if (b >= 11) {
      var shown = Math.max(0, Math.min(SUBGOALS.length, b - 11));
      var five = card("GOALS", "1 GOAL \u00b7 " + shown + " SUBGOALS");
      var top = elem("div", "dm-tree-top");
      top.append(elem("span", "dm-choice-mark is-radio"));
      top.append(elem("span", null, "An interactive PWR core simulator, built by agents in a week"));
      five.appendChild(top);
      SUBGOALS.slice(0, shown).forEach(function (text) {
        var sub = elem("div", "dm-tree-sub");
        sub.append(elem("span", "dm-choice-mark is-radio"));
        sub.append(elem("span", null, text));
        five.appendChild(sub);
      });
      if (shown === SUBGOALS.length) {
        var foot = elem("div", "dm-pill-row");
        foot.append(pill(b >= 15 ? "GENERATE TODOS \u2713" : "GENERATE TODOS", b >= 15));
        foot.append(elem("em", "dm-note", "Edited one subgoal."));
        five.appendChild(foot);
      }
      scroll.appendChild(five);
    }

    // 6. the work handed to the agents, named, and accepted
    if (b >= 16) {
      var rows = Math.max(0, Math.min(AGENT_TODOS.length, b - 16));
      var six = card("TODOS \u00b7 FOR AGENTS", rows + " TASKS");
      six.appendChild(elem("em", "dm-note dm-note-block", "Each row runs unattended. You review results, not code."));
      AGENT_TODOS.slice(0, rows).forEach(function (text) {
        var task = elem("div", "dm-task");
        task.append(elem("span", "dm-task-dash", "\u2013"));
        task.append(elem("span", null, text));
        six.appendChild(task);
      });
      if (rows === AGENT_TODOS.length) {
        var name = elem("div", "dm-name-row");
        name.append(elem("span", "dm-eyebrow", "CALL IT"));
        name.append(elem("span", "dm-name", "nuclear-sim"));
        name.append(elem("span", "dm-spacer"));
        name.append(pill(b >= 22 ? "ACCEPT TODOS \u2713" : "ACCEPT TODOS", b >= 22));
        six.appendChild(name);
      }
      scroll.appendChild(six);
    }

    // The recording scrolls to keep the newest card in frame; so does this.
    var over = scroll.scrollHeight - el.stageIntake.clientHeight;
    scroll.style.transform = "translateY(" + (over > 0 ? -over : 0) + "px)";
  }

  function render() {
    el.stageIntake.classList.toggle("hidden", state.stage !== "intake");
    el.stageApp.classList.toggle("hidden", state.stage !== "app");
    if (state.stage === "intake") { renderIntake(); return; }
    renderFilters();
    renderGoals();
    renderDetail();
    renderRail();
  }

  // ------------------------------------------------- the looping demo script

  var steps = null;
  var timer = null;
  var playing = false;
  var stopped = false;

  function buildSteps() {
    var S = [];
    function push(d, fn, paint, async) { S.push({ d: d, fn: fn, paint: paint, async: async }); }
    function select(id) { state.selected = id; state.rail = "todos"; }
    function tick(id, i) {
      patch(id, function (g) {
        return assign(g, { todos: g.todos.map(function (t, j) { return j === i ? assign(t, { done: true }) : t; }) });
      });
    }
    function status(id, st) { patch(id, function (g) { return assign(g, { status: st }); }); }
    function addTodo(id, text) {
      patch(id, function (g) { return assign(g, { todos: (g.todos || []).concat([{ text: text, done: false }]) }); });
    }
    // Agents are addressed by id, because the point of the rail is that three
    // of them are working at the same time.
    function agent(id, fn) {
      state.agents = state.agents.map(function (a) { return a.id === id ? fn(a) : a; });
    }
    function start(id) { agent(id, function (a) { return assign(a, { state: "running", lines: [] }); }); }
    function say(id, text) {
      agent(id, function (a) { return assign(a, { lines: a.lines.concat([text]).slice(-2) }); });
    }
    function finish(id) { agent(id, function (a) { return assign(a, { state: "done" }); }); }
    function type(id, text, ms) {
      push(320, function (done) {
        var g = null;
        state.goals.forEach(function (x) { if (x.id === id) g = x; });
        var base = g ? g.notes : "";
        var start = Date.now();
        (function frame() {
          if (stopped) return;
          var k = Math.min(1, (Date.now() - start) / ms);
          var next = base + text.slice(0, Math.round(text.length * k));
          patch(id, function (goal) { return assign(goal, { notes: next }); });
          if (state.selected === id && state.stage === "app") el.notes.value = next;
          else render();
          if (k < 1) setTimeout(frame, 16); else done();
        })();
      }, null, true);
    }

    // ---- act one: the intake, beat by beat --------------------------------
    function beat(n) { state.beat = n; }

    push(700, function () { state.stage = "intake"; beat(1); });
    push(900, function () { beat(2); });
    push(700, function () { beat(3); });
    push(600, function () { beat(4); state.typed = 0; });
    push(120, function (done) {
      var start = Date.now();
      (function frame() {
        if (stopped) return;
        var k = Math.min(1, (Date.now() - start) / PITCH_MS);
        state.typed = Math.round(PITCH.length * k);
        var line = el.intakeScroll.querySelector(".dm-said-text");
        if (line) {
          line.textContent = PITCH.slice(0, state.typed);
          if (k < 1) line.appendChild(elem("span", "dm-caret"));
        }
        if (k < 1) setTimeout(frame, 16); else done();
      })();
    }, null, true);
    push(900, function () { beat(5); });
    push(1000, function () { beat(6); });
    push(950, function () { beat(7); });
    push(1100, function () { beat(8); });
    push(1200, function () { beat(9); });
    push(1000, function () { beat(10); });
    push(900, function () { beat(11); });
    push(500, function () { beat(12); });
    push(450, function () { beat(13); });
    push(450, function () { beat(14); });
    push(900, function () { beat(15); });
    push(900, function () { beat(16); });
    push(420, function () { beat(17); });
    push(400, function () { beat(18); });
    push(400, function () { beat(19); });
    push(400, function () { beat(20); });
    push(400, function () { beat(21); });
    push(1000, function () { beat(22); });

    // ---- act two: the project those answers turned into --------------------
    push(900, function () { state.stage = "app"; });

    // 1. the rod goal is picked up, and all three agents take work at once
    push(900, function () { select("rods"); });
    push(700, function () { start("agent-1"); say("agent-1", "reading src/kinetics.py, src/rods.py"); });
    push(500, function () { start("agent-2"); say("agent-2", "scaffolded dashboard shell"); });
    push(500, function () { start("agent-3"); say("agent-3", "drafting SCRAM scenario"); });
    push(950, function () { say("agent-1", "added rod_worth() S-curve lookup"); });
    push(800, function () { say("agent-2", "wired power/temp traces at 60 fps"); });
    push(950, function () { say("agent-1", "a 50\u00a2 pull now scrams at 118% power"); tick("rods", 2); });
    push(850, function () { finish("agent-1"); say("agent-3", "xenon pit and load-follow queued"); });
    push(800, function () { say("agent-2", "rod slider drives the trace live"); tick("rods", 3); });
    push(700, function () { finish("agent-2"); finish("agent-3"); });

    // 2. you write down the physics you just learned, and close the goal
    type("rods", "\n\n# Answered\nOver-pulling scrams instead of melting. The delayed neutrons are what give you the seconds to react.", 2600);
    push(800, function () { status("rods", "done"); });

    // 3. the answer spawns the next subgoal, and the agents pick that up too
    push(1100, function () {
      state.goals = state.goals.slice(0, 4).concat(
        [{ id: "xenon", label: "Xenon poisoning after a scram", indent: 1, status: "doing", notes: "", sources: [], prompts: [], todos: [] }],
        state.goals.slice(4)
      );
      state.selected = "xenon";
      state.rail = "todos";
      state.agents = clone(BASE_AGENTS);
    });
    type("xenon", "# Objective\nSee why a reactor cannot simply be restarted an hour after a scram.", 1800);
    push(600, function () { addTodo("xenon", "Iodine and xenon decay chain"); });
    push(520, function () { addTodo("xenon", "Plot the pit over 48 h"); });
    push(520, function () { addTodo("xenon", "Block restart while poisoned"); });
    push(800, function () { start("agent-1"); say("agent-1", "added iodine-135 \u2192 xenon-135 chain"); });
    push(600, function () { start("agent-2"); say("agent-2", "plotting the 48 h pit"); });
    push(850, function () { say("agent-1", "restart blocked below 0 reactivity margin"); tick("xenon", 0); });
    push(800, function () { finish("agent-1"); tick("xenon", 1); });
    push(700, function () { finish("agent-2"); });

    // 4. move on, then reset and loop
    push(1400, function () { select("dashboard"); });
    push(900, function () { status("dashboard", "doing"); });
    push(1600, function () {
      state.goals = clone(BASE_GOALS);
      state.agents = clone(BASE_AGENTS);
      state.selected = "rods";
      state.rail = "todos";
      state.filter = "all";
      state.stage = "intake";
      state.beat = 0;
      state.typed = 0;
    });
    return S;
  }

  function play() {
    if (playing || stopped) return;
    playing = true;
    steps = buildSteps();
    var i = 0;
    (function next() {
      if (stopped) return;
      var step = steps[i % steps.length];
      i++;
      timer = setTimeout(function () {
        if (stopped) return;
        if (step.async) { step.fn(function () { if (!stopped) next(); }); return; }
        step.fn();
        if (step.paint) step.paint(); else render();
        next();
      }, step.d);
    })();
  }

  function stopPlay() {
    stopped = true;
    clearTimeout(timer);
  }

  // ------------------------------------------------------- direct interaction

  el.goalForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var label = el.goalInput.value.trim();
    if (!label) return;
    stopPlay();
    var id = "g" + state.goals.length + "-" + label.length;
    state.goals = state.goals.concat([{ id: id, label: label, indent: 0, status: "todo", notes: "# Objective\n", sources: [], prompts: [], todos: [] }]);
    state.selected = id;
    state.filter = "all";
    el.goalInput.value = "";
    render();
  });

  el.todoForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = el.todoInput.value.trim();
    if (!text) return;
    stopPlay();
    patch(active().id, function (g) { return assign(g, { todos: (g.todos || []).concat([{ text: text, done: false }]) }); });
    el.todoInput.value = "";
    render();
  });

  el.notes.addEventListener("input", function () {
    stopPlay();
    var value = el.notes.value;
    patch(active().id, function (g) { return assign(g, { notes: value }); });
  });

  el.addSource.addEventListener("click", function () {
    stopPlay();
    patch(active().id, function (g) { return assign(g, { sources: (g.sources || []).concat(["new-source"]) }); });
    render();
  });

  el.addPrompt.addEventListener("click", function () {
    stopPlay();
    patch(active().id, function (g) {
      return assign(g, { prompts: (g.prompts || []).concat(["Keep this goal's context in mind for the next change."]) });
    });
    render();
  });

  Array.prototype.forEach.call(document.querySelectorAll(".dm-rail-tab"), function (tab) {
    tab.addEventListener("click", function () { stopPlay(); state.rail = tab.dataset.rail; render(); });
  });

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:0;left:-9999px";
    document.body.appendChild(field);
    field.select();
    try { document.execCommand("copy"); } catch (_error) { /* clipboard unavailable */ }
    document.body.removeChild(field);
  }

  var toastTimer = null;
  el.copyNote.addEventListener("click", function () {
    var goal = active();
    copyText("# " + goal.label + "\n\n" + goal.notes);
    clearTimeout(toastTimer);
    el.toast.classList.add("on");
    toastTimer = setTimeout(function () { el.toast.classList.remove("on"); }, 1400);
  });

  var cmdTimer = null;
  if (el.copyCmd) {
    el.copyCmd.addEventListener("click", function () {
      copyText("npx engelbart-cli");
      clearTimeout(cmdTimer);
      el.copyCmdIcon.classList.add("copied");
      cmdTimer = setTimeout(function () { el.copyCmdIcon.classList.remove("copied"); }, 1600);
    });
  }

  // ------------------------------------------------------------------- start

  render();

  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still) {
    stopped = true;
  } else if (window.IntersectionObserver) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { if (entry.isIntersecting) play(); });
    }, { threshold: 0.3 });
    observer.observe(panel);
  } else {
    play();
  }
})();
