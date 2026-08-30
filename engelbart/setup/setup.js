(function runEngelbartWebSetup() {
  "use strict";

  // The web half of the setup conversation. The card contract is the one in
  // hc's setup_chat (source of truth); this page only draws what the server
  // has already normalized, keeps the transcript, and writes nothing until
  // the reader approves the todos card. State is mirrored to sessionStorage
  // so a refresh does not eat the conversation.

  var OPENING = "Tell me what you're working on in your own words. I'll ask a"
    + " few questions, then write up a plan for you to approve.";
  var SKIPPED = "skip -- decide for me";
  var STORE_KEY = "engelbart-web-setup-v1";
  var ORDER = ["questions", "plan", "goals", "todos"];

  var client = null;
  var session = null;

  var state = {
    transcript: [{ role: "engelbart", text: OPENING }],
    shown: [],
    plan: null,        // the plan card, as offered
    goals: null,       // the goals card, as offered
    chosen: "",        // the goal label the reader picked
    card: null,        // the card on screen, normalized by the server
    thinking: false,
  };

  var el = {
    loading: document.getElementById("loading-panel"),
    signin: document.getElementById("signin-panel"),
    chat: document.getElementById("chat-panel"),
    done: document.getElementById("done-panel"),
    log: document.getElementById("chat-log"),
    cardSlot: document.getElementById("card-slot"),
    sayForm: document.getElementById("say-form"),
    sayInput: document.getElementById("say-input"),
    saySend: document.getElementById("say-send"),
    status: document.getElementById("chat-status"),
    navSession: document.getElementById("nav-session"),
    sessionEmail: document.getElementById("session-email"),
    signOut: document.getElementById("sign-out"),
    installCmd: document.getElementById("install-cmd"),
    copyCmd: document.getElementById("copy-cmd"),
    newCode: document.getElementById("new-code"),
    doneStatus: document.getElementById("done-status"),
    codeNote: document.getElementById("code-note"),
  };

  function setStatus(message, kind) {
    el.status.textContent = message || "";
    if (kind) el.status.dataset.kind = kind;
    else delete el.status.dataset.kind;
  }

  function show(panel) {
    [el.loading, el.signin, el.chat, el.done].forEach(function (node) {
      node.classList.toggle("hidden", node !== panel);
    });
  }

  function remember() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        transcript: state.transcript,
        shown: state.shown,
        plan: state.plan,
        goals: state.goals,
        chosen: state.chosen,
        card: state.card,
      }));
    } catch (_error) { /* private windows forget; the page still works */ }
  }

  function restore() {
    try {
      var held = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (!held || !Array.isArray(held.transcript) || !held.transcript.length) return;
      state.transcript = held.transcript;
      state.shown = Array.isArray(held.shown) ? held.shown : [];
      state.plan = held.plan || null;
      state.goals = held.goals || null;
      state.chosen = String(held.chosen || "");
      state.card = held.card || null;
    } catch (_error) { /* a torn record is a fresh start */ }
  }

  function forget() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (_error) { /* fine */ }
  }

  // --- drawing ---------------------------------------------------------------

  function text(node, value) {
    node.textContent = String(value == null ? "" : value);
    return node;
  }

  function make(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function drawLog() {
    el.log.textContent = "";
    state.transcript.forEach(function (turn) {
      var line = make("div", "setup-turn");
      line.dataset.role = turn.role === "you" ? "you" : "engelbart";
      var who = make("span", "setup-turn-who");
      text(who, turn.role === "you" ? "you" : "engelbart");
      var said = make("div", "setup-turn-text");
      text(said, turn.text);
      line.appendChild(who);
      line.appendChild(said);
      el.log.appendChild(line);
    });
    el.log.scrollTop = el.log.scrollHeight;
  }

  function answersAsSaid(questions, answers) {
    var said = [];
    (questions.items || []).forEach(function (item) {
      var got = answers[item.id];
      if (Array.isArray(got)) got = got.join(" · ");
      got = String(got == null ? "" : got).replace(/\s+/g, " ").trim();
      if (!got) return;
      said.push(item.title + ": " + got);
    });
    return said.length ? said.join("\n") : SKIPPED;
  }

  function drawQuestions(card) {
    var box = make("div", "setup-card");
    var eyebrow = make("p", "setup-eyebrow");
    text(eyebrow, card.questions.eyebrow || "a few questions");
    box.appendChild(eyebrow);
    var form = make("form", "stack");
    card.questions.items.forEach(function (item) {
      var field = make("div", "field");
      var title = make("label");
      text(title, item.title);
      field.appendChild(title);
      if (item.subtitle) {
        field.appendChild(text(make("p", "setup-note"), item.subtitle));
      }
      if (item.type === "mcq" || item.type === "select_all") {
        item.options.forEach(function (option, index) {
          var row = make("label", "setup-option");
          var input = make("input");
          input.type = item.type === "mcq" ? "radio" : "checkbox";
          input.name = item.id;
          input.value = option.label;
          input.dataset.qid = item.id;
          row.appendChild(input);
          var words = make("span");
          text(words, option.why ? option.label + " — " + option.why : option.label);
          row.appendChild(words);
          field.appendChild(row);
          if (index >= 7) return;
        });
      } else {
        var input = make(item.type === "open" ? "textarea" : "input");
        if (item.type === "open") input.rows = 3;
        input.placeholder = item.placeholder || "";
        input.dataset.qid = item.id;
        field.appendChild(input);
      }
      form.appendChild(field);
    });
    var row = make("div", "button-row");
    var go = make("button", "button");
    go.type = "submit";
    text(go, "Continue");
    row.appendChild(go);
    form.appendChild(row);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var answers = {};
      card.questions.items.forEach(function (item) {
        if (item.type === "select_all") {
          var picked = [];
          form.querySelectorAll("input[data-qid=\"" + item.id + "\"]:checked")
            .forEach(function (input) { picked.push(input.value); });
          answers[item.id] = picked;
        } else if (item.type === "mcq") {
          var hit = form.querySelector("input[data-qid=\"" + item.id + "\"]:checked");
          answers[item.id] = hit ? hit.value : "";
        } else {
          var box2 = form.querySelector("[data-qid=\"" + item.id + "\"]");
          answers[item.id] = box2 ? box2.value : "";
        }
      });
      say(answersAsSaid(card.questions, answers));
    });
    box.appendChild(form);
    return box;
  }

  function drawPlan(card) {
    var box = make("div", "setup-card");
    box.appendChild(text(make("p", "setup-eyebrow"), "the plan"));
    card.plan.description.split(/\n{2,}|\n/).forEach(function (para) {
      if (para.trim()) box.appendChild(text(make("p"), para));
    });
    if (card.plan.unsure.length) {
      box.appendChild(text(make("p", "setup-note"), "I'm less sure about:"));
      var list = make("ul", "setup-unsure");
      card.plan.unsure.forEach(function (row) {
        list.appendChild(text(make("li"), row));
      });
      box.appendChild(list);
    }
    var form = make("form", "stack");
    var note = make("input");
    note.placeholder = "Anything to correct? (optional)";
    form.appendChild(note);
    var row = make("div", "button-row");
    var go = make("button", "button");
    go.type = "submit";
    text(go, "Looks right — keep going");
    row.appendChild(go);
    form.appendChild(row);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var said = note.value.trim();
      say(said ? "The plan is mostly right. One thing: " + said
               : "The plan looks right.");
    });
    box.appendChild(form);
    return box;
  }

  function drawGoals(card) {
    var box = make("div", "setup-card");
    box.appendChild(text(make("p", "setup-eyebrow"), "pick one to start on"));
    var form = make("form", "stack");
    card.goals.forEach(function (goal, index) {
      var row = make("label", "setup-option");
      var input = make("input");
      input.type = "radio";
      input.name = "goal";
      input.value = goal.label;
      if (!index) input.checked = true;
      row.appendChild(input);
      var words = make("span");
      text(words, goal.why ? goal.label + " — " + goal.why : goal.label);
      row.appendChild(words);
      form.appendChild(row);
    });
    var row2 = make("div", "button-row");
    var go = make("button", "button");
    go.type = "submit";
    text(go, "Start with this one");
    row2.appendChild(go);
    form.appendChild(row2);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var hit = form.querySelector("input[name=goal]:checked");
      state.chosen = hit ? hit.value : (card.goals[0] ? card.goals[0].label : "");
      say("Start with: " + state.chosen);
    });
    box.appendChild(form);
    return box;
  }

  function drawTodos(card) {
    var box = make("div", "setup-card");
    box.appendChild(text(make("p", "setup-eyebrow"), "the first rows of work"));
    var form = make("form", "stack");
    var groups = [];
    function todoRow(value) {
      var input = make("input", "setup-todo");
      input.value = value;
      return input;
    }
    if (card.subgoals.length) {
      card.subgoals.forEach(function (piece) {
        var field = make("div", "field");
        field.appendChild(text(make("label"), piece.label));
        var rows = piece.todos.map(todoRow);
        rows.forEach(function (input) { field.appendChild(input); });
        form.appendChild(field);
        groups.push({ label: piece.label, rows: rows });
      });
    } else {
      var field = make("div", "field");
      var rows = card.todos.map(todoRow);
      rows.forEach(function (input) { field.appendChild(input); });
      form.appendChild(field);
      groups.push({ label: "", rows: rows });
    }
    var nameField = make("div", "field");
    nameField.appendChild(text(make("label"), "Name this project"));
    var name = make("input");
    name.placeholder = "e.g. nuclear-sim";
    name.required = true;
    nameField.appendChild(name);
    form.appendChild(nameField);
    var row = make("div", "button-row");
    var go = make("button", "button");
    go.type = "submit";
    text(go, "Approve and get my install command");
    row.appendChild(go);
    form.appendChild(row);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var subgoals = [];
      var flat = [];
      groups.forEach(function (group) {
        var kept = group.rows.map(function (input) { return input.value.trim(); })
          .filter(Boolean);
        if (!kept.length) return;
        if (group.label) subgoals.push({ label: group.label, todos: kept });
        else flat = flat.concat(kept);
      });
      approve({
        name: name.value.trim(),
        plan: state.plan || { description: "", unsure: [] },
        goals: state.goals || [],
        chosen: state.chosen,
        todos: flat,
        subgoals: subgoals,
      }, go);
    });
    box.appendChild(form);
    return box;
  }

  function drawCard() {
    el.cardSlot.textContent = "";
    var card = state.card;
    var writable = !card || card.card === "none";
    el.sayForm.classList.toggle("hidden", !writable || state.thinking);
    if (!card) return;
    if (card.card === "questions") el.cardSlot.appendChild(drawQuestions(card));
    else if (card.card === "plan") el.cardSlot.appendChild(drawPlan(card));
    else if (card.card === "goals") el.cardSlot.appendChild(drawGoals(card));
    else if (card.card === "todos") el.cardSlot.appendChild(drawTodos(card));
  }

  function draw() {
    drawLog();
    drawCard();
  }

  // --- the rounds ------------------------------------------------------------

  function api(action, body) {
    return fetch("/api/engelbart-setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.access_token,
      },
      body: JSON.stringify(Object.assign({ action: action }, body || {})),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (value) {
        if (!response.ok) throw new Error(value.error || "The request failed");
        return value;
      });
    });
  }

  function round() {
    state.thinking = true;
    setStatus("Thinking…");
    draw();
    api("turn", { transcript: state.transcript, shown: state.shown })
      .then(function (card) {
        state.thinking = false;
        if (!card.ok) {
          setStatus(card.error || "That did not work; say it again.", "error");
          draw();
          return;
        }
        setStatus("");
        if (card.say) state.transcript.push({ role: "engelbart", text: card.say });
        if (ORDER.indexOf(card.card) >= 0) {
          state.shown.push(card.card);
          if (card.card === "plan") state.plan = card.plan;
          if (card.card === "goals") state.goals = card.goals;
        }
        state.card = card;
        remember();
        draw();
      })
      .catch(function (error) {
        state.thinking = false;
        setStatus(error.message, "error");
        draw();
      });
  }

  function say(words) {
    if (!words || state.thinking) return;
    state.transcript.push({ role: "you", text: words });
    state.card = null;
    remember();
    round();
  }

  function approve(payload, button) {
    if (!payload.name) {
      setStatus("Name the project first.", "error");
      return;
    }
    button.disabled = true;
    setStatus("Saving your project…");
    api("save", { payload: payload })
      .then(function () { return issueCode(); })
      .then(function () { forget(); })
      .catch(function (error) {
        button.disabled = false;
        setStatus(error.message, "error");
      });
  }

  function issueCode() {
    return fetch("/api/engelbart-device", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.access_token,
      },
      body: JSON.stringify({ action: "issue" }),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (value) {
        if (!response.ok) throw new Error(value.error || "Could not issue a setup code");
        text(el.installCmd, "npx engelbart-cli --code " + value.code);
        text(el.codeNote, "The code works once and expires in "
          + Math.round((value.expiresInSeconds || 900) / 60)
          + " minutes — get a new one here any time.");
        el.doneStatus.textContent = "";
        show(el.done);
      });
    });
  }

  // --- boot ------------------------------------------------------------------

  el.sayForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var words = el.sayInput.value.trim();
    if (!words) return;
    el.sayInput.value = "";
    say(words);
  });

  el.copyCmd.addEventListener("click", function () {
    var command = el.installCmd.textContent;
    var report = function () {
      el.doneStatus.textContent = "Copied.";
      el.doneStatus.dataset.kind = "success";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(command).then(report, function () {
        el.doneStatus.textContent = command;
      });
    } else {
      el.doneStatus.textContent = command;
    }
  });

  el.newCode.addEventListener("click", function () {
    el.doneStatus.textContent = "";
    issueCode().catch(function (error) {
      el.doneStatus.textContent = error.message;
      el.doneStatus.dataset.kind = "error";
    });
  });

  el.signOut.addEventListener("click", function () {
    if (client) client.auth.signOut();
    window.location.href = "/engelbart/signin";
  });

  function showSession(next) {
    session = next;
    if (!session) {
      el.navSession.classList.add("hidden");
      show(el.signin);
      return;
    }
    el.navSession.classList.remove("hidden");
    text(el.sessionEmail, (session.user && session.user.email) || "");
    restore();
    show(el.chat);
    draw();
    // A conversation that was already past its opening picks up where it
    // was; a fresh one waits for the reader to type.
    if (state.card) drawCard();
  }

  async function boot() {
    try {
      var response = await fetch("/api/engelbart-config", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Configuration unavailable");
      var config = await response.json();
      client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      client.auth.onAuthStateChange(function (_event, next) { showSession(next); });
      var held = await client.auth.getSession();
      if (held.error) throw held.error;
      showSession(held.data.session);
    } catch (_error) {
      show(el.loading);
      var status = el.loading.querySelector(".status");
      status.textContent = "Engelbart setup is not available on this deployment yet.";
      status.dataset.kind = "error";
    } finally {
      document.documentElement.removeAttribute("data-auth-mode");
      document.documentElement.removeAttribute("data-session");
    }
  }

  boot();
})();
