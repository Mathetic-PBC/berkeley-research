/* The web setup conversation.
 *
 * This is the local `hc setup-ui` page's conversation, wearing the same face
 * (see setup.css), moved to the browser and put behind an Engelbart account.
 * A member describes their first project, approves a plan, and leaves with
 * one command -- `npx engelbart-cli --code XXXX-XXXX-XXXX` -- that installs
 * on their machine and pulls this project down without a second sign-in.
 *
 * The card contract is hc's setup_chat (the source of truth); this page only
 * draws what the server has already normalized. Nothing is written into the
 * member's account until they press the button at the end. The rendering is
 * kept deliberately in step with hc/.../trajectory/web/setup.js. */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var STORE_KEY = "engelbart-web-setup-v1";

  var client = null;   // supabase client, once config is fetched
  var session = null;  // the member's session, once signed in

  // `screen` is the only thing that decides what is drawn.
  var st = {
    screen: "loading",   // loading | signin | talk | done
    msgs: [],
    card: null,          // the last card the model named
    answers: {},         // per question id, for the card on screen
    shown: [],           // the cards drawn so far -- the step order is read
                         // from this, and the server will not draw one out
                         // of turn
    thinking: false,
    draft: "",
    error: "",
    plan: null,          // the plan they approved
    goals: null,         // the goals they were offered
    chosen: "",          // the one they picked
    other: "",           // ...or the one they typed
    goalNote: "",        // what else the rows should know about it
    todos: [],           // rows, editable -- flat, when it did not break down
    pieces: [],          // ...or the pieces of the chosen goal, with rows
    name: "",            // the project's name, typed while the rest arrives
    made: null,          // { code, expiresInSeconds } once the code is issued
    saving: false,       // the button is mid-request
    installKind: "curl", // which install command the done screen shows
    brief: "",           // a pasted brief, before it is read
    briefOpen: false,    // the paste panel is showing
    sources: []          // { url, read, error } for the links in that brief
  };

  // The two ways in, and what each is worth saying. curl is first because it
  // is the one that needs nothing already on the machine -- no Node, no npm;
  // npx is there for someone who would rather use the tool they know.
  var INSTALL = {
    curl: { tab: "curl", note: "No Node, npm, or Python needed.",
      command: function (code) {
        return "curl -fsSL https://berkeley.mathetic.com/engelbart/install.sh"
          + " | sh -s -- --code " + code;
      } },
    npx: { tab: "npx", note: "Uses Node, which you already have if you run npx.",
      command: function (code) { return "npx engelbart-cli --code " + code; } }
  };

  var OPEN = "Tell me what you're working on in your own words."
    + " I'll ask a few questions, then write up a plan for you to approve.";

  function dark() {
    // Light unless the reader has asked for dark on this page: the first
    // thing anybody sees of this tool should not depend on a system setting
    // made for something else.
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

  function btn(label, cls, fn, disabled) {
    var b = el("button", "btn " + (cls || ""));
    b.appendChild(el("span", "", label));
    if ((cls || "").indexOf("btn-on") >= 0) b.appendChild(el("span", "go", "›"));
    if (disabled) b.setAttribute("disabled", "disabled");
    else on(b, "click", fn);
    return b;
  }

  function str(value) { return value == null ? "" : String(value); }

  function fresh() { return "x" + Math.random().toString(36).slice(2, 8); }

  function row(text) { return { id: fresh(), text: str(text) }; }

  // --- persistence ----------------------------------------------------------

  function remember() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        msgs: st.msgs, shown: st.shown, card: st.card,
        plan: st.plan, goals: st.goals, chosen: st.chosen
      }));
    } catch (e) { /* private windows forget; the page still works */ }
  }

  function restore() {
    try {
      var held = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (!held || !Array.isArray(held.msgs) || !held.msgs.length) return;
      st.msgs = held.msgs;
      st.shown = Array.isArray(held.shown) ? held.shown : [];
      st.card = held.card || null;
      st.plan = held.plan || null;
      st.goals = held.goals || null;
      st.chosen = str(held.chosen);
      if (st.card && st.card.card === "todos") {
        st.todos = (st.card.todos || []).map(row);
        st.pieces = (st.card.subgoals || []).map(function (g) {
          return { id: fresh(), label: g.label,
                   todos: (g.todos || []).map(row) };
        });
      }
    } catch (e) { /* a torn record is a fresh start */ }
  }

  function forget() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* fine */ }
  }

  // --- the server -----------------------------------------------------------

  function api(action, body) {
    return fetch("/api/engelbart-setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (session && session.access_token)
      },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (value) {
        if (!r.ok) throw new Error(value.error || "the request failed");
        return value;
      });
    });
  }

  // --- the conversation -----------------------------------------------------

  function say(role, text) {
    if (!str(text)) return;
    st.msgs.push({ role: role, text: str(text) });
  }

  function round(extra) {
    // One turn: the whole transcript out, one card back. The card the model
    // named replaces whatever was on screen.
    st.thinking = true;
    st.error = "";
    st.card = null;
    st.answers = {};
    remember();
    draw();
    api("turn", { transcript: st.msgs.concat(extra || []), shown: st.shown })
      .then(function (out) {
        st.thinking = false;
        if (!out || !out.ok) {
          st.error = (out && out.error) || "setup could not reach Claude";
          draw();
          return;
        }
        say("engelbart", out.say);
        st.card = out;
        if (out.card && out.card !== "none") st.shown.push(out.card);
        if (out.card === "plan") st.plan = out.plan;
        if (out.card === "goals") st.goals = out.goals;
        if (out.card === "todos") {
          st.todos = (out.todos || []).map(row);
          st.pieces = (out.subgoals || []).map(function (g) {
            return { id: fresh(), label: g.label,
                     todos: (g.todos || []).map(row) };
          });
        }
        remember();
        draw();
      })
      .catch(function (error) {
        st.thinking = false;
        st.error = error.message || "setup could not reach Claude";
        draw();
      });
  }

  // A pasted brief, read in one pass: the server fetches the links inside it
  // and writes the plan, the goals and the rows from what they say. It lands
  // on the todos card, which is the one that already knows how to edit rows,
  // name the project and save it -- so nothing here is a new way to finish.
  function sendBrief() {
    var text = st.brief.trim();
    if (!text || st.thinking) return;
    st.thinking = true;
    st.error = "";
    st.card = null;
    say("you", text);
    draw();
    api("brief", { text: text })
      .then(function (out) {
        var made = out.payload || {};
        st.thinking = false;
        st.sources = out.sources || [];
        st.brief = "";
        st.briefOpen = false;
        st.plan = made.plan || { description: "", unsure: [] };
        st.goals = made.goals || [];
        st.chosen = made.chosen || "";
        st.name = made.name || "";
        st.pieces = (made.subgoals || []).map(function (g) {
          return { id: fresh(), label: g.label,
                   todos: (g.todos || []).map(row) };
        });
        st.todos = (made.todos || []).map(row);
        // The whole order arrived at once, so the conversation is past all
        // four cards: a later turn asks for what comes after them, not for a
        // plan that is already on screen.
        st.shown = ["questions", "plan", "goals", "todos"];
        st.card = { card: "todos", say: "",
                    todos: st.todos.map(function (t) { return t.text; }),
                    subgoals: st.pieces };
        say("engelbart", briefSaid(st.sources));
        remember();
        draw();
      })
      .catch(function (error) {
        st.thinking = false;
        st.error = error.message || "that brief could not be read";
        draw();
      });
  }

  // What was actually read, said plainly -- a link that would not load
  // changes what the plan can be trusted on, so it is not hidden.
  function briefSaid(sources) {
    var read = sources.filter(function (s) { return s.read; });
    var missed = sources.filter(function (s) { return !s.read; });
    var said = read.length
      ? "Read " + read.length + (read.length === 1 ? " link" : " links")
        + " and wrote the project from them."
      : "Wrote the project from the brief itself.";
    if (missed.length) {
      said += " " + (missed.length === 1 ? "This one" : "These")
        + " could not be read, so nothing here rests on "
        + (missed.length === 1 ? "it" : "them") + ": "
        + missed.map(function (s) { return s.url; }).join(", ") + ".";
    }
    return said + " Everything below is editable before it is saved.";
  }

  function send() {
    var text = st.draft.trim();
    if (!text || st.thinking) return;
    say("you", text);
    st.draft = "";
    round();
  }

  // --- what the reader picked, as their turn --------------------------------

  function answersAsSaid() {
    var items = (st.card && st.card.questions && st.card.questions.items) || [];
    var said = [];
    items.forEach(function (q) {
      var got = st.answers[q.id];
      if (Array.isArray(got)) got = got.join(" · ");
      got = str(got).trim();
      if (got) said.push(q.title + ": " + got);
    });
    return said.join("\n");
  }

  function submitAnswers() {
    var said = answersAsSaid();
    if (!said) return;
    say("you", said);
    round();
  }

  function skipAnswers() {
    say("you", "skip -- decide for me");
    round();
  }

  // --- drawing --------------------------------------------------------------

  function draw() {
    app.setAttribute("data-dark", dark() ? "true" : "false");
    app.textContent = "";
    if (st.screen === "loading") return drawLoading();
    if (st.screen === "signin") return drawSignin();
    if (st.screen === "done") return drawDone();
    drawTalk();
  }

  function column(parent) {
    var wrap = el("div", "wrap");
    var col = el("div", "col");
    wrap.appendChild(col);
    parent.appendChild(wrap);
    return col;
  }

  function hero(col, note) {
    var box = el("div", "hero rise");
    box.appendChild(el("div", "hero-name", "Engelbart"));
    if (note) box.appendChild(el("div", "hero-note", note));
    col.appendChild(box);
  }

  function whoBar() {
    if (!session || !session.user) return;
    var bar = el("div", "who");
    var line = el("span", "", session.user.email || "signed in");
    var dot = el("span", "dot");
    var out = el("button", "", "sign out");
    on(out, "click", function () {
      if (client) client.auth.signOut();
      window.location.href = "/engelbart/signin";
    });
    bar.appendChild(dot);
    bar.appendChild(line);
    bar.appendChild(el("span", "", "·"));
    bar.appendChild(out);
    app.appendChild(bar);
  }

  function drawLoading() {
    var col = column(app);
    hero(col, st.error || "Waking up…");
  }

  // Signed out: setting a project up starts with an account, and the button
  // is the whole of the screen.
  function drawSignin() {
    var col = column(app);
    hero(col, "");
    var card = el("div", "card rise");
    var body = el("div", "card-body");
    body.appendChild(el("div", "card-title", "Set up your first project"));
    body.appendChild(el("div", "card-lede",
      "Describe the work, approve a plan, and leave with one command that"
      + " installs Engelbart on your machine and opens the project. It starts"
      + " with your Engelbart account."));
    var acts = el("div", "acts");
    var go = el("a", "btn btn-on");
    go.setAttribute("href", "/engelbart/signin");
    go.appendChild(el("span", "", "Sign in, then come back"));
    go.appendChild(el("span", "go", "›"));
    acts.appendChild(go);
    body.appendChild(acts);
    card.appendChild(body);
    col.appendChild(card);
  }

  // The conversation.
  function drawTalk() {
    whoBar();
    var col = column(app);
    if (st.msgs.length <= 1 && !st.card) hero(col, "");

    st.msgs.forEach(function (m, index) {
      var cls = "msg rise " + (m.role === "you" ? "msg-you" : "msg-them");
      if (index === 0 && m.role !== "you" && m.text === OPEN) cls += " msg-opening";
      var box = el("div", cls);
      box.appendChild(el("div", "lbl", m.role === "you" ? "you" : "engelbart"));
      box.appendChild(el("div", "msg-body", m.text));
      col.appendChild(box);
    });

    if (st.thinking) col.appendChild(generating());

    if (st.error) {
      var bad = el("div", "");
      bad.appendChild(el("div", "err", st.error));
      var again = el("div", "acts");
      again.appendChild(btn("Try again", "btn-on", function () { round(); }));
      bad.appendChild(again);
      col.appendChild(bad);
    }

    if (!st.thinking && st.msgs.length <= 1 && !st.card) drawBriefEntry(col);

    var kind = st.card && st.card.card;
    if (!st.thinking && kind === "questions") drawQuestions(col);
    if (!st.thinking && kind === "plan") drawPlan(col);
    if (!st.thinking && kind === "goals") drawGoals(col);
    if (!st.thinking && kind === "todos") drawTodos(col);

    drawComposer(app);
  }

  // The other way in: paste the brief you were handed instead of answering
  // questions about it. Offered only on the opening screen -- once the
  // conversation has started, the cards are the way forward.
  function drawBriefEntry(col) {
    if (!st.briefOpen) {
      var offer = el("div", "acts brief-offer");
      offer.appendChild(btn("Paste a brief instead", "", function () {
        st.briefOpen = true;
        draw();
      }));
      col.appendChild(offer);
      return;
    }
    var body = cardBox(col, "a brief", "links are read");
    body.appendChild(el("div", "card-lede",
      "Paste what you were sent -- a person, a paper, a repository, the task"
      + " someone suggested. The links are opened and read, and the plan, the"
      + " goals and the rows are written from what they say."));
    var field = el("textarea", "f brief-f");
    field.setAttribute("rows", "8");
    field.setAttribute("spellcheck", "false");
    field.setAttribute("placeholder",
      "Sagar Karandikar\nhttps://sagark.org/\nhttps://arxiv.org/pdf/…\n\n"
      + "Paper overview: …\nPossible task: …");
    field.value = st.brief;
    body.appendChild(field);
    var acts = el("div", "acts");
    // Built enabled so the click handler is actually attached -- btn() only
    // wires one when it is not disabled -- and then dimmed until there is
    // something to read. Typing tunes it in place: redrawing on every
    // keystroke would take the caret out of the field they are typing into.
    var read = btn("Read it", "btn-on", sendBrief);
    function tuneRead() {
      if (st.brief.trim() && !st.thinking) read.removeAttribute("disabled");
      else read.setAttribute("disabled", "disabled");
    }
    tuneRead();
    on(field, "input", function () { st.brief = field.value; tuneRead(); });
    // A brief is multiline, so Enter has to stay a newline; cmd/ctrl-enter is
    // the way to send one without reaching for the button.
    on(field, "keydown", function (event) {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendBrief();
      }
    });
    acts.appendChild(read);
    acts.appendChild(btn("Cancel", "", function () {
      st.briefOpen = false;
      draw();
    }));
    body.appendChild(acts);
  }

  function generating() {
    // Nine dots in a square, lit in turn: something is being made, which is
    // what is actually happening.
    var box = el("div", "think rise");
    var grid = el("span", "dots");
    for (var i = 0; i < 9; i++) {
      var dot = el("span", "dot");
      dot.style.animationDelay = (i % 3 + Math.floor(i / 3)) * 90 + "ms";
      grid.appendChild(dot);
    }
    box.appendChild(grid);
    box.appendChild(el("span", "", "generating"));
    return box;
  }

  function cardBox(col, eyebrow, right) {
    var card = el("div", "card rise");
    var head = el("div", "card-head");
    var line = el("div", "");
    line.style.display = "flex";
    line.style.alignItems = "baseline";
    line.appendChild(el("span", "lbl", eyebrow));
    if (right) line.appendChild(el("span", "lbl right", right));
    head.appendChild(line);
    head.appendChild(el("div", "rule"));
    card.appendChild(head);
    var body = el("div", "card-body");
    card.appendChild(body);
    col.appendChild(card);
    return body;
  }

  // --- the question card, in its four shapes --------------------------------

  function drawQuestions(col) {
    var set = st.card.questions;
    var items = set.items || [];
    var body = cardBox(col, set.eyebrow || "a few questions",
                       items.length === 1 ? "1 question"
                                          : items.length + " questions");
    items.forEach(function (q) { body.appendChild(questionNode(q)); });

    var acts = el("div", "acts");
    var ready = items.some(function (q) {
      var got = st.answers[q.id];
      return Array.isArray(got) ? got.length : str(got).trim();
    });
    acts.appendChild(btn("Send answers", ready ? "btn-on" : "",
                         submitAnswers, !ready));
    acts.appendChild(btn("Skip", "", skipAnswers));
    body.appendChild(acts);
  }

  function questionNode(q) {
    var box = el("div", "q");
    box.appendChild(el("div", "card-title", q.title));
    if (q.subtitle) box.appendChild(el("div", "card-sub", q.subtitle));
    else if (q.type === "select_all") {
      box.appendChild(el("div", "card-sub", "select all that apply"));
    }
    if (q.type === "mcq" || q.type === "select_all") {
      box.appendChild(optionList(q));
    } else {
      box.appendChild(writtenField(q));
    }
    return box;
  }

  function optionList(q) {
    var many = q.type === "select_all";
    var list = el("div", "");
    (q.options || []).forEach(function (o) {
      var picked = many
        ? (st.answers[q.id] || []).indexOf(o.label) >= 0
        : st.answers[q.id] === o.label;
      var line = el("div", "opt");
      line.setAttribute("data-on", picked ? "1" : "0");
      var mark = el("span", "mark " + (many ? "mark-many" : "mark-one"),
                    picked && many ? "✓" : "");
      line.appendChild(mark);
      var text = el("span", "opt-text");
      text.appendChild(el("span", "opt-label", o.label));
      if (o.why) text.appendChild(el("span", "opt-why", o.why));
      line.appendChild(text);
      on(line, "click", function () {
        if (many) {
          var held = (st.answers[q.id] || []).slice();
          var at = held.indexOf(o.label);
          if (at >= 0) held.splice(at, 1); else held.push(o.label);
          st.answers[q.id] = held;
        } else {
          st.answers[q.id] = st.answers[q.id] === o.label ? "" : o.label;
        }
        draw();
      });
      list.appendChild(line);
    });
    return list;
  }

  function writtenField(q) {
    var wrap = el("div", "field");
    var long = q.type === "open";
    var input = el(long ? "textarea" : "input", "f");
    if (long) input.setAttribute("rows", "3");
    else input.setAttribute("type", "text");
    input.setAttribute("spellcheck", "false");
    if (q.placeholder) input.setAttribute("placeholder", q.placeholder);
    input.value = str(st.answers[q.id]);
    on(input, "input", function () { st.answers[q.id] = input.value; });
    on(input, "blur", draw);
    wrap.appendChild(input);
    return wrap;
  }

  // --- plan -----------------------------------------------------------------

  function drawPlan(col) {
    var plan = st.card.plan || {};
    var body = cardBox(col, "plan");
    body.appendChild(el("div", "card-title",
                        "Here's what I think you're working on"));
    str(plan.description).split("\n\n").forEach(function (para) {
      if (!para.trim()) return;
      body.appendChild(el("div", "prose", para.trim()));
    });
    if ((plan.unsure || []).length) {
      var box = el("div", "inset");
      box.appendChild(el("div", "lbl", "still unsure about"));
      plan.unsure.forEach(function (line) {
        var bul = el("div", "bullet");
        bul.appendChild(el("span", "bullet-dot", "·"));
        bul.appendChild(el("span", "", line));
        box.appendChild(bul);
      });
      body.appendChild(box);
    }
    var ask = el("div", "card-title", "Is that basically right?");
    ask.style.marginTop = "16px";
    body.appendChild(ask);
    var acts = el("div", "acts");
    acts.appendChild(btn("Continue", "btn-on", function () {
      st.plan = plan;
      say("you", "Approved.");
      round();
    }));
    acts.appendChild(btn("Add something", "", function () {
      var field = document.querySelector(".composer .f");
      if (field) field.focus();
    }));
    body.appendChild(acts);
  }

  // --- goals ----------------------------------------------------------------

  function drawGoals(col) {
    var goals = st.card.goals || [];
    var typing = st.chosen === " other";
    var label = typing ? st.other.trim() : st.chosen;
    var body = cardBox(col, "goal");
    body.appendChild(el("div", "card-title", "What should we focus on?"));

    goals.forEach(function (g) {
      var picked = st.chosen === g.label;
      var line = el("div", "opt");
      line.setAttribute("data-on", picked ? "1" : "0");
      line.appendChild(el("span", "mark mark-one", ""));
      var text = el("span", "opt-text");
      text.appendChild(el("span", "opt-label", g.label));
      if (g.why) text.appendChild(el("span", "opt-why", g.why));
      line.appendChild(text);
      on(line, "click", function () {
        st.chosen = picked ? "" : g.label;
        draw();
      });
      body.appendChild(line);
    });

    var mine = el("div", "opt");
    mine.setAttribute("data-on", typing ? "1" : "0");
    mine.appendChild(el("span", "mark mark-one", ""));
    var mineText = el("span", "opt-text");
    mineText.appendChild(el("span", "opt-label", "Something else"));
    mineText.appendChild(el("span", "opt-why",
      "tell it what to start on instead and it will use that"));
    mine.appendChild(mineText);
    on(mine, "click", function () {
      st.chosen = typing ? "" : " other";
      draw();
    });
    body.appendChild(mine);

    if (typing) {
      var wrap = el("div", "field");
      var input = el("input", "f");
      input.setAttribute("type", "text");
      input.setAttribute("spellcheck", "false");
      input.setAttribute("placeholder", "what to start on");
      input.value = st.other;
      on(input, "input", function () { st.other = input.value; });
      on(input, "blur", draw);
      wrap.appendChild(input);
      body.appendChild(wrap);
    }

    if (label) {
      var more = el("div", "rise");
      more.style.marginTop = "14px";
      more.appendChild(el("div", "lbl", "anything the rows should know"));
      var box = el("div", "field");
      var note = el("textarea", "f");
      note.setAttribute("rows", "3");
      note.setAttribute("spellcheck", "false");
      note.setAttribute("placeholder",
                        "constraints, what to leave alone, where to start…");
      note.value = st.goalNote;
      on(note, "input", function () { st.goalNote = note.value; });
      box.appendChild(note);
      more.appendChild(box);
      body.appendChild(more);
    }

    var acts = el("div", "acts");
    acts.appendChild(btn("Generate TODOs", label ? "btn-on" : "", function () {
      st.goals = goals;
      say("you", st.goalNote.trim()
          ? label + "\n\n" + st.goalNote.trim() : label);
      round();
    }, !label));
    body.appendChild(acts);
  }

  // --- todos, and the name ---------------------------------------------------

  function drawTodos(col) {
    var pieces = st.pieces;
    var count = pieces.length
      ? pieces.reduce(function (n, g) { return n + g.todos.length; }, 0)
      : st.todos.length;
    var body = cardBox(col, "todos",
                       count === 1 ? "1 row" : count + " rows");

    if (pieces.length) {
      pieces.forEach(function (piece) {
        var head = el("div", "piece");
        var name = el("input", "f piece-name");
        name.setAttribute("type", "text");
        name.setAttribute("spellcheck", "false");
        name.value = piece.label;
        on(name, "input", function () { piece.label = name.value; });
        head.appendChild(name);
        var drop = el("button", "x", "×");
        on(drop, "click", function () {
          st.pieces = st.pieces.filter(function (g) { return g !== piece; });
          draw();
        });
        head.appendChild(drop);
        body.appendChild(head);
        var kids = el("div", "kids");
        piece.todos.forEach(function (t) {
          kids.appendChild(todoRow(t, piece.todos, function () {
            piece.todos = piece.todos.filter(function (r) { return r !== t; });
          }));
        });
        kids.appendChild(adder(function (text) {
          piece.todos.push(row(text));
        }));
        body.appendChild(kids);
      });
    } else {
      st.todos.forEach(function (t) {
        body.appendChild(todoRow(t, st.todos, function () {
          st.todos = st.todos.filter(function (r) { return r !== t; });
        }));
      });
      body.appendChild(adder(function (text) { st.todos.push(row(text)); }));
    }

    // The name, and the button that lives in it -- asked for here, by which
    // point they have seen what the project is, so naming it is recognition
    // rather than invention.
    var nameWrap = el("div", "");
    nameWrap.style.marginTop = "20px";
    nameWrap.appendChild(el("div", "lbl", "name your project"));
    var pill = el("div", "name-row");
    var name = el("input", "f");
    name.setAttribute("type", "text");
    name.setAttribute("spellcheck", "false");
    name.setAttribute("placeholder", "a short name");
    name.value = st.name;
    var go = btn(st.saving ? "Working…" : "Create project",
                 st.name.trim() && !st.saving ? "btn-on" : "",
                 complete, !st.name.trim() || st.saving);
    on(name, "input", function () {
      st.name = name.value;
      if (st.name.trim() && !st.saving) {
        go.removeAttribute("disabled");
        go.className = "btn btn-on";
        if (!go.querySelector(".go")) go.appendChild(el("span", "go", "›"));
        go.onclick = complete;
      } else {
        go.setAttribute("disabled", "disabled");
        go.className = "btn";
        var chev = go.querySelector(".go");
        if (chev) chev.remove();
      }
    });
    pill.appendChild(name);
    pill.appendChild(go);
    nameWrap.appendChild(pill);
    body.appendChild(nameWrap);

    if (st.error) body.appendChild(el("div", "err", st.error));
  }

  function todoRow(t, list, drop) {
    var line = el("div", "row");
    line.appendChild(el("span", "bullet-dot", "·"));
    var input = el("input", "f");
    input.setAttribute("type", "text");
    input.setAttribute("spellcheck", "false");
    input.value = t.text;
    on(input, "input", function () { t.text = input.value; });
    line.appendChild(input);
    var x = el("button", "x", "×");
    on(x, "click", function () { drop(); draw(); });
    line.appendChild(x);
    return line;
  }

  function adder(add) {
    var line = el("div", "row");
    line.appendChild(el("span", "bullet-dot", "·"));
    var input = el("input", "f");
    input.setAttribute("type", "text");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("placeholder", "add a row…");
    on(input, "keydown", function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      add(text);
      draw();
    });
    line.appendChild(input);
    return line;
  }

  // The one write. Save the approved project, then mint the install code, and
  // move to the screen that hands it over.
  function complete() {
    if (!st.name.trim() || st.saving) return;
    st.saving = true;
    st.error = "";
    draw();
    var payload = {
      name: st.name,
      plan: st.plan || { description: "", unsure: [] },
      goals: st.goals || [],
      chosen: st.chosen === " other" ? st.other : st.chosen,
      todos: st.todos.map(function (t) { return t.text; }),
      subgoals: st.pieces.map(function (g) {
        return { label: g.label,
                 todos: g.todos.map(function (t) { return t.text; }) };
      })
    };
    api("save", { payload: payload })
      .then(function () { return issueCode(); })
      .then(function (issued) {
        forget();
        st.saving = false;
        st.made = { name: st.name.trim(), code: issued.code,
                    expiresInSeconds: issued.expiresInSeconds };
        st.screen = "done";
        draw();
      })
      .catch(function (error) {
        st.saving = false;
        st.error = error.message || "the project could not be saved";
        draw();
      });
  }

  function issueCode() {
    return fetch("/api/engelbart-device", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (session && session.access_token)
      },
      body: JSON.stringify({ action: "issue" })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (value) {
        if (!r.ok) throw new Error(value.error || "could not issue a setup code");
        return value;
      });
    });
  }

  // The command, copyable -- a command someone retypes is a command someone
  // mistypes.
  function commandRow(command) {
    var line = el("div", "cmd");
    line.appendChild(el("span", "cmd-text", command));
    var copy = el("button", "cmd-copy", "copy");
    on(copy, "click", function () {
      var done = function () {
        copy.textContent = "copied";
        setTimeout(function () { copy.textContent = "copy"; }, 1400);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(command).then(done, fallback);
        } else fallback();
      } catch (e) { fallback(); }
      function fallback() {
        var probe = document.createElement("textarea");
        probe.value = command;
        document.body.appendChild(probe);
        probe.select();
        try { document.execCommand("copy"); done(); }
        catch (e2) { copy.textContent = "select it"; }
        document.body.removeChild(probe);
      }
    });
    line.appendChild(copy);
    return line;
  }

  function step(parent, n, text) {
    var line = el("div", "step");
    line.appendChild(el("div", "step-n", n));
    var body = el("div", "step-b");
    body.appendChild(el("div", "step-t", text));
    line.appendChild(body);
    parent.appendChild(line);
  }

  // The last screen: the project is saved to the account, and the command is
  // the whole of what is left to do.
  function drawDone() {
    whoBar();
    var col = column(app);
    hero(col, "“" + str(st.made.name) + "” is ready to install.");

    var card = el("div", "card rise");
    var head = el("div", "card-head");
    head.appendChild(el("span", "lbl", "install it"));
    head.appendChild(el("div", "rule"));
    card.appendChild(head);
    var body = el("div", "card-body");
    body.appendChild(el("div", "card-lede",
      "Run this in a terminal on the machine you build on. It installs"
      + " Engelbart, connects this account, and opens your project — no"
      + " second sign-in."));

    // The switch between the two commands. Toggled in place -- the whole
    // done screen is cheap to redraw, and st.made survives it.
    var seg = el("div", "seg");
    Object.keys(INSTALL).forEach(function (kind) {
      var on = st.installKind === kind;
      var tab = el("button", "seg-btn" + (on ? " seg-on" : ""),
                   INSTALL[kind].tab);
      if (!on) {
        tab.addEventListener("click", function () {
          st.installKind = kind;
          draw();
        });
      }
      seg.appendChild(tab);
    });
    body.appendChild(seg);

    var chosen = INSTALL[st.installKind] || INSTALL.curl;
    body.appendChild(commandRow(chosen.command(st.made.code)));
    var mins = Math.round((st.made.expiresInSeconds || 900) / 60);
    body.appendChild(el("div", "hint",
      chosen.note + " The code works once and expires in " + mins
      + (mins === 1 ? " minute." : " minutes.")));
    var acts = el("div", "acts");
    acts.appendChild(btn("Get a new code", "", function () {
      issueCode().then(function (issued) {
        st.made.code = issued.code;
        st.made.expiresInSeconds = issued.expiresInSeconds;
        draw();
      }).catch(function (error) {
        st.error = error.message;
        draw();
      });
    }));
    acts.appendChild(btn("Set up another", "", function () {
      reset();
      st.screen = "talk";
      say("engelbart", OPEN);
      draw();
    }));
    body.appendChild(acts);
    if (st.error) body.appendChild(el("div", "err", st.error));
    card.appendChild(body);
    col.appendChild(card);

    var next = el("div", "card rise");
    var nhead = el("div", "card-head");
    nhead.appendChild(el("span", "lbl", "then, on your machine"));
    nhead.appendChild(el("div", "rule"));
    next.appendChild(nhead);
    var nbody = el("div", "card-body");
    step(nbody, "1", "Run the command above. Engelbart installs and connects"
      + " this account.");
    step(nbody, "2", "Your project opens in the local workspace, its goals"
      + " and rows already there.");
    next.appendChild(nbody);
    col.appendChild(next);
  }

  function reset() {
    st.msgs = [];
    st.card = null;
    st.answers = {};
    st.shown = [];
    st.plan = null;
    st.goals = null;
    st.chosen = "";
    st.other = "";
    st.goalNote = "";
    st.todos = [];
    st.pieces = [];
    st.name = "";
    st.made = null;
    st.error = "";
    forget();
  }

  // --- the composer ---------------------------------------------------------

  function drawComposer(parent) {
    var foot = el("div", "foot");
    var col = el("div", "col");
    var first = st.msgs.length <= 1;
    var box = el("div", "composer" + (first ? " composer-first" : ""));
    var field = el("textarea", "f");
    field.setAttribute("rows", "1");
    field.setAttribute("spellcheck", "false");
    field.setAttribute("aria-label", first
      ? "What are you working on?" : "Message Engelbart");
    field.setAttribute("placeholder", first
      ? "What are you working on? Describe it however it comes out…"
      : "or just talk — the card above still works");
    field.value = st.draft;
    on(field, "input", function () {
      st.draft = field.value;
      field.style.height = "auto";
      field.style.height = Math.min(field.scrollHeight, 160) + "px";
      var button = box.querySelector(".send");
      if (!button) return;
      if (st.draft.trim() && !st.thinking) {
        button.removeAttribute("disabled");
        button.className = "send send-on";
      } else {
        button.setAttribute("disabled", "disabled");
        button.className = "send";
      }
    });
    on(field, "keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    box.appendChild(field);

    var ready = !!st.draft.trim() && !st.thinking;
    var button = el("button", "send" + (ready ? " send-on" : ""));
    if (!ready) button.setAttribute("disabled", "disabled");
    button.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24"'
      + ' fill="none" stroke="currentColor" stroke-width="1.6"'
      + ' stroke-linejoin="round"><path d="M3 20 L21 11 L4 4 L7 11 Z"></path>'
      + '<path d="M7 11 L21 11"></path></svg>';
    button.style.color = ready ? "var(--acc)" : "var(--fnt)";
    on(button, "click", send);
    box.appendChild(button);

    col.appendChild(box);
    foot.appendChild(col);
    parent.appendChild(foot);

    if (document.activeElement === document.body) {
      try { field.focus(); } catch (e) { /* not focusable yet */ }
    }
  }

  try {
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", draw);
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
    restore();
    if (st.screen === "loading" || st.screen === "signin") {
      st.screen = "talk";
      if (!st.msgs.length) say("engelbart", OPEN);
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
          { auth: { persistSession: true, autoRefreshToken: true,
                    detectSessionInUrl: true } });
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
