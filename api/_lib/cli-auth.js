"use strict";

const crypto = require("node:crypto");
const { rpc, ServiceError, verifyUser } = require("./supabase");

// I, L, O, U, 0 and 1 are omitted: the code is read off a screen and typed
// into a terminal, and those are the pairs that get mistyped.
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const USER_CODE_LENGTH = 8;
const SESSION_TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 5;
const DEVICE_CODE_PREFIX = "egbd_";
const TOKEN_PREFIX = "egb_";
const MAX_LABEL_LENGTH = 100;

// Setup codes are longer than approval codes on purpose: they are the only
// secret (the browser that issued one holds no device code), and they are
// pasted inside an install command rather than typed, so the extra length is
// free. The distinct 12-char shape also means one pasted into the approval
// box is rejected instead of half-matching.
const SETUP_CODE_LENGTH = 12;
const SETUP_CODE_TTL_SECONDS = 15 * 60;

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("base64url");
}

function newSecret(prefix) {
  return prefix + crypto.randomBytes(32).toString("base64url");
}

function newUserCode(randomInt = crypto.randomInt) {
  let code = "";
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Kept in step with normalizeUserCode in engelbart/shared.js; cli-auth.test.js
// asserts the two agree so the browser and the function never disagree about
// which code was typed.
function normalizeUserCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length <= 4) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

function isPlausibleUserCode(value) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeUserCode(value));
}

function newSetupCode(randomInt = crypto.randomInt) {
  let code = "";
  for (let index = 0; index < SETUP_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function normalizeSetupCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, SETUP_CODE_LENGTH);
  if (compact.length <= 4) return compact;
  if (compact.length <= 8) return `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}

function isPlausibleSetupCode(value) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeSetupCode(value));
}

function cleanLabel(value) {
  return String(value || "")
    .replace(/[^\w .@-]/g, "")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function requireSecret(value, prefix, name) {
  const secret = String(value || "");
  if (!secret.startsWith(prefix) || secret.length < prefix.length + 20 || secret.length > 200) {
    const error = new Error(`${name} is missing or malformed`);
    error.statusCode = 400;
    throw error;
  }
  return secret;
}

async function startSession(input = {}, options = {}) {
  const deviceCode = newSecret(DEVICE_CODE_PREFIX);
  const userCode = newUserCode(options.randomInt);
  const row = await rpc("engelbart_start_cli_session", {
    p_device_code_hash: hashSecret(deviceCode),
    p_user_code: userCode,
    p_client_label: cleanLabel(input.label),
    p_ttl_seconds: SESSION_TTL_SECONDS,
  }, options);
  const session = Array.isArray(row) ? row[0] : row;
  if (!session) throw new ServiceError("Could not start a CLI pairing session");
  return {
    deviceCode,
    userCode,
    // The approval UI lives on the sign-in page: /engelbart is a static demo
    // that loads none of the auth code, so a member sent there sees marketing
    // and the terminal waits forever.
    verificationUrl: `${options.origin || ""}/engelbart/signin`,
    verificationUrlComplete: `${options.origin || ""}/engelbart/signin?code=${encodeURIComponent(userCode)}`,
    intervalSeconds: POLL_INTERVAL_SECONDS,
    expiresInSeconds: SESSION_TTL_SECONDS,
  };
}

// The browser half. The caller has already been verified as a member, so the
// only decision left here is whether this code is still open.
async function resolveSession(userCode, user, approve, options = {}) {
  if (!isPlausibleUserCode(userCode)) {
    const error = new Error("That pairing code is not valid");
    error.statusCode = 400;
    throw error;
  }
  const result = await rpc("engelbart_resolve_cli_session", {
    p_user_code: normalizeUserCode(userCode),
    p_user_id: user.id,
    p_email: user.email,
    p_approve: Boolean(approve),
  }, options);
  const value = Array.isArray(result) ? result[0] : result;
  if (!value || !value.resolved) {
    const reason = value && value.reason;
    const error = new Error(reason === "already_resolved"
      ? "That pairing code was already used"
      : "That pairing code is expired or unknown");
    error.statusCode = reason === "already_resolved" ? 409 : 404;
    throw error;
  }
  return { approved: Boolean(value.approved), label: value.label || "" };
}

// The CLI half. Every terminal state is a 200 with a status the installer can
// act on; only a malformed request is an error.
async function pollSession(deviceCode, options = {}) {
  const secret = requireSecret(deviceCode, DEVICE_CODE_PREFIX, "Device code");
  const token = newSecret(TOKEN_PREFIX);
  const result = await rpc("engelbart_claim_cli_session", {
    p_device_code_hash: hashSecret(secret),
    p_token_hash: hashSecret(token),
    p_min_interval_seconds: POLL_INTERVAL_SECONDS,
  }, options);
  const value = Array.isArray(result) ? result[0] : result;
  const status = (value && value.status) || "expired";
  if (status === "ready") {
    return { status, token, email: String(value.email || "") };
  }
  if (status === "slow_down") {
    return { status, intervalSeconds: POLL_INTERVAL_SECONDS * 2 };
  }
  return { status, intervalSeconds: POLL_INTERVAL_SECONDS };
}

// The browser half of web-first onboarding: the member who just approved a
// setup asks for the code the install command will carry. The caller has
// already been verified as a member.
async function issueSetupCode(user, options = {}) {
  const code = newSetupCode(options.randomInt);
  await rpc("engelbart_issue_setup_code", {
    p_user_id: user.id,
    p_code_hash: hashSecret(code),
    p_ttl_seconds: SETUP_CODE_TTL_SECONDS,
  }, options);
  return { code, expiresInSeconds: SETUP_CODE_TTL_SECONDS };
}

// The CLI half: the code is swapped for a machine token in one transaction,
// so a replayed code reads as used rather than minting twice.
async function redeemSetupCode(code, label, options = {}) {
  if (!isPlausibleSetupCode(code)) {
    const error = new Error("That setup code is not valid");
    error.statusCode = 400;
    throw error;
  }
  const token = newSecret(TOKEN_PREFIX);
  const result = await rpc("engelbart_redeem_setup_code", {
    p_code_hash: hashSecret(normalizeSetupCode(code)),
    p_token_hash: hashSecret(token),
    p_label: cleanLabel(label),
  }, options);
  const value = Array.isArray(result) ? result[0] : result;
  const status = (value && value.status) || "invalid";
  if (status === "ready") {
    return { token, email: String(value.email || "") };
  }
  const error = new Error(status === "used"
    ? "That setup code was already used"
    : status === "denied"
      ? "That account is not an Engelbart member"
      : "That setup code is expired or unknown");
  error.statusCode = status === "used" ? 409 : status === "denied" ? 403 : 404;
  throw error;
}

async function verifyCliToken(token, options = {}) {
  const secret = requireSecret(token, TOKEN_PREFIX, "Engelbart CLI token");
  const result = await rpc("engelbart_touch_cli_token", {
    p_token_hash: hashSecret(secret),
  }, options);
  const value = Array.isArray(result) ? result[0] : result;
  if (!value || !value.valid) {
    throw new ServiceError("This Engelbart CLI is not signed in", 401);
  }
  return { id: String(value.user_id), email: String(value.email || "").toLowerCase() };
}

// One entry point for both callers of the authenticated endpoints: a browser
// session presents a Supabase JWT, an installed CLI presents its own token.
async function verifyPrincipal(bearer, options = {}) {
  const token = String(bearer || "");
  if (token.startsWith(TOKEN_PREFIX)) return verifyCliToken(token, options);
  return verifyUser(token, options);
}

async function revokeToken(token, options = {}) {
  const secret = requireSecret(token, TOKEN_PREFIX, "Engelbart CLI token");
  const result = await rpc("engelbart_revoke_cli_token", {
    p_token_hash: hashSecret(secret),
  }, options);
  const value = Array.isArray(result) ? result[0] : result;
  return { revoked: value === true || value === "true" };
}

module.exports = {
  DEVICE_CODE_PREFIX,
  POLL_INTERVAL_SECONDS,
  SESSION_TTL_SECONDS,
  SETUP_CODE_LENGTH,
  SETUP_CODE_TTL_SECONDS,
  TOKEN_PREFIX,
  USER_CODE_ALPHABET,
  cleanLabel,
  hashSecret,
  isPlausibleSetupCode,
  isPlausibleUserCode,
  issueSetupCode,
  newSetupCode,
  newUserCode,
  normalizeSetupCode,
  normalizeUserCode,
  pollSession,
  redeemSetupCode,
  requireSecret,
  resolveSession,
  revokeToken,
  startSession,
  verifyCliToken,
  verifyPrincipal,
};
