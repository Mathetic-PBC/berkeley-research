"use strict";

const { decryptSecret, encryptSecret } = require("./crypto");
const { litellmConfig } = require("./config");
const LiteLLM = require("./litellm");
const { patchRows, rpc, selectOne, selectRows } = require("./supabase");

// LiteLLM's wildcard for "everything this proxy serves" (SpecialModelNames in
// litellm/proxy/_types.py). Members get a plain API key, so the line-up is
// never pinned here and never drifts when the proxy adds a model.
const ALL_PROXY_MODELS = Object.freeze(["all-proxy-models"]);

function positiveMoney(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1000) {
    const error = new Error(`${name} must be between $0.01 and $1,000`);
    error.statusCode = 400;
    throw error;
  }
  return Math.round(number * 100) / 100;
}

function optionalLimit(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 10_000_000) {
    const error = new Error(`${name} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

// Keys are never scoped to a model subset, so this ignores any caller input.
// Validating a chosen list would only let an admin re-pin what this change
// exists to unpin.
function modelList() {
  return ALL_PROXY_MODELS.slice();
}

function policyFromRow(row) {
  return {
    budgetUsd: Number(row.budget_usd ?? row.default_budget_usd),
    models: row.models || row.default_models,
    rpmLimit: row.rpm_limit ?? row.default_rpm_limit ?? null,
    tpmLimit: row.tpm_limit ?? row.default_tpm_limit ?? null,
  };
}

async function settings(options = {}) {
  const row = await selectOne("engelbart_credit_settings", "singleton=eq.true&select=*", options);
  if (!row) {
    const error = new Error("Credit settings are not initialized");
    error.statusCode = 503;
    throw error;
  }
  return row;
}

async function allocatedBudget(options = {}, excludingUserId = "") {
  const rows = await selectRows(
    "engelbart_credit_accounts",
    "status=neq.error&select=user_id,budget_usd",
    options,
  );
  return rows.reduce((sum, row) => row.user_id === excludingUserId
    ? sum : sum + Number(row.budget_usd || 0), 0);
}

async function assertPoolCapacity(budgetUsd, options = {}, excludingUserId = "") {
  const current = await settings(options);
  const allocated = await allocatedBudget(options, excludingUserId);
  if (allocated + Number(budgetUsd) > Number(current.pool_budget_usd) + 0.0001) {
    const error = new Error("The configured credit pool is fully allocated");
    error.statusCode = 409;
    throw error;
  }
}

async function claimAccount(user, options = {}) {
  try {
    const result = await rpc("engelbart_claim_credit_account", {
      p_user_id: user.id,
      p_email: user.email,
    }, options);
    const value = Array.isArray(result) ? result[0] : result;
    if (!value || !value.account) throw new Error("Supabase returned no credit account claim");
    return { row: value.account, claimed: Boolean(value.claimed) };
  } catch (error) {
    if (/credit pool is fully allocated/i.test(String(error.detail || error.message))) {
      error.message = "The configured credit pool is fully allocated";
      error.statusCode = 409;
    }
    throw error;
  }
}

function encryptedKey(row, env = process.env) {
  return decryptSecret({
    ciphertext: row.key_ciphertext,
    iv: row.key_iv,
    tag: row.key_tag,
  }, env);
}

async function provision(user, options = {}) {
  const claim = await claimAccount(user, options);
  if (!claim.row) throw new Error("Could not claim a credit account");
  if (!claim.claimed) {
    if (claim.row.status === "ready") return claim.row;
    const error = new Error(claim.row.status === "error"
      ? "Credit provisioning needs an administrator to retry it"
      : "Credit provisioning is already in progress");
    error.statusCode = 409;
    throw error;
  }

  const policy = policyFromRow(claim.row);
  try {
    const key = await LiteLLM.generateKey(user, policy, options);
    const encrypted = encryptSecret(key, options.env);
    const rows = await patchRows(
      "engelbart_credit_accounts",
      `user_id=eq.${encodeURIComponent(user.id)}&provision_nonce=eq.${claim.row.provision_nonce}`,
      {
        key_ciphertext: encrypted.ciphertext,
        key_iv: encrypted.iv,
        key_tag: encrypted.tag,
        status: "ready",
        error_message: null,
        provisioned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      options,
    );
    if (!Array.isArray(rows) || !rows.length) throw new Error("Provisioning ownership was lost");
    return rows[0];
  } catch (error) {
    await patchRows(
      "engelbart_credit_accounts",
      `user_id=eq.${encodeURIComponent(user.id)}&provision_nonce=eq.${claim.row.provision_nonce}`,
      {
        status: "error",
        error_message: String(error.detail || error.message || "Provisioning failed").slice(0, 300),
        updated_at: new Date().toISOString(),
      },
      options,
    ).catch(() => {});
    throw error;
  }
}

async function credentialsFor(user, options = {}) {
  let row = await selectOne(
    "engelbart_credit_accounts",
    `user_id=eq.${encodeURIComponent(user.id)}&select=*`,
    options,
  );
  if (!row) row = await provision(user, options);
  if (row.status !== "ready" || row.blocked) {
    const error = new Error(row.blocked ? "This Engelbart credit key is paused" : "Credits are not ready");
    error.statusCode = 409;
    throw error;
  }
  // The balance a member is about to be shown, so it is read from the proxy
  // rather than from whenever an admin last pressed sync. A proxy that cannot
  // answer must not cost them their key: the stored figure is stale, not
  // wrong, and refusing the whole credential over it would be worse.
  try {
    row = await refreshSpend(row, options);
  } catch (error) { /* keep the stored figure */ }

  return {
    apiKey: encryptedKey(row, options.env),
    baseUrl: litellmConfig(options.env || process.env).baseUrl,
    budgetUsd: Number(row.budget_usd),
    spendUsd: Number(row.spend_usd),
    models: row.models,
    rpmLimit: row.rpm_limit,
    tpmLimit: row.tpm_limit,
  };
}

async function updateDefaults(input, options = {}) {
  const values = {
    pool_budget_usd: positiveMoney(input.poolBudgetUsd, "Pool budget"),
    default_budget_usd: positiveMoney(input.defaultBudgetUsd, "Default user budget"),
    default_models: modelList(),
    default_rpm_limit: optionalLimit(input.defaultRpmLimit, "Default RPM limit"),
    default_tpm_limit: optionalLimit(input.defaultTpmLimit, "Default TPM limit"),
    updated_at: new Date().toISOString(),
  };
  if (values.default_budget_usd > values.pool_budget_usd) {
    const error = new Error("Default user budget cannot exceed the pool budget");
    error.statusCode = 400;
    throw error;
  }
  try {
    return await rpc("engelbart_update_credit_settings", {
      p_pool_budget_usd: values.pool_budget_usd,
      p_default_budget_usd: values.default_budget_usd,
      p_default_models: values.default_models,
      p_default_rpm_limit: values.default_rpm_limit,
      p_default_tpm_limit: values.default_tpm_limit,
    }, options);
  } catch (error) {
    if (/pool cannot be lower/i.test(String(error.detail || error.message))) {
      error.message = "Pool budget cannot be lower than the amount already allocated";
      error.statusCode = 409;
    }
    throw error;
  }
}

async function updateStoredPolicy(userId, policy, options = {}) {
  try {
    const value = await rpc("engelbart_update_account_policy", {
      p_user_id: userId,
      p_budget_usd: policy.budgetUsd,
      p_models: policy.models,
      p_rpm_limit: policy.rpmLimit,
      p_tpm_limit: policy.tpmLimit,
    }, options);
    return Array.isArray(value) ? value[0] : value;
  } catch (error) {
    if (/credit pool is fully allocated/i.test(String(error.detail || error.message))) {
      error.message = "The configured credit pool is fully allocated";
      error.statusCode = 409;
    }
    throw error;
  }
}

async function updateAccount(userId, input, options = {}) {
  const row = await selectOne(
    "engelbart_credit_accounts",
    `user_id=eq.${encodeURIComponent(userId)}&select=*`,
    options,
  );
  if (!row || row.status !== "ready") {
    const error = new Error("Credit account is not ready");
    error.statusCode = 404;
    throw error;
  }
  const policy = {
    budgetUsd: positiveMoney(input.budgetUsd, "User budget"),
    models: modelList(),
    rpmLimit: optionalLimit(input.rpmLimit, "RPM limit"),
    tpmLimit: optionalLimit(input.tpmLimit, "TPM limit"),
  };
  const oldPolicy = policyFromRow(row);
  const key = encryptedKey(row, options.env);
  const increasing = policy.budgetUsd > oldPolicy.budgetUsd;
  if (increasing) {
    const updated = await updateStoredPolicy(userId, policy, options);
    try {
      await LiteLLM.updateKey(key, policy, options);
    } catch (error) {
      await updateStoredPolicy(userId, oldPolicy, options).catch(() => {});
      throw error;
    }
    return updated;
  } else {
    await LiteLLM.updateKey(key, policy, options);
    try {
      return await updateStoredPolicy(userId, policy, options);
    } catch (error) {
      await LiteLLM.updateKey(key, oldPolicy, options).catch(() => {});
      throw error;
    }
  }
}

async function blockAccount(userId, blocked, options = {}) {
  const row = await selectOne(
    "engelbart_credit_accounts",
    `user_id=eq.${encodeURIComponent(userId)}&select=*`,
    options,
  );
  if (!row || row.status !== "ready") {
    const error = new Error("Credit account is not ready");
    error.statusCode = 404;
    throw error;
  }
  await LiteLLM.setBlocked(encryptedKey(row, options.env), Boolean(blocked), options);
  const rows = await patchRows(
    "engelbart_credit_accounts",
    `user_id=eq.${encodeURIComponent(userId)}`,
    { blocked: Boolean(blocked), updated_at: new Date().toISOString() },
    options,
  );
  return rows[0];
}

// LiteLLM meters every request and enforces the budget; this row is only a
// mirror of that ledger. Anything that shows a member their balance has to
// refresh it first, or the number stands still while the money runs out.
async function refreshSpend(row, options = {}) {
  const info = await LiteLLM.keyInfo(encryptedKey(row, options.env), options);
  const spend = Math.max(0, Number(info.spend || 0));
  const now = new Date().toISOString();
  const rows = await patchRows(
    "engelbart_credit_accounts",
    `user_id=eq.${encodeURIComponent(row.user_id)}`,
    { spend_usd: spend, synced_at: now, updated_at: now },
    options,
  );
  return rows[0] || { ...row, spend_usd: spend, synced_at: now };
}

async function syncAccount(userId, options = {}) {
  const row = await selectOne(
    "engelbart_credit_accounts",
    `user_id=eq.${encodeURIComponent(userId)}&select=*`,
    options,
  );
  if (!row || row.status !== "ready") {
    const error = new Error("Credit account is not ready");
    error.statusCode = 404;
    throw error;
  }
  return refreshSpend(row, options);
}

async function adminState(options = {}) {
  const [configuration, accounts] = await Promise.all([
    settings(options),
    selectRows(
      "engelbart_credit_accounts",
      "select=user_id,email,budget_usd,rpm_limit,tpm_limit,spend_usd,blocked,status,error_message,provisioned_at,synced_at,created_at&order=created_at.desc",
      options,
    ),
  ]);
  const allocated = accounts.filter((row) => row.status !== "error")
    .reduce((sum, row) => sum + Number(row.budget_usd || 0), 0);
  return {
    settings: {
      poolBudgetUsd: Number(configuration.pool_budget_usd),
      defaultBudgetUsd: Number(configuration.default_budget_usd),
      defaultRpmLimit: configuration.default_rpm_limit,
      defaultTpmLimit: configuration.default_tpm_limit,
      allocatedBudgetUsd: allocated,
    },
    accounts: accounts.map((row) => ({
      userId: row.user_id,
      email: row.email,
      budgetUsd: Number(row.budget_usd),
      rpmLimit: row.rpm_limit,
      tpmLimit: row.tpm_limit,
      spendUsd: Number(row.spend_usd),
      blocked: row.blocked,
      status: row.status,
      error: row.error_message || "",
      provisionedAt: row.provisioned_at,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
    })),
  };
}

module.exports = {
  ALL_PROXY_MODELS,
  adminState,
  allocatedBudget,
  blockAccount,
  claimAccount,
  credentialsFor,
  encryptedKey,
  modelList,
  optionalLimit,
  policyFromRow,
  positiveMoney,
  provision,
  refreshSpend,
  settings,
  syncAccount,
  updateAccount,
  updateDefaults,
  updateStoredPolicy,
};
