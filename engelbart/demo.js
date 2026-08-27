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

  var STATUS_LABEL = { todo: "active", doing: "in progress", done: "done" };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function byId(id) { return document.getElementById(id); }

  var panel = byId("demo");
  if (!panel) return;

  var el = {
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

  function render() {
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
    function push(d, fn) { S.push({ d: d, fn: fn }); }
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
    function type(id, text, per) {
      var base = "";
      push(320, function () {
        var g = null;
        state.goals.forEach(function (x) { if (x.id === id) g = x; });
        base = g ? g.notes : "";
      });
      for (var i = 1; i <= text.length; i++) {
        (function (n) {
          push(per, function () { patch(id, function (g) { return assign(g, { notes: base + text.slice(0, n) }); }); });
        })(i);
      }
    }

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
    type("rods", "\n\n# Answered\nOver-pulling scrams instead of melting. The delayed neutrons are what give you the seconds to react.", 22);
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
    type("xenon", "# Objective\nSee why a reactor cannot simply be restarted an hour after a scram.", 22);
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
        step.fn();
        render();
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
