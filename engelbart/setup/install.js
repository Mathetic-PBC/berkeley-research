/* Install and Done: terminal instructions one at a time, the keys to press
 * stated as key chips, and a row to copy each command from.
 *
 *   window.EngelbartInstall.render(container, opts)
 *   window.EngelbartInstall.stop(container)
 *   window.EngelbartInstall.commands(os, code)
 *
 * render draws everything inside `container` and never touches the page
 * outside it. Rendering again into the same container replaces what was
 * there. stop() is kept for the page that calls it before emptying the
 * container; nothing animates any more, so it has nothing to do. Same CSP as
 * setup.js: no inline style, every look is a class in setup.css, state is a
 * data-attribute toggled on a node.
 *
 * opts: variant "install" | "bart"; code and expiresInSeconds for the connect
 * command; onDone() from the final button; onNewCode() from "Get a new code";
 * os / arch to skip the pickers (else the last pick, from localStorage). */
(function () {
  "use strict";

  var STORE = "engelbart.install";
  // Where the reader is in the walk, kept across renders: the page redraws
  // its whole column on any click (an "Ask about this" offer, the register
  // control), and each redraw renders this module into a fresh container. A
  // walk that forgot its step on every redraw would snap back to "Open a
  // terminal" each time.
  var LAST = null;

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
  // claude-plugins/engelbart forwards "$@"). Windows takes the PowerShell
  // scriptblock form because `irm | iex` cannot forward arguments. --no-open
  // on every OS: the CLI would otherwise open its own setup page, and the
  // reader is already on it. The chip pick does not change a command; both
  // installers detect the architecture themselves. There is no separate
  // Claude Code command: the installer puts Claude Code in place itself when
  // the machine has none, and updates one that is too old.
  function commands(os, code) {
    var c = code || "XXXX-XXXX-XXXX";
    if (os === "windows") return {
      engelbart: "& ([scriptblock]::Create((irm https://berkeley.mathetic.com/engelbart/install.ps1))) --code " + c + " --no-open"
    };
    return {
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

  // --- the keys ------------------------------------------------------------------
  //
  // What to press, stated rather than acted out: a chord is its keys as
  // chips, side by side; a thing to type is said in words; "then" sits
  // between the parts. A drawn keyboard lighting up letter by letter told the
  // reader less than this line does and took longer to say it.

  function keysRow(how) {
    var row = el("div", "ob-ins-keys");
    how.forEach(function (part, i) {
      if (i) row.appendChild(el("span", "ob-ins-then", "then"));
      if (part.keys) {
        var chord = el("span", "ob-ins-chord");
        part.keys.forEach(function (k) { chord.appendChild(el("kbd", "ob-kbd", k)); });
        row.appendChild(chord);
      } else {
        row.appendChild(el("span", "ob-ins-say", part.text));
      }
    });
    return row;
  }

  // --- the steps ---------------------------------------------------------------

  function openStep(os, again) {
    var title = again ? "Open a new terminal" : "Open a terminal";
    if (os === "mac") return { title: title, sub: "Press ⌘ Space, type Terminal, then press ⏎.",
      how: [{ keys: ["⌘", "Space"] }, { text: "type Terminal" }, { keys: ["⏎"] }] };
    if (os === "windows") return { title: title, sub: "Press ⊞, type PowerShell, then press ⏎.",
      how: [{ keys: ["⊞"] }, { text: "type PowerShell" }, { keys: ["⏎"] }] };
    return { title: title, sub: "Press Ctrl Alt T.", how: [{ keys: ["Ctrl", "Alt", "T"] }] };
  }
  function pasteHow(os) {
    var paste = os === "mac" ? ["⌘", "V"] : os === "windows" ? ["Ctrl", "V"] : ["Ctrl", "⇧", "V"];
    return [{ keys: paste }, { keys: ["⏎"] }];
  }
  function typeHow(word) { return [{ text: "type " + word }, { keys: ["⏎"] }]; }

  function steps(st) {
    var os = st.os.key, cmds = commands(os, st.opts.code);
    if (st.opts.variant === "bart") return [
      openStep(os, true),
      { title: "Start Claude Code", sub: "Type claude and press ⏎.", cmd: { label: "Run", text: "claude" }, how: typeHow("claude") },
      { title: "Trust the folder", sub: "Claude Code asks whether you trust the folder it opened in. Choose “Yes, I trust this folder” with ↓, then press ⏎.", how: [{ keys: ["↓"] }, { keys: ["⏎"] }] },
      { title: "Open Engelbart", sub: "Type /bart and press ⏎.", cmd: { label: "Then", text: "/bart" }, how: typeHow("/bart") },
      { done: true, title: "You're set up.", sub: "", button: "Done" }
    ];
    return [
      openStep(os, false),
      { title: "Install Engelbart and connect this account",
        sub: "Copy the command, paste it into the terminal, and press ⏎. It installs Claude Code if this machine has none, installs Engelbart, and pairs this account with your machine — no second sign-in.",
        cmd: { label: "Engelbart", text: cmds.engelbart }, code: true, how: pasteHow(os) },
      { done: true, title: "Engelbart is connected.", sub: "", button: "I've run it" }
    ];
  }

  // --- drawing -----------------------------------------------------------------

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
    if (step.sub) box.appendChild(el("div", "ob-done-s", step.sub));
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
    if (step.how) box.appendChild(keysRow(step.how));
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
    return box;
  }

  function draw(st) {
    var box = st.phase === "os" ? drawOs(st) : st.phase === "arch" ? drawArch(st) : drawStep(st);
    st.container.textContent = "";
    st.container.appendChild(box);
    LAST = { variant: st.opts.variant || "install", os: st.os ? st.os.key : null, arch: st.arch ? st.arch.key : null, phase: st.phase, i: st.i };
  }

  // --- the api -----------------------------------------------------------------

  function stop(container) { void container; }

  function render(container, opts) {
    opts = opts || {};
    var st = { container: container, opts: opts, os: null, arch: null, phase: "os", i: 0 };
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
    if (LAST && LAST.variant === (opts.variant || "install") && LAST.os === (st.os ? st.os.key : null) && LAST.arch === (st.arch ? st.arch.key : null)) {
      st.phase = LAST.phase; st.i = LAST.i;
    }
    container.__engelbartInstall = st;
    draw(st);
    return { stop: function () {} };
  }

  var api = { render: render, stop: stop, commands: commands };
  if (typeof window !== "undefined") window.EngelbartInstall = api;
})();
