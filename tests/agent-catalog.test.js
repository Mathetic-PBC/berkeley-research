"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const cp = require("node:child_process");
const test = require("node:test");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "engelbart/setup/test");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(DIR, "agent-catalog.js"), "utf8"), sandbox);
const catalog = JSON.parse(JSON.stringify(sandbox.window.EGB_AGENT_CATALOG));
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const prompts = require("../api/_lib/onboarding-prompts.js");
const runtimeRevision = "d82f5f43c1ac7137941b8596f9018833e15e7fbe";

test("the catalog preserves actual editable templates and covers every exported model invocation", () => {
  assert.deepEqual(catalog.editablePrompts, prompts.ORDER);
  assert.deepEqual(catalog.prompts, prompts.TEMPLATES);
  for (const file of ["onboarding-model", "research-model", "setup-chat"]) {
    const modulePath = "api/_lib/" + file + ".js";
    const exported = require(path.join(ROOT, modulePath));
    const functions = Object.entries(exported).filter(([symbol, value]) => symbol !== "callModel" && typeof value === "function" && /\b(?:callModel|generate|searched)\(/.test(value.toString())).map(([symbol]) => symbol);
    assert.ok(functions.length, file);
    for (const symbol of functions) assert.ok(catalog.nodes.some(node => node.kind === "model" && node.sources.some(source => source.path === modulePath && source.symbol === symbol)), "Unmapped model invocation: " + modulePath + ":" + symbol);
  }
  for (const node of catalog.nodes.filter(node => node.kind === "model")) assert.ok((node.prompts || []).length || (node.promptKeys || []).length, node.id + " must expose a source template or builder");
});

test("server sources and model modules cannot drift silently from generated source metadata", () => {
  const sources = catalog.nodes.flatMap(node => node.sources).concat(catalog.modelModules);
  for (const source of sources.filter(source => source.path.startsWith("api/"))) {
    const text = fs.readFileSync(path.join(ROOT, source.path), "utf8");
    assert.equal(hash(text), source.sha256, source.path + " changed; regenerate and review the graph");
    if (source.symbol) assert.match(source.url, new RegExp("/" + catalog.sourceRevisions.onboarding + "/"));
  }
});

test("every edge names an existing node in the same scope and declares its relationship", () => {
  const byId = new Map(catalog.nodes.map(node => [node.id, node]));
  assert.equal(byId.size, catalog.nodes.length);
  for (const node of catalog.nodes) {
    assert.ok(["human", "model", "deterministic"].includes(node.kind), node.id);
    assert.ok(node.purpose && node.sources.length, node.id);
    for (const source of node.sources) assert.ok(source.line > 0 && source.symbol && /^[a-f0-9]{64}$/.test(source.sha256), node.id);
  }
  for (const edge of catalog.edges) {
    assert.ok(byId.has(edge.from) && byId.has(edge.to), JSON.stringify(edge));
    assert.equal(byId.get(edge.from).scope, byId.get(edge.to).scope);
    assert.ok(["conditional", "data", "call"].includes(edge.kind));
    assert.ok(edge.label);
  }
  assert.equal(catalog.edges.filter(edge => byId.get(edge.from).scope === "other").length, 0, "Independent APIs must not be drawn as an invented invocation sequence");
});

test("runtime distinguishes inference, inspection, acceptance validation, and conditional repair", () => {
  const node = id => catalog.nodes.find(item => item.id === "runtime-" + id);
  const edge = (from, to) => catalog.edges.find(item => item.from === "runtime-" + from && item.to === "runtime-" + to);
  for (const id of ["router", "discover", "verification", "inspect", "acceptanceGate", "previewRecover"]) assert.equal(node(id).kind, "deterministic", id);
  for (const id of ["chat", "brainstorm", "overseer", "path"]) assert.match(node(id).model, /Opus/);
  assert.equal(node("restartCheck").kind, "model");
  assert.ok(node("restartCheck").prompts.some(prompt => prompt.label.includes("RESTART_CHECK") && prompt.text.includes("restart")));
  assert.match(node("restartCheck").purpose, /does not itself restart/);
  assert.match(node("builder").model, /HC_BUILD_QUICK_MODEL/);
  assert.match(node("path").condition, /post-verification/);
  assert.ok(edge("router", "acceptanceGate") && edge("acceptanceGate", "builder"));
  assert.equal(edge("router", "builder"), undefined, "Build routing cannot bypass current acceptance validation");
  assert.ok(edge("verification", "repair"), "Failure can happen before artifact inspection");
  assert.match(edge("previewRecover", "repair").label, /Needs build, agents enabled, accepted completed rows/);
  assert.match(catalog.scopes.find(scope => scope.id === "runtime").note, /HC_AGENTS=0/);
  assert.ok(edge("message", "chat") && edge("chat", "builder"));
  assert.equal(catalog.sourceRevisions.runtime, runtimeRevision);
  for (const source of catalog.nodes.filter(node => node.scope === "runtime").flatMap(node => node.sources)) assert.ok(source.url.includes("/" + runtimeRevision + "/"));
});

test("the shipped catalog reproduces exactly from pinned runtime and current server sources", t => {
  const candidates = [process.env.CLAUDE_PLUGINS_DIR, path.join(ROOT, "../claude-plugins-interface-fix"), path.join(ROOT, "../claude-plugins")].filter(Boolean);
  const checkout = candidates.find(candidate => fs.existsSync(path.join(candidate, ".git")));
  if (!checkout) return t.skip("Runtime checkout unavailable; server hashes and catalog invariants are still checked");
  cp.execFileSync(process.execPath, [path.join(DIR, "agent-catalog.build.cjs"), "--check"], { cwd: ROOT, env: { ...process.env, CLAUDE_PLUGINS_DIR: checkout }, timeout: 30000 });
});

test("graph search includes prompt text and recording matching never assigns resource recovery to every assets call", () => {
  class Component { constructor(props) { this.props = props; } setState(change, callback) { this.state = { ...this.state, ...(typeof change === "function" ? change(this.state) : change) }; if (callback) callback(); } }
  const context = { window: { React: { Component, createRef: () => ({ current: null }), createElement: () => null } } };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, "agent-graph.js"), "utf8"), context);
  const graph = new context.window.EGB_AGENT_GRAPH({ catalog, calls: [{ key: "assetsPrompt", purpose: "assets" }, { key: "resourceFallback", purpose: "assets" }] });
  const recovery = catalog.nodes.find(node => node.id === "resourceFallback");
  assert.equal(graph.calls(recovery).length, 1);
  assert.equal(graph.calls(recovery)[0].key, "resourceFallback");
  graph.state.query = "do-not-find-this-text";
  assert.equal(graph.matches(recovery), false);
  graph.state.query = recovery.prompts[0].text.slice(0, 45);
  assert.equal(graph.matches(recovery), true);
  graph.state.scope = "runtime";
  assert.equal(graph.calls(catalog.nodes.find(node => node.id === "runtime-chat")).length, 0);
  const positions = context.window.EGB_AGENT_GRAPH_LAYOUT(catalog.nodes.filter(node => node.scope === "onboarding"));
  assert.ok(Math.max(...positions.map(node => node.x)) < 1500, "Long rank chains wrap into readable bands");
  assert.ok(positions.find(node => node.id === "create").y > positions.find(node => node.id === "sources").y);
});
