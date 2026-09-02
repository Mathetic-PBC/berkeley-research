(function initializeEngelbartLanding() {
  "use strict";

  var copyButton = document.getElementById("copy-cmd");
  var copyIcon = document.getElementById("copy-cmd-icon");
  var commandText = document.getElementById("install-command");
  var installTabs = document.querySelectorAll(".dm-install-tab[data-install-mode]");
  var stage = document.getElementById("demo");
  var canvas = document.getElementById("demo-canvas");
  var toggle = document.getElementById("demo-toggle");

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
    try { document.execCommand("copy"); } catch (_error) { /* Clipboard unavailable. */ }
    document.body.removeChild(field);
  }

  if (copyButton && copyIcon && commandText) {
    var commands = {
      standard: "curl -fsSL https://berkeley.mathetic.com/engelbart/install.sh | sh",
      developer: "bunx engelbart-cli"
    };
    var installMode = "standard";
    var copyTimer = null;

    function flashCopied() {
      clearTimeout(copyTimer);
      copyIcon.classList.add("copied");
      copyTimer = setTimeout(function () { copyIcon.classList.remove("copied"); }, 1600);
    }

    function copyCommand(command) {
      copyText(command);
      flashCopied();
    }

    function selectInstallMode(next, copyDestination) {
      if (!commands[next]) return;
      installMode = next;
      commandText.textContent = commands[next];
      Array.prototype.forEach.call(installTabs, function (tab) {
        var selected = tab.getAttribute("data-install-mode") === next;
        tab.classList.toggle("is-on", selected);
        tab.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      if (copyDestination) copyCommand(commands[next]);
    }

    copyButton.addEventListener("click", function () {
      copyCommand(commands[installMode]);
    });

    Array.prototype.forEach.call(installTabs, function (tab) {
      if (!tab.classList.contains("dm-install-tab")) return;
      tab.addEventListener("click", function () {
        selectInstallMode(tab.getAttribute("data-install-mode"), true);
      });
    });
  }

  if (!stage || !canvas || !toggle) return;

  canvas.innerHTML = [
    '<div class="da-root">',
      '<div class="da-chat" data-el="chat">',
        '<div class="da-thread" data-el="thread">',
          '<div class="da-logo" data-el="logo">Engelbart</div>',
          '<section class="da-card da-launch" data-el="launch">',
            '<h2 class="da-heading">Is this new work, or work you already have?</h2>',
            '<div class="da-row"><span class="da-pill" data-el="launch-pill">Start a new project</span><span class="da-pill">Resume an existing one</span></div>',
          '</section>',
          '<section class="da-card da-ask" data-el="ask">',
            '<div class="da-micro" style="margin-bottom:9px">describe the project</div>',
            '<div class="da-heading" style="margin:0">Tell me what you\'re trying to make happen.</div>',
          '</section>',
          '<section class="da-card da-user" data-el="user">',
            '<div class="da-micro">you</div><div class="da-user-copy"><span data-el="user-copy"></span><span class="da-caret" data-el="caret">|</span></div>',
          '</section>',
          '<section class="da-card da-scope" data-el="scope">',
            '<div class="da-scope-head"><span class="da-micro" style="color:#1a1712">scope check</span><span class="da-micro" data-el="scope-count">2 questions</span></div>',
            '<div class="da-scope-body">',
              '<div><div class="da-question-title">How real does the physics need to be?</div><div class="da-micro da-question-hint">pick one</div>',
                '<div class="da-choice-list"><div class="da-choice radio" data-choice="physics"><span class="da-choice-mark"></span><span class="da-choice-label">Point kinetics — fast, qualitatively right, runs in a browser</span></div><div class="da-choice radio"><span class="da-choice-mark"></span><span class="da-choice-label">Full thermal-hydraulics — research-grade, slow</span></div></div>',
              '</div>',
              '<div><div class="da-question-title">What should the agents build first?</div><div class="da-micro da-question-hint">select all that apply</div>',
                '<div class="da-choice-list"><div class="da-choice" data-choice="solver"><span class="da-choice-mark"></span><span class="da-choice-label">The core solver (kinetics + feedback)</span></div><div class="da-choice" data-choice="dashboard"><span class="da-choice-mark"></span><span class="da-choice-label">The live dashboard (power, temp, reactivity)</span></div><div class="da-choice"><span class="da-choice-mark"></span><span class="da-choice-label">Scenario library (SCRAM, xenon pit, load-follow)</span></div></div>',
              '</div>',
            '</div>',
          '</section>',
          '<section class="da-card da-readback" data-el="readback">',
            '<div class="da-micro">reading you back</div><div class="da-readback-title">Here\'s what I think you\'re working on</div>',
            '<div class="da-readback-copy"><div class="da-body" data-reveal="readback-1">A driveable PWR core: point kinetics with temperature feedback, control rods with real consequences, and a live dashboard.</div><div class="da-body" data-reveal="readback-2">Agents write all the code. You review physics and feel, not diffs.</div></div>',
            '<div class="da-uncertain" data-reveal="readback-3"><em>I\'m less sure about:</em><div class="da-body" style="font-size:13.5px">which reactor type first · how the agents prove the physics · who it\'s for</div></div>',
            '<div class="da-card-actions"><span class="da-pill">Edit</span><span class="da-pill">Add something</span><span class="da-pill" data-el="continue-pill">Continue</span></div>',
          '</section>',
          '<section class="da-card da-goals-card" data-el="goals-card">',
            '<div class="da-section-head"><span class="da-micro">goals</span><span class="da-micro">1 goal · 3 subgoals</span></div>',
            '<div class="da-main-goal"><span class="da-goal-dot"></span><span>An interactive PWR core simulator, built by agents in a week</span></div>',
            '<div class="da-subgoals"><div class="da-subgoal"><span class="da-goal-dot"></span><span>Point kinetics solver that passes textbook transients</span></div><div class="da-subgoal"><span class="da-goal-dot"></span><span>Temperature feedback and rods with real consequences</span></div><div class="da-subgoal"><span class="da-goal-dot"></span><span>A live dashboard a visitor can drive without a manual</span></div></div>',
            '<div class="da-generate-row"><span class="da-pill" data-el="generate-pill">Generate todos</span><em>Edited one subgoal.</em></div>',
          '</section>',
          '<section class="da-card da-todos-card" data-el="todos-card">',
            '<div class="da-section-head"><span class="da-micro">todos · for agents</span><span class="da-micro">5 tasks</span></div>',
            '<div class="da-agent-intro"><em>Each row runs unattended. You review results, not code.</em></div>',
            '<div data-el="tasks"><div class="da-task">Scaffold repo: solver module, dashboard shell, test harness</div><div class="da-task">Point-kinetics ODEs, 6 delayed groups, tests vs textbook transients</div><div class="da-task">Fuel/coolant feedback with Doppler coefficient</div><div class="da-task">Rod worth curve + rate limit; meltdown past threshold</div><div class="da-task">Live dashboard: power, temps, reactivity at 60 fps</div></div>',
            '<div class="da-project-row"><span class="da-micro" style="font-size:9px">call it</span><span class="da-project-name">nuclear-sim</span><span class="da-pill" data-el="accept-pill">Accept todos</span></div>',
          '</section>',
        '</div>',
        '<div class="da-cursor-layer" data-el="chat-cursor-layer"><div class="da-click-ring" data-el="chat-ring"></div><div class="da-cursor" data-el="chat-cursor"></div></div>',
      '</div>',
      '<div class="da-generating" data-el="generating">',
        '<span class="da-generating-spinner" data-el="generating-spinner"></span><span class="da-generating-title">generating workspace</span>',
        '<div class="da-generating-steps"><span class="da-generating-step">project created ✓</span><span class="da-generating-step">goals attached ✓</span><span class="da-generating-step">todos handed to agents ✓</span></div>',
      '</div>',
      '<div class="da-work-layer" data-el="work-layer">',
        '<div class="da-workspace">',
          '<div class="da-work-top"><span class="da-work-name">Engelbart</span><span class="da-work-sep">/</span><span class="da-repo">nuclear-sim ▾</span><span class="da-micro da-saved">saved ✓</span></div>',
          '<div class="da-work-tabs"><span class="da-micro da-work-tab">Overview</span><span class="da-micro da-work-tab on">Goals</span><div class="da-work-filters"><span class="da-work-filter on" data-el="all-count">All 5</span><span class="da-work-filter" data-el="active-count">Active 1</span><span class="da-work-filter" data-el="done-count">Done 3</span></div></div>',
          '<div class="da-work-body">',
            '<aside class="da-goal-pane"><div class="da-pane-head"><span class="da-micro" style="font-size:9.5px">goals</span><span class="da-count">5</span></div><div class="da-search">Search goals, notes, TODOs</div>',
              '<div class="da-goal-row" data-goal="main"><span class="da-goal-dot"></span><span class="da-goal-label">Build a PWR core simulator</span></div>',
              '<div class="da-goal-children"><div class="da-goal-row done"><span class="da-goal-dot"></span><span class="da-goal-label" style="--strike:100%">Point kinetics solver</span></div><div class="da-goal-row done"><span class="da-goal-dot"></span><span class="da-goal-label" style="--strike:100%">Temperature feedback</span></div><div class="da-goal-row active" data-goal="rods"><span class="da-goal-dot"></span><span class="da-goal-label">Control rod dynamics</span></div><div class="da-goal-row" data-goal="dashboard"><span class="da-goal-dot"></span><span class="da-goal-label">Live dashboard</span></div></div>',
            '</aside>',
            '<section class="da-detail-pane"><div class="da-detail-title"><strong>Control rod dynamics</strong><span class="da-status-pill" data-el="goal-status">in progress</span></div><div class="da-sources"><span class="da-micro" style="font-size:9px">sources</span><span class="da-source">REPO: nuclear-sim</span><span class="da-source muted">+ Add source</span></div><div><div class="da-micro da-notes-label">notes</div><div class="da-notes"># Objective<br>See how a 10¢ reactivity insertion moves power over 60 s —<br>and make over-pulling the rods end badly.</div></div><div><div class="da-prompts-head"><span class="da-micro" style="font-size:9px">related prompts</span><span class="da-source muted">+ add a prompt</span></div><div class="da-empty-prompt">No prompts tied to this goal yet.</div></div></section>',
            '<aside class="da-agent-pane"><div class="da-agent-tabs"><span class="da-micro da-agent-tab on">TODOs</span><span class="da-micro da-agent-tab">Understanding</span></div><div class="da-agent-list">',
              '<div class="da-agent-card" data-agent="two" style="top:0"><div class="da-agent-head"><span class="da-spinner"></span><span class="da-agent-name">agent-2 · dashboard</span><span class="da-agent-status">running</span></div><div class="da-agent-lines"><span class="da-agent-line" data-at="22.5">scaffolded dashboard shell</span><span class="da-agent-line" data-at="23.3">wired power/temp traces at 60 fps</span><span class="da-agent-line" data-at="24.9">done · 2 TODOs closed</span></div></div>',
              '<div class="da-agent-card" data-agent="one" style="top:120px"><div class="da-agent-head"><span class="da-spinner"></span><span class="da-agent-name">agent-1 · rods &amp; feedback</span><span class="da-agent-status">running</span></div><div class="da-agent-lines"><span class="da-agent-line" data-at="22.1">reading src/kinetics.py, src/rods.py</span><span class="da-agent-line" data-at="22.9">added rod_worth() S-curve lookup</span><span class="da-agent-line" data-at="29.6">you · PWR geometry</span><span class="da-agent-line" data-at="30.1">assuming PWR geometry</span><span class="da-agent-line" data-at="30.6">re-ran 10¢ insertion: peak 1.6× nominal</span><span class="da-agent-line" data-at="32.6">done · 2 TODOs closed</span><div class="da-agent-question" data-el="agent-question"><div class="da-agent-question-copy">PWR geometry or a research reactor for the rod worth curve?</div><div class="da-agent-chips"><span class="da-agent-chip" data-el="pwr-chip">PWR</span><span class="da-agent-chip">Research reactor</span></div></div></div></div>',
              '<div class="da-agent-card" data-agent="three" style="top:366px"><div class="da-agent-head"><span class="da-spinner"></span><span class="da-agent-name">agent-3 · scenarios</span><span class="da-agent-status">running</span></div><div class="da-agent-lines"><span class="da-agent-line" data-at="23.1">drafting SCRAM scenario</span><span class="da-agent-line" data-at="26.6">decay heat curve fitted</span><span class="da-agent-line" data-at="33.4">xenon transient closed · done</span></div></div>',
              '<div class="da-all-done" data-el="all-done">5 of 5 done · agents idle</div>',
            '</div></aside>',
          '</div>',
        '</div>',
        '<div class="da-cursor-layer" data-el="work-cursor-layer"><div class="da-click-ring" data-el="work-ring"></div><div class="da-cursor" data-el="work-cursor"></div></div>',
      '</div>',
    '</div>'
  ].join("");

  var C = { Open: 0, Describe: 2.6, Scope: 6.2, Readback: 10.4, Goals: 14.4, Handoff: 17.8, Workspace: 21.2, Question: 24.2, Answer: 28.2, Complete: 31.6 };
  var DURATION = 36;
  var USER_TEXT = "An interactive nuclear reactor simulation — pull the control rods, watch power and temperature fight back, melt it down if I get greedy. Agents build it; I steer the physics.";

  function one(selector) { return canvas.querySelector(selector); }
  function many(selector) { return Array.prototype.slice.call(canvas.querySelectorAll(selector)); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutBack(t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function progress(T, at, duration, ease) { return (ease || easeInOutCubic)(clamp((T - at) / duration, 0, 1)); }
  function mix(from, to, p) { return from + (to - from) * p; }
  function interpolate(T, times, values) {
    if (T <= times[0]) return values[0];
    if (T >= times[times.length - 1]) return values[values.length - 1];
    for (var i = 0; i < times.length - 1; i += 1) {
      if (T >= times[i] && T <= times[i + 1]) {
        var p = easeInOutCubic((T - times[i]) / (times[i + 1] - times[i]));
        return mix(values[i], values[i + 1], p);
      }
    }
    return values[values.length - 1];
  }
  function enter(node, T, at, duration) {
    var d = duration || .55;
    node.style.opacity = progress(T, at, d * .6, easeOutCubic).toFixed(3);
    node.style.transform = "translateY(" + mix(18, 0, progress(T, at, d, easeOutCubic)).toFixed(2) + "px)";
  }
  function setOn(node, on) { node.classList.toggle("on", on); }
  function setDone(node, done, strike) {
    node.classList.toggle("done", done);
    node.querySelector(".da-goal-label").style.setProperty("--strike", (strike * 100).toFixed(1) + "%");
  }

  var el = {
    root: one(".da-root"), chat: one('[data-el="chat"]'), thread: one('[data-el="thread"]'), logo: one('[data-el="logo"]'),
    launch: one('[data-el="launch"]'), launchPill: one('[data-el="launch-pill"]'), ask: one('[data-el="ask"]'), user: one('[data-el="user"]'), userCopy: one('[data-el="user-copy"]'), caret: one('[data-el="caret"]'),
    scope: one('[data-el="scope"]'), scopeCount: one('[data-el="scope-count"]'), physics: one('[data-choice="physics"]'), solver: one('[data-choice="solver"]'), dashboardChoice: one('[data-choice="dashboard"]'),
    readback: one('[data-el="readback"]'), continuePill: one('[data-el="continue-pill"]'), goalsCard: one('[data-el="goals-card"]'), generatePill: one('[data-el="generate-pill"]'), todosCard: one('[data-el="todos-card"]'), acceptPill: one('[data-el="accept-pill"]'),
    chatCursorLayer: one('[data-el="chat-cursor-layer"]'), chatCursor: one('[data-el="chat-cursor"]'), chatRing: one('[data-el="chat-ring"]'),
    generating: one('[data-el="generating"]'), generatingSpinner: one('[data-el="generating-spinner"]'), workLayer: one('[data-el="work-layer"]'), workCursorLayer: one('[data-el="work-cursor-layer"]'), workCursor: one('[data-el="work-cursor"]'), workRing: one('[data-el="work-ring"]'),
    goalStatus: one('[data-el="goal-status"]'), activeCount: one('[data-el="active-count"]'), doneCount: one('[data-el="done-count"]'), agentQuestion: one('[data-el="agent-question"]'), pwrChip: one('[data-el="pwr-chip"]'), allDone: one('[data-el="all-done"]'),
    agentOne: one('[data-agent="one"]'), agentTwo: one('[data-agent="two"]'), agentThree: one('[data-agent="three"]'), mainGoal: one('[data-goal="main"]'), rodsGoal: one('[data-goal="rods"]'), dashboardGoal: one('[data-goal="dashboard"]')
  };
  var readbackReveals = many("[data-reveal]");
  var subgoals = many(".da-subgoal");
  var tasks = many(".da-task");
  var generatingSteps = many(".da-generating-step");
  var agentLines = many(".da-agent-line");
  var spinners = many(".da-spinner");

  var reveal = [.55, 2.75, 3.35, 6.4, 10.6, 14.6, 17.95];
  var heights = [112, 90, 166, 400, 324, 256, 310];
  var ys = [70, 206, 320, 510, 934, 1282, 1562];
  var scrollTargets = ys.map(function (y, i) { return 400 - (y + heights[i] / 2); });
  var scrollTimes = [], scrollValues = [];
  reveal.forEach(function (at, i) {
    scrollTimes.push(i === 0 ? reveal[0] : at - .35); scrollValues.push(scrollTargets[i]);
    scrollTimes.push(i + 1 < reveal.length ? reveal[i + 1] - .85 : DURATION); scrollValues.push(scrollTargets[i]);
  });
  function scrollAt(T) { return interpolate(T, scrollTimes, scrollValues); }

  var clickLaunch = 1.75, clickContinue = 13, clickGenerate = 16.85, clickAccept = 20.25;
  var scopeClicks = [7.3, 8, 8.6];
  var clicks = [clickLaunch].concat(scopeClicks, [clickContinue, clickGenerate, clickAccept]);
  var chatKeys = [
    { t: .9, x: 900, y: 560 },
    { t: 1.62, x: 425, y: ys[0] + 76 + scrollAt(1.62) },
    { t: 7, x: 390, y: ys[3] + 131 + scrollAt(7.3) }, { t: 7.44, x: 390, y: ys[3] + 131 + scrollAt(7.3) },
    { t: 7.72, x: 390, y: ys[3] + 279 + scrollAt(8) }, { t: 8.14, x: 390, y: ys[3] + 279 + scrollAt(8) },
    { t: 8.36, x: 390, y: ys[3] + 321 + scrollAt(8.6) }, { t: 8.76, x: 390, y: ys[3] + 321 + scrollAt(8.6) },
    { t: 12.2, x: 560, y: 300 }, { t: 12.85, x: 902, y: ys[4] + 288 + scrollAt(13) },
    { t: 16, x: 700, y: 420 }, { t: 16.7, x: 398, y: ys[5] + 220 + scrollAt(16.85) },
    { t: 19.3, x: 600, y: 460 }, { t: 20.1, x: 886, y: ys[6] + 274 + scrollAt(20.25) }
  ];
  var workKeys = [{ t: 28.35, x: 1160, y: 520 }, { t: 29.2, x: 938, y: 414 }];

  function cursorPosition(T, keys) {
    if (T <= keys[0].t) return keys[0];
    if (T >= keys[keys.length - 1].t) return keys[keys.length - 1];
    for (var i = 0; i < keys.length - 1; i += 1) {
      if (T >= keys[i].t && T < keys[i + 1].t) {
        var p = easeInOutCubic((T - keys[i].t) / (keys[i + 1].t - keys[i].t));
        return { x: mix(keys[i].x, keys[i + 1].x, p), y: mix(keys[i].y, keys[i + 1].y, p) };
      }
    }
    return keys[0];
  }

  function renderCursor(T, layer, cursor, ring, keys, clickTimes, opacity) {
    var position = cursorPosition(T, keys);
    layer.style.opacity = opacity.toFixed(3);
    cursor.style.left = position.x.toFixed(1) + "px";
    cursor.style.top = position.y.toFixed(1) + "px";
    var press = 0;
    clickTimes.forEach(function (at) { press = Math.max(press, progress(T, at, .16) - progress(T, at + .16, .18)); });
    cursor.style.transform = "scale(" + (1 - press * .18).toFixed(3) + ")";
    var ringAt = -1;
    clickTimes.forEach(function (at) { if (T >= at && T < at + .5) ringAt = (T - at) / .5; });
    ring.style.display = ringAt < 0 ? "none" : "block";
    if (ringAt >= 0) {
      ring.style.left = (position.x - 26).toFixed(1) + "px";
      ring.style.top = (position.y - 26).toFixed(1) + "px";
      ring.style.opacity = ((1 - ringAt) * .55).toFixed(3);
      ring.style.transform = "scale(" + (.3 + ringAt * .8).toFixed(3) + ")";
    }
  }

  function setAgentState(node, mode, status) {
    node.classList.toggle("done", mode === "done");
    node.classList.toggle("ask", mode === "ask");
    node.querySelector(".da-agent-status").textContent = status;
  }

  function render(T) {
    var chatOut = progress(T, clickAccept + .25, .5);
    var workIn = progress(T, C.Workspace + .3, .5);
    var generatingIn = progress(T, clickAccept + .6, .25) * (1 - progress(T, C.Workspace + .15, .25));
    var fadeOut = 1 - progress(T, DURATION - .75, .7);
    var chatScale = interpolate(T, [0, C.Scope, C.Readback + 1, C.Handoff + 3], [1, 1.015, 1.04, 1.05]);
    var workScale = interpolate(T, [C.Workspace + .3, C.Workspace + 1.3, C.Question - .4, C.Question + 1.6, C.Complete + .4, C.Complete + 2.8], [1.05, 1, 1, 1.13, 1.13, 1]);

    el.root.style.opacity = fadeOut.toFixed(3);
    el.chat.style.opacity = (1 - chatOut).toFixed(3);
    el.chat.style.transform = "scale(" + chatScale.toFixed(3) + ")";
    el.chat.style.transformOrigin = "640px 400px";
    el.thread.style.transform = "translateY(" + scrollAt(T).toFixed(1) + "px)";
    el.logo.style.opacity = progress(T, .15, .8).toFixed(3);

    enter(el.launch, T, reveal[0]); enter(el.ask, T, reveal[1]); enter(el.user, T, reveal[2]); enter(el.scope, T, reveal[3]); enter(el.readback, T, reveal[4]); enter(el.goalsCard, T, reveal[5]); enter(el.todosCard, T, reveal[6]);
    setOn(el.launchPill, T >= clickLaunch); el.launchPill.textContent = T >= clickLaunch ? "Start a new project ✓" : "Start a new project";

    var typed = Math.round(progress(T, reveal[2] + .25, 2.1) * USER_TEXT.length);
    el.userCopy.textContent = USER_TEXT.slice(0, typed);
    var caretVisible = T > reveal[2] + .25 && T < reveal[2] + 2.4;
    el.caret.style.display = caretVisible ? "inline" : "none";
    el.caret.style.opacity = (T * 3 % 1 > .5 ? 1 : .15).toFixed(2);

    [[el.physics, scopeClicks[0]], [el.solver, scopeClicks[1]], [el.dashboardChoice, scopeClicks[2]]].forEach(function (item) {
      var on = T > item[1]; setOn(item[0], on); item[0].querySelector(".da-choice-mark").textContent = on && !item[0].classList.contains("radio") ? "✓" : "";
    });
    el.scopeCount.textContent = T > reveal[3] + 2.4 ? "answered · 2 of 2" : "2 questions";

    var readbackTimes = [reveal[4] + .4, reveal[4] + 1, reveal[4] + 1.5];
    readbackReveals.forEach(function (node, i) { node.style.opacity = progress(T, readbackTimes[i], .5).toFixed(3); });
    setOn(el.continuePill, T >= clickContinue); el.continuePill.textContent = T >= clickContinue ? "Continue ✓" : "Continue";
    subgoals.forEach(function (node, i) { node.style.opacity = progress(T, reveal[5] + .5 + i * .35, .4).toFixed(3); });
    setOn(el.generatePill, T >= clickGenerate); el.generatePill.textContent = T >= clickGenerate ? "Generate todos ✓" : "Generate todos";
    tasks.forEach(function (node, i) { node.style.opacity = progress(T, reveal[6] + .3 + i * .22, .3).toFixed(3); });
    setOn(el.acceptPill, T >= clickAccept); el.acceptPill.textContent = T >= clickAccept ? "Accept todos ✓" : "Accept todos";

    renderCursor(T, el.chatCursorLayer, el.chatCursor, el.chatRing, chatKeys, clicks, progress(T, .7, .4) * (1 - chatOut));

    el.generating.style.opacity = generatingIn.toFixed(3);
    el.generatingSpinner.style.transform = "rotate(" + ((T * 300) % 360).toFixed(1) + "deg)";
    generatingSteps.forEach(function (node, i) { node.style.opacity = progress(T, clickAccept + .75 + i * .25, .2).toFixed(3); });
    el.workLayer.style.opacity = workIn.toFixed(3);
    el.workLayer.style.transform = "scale(" + workScale.toFixed(3) + ")";
    el.workLayer.style.transformOrigin = "1070px 380px";

    var agentTwoDone = T >= C.Question + .6;
    var agentOneAsk = T >= C.Question + 1.2 && T < C.Answer + 1.35;
    var agentOneAnswered = T >= C.Answer + 1.15;
    var agentOneDone = T >= C.Complete + .9;
    var agentThreeDone = T >= C.Complete + 1.7;
    setAgentState(el.agentTwo, agentTwoDone ? "done" : "running", agentTwoDone ? "finished · 2m · 41k" : "running");
    setAgentState(el.agentOne, agentOneDone ? "done" : agentOneAsk ? "ask" : "running", agentOneDone ? "finished · 4m · 88k" : agentOneAsk ? "waiting on you" : "running");
    setAgentState(el.agentThree, agentThreeDone ? "done" : "running", agentThreeDone ? "finished · 6m · 120k" : "running");
    spinners.forEach(function (node) { node.style.transform = "rotate(" + ((T * 260) % 360).toFixed(1) + "deg)"; });

    agentLines.forEach(function (node) {
      var at = Number(node.getAttribute("data-at"));
      node.style.display = T >= at - .25 ? "block" : "none";
      node.style.opacity = progress(T, at, .28).toFixed(3);
    });
    el.agentQuestion.style.display = T >= C.Question + 1.05 && T < C.Answer + 1.9 ? "block" : "none";
    el.agentQuestion.style.opacity = progress(T, C.Question + 1.3, .35).toFixed(3);
    setOn(el.pwrChip, agentOneAnswered);

    el.goalStatus.textContent = agentOneDone ? "done" : agentOneAsk ? "needs you" : "in progress";
    el.activeCount.textContent = "Active " + (agentOneDone && agentThreeDone ? 0 : 1);
    el.doneCount.textContent = "Done " + (3 + (agentTwoDone ? 1 : 0) + (agentOneDone ? 1 : 0));
    setDone(el.dashboardGoal, T >= C.Question + .7, progress(T, C.Question + .7, .5));
    setDone(el.rodsGoal, agentOneDone, progress(T, C.Complete + .9, .5));
    el.rodsGoal.classList.toggle("active", !agentOneDone);
    setDone(el.mainGoal, T >= C.Complete + 2.2, progress(T, C.Complete + 2.2, .5));
    el.allDone.style.opacity = progress(T, C.Complete + 2.4, .6).toFixed(3);

    renderCursor(T, el.workCursorLayer, el.workCursor, el.workRing, workKeys, [C.Answer + 1.15], progress(T, C.Answer, .3) * (1 - progress(T, C.Answer + 2.2, .5)));
  }

  function resizeCanvas() {
    var scale = stage.clientWidth / 1280;
    canvas.style.transform = "scale(" + scale.toFixed(5) + ")";
  }
  resizeCanvas();
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(stage);
  else window.addEventListener("resize", resizeCanvas);

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var requestedTime = new URLSearchParams(window.location.search).get("demoTime");
  var hasRequestedTime = requestedTime !== null && isFinite(Number(requestedTime));
  var playing = !reduceMotion && !hasRequestedTime;
  var time = hasRequestedTime ? clamp(Number(requestedTime), 0, DURATION) : reduceMotion ? 24 : 0;
  var lastFrame = null;

  function setPlaybackLabel() {
    toggle.textContent = playing ? "Pause" : "Play";
    toggle.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
    toggle.classList.toggle("is-paused", !playing);
  }
  setPlaybackLabel();
  render(time);

  toggle.addEventListener("click", function () {
    playing = !playing;
    lastFrame = null;
    setPlaybackLabel();
  });

  document.addEventListener("visibilitychange", function () { lastFrame = null; });
  function tick(timestamp) {
    if (lastFrame == null) lastFrame = timestamp;
    if (playing) {
      time = (time + (timestamp - lastFrame) / 1000) % DURATION;
      render(time);
    }
    lastFrame = timestamp;
    window.requestAnimationFrame(tick);
  }
  window.requestAnimationFrame(tick);
})();
