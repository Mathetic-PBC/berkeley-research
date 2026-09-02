"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/engelbart-onboarding");

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };

// The dispatcher is exercised with an injected record module so the handler's
// own job -- naming actions, loading the row, gating on credit -- is what the
// test sees.
function deps(overrides = {}) {
  const row = { id: "row-1", user_id: USER.id, status: "open", step: 0, analysis_status: "none", ...overrides.row };
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

// Reading the state of an analysis costs nothing, so it must not be priced
// like a model call: a member whose key is spent still has to be able to see
// that the paper was read, and how it went.
test("polling the analysis never touches the credit key; a retry does", async () => {
  const refuse = async () => { throw new Error("credentialsFor must not be called for a poll"); };
  const poll = await handler.dispatch(USER, { action: "analysis" }, deps({ credentialsFor: refuse }));
  assert.equal(poll.analysis_status, "none");
  await assert.rejects(handler.dispatch(USER, { action: "analysis", retry: true }, deps({
    credentialsFor: async () => ({ status: "exhausted" }) })), (e) => e.statusCode === 409);
});

// The row a spent key must never hide: the setup is finished, the pairing code
// is in it, and the page's whole job at that point is to show it.
test("a finished setup opens on a spent key and the meter says why", async () => {
  const out = await handler.dispatch(USER, { action: "open" }, deps({
    row: { status: "created", pending_setup_id: "p" },
    credentialsFor: async () => ({ status: "exhausted", budgetUsd: 25, spendUsd: 25 }) }));
  assert.equal(out.onboarding.status, "created");
  assert.deepEqual(out.credit, { status: "exhausted", budgetUsd: 25, spendUsd: 25 });
});

test("a key that will not resolve at all still opens a finished setup", async () => {
  const broken = async () => { const e = new Error("Credits are not ready"); e.statusCode = 409; throw e; };
  const out = await handler.dispatch(USER, { action: "open" }, deps({
    row: { status: "created" }, credentialsFor: broken }));
  assert.equal(out.onboarding.status, "created");
  assert.equal(out.credit.status, "unavailable");
  // An unfinished one still stops: there is nothing to show and no way to work.
  await assert.rejects(handler.dispatch(USER, { action: "open" }, deps({ credentialsFor: broken })),
    (e) => e.statusCode === 409);
});

test("a GET is a 405 that names the one method it allows", async () => {
  const headers = {};
  let status = 0;
  let payload = null;
  const res = {
    setHeader(key, value) { headers[key] = value; },
    status(code) { status = code; return this; },
    json(value) { payload = value; return this; },
  };
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(status, 405);
  assert.equal(headers.Allow, "POST");
  assert.equal(payload.error, "Method not allowed");
});
