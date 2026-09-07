/* The Engelbart debugger: the real setup page running in a frame against the
 * simulated control plane (sim-backend.js), with every request and every
 * operation the simulated server ran drawn beside it as a data-flow graph,
 * a request list and an inspector. Flattened from the Claude Design file
 * "Engelbart Debugger.dc.html": the component's logic is the design's, the
 * <x-dc> template is written out below as React.createElement calls, and the
 * style-hover / style-focus rules live in debugger.css.
 *
 * Two modes, one debugger. In Simulated mode nothing here reaches a real
 * server: the frame answers /api and the fake Supabase host in-page, and state
 * lives in this browser's localStorage. In Real mode the same frame runs the
 * same setup page against the real endpoints as the signed-in member, and
 * every request it makes does real work: model calls spend real credit,
 * writes land in the member's onboarding, uploads go to Storage. The frame
 * reports each request as it starts and ends, with the trace id the server
 * named in its reply; the trace's persisted telemetry is then read through
 * /api/engelbart-telemetry (real-runs.js) and placed under that request in the
 * same request list and inspector the simulator uses. Reading telemetry never
 * changes anything; the simulator's own controls are not offered in Real mode. */
(function () {
  "use strict";
  var root = document.getElementById("debugger");
  if (!window.React || !window.ReactDOM) {
    root.innerHTML = "<div class=\"unavailable\">The debugger needs React from cdn.jsdelivr.net, which did not load. Check the network and reload.</div>";
    return;
  }
  var h = React.createElement;
  var SANS = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  var SANSF = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  var MONO = "'Source Code Pro',ui-monospace,Menlo,monospace";
  var MONO2 = "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace";
  var EYEBROW = "display:block;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f";
  var FIELD = "display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fafafa;outline:none;font:13px/1.5 " + SANS + ";color:#171717";
  var LINK_BTN = "padding:0;border:none;background:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#8f8f8f;white-space:nowrap";

  // The template wrote styles as CSS text; React wants objects. Parsed once per distinct string.
  var styleCache = new Map();
  function css(text) {
    if (!text) return undefined;
    var hit = styleCache.get(text); if (hit) return hit;
    var o = {};
    String(text).split(";").forEach(function (decl) {
      var i = decl.indexOf(":"); if (i < 0) return;
      var k = decl.slice(0, i).trim(), v = decl.slice(i + 1).trim(); if (!k) return;
      o[k.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = v;
    });
    if (styleCache.size > 4000) styleCache.clear();
    styleCache.set(text, o); return o;
  }
class Debugger extends React.Component {
  constructor(props) {
    super(props);
    this.KINDS = {
      api: { label: "API", color: "#171717", bg: "#eaeaea", title: "Outbound HTTP to the LiteLLM admin API" },
      model: { label: "Model", color: "oklch(0.44 0.17 300)", bg: "oklch(0.95 0.035 300)", title: "A model call through the member's LiteLLM key" },
      db: { label: "DB", color: "oklch(0.42 0.11 215)", bg: "oklch(0.95 0.03 215)", title: "Supabase Auth and PostgREST reads and writes" },
      storage: { label: "Storage", color: "oklch(0.48 0.13 60)", bg: "oklch(0.95 0.035 60)", title: "Supabase Storage, bucket berkeley-papers" },
      web: { label: "Web", color: "oklch(0.46 0.13 150)", bg: "oklch(0.95 0.035 150)", title: "Fetches to the public web: page text, link checks" },
      processing: { label: "Proc", color: "#4d4d4d", bg: "#f2f2f2", title: "Work inside the function: validation, crypto, normalizing, compiling" }
    };
    this.KNOBS = [
      { key: "gradeModel", label: "Grader model", desc: "onboarding-model.js grade(): the family that scores an answer against its sample.", options: [["haiku", "haiku"], ["sonnet", "sonnet"]] },
      { key: "followUpGap", label: "Follow-up threshold", desc: "onboarding.js answer(): a follow-up is written when the grade disagrees with the self-rating by at least this many points.", options: [[25, "25"], [50, "50"]] },
      { key: "linkChecks", label: "Verify links", desc: "onboarding.js verifyLinks(): HEAD every link the hunt returned, budget 40, drop 404 and 410.", options: [[true, "on"], [false, "off"]] },
      { key: "readyGate", label: "Plan offer gate", desc: "brainstorm(): use model readiness with a two-response cap, or force readiness immediately; neither depends on resource fitting.", options: [["model", "model"], ["always", "always"]] },
      { key: "depthShift", label: "Register shift", desc: "assessedDepth(): move the register one stop from the graded mean, or leave the reader's chosen depth alone.", options: [[true, "on"], [false, "off"]] },
      { key: "cachePaper", label: "Cache the paper prefix", desc: "paperPrefix(): cache_control ephemeral on the PDF block, so the hunt reads the reading's cache.", options: [[true, "on"], [false, "off"]] },
      { key: "reconcileBlock", label: "Reconcile the LiteLLM gate", desc: "credits.js reconcileBlock(): /key/info carries no `blocked`, so the verdict is asserted on every credential read.", options: [[true, "on"], [false, "off"]] }
    ];
    this.SPEEDS = [{ key: "1", label: "1×", value: 1 }, { key: "4", label: "4×", value: 0.25 }, { key: "i", label: "instant", value: 0.02 }];
    // Simulated mode opens on the environments dashboard: nothing is open, so no product frame is mounted and
    // no simulated backend runs until an environment is chosen. Real mode has no environments; its frame boots by itself.
    this.state = Object.assign({ envs: this.loadEnvs(), tab: "live", notice: "", realPrompts: this.loadRealPrompts(), promptSel: null, hideKinds: {}, cases: this.loadCases(),
      caseOpen: null, knobs: Object.assign({}, window.EngelbartSim.DEFAULT_KNOBS), running: false, compare: null, cmpOpen: {}, inspTab: "output", speedKey: "1", copied: false, stick: true,
      picking: false, flowModal: false, detailModal: false, mode: this.loadMode(), frameKey: 1,
      real: this.freshReal() }, this.envState(null));
    // Real mode starts on an empty session; the simulator's tabs wait in the environment's storage.
    if (this.state.mode === "real") Object.assign(this.state, this.realRecordingState(this.state.real), { view: "requests", inspTab: "input", open: {} });
    this.realClient = window.EGB_REAL ? window.EGB_REAL.client() : null;
    this.frameRef = React.createRef(); this.bodyRef = React.createRef(); this.listRef = React.createRef(); this.flowScrollRef = React.createRef();
    this.pending = []; this.flushTimer = null;
    this.onMessage = this.onMessage.bind(this);
  }
  // --- runs and events -----------------------------------------------------------
  newRun(name, knobs) { return { id: "run-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name, knobs: knobs || Object.assign({}, window.EngelbartSim.DEFAULT_KNOBS), stages: [], requests: [], startedAt: null, seed: null, trigger: null, presses: 0 }; }
  // Tabs are buttons in the product. The first tab holds everything before an assigned button is pressed;
  // every other tab is one button, and pressing it wipes that tab and records what follows into it.
  target() { const r = this.state.recordings; return r.find(x => x.id === this.state.targetId) || r[r.length - 1]; }
  viewed() { return this.state.recordings[Math.min(this.state.viewing, this.state.recordings.length - 1)]; }
  normText(t) { return String(t || "").replace(/[›‹✓·×⌃←↓]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40); }
  // --- environment configuration: what the popup edits ------------------------------------------------------
  // The real templates, ported verbatim from api/_lib/onboarding-prompts.js; {{slots}} are what the server fills in.
  PROMPTS() { const P = window.EGB_PROMPTS; return P.ORDER.map(k => [k, P.LABELS[k], P.TEMPLATES[k]]); }
  // Every prompt a model call can name, in the order the reader meets them: the eleven editable ones, then
  // the three the server keeps to itself. A run recorded before prompts were named is placed by its purpose.
  PROMPT_LABEL(key) { const P = window.EGB_PROMPTS; return P.LABELS[key] || { detailsPrompt: "Ask the project questions", goalsPrompt: "Propose the goals", assetAskPrompt: "Answer a question about a resource" }[key] || key; }
  PROMPT_ORDER() { return window.EGB_PROMPTS.ORDER.concat(["assetAskPrompt", "detailsPrompt", "goalsPrompt"]); }
  templateOf(o) {
    if (!o || o.kind !== "model") return null;
    if (o.real) { const a = o.attributes || {}; if (a["engelbart.prompt.template"]) return a["engelbart.prompt.template"]; const purpose = o.meta && o.meta.purpose; return purpose ? { analysis: "analyzePrompt", grade: "gradePrompt", follow_up: "followUpPrompt", assets: "assetsPrompt", leveled: "levelPrompt", brainstorm: "brainstormPrompt", asset_ask: "assetAskPrompt", direction: "directionPrompt", subgoals: "subgoalsPrompt", details: "detailsPrompt", goals: "goalsPrompt", todos: "todosPrompt", ask: "askPrompt", rewrite: "rewritePrompt" }[purpose] || purpose : null; }
    return (o.input && o.input.template) || null;
  }
  promptEdited(o) { return !!(o.real ? (o.attributes || {})["engelbart.prompt.edited"] : o.input && o.input.template_edited); }
  // One model call in the Prompts view: the message as the model received it (a document block stands in for
  // the paper), and the reply as parsed; a recorded call reads both from its snapshots as the inspector does.
  promptCallVM(st, o) {
    const textOf = (req) => { const body = req && req.body ? req.body : req; const msgs = body && body.messages; if (!Array.isArray(msgs) || !msgs.length) return typeof req === "string" ? req : req ? JSON.stringify(req, null, 2) : "";
      const blocks = Array.isArray(msgs[0].content) ? msgs[0].content : [{ type: "text", text: String(msgs[0].content || "") }];
      return blocks.map(b => b.type === "text" ? String(b.text || "") : b.type === "document" ? "[the paper, as a PDF document block" + (b.source && b.source.source_ref && b.source.source_ref["[bytes]"] ? " · " + Math.round(b.source.source_ref["[bytes]"] / 1024) + " KB" : "") + "]" : "[" + (b.type || "block") + "]").join("\n\n"); };
    const show = (v) => v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    let input, output, note = "";
    if (o.real) {
      const si = o.snaps.input ? this.snapshot(o.snaps.input) : { state: "none" }, so = o.snaps.output ? this.snapshot(o.snaps.output) : { state: "none" };
      const read = (x, what) => x.state === "ready" ? null : x.state === "pending" ? "Loading " + what + "…" : x.state === "missing" ? "This " + what + " was not stored." : x.state === "none" ? "No " + what + " was recorded." : "This " + what + " could not be read.";
      input = read(si, "request") || textOf(si.content); output = read(so, "reply") || show(so.content);
      if (si.state === "ready" && si.redacted) note = "credentials redacted before it was stored";
    } else { input = textOf(o.input); output = o.status === "running" ? "…" : show(o.output); }
    const t = (o.meta && o.meta.tokens) || {}, cost = o.meta && o.meta.cost;
    const meta = [o.meta && (o.meta.model || o.meta.family) || "", t.input != null ? t.input.toLocaleString() + " in" : "", t.output != null ? t.output.toLocaleString() + " out" : "", cost ? this.fmtCost(cost) : "", o.status === "running" ? "running" : this.fmtMs(o.ms)].filter(Boolean).join(" · ");
    return { id: o.id, when: this.clock(o.at), where: st.label + (st.step ? " · " + st.step : ""), meta: meta, edited: this.promptEdited(o), badge: this.promptEdited(o) ? "edited prompt" : "", status: o.status, error: o.error ? String(o.error) : "", note: note,
      input: input, output: output, hasOutput: !!output,
      open: () => { const open = Object.assign({}, this.state.open); open[st.id] = true; this.setState({ open: open, view: "requests", inspTab: "input" }); this.select("live", st.id, o.id); } };
  }
  // Real mode: which environment's edited prompts the product's model calls use, remembered in this browser;
  // "" is the server's own. Sent to the frame when it is ready and whenever the choice changes.
  loadRealPrompts() { try { return window.localStorage.getItem("egb.debugger.realPrompts") || ""; } catch (e) { return ""; } }
  realOverrides(id) {
    const env = this.state.envs.find(e => e.id === (id === undefined ? this.state.realPrompts : id)), p = env && env.config && env.config.prompts;
    return p && Object.keys(p).length ? p : null;
  }
  pickRealPrompts(id) {
    const chosen = this.state.envs.some(e => e.id === id) ? id : "";
    try { if (chosen) window.localStorage.setItem("egb.debugger.realPrompts", chosen); else window.localStorage.removeItem("egb.debugger.realPrompts"); } catch (e) {}
    this.setState({ realPrompts: chosen }); if (this.state.connected) this.cmd("prompts", this.realOverrides(chosen) || {});
  }
  YEARS() { return ["First year", "Second year", "Third year", "Fourth year"]; }
  MAJORS() { return ["Computer Science", "Electrical Engineering & Computer Sciences", "Data Science", "Cognitive Science", "Molecular & Cell Biology", "Bioengineering", "Mechanical Engineering", "Applied Mathematics", "Statistics", "Physics", "Economics", "Business Administration", "Political Science", "Psychology", "Public Health", "English", "History", "Sociology", "Architecture", "Undeclared"]; }
  DEPTHS() { return [["everyday", "Everyday"], ["some", "Some detail"], ["technical", "Technical"], ["expert", "Expert"]]; }
  FAMS() { return ["I'm completely lost", "I wouldn't know where to start", "I can get oriented", "I can get started", "I can extend it"]; }
  defaultConfig() { return { description: "", notes: "", prompts: {}, participant: { enabled: false, name: "", year: "Second year", major: "", depth: "some", paperFamiliarity: 1, projectUrl: "", repoUrl: "", paper: null } }; }
  // The popup edits a draft; Save writes it to the environment (creating it in "new" mode). A card on the
  // dashboard configures its own environment, which need not be the open one; the dropdown configures the open one.
  openConfig(mode, envId) {
    const id = envId || this.state.envId, env = this.state.envs.find(e => e.id === id);
    const base = mode === "new" ? Object.assign({ name: "" }, this.defaultConfig()) : Object.assign({ name: env ? env.name : "" }, this.defaultConfig(), env && env.config || {});
    base.participant = Object.assign(this.defaultConfig().participant, base.participant || {}); base.prompts = Object.assign({}, base.prompts || {});
    this.setState({ config: { mode: mode, envId: id, draft: base, section: "about" } });
  }
  setDraft(path, value) { const c = this.state.config; if (!c) return; const d = JSON.parse(JSON.stringify(c.draft)); let o = d; const parts = path.split("."); for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts[parts.length - 1]] = value; this.setState({ config: Object.assign({}, c, { draft: d }) }); }
  saveConfig() {
    const c = this.state.config; if (!c) return; const d = c.draft;
    const defaults = {}; this.PROMPTS().forEach(([k, l, def]) => { defaults[k] = def; });
    const prompts = {}; Object.keys(d.prompts || {}).forEach(k => { if (d.prompts[k] != null && d.prompts[k] !== defaults[k]) prompts[k] = d.prompts[k]; });
    const config = { description: d.description, notes: d.notes, prompts: prompts, participant: d.participant };
    if (c.mode === "new") { this.setState({ config: null }); this.createEnv(d.name, config); return; }
    const envs = this.state.envs.map(e => e.id === c.envId ? Object.assign({}, e, { name: (d.name || "").trim() || e.name, config: config }) : e); this.persistEnvs(envs);
    // The running product carries the open environment's prompts; another environment's take effect when it opens.
    this.setState({ envs: envs, config: null }); if (c.envId === this.state.envId) this.cmd("prompts", config.prompts);
  }
  participantParam(config) { const p = config && config.participant; return p && p.enabled ? "&p=" + encodeURIComponent(JSON.stringify({ name: p.name, year: p.year, major: p.major, depth: p.depth, paperFamiliarity: Number(p.paperFamiliarity) || 0, projectUrl: p.projectUrl, repoUrl: p.repoUrl, paper: p.paper || null })) : ""; }
  // --- test environments: each has its own simulated account, steps, notes and layout -----------------------
  // The dashboard lists them as cards and is where Simulated mode lands; envId null means the dashboard is on
  // screen and nothing runs. Opening one restores its state and mounts the product against its account.
  loadEnvs() { try { return JSON.parse(window.localStorage.getItem("egb.debugger.envs.v1") || "[]"); } catch (e) { return []; } }
  persistEnvs(envs) { try { window.localStorage.setItem("egb.debugger.envs.v1", JSON.stringify(envs)); } catch (e) {} }
  envKey(id) { return "egb.debugger.env." + id; }
  // What an environment keeps between visits: its step tabs with everything recorded, notes, and the graph layout.
  saveEnvData() {
    if (this.state.mode === "real") return;
    const id = this.state.envId; if (!id) return;
    const S = this.state, data = { recordings: S.recordings, targetId: S.targetId, viewing: S.viewing, notes: S.notes, flowPos: S.flowPos, flowPan: S.flowPan, flowZoom: S.flowZoom, flowHeight: S.flowHeight };
    try { window.localStorage.setItem(this.envKey(id), JSON.stringify(data)); } catch (e) { this.setState({ notice: "This environment is too large to keep in browser storage; older steps may be lost on reload." }); }
    const envs = this.state.envs.map(e => e.id === id ? Object.assign({}, e, { lastUsedAt: Date.now(), stats: this.envStats(S.recordings) }) : e); this.persistEnvs(envs);
    if (JSON.stringify(envs) !== JSON.stringify(this.state.envs)) this.setState({ envs: envs });
  }
  scheduleSave() { if (this.state.mode === "real") return; clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveEnvData(), 800); }
  envStats(recs) { const all = []; recs.forEach(r => r.stages.forEach(s => all.push(s))); const t = this.totals(all); return { steps: recs.filter(r => r.step && r.stages.length).length, requests: t.requests, model: t.model, cost: t.cost, ms: t.ms }; }
  loadEnvData(id) { try { return JSON.parse(window.localStorage.getItem(this.envKey(id)) || "null"); } catch (e) { return null; } }
  blankEnv(name, config) { return { id: "env-" + Date.now().toString(36), name: (name || "").trim() || "Environment", createdAt: Date.now(), lastUsedAt: Date.now(), stats: { steps: 0, requests: 0, model: 0, cost: 0, ms: 0 }, config: config || this.defaultConfig() }; }
  // The state slice an environment restores: its step tabs, notes and graph layout. With no id, the dashboard's:
  // nothing open, and a blank Start tab so the panel has something to draw.
  envState(id) {
    const d = id ? this.loadEnvData(id) : null, tabs = d && Array.isArray(d.recordings) && d.recordings.length ? d.recordings : this.loadTabs();
    return { envId: id, recordings: tabs, targetId: d && d.targetId || tabs[0].id, viewing: Math.min(d && d.viewing || 0, tabs.length - 1), notes: d && d.notes || {}, flowPos: d && d.flowPos || {}, flowPan: d && d.flowPan || { x: 0, y: 0 }, flowZoom: d && d.flowZoom || 1, flowHeight: d && d.flowHeight || null,
      sel: null, flowSel: null, open: {}, connected: false, view: "flow" };
  }
  // Leaving the open environment: events the frame reported but has not yet drawn are drawn, then everything it
  // has is saved; the connection bookkeeping is cleared for whatever frame comes next.
  leaveEnv() {
    if (this.state.envId && !this.isReal()) { clearTimeout(this.flushTimer); this.flushTimer = null; if (this.pending.length) this.flush(); clearTimeout(this.saveTimer); this.saveEnvData(); }
    this.pending.splice(0); this.connectedAt = null; this.lastPress = null; this.wheelEl = null;
  }
  // Opening one saves whatever was open, restores the chosen environment's state and mounts the product against
  // its simulated account; the moment it was opened is what the dashboard orders its cards by.
  openEnv(id) {
    this.leaveEnv();
    const envs = this.state.envs.map(e => e.id === id ? Object.assign({}, e, { lastUsedAt: Date.now() }) : e); this.persistEnvs(envs);
    this.setState(Object.assign({ envs: envs }, this.envState(id)));
  }
  // All environments…: save what is open and return to the dashboard; the product frame unmounts with it.
  closeEnv() { this.leaveEnv(); this.setState(this.envState(null)); }
  createEnv(name, config) {
    const env = this.blankEnv(name || ("Environment " + (this.state.envs.length + 1)), config);
    const envs = [env].concat(this.state.envs); this.persistEnvs(envs); this.setState({ envs: envs }, () => this.openEnv(env.id));
  }
  // Deleting removes the record, the saved state and the simulated account. Deleting the open environment
  // returns to the dashboard; nothing of it is saved on the way out.
  deleteEnv(env) {
    if (!env || !window.confirm("Delete “" + env.name + "”? Its simulated account, steps and notes are removed.")) return;
    const open = this.state.envId === env.id;
    if (open) { clearTimeout(this.flushTimer); this.flushTimer = null; clearTimeout(this.saveTimer); this.pending.splice(0); this.connectedAt = null; this.lastPress = null; this.wheelEl = null; }
    try { window.localStorage.removeItem(this.envKey(env.id)); window.localStorage.removeItem("egb.sim.db." + env.id); } catch (e) {}
    const envs = this.state.envs.filter(e => e.id !== env.id); this.persistEnvs(envs);
    this.setState(open ? Object.assign({ envs: envs }, this.envState(null)) : { envs: envs });
  }
  // Resetting from the dashboard: the environment's simulated account and step tabs go, its name, participant,
  // prompts, notes and graph zoom stay. (The open environment resets from its own bar, where the product reloads too.)
  resetEnv(env) {
    if (!env || !window.confirm("Reset “" + env.name + "”? Its simulated account's setup is dropped and every step tab is cleared; its name, participant, prompts and notes stay.")) return;
    const d = this.loadEnvData(env.id) || {}, tabs = this.loadTabs();
    const data = { recordings: tabs, targetId: tabs[0].id, viewing: 0, notes: d.notes || {}, flowPos: {}, flowPan: { x: 0, y: 0 }, flowZoom: d.flowZoom || 1, flowHeight: d.flowHeight || null };
    try { window.localStorage.removeItem("egb.sim.db." + env.id); window.localStorage.setItem(this.envKey(env.id), JSON.stringify(data)); } catch (e) {}
    const envs = this.state.envs.map(e => e.id === env.id ? Object.assign({}, e, { stats: this.envStats(tabs) }) : e); this.persistEnvs(envs);
    this.setState({ envs: envs });
  }
  // A card on the dashboard: what the environment is set up as, and what it has recorded so far.
  envCard(e) {
    const p = e.config && e.config.participant, st = e.stats || {}, edited = Object.keys(e.config && e.config.prompts || {}).length;
    const when = e.lastUsedAt || e.createdAt, sameDay = new Date(when).toDateString() === new Date().toDateString();
    const dateLabel = sameDay ? this.clock(when) : new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + this.clock(when).replace(/:\d\d (AM|PM)$/, " $1");
    const participant = p && p.enabled ? [p.name || "Unnamed participant", p.year, p.major].filter(Boolean).join(" · ") + " · opens at the Paper step" : "Fresh participant · opens at the Start step";
    return { id: e.id, name: e.name, meta: (e.lastUsedAt ? "Last opened " : "Created ") + dateLabel + (edited ? " · " + edited + (edited === 1 ? " prompt edited" : " prompts edited") : ""),
      hasDescription: !!(e.config && e.config.description), description: e.config && e.config.description || "",
      participant: participant,
      stats: [{ k: "steps", v: String(st.steps || 0) }, { k: "requests", v: String(st.requests || 0) }, { k: "model calls", v: String(st.model || 0) }, { k: "est. cost", v: st.cost ? this.fmtCost(st.cost) : "$0" }, { k: "server time", v: this.fmtMs(st.ms) === "—" ? "0 ms" : this.fmtMs(st.ms) }],
      open: () => this.openEnv(e.id),
      configure: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); this.openConfig("edit", e.id); },
      reset: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); this.resetEnv(e); },
      remove: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); this.deleteEnv(e); } };
  }
  // One tab per onboarding step. The product reports which step is on screen; requests made while it
  // is there land in that step's tab. "Start" holds what happens before the first step is drawn.
  loadTabs() { const start = this.newRun("Start"); start.id = "start"; return [start]; }
  persistTabs() {}
  // Arriving at a step opens nothing: the tab appears, and the view moves, only when the reader first
  // acts there. Until then the view stays on the step whose press caused what is on screen.
  stepShown(label) { void label; }
  openStep(label, arrived) {
    const ORDER = ["Start", "Name", "Year", "Major", "Explanations", "Paper", "Install", "Topics", "Brainstorm", "Assets", "Direction", "Subgoals", "Todos", "Done"];
    if (!label) return;
    const recs = this.state.recordings.slice();
    let r = recs.find(x => x.step === label);
    if (!r) {
      r = this.newRun(label); r.id = "step-" + label; r.step = label; r.visits = 0;
      recs.push(r); recs.sort((a, b) => (a.step ? ORDER.indexOf(a.step) : -1) - (b.step ? ORDER.indexOf(b.step) : -1));
    }
    if (arrived) r.visits = (r.visits || 0) + 1;
    if (!r.seed) this.cmd("snapshot");
    if (this.state.targetId === r.id && this.viewed() === r && recs.length === this.state.recordings.length) return;
    this.setState({ recordings: recs, targetId: r.id, viewing: recs.indexOf(r), sel: null, stick: true, tab: "live", flowSel: null });
  }
  // A press on a step: that step's tab exists from now on and receives what the press does; when the
  // product then moves on, the new step's tab opens empty and takes over.
  pressed(step) {
    this.lastPress = Date.now();
    if (!this.connectedAt) return;
    this.openStep(step, false);
  }
  matches(t, k) { return !!t && !!k && t.cls === k.cls && (!t.text || t.text === k.text); }
  // The assigned button was pressed: its tab starts over and becomes the one that records.
  buttonPressed(k) {
    const recs = this.state.recordings.slice();
    let i = recs.findIndex(r => this.matches(r.trigger, k));
    const prev = i >= 0 ? recs[i] : null;
    const run = this.newRun(prev ? prev.name : (k.text || k.cls)); run.trigger = prev ? prev.trigger : k; run.id = prev ? prev.id : "tab-" + k.cls + "-" + k.text; run.presses = (prev ? prev.presses : 0) + 1;
    if (i >= 0) recs[i] = run; else { recs.push(run); i = recs.length - 1; }
    this.setState({ recordings: recs, targetId: run.id, viewing: i, sel: null, open: {}, stick: true, tab: "live", flowSel: null });
    if (!prev) this.persistTabs(recs);
    this.cmd("snapshot"); // the backend's state at this moment, so the recording can be replayed from here
  }
  addTab(k) {
    const recs = this.state.recordings.slice(); if (recs.some(r => this.matches(r.trigger, k))) { this.setState({ viewing: recs.findIndex(r => this.matches(r.trigger, k)) }); return; }
    const run = this.newRun(k.text || k.cls); run.trigger = k; run.id = "tab-" + k.cls + "-" + k.text; recs.push(run);
    this.setState({ recordings: recs, viewing: recs.length - 1, sel: null, flowSel: null }); this.persistTabs(recs);
  }
  removeTab(r) {
    const recs = this.state.recordings.filter(x => x !== r);
    this.setState({ recordings: recs, viewing: Math.min(this.state.viewing, recs.length - 1), targetId: this.state.targetId === r.id ? recs[0].id : this.state.targetId, sel: null, flowSel: null }); this.persistTabs(recs);
  }
  apply(run, ev) {
    if (ev.type === "stage") {
      if (!run.startedAt) run.startedAt = ev.at;
      run.stages.push({ id: ev.id, seq: ev.seq, at: ev.at, path: ev.path, method: ev.method, surface: ev.surface, action: ev.action, label: ev.label, bg: ev.bg, poll: ev.poll, direct: ev.direct, request: ev.request, status: "running", ops: [], ms: 0, code: null, response: null });
      if (ev.raw) run.requests.push(Object.assign({ stage: ev.id }, ev.raw));
      return;
    }
    const st = run.stages.find(s => s.id === (ev.stage || ev.id)); if (!st) return;
    // The box the product just changed selects itself, so the panel follows the action on the left.
    if (ev.type === "op" && ev.status === "ok" && ev.writes && ev.writes.length && ["credit", "session"].indexOf(ev.writes[0]) < 0 && run === this.target()) { this.autoSel = ev.writes[ev.writes.length - 1]; }
    if (ev.type === "op") { const i = st.ops.findIndex(o => o.id === ev.id); const o = { id: ev.id, seq: ev.seq, at: ev.at, kind: ev.kind, name: ev.name, target: ev.target, status: ev.status, input: ev.input, output: ev.output, ms: ev.ms, meta: ev.meta || {}, error: ev.error, reads: ev.reads || [], writes: ev.writes || [] }; if (i < 0) st.ops.push(o); else st.ops[i] = o; }
    if (ev.type === "stage.end") { st.status = ev.status; st.code = ev.code; st.ms = ev.ms; st.response = ev.response; }
  }
  totals(stages) {
    const t = { requests: 0, ops: 0, model: 0, cost: 0, ms: 0, dbWrites: 0, external: 0, errors: 0 };
    stages.forEach(s => { if (s.method !== "LOCAL") t.requests += 1; t.ms += s.ms || 0; if (s.status === "error") t.errors += 1;
      s.ops.forEach(o => { t.ops += 1; if (o.kind === "model") { t.model += 1; t.cost += (o.meta && o.meta.cost) || 0; } if (o.kind === "db" && /^(patch|insert|upsert|delete|rpc)/.test(o.name)) t.dbWrites += 1; if (o.kind === "api" || o.kind === "web") t.external += 1; }); });
    return t;
  }
  fmtMs(ms) { if (!ms) return "—"; return ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms"; }
  fmtCost(c) { return c ? "$" + c.toFixed(c < 0.01 ? 4 : 3) : ""; }
  pad(n) { return String(n).padStart(2, "0"); }
  clock(at) { const d = new Date(at), h = d.getHours(); return ((h % 12) || 12) + ":" + this.pad(d.getMinutes()) + ":" + this.pad(d.getSeconds()) + (h < 12 ? " AM" : " PM"); }
  // --- frame messages ---------------------------------------------------------------
  componentDidMount() { window.addEventListener("message", this.onMessage); this.applySplit(); if (this.isReal()) this.enterReal(); }
  componentWillUnmount() { window.removeEventListener("message", this.onMessage); }
  componentDidUpdate() { this.applySplit(); this.bindWheel(); }
  applySplit() { const s = Math.max(25, Math.min(80, Number(this.state.split != null ? this.state.split : (this.props.split ?? 56)))); if (this.bodyRef.current) this.bodyRef.current.style.gridTemplateColumns = "minmax(0," + s + "fr) 1px minmax(0," + (100 - s) + "fr)"; }
  // The divider: the pointer's position across the body becomes the split, live while dragging; the
  // product frame is covered meanwhile so it does not swallow the pointer.
  splitDown(e) {
    if (e.button !== 0) return; e.preventDefault();
    const body = this.bodyRef.current; if (!body) return;
    const shield = document.createElement("div"); shield.style.cssText = "position:fixed;inset:0;z-index:90;cursor:col-resize"; document.body.appendChild(shield);
    const move = ev => { const r = body.getBoundingClientRect(); const pct = Math.max(25, Math.min(80, (ev.clientX - r.left) / r.width * 100)); this.setState({ split: Math.round(pct * 10) / 10 }); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); shield.remove(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  // Only the product frame on this origin is listened to.
  onMessage(e) {
    if (e.origin !== window.location.origin) return;
    const f = this.frameRef.current; if (!f || e.source !== f.contentWindow) return;
    const m = e.data; if (!m || !m.egb) return;
    const real = this.isReal();
    if (m.egb === "ready") { this.connectedAt = Date.now(); this.lastPress = null; this.setState({ connected: true, picking: false });
      if (real) { const o = this.realOverrides(); if (o) this.cmd("prompts", o); return; } // no speed or snapshot in the real frame; only the chosen prompts
      this.cmd("speed", this.SPEEDS.find(x => x.key === this.state.speedKey).value); this.cmd("snapshot");
      const env = this.state.envs.find(e => e.id === this.state.envId); if (env && env.config && env.config.prompts) this.cmd("prompts", env.config.prompts); return; }
    if (m.egb === "step") { this.stepShown(m.label); return; }
    if (m.egb === "press") { if (!real) this.pressed(m.step); return; }
    if (m.egb === "picked") { this.setState({ picking: false }); if (!real) this.addTab(m.trigger); return; }
    if (m.egb === "pickCancel") { this.setState({ picking: false }); return; }
    if (m.egb === "trigger") { if (!real) this.buttonPressed(m.trigger); return; }
    if (m.egb === "snapshot") { if (real) return; const r = [...this.state.recordings].reverse().find(x => !x.seed); if (r) { r.seed = m.state; this.forceUpdate(); } return; }
    if (m.egb === "notice") { this.setState({ notice: m.text }); clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => this.setState({ notice: "" }), 6000); return; }
    // Real mode: the frame reports the product's own requests; the simulator's events do not occur there.
    if (m.egb === "session") { if (real) this.frameSession(m); return; }
    if (m.egb === "request") { if (real) this.requestStarted(m); return; }
    if (m.egb === "response") { if (real) this.requestEnded(m); return; }
    if (m.egb === "trace") { if (real) return; this.pending.push(m.event); if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40); }
  }
  flush() {
    // A new request lands in the step on screen; the rest of a request (a background reading that
    // outlives its step) follows the request wherever it started.
    this.flushTimer = null; const run = this.target(), recs = this.state.recordings;
    if (this.state.mode === "real" || !run) { this.pending.splice(0); return; }
    this.pending.splice(0).forEach(ev => {
      if (ev.type === "stage") { this.apply(run, ev); return; }
      const home = recs.find(r => r.stages.some(s => s.id === (ev.stage || ev.id))) || run; this.apply(home, ev);
    });
    if (this.autoSel && this.autoSel !== this.state.flowSel) { const next = this.autoSel; this.autoSel = null; this.setState({ flowSel: next, flowTab: null }); } else this.autoSel = null;
    this.scheduleSave();
    this.forceUpdate(() => { const el = this.listRef.current; if (el && this.state.stick && this.viewed() === run) el.scrollTop = el.scrollHeight; });
  }
  cmd(cmd, value) { const f = this.frameRef.current; if (f && f.contentWindow) f.contentWindow.postMessage({ egb: "cmd", cmd: cmd, value: value }, window.location.origin); }
  // --- Real mode: the same product against the real backend, each request's persisted trace beneath it -------
  // The mode is remembered in this browser. Switching to Real saves the simulator's tabs first; switching
  // back restores them from the environment's storage. The product on the left does, in Real mode, exactly
  // what it does at /engelbart/setup; this side only reads what the server recorded about it.
  // The mode is the URL's, as the frame's is: ?mode=real runs the setup page as the signed-in member; anything
  // else is the simulator, which is where the page lands and stays. There is no switch in the page.
  loadMode() { try { return new URLSearchParams(window.location.search).get("mode") === "real" ? "real" : "sim"; } catch (e) { return "sim"; } }
  isReal() { return this.state.mode === "real"; }
  setReal(patch, after) { this.setState(s => ({ real: Object.assign({}, s.real, patch) }), after); }
  // session: the member's session as this page reads it; frameSession: as the frame reported it; runs: the
  // member's runs for the picker; envelope: everything recorded for the onboarding this session is on, merged
  // trace by trace; requests: what the frame reported; picked/pickedEnvelope: an earlier run, when one is open.
  freshReal() { return { session: undefined, frameSession: undefined, runs: null, loading: false, error: "", envelope: null, onboardingId: null, requests: [], picked: null, pickedEnvelope: null, history: {}, seenAt: 0 }; }
  // The one recording Real mode draws: this session (what was recorded for the onboarding before, then this
  // session's requests with their traces), or the earlier run picked from the list.
  realRecording(R) {
    const A = window.EGB_REAL, empty = { operations: [], snapshots: [], events: [] };
    if (R.picked) return A.adapt(R.pickedEnvelope || empty, { name: A.runLabel(R.picked, {}), onboarding: R.picked });
    const env = R.envelope || empty;
    return A.adapt(env, { requests: R.requests, name: env.onboarding ? A.runLabel(env.onboarding, env.run || {}) : "Current session" });
  }
  realRecordingState(R) { const rec = this.realRecording(R); if (!R.picked) rec.id = "real-current"; return { recordings: [rec], targetId: rec.id, viewing: 0 }; }
  // Redraw from the envelope and the requests. A request row keeps its open state and its selection when its
  // trace arrives and the row becomes the trace's root.
  // `patch` is an object, or a function of the real state as it is when the update runs. Callers that derive
  // the patch from what they read earlier lose updates: a request and a reply, or two replies, in one turn
  // are separate messages, and React applies their updates together, after both handlers have run.
  rebuildReal(patch, after) {
    this.setState(s => {
      const add = typeof patch === "function" ? patch(s.real) : patch;
      const R = Object.assign({}, s.real, add || {});
      const st = this.realRecordingState(R), rec = st.recordings[0];
      const open = Object.assign({}, s.open); let sel = s.sel;
      rec.stages.forEach(x => { if (x.real && x.requestId) { const k = "req:" + x.requestId; if (open[k] != null && open[x.id] == null) open[x.id] = open[k]; if (sel && sel.run === "live" && sel.stage === k) sel = { run: "live", stage: x.id, op: null }; } });
      return Object.assign({ real: R, open: open, sel: sel }, st);
    }, () => { if (after) after(); const el = this.listRef.current; if (el && this.state.stick && !this.state.real.picked) el.scrollTop = el.scrollHeight; });
  }
  // On entering Real mode: the member's runs, for the picker. The frame boots the product by itself.
  enterReal() { if (!this.state.real.runs && !this.state.real.loading) this.loadRuns(); }
  realToken() {
    if (!this.realClient) return Promise.resolve(null);
    return this.realClient.session().then(s => { this.setReal({ session: s }); return s ? s.token : null; });
  }
  realFailed(e, fallback) {
    const msg = e && e.status === 401 ? "Your Engelbart session has expired. Sign in again at /engelbart/signin, then reload the frame." : e && e.status === 403 ? "This account is not an Engelbart member." : (e && e.message) || fallback;
    this.setReal({ loading: false, error: msg });
  }
  loadRuns() {
    this.setReal({ loading: true, error: "" });
    this.realToken().then(token => {
      if (!token) { this.setReal({ loading: false, runs: null }); return; }
      return this.realClient.list(token).then(body => this.setReal({ loading: false, runs: Array.isArray(body && body.runs) ? body.runs : [] }));
    }).catch(e => this.realFailed(e, "Could not load your runs."));
  }
  // The frame's word on the member's session. Without one the product leaves for /engelbart/signin, which
  // refuses to be framed, so the pane says what happened and how to come back.
  frameSession(m) { this.setReal({ frameSession: { signedIn: !!m.signedIn, email: m.email || "", error: m.error || "" } }); }
  reloadFrame() { this.setState(s => ({ frameKey: s.frameKey + 1, connected: false, real: Object.assign({}, s.real, { frameSession: undefined }) })); }
  // A request the frame reported as it started: a row of its own until its trace arrives.
  requestStarted(m) {
    const rq = { id: m.id, at: m.at || Date.now(), method: m.method, path: m.path, where: m.where, action: m.action, request: m.body === undefined ? null : m.body, step: m.step || null, bg: !!m.bg, poll: !!m.poll, status: "running", code: null, ms: 0, response: null, trace_id: null, trace: null };
    this.rebuildReal(R => ({ requests: R.requests.concat([rq]) }));
  }
  // The reply: status, body and, for a traced action, the trace id to read. A reply that carries the
  // onboarding row names the onboarding this session is on.
  requestEnded(m) {
    const row = m.body && m.body.onboarding && m.body.onboarding.id ? String(m.body.onboarding.id) : null;
    let matched = false;
    this.rebuildReal(R => {
      const i = R.requests.findIndex(r => r.id === m.id); if (i < 0) return null;
      matched = true;
      const rq = Object.assign({}, R.requests[i], { status: m.ok ? "ok" : "error", code: m.status || null, ms: m.ms || 0, response: m.body === undefined ? null : m.body, trace_id: m.trace_id || null, error: m.error || null, trace: m.trace_id ? "pending" : null });
      const requests = R.requests.slice(); requests[i] = rq; return { requests: requests };
    }, () => {
      if (!matched) return;
      if (row && row !== this.state.real.onboardingId) this.onboardingSeen(row);
      if (m.trace_id) this.fetchTrace(m.trace_id, 0);
    });
  }
  // The onboarding this session is on. What was recorded for it before this page opened is read once and
  // drawn ahead of this session's requests; the run list is refreshed so the picker knows it.
  onboardingSeen(id) {
    // One read per row, whatever arrives while it is out: the guard is an instance field, not state.
    this.rowLoads = this.rowLoads || {};
    if (this.state.real.history[id] || this.rowLoads[id]) { this.setReal({ onboardingId: id }); return; }
    this.rowLoads[id] = true;
    this.rebuildReal(R => { const history = Object.assign({}, R.history); history[id] = "loading"; return { onboardingId: id, history: history }; });
    this.realToken().then(token => token ? this.realClient.run(token, id) : null).then(env => {
      this.rebuildReal(R => { const h = Object.assign({}, R.history); h[id] = env ? "loaded" : "none"; return env ? { history: h, envelope: window.EGB_REAL.mergeEnvelope(R.envelope, env) } : { history: h }; });
      if (env) this.loadRuns();
    }).catch(e => {
      this.rebuildReal(R => { const h = Object.assign({}, R.history); h[id] = "failed"; return { history: h }; });
      if (!e || e.status !== 404) this.realFailed(e, "Could not read what was recorded for this onboarding before.");
    });
  }
  // The trace a reply named, read once the reply is in. The server flushes telemetry before it answers, so the
  // trace is normally there at once; a slow store gets a few more tries before the row says it never landed.
  fetchTrace(traceId, attempt) {
    const DELAYS = [800, 2000, 4000];
    this.realToken().then(token => {
      if (!token) { const e = new Error("Sign in to Engelbart to read telemetry"); e.status = 401; throw e; }
      return this.realClient.trace(token, traceId);
    }).then(env => {
      this.rebuildReal(R => ({ envelope: window.EGB_REAL.mergeEnvelope(R.envelope, env) }), () => this.markTrace(traceId, "loaded", null));
    }).catch(e => {
      if (e && e.status === 404 && attempt < DELAYS.length) { setTimeout(() => this.fetchTrace(traceId, attempt + 1), DELAYS[attempt]); return; }
      this.markTrace(traceId, "missing", e && e.status === 404 ? "The server recorded nothing under this trace id: telemetry may be off on this deployment, or its store did not take the write." : (e && e.message) || "The trace could not be read.");
      if (e && (e.status === 401 || e.status === 403)) this.realFailed(e, "");
    });
  }
  markTrace(traceId, state, why) {
    this.rebuildReal(R => ({ requests: R.requests.map(r => r.trace_id === traceId ? Object.assign({}, r, { trace: state, traceError: why || null }) : r) }));
  }
  // The picker: this session, or one of the member's earlier runs, opened in the same panel while the product
  // keeps running on the left. Requests made meanwhile are counted on the way back.
  pickRun(value) {
    if (value === "__refresh") { this.loadRuns(); return; }
    if (value === "__current") { this.rebuildReal({ picked: null, pickedEnvelope: null, seenAt: 0 }, () => this.setState({ sel: null, open: {}, stick: true })); return; }
    const item = (this.state.real.runs || []).find(r => r.onboarding_id === value); if (!item) return;
    this.rebuildReal(R => ({ picked: item, pickedEnvelope: null, loading: true, error: "", seenAt: R.requests.length }), () => this.setState({ sel: null, open: {}, stick: false }));
    this.realToken().then(token => token ? this.realClient.run(token, item.onboarding_id) : null).then(env => {
      if (!this.state.real.picked || this.state.real.picked.onboarding_id !== item.onboarding_id) return; // moved on meanwhile
      this.rebuildReal({ pickedEnvelope: env, loading: false });
    }).catch(e => this.realFailed(e, "Could not load that run."));
  }
  // A snapshot the run did not carry inline is asked for once, the first time a tab shows it, and kept in the
  // envelope it belongs to, so it survives every redraw.
  snapshot(id) {
    const rec = this.viewed(); if (!rec || !rec.real || !id) return { state: "none" };
    const s = window.EGB_REAL.snapshotOf(rec, id);
    this.snapshotLoads = this.snapshotLoads || {};
    if (s.state === "pending" && !this.snapshotLoads[id]) {
      this.snapshotLoads[id] = true;
      const key = this.state.real.picked ? "pickedEnvelope" : "envelope";
      const settle = (snap) => {
        this.rebuildReal(R => {
          const env = R[key]; if (!env) return null;
          const snapshots = (env.snapshots || []).map(x => x.snapshot_id === id ? (snap || Object.assign({}, x, { content: null, content_omitted: false, unavailable: true })) : x);
          const patch = {}; patch[key] = Object.assign({}, env, { snapshots: snapshots }); return patch;
        });
      };
      this.realToken().then(token => token ? this.realClient.snapshot(token, id) : null).then(body => settle(body && body.snapshot), () => settle(null)).then(() => { delete this.snapshotLoads[id]; });
    }
    return s;
  }
  dateOf(at) { const d = new Date(at); return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + this.clock(at); }
  // --- cases ---------------------------------------------------------------------------
  loadCases() { try { return JSON.parse(window.localStorage.getItem("egb.debugger.cases.v1") || "[]"); } catch (e) { return []; } }
  persist(cases) { try { window.localStorage.setItem("egb.debugger.cases.v1", JSON.stringify(cases)); } catch (e) { this.setState({ notice: "Could not save: browser storage is full. Delete a case first." }); } }
  saveCase() {
    const run = this.viewed(); if (!run.stages.length) return;
    const last = [...run.stages].reverse().find(s => s.method !== "LOCAL" && !s.poll);
    const c = { id: "case-" + Date.now().toString(36), name: run.name + " · through " + (last ? last.label : "open") + " · " + this.clock(Date.now()), savedAt: Date.now(),
      knobs: Object.assign({}, window.EngelbartSim.DEFAULT_KNOBS), requests: run.requests.slice(), stages: JSON.parse(JSON.stringify(run.stages)), runs: [], seed: run.seed || null };
    const cases = [c, ...this.state.cases]; this.persist(cases); this.setState({ cases: cases, tab: "cases", caseOpen: c.id });
  }
  knobDiff(knobs) { const D = window.EngelbartSim.DEFAULT_KNOBS; const d = Object.keys(D).filter(k => String(knobs[k]) !== String(D[k])).map(k => k + " " + D[k] + " → " + knobs[k]); return d.length ? d.join(" · ") : "defaults"; }
  async runIsolated(c) {
    if (this.state.running) return;
    const knobs = Object.assign({}, this.state.knobs); this.setState({ running: true });
    const events = []; const sim = window.EngelbartSim.create({ emit: ev => events.push(ev), speed: 0, knobs: knobs, seed: c.seed || undefined });
    try {
      for (const r of c.requests) { if (!r.url) continue; await sim.handle(r.url, { method: r.method, body: r.body != null ? r.body : (r.bytes != null ? { bytes: r.bytes } : undefined) }); }
    } catch (e) { this.setState({ notice: "Replay stopped: " + e.message }); }
    const run = this.newRun("Run " + (c.runs.length + 1) + " · " + this.knobDiff(knobs), knobs); events.forEach(ev => this.apply(run, ev)); run.startedAt = Date.now();
    c.runs.push(run); const cases = this.state.cases.slice(); this.persist(cases);
    this.setState({ cases: cases, running: false, tab: "compare", compare: { caseId: c.id, runId: run.id }, cmpOpen: {}, sel: null });
  }
  // --- comparison -------------------------------------------------------------------
  norm(v) { return JSON.stringify(v === undefined ? null : v).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<t>").replace(/"synced_at":"[^"]*"/g, "\"synced_at\":\"<t>\""); }
  alignOps(a, b) {
    const key = o => o.kind + "|" + o.name; const n = a.length, m = b.length, L = [];
    for (let i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = key(a[i]) === key(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const pairs = []; let i = 0, j = 0;
    while (i < n && j < m) { if (key(a[i]) === key(b[j])) { pairs.push({ a: a[i], b: b[j], kind: this.norm(a[i].output) === this.norm(b[j].output) ? "same" : "changed" }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { pairs.push({ a: a[i], b: null, kind: "removed" }); i++; } else { pairs.push({ a: null, b: b[j], kind: "added" }); j++; } }
    while (i < n) pairs.push({ a: a[i++], b: null, kind: "removed" }); while (j < m) pairs.push({ a: null, b: b[j++], kind: "added" });
    return pairs;
  }
  compareData() {
    const cmp = this.state.compare; if (!cmp) return null;
    const c = this.state.cases.find(x => x.id === cmp.caseId); if (!c) return null;
    const run = c.runs.find(r => r.id === cmp.runId); if (!run) return null;
    const A = c.stages.filter(s => s.method !== "LOCAL"), B = run.stages.filter(s => s.method !== "LOCAL");
    const rows = []; const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) { const a = A[i] || null, b = B[i] || null; const pairs = a && b ? this.alignOps(a.ops, b.ops) : (a ? a.ops.map(o => ({ a: o, b: null, kind: "removed" })) : b.ops.map(o => ({ a: null, b: o, kind: "added" })));
      const responseSame = a && b && this.norm(a.response) === this.norm(b.response);
      const status = !a ? "only-b" : !b ? "only-a" : (pairs.every(p => p.kind === "same") && responseSame) ? "same" : "changed";
      rows.push({ i: i, a: a, b: b, pairs: pairs, status: status }); }
    return { c: c, run: run, A: A, B: B, rows: rows };
  }
  // --- selection -------------------------------------------------------------------
  findOp(sel) {
    if (!sel) return null;
    let stages = null, sideLabel = "";
    if (sel.run === "live") stages = this.viewed().stages;
    else { const d = this.compareData(); if (!d) return null; stages = sel.run === "A" ? d.A : d.B; sideLabel = sel.run; }
    const st = stages.find(s => s.id === sel.stage); if (!st) return null;
    if (!sel.op) return { stage: st, op: null, side: sideLabel };
    const op = st.ops.find(o => o.id === sel.op); return op ? { stage: st, op: op, side: sideLabel } : null;
  }
  select(run, stage, op) { this.setState({ sel: { run: run, stage: stage, op: op }, copied: false }); }
  // --- view models --------------------------------------------------------------------
  stageVM(s, index, runKey, run) {
    const K = this.KINDS, sel = this.state.sel, hide = this.state.hideKinds;
    const explicit = this.state.open[s.id]; const isLast = index === run.stages.length - 1;
    const open = explicit != null ? explicit : (s.status === "running" || isLast);
    const cost = s.ops.reduce((n, o) => n + ((o.kind === "model" && o.meta && o.meta.cost) || 0), 0);
    const ops = s.ops.filter(o => !hide[o.kind]);
    const models = s.ops.filter(o => o.kind === "model").length;
    return { id: s.id, anchor: "stage-" + s.seq, seqLabel: this.pad(index + 1), label: s.label, path: s.method + " " + s.path,
      tag: s.bg ? "background" : s.poll ? (s.count > 1 ? "poll ×" + s.count : "poll") : s.direct ? "browser → storage" : s.method === "LOCAL" ? "in page" : s.synthetic ? "no root recorded" : s.awaiting === "pending" ? "reading trace…" : s.awaiting === "missing" ? "trace not recorded" : s.observed && s.untraced ? "untraced" : s.earlier ? "earlier" : s.outcome ? String(s.outcome) : "",
      modelPill: models ? (models > 1 ? models + " model" : "model") : "",
      dot: s.status === "running" ? "#0070f3" : s.status === "error" ? "#e70022" : "#c9c9c9",
      opsLabel: s.ops.length + (s.ops.length === 1 ? " op" : " ops"), msLabel: this.fmtMs(s.ms || s.ops.reduce((n, o) => n + (o.ms || 0), 0)), costLabel: this.fmtCost(cost),
      chevron: open ? "⌃" : "›", open: open, reqColor: sel && sel.stage === s.id && !sel.op ? "#0070f3" : "#8f8f8f",
      toggle: () => { const o = Object.assign({}, this.state.open); o[s.id] = !open; this.setState({ open: o }); },
      inspectStage: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.select(runKey, s.id, null); },
      dots: ops.map((o, i) => ({ color: o.status === "running" ? "#3291ff" : o.status === "error" ? "#e70022" : K[o.kind].color, ring: sel && sel.op === o.id ? "0 0 0 2px #fff, 0 0 0 3.5px #0070f3" : "none",
        line: i === ops.length - 1 ? "transparent" : "#e2e2e2", title: K[o.kind].label + " · " + o.name + " · " + this.fmtMs(o.ms), select: () => this.select(runKey, s.id, o.id) })),
      ops: ops.map((o, i) => ({ id: o.id, seq: this.pad(i + 1), kindLabel: K[o.kind].label, color: K[o.kind].color, bg: K[o.kind].bg, indent: (o.depth || 0) * 12, name: o.name + (o.status === "running" ? " …" : o.status === "error" ? " — failed" : ""), nameColor: o.status === "error" ? "#e70022" : "#171717",
        target: o.target, msLabel: o.status === "running" ? "running" : this.fmtMs(o.ms), rowBg: sel && sel.op === o.id ? "#e6f0fd" : "transparent", select: () => this.select(runKey, s.id, o.id) })) };
  }
  // --- readable rendering of stored data, prompts and replies ---------------------------------------------------
  renderData(v, depth) {
    const d = depth || 0;
    const label = k => String(k).replace(/_/g, " ").replace(/^not included$/i, "left out");
    if (v === null || v === undefined || v === "") return h("span", { style: { color: "#c9c9c9", font: "12px/1.5 " + SANS } }, "—");
    if (typeof v === "boolean" || typeof v === "number") return h("span", { style: { font: "12px/1.5 " + MONO, color: "#171717" } }, String(v));
    if (typeof v === "string") {
      if (/^https?:\/\/\S+$/.test(v)) return h("a", { href: v, target: "_blank", rel: "noopener", style: { font: "12px/1.5 " + MONO, color: "#0070f3", wordBreak: "break-all" } }, v.replace(/^https?:\/\//, ""));
      return h("span", { style: { font: (v.length > 90 ? "12.5px/1.65 " : "12.5px/1.5 ") + SANS, color: "#171717", whiteSpace: "pre-wrap", textWrap: "pretty" } }, v);
    }
    if (d > 6) return h("span", { style: { color: "#8f8f8f" } }, "…");
    if (Array.isArray(v)) {
      if (!v.length) return h("span", { style: { color: "#c9c9c9", font: "12px/1.5 " + SANS } }, "none");
      if (v.every(x => x === null || typeof x !== "object")) return h("ul", { style: { margin: 0, padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: "3px" } }, v.map((x, i) => h("li", { key: i, style: { font: "12.5px/1.55 " + SANS, color: "#171717" } }, this.renderData(x, d + 1))));
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } }, v.map((x, i) => {
        const t = x && (x.title || x.label || x.area || x.question || x.role || x.name);
        const rest = x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => !(t && ["title", "label", "area", "name"].indexOf(k) >= 0 && x[k] === t))) : x;
        return h("div", { key: i, style: { border: "1px solid #eaeaea", borderRadius: "6px", padding: "9px 12px 10px", background: "#fff" } },
          t ? h("div", { style: { font: "500 13px/1.4 " + SANS, color: "#171717", marginBottom: "6px" } }, String(t)) : null,
          this.renderData(rest, d + 1));
      }));
    }
    const keys = Object.keys(v);
    if (!keys.length) return h("span", { style: { color: "#c9c9c9" } }, "{}");
    return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(88px,auto) minmax(0,1fr)", columnGap: "14px", rowGap: "6px", alignItems: "baseline" } }, keys.flatMap(k => [
      h("span", { key: k + ":k", style: { font: "500 9px/1.7 " + SANS, letterSpacing: "1.3px", textTransform: "uppercase", color: /not_included|left out/i.test(k) ? "#e70022" : "#8f8f8f", whiteSpace: "nowrap" } }, label(k)),
      h("div", { key: k + ":v", style: { minWidth: 0 } }, this.renderData(v[k], d + 1))]));
  }
  renderPrompt(p) {
    if (!p || !p.body) return this.renderData(p);
    const body = p.body, tools = (body.tools || []).map(t => t.name + (t.max_uses ? " · up to " + t.max_uses + " uses" : ""));
    const meta = [body.model, body.max_tokens ? body.max_tokens.toLocaleString() + " max tokens" : null, p.timeout_ms ? Math.round(p.timeout_ms / 1000) + " s timeout" : null].concat(tools).filter(Boolean);
    const blocks = ((body.messages || [])[0] || {}).content || [];
    return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
      p.prompt ? h("p", { style: { margin: 0, font: "12.5px/1.65 " + SANS, color: "#171717", textWrap: "pretty" } }, p.prompt) : null,
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } }, meta.map((m, i) => h("span", { key: i, style: { padding: "4px 9px", border: "1px solid #eaeaea", borderRadius: "999px", font: "11px/1 " + MONO, color: "#4d4d4d" } }, m))),
      h("div", { style: { font: "500 9px/1 " + SANS, letterSpacing: "1.3px", textTransform: "uppercase", color: "#8f8f8f", marginTop: "2px" } }, "message · " + blocks.length + (blocks.length === 1 ? " block" : " blocks")),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, blocks.map((b, i) => b.type === "document"
        ? h("div", { key: i, style: { display: "flex", alignItems: "center", gap: "10px", padding: "9px 12px", border: "1px solid #eaeaea", borderRadius: "6px", background: "#fff" } },
          h("span", { style: { padding: "3px 7px", borderRadius: "4px", background: "oklch(0.95 0.035 60)", color: "oklch(0.48 0.13 60)", font: "500 9px/1 " + SANS, letterSpacing: "1.3px", textTransform: "uppercase" } }, "PDF"),
          h("span", { style: { font: "12.5px/1.5 " + SANS, color: "#171717" } }, "The paper, as a document block · " + String(b.source && b.source.data || "").replace(/[<>]/g, "") + (b.cache_control ? " · cached (ephemeral)" : " · not cached")))
        : h("div", { key: i, style: { padding: "9px 12px", borderLeft: "2px solid #e2e2e2", background: "#fff", font: "12.5px/1.6 " + SANS, color: "#171717", whiteSpace: "pre-wrap", textWrap: "pretty" } }, String(b.text || "")))));
  }
  // --- the data-flow graph: nodes are what the setup stores, edges the operations that produce one from another ----
  // Dragging a box: the pointer's travel, divided by the zoom, moves the box; a press that never moved is a click.
  dragStart(e, id, p) {
    if (e.button !== 0) return; e.stopPropagation();
    const zoom = this.state.flowZoom || 1, sx = e.clientX, sy = e.clientY, ox = p.x, oy = p.y; this.dragMoved = false;
    const move = ev => { const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom; if (!this.dragMoved && Math.abs(dx) + Math.abs(dy) < 4) return; this.dragMoved = true;
      const fp = Object.assign({}, this.state.flowPos); fp[id] = { x: Math.round(ox + dx), y: Math.round(oy + dy) }; this.setState({ flowPos: fp }); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  // Wheel over the graph zooms around the cursor (a non-passive listener, so the page does not scroll too).
  bindWheel() {
    const el = this.flowScrollRef.current; if (!el || el === this.wheelEl) return;
    this.wheelEl = el;
    el.addEventListener("wheel", e => {
      e.preventDefault();
      const old = this.state.flowZoom || 1, next = Math.max(0.4, Math.min(2.5, Math.round(old * (e.deltaY < 0 ? 1.1 : 1 / 1.1) * 100) / 100));
      if (next === old) return;
      const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, pan = this.state.flowPan || { x: 0, y: 0 }, k = next / old;
      this.setState({ flowZoom: next, flowPan: { x: Math.round(px - (px - pan.x) * k), y: Math.round(py - (py - pan.y) * k) } });
    }, { passive: false });
  }
  // Hold and drag anywhere that is not a box to move the whole graph.
  panDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest("[data-node]")) return;
    const el = this.flowScrollRef.current; if (!el) return; e.preventDefault();
    const sx = e.clientX, sy = e.clientY, p0 = this.state.flowPan || { x: 0, y: 0 }; el.style.cursor = "grabbing";
    const move = ev => this.setState({ flowPan: { x: Math.round(p0.x + (ev.clientX - sx)), y: Math.round(p0.y + (ev.clientY - sy)) } });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); el.style.cursor = "grab"; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  resizeDown(e) {
    if (e.button !== 0) return; e.preventDefault();
    const el = this.flowScrollRef.current; const start = el ? el.getBoundingClientRect().height : 300, sy = e.clientY;
    const shield = document.createElement("div"); shield.style.cssText = "position:fixed;inset:0;z-index:90;cursor:ns-resize"; document.body.appendChild(shield);
    const move = ev => this.setState({ flowHeight: Math.max(120, Math.round(start + (ev.clientY - sy))) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); shield.remove(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  setNote(id, text) { const notes = Object.assign({}, this.state.notes); if (text.trim()) notes[id] = text; else delete notes[id]; this.setState({ notes: notes }, () => this.scheduleSave()); }
  flowVM(run) {
    const FLOW = window.EngelbartSim.FLOW, K = this.KINDS, S = this.state;
    const COL = 210, NW = 122, NH = 38, ROW = 66, PX = 20, PY = 18, Z = S.flowZoom || 1;
    // The whole session: every tab's operations, with the viewed tab's marked `here`.
    const ops = []; S.recordings.forEach(rec => rec.stages.forEach(s => s.ops.forEach(o => ops.push({ op: o, stage: s, rec: rec, here: rec === run }))));
    const live = x => x.op.status === "ok" || x.op.status === "running";
    // Tables are drawn one box per row, so each answer, turn or question can be read on its own.
    const ROWKEY = { calibrations: r => r.area_index != null ? r.area_index + ":" + r.question_level : null, turns: r => r.role ? r.id : null, asks: r => r.id || null };
    const rowsIn = (x, base) => { const out = x.op.output, list = Array.isArray(out) ? out : [out]; return list.filter(r => r && typeof r === "object" && ROWKEY[base] && ROWKEY[base](r) != null); };
    const rowsFor = base => { const m = new Map(); ops.filter(x => x.op.status === "ok" && (x.op.writes || []).indexOf(base) >= 0).forEach(x => rowsIn(x, base).forEach(r => { m.set(String(ROWKEY[base](r)), r); })); return m; };
    const rowLabel = (base, r, i) => base === "calibrations" ? { label: "Answer " + (i + 1), sub: "Area " + (Number(r.area_index) + 1) + " · L" + r.question_level + " · " + (r.answered_at ? (r.graded_level != null ? "graded " + r.graded_level : "grading") : "follow-up") }
      : base === "turns" ? { label: "Turn " + (i + 1) + " · " + r.role, sub: String(r.content || "").split("\n")[0].slice(0, 26) } : { label: "Question " + (i + 1), sub: String(r.question || r.quote || "").slice(0, 26) };
    const touched = new Set(); ops.forEach(x => { if (live(x)) (x.op.reads || []).concat(x.op.writes || []).forEach(n => touched.add(n)); });
    const vnodes = [];
    FLOW.nodes.filter(n => touched.has(n.id)).forEach(n => {
      if (ROWKEY[n.id]) { const m = rowsFor(n.id); if (m.size) { let i = 0; m.forEach((r, k) => { const l = rowLabel(n.id, r, i); vnodes.push({ id: n.id + "#" + k, base: n.id, key: k, row: r, col: n.col, order: i, label: l.label, sub: l.sub, group: n.label }); i++; }); return; } }
      vnodes.push({ id: n.id, base: n.id, key: null, row: null, col: n.col, order: n.row, label: n.label, sub: n.sub });
    });
    const byBase = base => vnodes.filter(v => v.base === base);
    const hasKey = (x, v) => {
      if (v.key == null) return true;
      const mine = rowsIn(x, v.base);
      if (mine.length) return mine.some(r => String(ROWKEY[v.base](r)) === v.key);
      // A keyless write (a grade, a follow-up) belongs to the row its own request wrote.
      return ops.some(y => y.stage === x.stage && y !== x && y.op.status === "ok" && (y.op.writes || []).indexOf(v.base) >= 0 && rowsIn(y, v.base).some(r => String(ROWKEY[v.base](r)) === v.key));
    };
    const writersOf = v => ops.filter(x => (x.op.writes || []).indexOf(v.base) >= 0 && hasKey(x, v));
    const readersOf = v => ops.filter(x => (x.op.reads || []).indexOf(v.base) >= 0);
    // Arrows: for each operation, from every value it read to every value it wrote (to the exact row when
    // the write is a table row). A row written from another row of the same table (a follow-up) points
    // only to rows of the same area.
    const groups = new Map();
    ops.filter(x => live(x) && !(x.op.kind && S.hideKinds[x.op.kind]) && (x.op.reads || []).length && (x.op.writes || []).length).forEach(x => {
      (x.op.writes || []).forEach(W => {
        let targets = byBase(W); if (ROWKEY[W]) { const hit = targets.filter(v => hasKey(x, v)); if (hit.length) targets = hit; }
        targets.forEach(t => (x.op.reads || []).forEach(R => {
          let sources = byBase(R).filter(v => v.id !== t.id);
          if (R === W && t.row) sources = sources.filter(v => v.row && v.row.area_index === t.row.area_index && v.order < t.order);
          if (!sources.length) return;
          const key = t.id + "|" + x.op.name; if (!groups.has(key)) groups.set(key, { to: t.id, name: x.op.name, kind: x.op.kind, froms: new Set(), status: "before", count: 0 });
          const g = groups.get(key); sources.forEach(v => g.froms.add(v.id)); g.count += 1;
          if (x.here && x.op.status === "running") g.status = "running"; else if (x.here && x.op.status === "ok" && g.status !== "running") g.status = "here";
        }));
      });
    });
    const vedges = []; groups.forEach(g => g.froms.forEach(f => vedges.push({ from: f, to: g.to })));
    // Layered by lineage: a value sits one column right of the last value it was built from, level with
    // the values it came from; rows of one table stay together.
    const layer = {}; const producersOf = id => vedges.filter(e => e.to === id).map(e => e.from);
    const depth = (id, seen) => { if (layer[id] != null) return layer[id]; seen = seen || new Set(); if (seen.has(id)) return 0; seen.add(id); const p = producersOf(id); const d = p.length ? 1 + Math.max(...p.map(q => depth(q, seen))) : 0; layer[id] = d; return d; };
    vnodes.forEach(v => depth(v.id));
    vnodes.forEach(v => { if (v.key != null) { const sib = vnodes.filter(w => w.base === v.base); const d = Math.max(...sib.map(w => layer[w.id])); sib.forEach(w => { layer[w.id] = d; }); } });
    const cols = [...new Set(vnodes.map(v => layer[v.id]))].sort((a, b) => a - b);
    const pos = {}; let maxY = 0;
    cols.forEach((c, ci) => {
      const inCol = vnodes.filter(v => layer[v.id] === c);
      const bary = v => { const ys = producersOf(v.id).map(p => pos[p] ? pos[p].y : null).filter(y => y != null); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : PY + v.order * ROW; };
      let nextY = PY;
      inCol.sort((a, b) => bary(a) - bary(b) || a.base.localeCompare(b.base) || a.order - b.order).forEach(v => { const y = ci === 0 ? nextY : Math.max(nextY, Math.round(bary(v))); pos[v.id] = { x: PX + ci * COL, y: y }; nextY = y + ROW; maxY = Math.max(maxY, y); });
    });
    // Boxes the reader dragged stay where they were put.
    let maxX = PX + Math.max(0, cols.length - 1) * COL;
    vnodes.forEach(v => { const o = S.flowPos[v.id]; if (o) { pos[v.id] = { x: Math.max(0, o.x), y: Math.max(0, o.y) }; maxX = Math.max(maxX, pos[v.id].x); maxY = Math.max(maxY, pos[v.id].y); } });
    const selNode = S.flowSel;
    const selOp = S.sel && S.sel.op && S.sel.run === "live" ? (() => { const st = run.stages.find(s => s.id === S.sel.stage); return st && st.ops.find(o => o.id === S.sel.op); })() : null;
    const opHl = new Set(selOp ? (selOp.reads || []).concat(selOp.writes || []) : []);
    // Everything drawn is scaled here, not by a CSS transform, so text and lines stay sharp at any zoom.
    const zz = n => Math.round(n * Z * 100) / 100;
    const curve = (x1, y1, x2, y2) => { x1 = zz(x1); y1 = zz(y1); x2 = zz(x2); y2 = zz(y2); const dx = Math.max(18 * Z, (x2 - x1) / 2); return "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2; };
    const edges = [], junctions = [];
    groups.forEach(g => {
      const b = pos[g.to]; if (!b) return; const froms = [...g.froms].filter(f => pos[f]); if (!froms.length) return;
      const st = g.status, kindColor = g.kind ? K[g.kind].color : "#4d4d4d", stroke = st === "running" ? "#3291ff" : kindColor;
      const touches = selNode && (g.to === selNode || froms.indexOf(selNode) >= 0);
      const style = w => "fill:none;stroke:" + stroke + ";stroke-width:" + w + ";opacity:" + (selNode && !touches ? 0.15 : st === "before" && !touches ? 0.45 : 1);
      const x2 = b.x, y2 = b.y + NH / 2, width = (touches || st === "running" || st === "here" ? 2 : 1.5) * Math.max(0.6, Math.min(1.4, Z));
      if (froms.length === 1) { const a = pos[froms[0]]; edges.push({ d: curve(a.x + NW, a.y + NH / 2, x2, y2), style: style(width) }); return; }
      const jx = x2 - 38, jy = y2;
      froms.forEach(f => { const a = pos[f]; edges.push({ d: curve(a.x + NW, a.y + NH / 2, jx, jy), style: style(width) }); });
      edges.push({ d: "M" + zz(jx) + " " + zz(jy) + " L" + zz(x2) + " " + zz(y2), style: style(width) });
      junctions.push({ cx: zz(jx), cy: zz(jy), r: Math.max(2.5, 4.5 * Z), style: "fill:" + stroke + ";stroke:#fafafa;stroke-width:2;opacity:" + (selNode && !touches ? 0.15 : 1) });
    });
    const nodes = vnodes.map(v => {
      const p = pos[v.id], w = writersOf(v), ok = w.filter(x => x.op.status === "ok"), here = ok.filter(x => x.here), running = w.some(x => x.here && x.op.status === "running");
      const on = selNode === v.id, hl = opHl.has(v.base), written = ok.length > 0, wroteHere = here.length > 0, readHere = readersOf(v).some(x => x.here);
      return { id: v.id, x: zz(p.x), y: zz(p.y), w: zz(NW), h: zz(NH), fs: zz(11), fs2: zz(9), pad: zz(6) + "px " + zz(12) + "px 0 " + zz(9) + "px", radius: zz(6), dotSize: Math.max(3, zz(5)), dotOff: zz(5), label: v.label, sub: v.sub, title: (v.group ? v.group + " · " : "") + v.label + (v.row && v.row.area ? " · " + v.row.area + " · self-rated " + v.row.self_level : "") + " · " + v.sub + (wroteHere ? " · written on this step" : written ? " · written on an earlier step" : " · not produced yet") + (readHere ? " · read on this step" : ""),
        bg: on ? "#e6f0fd" : wroteHere ? "#fff" : written ? "#f5f5f5" : "#fff",
        border: (on || hl || running || wroteHere ? "2px" : "1px") + " solid " + (on || hl ? "#0070f3" : running ? "#3291ff" : wroteHere ? "#171717" : readHere ? "#8f8f8f" : written ? "#c9c9c9" : "#e2e2e2"),
        color: wroteHere || on || readHere ? "#171717" : written ? "#4d4d4d" : "#8f8f8f", dot: running ? "#0070f3" : wroteHere ? "#171717" : written ? "#c9c9c9" : "#e2e2e2", written: written || running, wroteHere: wroteHere || running, readHere: readHere,
        count: "", hasCount: false, stack: "none", hasNote: !!(S.notes[v.id] || "").trim(),
        down: (e) => this.dragStart(e, v.id, pos[v.id]),
        select: () => { if (this.dragMoved) { this.dragMoved = false; return; } this.setState({ flowSel: on ? null : v.id, flowTab: null }); } };
    });
    let detail = null;
    const sel = selNode && vnodes.find(v => v.id === selNode);
    if (sel) {
      const w = writersOf(sel), okW = w.filter(x => x.op.status === "ok"), last = okW[okW.length - 1] || null;
      const why = [...okW].reverse().map(x => x.op.meta && x.op.meta.why).find(Boolean) || "";
      const FIELDS = { profile: ["name", "year", "major", "depth"], paper: ["paper_id", "paper_title", "paper_familiarity"], links: ["project_url", "repo_url"], analysis: ["analysis"], assets: ["assets"], brief: ["assets_brief"],
        assessment: ["assessment"], leveled: ["leveled"], interest: ["interest"], chosen: ["asset_chosen"], direction: ["direction"], subgoals: ["subgoals"], todos: ["todos", "project_name", "goal_chosen"] };
      let value, source = null;
      if (sel.row) { value = sel.row; source = last; }
      else if (sel.base === "payload") { source = [...okW].reverse().find(x => /toPayload/.test(x.op.name)) || last; value = source && source.op.output; }
      else if (FIELDS[sel.base]) {
        for (let i = okW.length - 1; i >= 0 && value === undefined; i--) { const out = okW[i].op.output, rows = Array.isArray(out) ? out : [out];
          rows.forEach(r => { if (value === undefined && r && typeof r === "object" && FIELDS[sel.base].some(f => r[f] != null)) { value = {}; FIELDS[sel.base].forEach(f => { if (r[f] != null) value[f] = r[f]; }); source = okW[i]; } }); }
      } else {
        const substantive = o => o != null && !(typeof o === "string") && !(typeof o === "object" && !Array.isArray(o) && Object.keys(o).every(k => ["ok", "id", "revoked"].indexOf(k) >= 0));
        const carrier = [...okW].reverse().find(x => substantive(x.op.output)) || last;
        if (carrier) { const out = carrier.op.output; value = Array.isArray(out) && out.length === 1 ? out[0] : out; source = carrier; }
      }
      // A recorded operation carries no output to find the value in; what wrote it is what its record says wrote it.
      if (!source && last && last.op.real) source = last;
      const producer = [...okW].reverse().find(x => x.op.kind === "model") || source || last;
      const isModel = producer && producer.op.kind === "model";
      // A recorded operation's payloads are its snapshots, read by id as the inspector reads them; a simulated one
      // carries its input and output. The browser's request and reply are there only when the browser reported them.
      const realSnaps = producer && producer.op.real ? [["input", isModel ? "Prompt" : "Input", producer.op.snaps.input], ["output", isModel ? "Model output" : "Output", producer.op.snaps.output], ["raw", "Raw reply", producer.op.snaps.raw]].filter(t => t[2]) : null;
      const tabDefs = realSnaps ? (realSnaps.length ? realSnaps.map(t => [t[0], t[1]]) : [["value", "Value"]]).concat(producer.stage.observed ? [["request", "Request"], ["response", "Response"]] : [])
        : producer ? (isModel ? [["prompt", "Prompt"], ["output", "Model output"]] : [["input", "Input"], ["output", "Output"]]).concat([["request", "Request"], ["response", "Response"]]) : [["value", "Value"]];
      const tabKey = tabDefs.some(t => t[0] === S.flowTab) ? S.flowTab : (tabDefs.some(t => t[0] === "output") ? "output" : tabDefs[0][0]);
      const pIn = producer && producer.op.input || {};
      // The prompt as one message, the way the model receives it: the template's text with the filled-in
      // context sitting inside the block it was pasted into.
      const assembled = () => { if (!pIn.body) return pIn; const blocks = ((pIn.body.messages || [])[0] || {}).content || []; let lastText = -1; blocks.forEach((b, i) => { if (b.type === "text") lastText = i; });
        const content = blocks.map((b, i) => i === lastText ? Object.assign({}, b, { filled_in: pIn.context || undefined }) : b);
        return { template: pIn.template, template_edited: pIn.template_edited, model: pIn.body.model, max_tokens: pIn.body.max_tokens, tools: pIn.body.tools, timeout_ms: pIn.timeout_ms, messages: [{ role: "user", content: content }] }; };
      const realSnap = realSnaps && realSnaps.find(t => t[0] === tabKey), realState = realSnap ? this.snapshot(realSnap[2]) : null;
      const shownValue = realSnap ? (realState.state === "ready" ? (realState.content === undefined || realState.content === null ? "—" : realState.content) : realState.state === "pending" ? "Loading " + (realState.bytes ? Math.round(realState.bytes / 1024) + " KB" : "the snapshot") + "…" : realState.state === "missing" ? "This snapshot was not stored." : "This snapshot could not be read.")
        : realSnaps && tabKey === "value" ? undefined : tabKey === "value" ? value : tabKey === "prompt" ? assembled()
        : tabKey === "context" ? (pIn.context || "(this call declares no context)") : tabKey === "input" ? pIn : tabKey === "output" ? (sel.row && !isModel ? sel.row : producer.op.output) : tabKey === "request" ? { path: producer.stage.method + " " + producer.stage.path, body: producer.stage.request } : { status: producer.stage.status + (producer.stage.code ? " · " + producer.stage.code : ""), body: producer.stage.response };
      let json = shownValue === undefined || shownValue === null ? "" : (typeof shownValue === "string" ? shownValue : JSON.stringify(shownValue, null, 2));
      if (realState && realState.state === "ready" && realState.truncated) json = "// cut to the byte bound when it was recorded\n" + json;
      const tabNote = realSnaps && !realSnaps.length ? "This operation kept no payload; open it in the inspector for its attributes and events." : realState && realState.state === "ready" ? (realState.redacted ? "redacted before it was stored" : "stored as sent") : "";
      detail = { label: (sel.group ? sel.group + " · " : "") + sel.label, sub: sel.sub, rendered: null, hasRendered: false, showRaw: !!json, rawLabel: "", toggleRaw: () => {},
        tabs: tabDefs.map(([k, label]) => ({ label: label, select: () => this.setState({ flowTab: k }), bg: tabKey === k ? "#171717" : "#fff", color: tabKey === k ? "#fff" : "#4d4d4d", border: tabKey === k ? "#171717" : "#eaeaea" })),
        tabNote: tabNote,
        status: source ? "Last written on " + source.rec.name + " at " + this.clock(source.op.at) + " by “" + source.op.name + "”" + (source.op.kind === "model" ? " (a model call)" : "") + (w.length > 1 ? " · " + w.length + " writes so far" : "") : "",
        hasValue: !!json, json: json || "", why: why ? "Why · " + why : "", hasWhy: !!why,
        openLabel: source ? "open in inspector ›" : "", open: () => { if (!source) return; const o = Object.assign({}, this.state.open); o[source.stage.id] = true; this.setState({ open: o, viewing: S.recordings.indexOf(source.rec) }); this.select("live", source.stage.id, source.op.id); },
        note: S.notes[sel.id] || "", setNote: (e) => this.setNote(sel.id, e.target.value), noteCount: Object.keys(S.notes).filter(k => (S.notes[k] || "").trim()).length,
        close: () => this.setState({ flowSel: null, detailModal: false }) };
    }
    return { nodes: nodes, edges: edges, junctions: junctions, edgeLabels: [], detail: detail, total: FLOW.nodes.length, width: Math.max(240, zz(maxX + NW + PX)), height: Math.max(60, zz(maxY + NH + PY)) };
  }
  inspectorVM() {
    const K = this.KINDS, found = this.findOp(this.state.sel); if (!found) return null;
    const tab = this.state.inspTab, tabs = [];
    const mk = (key, label) => ({ label: label, select: () => this.setState({ inspTab: key, copied: false }), bg: tab === key ? "#171717" : "#fff", color: tab === key ? "#fff" : "#4d4d4d", border: tab === key ? "#171717" : "#eaeaea" });
    let json, meta = [], name, target, kind, redactedNote = null;
    if (found.op && found.op.real) {
      const o = found.op; kind = o.kind; name = o.name; target = o.target; const sn = o.snaps; const list = [];
      if (sn.input) list.push(["input", "Input", sn.input]);
      if (sn.output) list.push(["output", "Output", sn.output]);
      if (sn.raw) list.push(["raw", "Raw reply", sn.raw]);
      sn.extra.forEach(x => list.push(["snap:" + x.kind, x.kind.replace(/_/g, " "), x.id]));
      if (sn.error) list.push(["errsnap", "Error detail", sn.error]);
      list.push(["attrs", "Attributes", null]);
      if (o.events.length) list.push(["events", "Events", null]);
      if (o.error) list.push(["error", "Error", null]);
      const cur = list.find(t => t[0] === tab) || list[0];
      list.forEach(t => tabs.push(mk(t[0], t[1])));
      if (cur[2]) {
        const s = this.snapshot(cur[2]);
        json = s.state === "ready" ? (s.content === undefined || s.content === null ? "—" : JSON.stringify(s.content, null, 2)) : s.state === "pending" ? "Loading " + (s.bytes ? Math.round(s.bytes / 1024) + " KB" : "the snapshot") + "…" : s.state === "missing" ? "This snapshot was not stored." : "This snapshot could not be read.";
        if (s.truncated) json = "// cut to the byte bound when it was recorded\n" + json;
        redactedNote = s.state === "ready" ? (s.redacted ? "redacted before it was stored" : "stored as sent") : "";
      } else json = cur[0] === "attrs" ? JSON.stringify(o.attributes, null, 2) : cur[0] === "events" ? JSON.stringify(o.events, null, 2) : JSON.stringify({ error: o.error }, null, 2);
      meta.push({ k: "status", v: o.status }, { k: "took", v: this.fmtMs(o.ms) }, { k: "level", v: o.level || "—" });
      if (o.kind === "model") { const t = o.meta.tokens || {}; meta.push({ k: "model", v: o.meta.model || o.meta.family || "—" }); if (t.input != null) meta.push({ k: "in", v: t.input.toLocaleString() }); if (t.cache_write) meta.push({ k: "cache write", v: t.cache_write.toLocaleString() }); if (t.cache_read) meta.push({ k: "cache read", v: t.cache_read.toLocaleString() }); if (t.output != null) meta.push({ k: "out", v: t.output.toLocaleString() }); if (o.meta.finish) meta.push({ k: "finish", v: o.meta.finish }); }
      if (o.meta.code != null) meta.push({ k: "http", v: String(o.meta.code) });
    } else if (found.stage && found.stage.real) {
      // A recorded action. When this page saw the request go out, the browser's side of it is here too.
      const s = found.stage; kind = "api"; name = s.label; target = s.method + " " + s.path;
      const list = [];
      if (s.observed) list.push(["input", "Request"], ["output", "Response"]);
      list.push(["attrs", "Attributes"]); if (s.error) list.push(["error", "Error"]);
      const cur = list.find(t => t[0] === tab) || list[0];
      list.forEach(t => tabs.push(mk(t[0], t[1])));
      const show = v => v === undefined || v === null ? "—" : JSON.stringify(v, null, 2);
      json = cur[0] === "input" ? show(s.request) : cur[0] === "output" ? show(s.response) : cur[0] === "error" ? show(s.error) : show(s.attributes);
      meta.push({ k: "status", v: s.status + (s.code ? " · " + s.code : "") }, { k: "server time", v: this.fmtMs(s.ms) });
      if (s.observed) meta.push({ k: "round trip", v: this.fmtMs(s.browserMs) });
      meta.push({ k: "ops", v: String(s.ops.length) }, { k: "trace", v: String(s.trace_id || "").slice(0, 12) || "—" });
      if (s.observed) { if (s.step) meta.push({ k: "step", v: s.step }); } else meta.push({ k: "body", v: "not recorded" });
    } else if (found.op) {
      const o = found.op; kind = o.kind; name = o.name; target = o.target;
      tabs.push(mk("input", "Input"), mk("output", "Output"));
      const body = tab === "input" ? o.input : (o.status === "error" ? { error: o.error } : o.output);
      json = body === undefined || body === null ? "—" : JSON.stringify(body, null, 2);
      meta.push({ k: "status", v: o.status }, { k: "took", v: this.fmtMs(o.ms) });
      if (o.kind === "model" && o.meta) { const t = o.meta.tokens || {}; meta.push({ k: "model", v: o.meta.model || o.meta.family }); if (t.input) meta.push({ k: "in", v: t.input.toLocaleString() }); if (t.cache_write) meta.push({ k: "cache write", v: t.cache_write.toLocaleString() }); if (t.cache_read) meta.push({ k: "cache read", v: t.cache_read.toLocaleString() }); if (t.output) meta.push({ k: "out", v: t.output.toLocaleString() }); if (t.web_searches) meta.push({ k: "searches", v: String(t.web_searches) }); meta.push({ k: "est. cost", v: this.fmtCost(o.meta.cost) || "$0" }); }
    } else {
      // A simulated request, or a real one the server did not trace (a poll, the config read, the upload).
      const s = found.stage; kind = "api"; name = s.label; target = s.method + " " + s.path;
      tabs.push(mk("input", "Request"), mk("output", "Response")); if (s.observed && (s.error || s.traceError)) tabs.push(mk("error", "Error"));
      const body = tab === "input" ? s.request : tab === "error" ? { error: s.error || undefined, trace: s.traceError || undefined } : s.response; json = body === undefined || body === null ? "—" : JSON.stringify(body, null, 2);
      meta.push({ k: "status", v: s.status + (s.code ? " · " + s.code : "") }, { k: s.observed ? "round trip" : "server time", v: this.fmtMs(s.ms) }, { k: "ops", v: String(s.ops.length) });
      if (s.direct) meta.push({ k: "route", v: "browser → Storage, no function" });
      if (s.observed) { meta.push({ k: "trace", v: s.awaiting === "pending" ? "reading…" : s.awaiting === "missing" ? "not recorded" : "none: untraced request" }); if (s.count > 1) meta.push({ k: "polls", v: String(s.count) }); if (s.step) meta.push({ k: "step", v: s.step }); }
    }
    const redacted = (json.match(/••••|\[redacted\]/g) || []).length;
    let counterpart = null;
    if (found.side) { const d = this.compareData(); const row = d && d.rows.find(r => (found.side === "A" ? r.a : r.b) && (found.side === "A" ? r.a.id : r.b.id) === found.stage.id);
      if (row) { const pair = found.op ? row.pairs.find(p => (found.side === "A" ? p.a : p.b) === found.op) : null; const other = found.side === "A" ? (pair ? pair.b : row.b) : (pair ? pair.a : row.a);
        if (other) counterpart = () => this.select(found.side === "A" ? "B" : "A", found.op ? (found.side === "A" ? row.b.id : row.a.id) : other.id, found.op ? other.id : null); } }
    return { kindLabel: K[kind].label, bg: K[kind].bg, color: K[kind].color, name: name, target: target, meta: meta, tabs: tabs, json: json,
      side: found.side ? "side " + found.side : "", sideColor: found.side === "B" ? "#0070f3" : "#8f8f8f",
      redacted: redacted ? redacted + " secret" + (redacted > 1 ? "s" : "") + " redacted" : redactedNote != null ? redactedNote : "nothing redacted",
      counterpartLabel: counterpart ? "see in " + (found.side === "A" ? "B" : "A") + " ›" : "", counterpartColor: counterpart ? "#0070f3" : "transparent", counterpart: counterpart || (() => {}), raw: json };
  }
  renderVals() {
    const S = this.state, K = this.KINDS, live = this.viewed(), isLiveRec = live === this.target(), t = this.totals(live.stages);
    const showPolls = this.props.showPolls ?? true;
    const visible = live.stages.filter(s => showPolls || !s.poll);
    const counts = {}; live.stages.forEach(s => s.ops.forEach(o => { counts[o.kind] = (counts[o.kind] || 0) + 1; }));
    const insp = this.inspectorVM();
    const real = this.isReal();
    // A real run draws the lineage its operations recorded (engelbart.lineage.reads / .writes). A run recorded
    // before that was part of the contract has none, and no edge is guessed for it.
    const lineageUnavailable = real && !live.lineage;
    const flow = lineageUnavailable ? { nodes: [], edges: [], junctions: [], width: 0, height: 0, detail: null } : this.flowVM(live);
    const tokens = live.stages.reduce((n, s) => n + s.ops.reduce((m, o) => m + ((o.meta && o.meta.tokens && ((o.meta.tokens.input || 0) + (o.meta.tokens.output || 0))) || 0), 0), 0);
    const cmp = this.compareData();
    const testMode = this.props.productTestMode ?? false;
    const knobRows = this.KNOBS.map(kn => ({ label: kn.label, desc: kn.desc, options: kn.options.map(([v, label]) => { const on = String(S.knobs[kn.key]) === String(v); return { label: label, bg: on ? "#171717" : "transparent", color: on ? "#fff" : "#4d4d4d", select: () => { const k = Object.assign({}, S.knobs); k[kn.key] = v; this.setState({ knobs: k }); } }; }) }));
    const badge = { same: ["same", "#f2f2f2", "#4d4d4d"], changed: ["changed", "#e6f0fd", "#0761d1"], "only-a": ["only in A", "oklch(0.95 0.04 25)", "oklch(0.45 0.16 25)"], "only-b": ["only in B", "oklch(0.95 0.04 150)", "oklch(0.42 0.13 150)"] };
    const pairBg = { same: "#fff", changed: "#e6f0fd", removed: "oklch(0.95 0.04 25)", added: "oklch(0.95 0.04 150)" };
    const cmpRows = cmp ? cmp.rows.map(r => { const open = !!S.cmpOpen[r.i]; const a = r.a, b = r.b; const stats = s => s ? s.ops.length + " ops · " + this.fmtMs(s.ms) + (this.fmtCost(s.ops.reduce((n, o) => n + ((o.kind === "model" && o.meta && o.meta.cost) || 0), 0)) ? " · " + this.fmtCost(s.ops.reduce((n, o) => n + ((o.kind === "model" && o.meta && o.meta.cost) || 0), 0)) : "") : "—";
      return { seqLabel: this.pad(r.i + 1), label: (a || b).label, badge: badge[r.status][0], badgeBg: badge[r.status][1], badgeColor: badge[r.status][2], aStats: stats(a), bStats: stats(b), chevron: open ? "⌃" : "›", open: open,
        toggle: () => { const o = Object.assign({}, S.cmpOpen); o[r.i] = !open; this.setState({ cmpOpen: o }); },
        pairs: r.pairs.map(p => ({ aName: p.a ? p.a.name : "", bName: p.b ? p.b.name : "", aMs: p.a ? this.fmtMs(p.a.ms) : "", bMs: p.b ? this.fmtMs(p.b.ms) : "",
          aKindColor: p.a ? K[p.a.kind].color : "transparent", bKindColor: p.b ? K[p.b.kind].color : "transparent",
          aBg: p.a ? (S.sel && S.sel.op === p.a.id && S.sel.run === "A" ? "#dbe8fd" : (p.kind === "changed" ? pairBg.changed : p.kind === "removed" ? pairBg.removed : "#fff")) : "#fafafa",
          bBg: p.b ? (S.sel && S.sel.op === p.b.id && S.sel.run === "B" ? "#dbe8fd" : (p.kind === "changed" ? pairBg.changed : p.kind === "added" ? pairBg.added : "#fff")) : "#fafafa",
          aCursor: p.a ? "pointer" : "default", bCursor: p.b ? "pointer" : "default",
          selectA: () => { if (p.a) this.select("A", a.id, p.a.id); }, selectB: () => { if (p.b) this.select("B", b.id, p.b.id); } })) }; }) : [];
    const tA = cmp ? this.totals(cmp.A) : null, tB = cmp ? this.totals(cmp.B) : null;
    const metric = (label, fa, fb, fmt) => { const d = fb - fa; return { label: label, a: fmt(fa), b: fmt(fb), delta: d === 0 ? "—" : (d > 0 ? "+" : "−") + fmt(Math.abs(d)), deltaColor: d === 0 ? "#c9c9c9" : "#171717" }; };
    const cmpMetrics = cmp ? [metric("Requests", tA.requests, tB.requests, String), metric("Operations", tA.ops, tB.ops, String), metric("Model calls", tA.model, tB.model, String), metric("Estimated cost", tA.cost, tB.cost, v => "$" + v.toFixed(3)), metric("Server time", tA.ms, tB.ms, v => this.fmtMs(v) === "—" ? "0" : this.fmtMs(v)), metric("DB writes", tA.dbWrites, tB.dbWrites, String), metric("External calls", tA.external, tB.external, String), metric("Failed requests", tA.errors, tB.errors, String)] : [];
    const changedStages = cmp ? cmp.rows.filter(r => r.status !== "same").length : 0;
    // The Prompts view: every model call of the recording on screen, grouped by the prompt it sent, in the
    // order the reader meets the prompts; the selected prompt's calls with their input as sent and reply.
    const calls = []; live.stages.forEach(st => st.ops.forEach(o => { const key = this.templateOf(o); if (key) calls.push({ key: key, stage: st, op: o }); }));
    const promptCount = calls.length, order = this.PROMPT_ORDER();
    const keys = Array.from(new Set(calls.map(c => c.key))).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
    const promptKey = keys.indexOf(S.promptSel) >= 0 ? S.promptSel : keys[0];
    const promptTabs = keys.map(k => { const mine = calls.filter(c => c.key === k), on = k === promptKey; return { key: k, label: this.PROMPT_LABEL(k), count: String(mine.length), edited: mine.some(c => this.promptEdited(c.op)), on: on, bg: on ? "#171717" : "#fff", color: on ? "#fff" : "#4d4d4d", border: on ? "#171717" : "#eaeaea", select: () => this.setState({ promptSel: k }) }; });
    const promptCalls = calls.filter(c => c.key === promptKey).map(c => this.promptCallVM(c.stage, c.op));
    return {
      cfg: (() => { const c = S.config; if (!c) return { open: false }; const d = c.draft, P = this.PROMPTS(), sec = c.section || "about";
        const seg = (list, cur, set) => list.map(([v, label]) => ({ label: label, bg: String(cur) === String(v) ? "#171717" : "transparent", color: String(cur) === String(v) ? "#fff" : "#4d4d4d", select: () => set(v) }));
        const vm = { open: true, title: c.mode === "new" ? "New environment" : "Configure environment", saveLabel: c.mode === "new" ? "Create environment" : "Save",
          sections: [["about", "About"], ["participant", "Participant"], ["prompts", "Prompts"]].map(([k, label]) => ({ label: label, color: sec === k ? "#171717" : "#8f8f8f", line: sec === k ? "#171717" : "transparent", select: () => this.setState({ config: Object.assign({}, c, { section: k }) }) })),
          isAbout: sec === "about", isParticipant: sec === "participant", isPrompts: sec === "prompts",
          name: d.name, setName: (e) => this.setDraft("name", e.target.value), description: d.description, setDescription: (e) => this.setDraft("description", e.target.value), notes: d.notes, setNotes: (e) => this.setDraft("notes", e.target.value),
          pEnabled: !!d.participant.enabled, pToggle: seg([[true, "Prefilled"], [false, "Blank"]], d.participant.enabled, v => this.setDraft("participant.enabled", v)),
          pName: d.participant.name, setPName: (e) => this.setDraft("participant.name", e.target.value), pMajor: d.participant.major, setPMajor: (e) => this.setDraft("participant.major", e.target.value),
          pYear: d.participant.year, years: this.YEARS().concat(["Something else"]).map(y => { const other = y === "Something else", on = other ? this.YEARS().indexOf(d.participant.year) < 0 : d.participant.year === y; return { label: y, bg: on ? "#171717" : "transparent", color: on ? "#fff" : "#4d4d4d", select: () => this.setDraft("participant.year", other ? "" : y) }; }),
          yearOther: this.YEARS().indexOf(d.participant.year) < 0, setPYear: (e) => this.setDraft("participant.year", e.target.value),
          majorSeeds: this.MAJORS().filter(m => { const t = String(d.participant.major || "").trim().toLowerCase(); return m.toLowerCase() !== t && (!t || m.toLowerCase().indexOf(t) >= 0); }).slice(0, 6).map(m => ({ label: m, select: () => this.setDraft("participant.major", m) })),
          depths: seg(this.DEPTHS(), d.participant.depth, v => this.setDraft("participant.depth", v)),
          fams: this.FAMS().map((f, i) => ({ label: f, bg: Number(d.participant.paperFamiliarity) === i ? "#171717" : "transparent", color: Number(d.participant.paperFamiliarity) === i ? "#fff" : "#4d4d4d", select: () => this.setDraft("participant.paperFamiliarity", i) })),
          paperPrompt: d.participant.paper ? "Choose a different PDF" : "Add the PhD student's paper · drop a PDF or click to choose", paperName: d.participant.paper ? d.participant.paper.name + " · PDF · " + (d.participant.paper.size / 1024 / 1024).toFixed(1) + " MB" : "", hasPaper: !!d.participant.paper,
          setPaper: (e) => { const f = e.target.files && e.target.files[0]; if (f) this.setDraft("participant.paper", { name: f.name, size: f.size }); }, clearPaper: () => this.setDraft("participant.paper", null),
          pProject: d.participant.projectUrl, setPProject: (e) => this.setDraft("participant.projectUrl", e.target.value), pRepo: d.participant.repoUrl, setPRepo: (e) => this.setDraft("participant.repoUrl", e.target.value),
          participantNote: c.mode === "new" ? "A prefilled participant has finished a setup before: the product opens at the Paper step with name, year, major and register on record, and the links and familiarity below already entered." : "Participant changes take effect after Reset test environment; prompt changes apply to the next model call.",
          prompts: P.map(([key, label, def]) => { const cur = d.prompts[key]; const changed = cur != null && cur !== def; return { key: key, label: label, changed: changed, badge: changed ? "edited" : "", value: cur != null ? cur : def, set: (e) => this.setDraft("prompts." + key, e.target.value), reset: () => { const p = Object.assign({}, d.prompts); delete p[key]; this.setDraft("prompts", p); }, resetLabel: changed ? "reset to default" : "" }; }),
          promptTabs: P.map(([key, label, def]) => { const cur = d.prompts[key], changed = cur != null && cur !== def, on = (c.promptTab || P[0][0]) === key; return { key: key, label: label, changed: changed, on: on, color: on ? "#171717" : changed ? "#0070f3" : "#8f8f8f", bg: on ? "#171717" : "transparent", fg: on ? "#fff" : changed ? "#0070f3" : "#4d4d4d", border: on ? "#171717" : changed ? "#0070f3" : "#eaeaea", select: () => this.setState({ config: Object.assign({}, c, { promptTab: key }) }) }; }),
          cancel: () => this.setState({ config: null }), save: () => this.saveConfig() };
        vm.prompt = vm.prompts.find(pp => pp.key === (c.promptTab || P[0][0])) || vm.prompts[0]; vm.editedCount = vm.prompts.filter(pp => pp.changed).length;
        return vm; })(),
      // The dashboard is Simulated mode with nothing open; its cards are ordered by the last opening, then creation.
      isDashboard: !real && !S.envId, envsEmpty: !S.envs.length,
      envCards: S.envs.slice().sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0)).map(e => this.envCard(e)),
      newEnv: () => this.openConfig("new"),
      envId: S.envId || "",
      envOptions: S.envs.map(e => ({ value: e.id, label: e.name })).concat([{ value: "__all", label: "All environments…" }, { value: "__configure", label: "Configure this environment…" }, { value: "__new", label: "New environment…" }, { value: "__delete", label: "Delete this environment…" }]),
      envSelect: (e) => { const v = e.target.value; if (v === "__all") this.closeEnv(); else if (v === "__configure") this.openConfig("edit"); else if (v === "__new") this.openConfig("new"); else if (v === "__delete") { this.deleteEnv(S.envs.find(x => x.id === S.envId)); this.forceUpdate(); } else if (v && v !== S.envId) this.openEnv(v); },
      notice: S.notice,
      resetProduct: () => { if (window.confirm("Reset the test environment? The simulated account's setup is dropped, the product reloads at step one, and every step tab is cleared.")) { const tabs = this.loadTabs(); this.setState({ recordings: tabs, targetId: tabs[0].id, viewing: 0, sel: null, open: {}, flowSel: null, connected: false, flowPos: {}, flowPan: { x: 0, y: 0 } }, () => this.saveEnvData()); this.cmd("reset"); } },
      recordings: S.recordings.map((r, i) => { const on = r === live, isTarget = r === this.target(); return { id: r.id, label: r.name, title: (r.step ? "requests made while the product is on the " + r.step + " step · " : "requests made before the first step is on screen · ") + (on ? "click the name to rename" : "click to view"), on: on, off: !on, color: on ? "#171717" : "#8f8f8f", subColor: on ? "#4d4d4d" : "#c9c9c9", line: on ? "#171717" : "transparent", dot: isTarget ? "#0070f3" : "transparent",
        select: () => { if (!on) this.setState({ viewing: i, sel: null, stick: true, flowSel: null }); },
        rename: (e) => { r.name = e.target.value || r.step || "Start"; this.forceUpdate(); },
        closable: !!r.step && !isTarget, close: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.removeTab(r); } }; }),
      statTiles: [
        { k: "requests", v: String(t.requests), help: "Calls the page made to the server (one per Continue, poll, upload…)" },
        { k: "operations", v: String(t.ops), help: "Things the server did to answer those requests: auth checks, database reads and writes, storage, model calls, link checks" },
        { k: "model calls", v: String(t.model), help: "Operations that called a model through LiteLLM" },
        real ? { k: "tokens", v: tokens.toLocaleString(), help: "Input and output tokens the model calls recorded" } : { k: "est. cost", v: t.cost ? this.fmtCost(t.cost) : "$0", help: "Estimated model spend, from token counts" },
        { k: "server time", v: this.fmtMs(t.ms) === "—" ? "0 ms" : this.fmtMs(t.ms), help: real ? "Time the server recorded for each action, summed" : "Simulated time the server spent answering, summed across requests" }],
      views: [["flow", "Data flow"], ["requests", "Requests" + (t.requests ? " · " + t.requests : "")], ["prompts", "Prompts" + (promptCount ? " · " + promptCount : "")]].map(([k, label]) => ({ key: k, label: label, color: (S.view || "flow") === k ? "#171717" : "#8f8f8f", line: (S.view || "flow") === k ? "#171717" : "transparent", select: () => this.setState({ view: k }) })),
      isFlowView: (S.view || "flow") === "flow", isRequestsView: (S.view || "flow") === "requests", isPromptsView: (S.view || "flow") === "prompts",
      promptTabs: promptTabs, promptCalls: promptCalls, promptsEmpty: !promptCount, promptSelLabel: promptTabs.length ? this.PROMPT_LABEL(promptKey) : "",
      promptsEmptyText: real ? (S.real.picked ? "This run recorded no model calls." : "No model calls yet. When the product asks the model, each call lands here under its prompt.") : "No model calls on this step yet. When the product asks the model, each call lands here under its prompt.",
      flowNodes: flow.nodes, flowEdges: flow.edges, flowDetail: flow.detail || {}, flowHasDetail: !!flow.detail, flowOpen: true,
      flowW: flow.width, flowH: flow.height, flowEmpty: !flow.nodes.length, flowHasNodes: flow.nodes.length > 0, flowJunctions: flow.junctions, lineageUnavailable: lineageUnavailable,
      flowZoomLabel: Math.round(S.flowZoom * 100) + "%",
      zoomIn: () => this.setState({ flowZoom: Math.min(2.5, Math.round((S.flowZoom + 0.15) * 100) / 100) }), zoomOut: () => this.setState({ flowZoom: Math.max(0.4, Math.round((S.flowZoom - 0.15) * 100) / 100) }),
      zoomReset: () => this.setState({ flowZoom: 1, flowPos: {}, flowPan: { x: 0, y: 0 } }), hasLayoutChanges: Object.keys(S.flowPos).length > 0 || S.flowZoom !== 1 || !!(S.flowPan && (S.flowPan.x || S.flowPan.y)),
      flowPanX: (S.flowPan || { x: 0 }).x, flowPanY: (S.flowPan || { y: 0 }).y,
      toggleFlowModal: () => this.setState({ flowModal: !S.flowModal }), flowModalLabel: S.flowModal ? "close" : "expand",
      fc: S.flowModal ? { pos: "fixed", left: "3vw", top: "4vh", w: "94vw", h: "92vh", z: 60, scrollFlex: "1 1 auto", scrollMax: "none", scrollH: "auto" } : { pos: "relative", left: "auto", top: "auto", w: "auto", h: "auto", z: "auto", scrollFlex: "0 0 auto", scrollMax: "none", scrollH: (S.flowHeight || 360) + "px" },
      panDown: (e) => this.panDown(e), resizeDown: (e) => this.resizeDown(e),
      toggleDetailModal: () => this.setState({ detailModal: !S.detailModal }), detailModalLabel: S.detailModal ? "close" : "expand",
      dm: S.detailModal ? { pos: "fixed", left: "8vw", top: "6vh", w: "84vw", h: "88vh", z: 70, border: "1px solid #eaeaea", radius: "12px", pad: "16px 18px 18px", preFlex: "1 1 auto", preMax: "none" } : { pos: "relative", left: "auto", top: "auto", w: "auto", h: "auto", z: "auto", border: "none", radius: "0", pad: "12px 14px 13px", preFlex: "0 1 auto", preMax: "420px" },
      anyModal: S.flowModal || S.detailModal, closeModals: () => this.setState({ flowModal: false, detailModal: false }),
      lastRan: live.stages.length ? "Last run: " + this.clock(live.stages[live.stages.length - 1].at) : "Last run: —",
      // Real mode names only its mode: no environment, no prefilled participant, and never the product's test
      // switch, whose reset buttons would clear the member's real record. The dashboard mounts no frame at all.
      frameSrc: real ? "/engelbart/setup/test/frame?mode=real" : S.envId ? "/engelbart/setup/test/frame?env=" + S.envId + (testMode ? "&test=true" : "") + this.participantParam((S.envs.find(e => e.id === S.envId) || {}).config) : "",
      onListScroll: (e) => { const el = e.target; const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48; if (stick !== S.stick) this.setState({ stick: stick }); },
      isLive: S.tab === "live", isCases: S.tab === "cases", isCompare: S.tab === "compare",
      liveEmpty: !visible.length, stages: visible.map((s, i) => this.stageVM(s, live.stages.indexOf(s), "live", live)),
      kindChips: Object.keys(K).map(k => ({ key: k, label: K[k].label, color: K[k].color, count: String(counts[k] || 0), title: K[k].title, bg: S.hideKinds[k] ? "transparent" : K[k].bg, border: S.hideKinds[k] ? "#eaeaea" : "transparent", opacity: S.hideKinds[k] ? 0.55 : 1, toggle: () => { const hk = Object.assign({}, S.hideKinds); hk[k] = !hk[k]; this.setState({ hideKinds: hk }); } })),
      casesEmpty: !S.cases.length,
      cases: S.cases.map(c => { const tc = this.totals(c.stages); return { id: c.id, name: c.name, rename: (e) => { c.name = e.target.value; const cases = S.cases.slice(); this.persist(cases); this.setState({ cases: cases }); },
        meta: "saved " + this.clock(c.savedAt) + " · " + tc.requests + " requests · " + tc.ops + " ops · " + tc.model + " model calls · " + (this.fmtCost(tc.cost) || "$0") + " · " + c.runs.length + (c.runs.length === 1 ? " isolated run" : " isolated runs"),
        requestCount: c.requests.length, knobsOpen: S.caseOpen === c.id, knobsLabel: S.caseOpen === c.id ? "Close" : "Try a change ›", toggleKnobs: () => this.setState({ caseOpen: S.caseOpen === c.id ? null : c.id }),
        remove: () => { if (!window.confirm("Delete this test case and its isolated runs?")) return; const cases = S.cases.filter(x => x !== c); this.persist(cases); this.setState({ cases: cases, compare: S.compare && S.compare.caseId === c.id ? null : S.compare }); },
        runIsolated: () => this.runIsolated(c),
        runs: c.runs.map(r => { const tr = this.totals(r.stages); return { id: r.id, name: r.name, meta: tr.ops + " ops · " + tr.model + " model calls · " + (this.fmtCost(tr.cost) || "$0") + " · " + this.fmtMs(tr.ms) + " server" + (tr.errors ? " · " + tr.errors + " failed" : ""), compare: () => this.setState({ tab: "compare", compare: { caseId: c.id, runId: r.id }, cmpOpen: {}, sel: null }) }; }) }; }),
      knobRows: knobRows, knobSummary: "Changes: " + this.knobDiff(S.knobs), running: S.running, runLabel: S.running ? "Running…" : "Run in isolation",
      compareEmpty: !cmp, compareReady: !!cmp,
      cmpAName: cmp ? cmp.c.name : "", cmpAKnobs: cmp ? this.knobDiff(cmp.c.knobs) : "", cmpBName: cmp ? cmp.run.name : "", cmpBKnobs: cmp ? this.knobDiff(cmp.run.knobs) : "",
      cmpMetrics: cmpMetrics, cmpRows: cmpRows, cmpStageSummary: cmp ? (changedStages ? changedStages + " of " + cmp.rows.length + " requests differ" : "all " + cmp.rows.length + " requests identical") : "",
      hasInspector: !!insp, insp: insp || {}, closeInspector: () => this.setState({ sel: null }),
      isReal: real, real: this.realVM(),
      copyLabel: S.copied ? "Copied" : "Copy JSON", copyJson: () => { if (insp && navigator.clipboard) navigator.clipboard.writeText(insp.raw).then(() => this.setState({ copied: true }), () => {}); }
    };
  }
  // Real mode's view model: the run picker, the member's session and the frame's word on it.
  realVM() {
    const S = this.state, R = S.real, real = S.mode === "real";
    const label = r => (r.project_name || r.paper_title || ("onboarding " + String(r.onboarding_id).slice(0, 8))) + " · " + this.dateOf(r.telemetry && r.telemetry.started_at || r.created_at) + (r.telemetry && r.telemetry.status === "failed" ? " · failed" : "");
    // Earlier runs: the member's other onboardings that recorded something. The one the product is on is this session.
    const earlier = (R.runs || []).filter(r => r.telemetry && r.onboarding_id !== R.onboardingId);
    const fresh = R.picked ? Math.max(0, R.requests.length - (R.seenAt || 0)) : 0;
    const options = [{ value: "__current", label: "Current session" + (fresh ? " · " + fresh + " new" : "") }]
      .concat(earlier.map(r => ({ value: r.onboarding_id, label: label(r) })))
      .concat([{ value: "__refresh", label: R.loading ? "Refreshing the list…" : (R.runs ? "Refresh the list" : "Load earlier runs") }]);
    const fs = R.frameSession;
    const editedOf = e => Object.keys(e.config && e.config.prompts || {}).length;
    const promptOptions = [{ value: "", label: "Server prompts" }].concat(S.envs.map(e => ({ value: e.id, label: e.name + " · " + (editedOf(e) ? editedOf(e) + " edited" : "no edits") })));
    const chosen = S.envs.find(e => e.id === S.realPrompts), chosenEdits = chosen ? editedOf(chosen) : 0;
    return { isReal: real, pickerValue: R.picked ? R.picked.onboarding_id : "__current", pickerOptions: options, pick: (e) => this.pickRun(e.target.value),
      promptValue: chosen ? chosen.id : "", promptOptions: promptOptions, pickPrompts: (e) => this.pickRealPrompts(e.target.value),
      promptsApplied: chosenEdits ? chosenEdits + " edited prompt" + (chosenEdits === 1 ? "" : "s") : "", promptsTitle: chosen ? (chosenEdits ? "The product's model calls use the " + chosenEdits + " edited prompt" + (chosenEdits === 1 ? "" : "s") + " of “" + chosen.name + "”; every other prompt is the server's own" : "“" + chosen.name + "” edits no prompt, so the server's own are used") : "The product's model calls use the server's own prompts; choose an environment to use its edited prompts for your run",
      email: (R.session && R.session.email) || (fs && fs.email) || "", error: R.error || "", loading: !!R.loading,
      signedOut: !!(fs && fs.signedIn === false), signedOutWhy: (fs && fs.error) || "", reloadFrame: () => this.reloadFrame(),
      viewingPicked: !!R.picked, pickedTitle: R.picked ? label(R.picked) : "" };
  }
  // The product left for /engelbart/signin, which refuses to be framed: say so over the empty frame.
  renderSignedOut(R) {
    return h("div", { "data-screen-label": "Signed out", style: css("position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#fafafa") },
      h("div", { style: css("max-width:380px;border:1px solid #eaeaea;border-radius:10px;background:#fff;padding:16px 18px") },
        h("div", { style: css("font:500 13px/1.5 " + SANS + ";color:#171717") }, "Sign in to Engelbart to use Real mode"),
        h("div", { style: css("margin-top:4px;font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") },
          "Real mode runs the setup page as you, with your own session, and this browser has none. ",
          h("a", { href: "/engelbart/signin", target: "_blank", rel: "noopener", style: css("color:#0070f3") }, "Sign in"), " in a new tab, then reload the frame.",
          R.signedOutWhy ? " (" + R.signedOutWhy + ")" : ""),
        h("button", { onClick: R.reloadFrame, className: "hv-ink-line", style: css("margin-top:12px;padding:8px 14px;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#4d4d4d;background:transparent;border:1px solid #eaeaea;border-radius:999px") }, "Reload the frame")));
  }
  // --- the template ------------------------------------------------------------------------------------
  // On the dashboard the bar carries the wordmark and the notice alone; the environment dropdown and the reset
  // belong to an open environment. In Real mode (?mode=real) it carries the run picker and the member instead.
  renderTopBar(V) {
    const R = V.real;
    return h("div", { "data-screen-label": "Top bar", style: css("flex:none;min-height:46px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:6px 14px 6px 16px;border-bottom:1px solid #eaeaea;white-space:nowrap") },
      h("span", { style: css("font:500 17px/1 " + SANSF + ";letter-spacing:-0.2px") }, "Engelbart"),
      V.isReal
        ? h("select", { value: R.pickerValue, onChange: R.pick, "data-run-picker": "1", title: "what the panel shows: this session, or one of your earlier runs", style: css("max-width:320px;padding:6px 28px 6px 12px;border:1px solid #eaeaea;border-radius:999px;background:#fff;font:500 12.5px/1.3 " + SANS + ";color:#171717;outline:none;cursor:pointer") },
          R.pickerOptions.map(o => h("option", { key: o.value, value: o.value }, o.label)))
        : V.isDashboard ? null : h("select", { value: V.envId, onChange: V.envSelect, title: "switch environment", style: css("max-width:280px;padding:6px 28px 6px 12px;border:1px solid #eaeaea;border-radius:999px;background:#fff;font:500 12.5px/1.3 " + SANS + ";color:#171717;outline:none;cursor:pointer") },
          V.envOptions.map(eo => h("option", { key: eo.value, value: eo.value }, eo.label))),
      V.isReal ? h("select", { value: R.promptValue, onChange: R.pickPrompts, "data-prompt-picker": "1", title: R.promptsTitle, style: css("max-width:260px;padding:6px 28px 6px 12px;border:1px solid " + (R.promptsApplied ? "#0070f3" : "#eaeaea") + ";border-radius:999px;background:#fff;font:500 12.5px/1.3 " + SANS + ";color:" + (R.promptsApplied ? "#0070f3" : "#171717") + ";outline:none;cursor:pointer") },
          R.promptOptions.map(o => h("option", { key: o.value, value: o.value }, o.label))) : null,
      h("span", { style: css("font:12px/1.4 " + SANS + ";color:#e70022;flex:1 1 40px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, V.notice || (V.isReal ? R.error : "")),
      V.isReal ? (R.email ? h("span", { title: "the member the product runs as", style: css("font:11px/1 " + MONO + ";color:#8f8f8f") }, R.email) : null)
        : V.isDashboard ? null : h("button", { onClick: V.resetProduct, title: "Drop the simulated account's setup, reload the product at step one, and clear every tab", className: "hv-ink-line",
          style: css("padding:8px 14px;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#4d4d4d;background:transparent;border:1px solid #eaeaea;border-radius:999px;white-space:nowrap") }, "Reset test environment"));
  }
  // The environments dashboard, Simulated mode's landing screen. Every environment is a card: the whole card
  // opens it, its × deletes it, Configure edits it and Reset clears it, both without opening it. Hover changes
  // borders only (debugger.css).
  renderDashboard(V) {
    const PILL = "padding:8px 14px;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;border-radius:999px;white-space:nowrap";
    return h("div", { "data-screen-label": "Environments", style: css("flex:1;min-height:0;overflow:auto;padding:32px 32px 48px") },
      h("div", { style: css("max-width:920px;margin:0 auto") },
        h("div", { style: css("display:flex;align-items:flex-start;gap:16px 24px;flex-wrap:wrap") },
          h("div", { style: css("flex:1 1 320px;min-width:0") },
            h("div", { style: css("font:500 22px/1.2 " + SANS + ";letter-spacing:-0.3px;color:#171717") }, "Test environments"),
            h("div", { style: css("margin-top:8px;font:12.5px/1.7 " + SANS + ";color:#8f8f8f;text-wrap:pretty;max-width:560px") },
              "Each environment is isolated: its own simulated account, step tabs, notes and graph layout. Open one to pick up where you left off, or start a new one with its own participant and prompts.")),
          h("button", { onClick: V.newEnv, className: "hv-black", style: css("flex:none;padding:10px 16px;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#fff;background:#171717;border:1px solid #171717;border-radius:999px;white-space:nowrap") }, "New environment")),
        V.envsEmpty ? h("div", { style: css("margin-top:28px;padding:40px 24px;border:1px dashed #dedede;border-radius:12px;text-align:center;font:13px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") },
          "No environments yet. Create one to open the product against a fresh simulated account.") : null,
        h("div", { style: css("margin-top:28px;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px") },
          V.envCards.map(ec => h("div", { key: ec.id, onClick: ec.open, className: "hv-line-c9", style: css("display:flex;flex-direction:column;gap:14px;padding:18px 18px 16px;border:1px solid #eaeaea;border-radius:12px;background:#fff;cursor:pointer;min-width:0") },
            h("div", { style: css("display:flex;align-items:flex-start;gap:10px") },
              h("div", { style: css("flex:1;min-width:0") },
                h("div", { style: css("font:500 15px/1.3 " + SANS + ";color:#171717;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, ec.name),
                h("div", { style: css("margin-top:4px;font:11.5px/1.5 " + SANS + ";color:#8f8f8f") }, ec.meta)),
              h("button", { onClick: ec.remove, "aria-label": "delete environment", title: "Delete this environment", className: "hv-red", style: css("flex:none;padding:0 4px;border:none;background:none;font:18px/1 " + SANS + ";color:#c9c9c9") }, "×")),
            ec.hasDescription ? h("div", { style: css("font:12.5px/1.6 " + SANS + ";color:#4d4d4d;text-wrap:pretty") }, ec.description) : null,
            h("div", { style: css("font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, ec.participant),
            h("div", { style: css("display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:12px 10px;padding-top:14px;border-top:1px solid #f0f0f0") },
              ec.stats.map(st => h("div", { key: st.k, style: css("min-width:0") },
                h("div", { style: css("font:500 15px/1.2 " + MONO2 + ";color:#171717") }, st.v),
                h("div", { style: css("margin-top:4px;font:500 9px/1 " + SANS + ";letter-spacing:1.2px;text-transform:uppercase;color:#8f8f8f;white-space:nowrap") }, st.k)))),
            h("div", { style: css("display:flex;align-items:center;gap:8px;margin-top:2px") },
              h("span", { style: css(PILL + ";color:#fff;background:#171717") }, "Open ›"),
              h("button", { onClick: ec.configure, className: "hv-ink-line", style: css(PILL + ";color:#4d4d4d;background:transparent;border:1px solid #eaeaea") }, "Configure"),
              h("button", { onClick: ec.reset, title: "Drop the simulated account's setup and clear every step tab; the participant and prompts stay", className: "hv-ink-line", style: css(PILL + ";color:#4d4d4d;background:transparent;border:1px solid #eaeaea") }, "Reset")))))));
  }
  renderConfig(cfg) {
    if (!cfg.open) return null;
    const chips = (list) => list.map((x, i) => h("button", { key: i, onClick: x.select, style: css("padding:6px 11px;border:1px solid #eaeaea;border-radius:999px;font:500 11.5px/1 " + SANS + ";background:" + x.bg + ";color:" + x.color) }, x.label));
    const field = (label, input) => h("label", { style: css("display:block") }, h("span", { style: css(EYEBROW) }, label), input);
    const about = h("div", { style: css("display:flex;flex-direction:column;gap:22px;padding:4px 0 12px") },
      field("Name", h("input", { value: cfg.name, onChange: cfg.setName, placeholder: "e.g. Physics major, no paper links", spellCheck: false, className: "fc-blue",
        style: css("display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fafafa;outline:none;font:500 14px/1.5 " + SANS + ";color:#171717") })),
      field("Description", h("textarea", { value: cfg.description, onChange: cfg.setDescription, placeholder: "What this environment is for: the scenario, the hypothesis, what to watch.", rows: 3, spellCheck: false, className: "fc-blue",
        style: css("display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fafafa;outline:none;resize:vertical;font:13px/1.6 " + SANS + ";color:#171717") })),
      field("Notes", h("textarea", { value: cfg.notes, onChange: cfg.setNotes, placeholder: "Running notes for this environment.", rows: 5, spellCheck: false, className: "fc-blue",
        style: css("display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fafafa;outline:none;resize:vertical;font:13px/1.6 " + SANS + ";color:#171717") })));
    const participant = h("div", { style: css("display:flex;flex-direction:column;gap:22px;padding:4px 0 12px") },
      h("div", { style: css("display:flex;align-items:center;gap:12px;flex-wrap:wrap") },
        h("span", { style: css("font:500 12.5px/1.4 " + SANS + ";color:#171717") }, "The account starts"),
        h("span", { style: css("display:inline-flex;padding:2px;border:1px solid #eaeaea;border-radius:999px") },
          cfg.pToggle.map((pt, i) => h("button", { key: i, onClick: pt.select, style: css("padding:5px 11px;border:none;border-radius:999px;font:500 11px/1 " + SANS + ";background:" + pt.bg + ";color:" + pt.color) }, pt.label)))),
      h("div", { style: css("font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, cfg.participantNote),
      cfg.pEnabled ? [
        h("div", { key: "who", style: css("display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:22px") },
          field("What is your name?", h("input", { value: cfg.pName, onChange: cfg.setPName, placeholder: "type your name…", spellCheck: false, className: "fc-blue", style: css(FIELD) })),
          h("label", { style: css("display:block") }, h("span", { style: css(EYEBROW) }, "What is your major?"),
            h("input", { value: cfg.pMajor, onChange: cfg.setPMajor, placeholder: "start typing…", spellCheck: false, className: "fc-blue", style: css(FIELD) }),
            h("div", { style: css("display:flex;flex-wrap:wrap;gap:6px;margin-top:8px") }, cfg.majorSeeds.map((ms, i) => h("button", { key: i, onClick: ms.select, className: "hv-ink-line-fill",
              style: css("padding:6px 12px;border:1px solid #eaeaea;border-radius:999px;background:transparent;font:12px/1.4 " + SANS + ";color:#4d4d4d") }, ms.label))))),
        h("div", { key: "year" }, h("span", { style: css(EYEBROW) }, "What year are you?"),
          h("div", { style: css("display:flex;flex-wrap:wrap;gap:6px;margin-top:8px") }, chips(cfg.years)),
          cfg.yearOther ? h("input", { value: cfg.pYear, onChange: cfg.setPYear, placeholder: "transferring, fifth-year, grad…", spellCheck: false, className: "fc-blue", style: css(FIELD.replace("margin-top:6px", "margin-top:8px")) }) : null),
        h("div", { key: "depth" }, h("span", { style: css(EYEBROW) }, "How technical should explanations be?"),
          h("div", { style: css("display:flex;flex-wrap:wrap;gap:6px;margin-top:8px") }, chips(cfg.depths))),
        h("div", { key: "fam" }, h("span", { style: css(EYEBROW) }, "How familiar are you with the paper?"),
          h("div", { style: css("display:flex;flex-wrap:wrap;gap:6px;margin-top:8px") }, chips(cfg.fams))),
        h("div", { key: "paper" }, h("span", { style: css(EYEBROW) }, "Which paper are you building on?"),
          cfg.hasPaper ? h("div", { style: css("display:flex;align-items:center;gap:12px;margin-top:8px;padding:10px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fafafa") },
            h("span", { style: css("flex:1;min-width:0;font:13px/1.5 " + SANS + ";color:#171717;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, cfg.paperName),
            h("button", { onClick: cfg.clearPaper, className: "hv-ink", style: css("padding:0;border:none;background:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#8f8f8f") }, "Replace")) : null,
          h("label", { className: "hv-line-ink", style: css("display:flex;align-items:center;gap:12px;margin-top:8px;padding:12px 14px;border:1px dashed #c9c9c9;border-radius:8px;background:#fff;cursor:pointer") },
            h("span", { style: css("font:400 18px/1 system-ui,sans-serif;color:#8f8f8f") }, "+"),
            h("span", { style: css("font:12.5px/1.5 " + SANS + ";color:#4d4d4d") }, cfg.paperPrompt),
            h("input", { type: "file", accept: "application/pdf", onChange: cfg.setPaper, style: css("display:none") })),
          h("div", { style: css("margin-top:6px;font:11px/1.5 " + SANS + ";color:#8f8f8f") }, "Only the file's name and size are kept; the simulated reading uses the fixture paper regardless of the PDF's contents.")),
        h("div", { key: "links", style: css("display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px") },
          field("Project page · optional", h("input", { value: cfg.pProject, onChange: cfg.setPProject, placeholder: "https://", spellCheck: false, className: "fc-blue", style: css(FIELD.replace("font:13px/1.5 " + SANS, "font:13px/1.5 " + MONO)) })),
          field("GitHub · optional", h("input", { value: cfg.pRepo, onChange: cfg.setPRepo, placeholder: "https://", spellCheck: false, className: "fc-blue", style: css(FIELD.replace("font:13px/1.5 " + SANS, "font:13px/1.5 " + MONO)) })))
      ] : null);
    const prompts = [
      h("div", { key: "intro", style: css("font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty;margin-bottom:12px") }, "The eleven prompts the onboarding sends, verbatim from api/_lib/onboarding-prompts.js, in the order the reader meets them. Text in {{double braces}} is what the server fills in for each call: the reader block, the assessment, the transcript, the paper's title. Edit any prompt and this environment's calls carry your version, slots included."),
      h("div", { key: "tabs", "data-prompt-tabs": "1", style: css("display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px") },
        cfg.promptTabs.map(pt => h("button", { key: pt.key, onClick: pt.select, title: pt.key + (pt.changed ? " · edited" : ""), "aria-pressed": pt.on, style: css("display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border:1px solid " + pt.border + ";border-radius:999px;background:" + pt.bg + ";font:500 11px/1 " + SANS + ";color:" + pt.fg) },
          pt.label, pt.changed ? h("span", { title: "edited", style: css("width:7px;height:7px;border-radius:50%;background:" + (pt.on ? "#fff" : "#0070f3")) }) : null))),
      h("div", { key: "editor", style: css("border:1px solid #eaeaea;border-radius:8px;padding:10px 12px 12px;background:#fff;margin-bottom:12px") },
        h("div", { style: css("display:flex;align-items:baseline;gap:8px") },
          h("span", { style: css("font:500 12.5px/1.4 " + SANS + ";color:#171717") }, cfg.prompt.label),
          h("span", { style: css("font:11px/1.4 " + MONO + ";color:#8f8f8f") }, cfg.prompt.key),
          h("span", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#0070f3") }, cfg.prompt.badge),
          h("span", { style: css("flex:1") }),
          h("button", { onClick: cfg.prompt.reset, className: "hv-ink", style: css(LINK_BTN) }, cfg.prompt.resetLabel)),
        h("textarea", { key: cfg.prompt.key, value: cfg.prompt.value, onChange: cfg.prompt.set, rows: 18, spellCheck: false, className: "fc-blue",
          style: css("display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:9px 12px;border:1px solid #eaeaea;border-radius:6px;background:#fafafa;outline:none;resize:vertical;font:12.5px/1.6 " + SANS + ";color:#171717") }))
    ];
    return [
      h("div", { key: "veil", onClick: cfg.cancel, style: css("position:fixed;inset:0;z-index:80;background:rgba(23,23,23,0.32)") }),
      h("div", { key: "dialog", "data-screen-label": "Configure environment", style: css("position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(720px,92vw);max-height:88vh;z-index:81;display:flex;flex-direction:column;background:#fff;border:1px solid #eaeaea;border-radius:12px;overflow:hidden") },
        h("div", { style: css("flex:none;display:flex;align-items:center;gap:12px;padding:16px 20px 0") },
          h("span", { style: css("font:500 17px/1.3 " + SANS + ";letter-spacing:-0.2px;color:#171717") }, cfg.title),
          h("span", { style: css("flex:1") }),
          h("button", { onClick: cfg.cancel, "aria-label": "close", className: "hv-ink", style: css("padding:0 2px;border:none;background:none;font:18px/1 " + SANS + ";color:#8f8f8f") }, "×")),
        h("div", { style: css("flex:none;display:flex;align-items:flex-end;gap:2px;padding:10px 20px 0;border-bottom:1px solid #eaeaea") },
          cfg.sections.map((cs, i) => h("button", { key: i, onClick: cs.select, style: css("padding:8px 10px 9px;border:none;background:transparent;font:500 12.5px/1 " + SANS + ";color:" + cs.color + ";border-bottom:2px solid " + cs.line + ";margin-bottom:-1px;white-space:nowrap") }, cs.label))),
        h("div", { style: css("flex:1 1 auto;min-height:0;overflow:auto;padding:22px 24px 10px") },
          cfg.isAbout ? about : null, cfg.isParticipant ? participant : null, cfg.isPrompts ? prompts : null),
        h("div", { style: css("flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px 16px;border-top:1px solid #eaeaea") },
          h("button", { onClick: cfg.cancel, className: "hv-ink-line", style: css("padding:9px 16px;border:1px solid #eaeaea;border-radius:999px;background:transparent;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#4d4d4d") }, "Cancel"),
          h("button", { onClick: cfg.save, className: "hv-dim", style: css("display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border:1px solid #171717;border-radius:999px;background:#171717;color:#fff;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase") }, h("span", null, cfg.saveLabel), h("span", null, "›"))))
    ];
  }
  renderStepTabs(V) {
    return h("div", { style: css("display:flex;align-items:flex-end;gap:2px;flex-wrap:wrap;border-bottom:1px solid #eaeaea;margin:-4px 0 12px") },
      V.recordings.map(rc => h("span", { key: rc.id, onClick: rc.select, title: rc.title, className: "hv-fafafa", style: css("display:inline-flex;align-items:center;gap:7px;padding:8px 10px 9px;border-bottom:2px solid " + rc.line + ";margin-bottom:-1px;cursor:pointer;white-space:nowrap") },
        h("span", { style: css("width:7px;height:7px;border-radius:50%;background:" + rc.dot) }),
        rc.on ? h("span", { style: css("position:relative;display:inline-block") },
          h("span", { "aria-hidden": "true", style: css("visibility:hidden;display:inline-block;padding:0 2px;font:500 12.5px/1 " + SANS + ";white-space:pre;min-width:18px;max-width:240px") }, rc.label),
          h("input", { value: rc.label, onChange: rc.rename, spellCheck: false, title: "rename this step", className: "fc-bottom-blue",
            style: css("position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:0 2px;margin:0;border:none;border-bottom:1px dashed #c9c9c9;background:transparent;outline:none;font:500 12.5px/1 " + SANS + ";color:#171717") })) : null,
        rc.off ? h("span", { style: css("font:500 12.5px/1 " + SANS + ";color:" + rc.color) }, rc.label) : null,
        rc.closable ? h("span", { onClick: rc.close, title: "close this step", className: "hv-red", style: css("font:13px/1 " + SANS + ";color:" + rc.subColor) }, "×") : null)));
  }
  renderFlow(V) {
    const fc = V.fc, dm = V.dm, fd = V.flowDetail;
    return [
      V.anyModal ? h("div", { key: "veil", onClick: V.closeModals, style: css("position:fixed;inset:0;z-index:50;background:rgba(23,23,23,0.32)") }) : null,
      h("div", { key: "flow", "data-screen-label": "Data flow", style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:14px;background:#fff;overflow:hidden;display:flex;flex-direction:column;position:" + fc.pos + ";left:" + fc.left + ";top:" + fc.top + ";width:" + fc.w + ";height:" + fc.h + ";z-index:" + fc.z) },
        h("div", { style: css("flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px") },
          h("span", { style: css("flex:1;min-width:0;font:11px/1.4 " + SANS + ";color:#8f8f8f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, "boxes are stored values · arrows are the operations between them · violet arrows are model calls · drag a box to move it"),
          h("span", { style: css("display:inline-flex;align-items:center;border:1px solid #eaeaea;border-radius:999px;overflow:hidden") },
            h("button", { onClick: V.zoomOut, title: "zoom out", className: "hv-f5", style: css("padding:4px 9px;border:none;background:transparent;font:500 13px/1 " + SANS + ";color:#4d4d4d") }, "−"),
            h("span", { style: css("min-width:40px;text-align:center;font:11px/1 " + MONO + ";color:#4d4d4d") }, V.flowZoomLabel),
            h("button", { onClick: V.zoomIn, title: "zoom in", className: "hv-f5", style: css("padding:4px 9px;border:none;background:transparent;font:500 13px/1 " + SANS + ";color:#4d4d4d") }, "+")),
          V.hasLayoutChanges ? h("button", { onClick: V.zoomReset, title: "undo moves and zoom", className: "hv-ink", style: css(LINK_BTN) }, "reset layout") : null,
          h("button", { onClick: V.toggleFlowModal, className: "hv-ink", style: css(LINK_BTN) }, V.flowModalLabel)),
        h("div", { ref: this.flowScrollRef, onPointerDown: V.panDown, style: css("border-top:1px solid #f2f2f2;background:#fafafa;overflow:hidden;position:relative;min-height:0;cursor:grab;flex:" + fc.scrollFlex + ";max-height:" + fc.scrollMax + ";height:" + fc.scrollH) },
          V.flowEmpty ? h("div", { style: css("padding:18px 14px;font:12px/1.5 " + SANS + ";color:#8f8f8f") }, "Nothing exists yet. Values appear here as the product produces them.") : null,
          V.flowHasNodes ? h("div", { style: css("position:relative;width:" + V.flowW + "px;height:" + V.flowH + "px;transform:translate(" + V.flowPanX + "px, " + V.flowPanY + "px)") },
            h("svg", { width: V.flowW, height: V.flowH, style: css("display:block;position:absolute;left:0;top:0;pointer-events:none") },
              V.flowEdges.map((fe, i) => h("path", { key: "e" + i, d: fe.d, style: css(fe.style) })),
              V.flowJunctions.map((fj, i) => h("circle", { key: "j" + i, cx: fj.cx, cy: fj.cy, r: fj.r, style: css(fj.style) }))),
            V.flowNodes.map(fn => h("div", { key: fn.id, "data-node": "1", onClick: fn.select, onPointerDown: fn.down, title: fn.title,
              style: css("position:absolute;left:" + fn.x + "px;top:" + fn.y + "px;width:" + fn.w + "px;height:" + fn.h + "px;box-sizing:border-box;padding:" + fn.pad + ";border-radius:" + fn.radius + "px;cursor:grab;user-select:none;background:" + fn.bg + ";border:" + fn.border + ";box-shadow:" + fn.stack) },
              h("span", { style: css("display:block;font:500 " + fn.fs + "px/1.2 " + SANS + ";color:" + fn.color + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis") }, fn.label),
              h("span", { style: css("display:block;margin-top:2px;font:" + fn.fs2 + "px/1.2 " + SANS + ";color:#8f8f8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis") }, fn.sub),
              h("span", { style: css("position:absolute;right:" + fn.dotOff + "px;top:" + fn.dotOff + "px;width:" + fn.dotSize + "px;height:" + fn.dotSize + "px;border-radius:50%;background:" + fn.dot) }),
              fn.hasNote ? h("span", { title: "has a note", style: css("position:absolute;left:-1px;top:-1px;width:0;height:0;border-style:solid;border-width:9px 9px 0 0;border-color:#0070f3 transparent transparent transparent;border-top-left-radius:6px") }) : null,
              fn.hasCount ? h("span", { style: css("position:absolute;right:-7px;bottom:-7px;padding:2px 5px;border-radius:999px;background:#171717;color:#fff;font:500 9px/1 " + MONO) }, fn.count) : null))) : null),
        h("div", { onPointerDown: V.resizeDown, title: "drag to resize the graph", style: css("flex:none;height:10px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;border-top:1px solid #f2f2f2;background:#fff") },
          h("span", { style: css("width:36px;height:3px;border-radius:2px;background:#e2e2e2") })),
        V.flowHasDetail ? h("div", { style: css("display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;background:#fff;border-top:1px solid #eaeaea;position:" + dm.pos + ";left:" + dm.left + ";top:" + dm.top + ";width:" + dm.w + ";height:" + dm.h + ";z-index:" + dm.z + ";border:" + dm.border + ";border-radius:" + dm.radius + ";padding:" + dm.pad) },
          h("div", { style: css("flex:none;display:flex;align-items:baseline;gap:10px") },
            h("span", { style: css("font:500 13px/1.3 " + SANS + ";color:#171717") }, fd.label),
            h("span", { style: css("font:11px/1.3 " + SANS + ";color:#8f8f8f") }, fd.sub),
            h("span", { style: css("flex:1") }),
            h("button", { onClick: V.toggleDetailModal, className: "hv-ink", style: css(LINK_BTN) }, V.detailModalLabel),
            h("button", { onClick: fd.close, "aria-label": "close", className: "hv-ink", style: css("padding:0 2px;border:none;background:none;font:15px/1 " + SANS + ";color:#8f8f8f") }, "×")),
          h("div", { style: css("margin-top:6px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap") },
            h("span", { style: css("font:11.5px/1.5 " + SANS + ";color:#4d4d4d") }, fd.status),
            h("button", { onClick: fd.open, className: "hv-ink", style: css("padding:0;border:none;background:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#0070f3;white-space:nowrap") }, fd.openLabel)),
          fd.hasWhy ? h("div", { style: css("margin-top:8px;padding:8px 10px;border-radius:6px;background:#e6f0fd;font:11.5px/1.5 " + SANS + ";color:#0761d1;text-wrap:pretty") }, fd.why) : null,
          h("div", { style: css("margin-top:10px;display:flex;align-items:center;gap:4px;flex-wrap:wrap") },
            fd.tabs.map((ft, i) => h("button", { key: i, onClick: ft.select, style: css("padding:5px 10px;border:1px solid " + ft.border + ";border-radius:999px;background:" + ft.bg + ";font:500 9.5px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:" + ft.color + ";white-space:nowrap") }, ft.label)),
            fd.tabNote ? h("span", { "data-tab-note": "1", style: css("font:11px/1.4 " + SANS + ";color:#8f8f8f") }, fd.tabNote) : null),
          fd.hasRendered ? h("div", { style: css("margin-top:10px;max-height:420px;overflow:auto;padding:12px 14px;background:#fafafa;border:1px solid #eaeaea;border-radius:6px") }, fd.rendered) : null,
          fd.showRaw ? h("pre", { style: css("margin:8px 0 0;overflow:auto;padding:10px 12px;background:#fafafa;border:1px solid #eaeaea;border-radius:6px;font:11.5px/1.55 " + MONO2 + ";color:#171717;white-space:pre-wrap;word-break:break-word;min-height:0;flex:" + dm.preFlex + ";max-height:" + dm.preMax) }, fd.json) : null,
          h("div", { style: css("flex:none;margin-top:10px") },
            h("div", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f") }, "Notes"),
            h("textarea", { value: fd.note, onChange: fd.setNote, placeholder: "What you make of this value — saved in this browser, kept when you come back…", rows: 2, spellCheck: false, className: "fc-blue-line",
              style: css("display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 12px;border:1px solid #eaeaea;border-radius:6px;background:#fff;resize:vertical;font:12.5px/1.6 " + SANS + ";color:#171717;outline:none") }))) : null)
    ];
  }
  renderRequests(V) {
    const K = this.KINDS;
    return [
      h("div", { key: "chips", style: css("display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px") },
        V.kindChips.map(k => h("button", { key: k.key, onClick: k.toggle, title: k.title, style: css("display:inline-flex;align-items:center;gap:7px;padding:5px 10px 5px 8px;border:1px solid " + k.border + ";border-radius:999px;background:" + k.bg + ";opacity:" + k.opacity) },
          h("span", { style: css("width:9px;height:9px;border-radius:3px;background:" + k.color) }),
          h("span", { style: css("font:500 11px/1 " + SANS + ";color:#171717") }, k.label),
          h("span", { style: css("font:11px/1 " + MONO + ";color:#8f8f8f") }, k.count)))),
      V.liveEmpty ? h("div", { key: "empty", style: css("padding:28px 18px;border:1px dashed #e2e2e2;border-radius:10px;text-align:center") },
        h("div", { style: css("font:500 13px/1.5 " + SANS + ";color:#171717") }, V.isReal ? (V.real.viewingPicked ? "No actions were recorded for this run" : "No requests yet") : "No requests on this step yet"),
        h("div", { style: css("margin-top:4px;font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, V.isReal ? (V.real.viewingPicked ? "The run has no workflow operation on record." : "Use the product on the left. Every request it makes lands here as it happens, and the operations the server recorded to answer it follow as soon as the reply names its trace.") : "Use the product on the left. Every request it makes while on this step, and every operation the server runs to answer it, lands here as it happens.")) : null,
      V.stages.map(s => h("div", { key: s.id, id: s.anchor, style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:8px;background:#fff;overflow:hidden") },
        h("div", { onClick: s.toggle, className: "hv-fafafa", style: css("display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer") },
          h("span", { style: css("font:500 10px/1 " + MONO + ";color:#8f8f8f;width:22px") }, s.seqLabel),
          h("span", { style: css("width:8px;height:8px;border-radius:50%;flex:none;background:" + s.dot) }),
          h("span", { style: css("flex:0 1 auto;min-width:0;font:500 13px/1.3 " + SANS + ";color:#171717;white-space:nowrap;overflow:hidden;text-overflow:ellipsis") }, s.label),
          s.modelPill ? h("span", { title: "this request called a model", style: css("flex:none;padding:3px 6px;border-radius:4px;background:" + K.model.bg + ";color:" + K.model.color + ";font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;white-space:nowrap") }, s.modelPill) : null,
          h("span", { style: css("flex:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#8f8f8f;white-space:nowrap") }, s.tag),
          h("span", { style: css("flex:1 1 30px;min-width:0;font:11px/1.4 " + MONO + ";color:#8f8f8f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, s.path),
          h("span", { style: css("flex:none;font:11px/1 " + SANS + ";color:#4d4d4d;white-space:nowrap") }, s.opsLabel),
          h("span", { style: css("flex:none;font:11px/1 " + MONO + ";color:#4d4d4d;text-align:right;white-space:nowrap") }, s.msLabel),
          h("span", { style: css("flex:none;font:11px/1 " + MONO + ";color:#8f8f8f;text-align:right;white-space:nowrap") }, s.costLabel),
          h("span", { style: css("flex:none;font:12px/1 " + SANS + ";color:#8f8f8f;width:10px;text-align:center") }, s.chevron)),
        h("div", { style: css("display:flex;align-items:center;flex-wrap:wrap;row-gap:6px;padding:0 12px 10px 44px") },
          s.dots.map((d, i) => h("span", { key: i, onClick: d.select, title: d.title, style: css("display:inline-flex;align-items:center;cursor:pointer") },
            h("span", { style: css("width:10px;height:10px;border-radius:3px;background:" + d.color + ";box-shadow:" + d.ring) }),
            h("span", { style: css("width:9px;height:1px;background:" + d.line) }))),
          h("button", { onClick: s.inspectStage, className: "hv-ink", style: css("margin-left:8px;padding:0;border:none;background:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:" + s.reqColor) }, "request · response")),
        s.open ? h("div", { style: css("border-top:1px solid #f2f2f2;padding:5px 0") },
          s.ops.map(o => h("div", { key: o.id, onClick: o.select, className: "hv-fafafa", style: css("display:grid;grid-template-columns:34px 64px minmax(0,1fr) 58px;align-items:baseline;gap:10px;padding:5px 12px;cursor:pointer;background:" + o.rowBg) },
            h("span", { style: css("font:11px/1.5 " + MONO + ";color:#c9c9c9;text-align:right") }, o.seq),
            h("span", { style: css("display:inline-block;padding:4px 0;border-radius:4px;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;text-align:center;background:" + o.bg + ";color:" + o.color) }, o.kindLabel),
            h("span", { style: css("min-width:0;padding-left:" + (o.indent || 0) + "px") },
              h("span", { style: css("font:13px/1.45 " + SANS + ";color:" + o.nameColor) }, o.name),
              h("span", { style: css("display:block;font:11px/1.5 " + MONO + ";color:#8f8f8f;word-break:break-all") }, o.target)),
            h("span", { style: css("font:11px/1.5 " + MONO + ";color:#4d4d4d;text-align:right") }, o.msLabel)))) : null))
    ];
  }
  renderLive(V) {
    return h("div", { ref: this.listRef, onScroll: V.onListScroll, style: css("flex:1;min-height:0;overflow:auto;padding:12px 14px 20px") },
      V.isReal ? null : this.renderStepTabs(V),
      h("div", { style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:14px;background:#fff;overflow:hidden") },
        h("div", { style: css("padding:16px 14px 18px;background:#fafafa") },
          h("div", { style: css("display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap") },
            h("span", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f") }, V.isReal ? (V.real.viewingPicked ? "Earlier run · " + V.real.pickedTitle : "This session") : "This step"),
            h("span", { style: css("font:11.5px/1.4 " + MONO + ";color:#4d4d4d") }, V.lastRan)),
          h("div", { style: css("margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:12px 8px") },
            V.statTiles.map(stt => h("span", { key: stt.k, title: stt.help, style: css("min-width:0") },
              h("span", { style: css("display:block;font:500 19px/1.2 " + SANS + ";letter-spacing:-0.3px;color:#171717;font-variant-numeric:tabular-nums") }, stt.v),
              h("span", { style: css("display:block;margin-top:5px;font:11px/1.3 " + SANS + ";color:#8f8f8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis") }, stt.k)))))),
      h("div", { style: css("display:flex;align-items:center;gap:2px;margin-bottom:12px;border-bottom:1px solid #eaeaea") },
        V.views.map(vw => h("button", { key: vw.key, onClick: vw.select, style: css("padding:8px 10px 9px;border:none;background:transparent;font:500 12.5px/1 " + SANS + ";color:" + vw.color + ";border-bottom:2px solid " + vw.line + ";margin-bottom:-1px;white-space:nowrap") }, vw.label))),
      V.isFlowView && V.lineageUnavailable ? this.renderLineageUnavailable() : null,
      V.isFlowView && !V.lineageUnavailable ? this.renderFlow(V) : null,
      V.isRequestsView ? this.renderRequests(V) : null,
      V.isPromptsView ? this.renderPrompts(V) : null);
  }
  // The Prompts view: a tab per prompt the run sent, and under it every call of that prompt, the message as
  // the model received it and the reply as parsed. The rest of the call is one click away in the inspector.
  renderPrompts(V) {
    const K = this.KINDS;
    const block = (label, text) => [h("div", { key: label, style: css("margin-top:10px;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f") }, label),
      h("pre", { key: label + "-pre", style: css("margin:6px 0 0;max-height:320px;overflow:auto;padding:10px 12px;background:#fafafa;border:1px solid #eaeaea;border-radius:6px;font:11.5px/1.55 " + MONO2 + ";color:#171717;white-space:pre-wrap;word-break:break-word") }, text)];
    return h("div", { "data-screen-label": "Prompts" },
      V.promptsEmpty ? h("div", { style: css("padding:28px 18px;border:1px dashed #e2e2e2;border-radius:10px;text-align:center") },
        h("div", { style: css("font:500 13px/1.5 " + SANS + ";color:#171717") }, "No model calls yet"),
        h("div", { style: css("margin-top:4px;font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, V.promptsEmptyText)) : null,
      V.promptsEmpty ? null : h("div", { style: css("display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px") },
        V.promptTabs.map(pt => h("button", { key: pt.key, onClick: pt.select, "data-prompt-tab": pt.key, title: pt.key, style: css("display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border:1px solid " + pt.border + ";border-radius:999px;background:" + pt.bg) },
          h("span", { style: css("font:500 11px/1 " + SANS + ";color:" + pt.color) }, pt.label),
          h("span", { style: css("font:11px/1 " + MONO + ";color:" + (pt.on ? "#c9c9c9" : "#8f8f8f")) }, pt.count),
          pt.edited ? h("span", { title: "an edited prompt was sent", style: css("width:7px;height:7px;border-radius:50%;background:#0070f3") }) : null))),
      V.promptCalls.map(pc => h("div", { key: pc.id, "data-prompt-call": "1", style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:10px;padding:10px 12px 12px;background:#fff") },
        h("div", { style: css("display:flex;align-items:baseline;gap:10px;flex-wrap:wrap") },
          h("span", { style: css("font:500 10px/1 " + MONO + ";color:#8f8f8f") }, pc.when),
          h("span", { style: css("font:500 12.5px/1.3 " + SANS + ";color:#171717") }, pc.where),
          pc.badge ? h("span", { style: css("padding:3px 6px;border-radius:4px;background:#e6f0fd;color:#0761d1;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;white-space:nowrap") }, pc.badge) : null,
          h("span", { style: css("flex:1") }),
          h("span", { style: css("font:11px/1.4 " + MONO + ";color:" + (pc.status === "error" ? "#e70022" : "#4d4d4d")) }, pc.status === "error" ? "failed" : pc.meta),
          h("button", { onClick: pc.open, className: "hv-ink", style: css("padding:0;border:none;background:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#0070f3;white-space:nowrap") }, "open in session ›")),
        pc.error ? h("div", { style: css("margin-top:8px;font:12px/1.5 " + SANS + ";color:#e70022;text-wrap:pretty") }, pc.error) : null,
        block("Input · as the model received it", pc.input),
        pc.hasOutput ? block("Response · as parsed", pc.output) : null,
        pc.note ? h("div", { style: css("margin-top:6px;font:11px/1.4 " + SANS + ";color:#8f8f8f") }, pc.note) : null)));
  }
  renderLineageUnavailable() {
    return h("div", { "data-screen-label": "Lineage unavailable", style: css("border:1px dashed #e2e2e2;border-radius:10px;padding:28px 18px;text-align:center;margin-bottom:14px") },
      h("div", { style: css("font:500 13px/1.5 " + SANS + ";color:#171717") }, "Lineage was not recorded for this run"),
      h("div", { style: css("margin:4px auto 0;max-width:460px;font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") },
        "The graph draws which stored values each operation read and wrote. This run was recorded before the server kept that, so its operations, timing, payloads and errors are on record but no edge is guessed from them. Use Requests to inspect every operation; runs recorded since carry their reads and writes and draw here."));
  }
  renderCases(V) {
    return h("div", { style: css("flex:1;min-height:0;overflow:auto;padding:12px 14px 20px") },
      V.casesEmpty ? h("div", { style: css("padding:28px 18px;border:1px dashed #e2e2e2;border-radius:10px;text-align:center") },
        h("div", { style: css("font:500 13px/1.5 " + SANS) }, "No test cases saved"),
        h("div", { style: css("margin-top:4px;font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, "Walk the product as far as you like, then press Save as test case. The recorded requests can be replayed against a changed backend and compared.")) : null,
      V.cases.map(c => h("div", { key: c.id, style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:10px;background:#fff") },
        h("div", { style: css("display:flex;align-items:center;gap:10px;padding:10px 12px") },
          h("input", { value: c.name, onChange: c.rename, spellCheck: false, className: "fc-bottom-grey", style: css("flex:1;min-width:0;border:none;border-bottom:1px solid transparent;background:transparent;padding:2px 0;font:500 13px/1.4 " + SANS + ";color:#171717;outline:none") }),
          h("button", { onClick: c.toggleKnobs, className: "hv-dim", style: css("padding:7px 12px;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#fff;background:#171717;border:1px solid #171717;border-radius:999px") }, c.knobsLabel),
          h("button", { onClick: c.remove, className: "hv-red-line", style: css("padding:7px 10px;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f;background:transparent;border:1px solid #eaeaea;border-radius:999px") }, "Delete")),
        h("div", { style: css("padding:0 12px 10px;font:11.5px/1.5 " + MONO + ";color:#8f8f8f") }, c.meta),
        c.knobsOpen ? h("div", { style: css("border-top:1px solid #f2f2f2;padding:12px 12px 14px;background:#fafafa") },
          h("div", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f") }, "Try a change · replay these " + c.requestCount + " requests against a backend with"),
          V.knobRows.map((kn, i) => h("div", { key: i, style: css("display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid #f2f2f2") },
            h("span", { style: css("min-width:0") },
              h("span", { style: css("display:block;font:500 12.5px/1.4 " + SANS + ";color:#171717") }, kn.label),
              h("span", { style: css("display:block;font:11.5px/1.5 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, kn.desc)),
            h("span", { style: css("display:inline-flex;padding:2px;border:1px solid #eaeaea;border-radius:999px;background:#fff") },
              kn.options.map((op, j) => h("button", { key: j, onClick: op.select, style: css("padding:5px 10px;border:none;border-radius:999px;font:500 11px/1 " + MONO + ";background:" + op.bg + ";color:" + op.color) }, op.label))))),
          h("div", { style: css("display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px") },
            h("span", { style: css("font:11px/1.5 " + SANS + ";color:#8f8f8f") }, V.knobSummary),
            h("button", { onClick: c.runIsolated, disabled: V.running, className: "hv-dim", style: css("display:inline-flex;align-items:center;gap:7px;padding:8px 16px;font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#fff;background:#171717;border:1px solid #171717;border-radius:999px") }, h("span", null, V.runLabel), h("span", null, "›")))) : null,
        c.runs.map(r => h("div", { key: r.id, style: css("display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid #f2f2f2") },
          h("span", { style: css("width:8px;height:8px;border-radius:50%;background:#0070f3;flex:none") }),
          h("span", { style: css("flex:1;min-width:0") },
            h("span", { style: css("display:block;font:500 12.5px/1.4 " + SANS + ";color:#171717;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, r.name),
            h("span", { style: css("display:block;font:11px/1.5 " + MONO + ";color:#8f8f8f") }, r.meta)),
          h("button", { onClick: r.compare, className: "hv-ink-line", style: css("padding:7px 12px;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#4d4d4d;background:transparent;border:1px solid #eaeaea;border-radius:999px") }, "Compare ›"))))));
  }
  renderCompare(V) {
    const cell = (extra) => css("font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f" + (extra || ""));
    const legend = (bg, border, text) => h("span", { style: css("display:inline-flex;align-items:center;gap:6px") }, h("span", { style: css("width:9px;height:9px;border-radius:2px;background:" + bg + ";border:1px solid " + border) }), text);
    return h("div", { style: css("flex:1;min-height:0;overflow:auto;padding:12px 14px 20px") },
      V.compareEmpty ? h("div", { style: css("padding:28px 18px;border:1px dashed #e2e2e2;border-radius:10px;text-align:center") },
        h("div", { style: css("font:500 13px/1.5 " + SANS) }, "Nothing to compare"),
        h("div", { style: css("margin-top:4px;font:12px/1.6 " + SANS + ";color:#8f8f8f;text-wrap:pretty") }, "Run a saved test case with a change. The baseline and the isolated run line up here, request by request.")) : null,
      V.compareReady ? [
        h("div", { key: "heads", style: css("display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px") },
          h("div", { style: css("padding:10px 12px;border:1px solid #eaeaea;border-radius:8px") },
            h("div", { style: cell() }, "A · baseline"),
            h("div", { style: css("margin-top:6px;font:500 13px/1.4 " + SANS) }, V.cmpAName),
            h("div", { style: css("margin-top:2px;font:11px/1.5 " + MONO + ";color:#8f8f8f") }, V.cmpAKnobs)),
          h("div", { style: css("padding:10px 12px;border:1px solid #0070f3;border-radius:8px") },
            h("div", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#0070f3") }, "B · isolated run"),
            h("div", { style: css("margin-top:6px;font:500 13px/1.4 " + SANS) }, V.cmpBName),
            h("div", { style: css("margin-top:2px;font:11px/1.5 " + MONO + ";color:#0761d1") }, V.cmpBKnobs))),
        h("div", { key: "metrics", style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:14px;overflow:hidden") },
          h("div", { style: css("display:grid;grid-template-columns:minmax(0,1fr) 84px 84px 84px;gap:8px;padding:8px 12px;background:#fafafa;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f") },
            h("span", null, "Across the run"), h("span", { style: css("text-align:right") }, "A"), h("span", { style: css("text-align:right") }, "B"), h("span", { style: css("text-align:right") }, "Δ")),
          V.cmpMetrics.map((m, i) => h("div", { key: i, style: css("display:grid;grid-template-columns:minmax(0,1fr) 84px 84px 84px;gap:8px;padding:7px 12px;border-top:1px solid #f2f2f2;align-items:baseline") },
            h("span", { style: css("font:12.5px/1.4 " + SANS) }, m.label),
            h("span", { style: css("font:12px/1.4 " + MONO + ";text-align:right;color:#4d4d4d") }, m.a),
            h("span", { style: css("font:12px/1.4 " + MONO + ";text-align:right;color:#171717") }, m.b),
            h("span", { style: css("font:500 12px/1.4 " + MONO + ";text-align:right;color:" + m.deltaColor) }, m.delta)))),
        h("div", { key: "legend", style: css("display:flex;gap:14px;align-items:center;margin-bottom:8px;font:11px/1 " + SANS + ";color:#8f8f8f") },
          legend("#e6f0fd", "#3291ff", "changed output"), legend("oklch(0.95 0.04 150)", "oklch(0.6 0.12 150)", "only in B"), legend("oklch(0.95 0.04 25)", "oklch(0.6 0.14 25)", "only in A"),
          h("span", { style: css("flex:1") }), h("span", null, V.cmpStageSummary)),
        V.cmpRows.map((cr, i) => h("div", { key: i, style: css("border:1px solid #eaeaea;border-radius:8px;margin-bottom:8px;overflow:hidden") },
          h("div", { onClick: cr.toggle, className: "hv-fafafa", style: css("display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer") },
            h("span", { style: css("font:500 10px/1 " + MONO + ";color:#8f8f8f;width:22px") }, cr.seqLabel),
            h("span", { style: css("flex:0 1 auto;min-width:0;font:500 13px/1.3 " + SANS + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis") }, cr.label),
            h("span", { style: css("flex:none;padding:3px 7px;border-radius:4px;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;background:" + cr.badgeBg + ";color:" + cr.badgeColor + ";white-space:nowrap") }, cr.badge),
            h("span", { style: css("flex:1 1 0") }),
            h("span", { style: css("font:11px/1 " + MONO + ";color:#8f8f8f;white-space:nowrap") }, cr.aStats),
            h("span", { style: css("font:11px/1 " + SANS + ";color:#c9c9c9") }, "→"),
            h("span", { style: css("font:11px/1 " + MONO + ";color:#171717;white-space:nowrap") }, cr.bStats),
            h("span", { style: css("font:12px/1 " + SANS + ";color:#8f8f8f;width:10px;text-align:center") }, cr.chevron)),
          cr.open ? h("div", { style: css("border-top:1px solid #f2f2f2") },
            h("div", { style: css("display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#f2f2f2") },
              h("div", { style: css("padding:6px 12px;background:#fafafa;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#8f8f8f") }, "A"),
              h("div", { style: css("padding:6px 12px;background:#fafafa;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#0070f3") }, "B")),
            cr.pairs.map((p, j) => h("div", { key: j, style: css("display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#f2f2f2;border-top:1px solid #f2f2f2") },
              h("div", { onClick: p.selectA, style: css("display:flex;align-items:baseline;gap:8px;padding:6px 12px;background:" + p.aBg + ";cursor:" + p.aCursor + ";min-width:0") },
                h("span", { style: css("flex:none;width:8px;height:8px;border-radius:2px;background:" + p.aKindColor + ";position:relative;top:1px") }),
                h("span", { style: css("min-width:0;font:12px/1.4 " + SANS + ";color:#171717;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, p.aName),
                h("span", { style: css("flex:none;font:11px/1.4 " + MONO + ";color:#8f8f8f") }, p.aMs)),
              h("div", { onClick: p.selectB, style: css("display:flex;align-items:baseline;gap:8px;padding:6px 12px;background:" + p.bBg + ";cursor:" + p.bCursor + ";min-width:0") },
                h("span", { style: css("flex:none;width:8px;height:8px;border-radius:2px;background:" + p.bKindColor + ";position:relative;top:1px") }),
                h("span", { style: css("min-width:0;font:12px/1.4 " + SANS + ";color:#171717;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, p.bName),
                h("span", { style: css("flex:none;font:11px/1.4 " + MONO + ";color:#8f8f8f") }, p.bMs))))) : null))
      ] : null);
  }
  renderInspector(V) {
    const insp = V.insp;
    return h("div", { "data-screen-label": "Inspector", style: css("flex:none;height:42%;min-height:220px;display:flex;flex-direction:column;border-top:1px solid #eaeaea;background:#fafafa") },
      h("div", { style: css("flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px 0") },
        h("span", { style: css("display:inline-block;padding:4px 7px;border-radius:4px;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;background:" + insp.bg + ";color:" + insp.color) }, insp.kindLabel),
        h("span", { style: css("font:500 13px/1.3 " + SANS + ";color:#171717;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap") }, insp.name),
        h("span", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:" + insp.sideColor) }, insp.side),
        h("span", { style: css("flex:1") }),
        h("button", { onClick: insp.counterpart, className: "hv-ink", style: css("padding:0;border:none;background:none;font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:" + insp.counterpartColor) }, insp.counterpartLabel),
        h("button", { onClick: V.closeInspector, "aria-label": "close", className: "hv-ink", style: css("padding:0 2px;border:none;background:none;font:16px/1 " + SANS + ";color:#8f8f8f") }, "×")),
      h("div", { style: css("flex:none;padding:6px 14px 0;font:11px/1.5 " + MONO + ";color:#4d4d4d;word-break:break-all") }, insp.target),
      h("div", { style: css("flex:none;display:flex;gap:14px;flex-wrap:wrap;padding:6px 14px 0") },
        insp.meta.map((mr, i) => h("span", { key: i, style: css("display:inline-flex;align-items:baseline;gap:5px") },
          h("span", { style: css("font:500 9px/1 " + SANS + ";letter-spacing:1.3px;text-transform:uppercase;color:#8f8f8f") }, mr.k),
          h("span", { style: css("font:11.5px/1.4 " + MONO + ";color:#171717") }, mr.v)))),
      h("div", { style: css("flex:none;display:flex;align-items:center;gap:2px;padding:8px 14px 0") },
        insp.tabs.map((it, i) => h("button", { key: i, onClick: it.select, style: css("padding:6px 10px;border:1px solid " + it.border + ";border-radius:999px;background:" + it.bg + ";font:500 10px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:" + it.color) }, it.label)),
        h("span", { style: css("flex:1") }),
        h("span", { style: css("font:11px/1 " + SANS + ";color:#8f8f8f") }, insp.redacted),
        h("button", { onClick: V.copyJson, className: "hv-ink-line", style: css("margin-left:10px;padding:5px 10px;border:1px solid #eaeaea;border-radius:999px;background:#fff;font:500 9px/1 " + SANS + ";letter-spacing:1.4px;text-transform:uppercase;color:#4d4d4d") }, V.copyLabel)),
      h("pre", { style: css("flex:1;min-height:0;overflow:auto;margin:8px 14px 12px;padding:10px 12px;background:#fff;border:1px solid #eaeaea;border-radius:8px;font:11.5px/1.55 " + MONO2 + ";color:#171717;white-space:pre-wrap;word-break:break-word") }, insp.json));
  }
  render() {
    const V = this.renderVals(), R = V.real;
    return h("div", { style: css("height:100vh;display:flex;flex-direction:column;background:#fff;color:#171717;font-family:" + SANSF + ";overflow:hidden") },
      this.renderTopBar(V),
      this.renderConfig(V.cfg),
      V.isDashboard ? this.renderDashboard(V) : h("div", { ref: this.bodyRef, style: css("flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,56fr) 1px minmax(0,44fr)") },
        h("div", { "data-screen-label": "Product", style: css("min-width:0;min-height:0;position:relative;background:#fafafa") },
          h("iframe", { key: "frame-" + this.state.frameKey, ref: this.frameRef, title: V.isReal ? "Engelbart setup, running against the real backend" : "Engelbart setup, running against the simulated backend", src: V.frameSrc, style: css("display:block;width:100%;height:100%;border:0;background:#fff") }),
          V.isReal && R.signedOut ? this.renderSignedOut(R) : null),
        h("div", { onPointerDown: (e) => this.splitDown(e), title: "drag to resize", style: css("position:relative;background:#eaeaea;cursor:col-resize;width:1px") },
          h("div", { style: css("position:absolute;left:-5px;top:0;bottom:0;width:11px;cursor:col-resize") }),
          h("div", { style: css("position:absolute;left:-2px;top:50%;width:5px;height:36px;margin-top:-18px;border-radius:3px;background:#c9c9c9") })),
        h("div", { "data-screen-label": "Execution graph", style: css("min-width:0;min-height:0;display:flex;flex-direction:column;background:#fff") },
          V.isLive ? this.renderLive(V) : null,
          V.isCases ? this.renderCases(V) : null,
          V.isCompare ? this.renderCompare(V) : null,
          V.hasInspector ? this.renderInspector(V) : null)));
  }
}

  var params = new URLSearchParams(window.location.search);
  ReactDOM.createRoot(root).render(h(Debugger, { split: 56, showPolls: true, productTestMode: params.get("test") === "true" }));
})();
