"use strict";

const crypto = require("node:crypto");
const { adminSessionSecret } = require("./config");
const {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  verifyPassword,
  verifyTotp,
} = require("./crypto");
const { parseCookies } = require("./http");
const { patchRows, rpc, selectOne } = require("./supabase");

const COOKIE_NAME = "engelbart_admin";
const SESSION_SECONDS = 8 * 60 * 60;

async function readAdminConfig(options = {}) {
  const row = await selectOne(
    "engelbart_admin_config",
    "singleton=eq.true&select=*",
    options,
  );
  if (!row) {
    const error = new Error("Admin configuration is not initialized");
    error.statusCode = 503;
    throw error;
  }
  return row;
}

function signature(payload, env = process.env) {
  return crypto.createHmac("sha256", adminSessionSecret(env)).update(payload).digest("base64url");
}

function createSession(generation, options = {}) {
  const now = Number(options.now || Date.now());
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    generation: Number(generation),
    expiresAt: Math.floor(now / 1000) + SESSION_SECONDS,
  })).toString("base64url");
  return `${payload}.${signature(payload, options.env)}`;
}

function parseSession(token, options = {}) {
  const [payload, received, extra] = String(token || "").split(".");
  if (!payload || !received || extra) return null;
  const expected = Buffer.from(signature(payload, options.env));
  const actual = Buffer.from(received);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let value;
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const now = Math.floor(Number(options.now || Date.now()) / 1000);
  if (value.v !== 1 || !Number.isInteger(value.generation) || Number(value.expiresAt) <= now) return null;
  return value;
}

function totpUri(secret) {
  return `otpauth://totp/${encodeURIComponent("Mathetic:Engelbart Admin")}`
    + `?secret=${secret}&issuer=${encodeURIComponent("Mathetic")}&digits=6&period=30`;
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function requireAdmin(req, options = {}) {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = parseSession(token, options);
  if (!session) {
    const error = new Error("Admin authentication required");
    error.statusCode = 401;
    throw error;
  }
  const config = await readAdminConfig(options);
  if (Number(config.session_generation) !== session.generation) {
    const error = new Error("Admin session has expired");
    error.statusCode = 401;
    throw error;
  }
  return { session, config };
}

async function login(password, totp, options = {}) {
  const config = await readAdminConfig(options);
  if (!verifyPassword(password, config.password_hash)) {
    const error = new Error("Admin code is incorrect");
    error.statusCode = 401;
    throw error;
  }
  let generation = Number(config.session_generation);
  let recoveryCodeUsed = false;
  let recoveryCodesRemaining = Array.isArray(config.recovery_code_hashes)
    ? config.recovery_code_hashes.length
    : 0;
  if (config.totp_enabled) {
    if (!totp) return { mfaRequired: true };
    const secret = decryptSecret({
      ciphertext: config.totp_secret_ciphertext,
      iv: config.totp_secret_iv,
      tag: config.totp_secret_tag,
    }, options.env);
    if (!verifyTotp(secret, totp, options.now)) {
      const result = await rpc("engelbart_consume_admin_recovery_code", {
        p_code_hash: hashRecoveryCode(totp),
      }, options);
      const consumed = Array.isArray(result) ? result[0] : result;
      if (!consumed || !consumed.consumed) {
        const error = new Error("Authenticator or recovery code is incorrect");
        error.statusCode = 401;
        throw error;
      }
      generation = Number(consumed.session_generation);
      recoveryCodeUsed = true;
      recoveryCodesRemaining = Number(consumed.remaining);
    }
  }
  return {
    mfaRequired: false,
    mfaEnabled: Boolean(config.totp_enabled),
    recoveryCodeUsed,
    recoveryCodesRemaining,
    token: createSession(generation, options),
  };
}

async function resetPassword(newPassword, options = {}) {
  const config = await readAdminConfig(options);
  const generation = Number(config.session_generation) + 1;
  const rows = await patchRows(
    "engelbart_admin_config",
    "singleton=eq.true",
    {
      password_hash: hashPassword(newPassword),
      session_generation: generation,
      updated_at: new Date(Number(options.now || Date.now())).toISOString(),
    },
    options,
  );
  if (!Array.isArray(rows) || !rows.length) throw new Error("Admin password was not updated");
  return createSession(generation, options);
}

async function beginMfa(options = {}) {
  const config = await readAdminConfig(options);
  if (config.totp_enabled) {
    const error = new Error("MFA is already enabled; disable it before enrolling a replacement");
    error.statusCode = 409;
    throw error;
  }
  const secret = newTotpSecret();
  const encrypted = encryptSecret(secret, options.env);
  const expiresAt = new Date(Number(options.now || Date.now()) + 10 * 60 * 1000).toISOString();
  await patchRows("engelbart_admin_config", "singleton=eq.true", {
    totp_secret_ciphertext: encrypted.ciphertext,
    totp_secret_iv: encrypted.iv,
    totp_secret_tag: encrypted.tag,
    totp_pending_until: expiresAt,
    totp_enabled: false,
    updated_at: new Date(Number(options.now || Date.now())).toISOString(),
  }, options);
  return { secret, uri: totpUri(secret), expiresAt };
}

async function addAuthenticator(password, code, options = {}) {
  const config = await readAdminConfig(options);
  if (!verifyPassword(password, config.password_hash)) {
    const error = new Error("Admin password is incorrect");
    error.statusCode = 401;
    throw error;
  }
  if (!config.totp_enabled) {
    const error = new Error("Enable two-factor authentication first");
    error.statusCode = 409;
    throw error;
  }
  const secret = decryptSecret({
    ciphertext: config.totp_secret_ciphertext,
    iv: config.totp_secret_iv,
    tag: config.totp_secret_tag,
  }, options.env);
  if (!verifyTotp(secret, code, options.now)) {
    const error = new Error("Authenticator code is incorrect");
    error.statusCode = 401;
    throw error;
  }
  return { secret, uri: totpUri(secret) };
}

async function verifyMfa(code, options = {}) {
  const config = await readAdminConfig(options);
  const pendingUntil = Date.parse(config.totp_pending_until || "");
  if (!Number.isFinite(pendingUntil) || pendingUntil < Number(options.now || Date.now())) {
    const error = new Error("MFA enrollment expired; start again");
    error.statusCode = 400;
    throw error;
  }
  const secret = decryptSecret({
    ciphertext: config.totp_secret_ciphertext,
    iv: config.totp_secret_iv,
    tag: config.totp_secret_tag,
  }, options.env);
  if (!verifyTotp(secret, code, options.now)) {
    const error = new Error("Authenticator code is incorrect");
    error.statusCode = 400;
    throw error;
  }
  const generation = Number(config.session_generation) + 1;
  const recoveryCodes = newRecoveryCodes();
  await patchRows("engelbart_admin_config", "singleton=eq.true", {
    totp_enabled: true,
    totp_pending_until: null,
    recovery_code_hashes: recoveryCodes.map(hashRecoveryCode),
    session_generation: generation,
    updated_at: new Date(Number(options.now || Date.now())).toISOString(),
  }, options);
  return { token: createSession(generation, options), recoveryCodes };
}

async function regenerateRecoveryCodes(password, code, options = {}) {
  const config = await readAdminConfig(options);
  if (!verifyPassword(password, config.password_hash)) {
    const error = new Error("Admin password is incorrect");
    error.statusCode = 401;
    throw error;
  }
  if (!config.totp_enabled) {
    const error = new Error("Enable two-factor authentication first");
    error.statusCode = 409;
    throw error;
  }
  const secret = decryptSecret({
    ciphertext: config.totp_secret_ciphertext,
    iv: config.totp_secret_iv,
    tag: config.totp_secret_tag,
  }, options.env);
  if (!verifyTotp(secret, code, options.now)) {
    const error = new Error("Authenticator code is incorrect");
    error.statusCode = 401;
    throw error;
  }
  const generation = Number(config.session_generation) + 1;
  const recoveryCodes = newRecoveryCodes();
  await patchRows("engelbart_admin_config", "singleton=eq.true", {
    recovery_code_hashes: recoveryCodes.map(hashRecoveryCode),
    session_generation: generation,
    updated_at: new Date(Number(options.now || Date.now())).toISOString(),
  }, options);
  return { token: createSession(generation, options), recoveryCodes };
}

async function disableMfa(password, code, options = {}) {
  const config = await readAdminConfig(options);
  if (!verifyPassword(password, config.password_hash)) {
    const error = new Error("Admin password is incorrect");
    error.statusCode = 401;
    throw error;
  }
  if (config.totp_enabled) {
    const secret = decryptSecret({
      ciphertext: config.totp_secret_ciphertext,
      iv: config.totp_secret_iv,
      tag: config.totp_secret_tag,
    }, options.env);
    if (!verifyTotp(secret, code, options.now)) {
      const error = new Error("Authenticator code is incorrect");
      error.statusCode = 401;
      throw error;
    }
  }
  const generation = Number(config.session_generation) + 1;
  await patchRows("engelbart_admin_config", "singleton=eq.true", {
    totp_secret_ciphertext: null,
    totp_secret_iv: null,
    totp_secret_tag: null,
    totp_pending_until: null,
    totp_enabled: false,
    recovery_code_hashes: [],
    session_generation: generation,
    updated_at: new Date(Number(options.now || Date.now())).toISOString(),
  }, options);
  return createSession(generation, options);
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  addAuthenticator,
  beginMfa,
  clearCookie,
  createSession,
  disableMfa,
  login,
  parseSession,
  readAdminConfig,
  regenerateRecoveryCodes,
  requireAdmin,
  resetPassword,
  sessionCookie,
  verifyMfa,
};
