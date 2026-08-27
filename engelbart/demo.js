// Flattened by hand from the Claude Design project "Mathetic Demo.dc.html".
// The design-canvas runtime (support.js, React) is not shipped: the <x-dc>
// template became markup in index.html, and the DCLogic component became the
// state machine below. To change copy or behaviour, edit here — or re-export
// from the design and re-flatten, the same way the homepage was built.
(function runEngelbartDemo() {
  "use strict";

  var ORDER = ["todo", "doing", "done"];

  var BASE_GOALS = [
    { id: "sim", label: "Build a rocket flight simulator", indent: 0, status: "doing",
      notes: "# Objective\nPredict apogee within 5% of the published flight data for a single-stage sounding rocket.\n\n# Decisions\n2D first. Point mass, then rotation once ascent is stable.\n\n# Open questions\nIs a flat-Earth approximation fine at 100 km?",
      sources: [], prompts: [],
      todos: [ { text: "Write the equations of motion by hand", done: true }, { text: "SI units everywhere, never convert", done: true }, { text: "Validate against a real flight profile", done: false } ] },
    { id: "thrust", label: "Thrust and mass flow", indent: 1, status: "done",
      notes: "# In my words\nThrust pushes, and the rocket gets lighter while it pushes. The second part is what makes it interesting.",
      sources: ["thrust_curve.csv"], prompts: [],
      todos: [ { text: "Load the thrust curve from CSV", done: true }, { text: "Deplete mass to burnout", done: true } ] },
    { id: "drag", label: "Atmospheric drag", indent: 1, status: "doing",
      notes: "# Objective\nDrag that changes with altitude, not a constant.\n\n# In my words\nAir thins as you climb, so the same speed costs less drag up high.\n\n# Open questions\nDoes Cd need to vary with Mach here?",
      sources: ["1976 std atmosphere"],
      prompts: ["Sanity-check my drag term's units before I trust the plot — Cd is coming out dimensionless but apogee is 12% high."],
      todos: [ { text: "Exponential density model", done: true }, { text: "Drag opposes velocity, not just -y", done: true }, { text: "Try Mach-dependent Cd", done: false }, { text: "Compare both models at apogee", done: false } ] },
    { id: "integrator", label: "Integrator: Euler vs RK4", indent: 1, status: "todo",
      notes: "# Objective\nStop the trajectory drifting at large timesteps.\n\n# Open questions\nIs RK4 overkill if I just shrink dt?",
      sources: [], prompts: [],
      todos: [ { text: "Euler baseline working", done: true }, { text: "Implement RK4", done: false }, { text: "Plot apogee vs dt for both", done: false } ] },
    { id: "viz", label: "Visualize the trajectory", indent: 0, status: "doing",
      notes: "# Objective\nSee the arc, burnout, and apogee in one frame.",
      sources: [], prompts: [],
      todos: [ { text: "Altitude vs downrange plot", done: true }, { text: "Mark burnout on the arc", done: false } ] }
  ];

  var UNDERSTANDING = "What this project is really about:\n\n"
    + "A rocket is a mass that throws part of itself away. Every force in the model is either pushing it, slowing it, or pulling it down.\n\n"
    + "Open: does Cd need Mach?";

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
    runDot: byId("dm-run-dot"),
    runStatus: byId("dm-run-status"),
    runLines: byId("dm-run-lines"),
    copyNote: byId("dm-copy-note"),
    toast: byId("dm-toast"),
    copyCmd: byId("copy-cmd"),
    copyCmdIcon: byId("copy-cmd-icon"),
  };

  var state = {
    filter: "all",
    rail: "todos",
    selected: "drag",
    toast: false,
    run: { status: "idle", label: "no run yet", lines: [] },
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

    el.runStatus.textContent = state.run.label;
    el.runDot.className = "dm-run-dot is-" + state.run.status;
    el.runLines.replaceChildren();
    state.run.lines.forEach(function (text) {
      var line = document.createElement("div");
      line.className = "dm-run-line";
      line.textContent = text;
      el.runLines.appendChild(line);
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
    function run(st, label) { state.run = assign(state.run, { status: st, label: label }); }
    function logLine(text) { state.run = assign(state.run, { lines: state.run.lines.concat([text]).slice(-4) }); }
    function clearLog() { state.run = assign(state.run, { lines: [] }); }
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

    // 1. pick up the drag goal, hand its TODOs to the agent
    push(900, function () { select("drag"); });
    push(1000, function () { clearLog(); run("building", "building · 0m in"); });
    push(900, function () { logLine("reading src/atmosphere.py, src/forces.py"); });
    push(1100, function () { logLine("added mach_cd() table lookup"); });
    push(900, function () { run("building", "building · 2m in"); });
    push(1000, function () { logLine("re-ran ascent: apogee 102.4 km (was 114.8)"); tick("drag", 2); });
    push(1000, function () { logLine("done · 2 TODOs closed"); tick("drag", 3); });
    push(700, function () { run("finished", "finished · 2m in · 41k tok"); });

    // 2. write down what you learned, close the goal
    type("drag", "\n\n# Answered\nMach matters above ~0.8, so Cd varies with Mach now.", 24);
    push(800, function () { status("drag", "done"); });

    // 3. the answer spawns a new subgoal, then a build for it
    push(1100, function () {
      state.goals = state.goals.slice(0, 3).concat(
        [{ id: "wind", label: "Model wind shear on ascent", indent: 1, status: "doing", notes: "", sources: [], prompts: [], todos: [] }],
        state.goals.slice(3)
      );
      state.selected = "wind";
      state.rail = "todos";
    });
    type("wind", "# Objective\nSee how a 20 m/s crosswind at 3 km moves the impact point.", 24);
    push(650, function () { addTodo("wind", "Add a horizontal wind term"); });
    push(550, function () { addTodo("wind", "Sweep 0-30 m/s"); });
    push(550, function () { addTodo("wind", "Plot impact dispersion"); });
    push(900, function () { clearLog(); run("building", "building · 0m in"); });
    push(950, function () { logLine("wind term added to forces.py"); });
    push(950, function () { logLine("swept 7 wind speeds"); tick("wind", 0); });
    push(900, function () { logLine("dispersion plot written to out/"); tick("wind", 1); });
    push(800, function () { run("finished", "finished · 1m in · 18k tok"); });

    // 4. move on, then reset and loop
    push(1400, function () { select("integrator"); });
    push(900, function () { status("integrator", "doing"); });
    push(1600, function () {
      state.goals = clone(BASE_GOALS);
      state.selected = "drag";
      state.rail = "todos";
      state.filter = "all";
      state.run = { status: "idle", label: "no run yet", lines: [] };
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
