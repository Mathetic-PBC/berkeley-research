class Component extends DCLogic {
  state = this.initial();
  initial() { return { step: 0, maxSeen: 0, name: "", year: "", yearOther: false, yearText: "", major: "", slide: 100, touched: false,
    pfile: null, pover: false, popen: null, plink: "", prepo: "", pfam: 0.2, pdrag: false, analysis: null,
    z: 0.25, zDrag: false, fIdx: 0, fam: {}, fAnswers: {}, drag: false, bank: null, paper: null, fields: null,
    draft: "", qIdx: 0, answers: {}, goalPick: -1, goalOther: "", todos: [], newTodo: "", projName: "",
    askBtn: null, askOpen: false, askQuote: "", askText: "", asks: [] }; }
  contentRef = React.createRef();
  ANALYZE_MS = 6000;
  YEARS = ["First year", "Second year", "Third year", "Fourth year"];
  MAJORS = ["Computer Science", "Electrical Engineering & Computer Sciences", "Data Science", "Cognitive Science", "Molecular & Cell Biology", "Bioengineering", "Mechanical Engineering", "Applied Mathematics", "Statistics", "Physics", "Economics", "Business Administration", "Political Science", "Psychology", "Public Health", "English", "History", "Sociology", "Architecture", "Undeclared"];
  LEVELS = [{ label: "PLAIN LANGUAGE", short: "Plain" }, { label: "SOME TECHNICAL DETAIL", short: "Some detail" }, { label: "FULLY TECHNICAL", short: "Technical" }];
  P_LEVELS = ["I'm completely lost", "I wouldn't know where to start", "I can get oriented", "I can get started", "I can extend it"];
  P_DESCS = ["I wouldn't understand what the project does or what to learn first.", "I follow the main ideas, but wouldn't know how to start building or contributing.", "I grasp the general ideas, but need heavy guidance on the paper, code, or methods.", "I can navigate the paper and code, spot what to learn, and begin a task with little guidance.", "I can independently implement, troubleshoot, compare approaches, and design extensions."];
  plvl() { return Math.max(0, Math.min(4, Math.ceil(this.state.pfam * 5) - 1)); }
  setPFile(f) { if (f && f.type === "application/pdf") this.setState({ pfile: { name: f.name.replace(/\.pdf$/i, ""), meta: "PDF · " + (f.size / 1024 / 1024).toFixed(1) + " MB" }, pover: false }); }
  shortUrl(u) { try { return new URL(u.startsWith("http") ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }
  Z_LEVELS = ["Everyday", "Some detail", "Technical", "Expert"];
  Z_PHRASE = ["in everyday language", "with some technical detail", "technical", "expert-level"];
  Z_SAMPLE = [
    "The program reads your request, makes the changes in your files, checks its work, and tells you when it's done.",
    "The agent takes a prompt, calls tools like read_file and run_shell, feeds the results back to the model, and loops until the task is finished.",
    "The dispatch loop parses tool_use blocks, executes against a name-keyed registry, appends tool_result to the transcript, and terminates on end_turn.",
    "Dispatch is a fold over the message log: each tool_use is validated against its JSON schema, executed with a bounded budget, and its tool_result appended before re-sampling; termination on end_turn or the iteration cap."
  ];
  zLevel() { return Math.max(0, Math.min(3, Math.ceil(this.state.z * 4) - 1)); }
  commitZ(z) { const L = Math.max(0, Math.min(3, Math.ceil(z * 4) - 1)); this.setState(s => ({ z, zDrag: false, touched: true, slide: Math.min(2, L) * 100, todos: this.relevel(s.todos, Math.min(2, L)) })); }
  // ---- Background analysis (runs silently after Sources) ----
  // PLACEHOLDER system prompt. Input: the uploaded paper text + links + per-source familiarity. Output: JSON only.
  SYSTEM_PROMPT_ANALYZE = `You are given a research paper (and optional links) a student is working from, plus how familiar they say they are with each source.
Return ONLY JSON of this shape:
{
  "paper": { "title": string, "venue": string, "summary": string },   // summary: one plain sentence, no jargon
  "fields": [ { "name": string, "why": string, "topic": string } ]     // exactly 4 fields the paper leans on; why = one clause tying it to the paper; topic = the specific sub-topic to assess
}
Order fields from most to least load-bearing for the paper.`;
  // PLACEHOLDER system prompt. Input: the 4 fields/topics above + the 5 level definitions. Output: JSON only.
  SYSTEM_PROMPT_QUESTIONS = `You write short-answer questions that check a student's familiarity with a TOPIC. Each topic is one a paper relies on, but questions must be about the topic itself — general knowledge in that field — NOT about the paper, its method, or its claims. Never mention the paper.
For EVERY field write exactly five questions, one per level: 0 asks for everyday intuition; 25 asks to recognise an idea; 50 asks to explain it from memory; 75 asks to apply it to a new situation; 100 asks to critique or compare approaches. Each answerable in one sentence.
Reply ONLY with JSON: an array of 4 arrays (one per field, in order), each containing 5 question strings (levels 0→100).`;
  // Canned result used when no model is reachable.
  ANALYSIS_FALLBACK = {
    paper: { title: "ReAct: Synergizing Reasoning and Acting in Language Models", venue: "ICLR · 2023", summary: "A language model takes turns thinking out loud and doing something, then looks at what happened — and the paper shows this beats either thinking or acting alone." },
    fields: [
      { name: "Machine learning", why: "the paper is about how a model is prompted", topic: "prompting large language models and in-context examples" },
      { name: "Software engineering", why: "the loop that calls tools is code you'll write", topic: "control loops, APIs and calling external functions from code" },
      { name: "Human–computer interaction", why: "someone has to steer and read what the agent does", topic: "feedback, visibility of system state and trust in automation" },
      { name: "Cognitive science", why: "the paper's claim that reasoning and acting reinforce each other", topic: "how people interleave planning and action when solving problems" }
    ],
    bank: [
      ["If you wanted a friend to answer a question the way you would, what would you show them first?", "What does it mean to give a model an 'example' inside your request?", "Explain in your own words what a prompt is and why wording changes the answer.", "How would you get a model to always answer in a fixed format without retraining it?", "When would few-shot examples hurt rather than help, compared with fine-tuning?"],
      ["If a program has to keep checking something over and over, what's the risk?", "What's the difference between a program that runs once and one that runs in a loop?", "Explain what an API call is and what comes back from one.", "How would you stop a loop that calls an external service from running forever?", "When would you choose retries with backoff over failing fast for an external call?"],
      ["When a machine is doing something for you, what makes you trust it's working?", "What does 'showing the system's state' mean in an interface?", "Explain why visibility of what an automated tool is doing matters to its user.", "How would you design the moment a tool asks the user for permission without being annoying?", "Compare two ways of showing an agent's intermediate steps and say when each fails."],
      ["When you assemble furniture, do you plan every step first or figure it out as you go — why?", "What is meant by 'thinking out loud' while solving a problem?", "Explain how planning and acting can feed into each other.", "How would you test whether writing down reasoning actually improves someone's decisions?", "Critique the claim that verbal reasoning traces reflect the actual process behind a decision."]
    ]
  };
  FLEVELS = ["Wouldn't know where to start", "I can follow it", "I can explain it", "I can use it", "I can reason with it"];
  FDESCS = ["I wouldn't recognize most of the important concepts.", "I recognize the main ideas when someone explains them.", "I could explain the core ideas in my own words, from memory.", "I could use the ideas to solve a new problem or make a design decision.", "I could spot mistakes, compare approaches, and explain when an idea would or wouldn't work."];
  SNAP = [0.2, 0.4, 0.6, 0.8, 1];
  PROJECT_QS = [
    { id: "who", kind: "choice", title: ["Who is this for?", "Who is this for?", "Target user?"], options: ["Just me", "A class or a small team", "Anyone who wants to install it"] },
    { id: "lang", kind: "choice", title: ["What do you want to write it in?", "Which language or runtime?", "Language / runtime?"], options: ["Python", "TypeScript / Node", "Something else", "Not sure yet"] },
    { id: "first", kind: "multi", title: ["What should the very first version be able to do?", "What must the first slice do?", "Scope of the first slice?"],
      optionsLv: [["Take one request and change a file", "Show what it's doing while it works", "Ask before doing anything risky", "Remember earlier parts of the conversation"],
        ["One prompt in → a file edit out", "Show tool calls as they happen", "Confirm before destructive commands", "Keep a long conversation coherent"],
        ["Single prompt → tool call → file edit round trip", "Stream tool events to the terminal", "Confirmation gate on destructive shell", "Transcript compaction under the context window"]] },
    { id: "never", kind: "short", title: ["Anything it should never do?", "Any hard constraints?", "Hard constraints / invariants?"], hint: "Optional.", placeholder: "e.g. never touch files outside the project folder" }
  ];
  GOALS = [
    [{ label: "A tool you can type a request into and it edits your project files", short: "The core loop", why: "Everything else builds on this. Get it working and you already have a real, if rough, helper." },
     { label: "Give the tool hands: read a file, write a file, run a command", short: "The three tools", why: "Without these it can only talk. This is what lets it actually do things." },
     { label: "A safe place for it to run commands so it can't break your computer", short: "A safe fence", why: "If a program is going to run commands for you, you want a fence around it." },
     { label: "Help it remember a long conversation without getting confused", short: "Memory", why: "This is what separates a fun demo from something you'd use on a real project." }],
    [{ label: "A CLI that can read a prompt, call an LLM, and edit files in a project", short: "The core CLI loop", why: "This is the core loop everything else depends on — get this working and you have a real agent, even a crude one." },
     { label: "A tool-use layer the agent can call (read file, write file, run shell command)", short: "Tool-use layer", why: "Without tools the agent can only talk, not act — this is what turns a chatbot into a coding agent." },
     { label: "A safe execution sandbox for running agent-issued shell commands", short: "Execution sandbox", why: "If you're letting an LLM run commands on your machine, containment is what keeps this from being terrifying." },
     { label: "A conversation/context manager that keeps long sessions coherent", short: "Context manager", why: "This is the piece that separates a toy demo from something usable on a real multi-file project." }],
    [{ label: "A REPL-style CLI: prompt → model → tool calls → file edits, with streaming output", short: "Agent loop", why: "The loop is the dependency root; a crude but complete loop beats polished parts." },
     { label: "A typed tool-use layer (read_file, write_file, run_shell) with JSON-schema signatures", short: "Tool layer", why: "Tools are the actuator; without them the model is a chatbot with no side effects." },
     { label: "A sandboxed executor for model-issued shell (allowlist, cwd jail, timeouts, no network)", short: "Sandbox", why: "Untrusted, model-generated commands on a host need containment before autonomy." },
     { label: "A context manager: transcript compaction, tool-result truncation, rolling summaries", short: "Context manager", why: "Multi-file sessions blow past the window fast; compaction is what keeps them coherent." }]
  ];
  OTHER = [{ label: "Something else", why: "tell it what to start on instead and it will use that" }, { label: "Something else", why: "tell it what to start on instead and it will use that" }, { label: "Something else", why: "specify an alternative starting goal" }];
  KEYS = ["loop", "tools", "guard", "context"];
  TODOS = [
    { loop: ["Spot when the AI's reply is asking to use a tool", "Run that tool and add what happened to the conversation", "Keep going until the AI replies without asking for a tool, then show its answer"],
      tools: ["Read a file: give it a path, get the text back (stop if the file is huge)", "Write a file: give it a path and new text; refuse anything outside your project folder", "Run a command: get back what it printed and whether it worked (give up after a few seconds)"],
      guard: ["Ask before running anything that deletes or installs", "Show each step as it happens so you can follow along", "Save the conversation so you can look back at what it did"],
      context: ["Cut long tool output down to the first and last few lines", "Summarise old parts of the conversation when it gets long", "Keep the summary and the recent turns together when asking the AI"],
      other: ["Write down what 'done' looks like in one sentence", "Build the smallest version that does it end to end", "Try it once on something real and note what broke"] },
    { loop: ["Parse tool calls out of the model's response", "Execute the named tool and append the result to the transcript", "Loop until the model answers without a tool call, then show that answer"],
      tools: ["Implement read_file: path in, contents out, with a size cap", "Implement write_file: path + new contents, refusing paths outside the project", "Implement run_shell: command in, stdout/stderr/exit code out, with a timeout"],
      guard: ["Add a confirm step for destructive commands (rm, install, git push)", "Stream tool calls and results to the terminal as they happen", "Log each session to a file for replay"],
      context: ["Truncate tool results to head + tail", "Summarise older turns once the transcript passes a token budget", "Send summary + recent turns as the model's context"],
      other: ["Define 'done' in one sentence", "Build the thinnest end-to-end slice", "Run it on a real case and record what broke"] },
    { loop: ["Parse tool_use blocks; validate args against schema", "Execute, append tool_result to transcript; surface errors as results, not exceptions", "Terminate on stop_reason=end_turn; cap iterations; emit final text"],
      tools: ["read_file(path): UTF-8 read, byte cap, realpath check against project root", "write_file(path, content): atomic write via temp+rename, path jail enforced", "run_shell(cmd): subprocess with timeout, captured stdout/stderr/exit, cwd pinned"],
      guard: ["Allow/deny lists for run_shell with a confirmation gate on destructive patterns", "Stream deltas and tool events to a TUI pane", "Persist transcript as JSONL for replay and eval"],
      context: ["Head/tail truncation of tool_result content", "Rolling summarisation past a token threshold", "Assemble context as system + summary + recent window"],
      other: ["Specify the acceptance criterion", "Implement the minimal end-to-end path", "Exercise on a real input; log failures"] }
  ];
  GLOSS = [
    [/\bloop|trajector|observ/i, ["The program repeats the same few steps — think, do, check — until the job is done.", "The agent loop: send the transcript to the model, run whatever tool it asks for, append the result, repeat until it answers without a tool call.", "Core control flow: model call → parse tool_use → execute → append tool_result → re-call; terminate on end_turn or an iteration cap."]],
    [/sandbox|safe|fence|contain|destructive|risky/i, ["A fenced-off area where commands can run without touching the rest of your computer.", "An isolated environment (restricted folder, no network, time limits) so a bad command can't do real damage.", "Process isolation via cwd jail, allowlists, resource limits and no network egress."]],
    [/context|transcript|conversation|remember|memory|compaction/i, ["The AI can only hold so much in mind at once. Long conversations have to be trimmed or summarised so it doesn't lose the thread.", "The context window is the model's working memory; the transcript is kept inside it by truncating results or summarising older turns.", "Token budgeting across the transcript: tool-result truncation and rolling summarisation to stay under the window."]],
    [/reason|think step|trace/i, ["Letting the AI write out its thinking before it acts, so each step is based on the last.", "A reasoning trace: the model emits intermediate thoughts before choosing an action, which improves the action it picks.", "Interleaved chain-of-thought tokens conditioning subsequent action selection; the ReAct contribution."]],
    [/few-shot|prompting/i, ["Showing the AI a couple of worked examples so it copies the pattern.", "Few-shot prompting: include a handful of example trajectories in the prompt so the model imitates the format.", "In-context exemplars of full trajectories; no gradient updates."]],
    [/\btool|function|action/i, ["A 'tool' is one thing the program can do for the AI, like reading a file. The AI asks for it by name, the program does it and reports back.", "A tool is a named function with a description and expected inputs; the model requests it, your code runs it and returns the result.", "A schema-described function exposed to the model; calls arrive as structured tool_use blocks, results return as tool_result content."]],
    [/\bcli\b|terminal|command-line|repl/i, ["A program you use by typing into a text window instead of clicking buttons.", "A command-line interface: you run it from the terminal and interact by typing.", "A terminal-native binary; stdin/stdout interaction, suitable for piping and TUI rendering."]],
    [/model|\bllm\b|\bai\b/i, ["The AI that reads your request and decides what to do next.", "A language model called via an API; it returns text and, optionally, tool calls.", "An LLM invoked through a messages API with native tool-use support."]]
  ];
  GENERIC = ["Put simply: this is one of the steps that turns typing a request into real changes in your files.", "In short: this is part of the pipeline that lets the model act on your codebase instead of just describing changes.", "This is a component of the act-observe loop; it exists so model output becomes verified side effects."];
  QUICK = ["What does this mean?", "Why does this matter?", "Give me an example", "Is this too much for a first project?"];
  componentDidMount() {
    this._mu = (e) => {
      if (e.target && e.target.closest && e.target.closest("[data-askbtn]")) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const t = sel ? sel.toString().trim() : "";
        const c = this.contentRef.current;
        if (!t || t.length < 3 || !c || !sel.rangeCount || !c.contains(sel.anchorNode) || this.state.step < 6) { if (this.state.askBtn) this.setState({ askBtn: null }); return; }
        const r = sel.getRangeAt(0).getBoundingClientRect(), cr = c.getBoundingClientRect();
        this.setState({ askBtn: { text: t.slice(0, 240), x: r.left - cr.left + r.width / 2, y: r.top - cr.top } });
      }, 0);
    };
    document.addEventListener("mouseup", this._mu);
    this._prev = { step: this.state.step, analysis: this.state.analysis, fIdx: this.state.fIdx };
    if (this.state.step === 3 || this.state.step === 4 || (this.state.step === 6 && this.state.analysis === "done")) this.spotlight();
  }
  componentWillUnmount() { document.removeEventListener("mouseup", this._mu); this._anId = -1; }
  level() { return Math.max(0, Math.min(2, Math.round(this.state.slide / 100))); }
  spotlight() { clearTimeout(this._spotT); this.setState(s => ({ spot: true, spotKey: (s.spotKey || 0) + 1 })); this._spotT = setTimeout(() => this.setState({ spot: false }), 3000); }
  componentDidUpdate() {
    const s = this.state, p = this._prev || {};
    const onTopics = s.step === 6 && s.analysis === "done", wasOn = p.step === 6 && p.analysis === "done";
    this._prev = { step: s.step, analysis: s.analysis, fIdx: s.fIdx };
    if ((onTopics && !wasOn) || (onTopics && p.fIdx !== s.fIdx) || (s.step === 3 && p.step !== 3) || (s.step === 4 && p.step !== 4)) this.spotlight();
  }
  flvl(i) { return Math.max(0, Math.min(4, Math.ceil((this.state.fam[i] ?? 0.2) * 5) - 1)); }
  famAvg() { const n = (this.state.fields || []).length; if (!n) return null; let t = 0; for (let i = 0; i < n; i++) t += this.flvl(i); return t / n; }
  assessedLevel() {
    const lv = this.level(), avg = this.famAvg();
    if (avg == null || this.state.step < 7) return lv;
    if (avg <= 1) return Math.max(0, lv - 1);
    if (avg >= 3) return Math.min(2, lv + 1);
    return lv;
  }
  async runAnalysis() {
    const st = this.state, src = [`paper: ${st.pfile ? st.pfile.name : ""}`, st.plink.trim() ? `project page: ${st.plink.trim()}` : "", st.prepo.trim() ? `github: ${st.prepo.trim()}` : "", `familiarity with the paper: ${this.P_LEVELS[this.plvl()]}`].filter(Boolean).join("\n");
    let out = null;
    try {
      if (window.claude && window.claude.complete) {
        const t1 = await window.claude.complete({ max_tokens: 1200, system: this.SYSTEM_PROMPT_ANALYZE, messages: [{ role: "user", content: `Sources:\n${src}` }] });
        const a = JSON.parse(t1.slice(t1.indexOf("{"), t1.lastIndexOf("}") + 1));
        const fields = a.fields.map((f, i) => `${i}. ${f.name} — topic: ${f.topic}`).join("\n");
        const levels = this.FLEVELS.map((l, L) => `${L * 25} "${l}": ${this.FDESCS[L]}`).join("\n");
        const t2 = await window.claude.complete({ max_tokens: 2500, system: this.SYSTEM_PROMPT_QUESTIONS, messages: [{ role: "user", content: `Fields:\n${fields}\n\nLevels:\n${levels}` }] });
        const bank = JSON.parse(t2.slice(t2.indexOf("["), t2.lastIndexOf("]") + 1));
        if (a.fields.length === 4 && bank.length === 4 && bank.every(b => b.length === 5)) out = { paper: a.paper, fields: a.fields, bank };
      }
    } catch (e) { out = null; }
    if (!out) { await new Promise(r => setTimeout(r, this.ANALYZE_MS)); out = this.ANALYSIS_FALLBACK; }
    if (this._anId !== this._anRun) return;
    this.setState({ analysis: "done", paper: out.paper, fields: out.fields, bank: out.bank });
  }
  setLevel(n) { n = Math.max(0, Math.min(2, n)); this.setState(s => ({ slide: n * 100, touched: true, todos: this.relevel(s.todos, n) })); }
  todoKey() { const s = this.state; return s.goalPick === 4 ? "other" : this.KEYS[s.goalPick]; }
  relevel(todos, n) { const k = this.todoKey(); return todos.map(t => (t.src == null || t.custom) ? t : { ...t, text: this.TODOS[n][k][t.src] }); }
  buildTodos(n) { return this.TODOS[n][this.todoKey()].map((t, i) => ({ src: i, custom: false, text: t })); }
  answerFor(quote, question, lv) {
    const hit = this.GLOSS.find(g => g[0].test(quote)) || this.GLOSS.find(g => g[0].test(quote + " " + question));
    let a = hit ? hit[1][lv] : this.GENERIC[lv];
    if (/why/i.test(question)) a += "\n\n" + ["Why it matters: skip it and the tool can't finish real jobs on its own.", "Why it matters: without it the loop either can't act or can't stop cleanly.", "Why it matters: it sits on the critical path of the dispatch loop."][lv];
    if (/example/i.test(question)) a += "\n\n" + ["Example: you type 'rename every foo to bar'. It opens the files, makes the edits, runs your tests, and tells you it's done.", "Example: prompt 'rename foo→bar across src/'. The model calls read_file on each match, write_file with the edit, run_shell for the tests, then stops.", "Example: user turn 'rename foo→bar in src/'. Loop: read_file ×N → write_file ×N → run_shell('npm test') → end_turn with a summary."][lv];
    if (/too much|first project|hard|complicated/i.test(question)) a += "\n\n" + ["For a first project this is fine — start with one tool and one loop, and grow from there.", "Reasonable for a first slice if you keep it to three tools and skip the sandbox for now.", "Scope is fine; defer sandboxing and compaction to a second iteration."][lv];
    return a;
  }
  go(n) { this.setState(s => ({ step: n, maxSeen: Math.max(s.maxSeen, n), askBtn: null, askOpen: false, qIdx: 0 })); }
  startAnalysis() {
    this._anRun = (this._anRun || 0) + 1; this._anId = this._anRun;
    this.setState({ analysis: "busy", paper: null, fields: null, bank: null, fam: {}, fAnswers: {}, fIdx: 0 });
    this.runAnalysis();
  }
  yearLabel() { const s = this.state; return s.yearOther ? s.yearText.trim() : s.year; }
  levelPhrase() { return this.Z_PHRASE[this.zLevel()]; }
  optRow(label, on, pick, square) {
    return { label, pick,
      style: "display:flex;align-items:center;gap:11px;padding:12px 14px;border-radius:8px;cursor:pointer;transition:border-color 120ms,background 120ms;border:1px solid " + (on ? "#171717" : "#eaeaea"),
      hover: on ? "" : "background:#f2f2f2",
      markStyle: "flex:none;width:11px;height:11px;border-radius:" + (square ? "3px" : "50%") + ";border:1.5px solid " + (on ? "#171717;background:#171717" : "#c9c9c9"),
      textStyle: "font:13px/1.4 system-ui;color:" + (on ? "#171717" : "#4d4d4d") };
  }
  renderVals() {
    const s = this.state, set = (p) => this.setState(p), lv = this.level(), alv = this.assessedLevel(), zl = this.zLevel();
    const zPos = e => { const r = e.currentTarget.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    const trunc = (t, n) => t.length > n ? t.slice(0, n - 1).trim() + "…" : t;
    const tiny = (off) => "padding:0;font:500 9px/1 system-ui;letter-spacing:1.2px;text-transform:uppercase;background:none;border:none;color:" + (off ? "#eaeaea;cursor:default" : "#8f8f8f;cursor:pointer");
    const chosenGoal = s.goalPick === 4 ? s.goalOther.trim() : (s.goalPick >= 0 ? this.GOALS[lv][s.goalPick].short : "");
    const goalTitle = s.goalPick === 4 ? s.goalOther.trim() : (s.goalPick >= 0 ? this.GOALS[lv][s.goalPick].label : "");
    const srcVal = s.pfile ? trunc(s.pfile.name, 26) : "";
    const answered = (qs) => qs.filter(q => s.answers[q.id] != null && s.answers[q.id] !== "" && !(Array.isArray(s.answers[q.id]) && !s.answers[q.id].length)).length;
    const vals = [s.name.trim(), this.yearLabel(), s.major.trim(), this.levelPhrase().replace(/^(in |with )/, ""),
      srcVal, trunc(s.draft.trim(), 26), s.step > 6 && s.fields ? s.fields.length + " fields ranked" : "", s.step > 7 ? answered(this.PROJECT_QS) + " of " + this.PROJECT_QS.length + " answered" : "",
      chosenGoal ? trunc(chosenGoal, 26) : "", s.step >= 10 ? s.todos.length + " todos" : ""];
    const labels = ["Name", "Year", "Major", "Explanations", "Paper", "Project", "Topics", "Details", "Focus", "Todos"];
    const rail = labels.map((label, i) => {
      const done = !!vals[i] && s.step > i;
      const active = s.step === i;
      const reachable = i <= s.maxSeen && s.step < 10;
      return { label, value: done && !active ? vals[i] : "", hasCon: i > 0,
        conStyle: "display:block;width:1.5px;height:12px;margin-left:20px;background:" + (s.step >= i ? "#0070f3" : "#eaeaea") + ";transition:background 300ms",
        rowStyle: "display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:8px;" + (active ? "background:#fff;border:1px solid #eaeaea;" : "border:1px solid transparent;") + (reachable && !active ? "cursor:pointer;" : ""),
        rowHover: reachable && !active ? "background:#f2f2f2" : "",
        circleStyle: "flex:none;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:500 9px/1 system-ui;transition:background 300ms;" + (done ? "background:#0070f3;color:#fff;border:none;" : active ? "border:1.5px solid #171717;color:#171717;background:#fff;" : "border:1.5px solid #c9c9c9;color:#8f8f8f;background:#fafafa;"),
        circleText: done ? "\u2713" : String(i + 1),
        labelStyle: done && !active ? "display:block;font:500 9px/1 system-ui;letter-spacing:1.2px;text-transform:uppercase;color:#8f8f8f" : "display:block;font:500 13px/1.3 system-ui;color:" + (active ? "#171717" : "#8f8f8f"),
        go: () => { if (reachable && !active) this.go(i); } };
    });
    const yearRows = this.YEARS.map(label => {
      const on = !s.yearOther && s.year === label;
      return this.optRow(label, on, () => { set({ year: label, yearOther: false }); setTimeout(() => this.go(2), 180); });
    }).concat([this.optRow("Something else", s.yearOther, () => set({ yearOther: !s.yearOther, year: "" }))]);
    const typed = s.major.trim().toLowerCase();
    const seeds = this.MAJORS.filter(m => { const low = m.toLowerCase(); return low !== typed && (!typed || low.indexOf(typed) >= 0); })
      .slice(0, 6).map(label => ({ label, pick: () => { set({ major: label }); setTimeout(() => this.go(3), 180); } }));
    const stops = this.LEVELS.map((l, i) => ({ label: l.label,
      pick: () => set({ slide: i * 100, touched: true }),
      style: "flex:1;padding:0;font:500 9px/1.5 system-ui;letter-spacing:1.2px;background:none;border:none;cursor:pointer;text-align:" + (i === 0 ? "left" : i === 2 ? "right" : "center") + ";color:" + (s.touched && i === lv ? "#0070f3" : "#8f8f8f") }));
    const levelSeg = this.LEVELS.map((l, i) => ({ label: l.short, pick: () => this.setLevel(i),
      style: "padding:0;font:500 9px/1 system-ui;letter-spacing:1.1px;text-transform:uppercase;background:none;border:none;cursor:pointer;color:" + (i === lv ? "#171717" : "#8f8f8f") }));
    const nudge = (off) => "padding:7px 12px;font:500 9px/1 system-ui;letter-spacing:1.2px;text-transform:uppercase;border-radius:999px;background:transparent;border:1px solid " + (off ? "transparent;color:#e2e2e2;cursor:default" : "#eaeaea;color:#4d4d4d;cursor:pointer");
    const cta = (off) => "display:inline-flex;align-items:center;gap:7px;padding:9px 18px;font:500 10px/1 system-ui;letter-spacing:1.4px;text-transform:uppercase;border-radius:999px;transition:opacity 120ms;" + (off ? "color:#8f8f8f;background:#f2f2f2;border:1px solid #eaeaea;cursor:default;" : "color:#fff;background:#171717;border:1px solid #171717;cursor:pointer;");
    const pill = (off) => "padding:8px 14px;font:500 10px/1 system-ui;letter-spacing:1.4px;text-transform:uppercase;border-radius:999px;" + (off ? "color:#8f8f8f;background:#f2f2f2;border:1px solid #eaeaea;cursor:default" : "color:#fff;background:#171717;border:1px solid #171717;cursor:pointer");
    // paper
    const hasFile = !!s.pfile, pl = this.plvl();
    const pRows = [
      { key: "plink", label: "Project page", hint: "optional", placeholder: "https://" },
      { key: "prepo", label: "GitHub", hint: "optional", placeholder: "https://" }
    ].map(r => { const val = s[r.key], open = s.popen === r.key; this._pRefs = this._pRefs || {}; const ref = this._pRefs[r.key] || (this._pRefs[r.key] = React.createRef());
      return { ...r, val, open, ref, rows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, tab: open ? 0 : -1, status: val.trim() && !open ? this.shortUrl(val.trim()) : "", rot: open ? "rotate(90deg)" : "none",
        pick: () => { const next = open ? null : r.key; set({ popen: next }); if (next) setTimeout(() => { const el = ref.current; if (el) { el.focus(); el.select(); } }, 30); },
        change: e => set({ [r.key]: e.target.value }), key: e => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); set({ popen: null }); } } }; });
    const sourcesIncomplete = !hasFile;
    const sendSources = () => { if (sourcesIncomplete) return; this.startAnalysis(); this.go(5); };
    // questions
    // topics / familiarity
    const fields = s.fields || [], fn = fields.length, fi = Math.min(s.fIdx, Math.max(0, fn - 1)), fld = fields[fi];
    const fval = s.fam[fi] ?? 0.2, flv = this.flvl(fi), fkey = fi + ":" + flv;
    const fQuestion = s.bank && fld ? s.bank[fi][flv] : "";
    const fAnswer = s.fAnswers[fkey] || "";
    const fAnswered = !!fAnswer.trim(), fLast = fi === fn - 1;
    const pos = e => { const r = e.currentTarget.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    const snapFam = () => this.setState(st => ({ drag: false, fam: { ...st.fam, [fi]: this.SNAP[Math.max(0, Math.min(4, Math.ceil((st.fam[fi] ?? 0.2) * 5) - 1))] } }));
    const fGo = (i) => set({ fIdx: i });
    const fAdvance = () => { if (!fAnswered) return; if (fLast) this.go(7); else fGo(fi + 1); };
    const fTrans = s.drag ? "none" : "left .25s cubic-bezier(.2,.8,.2,1),width .25s cubic-bezier(.2,.8,.2,1)";
    const fDone = (i) => { for (let L = 0; L < 5; L++) if ((s.fAnswers[i + ":" + L] || "").trim()) return true; return false; };
    // project questions
    const onQ = s.step === 7;
    const qs = this.PROJECT_QS;
    const q = qs[Math.min(s.qIdx, qs.length - 1)];
    const qLv = alv;
    const ans = q ? s.answers[q.id] : undefined;
    const setAns = (v) => this.setState(st => ({ answers: { ...st.answers, [q.id]: v } }));
    const qOptions = q ? (q.optionsLv ? q.optionsLv[qLv] : q.options) || [] : [];
    const qRows = q ? qOptions.map((label, i) => {
      const multi = q.kind === "multi", cur = Array.isArray(ans) ? ans : [];
      const on = multi ? cur.indexOf(i) >= 0 : ans === i;
      return this.optRow(label, on, () => { if (multi) setAns(on ? cur.filter(x => x !== i) : cur.concat([i])); else setAns(on ? null : i); }, multi);
    }) : [];
    const qUnanswered = !q || ans == null || ans === "" || (Array.isArray(ans) && !ans.length) || (typeof ans === "string" && !ans.trim());
    const qLast = s.qIdx >= qs.length - 1;
    const qAdvance = () => { if (qLast) this.go(s.step + 1); else set({ qIdx: s.qIdx + 1 }); };
    const qDots = qs.map((x, i) => ({
      style: "display:block;height:6px;border-radius:999px;transition:width 140ms,background 140ms;cursor:pointer;width:" + (i === s.qIdx ? "20px;background:#0070f3" : "6px;background:#c9c9c9"),
      go: () => set({ qIdx: i }) }));
    const weakest = fn ? fields.reduce((b, f, i) => this.flvl(i) < this.flvl(b) ? i : b, 0) : -1;
    const qIntro = alv < lv ? "Asking in plainer terms — you're newest to " + (fields[weakest] ? fields[weakest].name.toLowerCase() : "the topics") + "." : alv > lv ? "Asking more directly — you rated yourself strong across the paper's fields." : "";
    // goal & todos
    const goalRows = this.GOALS[lv].concat([this.OTHER[lv]]).map((g, i) => {
      const on = s.goalPick === i;
      return { label: g.label, why: g.why,
        pick: () => set({ goalPick: on ? -1 : i }),
        style: "display:flex;align-items:flex-start;gap:11px;padding:13px 14px;border-radius:8px;cursor:pointer;transition:border-color 120ms,background 120ms;border:1px solid " + (on ? "#171717" : "#eaeaea"),
        hover: on ? "" : "background:#f2f2f2",
        markStyle: "flex:none;margin-top:4px;width:11px;height:11px;border-radius:50%;border:1.5px solid " + (on ? "#171717;background:#171717" : "#c9c9c9"),
        textStyle: "display:block;font:500 13.5px/1.5 system-ui;color:" + (on ? "#171717" : "#4d4d4d") };
    });
    const goalUnpicked = s.goalPick < 0 || (s.goalPick === 4 && !s.goalOther.trim());
    const genTodos = () => { if (goalUnpicked) return;
      this.setState({ todos: this.buildTodos(lv), projName: s.projName || (s.goalPick === 4 ? "my-project" : ["agent-loop", "agent-tools", "safe-sandbox", "context-keeper"][s.goalPick]) }, () => this.go(9)); };
    const todoRows = s.todos.map((r, i) => ({ text: r.text,
      edit: e => { const v = e.target.value; this.setState(st => ({ todos: st.todos.map((x, ri) => ri === i ? { ...x, text: v, custom: true } : x) })); },
      del: () => this.setState(st => ({ todos: st.todos.filter((x, ri) => ri !== i) })) }));
    const todoCount = s.todos.length, canAddTodo = todoCount < 4;
    const createOff = todoCount < 2 || todoCount > 4 || !s.projName.trim();
    const nameEmpty = !s.name.trim(), yearTextEmpty = !s.yearText.trim(), majorEmpty = !s.major.trim(), draftEmpty = !s.draft.trim();
    const disabledNow = (s.step === 0 && nameEmpty) || (s.step === 1 && yearTextEmpty) || (s.step === 2 && majorEmpty) ||  (s.step === 4 && sourcesIncomplete) || (s.step === 5 && draftEmpty) || (s.step === 8 && goalUnpicked);
    const enterNext = (empty) => (e) => { if (e.key === "Enter" && !empty) this.go(s.step + 1); };
    const sendDraft = () => { if (draftEmpty) return; this.go(6); };
    // ask
    const askEmpty = !s.askText.trim();
    const sendAsk = (qq) => { const question = (qq || s.askText).trim(); if (!question) return;
      const id = Math.random().toString(36).slice(2);
      this.setState(st => ({ asks: [{ id, quote: st.askQuote, question, level: lv, thinking: true }].concat(st.asks), askOpen: false, askText: "" }));
      setTimeout(() => this.setState(st => ({ asks: st.asks.map(k => k.id === id ? { ...k, thinking: false } : k) })), 900); };
    const asks = s.asks.map(k => {
      const setL = (n) => this.setState(st => ({ asks: st.asks.map(x => x.id === k.id ? { ...x, level: Math.max(0, Math.min(2, n)) } : x) }));
      return { quote: k.quote, question: k.question, thinking: k.thinking, ready: !k.thinking,
        answer: this.answerFor(k.quote, k.question, k.level), tag: this.LEVELS[k.level].short,
        atPlain: k.level === 0, atFull: k.level === 2, simpler: () => setL(k.level - 1), deeper: () => setL(k.level + 1),
        simplerStyle: tiny(k.level === 0), deeperStyle: tiny(k.level === 2),
        remove: () => this.setState(st => ({ asks: st.asks.filter(x => x.id !== k.id) })) };
    });
    const genStage = s.step >= 6 && s.step <= 9 && !(s.step === 6 && s.analysis !== "done");
    return {
      rail, yearRows, seeds, stops, goalRows, todoRows, levelSeg, asks,
      levelSample: this.Z_SAMPLE[zl],
      zHint: s.touched ? "You can change this later." : "Everyday is the default · drag to change · you can adjust it later", zLevelName: this.Z_LEVELS[zl], zLevelDesc: ["Plain words, no jargon, analogies where they help.", "Uses some technical language when necessary; assumes some familiarity.\n", "Assumes you know the field well; explanations of niche concepts.", "Terse and precise; uses specific jargon and references advanced concepts."][zl], zPct: (s.z * 100).toFixed(2) + "%", zCursor: s.zDrag ? "grabbing" : "grab",
      zTrans: s.zDrag ? "none" : "left .25s cubic-bezier(.2,.8,.2,1),width .25s cubic-bezier(.2,.8,.2,1)",
      zBars: Array.from({ length: 4 }, (v, i) => ({ h: (25 + 75 * (i / 3)) + "%", fill: (Math.min(1, Math.max(0, s.z * 4 - i)) * 100).toFixed(1) + "%" })),
      zStops: this.Z_LEVELS.map((label, i) => ({ label, pick: () => this.commitZ((i + 1) / 4),
        style: "background:none;border:0;padding:0;cursor:pointer;font:" + (i === zl ? "500" : "400") + " 13px/1.4 system-ui;text-align:center;transition:color .2s;color:" + (i === zl ? "#171717" : "#8f8f8f") })),
      zDown: e => { e.currentTarget.setPointerCapture(e.pointerId); const z = zPos(e); this.setState({ zDrag: true, z, touched: true }); },
      zMove: e => { if (this.state.zDrag) this.setState({ z: zPos(e) }); },
      zUp: () => { if (this.state.zDrag) this.commitZ(Math.max(1, Math.min(4, Math.ceil(this.state.z * 4))) / 4); },
      analyzing: s.analysis === "busy",
      showRegister: false,
      atPlain: lv === 0, atFull: lv === 2, lessJargon: () => this.setLevel(lv - 1), moreDetail: () => this.setLevel(lv + 1),
      nudgeDownStyle: nudge(lv === 0), nudgeUpStyle: nudge(lv === 2),
      contentRef: this.contentRef,
      noFile: !hasFile, hasFile, fileName: hasFile ? s.pfile.name : "", fileMeta: hasFile ? s.pfile.meta : "",
      dropBg: s.pover ? "#f2f2f2" : "#fafafa",
      pDragOver: e => { e.preventDefault(); if (!s.pover) set({ pover: true }); }, pDragLeave: () => set({ pover: false }),
      pDrop: e => { e.preventDefault(); this.setPFile(e.dataTransfer.files[0]); }, pFileChange: e => this.setPFile(e.target.files[0]),
      pClearFile: () => set({ pfile: null }), pRows, sendSources,
      pLevelName: this.P_LEVELS[pl], pLevelDesc: this.P_DESCS[pl],
      pPct: (s.pfam * 100).toFixed(2) + "%", pCursor: s.pdrag ? "grabbing" : "grab", pTrans: s.pdrag ? "none" : "left .25s cubic-bezier(.2,.8,.2,1),width .25s cubic-bezier(.2,.8,.2,1)",
      pBars: Array.from({ length: 5 }, (v, b) => ({ h: (25 + 75 * (b / 4)) + "%", fill: (Math.min(1, Math.max(0, s.pfam * 5 - b)) * 100).toFixed(1) + "%" })),
      pDown: e => { e.currentTarget.setPointerCapture(e.pointerId); set({ pdrag: true, pfam: zPos(e) }); },
      pMove: e => { if (this.state.pdrag) set({ pfam: zPos(e) }); },
      pUp: () => { if (this.state.pdrag) this.setState(st => ({ pdrag: false, pfam: Math.max(1, Math.min(5, Math.ceil(st.pfam * 5))) / 5 })); },
      askBtnOn: !!s.askBtn && !s.askOpen,
      askBtnStyle: "position:absolute;z-index:5;transform:translate(-50%,-100%);margin-top:-8px;padding:7px 12px;font:500 10px/1 system-ui;letter-spacing:1.2px;text-transform:uppercase;color:#fff;background:#171717;border:1px solid #171717;border-radius:999px;cursor:pointer;animation:pop 140ms both;left:" + (s.askBtn ? s.askBtn.x : 0) + "px;top:" + (s.askBtn ? s.askBtn.y : 0) + "px",
      openAsk: () => { const qt = s.askBtn ? s.askBtn.text : ""; set({ askOpen: true, askQuote: qt, askBtn: null, askText: "" }); const sel = window.getSelection(); if (sel) sel.removeAllRanges(); },
      closeAsk: () => set({ askOpen: false, askText: "" }),
      askOpen: s.askOpen, askQuote: s.askQuote, askText: s.askText, askEmpty, hasAsks: s.asks.length > 0,
      askBtnSendStyle: pill(askEmpty),
      quickAsks: this.QUICK.map(label => ({ label, send: () => sendAsk(label) })),
      askSend: () => sendAsk(), setAskText: e => set({ askText: e.target.value }),
      askKey: e => { if (e.key === "Enter") { e.preventDefault(); sendAsk(); } if (e.key === "Escape") set({ askOpen: false }); },
      thinkDots: Array.from({ length: 9 }, (v, i) => ({ style: "width:4px;height:4px;border-radius:50%;background:#171717;opacity:.15;animation:pulse 1.1s ease-in-out infinite;animation-delay:" + (i * 90) + "ms" })),
      onName: s.step === 0, onYear: s.step === 1, onMajor: s.step === 2, onLevel: s.step === 3, onSources: s.step === 4, onProject: s.step === 5,
      onWaiting: s.step === 6 && s.analysis !== "done", onTopics: s.step === 6 && s.analysis === "done", onQuestions: onQ, onGoal: s.step === 8, onTodos: s.step === 9, onDone: s.step === 10,
      paperTitle: s.paper ? s.paper.title : "", paperVenue: s.paper ? s.paper.venue : "", paperSummary: s.paper ? s.paper.summary : "",
      fNum: fi + 1, fCount: fn, fName: fld ? fld.name : "", fWhy: fld ? fld.why : "",
      fLevelName: this.FLEVELS[flv], fLevelDesc: this.FDESCS[flv],
      fPct: (fval * 100).toFixed(2) + "%", fCursor: s.drag ? "grabbing" : "grab", fTrans,
      fBars: Array.from({ length: 5 }, (v, b) => ({ h: (25 + 75 * (b / 4)) + "%", fill: (Math.min(1, Math.max(0, fval * 5 - b)) * 100).toFixed(1) + "%" })),
      fDown: e => { e.currentTarget.setPointerCapture(e.pointerId); this.setState(st => ({ drag: true, fam: { ...st.fam, [fi]: pos(e) } })); },
      fMove: e => { if (this.state.drag) { const p = pos(e); this.setState(st => ({ fam: { ...st.fam, [fi]: p } })); } },
      fUp: () => { if (this.state.drag) snapFam(); },
      spot: !!s.spot, spotKey: s.spotKey || 0, slidePct: "calc(7.5px + (100% - 15px) * " + (s.slide / 200) + ")",
      fLoading: !s.bank, fReady: !!s.bank, fQuestion, fAnswer, fBorder: fAnswered ? "#c9c9c9" : "#eaeaea",
      setFAnswer: e => { const v = e.target.value; this.setState(st => ({ fAnswers: { ...st.fAnswers, [fkey]: v } })); },
      fKey: e => { if (e.key === "Enter") { e.preventDefault(); fAdvance(); } },
      fHint: !s.bank ? "" : fAnswered ? (fLast ? "All set — on to your project." : "Next field →") : "Answer to move on. Changing the level asks a different question.",
      fBack: () => { if (fi > 0) fGo(fi - 1); }, fAtFirst: fi === 0,
      fBackStyle: "flex:none;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font:15px/1 system-ui;color:#8f8f8f;background:transparent;border:1px solid #eaeaea;border-radius:50%;transition:color 120ms,border-color 120ms;" + (fi === 0 ? "opacity:.35;cursor:default" : "cursor:pointer"),
      fDots: fields.map((x, i) => ({ style: "display:block;height:6px;border-radius:999px;transition:width 140ms,background 140ms;cursor:pointer;width:" + (i === fi ? "20px;background:#0070f3" : "6px;background:" + (fDone(i) ? "#8f8f8f" : "#c9c9c9")), go: () => fGo(i) })),
      fNext: fAdvance, fUnanswered: !fAnswered, fNextStyle: cta(!fAnswered), fNextLabel: fLast ? "On to the project" : "Next",
      qStepLabel: "Step 8 of 10 · Details",
      qNum: s.qIdx + 1, qCount: qs.length, qIntro, qIntroTag: "Taken into account",
      qTitle: q ? q.title[qLv] : "", qHint: q ? q.hint || "" : "", qPlaceholder: q ? q.placeholder || "" : "",
      qIsOptions: !!q && q.kind !== "short", qIsMulti: !!q && q.kind === "multi", qIsShort: !!q && q.kind === "short", qRows,
      qText: typeof ans === "string" ? ans : "", setQText: e => setAns(e.target.value),
      qKey: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!qUnanswered) qAdvance(); } },
      qDots, qAtFirst: s.qIdx === 0, qBack: () => { if (s.qIdx > 0) set({ qIdx: s.qIdx - 1 }); },
      qSkip: () => { setAns(null); qAdvance(); }, qNext: () => { if (!qUnanswered) qAdvance(); }, qUnanswered, qNextStyle: cta(qUnanswered),
      qNextLabel: qLast ? "Pick a focus" : "Next",
      name: s.name, yearText: s.yearText, major: s.major, slide: s.slide, draft: s.draft, goalOther: s.goalOther, newTodo: s.newTodo, projName: s.projName,
      yearOther: s.yearOther, goalOtherOn: s.goalPick === 4, goalTitle,
      nameEmpty, yearTextEmpty, majorEmpty, draftEmpty, goalUnpicked, levelUntouched: !s.touched,
      todoCount, canAddTodo, createOff, createStyle: pill(createOff),
      todoHint: todoCount < 2 ? "At least two todos." : todoCount >= 4 ? "Four is the cap — keep the first project small." : "Edit, remove, or add up to " + (4 - todoCount) + " more.",
      backArrowStyle: "flex:none;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font:15px/1 system-ui;color:#8f8f8f;background:transparent;border:1px solid #eaeaea;border-radius:50%;transition:color 120ms,border-color 120ms;" + (s.qIdx === 0 ? "opacity:.35;cursor:default" : "cursor:pointer"),
      ctaStyle: cta(disabledNow),
      setName: e => set({ name: e.target.value }), setYearText: e => set({ yearText: e.target.value }), setMajor: e => set({ major: e.target.value }),
      setDraft: e => set({ draft: e.target.value }), setGoalOther: e => set({ goalOther: e.target.value }),
      setNewTodo: e => set({ newTodo: e.target.value }), setProjName: e => set({ projName: e.target.value }),
      nameKey: enterNext(nameEmpty), yearKey: enterNext(yearTextEmpty), majorKey: enterNext(majorEmpty),
      draftKey: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDraft(); } },
      newTodoKey: e => { if (e.key === "Enter" && s.newTodo.trim() && canAddTodo) { const v = s.newTodo.trim(); this.setState(st => ({ newTodo: "", todos: st.todos.concat([{ src: null, custom: true, text: v }]) })); } },
      slideInput: e => set({ slide: Number(e.target.value), touched: true }),
      slideChange: e => set({ slide: Math.max(0, Math.min(2, Math.round(Number(e.target.value) / 100))) * 100, touched: true }),
      slideChangeLevel: e => this.setLevel(Math.round(Number(e.target.value) / 100)),
      next: () => { if (!disabledNow && s.step < 4) this.go(s.step + 1); },
      sendDraft, genTodos,
      createProject: () => { if (!createOff) set({ step: 10, maxSeen: 10, askOpen: false, askBtn: null }); },
      restart: () => { this._anId = -1; set(this.initial()); },
      doneLevel: this.levelPhrase()
    };
  }
}
