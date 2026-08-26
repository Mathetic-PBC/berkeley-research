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
        auto_create_key: false,
      },
    });
  } catch (error) {
    if (error instanceof LiteLLMError && [400, 409].includes(error.statusCode)
        && /exist|duplicate|already/i.test(error.detail)) return null;
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
    budget_duration: null,
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
    budget_duration: null,
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
  generateKey,
  keyInfo,
  request,
  setBlocked,
  updateKey,
};
