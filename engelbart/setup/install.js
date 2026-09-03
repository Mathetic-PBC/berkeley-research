/* Install and Done: terminal instructions one at a time, a keyboard that shows
 * which keys to press, and a row to copy each command from.
 *
 *   window.EngelbartInstall.render(container, opts)
 *   window.EngelbartInstall.stop(container)
 *   window.EngelbartInstall.commands(os, code)
 *
 * render draws everything inside `container` and never touches the page
 * outside it. Rendering again into the same container replaces what was there
 * and stops its animation; stop() does only the latter, for a page that is
 * about to empty the container itself. Same CSP as setup.js: no inline style,
 * every look is a class in setup.css, state is a data-attribute toggled on a
 * node. The keyboard animates by toggling data-on on its key nodes; nothing
 * is rebuilt on a tick.
 *
 * opts: variant "install" | "bart"; code and expiresInSeconds for the connect
 * command; onDone() from the final button; onNewCode() from "Get a new code";
 * os / arch to skip the pickers (else the last pick, from localStorage). */
(function () {
  "use strict";

  var STORE = "engelbart.install";
  var TICK = 140;   // ms per animation frame; a keystroke is one frame lit, one dark

  var OSES = [
    { key: "mac", label: "macOS", ask: "Which Mac?", why: "Apple menu › About This Mac names the chip.",
      arches: [{ key: "arm64", label: "Apple Silicon", why: "M1 and later" }, { key: "x64", label: "Intel", why: "2020 and earlier" }] },
    { key: "windows", label: "Windows", ask: "Which Windows?", why: "Settings › System › About shows the system type.",
      arches: [{ key: "x64", label: "x64", why: "nearly every PC" }, { key: "arm64", label: "ARM", why: "Snapdragon laptops, Surface Pro X" }] },
    { key: "linux", label: "Linux", ask: "Which Linux?", why: "uname -m prints x86_64 or aarch64.",
      arches: [{ key: "x64", label: "x64", why: "x86_64" }, { key: "arm64", label: "ARM64", why: "aarch64, Raspberry Pi, Graviton" }] }
  ];
  function osOf(key) { return OSES.filter(function (o) { return o.key === key; })[0] || null; }
  function archOf(os, key) { return os ? os.arches.filter(function (a) { return a.key === key; })[0] || null : null; }

  // Which installer, and why. Mac and Linux take the curl installer the
  // landing page and README already give: it needs no Node or bun first,
  // verifies the binary's SHA-256, then runs `engelbart install "$@"`, so
  // `sh -s -- --code … --no-open` reaches the CLI (scripts/install.sh in
  // claude-plugins/engelbart forwards "$@"). The Done screen's
  // `bunx engelbart-cli --code …` presumes bun, which nothing on this page
  // installs, so that form is not used here. Windows takes the PowerShell
  // scriptblock form because `irm | iex` cannot forward arguments. --no-open
  // on every OS: the CLI would otherwise open its own setup page, and the
  // reader is already on it. The chip pick does not change a command; both
  // installers detect the architecture themselves.
  function commands(os, code) {
    var c = code || "XXXX-XXXX-XXXX";
    if (os === "windows") return {
      claude: "irm https://claude.ai/install.ps1 | iex",
      engelbart: "& ([scriptblock]::Create((irm https://berkeley.mathetic.com/engelbart/install.ps1))) --code " + c + " --no-open"
    };
    return {
      claude: "curl -fsSL https://claude.ai/install.sh | bash",
      engelbart: "curl -fsSL https://berkeley.mathetic.com/engelbart/install.sh | sh -s -- --code " + c + " --no-open"
    };
  }

  // --- helpers ---------------------------------------------------------------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function on(node, event, fn) { node.addEventListener(event, fn); return node; }
  function attr(node, name, value) { node.setAttribute(name, value); return node; }
  function button(cls, text) { var b = el("button", cls, text); b.type = "button"; return b; }
  function cta(label, fn) {
    var b = button("ob-cta");
    b.appendChild(el("span", "", label));
    b.appendChild(el("span", "ob-cta-arrow", "›"));
    return on(b, "click", fn);
  }

  // The same row as setup.js's cmdRow, left-aligned and wrapping for a step.
  function cmdRow(box, label, cmd) {
    box.appendChild(el("div", "ob-cap", label));
    var row = el("div", "ob-cmd ob-ins-cmd");
    row.appendChild(el("span", "ob-cmd-text", cmd));
    var copy = button("ob-cmd-copy", "Copy");
    on(copy, "click", function () {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      navigator.clipboard.writeText(cmd).then(function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1400); }, function () {});
    });
    row.appendChild(copy); box.appendChild(row);
  }

  // --- the keyboard ------------------------------------------------------------
  //
  // Three letter rows and a modifier row, as divs. A frame is the set of keys
  // lit for one tick; a sequence is the frames of one instruction, looped.

  var ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "enter"],
    ["shift", "z", "x", "c", "v", "b", "n", "m", "slash"]
  ];
  var BOTTOM = { mac: ["ctrl", "alt", "cmd", "space"], windows: ["ctrl", "win", "alt", "space"], linux: ["ctrl", "alt", "space"] };
  var WIDE = { enter: "wide", shift: "wide", space: "space", ctrl: "mod", alt: "mod", cmd: "mod", win: "mod" };

  function cap(os, key) {
    if (key === "enter") return "⏎";
    if (key === "shift") return "⇧";
    if (key === "slash") return "/";
    if (key === "space") return "";
    if (key === "cmd") return "⌘";
    if (key === "win") return "⊞";
    if (key === "ctrl") return os === "mac" ? "⌃" : "Ctrl";
    if (key === "alt") return os === "mac" ? "⌥" : "Alt";
    return key;
  }
  function keyOf(ch) { return ch === "/" ? "slash" : ch === " " ? "space" : ch.toLowerCase(); }

  function keyboard(os) {
    var kbd = el("div", "ob-ins-kbd"), keys = {};
    ROWS.concat([BOTTOM[os]]).forEach(function (row, i) {
      var r = attr(el("div", "ob-ins-krow"), "data-i", String(i + 1));
      row.forEach(function (k) {
        var node = attr(attr(el("div", "ob-ins-key", cap(os, k)), "data-key", k), "data-on", "0");
        if (WIDE[k]) attr(node, "data-w", WIDE[k]);
        keys[k] = node; r.appendChild(node);
      });
      kbd.appendChild(r);
    });
    var wrap = el("div", "ob-ins-kwrap");
    wrap.appendChild(kbd);
    var label = attr(el("div", "ob-ins-kcap", ""), "data-on", "0");
    wrap.appendChild(label);
    return { node: wrap, keys: keys, label: label };
  }

  function seq() {
    var frames = [];
    function push(keys, label, n) { for (var i = 0; i < n; i++) frames.push({ keys: keys, label: label }); }
    var s = {
      frames: frames,
      chord: function (keys, label) { push(keys, label, 3); push([], label, 2); return s; },
      press: function (key, label) { push([key], label, 2); push([], label, 2); return s; },
      type: function (word, label) {
        for (var i = 0; i < word.length; i++) { push([keyOf(word[i])], label, 1); push([], label, 1); }
        push([], label, 1); return s;
      },
      pause: function () { push([], "", 6); return s; }
    };
    return s;
  }

  // --- the steps ---------------------------------------------------------------

  function openStep(os, again) {
    var s = seq(), title = again ? "Open a new terminal" : "Open a terminal";
    if (os === "mac") {
      s.chord(["cmd", "space"], "⌘ Space").type("terminal", "Type Terminal").press("enter", "⏎").pause();
      return { title: title, sub: "Press ⌘ Space, type Terminal, then press ⏎.", frames: s.frames };
    }
    if (os === "windows") {
      s.press("win", "⊞").type("powershell", "Type PowerShell").press("enter", "⏎").pause();
      return { title: title, sub: "Press ⊞, type PowerShell, then press ⏎.", frames: s.frames };
    }
    s.chord(["ctrl", "alt", "t"], "Ctrl Alt T").pause();
    return { title: title, sub: "Press Ctrl Alt T.", frames: s.frames };
  }
  function pasteFrames(os) {
    var s = seq();
    if (os === "mac") s.chord(["cmd", "v"], "⌘ V");
    else if (os === "windows") s.chord(["ctrl", "v"], "Ctrl V");
    else s.chord(["ctrl", "shift", "v"], "Ctrl ⇧ V");
    return s.press("enter", "⏎").pause().frames;
  }
  function typeFrames(word, label) { return seq().type(word, label).press("enter", "⏎").pause().frames; }

  function steps(st) {
    var os = st.os.key, cmds = commands(os, st.opts.code);
    if (st.opts.variant === "bart") return [
      openStep(os, true),
      { title: "Start Claude Code", sub: "Type claude and press ⏎.", cmd: { label: "Run", text: "claude" }, frames: typeFrames("claude", "Type claude") },
      { title: "Open Engelbart", sub: "Type /bart and press ⏎. Engelbart picks up the project you just set up.", cmd: { label: "Then", text: "/bart" }, frames: typeFrames("/bart", "Type /bart") },
      { done: true, title: "You're set up.", sub: "Engelbart is running with your first project. Come back here any time to set up another.", button: "Done" }
    ];
    return [
      openStep(os, false),
      { title: "Install Claude Code", sub: "Copy this, paste it into the terminal, and press ⏎.", cmd: { label: "Claude Code", text: cmds.claude },
        hint: "Skip this if Claude Code is already installed.", frames: pasteFrames(os) },
      { title: "Install Engelbart and connect this account", sub: "Paste it and press ⏎. It installs Engelbart and pairs this account with your machine — no second sign-in.",
        cmd: { label: "Engelbart", text: cmds.engelbart }, code: true, frames: pasteFrames(os) },
      { done: true, title: "Engelbart is connected.", sub: "Once the command has finished, your machine is paired with this account and the project is ready.", button: "I've run it" }
    ];
  }

  // --- drawing -----------------------------------------------------------------

  function stopTimer(st) { if (st.timer != null) { clearInterval(st.timer); st.timer = null; } }

  function animate(st, kb, frames) {
    stopTimer(st);
    var lit = [], i = -1;
    function apply(frame) {
      lit.forEach(function (k) { if (kb.keys[k]) kb.keys[k].setAttribute("data-on", "0"); });
      lit = frame.keys;
      lit.forEach(function (k) { if (kb.keys[k]) kb.keys[k].setAttribute("data-on", "1"); });
      if (kb.label.textContent !== frame.label) kb.label.textContent = frame.label;
      kb.label.setAttribute("data-on", frame.label ? "1" : "0");
    }
    function tick() {
      // The page may have emptied the container without telling us.
      if (st.container.isConnected === false) { stopTimer(st); return; }
      i = (i + 1) % frames.length; apply(frames[i]);
    }
    tick();
    st.timer = setInterval(tick, TICK);
  }

  function remember(st) {
    try { window.localStorage.setItem(STORE, JSON.stringify({ os: st.os ? st.os.key : null, arch: st.arch ? st.arch.key : null })); } catch (e) {}
  }

  function drawOs(st) {
    var box = el("div", "ob-step");
    box.appendChild(el("div", "ob-count", "Install"));
    box.appendChild(el("div", "ob-title", "Which computer are you on?"));
    box.appendChild(el("div", "ob-sub", "The commands differ a little by system."));
    var opts = el("div", "ob-opts");
    OSES.forEach(function (o) {
      var row = attr(el("div", "ob-opt"), "data-on", st.os === o ? "1" : "0");
      row.appendChild(el("span", "ob-mark"));
      row.appendChild(el("span", "ob-opt-text", o.label));
      on(row, "click", function () { st.os = o; st.arch = null; st.phase = "arch"; remember(st); draw(st); });
      opts.appendChild(row);
    });
    box.appendChild(opts);
    return box;
  }

  function drawArch(st) {
    var box = el("div", "ob-step"), o = st.os;
    box.appendChild(el("div", "ob-count", o.label));
    box.appendChild(el("div", "ob-title", o.ask));
    box.appendChild(el("div", "ob-sub", "Not sure? " + o.why));
    var opts = el("div", "ob-opts");
    o.arches.forEach(function (a) {
      var row = attr(el("div", "ob-opt"), "data-on", st.arch === a ? "1" : "0");
      row.appendChild(el("span", "ob-mark"));
      row.appendChild(el("span", "ob-opt-text", a.label));
      row.appendChild(el("span", "ob-ins-opt-why", a.why));
      on(row, "click", function () { st.arch = a; st.phase = "step"; st.i = 0; remember(st); draw(st); });
      opts.appendChild(row);
    });
    box.appendChild(opts);
    var nav = el("div", "ob-nav");
    nav.appendChild(on(button("ob-arrow", "←"), "click", function () { st.phase = "os"; draw(st); }));
    box.appendChild(nav);
    return box;
  }

  function drawDone(st, step) {
    var box = el("div", "ob-step ob-done");
    box.appendChild(el("span", "ob-check", "✓"));
    box.appendChild(el("div", "ob-done-t", step.title));
    box.appendChild(el("div", "ob-done-s", step.sub));
    var acts = el("div", "ob-done-acts");
    acts.appendChild(on(button("ob-ghost", "Back"), "click", function () { st.i -= 1; draw(st); }));
    acts.appendChild(cta(step.button, function () { if (st.opts.onDone) st.opts.onDone(); }));
    box.appendChild(acts);
    return box;
  }

  function drawStep(st) {
    var all = steps(st), walk = all.filter(function (s) { return !s.done; }), step = all[st.i];
    if (step.done) return drawDone(st, step);
    var box = el("div", "ob-step");
    box.appendChild(el("div", "ob-count", "Step " + (st.i + 1) + " of " + walk.length + " · " + st.os.label + " · " + st.arch.label));
    box.appendChild(el("div", "ob-title", step.title));
    box.appendChild(el("div", "ob-sub", step.sub));
    if (step.cmd) cmdRow(box, step.cmd.label, step.cmd.text);
    if (step.code) {
      var mins = Math.round((st.opts.expiresInSeconds || 900) / 60);
      var row = attr(el("div", "ob-actions"), "data-between", "1");
      row.appendChild(el("span", "ob-hint", "The code works once and expires in " + mins + " minutes."));
      row.appendChild(on(button("ob-ghost", "Get a new code"), "click", function () { if (st.opts.onNewCode) st.opts.onNewCode(); }));
      box.appendChild(row);
    }
    if (step.hint) box.appendChild(el("div", "ob-hint ob-ins-hint", step.hint));
    var kb = keyboard(st.os.key);
    box.appendChild(kb.node);
    var nav = el("div", "ob-nav");
    nav.appendChild(on(button("ob-arrow", "←"), "click", function () {
      if (st.i === 0) { st.phase = "arch"; } else { st.i -= 1; }
      draw(st);
    }));
    var pd = el("span", "ob-pdots");
    walk.forEach(function (_, i) {
      var d = attr(attr(el("span", "ob-pdot"), "data-on", i === st.i ? "1" : "0"), "data-done", i < st.i ? "1" : "0");
      on(d, "click", function () { st.i = i; draw(st); }); pd.appendChild(d);
    });
    nav.appendChild(pd);
    nav.appendChild(cta("Continue", function () { st.i += 1; draw(st); }));
    box.appendChild(nav);
    st.frames = step.frames; st.kb = kb;
    return box;
  }

  function draw(st) {
    stopTimer(st);
    st.frames = null; st.kb = null;
    var box = st.phase === "os" ? drawOs(st) : st.phase === "arch" ? drawArch(st) : drawStep(st);
    st.container.textContent = "";
    st.container.appendChild(box);
    if (st.frames) animate(st, st.kb, st.frames);
  }

  // --- the api -----------------------------------------------------------------

  function stop(container) {
    var st = container && container.__engelbartInstall;
    if (st) stopTimer(st);
  }

  function render(container, opts) {
    opts = opts || {};
    stop(container);
    var st = { container: container, opts: opts, os: null, arch: null, phase: "os", i: 0, timer: null };
    var os = opts.os, arch = opts.arch;
    if (!os) {
      try {
        var raw = window.localStorage ? window.localStorage.getItem(STORE) : null;
        if (raw) { var v = JSON.parse(raw); os = v.os; arch = v.arch; }
      } catch (e) { os = null; arch = null; }
    }
    st.os = osOf(os);
    st.arch = archOf(st.os, arch);
    st.phase = !st.os ? "os" : !st.arch ? "arch" : "step";
    container.__engelbartInstall = st;
    draw(st);
    return { stop: function () { stopTimer(st); } };
  }

  var api = { render: render, stop: stop, commands: commands };
  if (typeof window !== "undefined") window.EngelbartInstall = api;
})();
