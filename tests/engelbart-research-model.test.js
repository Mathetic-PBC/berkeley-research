"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const RM = require("../api/_lib/research-model");

const CREDS = { baseUrl: "https://llm.example", apiKey: "key", models: ["claude-sonnet-4-5-20250929"] };

const LAB = {
  pi: {
    id: "p1", name: "Adam Yala", title: "Assistant Professor",
    lab_name: "Yala Lab", department: "Computational Precision Health",
    interests: ["machine learning", "precision medicine"], bio: "Works on clinical ML.",
  },
  members: [{ id: "m1", name: "Jane Doe", interests: [] }],
  projects: [
    { id: "pr1", title: "Mirai", description: "Breast-cancer risk model.", status: "active" },
    { id: "pr2", title: "Pillar-0", description: "Medical imaging foundation model.", status: "active" },
  ],
  papers: [
    { id: "pa1", title: "Deep mammographic risk", year: 2021, venue: "Radiology" },
    { id: "pa2", title: "Imaging foundation models", year: 2023, venue: "NeurIPS" },
  ],
};

// Fake LiteLLM proxy: replays a canned model reply in Anthropic Messages shape,
// and captures the prompt so we can assert grounding.
function modelReturning(payload, capture) {
  return async function fetchImpl(url, options) {
    if (capture) capture.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: JSON.stringify(payload) }] }; },
    };
  };
}

function modelHttpError(status) {
  return async function fetchImpl() {
    return { ok: false, status, async json() { return { error: { message: "spent" } }; } };
  };
}

test("labContext grounds the prompt in the lab's real name, PI, projects, and papers", () => {
  const ctx = RM.labContext(LAB);
  assert.match(ctx, /Yala Lab/);
  assert.match(ctx, /Adam Yala/);
  assert.match(ctx, /Mirai/);
  assert.match(ctx, /Pillar-0/);
  // real papers are now part of the grounding, not only Understand
  assert.match(ctx, /Relevant papers from this lab/);
  assert.match(ctx, /Deep mammographic risk/);
});

test("labContext bounds the paper set and keeps the caller's order (curated first)", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, title: `Paper ${i}` }));
  const ctx = RM.labContext({ ...LAB, papers: many });
  assert.match(ctx, /Paper 0/);
  assert.match(ctx, /Paper 5/);          // within the bound
  assert.doesNotMatch(ctx, /Paper 6/);   // MAX_CONTEXT_PAPERS = 6, rest dropped
});

test("generateIdeas grounds ideas in the lab's real papers, not just projects", async () => {
  const calls = [];
  await RM.generateIdeas({ lab: LAB, interest: "clinical ml" }, CREDS, {
    fetchImpl: modelReturning(
      { ideas: [{ title: "T", what: "w", why: "y", inspired: "Deep mammographic risk" }] }, calls),
  });
  const prompt = calls[0].body.messages[0].content;
  assert.match(prompt, /Relevant papers from this lab/);
  assert.match(prompt, /Deep mammographic risk/);          // the real paper reached the prompt
});

// The retrieval rows clusterAreas groups over (the shape lab_matches returns).
const MATCHES = [
  { pi_id: "a1", pi_name: "Preeya Khanna", lab_name: "Sensorimotor Neural Engineering Lab", department: "Neuroscience", interests: ["motor control", "BCI"] },
  { pi_id: "a2", pi_name: "Gopala Anumanchipalli", lab_name: "Berkeley Speech Group", department: "EECS", interests: ["speech neuroprosthesis"] },
  { pi_id: "a3", pi_name: "Amy Pavel", lab_name: "Pavel Research Group", department: "EECS", interests: ["accessibility", "assistive tech"] },
];

test("clusterAreas maps model indices back to real pi_ids and keeps only real labs", async () => {
  const calls = [];
  const out = await RM.clusterAreas(
    { interest: "brain computer interfaces", labs: MATCHES },
    CREDS,
    { fetchImpl: modelReturning({ areas: [
      { label: "Neural interfaces", summary: "decoding movement and speech", labs: [0, 1, 1, 99] },
      { label: "Assistive technology", summary: "tools for access", labs: [2] },
      { label: "Empty", summary: "no real labs", labs: [42] },   // dropped: no valid labs
    ] }, calls) },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { label: "Neural interfaces", summary: "decoding movement and speech", pi_ids: ["a1", "a2"] });
  assert.deepEqual(out[1].pi_ids, ["a3"]);
  // the prompt listed the real labs by index for grounding
  assert.match(calls[0].body.messages[0].content, /\[0\] Sensorimotor Neural Engineering Lab/);
  assert.match(calls[0].body.messages[0].content, /brain computer interfaces/);
});

test("clusterAreas returns [] for no matched labs, without calling the model", async () => {
  const calls = [];
  const out = await RM.clusterAreas({ interest: "x", labs: [] }, CREDS, { fetchImpl: modelReturning({}, calls) });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

test("clusterAreas falls back to one area over all labs when the model gives nothing usable", async () => {
  const out = await RM.clusterAreas(
    { interest: "x", labs: MATCHES },
    CREDS,
    { fetchImpl: modelReturning({ areas: [] }) },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "Related work");
  assert.deepEqual(out[0].pi_ids, ["a1", "a2", "a3"]);
});

test("generateIdeas normalizes, filters incomplete, and caps to MAX_IDEAS", async () => {
  const calls = [];
  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `Idea ${i}`, what: "build a thing", why: "learn", inspired: "Mirai",
  }));
  many.push({ title: "no what", what: "" });  // dropped (missing what)
  const out = await RM.generateIdeas(
    { lab: LAB, interest: "cancer imaging" },
    CREDS,
    { fetchImpl: modelReturning({ ideas: many }, calls) },
  );
  assert.equal(out.length, RM.MAX_IDEAS);
  assert.ok(out.every((i) => i.title && i.what));
  // prompt carried the interest and the real lab
  assert.match(calls[0].body.messages[0].content, /cancer imaging/);
  assert.match(calls[0].body.messages[0].content, /Yala Lab/);
});

test("refineIdea returns model text, or falls back to the original idea", async () => {
  const good = await RM.refineIdea(
    { lab: LAB, idea: { title: "T", description: "D" }, note: "make it smaller" },
    CREDS,
    { fetchImpl: modelReturning({ title: "T2", description: "D2", say: "narrowed" }) },
  );
  assert.deepEqual(good, { title: "T2", description: "D2", say: "narrowed" });

  const fallback = await RM.refineIdea(
    { lab: LAB, idea: { title: "Keep", description: "Same" }, note: "x" },
    CREDS,
    { fetchImpl: modelReturning({}) },
  );
  assert.equal(fallback.title, "Keep");
  assert.equal(fallback.description, "Same");
  assert.ok(fallback.say.length > 0);
});

test("generatePath always returns the four lanes, rows bounded, main/sub kept", async () => {
  const out = await RM.generatePath(
    { lab: LAB, idea: { title: "Reproduce Mirai", description: "..." }, interest: "ml" },
    CREDS,
    {
      fetchImpl: modelReturning({
        name: "Mirai mini",
        objective: "Reproduce a slice of Mirai",
        lanes: {
          brainstorm: ["What subset is feasible?"],
          understand: ["Read the Mirai paper\nfocus on the risk head", "  "],
          implement: Array.from({ length: 9 }, (_, i) => `step ${i}`),
          apply: ["Share with the lab"],
          bogus: ["ignored"],
        },
      }),
    },
  );
  assert.equal(out.name, "Mirai mini");
  assert.deepEqual(Object.keys(out.lanes).sort(), RM.LANES.slice().sort());
  assert.equal(out.lanes.implement.length, RM.MAX_ROWS);            // capped
  assert.equal(out.lanes.understand.length, 1);                    // blank row dropped
  assert.match(out.lanes.understand[0], /Read the Mirai paper\nfocus on the risk head/);
});

test("generatePath falls back to the idea when the model omits name/objective", async () => {
  const out = await RM.generatePath(
    { lab: LAB, idea: { title: "Fallback Title", what: "Fallback objective" } },
    CREDS,
    { fetchImpl: modelReturning({ lanes: {} }) },
  );
  assert.equal(out.name, "Fallback Title");
  assert.equal(out.objective, "Fallback objective");
  assert.deepEqual(out.lanes, { brainstorm: [], understand: [], implement: [], apply: [] });
});

test("a spent credit key surfaces as a 409, not a 502", async () => {
  await assert.rejects(
    () => RM.generateIdeas({ lab: LAB }, CREDS, { fetchImpl: modelHttpError(401) }),
    (err) => err.statusCode === 409,
  );
  await assert.rejects(
    () => RM.generatePath({ lab: LAB, idea: {} }, CREDS, { fetchImpl: modelHttpError(429) }),
    (err) => err.statusCode === 409,
  );
});

test("explorationToPayload maps the four lanes into subgoals + todos", () => {
  const payload = RM.explorationToPayload({
    name: "Mirai mini",
    objective: "Reproduce a slice of Mirai",
    idea: { inspired: "Mirai" },
    lab: { lab_name: "Yala Lab", pi_name: "Adam Yala", department: "CPH" },
    lanes: {
      brainstorm: ["Which subset?"],
      understand: ["Read the paper\nfocus on the risk head"],
      implement: ["", "Load the data"],   // blank dropped
      apply: [],                           // empty lane -> no subgoal
    },
  });
  assert.equal(payload.name, "Mirai mini");
  assert.equal(payload.chosen, "Mirai mini");
  assert.deepEqual(payload.goals, [{ label: "Mirai mini", why: "Reproduce a slice of Mirai" }]);
  // provenance folded into the plan description
  assert.match(payload.plan.description, /Based on Yala Lab, led by Adam Yala\./);
  assert.match(payload.plan.description, /Inspired by Mirai\./);
  // lanes -> subgoals, in order, empty lane dropped
  assert.deepEqual(payload.subgoals.map((s) => s.label), ["Brainstorm", "Understand", "Implement"]);
  // main\nsub folded to one line with an em dash
  assert.equal(payload.subgoals[1].todos[0], "Read the paper — focus on the risk head");
  assert.deepEqual(payload.subgoals[2].todos, ["Load the data"]);
});

test("explorationToPayload falls back to the idea for name and objective", () => {
  const payload = RM.explorationToPayload({
    idea: { title: "Fallback", what: "Do the thing", inspired: "" },
    lanes: { brainstorm: ["a"] },
  });
  assert.equal(payload.name, "Fallback");
  assert.equal(payload.plan.description, "Do the thing");
  assert.equal(payload.chosen, "Fallback");
});

test("explorationToPayload survives SetupChat.normalizePayload unchanged in shape", () => {
  const SetupChat = require("../api/_lib/setup-chat");
  const bounded = SetupChat.normalizePayload(RM.explorationToPayload({
    name: "P", objective: "O", lanes: { understand: ["read x"], apply: ["ship it"] },
  }));
  assert.equal(bounded.name, "P");
  assert.deepEqual(bounded.subgoals.map((s) => s.label), ["Understand", "Apply"]);
  assert.deepEqual(bounded.subgoals[0].todos, ["read x"]);
});
