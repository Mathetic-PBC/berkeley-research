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

function litellmConfig(env = process.env) {
  return {
    baseUrl: httpsOrigin(required(env, "LITELLM_BASE_URL"), "LITELLM_BASE_URL"),
    masterKey: required(env, "LITELLM_MASTER_KEY"),
  };
}

module.exports = {
  adminSessionSecret,
  encryptionKey,
  httpsOrigin,
  litellmConfig,
  required,
  supabaseConfig,
};
