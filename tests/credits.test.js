"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AVAILABLE_MODELS,
  claimAccount,
  modelList,
  optionalLimit,
  policyFromRow,
  positiveMoney,
  updateStoredPolicy,
} = require("../api/_lib/credits");

const SUPABASE_ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

test("credit policy admits only explicit Claude models", () => {
  assert.deepEqual(modelList(["claude-sonnet-4-6", "claude-sonnet-4-6"]), ["claude-sonnet-4-6"]);
  assert.throws(() => modelList([]), /at least one/);
  assert.throws(() => modelList(["openai/gpt-5"]), /supported Claude/);
  assert.deepEqual(AVAILABLE_MODELS, [
    "claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5",
  ]);
});

test("budgets and rate limits fail closed outside bounded values", () => {
  assert.equal(positiveMoney("25.009", "Budget"), 25.01);
  assert.throws(() => positiveMoney(0, "Budget"), /between/);
  assert.throws(() => positiveMoney(1001, "Budget"), /between/);
  assert.equal(optionalLimit("", "RPM"), null);
  assert.equal(optionalLimit("60", "RPM"), 60);
  assert.throws(() => optionalLimit("1.5", "RPM"), /positive integer/);
});

test("new accounts inherit the global policy exactly once", () => {
  assert.deepEqual(policyFromRow({
    default_budget_usd: "25.00",
    default_models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    default_rpm_limit: 30,
    default_tpm_limit: null,
  }), {
    budgetUsd: 25,
    models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    rpmLimit: 30,
    tpmLimit: null,
  });
});

test("account claims use the atomic Supabase pool allocator", async () => {
  let request;
  const result = await claimAccount({ id: "user-uuid", email: "member@example.com" }, {
    env: SUPABASE_ENV,
    async fetchImpl(url, options) {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            claimed: true,
            account: { user_id: "user-uuid", status: "provisioning" },
          });
        },
      };
    },
  });
  assert.equal(request.url, "https://project.supabase.co/rest/v1/rpc/engelbart_claim_credit_account");
  assert.equal(request.options.headers.Authorization, "Bearer service-role");
  assert.deepEqual(request.body, { p_user_id: "user-uuid", p_email: "member@example.com" });
  assert.equal(result.claimed, true);
  assert.equal(result.row.user_id, "user-uuid");
});

test("admin policy changes cross the atomic Supabase pool allocator", async () => {
  let request;
  const policy = {
    budgetUsd: 40,
    models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    rpmLimit: 20,
    tpmLimit: null,
  };
  await updateStoredPolicy("user-uuid", policy, {
    env: SUPABASE_ENV,
    async fetchImpl(url, options) {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ user_id: "user-uuid", budget_usd: 40 }); },
      };
    },
  });
  assert.match(request.url, /rpc\/engelbart_update_account_policy$/);
  assert.deepEqual(request.body, {
    p_user_id: "user-uuid",
    p_budget_usd: 40,
    p_models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    p_rpm_limit: 20,
    p_tpm_limit: null,
  });
});
