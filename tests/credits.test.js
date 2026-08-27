"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { encryptSecret } = require("../api/_lib/crypto");
const {
  ALL_PROXY_MODELS,
  claimAccount,
  credentialsFor,
  refreshSpend,
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

const PROXY_ENV = {
  ...SUPABASE_ENV,
  LITELLM_BASE_URL: "https://proxy.example.com",
  LITELLM_MASTER_KEY: "sk-master",
  ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
};

function readyRow(overrides = {}) {
  const secret = encryptSecret("sk-member-key", PROXY_ENV);
  return {
    user_id: "user-uuid",
    status: "ready",
    blocked: false,
    budget_usd: "25.00",
    spend_usd: "0.000000",
    synced_at: null,
    models: ["all-proxy-models"],
    rpm_limit: null,
    tpm_limit: null,
    key_ciphertext: secret.ciphertext,
    key_iv: secret.iv,
    key_tag: secret.tag,
    ...overrides,
  };
}

// Answers a Supabase select with `row` and a LiteLLM /key/info with `spend`,
// recording every call so a test can state which hops it expects.
function proxyAndDatabase(row, spend, options = {}) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init = {}) {
      calls.push(url);
      if (url.includes("/key/info")) {
        if (options.keyInfoFails) return { ok: false, status: 503, async text() { return "proxy down"; } };
        return { ok: true, status: 200, async text() { return JSON.stringify({ info: { spend }, spend }); } };
      }
      if (init.method === "PATCH") {
        const patch = JSON.parse(init.body);
        return { ok: true, status: 200, async text() { return JSON.stringify([{ ...row, ...patch }]); } };
      }
      return { ok: true, status: 200, async text() { return JSON.stringify([row]); } };
    },
  };
}

// A key scoped to named models 403s the moment Claude Code asks for anything
// else, and the names drift every time Anthropic ships a model. So no caller
// gets to choose a subset, not even an admin sending one deliberately.
test("credit policy never pins a key to named models", () => {
  assert.deepEqual(ALL_PROXY_MODELS, ["all-proxy-models"], "LiteLLM's proxy-wide wildcard");
  assert.deepEqual(modelList(), ALL_PROXY_MODELS);
  assert.notEqual(modelList(), ALL_PROXY_MODELS, "callers must not mutate the frozen constant");
  assert.deepEqual(modelList([]), ["all-proxy-models"]);
  assert.deepEqual(modelList(["claude-sonnet-4-6"]), ["all-proxy-models"]);
  assert.deepEqual(modelList(["openai/gpt-5"]), ["all-proxy-models"]);
  assert.notEqual(modelList(), modelList(), "each caller gets its own array to mutate");
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

// The stored figure only moves when someone presses sync, so a member reading
// their balance at sign-in would be told $25.00 of $25.00 left however much
// they had actually spent.
test("reading credentials refreshes the balance from the proxy", async () => {
  const row = readyRow();
  const scripted = proxyAndDatabase(row, 12.5);

  const result = await credentialsFor({ id: "user-uuid", email: "m@example.com" }, {
    env: PROXY_ENV,
    fetchImpl: scripted.fetchImpl,
  });

  assert.equal(result.spendUsd, 12.5);
  assert.equal(result.budgetUsd, 25);
  assert.equal(result.apiKey, "sk-member-key");
  assert.ok(scripted.calls.some((url) => url.includes("/key/info")), "asked the proxy");
});

// A proxy that cannot answer must not cost a member their key: the stored
// figure is stale, not wrong, and a login is a bad place to fail closed.
test("a proxy that will not answer leaves the credential intact", async () => {
  const row = readyRow({ spend_usd: "4.000000" });
  const scripted = proxyAndDatabase(row, 12.5, { keyInfoFails: true });

  const result = await credentialsFor({ id: "user-uuid", email: "m@example.com" }, {
    env: PROXY_ENV,
    fetchImpl: scripted.fetchImpl,
  });

  assert.equal(result.apiKey, "sk-member-key");
  assert.equal(result.spendUsd, 4);
});

test("refreshing writes the proxy's figure and stamps when it was read", async () => {
  const row = readyRow();
  const scripted = proxyAndDatabase(row, 7.25);

  const updated = await refreshSpend(row, { env: PROXY_ENV, fetchImpl: scripted.fetchImpl });

  assert.equal(Number(updated.spend_usd), 7.25);
  assert.notEqual(updated.synced_at, null);
});

// LiteLLM has been seen to report a negative figure after a refund; a balance
// over budget is a confusing thing to show and a worse thing to store.
test("a negative figure from the proxy is floored at zero", async () => {
  const row = readyRow();
  const scripted = proxyAndDatabase(row, -3);

  const updated = await refreshSpend(row, { env: PROXY_ENV, fetchImpl: scripted.fetchImpl });

  assert.equal(Number(updated.spend_usd), 0);
});

test("account claims send the invite to the atomic Supabase allocator", async () => {
  let request;
  const result = await claimAccount({ id: "user-uuid", email: "member@example.com" }, {
    env: SUPABASE_ENV,
    inviteCode: "EGB-A1B2-C3D4-E5F6-7788-9900",
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
  assert.deepEqual(request.body, {
    p_user_id: "user-uuid",
    p_email: "member@example.com",
    p_invite_code: "EGB-A1B2-C3D4-E5F6-7788-9900",
  });
  assert.equal(result.claimed, true);
  assert.equal(result.row.user_id, "user-uuid");
});

test("account claims fail closed when Supabase rejects missing credit entitlement", async () => {
  let request;
  await assert.rejects(
    claimAccount({ id: "legacy-user", email: "legacy@example.com" }, {
      env: SUPABASE_ENV,
      async fetchImpl(url, options) {
        request = { url, body: JSON.parse(options.body) };
        return {
          ok: false,
          status: 400,
          async text() {
            return JSON.stringify({
              message: "A valid Engelbart invite is required for Claude credits",
            });
          },
        };
      },
    }),
    (error) => error.statusCode === 403
      && /valid, unused Engelbart invite code/i.test(error.message),
  );
  assert.match(request.url, /rpc\/engelbart_claim_credit_account$/);
  assert.equal(request.body.p_invite_code, null);
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
