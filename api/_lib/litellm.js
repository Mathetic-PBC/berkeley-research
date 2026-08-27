"use strict";

const { litellmConfig } = require("./config");

class LiteLLMError extends Error {
  constructor(message, statusCode = 502, detail = "") {
    super(message);
    this.name = "LiteLLMError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

async function request(path, options = {}) {
  const config = litellmConfig(options.env || process.env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method: options.method || "POST",
    headers: {
      Authorization: `Bearer ${config.masterKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  if (!response.ok) {
    const detail = typeof value === "object" && value
      ? String(value.detail || value.error || value.message || "")
      : String(value || "");
    throw new LiteLLMError("LiteLLM rejected the request", response.status, detail.slice(0, 300));
  }
  return value;
}

// Hardcoding this to null was what made an exhausted key a permanent one:
// LiteLLM only resets a key's spend on a `budget_duration` cycle, so without
// one the ledger only ever climbs and the sole way back is an administrator
// editing spend by hand. It is still null unless LITELLM_BUDGET_DURATION says
// otherwise -- a recurring allowance is a different promise from a fixed pot,
// and the pool's arithmetic has to be chosen, not inherited from a default.
function cycle(options = {}) {
  return litellmConfig(options.env || process.env).budgetDuration;
}

// LiteLLM enforces the user's budget and the key's budget independently, and
// spends against the lower of the two. A user cap set once at sign-up and
// never touched again is therefore its own way to run out: raising a member's
// key budget leaves them stopped at whatever their first allocation was, with
// nothing in the key's own numbers to explain it.
function updateUser(user, policy, options = {}) {
  return request("/user/update", {
    ...options,
    body: {
      user_id: user.id,
      max_budget: Number(policy.budgetUsd),
      budget_duration: cycle(options),
    },
  });
}

async function ensureUser(user, policy, options = {}) {
  try {
    return await request("/user/new", {
      ...options,
      body: {
        user_id: user.id,
        user_email: user.email,
        user_alias: user.email || user.id,
        user_role: "internal_user",
        max_budget: Number(policy.budgetUsd),
        budget_duration: cycle(options),
        auto_create_key: false,
      },
    });
  } catch (error) {
    if (error instanceof LiteLLMError && [400, 409].includes(error.statusCode)
        && /exist|duplicate|already/i.test(error.detail)) {
      // Already there from an earlier allocation, and carrying that
      // allocation's cap. Bringing it up to the current policy is the
      // difference between a re-provision that works and one that mints a key
      // the user record will not let anyone spend.
      return updateUser(user, policy, options);
    }
    throw error;
  }
}

async function generateKey(user, policy, options = {}) {
  await ensureUser(user, policy, options);
  const body = {
    user_id: user.id,
    key_alias: `engelbart:${user.id}`,
    models: policy.models,
    max_budget: Number(policy.budgetUsd),
    budget_duration: cycle(options),
    metadata: { product: "engelbart", supabase_user_id: user.id },
    key_type: "llm_api",
  };
  if (policy.rpmLimit) body.rpm_limit = Number(policy.rpmLimit);
  if (policy.tpmLimit) body.tpm_limit = Number(policy.tpmLimit);
  const value = await request("/key/generate", { ...options, body });
  const key = String(value && (value.key || value.token) || "");
  if (!key.startsWith("sk-")) throw new LiteLLMError("LiteLLM generated no usable key");
  return key;
}

function updateKey(key, policy, options = {}) {
  const body = {
    key,
    models: policy.models,
    max_budget: Number(policy.budgetUsd),
    budget_duration: cycle(options),
    rpm_limit: policy.rpmLimit ? Number(policy.rpmLimit) : null,
    tpm_limit: policy.tpmLimit ? Number(policy.tpmLimit) : null,
  };
  return request("/key/update", { ...options, body });
}

function setBlocked(key, blocked, options = {}) {
  return request(blocked ? "/key/block" : "/key/unblock", {
    ...options,
    body: { key },
  });
}

async function keyInfo(key, options = {}) {
  const value = await request(`/key/info?key=${encodeURIComponent(key)}`, {
    ...options,
    method: "GET",
  });
  return value && (value.info || value) || {};
}

module.exports = {
  LiteLLMError,
  ensureUser,
  updateUser,
  generateKey,
  keyInfo,
  request,
  setBlocked,
  updateKey,
};
