"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/engelbart-onboarding");

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };

// The dispatcher is exercised with an injected record module so the handler's
// own job -- naming actions, loading the row, gating on credit -- is what the
// test sees.
function deps(overrides = {}) {
  const row = { id: "row-1", user_id: USER.id, status: "open", step: 0, analysis_status: "none" };
  return {
    credentialsFor: async () => ({ status: "active", apiKey: "k", baseUrl: "https://p", models: [], budgetUsd: 25, spendUsd: 1 }),
    ...overrides,
    // Last, so an override names ONE record function and keeps the rest: the
    // handler loads the row through `open` before every other action.
    OB: {
      open: async () => ({ onboarding: row, calibrations: [] }),
      step: async (u, r, b) => ({ onboarding: { ...r, step: b.step } }),
      sources: async () => ({ analysis_status: "done" }),
      analysis: async () => ({ analysis_status: "none" }),
      answer: async () => ({ graded_level: 50 }),
      details: async () => ({ intro: "", questions: [] }),
      goals: async () => ({ goals: [] }),
      todos: async () => ({ todos: [], name: "" }),
      ask: async () => ({ answer: "a" }),
      create: async () => ({ ok: true, pending_setup_id: "p" }),
      ...overrides.OB,
    },
  };
}

test("open returns the row, the calibrations and the credit meter", async () => {
  const out = await handler.dispatch(USER, { action: "open" }, deps());
  assert.equal(out.onboarding.id, "row-1");
  assert.deepEqual(out.credit, { status: "active", budgetUsd: 25, spendUsd: 1 });
  assert.equal(out.apiKey, undefined);
});

test("a spent key stops the flow at open with the credit wording", async () => {
  await assert.rejects(handler.dispatch(USER, { action: "open" }, deps({
    credentialsFor: async () => ({ status: "exhausted" }) })), (e) => e.statusCode === 409 && /credit/i.test(e.message));
});

test("model actions receive the member's credentials; step does not need them", async () => {
  let seen = null;
  const d = deps({ OB: { details: async (u, r, c, b, credentials) => { seen = credentials; return { intro: "", questions: [] }; } },
    credentialsFor: async () => ({ status: "active", apiKey: "member", baseUrl: "https://p", models: [] }) });
  await handler.dispatch(USER, { action: "details" }, d);
  assert.equal(seen.apiKey, "member");
  let asked = 0;
  await handler.dispatch(USER, { action: "step", step: 2, fields: {} }, deps({ credentialsFor: async () => { asked += 1; return { status: "active" }; } }));
  assert.equal(asked, 0);
});

test("an unknown action is a 400", async () => {
  await assert.rejects(handler.dispatch(USER, { action: "dance" }, deps()), (e) => e.statusCode === 400);
});
