"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const LiteLLM = require("../api/_lib/litellm");

const ENV = {
  LITELLM_BASE_URL: "https://proxy.example.com/",
  LITELLM_MASTER_KEY: "sk-admin-only",
};

test("provisions one non-admin LiteLLM user and one inference-only key", async () => {
  const calls = [];
  async function fetchImpl(url, options) {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return url.endsWith("/key/generate") ? JSON.stringify({ key: "sk-user-key" }) : "{}";
      },
    };
  }
  const policy = {
    budgetUsd: 25,
    models: ["claude-sonnet-4-6"],
    rpmLimit: 30,
    tpmLimit: 100000,
  };
  const key = await LiteLLM.generateKey(
    { id: "supabase-uuid", email: "member@example.com" },
    policy,
    { env: ENV, fetchImpl },
  );
  assert.equal(key, "sk-user-key");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, {
    user_id: "supabase-uuid",
    user_email: "member@example.com",
    user_alias: "member@example.com",
    user_role: "internal_user",
    max_budget: 25,
    auto_create_key: false,
  });
  assert.equal(calls[1].body.user_id, "supabase-uuid");
  assert.equal(calls[1].body.key_type, "llm_api");
  assert.equal(calls[1].body.max_budget, 25);
  assert.deepEqual(calls[1].body.models, ["claude-sonnet-4-6"]);
  assert.equal(calls[1].body.rpm_limit, 30);
  assert.equal(calls[1].body.tpm_limit, 100000);
  assert.equal(calls[1].options.headers.Authorization, "Bearer sk-admin-only");
});
