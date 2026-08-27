"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ALL_PROXY_MODELS,
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

test("keys are never scoped to a model subset", () => {
  assert.deepEqual(ALL_PROXY_MODELS, ["all-proxy-models"], "LiteLLM's proxy-wide wildcard");
  assert.deepEqual(modelList(), ALL_PROXY_MODELS);
  assert.notEqual(modelList(), ALL_PROXY_MODELS, "callers must not mutate the frozen constant");
  assert.deepEqual(modelList(["openai/gpt-5"]), ALL_PROXY_MODELS, "request input is ignored");
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
    default_models: ["all-proxy-models"],
    default_rpm_limit: 30,
    default_tpm_limit: null,
  }), {
    budgetUsd: 25,
    models: ["all-proxy-models"],
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
    models: ["all-proxy-models"],
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
    p_models: ["all-proxy-models"],
    p_rpm_limit: 20,
    p_tpm_limit: null,
  });
});
