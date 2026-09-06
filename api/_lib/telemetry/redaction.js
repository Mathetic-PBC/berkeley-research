"use strict";

// Central redaction for everything the telemetry layer records. Callers hand
// over the real value -- a model request, a PostgREST body, an error -- and
// get back a bounded copy with credentials, signed tokens and raw bytes gone.
// No caller redacts on its own; this is the one place the rules live, so a
// new secret is caught everywhere by adding it here once.

const crypto = require("node:crypto");

const REDACTED = "[redacted]";
const MAX_STRING = 64 * 1024;
const MAX_DEPTH = 24;

// Object keys whose values are never recorded, whatever they hold.
const SECRET_KEY = new RegExp("^(?:" + [
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "apikey", "api[-_]?key", "x-api-key", "anon[-_]?key", "service[-_]?role[-_]?key", "master[-_]?key",
  "token", "access[-_]?token", "refresh[-_]?token", "id[-_]?token", "paper[-_]?token", "machine[-_]?token",
  "secret", "client[-_]?secret", "password", "passwd", "private[-_]?key", "signature",
  "upload[-_]?url", "signed[-_]?url", "signedurl",
].join("|") + ")$", "i");

// Substrings that read as credentials wherever they appear inside a string.
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,                                  // any bearer token
  /\bsk-[A-Za-z0-9_-]{8,}/g,                                             // LiteLLM / Anthropic keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,    // JWTs (Supabase keys, sessions)
  /\begb_[A-Za-z0-9_-]{8,}/g,                                            // Engelbart machine tokens
  /([?&](?:token|apikey|api_key|access_token|signature|sig|key|code)=)[^&\s"'<>]+/gi, // signed URLs
];

// Environment variables whose VALUES are stripped from every recorded
// string, plus any variable whose name says it holds a credential.
const ENV_SECRET_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "LITELLM_MASTER_KEY",
  "ENGELBART_CREDENTIAL_KEY", "ENGELBART_ADMIN_SESSION_SECRET", "OTEL_EXPORTER_OTLP_HEADERS"];
const ENV_SECRET_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

function secretValues(env = process.env, extra = []) {
  const out = new Set();
  for (const [name, value] of Object.entries(env || {})) {
    if (!ENV_SECRET_NAMES.includes(name) && !ENV_SECRET_NAME.test(name)) continue;
    const s = String(value || "");
    if (s.length >= 8) out.add(s);
  }
  for (const value of extra) {
    const s = String(value || "");
    if (s.length >= 8) out.add(s);
  }
  return out;
}

function redactString(value, secrets, maxString) {
  let s = value;
  // Patterns first, so "Bearer <known secret>" goes as one token; the known
  // values then catch anything the patterns did not recognise.
  for (const pattern of SECRET_PATTERNS) {
    // Only the signed-URL pattern has a capture group; for the others the
    // second argument is the match offset, which is not a prefix to keep.
    s = s.replace(pattern, (match, prefix) => (typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED));
  }
  for (const secret of secrets) {
    if (s.includes(secret)) s = s.split(secret).join(REDACTED);
  }
  if (s.length > maxString) s = `${s.slice(0, maxString)} [… ${s.length - maxString} more chars truncated]`;
  return s;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// An Anthropic base64 source block: the bytes are referenced, never copied.
function isBase64Source(value) {
  return value && typeof value === "object" && value.type === "base64" && typeof value.data === "string";
}

function bytesRef(buffer, mediaType) {
  const out = { "[bytes]": buffer.length, sha256: sha256(buffer) };
  if (mediaType) out.media_type = mediaType;
  return out;
}

function redactValue(value, state, depth) {
  if (value == null) return value;
  const kind = typeof value;
  if (kind === "string") return redactString(value, state.secrets, state.maxString);
  if (kind === "number" || kind === "boolean") return value;
  if (kind === "bigint") return value.toString();
  if (kind === "function" || kind === "symbol") return undefined;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return bytesRef(Buffer.from(value.buffer ? value : new Uint8Array(value)));
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value, state);
  if (depth >= state.maxDepth) return "[depth]";
  if (state.seen.has(value)) return "[cycle]";
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, state, depth + 1));
    if (isBase64Source(value)) {
      let bytes;
      try { bytes = Buffer.from(value.data, "base64"); } catch { bytes = Buffer.alloc(0); }
      return { ...redactValue({ ...value, data: undefined }, state, depth + 1), data: REDACTED, source_ref: bytesRef(bytes, value.media_type) };
    }
    if (typeof value.toJSON === "function" && !(value instanceof Map) && !(value instanceof Set)) {
      return redactValue(value.toJSON(), state, depth + 1);
    }
    if (value instanceof Map) return redactValue(Object.fromEntries(value), state, depth + 1);
    if (value instanceof Set) return redactValue([...value], state, depth + 1);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, state, depth + 1);
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

// A safe deep copy of any value: credentials out, bytes referenced, strings
// bounded, cycles cut. Never throws -- a value it cannot walk is described.
function redact(value, options = {}) {
  const state = {
    secrets: options.secrets || secretValues(options.env || process.env),
    maxString: Number(options.maxString) || MAX_STRING,
    maxDepth: Number(options.maxDepth) || MAX_DEPTH,
    seen: new Set(),
  };
  try {
    return redactValue(value, state, 0);
  } catch (error) {
    return { "[unredactable]": String(error && error.message || error).slice(0, 200) };
  }
}

// The parts of an error the record may hold. The message is redacted like
// any string; the stack is kept only when asked, since it can quote inputs.
function sanitizeError(error, options = {}) {
  if (!error) return null;
  const secrets = options.secrets || secretValues(options.env || process.env);
  const out = {
    name: String(error.name || "Error").slice(0, 80),
    message: redactString(String(error.message || error), secrets, 500),
  };
  if (error.statusCode != null) out.statusCode = Number(error.statusCode) || 0;
  if (error.code != null) out.code = String(error.code).slice(0, 80);
  if (error.detail != null) out.detail = redactString(String(error.detail), secrets, 300);
  if (options.stack && typeof error.stack === "string") out.stack = redactString(error.stack, secrets, 4000);
  return out;
}

// A URL with the query and fragment gone: a signed URL's token lives there.
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function hostOf(value) {
  try { return new URL(String(value)).hostname; } catch { return ""; }
}

module.exports = {
  MAX_STRING,
  REDACTED,
  hostOf,
  redact,
  safeUrl,
  sanitizeError,
  secretValues,
  sha256,
};
