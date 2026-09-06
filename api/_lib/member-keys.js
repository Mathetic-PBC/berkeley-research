"use strict";

// A member's own Anthropic key, brought to the setup page. Their model calls
// then run on it, straight to Anthropic, and the Mathetic pool is neither
// asked nor allowed to refuse them. The key is checked with Anthropic before
// it is kept, stored encrypted under the same key as the LiteLLM credentials,
// and never returned to a client: the page learns the last four characters
// and nothing else. The Claude Code connection is untouched; that still hands
// the CLI the member's LiteLLM key.

const { decryptSecret, encryptSecret } = require("./crypto");
const { deleteRows, insertRows, selectOne } = require("./supabase");
const { telemetry } = require("./telemetry");
const { ANTHROPIC_URL, ANTHROPIC_VERSION } = require("./upstream");

const TABLE = "engelbart_member_model_keys";
// Anthropic keys: sk-ant-<label>-<body>, around a hundred characters.
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const CHECK_TIMEOUT_MS = 10 * 1000;

function refuse(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Reads and writes of this table leave no trace: the row is a credential,
// and the record has no use for it.
function quiet(options) {
  return { ...options, trace: false };
}

function byUser(user) {
  return `user_id=eq.${encodeURIComponent(user.id)}`;
}

function normalizeKey(value) {
  const key = String(value || "").trim();
  if (!KEY_SHAPE.test(key)) throw refuse("That does not look like an Anthropic API key; they start with sk-ant-", 400);
  return key;
}

// GET /v1/models costs nothing and answers 401 to a key Anthropic does not
// know, which is the one thing worth learning before the key is kept.
async function checkKey(key, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  let response;
  try {
    response = await fetchImpl(`${ANTHROPIC_URL}/v1/models?limit=1`, {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      signal: options.signal || AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    throw refuse("Anthropic could not be reached to check the key; try again in a moment", 502);
  }
  if (response.status === 401 || response.status === 403) throw refuse("Anthropic did not accept that key", 400);
  if (!response.ok) throw refuse(`Anthropic answered ${response.status} while checking the key; try again in a moment`, 502);
}

async function setKey(user, value, options = {}) {
  const key = normalizeKey(value);
  telemetry.protect(key);
  await checkKey(key, options);
  const encrypted = encryptSecret(key, options.env);
  await insertRows(TABLE, [{
    user_id: user.id,
    provider: "anthropic",
    key_ciphertext: encrypted.ciphertext,
    key_iv: encrypted.iv,
    key_tag: encrypted.tag,
    key_last4: key.slice(-4),
    updated_at: new Date().toISOString(),
  }], { ...quiet(options), query: "on_conflict=user_id", prefer: "resolution=merge-duplicates,return=minimal" });
  return { set: true, last4: key.slice(-4) };
}

async function clearKey(user, options = {}) {
  await deleteRows(TABLE, byUser(user), quiet(options));
  return { set: false };
}

// What the page may know: whether a key is set, and its last four characters.
async function status(user, options = {}) {
  const row = await selectOne(TABLE, `${byUser(user)}&select=key_last4,updated_at`, quiet(options));
  return row ? { set: true, last4: String(row.key_last4 || ""), since: row.updated_at } : { set: false };
}

// The member's model credentials when they brought a key, else null. This is
// the one place the key is decrypted, and what it goes into is a model call.
async function credentials(user, options = {}) {
  const row = await selectOne(TABLE, `${byUser(user)}&select=key_ciphertext,key_iv,key_tag`, quiet(options));
  if (!row) return null;
  let key;
  try {
    key = decryptSecret({ ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag }, options.env);
  } catch {
    throw refuse("Your saved Anthropic key could not be read; remove it and add it again", 409);
  }
  telemetry.protect(key);
  return { status: "own", gateway: "anthropic", apiKey: key, baseUrl: ANTHROPIC_URL, models: [] };
}

module.exports = { KEY_SHAPE, TABLE, checkKey, clearKey, credentials, normalizeKey, setKey, status };
