/* Rebuild the source-only catalog: node engelbart/setup/test/agent-catalog.build.cjs
 * No model calls, credentials, user records or generated examples are read. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "../../..");
const RUNTIME_SHA = "d82f5f43c1ac7137941b8596f9018833e15e7fbe";
const SITE_SHA = "bc5ca6b31049fdadb17dbab407a65abc7c735474";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
function jsSource(file, symbol) {
  const full = path.join(ROOT, file), text = fs.readFileSync(full, "utf8"), value = require(full)[symbol];
  if (value == null) throw new Error(`Missing exported source ${file}:${symbol}`);
  const content = typeof value === "function" ? value.toString() : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:function\\s+|(?:const|let|var)\\s+)${escaped}\\b`).exec(text);
  const line = match ? text.slice(0, match.index).split("\n").length : 1;
  return { path: file, symbol, line, sha256: sha(text), url: `https://github.com/Mathetic-PBC/berkeley-research/blob/${SITE_SHA}/${file}#L${line}`, content };
}
function sourceOnly(source) { const { content, ...meta } = source; return meta; }
function build() {
  const P = require(path.join(ROOT, "api/_lib/onboarding-prompts.js"));
  const nodes = [], edges = [];
  const add = (id, label, kind, column, purpose, sources, extra = {}) => nodes.push({ id, label, kind, column, purpose, scope: "onboarding", sources: sources.map(sourceOnly), ...extra });
  const source = (file, symbol) => jsSource("api/_lib/" + file + ".js", symbol);
  const ob = symbol => source("onboarding", symbol), model = symbol => source("onboarding-model", symbol);
  const edge = (from, to, label, kind = "conditional") => edges.push({ from, to, label, kind });
  add("sources", "Choose research sources", "human", 0, "Supply a PDF, dataset or article, optionally with a project page and repository. The source revision invalidates dependent analysis and planning.", [ob("sources")]);
  add("analysis", "Read the sources", "model", 1, "Extract bounded research analysis and calibration questions from the supplied sources.", [model("analyze")], { model: "Sonnet family", promptKeys: ["analyzePrompt"], purposes: ["analysis"], symbol: "analyze" });
  add("assets", "Find research resources", "model", 1, "Search for resources grounded in the source material. Web search is conditional on provider support.", [model("assets")], { model: "Sonnet family", promptKeys: ["assetsPrompt"], purposes: ["assets"], symbol: "assets" });
  add("links", "Verify resource links", "deterministic", 2, "Check returned links and retain their access evidence; this stage does not ask a model to guess availability.", [ob("verifyLinks")]);
  add("answer", "Answer a topic question", "human", 2, "Choose a familiarity level and answer the displayed question; its grade can trigger a follow-up.", [ob("answer")]);
  add("grade", "Grade the answer", "model", 3, "Score the answer against the calibrated question and sample answer.", [model("grade")], { model: "Haiku family", promptKeys: ["gradePrompt"], purposes: ["grade"], symbol: "grade" });
  add("followup", "Ask a follow-up", "model", 4, "Write a follow-up when the grade and self-rating disagree enough; it is not asked for every answer.", [model("followUp"), ob("answer")], { model: "Sonnet family", promptKeys: ["followUpPrompt"], purposes: ["follow_up"], symbol: "followUp" });
  add("assessment", "Compile assessment", "deterministic", 4, "Combine calibration records into the reader assessment and explanation depth.", [ob("compileAssessment"), ob("assessedDepth")]);
  add("leveled", "Fit resources to the reader", "model", 5, "Use research resources, interest and assessed knowledge to suggest accessible entry points.", [model("levelAssets")], { model: "Sonnet family", promptKeys: ["levelPrompt"], purposes: ["leveled"], symbol: "levelAssets" });
  add("brainstorm", "Discuss a direction", "model", 5, "Produce a bounded brainstorm turn from the reader, source analysis and conversation. The opening is a cheaper bounded call; later turns may offer a plan.", [model("brainstorm"), ob("brainstorm")], { model: "Haiku for opening; Sonnet for later turns", promptKeys: ["brainstormPrompt"], purposes: ["brainstorm"], symbol: "brainstorm" });
  add("choose", "Choose a resource", "human", 6, "Select the resource and continue to a proposed direction. This is a user decision, not an autonomous agent.", [ob("chooseAsset")]);
  add("planning", "Advance planning stages", "deterministic", 7, "Persist and claim one resumable resource/draft/review/correction stage per request. A failed check can request at most one corrected draft.", [source("resumable-plan", "advance")]);
  add("resourceFallback", "Recover inaccessible resources", "model", 8, "A bounded continuation of the resource search finds compatible alternatives or explicitly marked synthetic examples when access recovery requires it.", [model("resourceFallback")], { model: "Sonnet family", condition: "Only when deterministic resource resolution cannot use the selected resource.", purposes: [], symbol: "resourceFallback", prompts: [{ label: "Resource recovery prompt builder (source)", text: model("resourceFallback").content }] });
  for (const [id, label, column, purpose] of [
    ["direction", "Propose a direction", 8, "Draft a paper-grounded, runnable direction using the selected resource and reader context."],
    ["subgoals", "Propose subgoals", 9, "Break the accepted direction into three actionable footholds."],
    ["todos", "Propose TODOs", 10, "Generate executable work for the first settled subgoal, with the source and resources in context."]
  ]) add(id, label, "model", column, purpose, [model(id), model("planStage")], { model: "Sonnet family", promptKeys: [id + "Prompt"], purposes: [id], symbol: id, prompts: [{ label: "Additional grounding rules (source)", text: source("plan-evidence", "rules").content }] });
  add("review", "Review the proposed plan", "model", 9, "Check grounding, actionability, mechanism fidelity, resource honesty and progression. Rejection requests a correction or ends the bounded attempt.", [source("plan-evidence", "reviewPrompt"), model("planStage")], { model: "Sonnet family", purposes: ["paper_plan_check"], prompts: [{ label: "Plan review prompt builder (source)", text: source("plan-evidence", "reviewPrompt").content }] });
  add("create", "Create the project", "deterministic", 11, "Compile and persist the accepted setup into a project and goals. This endpoint does not generate another model answer.", [ob("create")]);
  for (const [id, label, symbol, key, purpose, family] of [
    ["assetAsk", "Answer a resource question", "assetAsk", "assetAskPrompt", "asset_ask", "Sonnet family"],
    ["ask", "Explain selected text", "ask", "askPrompt", "ask", "Sonnet family"],
    ["rewrite", "Change explanation depth", "rewrite", "rewritePrompt", "rewrite", "Haiku family"],
    ["details", "Ask project questions", "details", "detailsPrompt", "details", "Sonnet family"],
    ["goals", "Generate legacy goals", "goals", "goalsPrompt", "goals", "Sonnet family"]
  ]) add(id, label, "model", id === "details" || id === "goals" ? 3 : 6, "On-demand " + label.toLowerCase() + " through its existing API action.", [model(symbol), source("onboarding-prompts", key)], { model: family, condition: id === "details" || id === "goals" ? "Retained API path; not a mandatory step in the current source → direction onboarding." : "Only when the reader asks for this action.", promptKeys: P.TEMPLATES[key] ? [key] : [], prompts: P.TEMPLATES[key] ? [] : [{ label: key + " builder (source)", text: source("onboarding-prompts", key).content }], purposes: [purpose], symbol });
  edge("sources", "analysis", "Run source analysis"); edge("sources", "assets", "Run resource search");
  edge("assets", "links", "Validate returned URLs", "call"); edge("analysis", "answer", "Calibration questions", "data");
  edge("answer", "grade", "Submitted answer"); edge("grade", "followup", "Grade/self-rating disagreement");
  edge("grade", "assessment", "Calibration result", "data"); edge("assessment", "leveled", "Reader assessment", "data");
  edge("links", "leveled", "Checked resource catalog", "data"); edge("analysis", "brainstorm", "Research analysis", "data");
  edge("brainstorm", "choose", "Reader continues"); edge("leveled", "choose", "Available choices", "data");
  edge("choose", "planning", "Continue or revise"); edge("planning", "resourceFallback", "Access recovery needed");
  for (const id of ["direction", "subgoals", "todos"]) { edge("planning", id, "Claimed " + id + " draft stage"); edge(id, "review", "Draft passes structural checks"); }
  edge("review", "planning", "Advance or request one correction"); edge("direction", "subgoals", "Accepted direction", "data");
  edge("subgoals", "todos", "First selected subgoal", "data"); edge("todos", "create", "Accepted TODOs", "data");
  edge("leveled", "assetAsk", "Selected resource", "data"); edge("analysis", "ask", "Selected text and research context", "data");
  edge("analysis", "details", "Research context", "data"); edge("details", "goals", "Answered project questions", "data");

  for (const [symbol, label] of [["clusterAreas", "Cluster research areas"], ["generateIdeas", "Generate research ideas"], ["refineIdea", "Refine a research idea"], ["generatePath", "Generate a research path"], ["generateProject", "Generate a research project"], ["extractLab", "Extract lab information"]]) {
    const s = source("research-model", symbol);
    add("research-" + symbol, label, "model", 0, "Separate research API capability: " + label.toLowerCase() + ". It is not a required setup step.", [s], { scope: "other", model: "Sonnet family via pickModel", prompts: [{ label: "Prompt builder (source)", text: s.content }], symbol });
  }
  for (const [symbol, label, prompt] of [["turn", "Conversational setup", "FORM"], ["fromBrief", "Compile a setup brief", "BRIEF_FORM"]]) {
    add("setup-" + symbol, label, "model", 1, "Separate setup-chat API path, retained alongside the current guided onboarding.", [source("setup-chat", symbol)], { scope: "other", model: "Sonnet family via pickModel", prompts: [{ label: prompt, text: source("setup-chat", prompt).content }], symbol });
  }
  const runtime = require("./agent-runtime.catalog.cjs").build({ ROOT, RUNTIME_SHA, sha });
  nodes.push(...runtime.nodes); edges.push(...runtime.edges);
  return {
    version: 1, sourceRevisions: { onboarding: SITE_SHA, runtime: RUNTIME_SHA },
    scopes: [
      { id: "onboarding", label: "Guided onboarding", note: "Declared API paths. Dotted links describe data dependencies; dashed links run only under their stated conditions. Separate optional actions are not a mandatory sequence." },
      { id: "runtime", label: "Installed workspace", note: "Runtime pinned to " + RUNTIME_SHA.slice(0, 7) + ". HC_AGENTS=0 disables orchestration, not the separate transcript-synthesis and preview paths. Source architecture, not observed setup activity." },
      { id: "other", label: "Other model APIs", note: "Additional research and setup-chat endpoints. No connecting arrows are inferred merely because functions appear in the same file." }
    ],
    editablePrompts: P.ORDER, prompts: P.TEMPLATES, nodes, edges,
    modelModules: ["api/_lib/onboarding-model.js", "api/_lib/research-model.js", "api/_lib/setup-chat.js"].map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(ROOT, file), "utf8")) })),
  };
}
function output(catalog) { return "/* Generated from source by agent-catalog.build.cjs; do not hand-edit. */\nwindow.EGB_AGENT_CATALOG = " + JSON.stringify(catalog, null, 2) + ";\n"; }
if (require.main === module) {
  const text = output(build()), destination = path.join(__dirname, "agent-catalog.js");
  if (process.argv.includes("--check")) { if (fs.readFileSync(destination, "utf8") !== text) throw new Error("Agent catalog drifted; rebuild from its pinned sources."); }
  else fs.writeFileSync(destination, text);
}
module.exports = { build, output, RUNTIME_SHA, SITE_SHA };
