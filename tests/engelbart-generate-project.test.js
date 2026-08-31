"use strict";

// The final "Generate project": a structured, per-goal project grounded ONLY in
// canonical lab data. Papers are chosen by number from the lab's real list and
// mapped back to canonical ids; an out-of-range or invented pick is dropped, so
// the model can never fabricate a paper. Each phase becomes its own goals with
// their own resources (a Brainstorm document, an Understand paper).

const test = require("node:test");
const assert = require("node:assert/strict");
const RM = require("../api/_lib/research-model");
const SetupChat = require("../api/_lib/setup-chat");

const PI = "aaaaaaaa-0000-0000-0000-000000000001";
const S1 = "aaaaaaaa-0000-0000-0000-000000000002";
const PR1 = "aaaaaaaa-0000-0000-0000-000000000003";
const PA1 = "bbbbbbbb-0000-0000-0000-000000000001";
const PA2 = "bbbbbbbb-0000-0000-0000-000000000002";

const LAB = {
  pi: { id: PI, name: "Prof X", lab_name: "X Lab", department: "EECS",
        interests: ["machine learning"], bio: "" },
  members: [{ id: S1, name: "Stu One", title: "PhD student" }],
  projects: [{ id: PR1, title: "Existing Project" }],
  papers: [
    { id: PA1, title: "Paper One", year: 2021, venue: "NeurIPS",
      doi_url: "https://doi.org/1", url: "", has_pdf: true },
    { id: PA2, title: "Paper Two", year: 2022, venue: "ICML",
      doi_url: "", url: "https://x/2", has_pdf: false },
  ],
};

function modelSaying(reply) {
  return async function fetchImpl() {
    return { ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: JSON.stringify(reply) }] }; } };
  };
}

const REPLY = {
  brainstorm: { description: "Shape it", purpose: "so the scope is right",
                document_md: "# Shaping\n- what should it do?" },
  understand: [
    { paper: 0, description: "covers A", purpose: "grounds the method", todos: ["read intro", "find method"] },
    { paper: 1, description: "covers B", purpose: "the baseline", todos: ["read results"] },
    { paper: 9, description: "invented", purpose: "x", todos: [] },       // out of range
  ],
  implement: [{ title: "Build the prototype", description: "a first cut", purpose: "prove it runs", todos: ["scaffold"] }],
  apply: [{ title: "Package the result", description: "share back", purpose: "close the loop", todos: ["writeup"] }],
};

const CREDS = { apiKey: "k", baseUrl: "https://p", models: ["all"] };

test("generateProject grounds Understand in canonical papers and drops invented ones", async () => {
  const project = await RM.generateProject(
    { interest: "ml", idea: { title: "Idea", description: "do a thing", inspired: "Paper One" }, lab: LAB },
    CREDS, { fetchImpl: modelSaying(REPLY) });
  assert.equal(project.understand.length, 2);                 // index 9 dropped
  assert.equal(project.understand[0].paper.paper_id, PA1);
  assert.equal(project.understand[0].paper.url, "https://doi.org/1");
  assert.equal(project.understand[1].paper.paper_id, PA2);
  assert.equal(project.understand[1].paper.url, "https://x/2"); // doi empty -> url
  assert.match(project.brainstorm.document_md, /# Shaping/);
  assert.equal(project.implement.length, 1);
  assert.equal(project.apply.length, 1);
});

test("generateProject invents no papers when the lab has none", async () => {
  const project = await RM.generateProject(
    { interest: "ml", idea: { title: "Idea" }, lab: { ...LAB, papers: [] } },
    CREDS, { fetchImpl: modelSaying(REPLY) });
  assert.equal(project.understand.length, 0);
  assert.ok(project.brainstorm.document_md.length > 0);        // fallback doc still project-specific
});

test("normalizeProject caps counts and dedups papers", () => {
  const project = RM.normalizeProject({
    brainstorm: {}, apply: [],
    understand: [
      { paper: 0, description: "a", purpose: "p" },
      { paper: 0, description: "dup", purpose: "p" },           // duplicate id dropped
      { paper: 1, description: "b", purpose: "p" },
    ],
    implement: Array(9).fill({ title: "g", description: "d", purpose: "p" }),
  }, { lab: LAB, idea: { title: "T" } });
  assert.equal(project.understand.length, 2);
  assert.equal(project.implement.length, 3);                   // MAX_IMPLEMENT
});

test("structuredToPayload lays out phase-tagged goals with goal-level resources", () => {
  const project = {
    brainstorm: { description: "Shape it", purpose: "why", document_md: "# Q\n- one?" },
    understand: [{ paper: { paper_id: PA1, title: "Paper One", url: "https://doi.org/1" },
                   description: "covers", purpose: "matters", todos: ["read"] }],
    implement: [{ title: "Build", description: "d", purpose: "p", todos: ["step"] }],
    apply: [{ title: "Package", description: "d", purpose: "p", todos: ["writeup"] }],
  };
  const payload = SetupChat.normalizePayload(RM.structuredToPayload(project, {
    name: "My Project", objective: "the objective",
  }));
  const byPhase = (ph) => payload.subgoals.filter((s) => s.phase === ph);
  assert.equal(payload.subgoals.length, 4);
  const brain = byPhase("brainstorm")[0];
  assert.equal(brain.label, "Shape the project");
  assert.ok(brain.document && brain.document.body_md.includes("# Q"));
  assert.equal(brain.why, "why");
  const paperGoal = byPhase("understand")[0];
  assert.match(paperGoal.label, /Read/);
  assert.equal(paperGoal.paper.paper_id, PA1);
  assert.equal(byPhase("implement")[0].label, "Build");
  assert.equal(byPhase("apply")[0].label, "Package");
});

test("normalizePayload preserves per-goal phase/why/description/paper/document", () => {
  const out = SetupChat.normalizePayload({
    name: "P", chosen: "P",
    subgoals: [
      { label: "Shape the project", phase: "brainstorm", why: "w", description: "d",
        document: { title: "Shaping: P", body_md: "# Q\n- one?" } },
      { label: "Read “Paper One”", phase: "understand", why: "matters", description: "covers",
        paper: { paper_id: PA1, title: "Paper One", url: "https://doi.org/1" }, todos: ["read"] },
    ],
  });
  assert.equal(out.subgoals.length, 2);
  assert.equal(out.subgoals[0].document.body_md.includes("# Q"), true);
  assert.equal(out.subgoals[1].paper.paper_id, PA1);
  assert.equal(out.subgoals[1].phase, "understand");
});

test("a paperless understand subgoal is dropped, but a document/paper goal with no todos survives", () => {
  const out = SetupChat.normalizePayload({
    name: "P", chosen: "P",
    subgoals: [
      { label: "empty heading" },                                  // no todos/phase/resource -> dropped
      { label: "Shape", phase: "brainstorm", document: { title: "t", body_md: "x" } }, // kept
      { label: "Read bad", phase: "understand", paper: { paper_id: "not-a-uuid" } },   // no valid paper, but phase keeps it
    ],
  });
  const labels = out.subgoals.map((s) => s.label);
  assert.equal(labels.includes("empty heading"), false);
  assert.equal(labels.includes("Shape"), true);
  assert.equal(labels.includes("Read bad"), true);
});

test("normalizeProvenance keeps only valid canonical ids", () => {
  const prov = SetupChat.normalizeProvenance({
    interest: "ml", lab: { pi_id: PI, lab_name: "X Lab" }, pi: { id: PI, name: "Prof X" },
    students: [{ id: S1, name: "Stu One" }, { id: "bad", name: "No Id" }],
    papers: [{ paper_id: PA1, title: "Paper One" }, { paper_id: "bad", title: "drop" }],
    projects: [{ id: PR1, title: "Existing Project" }],
    idea: { title: "Idea", inspired: "Paper One" },
  });
  assert.equal(prov.lab.pi_id, PI);
  assert.equal(prov.students.length, 2);              // bad id kept with name, id blanked
  assert.equal(prov.students[1].id, "");
  assert.equal(prov.papers.length, 1);                // paper needs a valid id
  assert.equal(prov.papers[0].paper_id, PA1);
});

test("generateProject throws on an unusable reply instead of a near-empty project", async () => {
  // Truncated / non-JSON output used to slip through as a "structured" project
  // holding only the Shape goal; a throw lets save_path degrade to the lanes
  // the student actually drafted.
  const unusable = async function fetchImpl() {
    return { ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: '{"brainstorm": {"descr' }] }; } };
  };
  await assert.rejects(
    RM.generateProject({ interest: "", idea: { title: "T" }, lab: LAB, lanes: {} },
      CREDS, { fetchImpl: unusable }),
    /usable JSON/);
});

test("generateProject asks the gateway for the large-reply headroom", async () => {
  let body = null;
  const capture = async function fetchImpl(url, init) {
    body = JSON.parse(init.body);
    return { ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: JSON.stringify(REPLY) }] }; } };
  };
  await RM.generateProject({ interest: "", idea: { title: "T" }, lab: LAB, lanes: {} },
    CREDS, { fetchImpl: capture });
  assert.equal(body.max_tokens, 8192);
});
