"use strict";

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) {
    const error = new Error(`Missing server configuration: ${name}`);
    error.statusCode = 503;
    throw error;
  }
  return value;
}

function httpsOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
}

function supabaseConfig(env = process.env) {
  return {
    url: httpsOrigin(required(env, "SUPABASE_URL"), "SUPABASE_URL"),
    anonKey: required(env, "SUPABASE_ANON_KEY"),
    serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function encryptionKey(env = process.env) {
  const encoded = required(env, "ENGELBART_CREDENTIAL_KEY");
  let key;
  try { key = Buffer.from(encoded, "base64url"); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) {
    const error = new Error("ENGELBART_CREDENTIAL_KEY must be 32 base64url-encoded bytes");
    error.statusCode = 503;
    throw error;
  }
  return key;
}

function adminSessionSecret(env = process.env) {
  const value = required(env, "ENGELBART_ADMIN_SESSION_SECRET");
  if (Buffer.byteLength(value) < 32) {
    const error = new Error("ENGELBART_ADMIN_SESSION_SECRET must contain at least 32 bytes");
    error.statusCode = 503;
    throw error;
  }
  return value;
}

// LiteLLM's own duration grammar for `budget_duration` (30s, 30m, 24h, 30d,
// 1mo). Anything else is silently ignored by the proxy, which would leave a
// pool that looks like it recycles and does not.
const BUDGET_DURATION = /^[1-9][0-9]*(s|m|h|d|mo)$/;

// Unset by default, and deliberately so. A duration here turns each member's
// budget from a fixed pot into a recurring allowance: LiteLLM resets their
// spend every cycle, which is what stops an exhausted key needing a hand to
// come back, but it also means the pool can pay out its allocated total once
// per cycle rather than once. Set it only with that arithmetic in mind.
function budgetDuration(env = process.env) {
  const value = String(env.LITELLM_BUDGET_DURATION || "").trim();
  if (!value) return null;
  if (!BUDGET_DURATION.test(value)) {
    const error = new Error("LITELLM_BUDGET_DURATION must look like 30d, 24h, or 1mo");
    error.statusCode = 503;
    throw error;
  }
  return value;
}

function litellmConfig(env = process.env) {
  return {
    baseUrl: httpsOrigin(required(env, "LITELLM_BASE_URL"), "LITELLM_BASE_URL"),
    masterKey: required(env, "LITELLM_MASTER_KEY"),
    budgetDuration: budgetDuration(env),
  };
}

module.exports = {
  adminSessionSecret,
  budgetDuration,
  encryptionKey,
  httpsOrigin,
  litellmConfig,
  required,
  supabaseConfig,
};
