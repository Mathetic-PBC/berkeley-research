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

test("labContext grounds the prompt in the lab's real name, PI, and projects", () => {
  const ctx = RM.labContext(LAB);
  assert.match(ctx, /Yala Lab/);
  assert.match(ctx, /Adam Yala/);
  assert.match(ctx, /Mirai/);
  assert.match(ctx, /Pillar-0/);
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
