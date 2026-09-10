"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
function build({ ROOT, RUNTIME_SHA, sha }) {
  const candidates = [process.env.CLAUDE_PLUGINS_DIR, path.join(ROOT, "../claude-plugins-interface-fix"), path.join(ROOT, "../claude-plugins")].filter(Boolean);
  const checkout = candidates.find(candidate => fs.existsSync(path.join(candidate, ".git")));
  if (!checkout) throw new Error("Set CLAUDE_PLUGINS_DIR to the runtime checkout to regenerate its pinned source catalog.");
  const nodes = [], edges = [], cache = new Map();
  function source(file, symbol) {
    const relative = "hc/src/human_compact/" + file;
    if (!cache.has(relative)) {
      const text = cp.execFileSync("git", ["show", RUNTIME_SHA + ":" + relative], { cwd: checkout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const parsed = JSON.parse(cp.execFileSync("python3", ["-c", `import ast,json,sys,subprocess
text=subprocess.check_output(['git','show',sys.argv[2]+':'+sys.argv[3]],cwd=sys.argv[1],text=True); tree=ast.parse(text); out={}
def walk(nodes,prefix=''):
 for n in nodes:
  if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
   name=prefix+n.name
   out[name]={'line':n.lineno,'content':ast.get_source_segment(text,n),'literal':False}
   if isinstance(n,ast.ClassDef): walk(n.body,name+'.')
  elif isinstance(n,(ast.Assign,ast.AnnAssign)):
   targets=n.targets if isinstance(n,ast.Assign) else [n.target]
   for target in targets:
    if isinstance(target,ast.Name):
     try: value=ast.literal_eval(n.value)
     except (ValueError,TypeError,SyntaxError): value=None
     if isinstance(value,(list,tuple)) and all(isinstance(v,str) for v in value): value='\\n'.join(value)
     out[prefix+target.id]={'line':n.lineno,'content':value if isinstance(value,str) else ast.get_source_segment(text,n),'literal':isinstance(value,str)}
walk(tree.body)
print(json.dumps(out))`, checkout, RUNTIME_SHA, relative], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
      cache.set(relative, { text, parsed });
    }
    const record = cache.get(relative), found = record.parsed[symbol];
    if (!found) throw new Error("Missing pinned runtime source: " + relative + ":" + symbol);
    return { path: relative, symbol, sha256: sha(record.text), line: found.line, url: `https://github.com/divadbaroon/claude-plugins/blob/${RUNTIME_SHA}/${relative}#L${found.line}`, content: found.content, literal: found.literal };
  }
  const s = (file, symbol) => source("trajectory/" + file + ".py", symbol);
  const a = (file, symbol) => s("agents/" + file, symbol);
  const meta = source => { const { content, literal, ...rest } = source; return rest; };
  function add(id, label, kind, column, purpose, sources, model, condition, prompts = []) {
    nodes.push({ id: "runtime-" + id, label, kind, column, purpose, scope: "runtime", sources: sources.map(meta), model, condition,
      prompts: prompts.map(prompt => ({ label: prompt.symbol + (prompt.literal ? " template" : " prompt builder (source)"), text: prompt.content })) });
  }
  const edge = (from, to, label, kind = "conditional") => edges.push({ from: "runtime-" + from, to: "runtime-" + to, label, kind });
  add("message", "Send a Bart message", "human", 0, "Send a question, ask for options or explicitly request a plan. Pending human questions have their own answer-resolution path.", [a("orchestrator", "Orchestrator.bart_message")]);
  add("context", "Condense project context", "model", 1, "Compress a large project digest and cache it by tree hash before routing the message.", [s("brainstorm", "_project_context")], "Opus by default; interface model setting", "Only for long uncached project context with a project directory.", [s("brainstorm", "CONDENSE")]);
  add("router", "Route events", "deterministic", 2, "Dispatch meaningful events and enforce hard constraints. Build requests, completed builds and failed verification take deterministic routes; an Overseer model is not always called.", [a("overseer", "route"), a("overseer", "fallback"), a("policy", "is_meaningful")]);
  add("overseer", "Overseer", "model", 3, "Choose the next permitted agent action for meaningful events. Hard safety and explicit user intent override the model's proposed route.", [a("overseer", "_model"), a("overseer", "route")], "Opus by default; interface model setting", "Called only for eligible meaningful events; not for the deterministic build/verify-failure routes.", [a("overseer", "PROMPT")]);
  add("chat", "Chat", "model", 4, "Answer in prose, propose up to three TODOs, or classify missing information as a human preference or an environment fact. Special focuses resolve pending answers and paused builder questions.", [a("chat", "ask"), a("chat", "compose")], "Opus by default; interface model setting", "Default conversation route; proposals require the user's Add action before changing TODOs.", [a("chat", "PROMPT"), a("context", "UPDATE_INSTRUCTIONS")]);
  add("brainstorm", "Brainstorm", "model", 4, "Produce options, clarification cards and proposed TODOs using the conversation and current project.", [a("brainstorm", "reply"), s("brainstorm", "ask")], "Opus by default; interface model setting", "Explicit brainstorm requests or a bounded need for human preference clarification.", [s("brainstorm", "FORM"), a("orchestrator", "focus")]);
  add("path", "Path planner", "model", 4, "Propose at most twelve whitelisted planning operations. Applying them is separately validated against the current tree.", [a("path", "plan")], "Opus by default; interface model setting", "Explicit planning request or permitted post-verification replanning.", [a("path", "PROMPT")]);
  add("apply", "Validate and apply plan", "deterministic", 5, "Compare the tree snapshot and atomically apply allowed edits; refuse changes that replace busy or completed work.", [a("path", "apply")]);
  add("discover", "Inspect the environment", "deterministic", 5, "Read bounded project entries, manifests and saved run commands. This is local inspection, not a model or arbitrary source search.", [a("runtime", "LocalRuntime.discover")]);
  add("human", "Answer or add a proposal", "human", 6, "Supply a preference, resume or cancel a waiting build, or explicitly add a proposed TODO. Routine code edits do not invoke every agent.", [a("orchestrator", "Orchestrator._answer_pending"), a("orchestrator", "note_op")]);
  add("buildRequest", "Press Build", "human", 0, "Explicitly request selected TODOs to be built. Conversation routing cannot invent permission to build.", [a("orchestrator", "Orchestrator.build_requested")]);
  add("acceptanceGate", "Ensure current acceptance", "deterministic", 1, "Validate saved acceptance criteria against the selected rows. Request model derivation only when current criteria are missing.", [a("acceptance", "ensure")]);
  add("acceptance", "Derive acceptance checks", "model", 2, "Derive observable acceptance criteria for selected TODOs whose current text has no valid saved criteria. Concurrent requests are coalesced.", [a("acceptance", "derive"), a("acceptance", "ensure")], "Sonnet by default; build model setting", "Missing or stale criteria; may be prepared after TODO edits and is ensured before building.", [a("acceptance", "derive")]);
  add("builder", "Claude builder", "model", 3, "Run Claude Code as a headless streaming session for selected work, reusing that session for answers and repairs. Normal and quick lanes have separately configurable models and effort.", [s("build", "Run._command"), s("build", "compose_prompt")], "Both lanes default Sonnet; model/quick_model settings or HC_BUILD_MODEL/HC_BUILD_QUICK_MODEL", "Explicit build, same-session answer, or bounded verifier-requested repair.", [s("build", "compose_prompt")]);
  add("restartCheck", "Check restart requirement", "model", 5, "Resume the builder to determine whether the delivered change needs a restart or reinstall. This check does not itself restart the app.", [s("build", "Run._check"), s("build", "Run._finish")], "Sonnet with high effort by default; check_model/check_effort settings", "Idle full build only: done rows, prior live process, checks enabled, no error, no queued next work, and no dispatched repair.", [s("build", "RESTART_CHECK")]);
  add("verification", "Coordinate verification", "deterministic", 4, "Check row completion, process exit and preview readiness, then inspect the artifact. The coordinator itself is deterministic.", [a("verifier", "verify"), a("verifier", "_verify")]);
  add("inspect", "Inspect the artifact", "deterministic", 5, "Run Playwright and safe file checks against observable criteria. Complete matching evidence can pass without a model call.", [a("artifacts", "inspect_page"), a("artifacts", "verify")]);
  add("artifactJudge", "Judge incomplete evidence", "model", 6, "Evaluate prose or partially covered acceptance criteria against collected artifact evidence. Every criterion must pass with observed evidence.", [a("artifacts", "verify")], "Sonnet by default; build model setting", "Only when deterministic checks do not cover every criterion.", [a("artifacts", "verify")]);
  add("repair", "Repair or ask the human", "deterministic", 7, "After failed verification, allow up to two same-session repairs; otherwise publish a human question. Old verification must finish before a reopened run replaces it.", [a("orchestrator", "Orchestrator._build"), a("orchestrator", "Orchestrator._escalate")]);
  add("inference", "Infer the shared goal tree", "model", 1, "Read a bounded digest of conversation events and merge a proposed goal update using compare-and-swap. This pipeline is distinct from Bart chat routing.", [s("chat_synth", "refresh"), s("chat_synth", "_provider"), s("chat_synth", "spawn_refresh")], "Sonnet default; HC_CHAT_PROVIDER / HC_CHAT_MODEL", "Active workspace hooks or transcript-follow updates, unless HC_CHAT_INFER=0/off/no/false or a per-chat inference_off file disables the worker. Transcript-follow requests are independent of the active-workspace hook gate.", [s("chat_synth", "INITIAL_PROMPT"), s("chat_synth", "INCREMENTAL_PROMPT")]);
  add("previewDetect", "Detect a preview command", "deterministic", 0, "Detect a repository serving command and its blockers. Safe automatic preview uses deterministic configuration.", [s("preview", "configure"), s("preview", "show_ui")]);
  add("previewSuggest", "Suggest a preview command", "model", 1, "Suggest a startup configuration when deterministic detection is insufficient and the reader explicitly requests help.", [s("preview", "_ask_model")], "Sonnet default; build model setting", "Explicit configuration only; automatic detect-only requests do not call this model.", [s("preview", "_ask_model")]);
  add("previewExplain", "Explain preview failure", "model", 2, "Explain a failed preview process and suggest a bounded correction from captured process output.", [s("preview", "explain_failure")], "Sonnet default; build model setting", "Requested recovery after a preview failure.", [s("preview", "explain_failure")]);
  add("previewIntent", "Interpret preview intent", "model", 2, "Translate current work into a preview intent through the structured provider interface.", [s("preview", "intent_for")], "Sonnet default; build model setting", "When preview intent is requested by its caller.", [s("preview", "intent_for")]);
  add("previewRecover", "Choose preview recovery", "deterministic", 3, "Choose a bounded detected restart, human guidance, or a repair request. Repair requires agents enabled and saved completed acceptance rows.", [s("preview", "recover"), a("orchestrator", "Orchestrator.preview_failed")]);
  edge("message", "context", "Digest exceeds cache threshold"); edge("message", "router", "No pending answer");
  edge("context", "router", "Condensed context", "data"); edge("router", "overseer", "Eligible meaningful event");
  for (const target of ["chat", "brainstorm", "path"]) edge("router", target, "Permitted " + target + " route");
  edge("overseer", "router", "Constrained action proposal", "data"); edge("path", "apply", "Whitelisted plan patch", "call");
  edge("chat", "discover", "Environment fact needed"); edge("discover", "chat", "One bounded discovery retry");
  edge("chat", "brainstorm", "Human preference clarification"); edge("chat", "human", "Proposal or preference question");
  edge("brainstorm", "human", "Options or question"); edge("human", "chat", "Resolve pending answer");
  edge("buildRequest", "router", "Build requested event", "call"); edge("router", "acceptanceGate", "Explicit build route");
  edge("acceptanceGate", "acceptance", "Missing current criteria"); edge("acceptance", "acceptanceGate", "Derived criteria", "data");
  edge("acceptanceGate", "builder", "Current criteria validated");
  edge("builder", "verification", "Finished idle build"); edge("builder", "chat", "Classify paused build question");
  edge("verification", "inspect", "Completion and preview gates pass"); edge("inspect", "artifactJudge", "Some criteria need interpretation");
  edge("verification", "repair", "Pre-inspection verification fails"); edge("builder", "restartCheck", "Finished full build meets restart-check guards");
  edge("inspect", "repair", "Deterministic evidence fails"); edge("artifactJudge", "repair", "Evidence review fails");
  edge("repair", "builder", "Fewer than two repair attempts"); edge("repair", "human", "Repair budget exhausted");
  edge("verification", "router", "Verification passed event"); edge("previewDetect", "previewSuggest", "Explicit fallback configuration");
  edge("previewExplain", "previewRecover", "Failure explanation", "data"); edge("previewRecover", "repair", "Needs build, agents enabled, accepted completed rows");
  edge("previewRecover", "human", "Credential, sign-in or license input needed");
  edge("message", "chat", "Pending answer shortcut"); edge("chat", "builder", "Pending answer authorizes same-session resume");
  return { nodes, edges };
}
module.exports = { build };
