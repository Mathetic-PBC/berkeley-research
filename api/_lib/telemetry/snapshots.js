"use strict";

// Payload snapshots: the actual request a model was sent, the raw reply, the
// parsed reply, the normalized result, a page's extracted text. They are the
// Bart Snapshot entity (docs/observability/data-contract.md) and live beside
// the operation, never inside its span attributes. Every snapshot is redacted
// before it gets here and bounded here: a PDF is a byte reference, a huge
// string is cut, and a record that is still too large is kept as a preview.

const crypto = require("node:crypto");

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const SHRUNK_STRING = 4096;

const KINDS = Object.freeze([
  "model_request", "model_raw_response", "model_parsed_response", "normalized_result",
  "processing_input", "processing_output",
  "database_request", "database_response",
  "page_text", "error_detail",
]);

function shrinkStrings(value, cap) {
  if (typeof value === "string") return value.length > cap ? `${value.slice(0, cap)} [… ${value.length - cap} more chars truncated]` : value;
  if (Array.isArray(value)) return value.map((v) => shrinkStrings(v, cap));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrinkStrings(v, cap);
    return out;
  }
  return value;
}

// The UTF-8 size of a value as JSON: what `bytes` means everywhere here.
function sizeOf(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  return Buffer.byteLength(json === undefined ? "null" : json);
}

// The first `chars` UTF-16 units of `json`, not ending inside a surrogate
// pair, so the preview is well-formed text.
function head(json, chars) {
  let cut = json.slice(0, Math.max(0, chars));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// The content within its byte budget, and whether it had to be cut to fit.
// Three rules, in order: (1) within the cap, kept whole; (2) over it, every
// string shortened to SHRUNK_STRING characters, kept if that fits; (3) still
// over, replaced by a preview wrapper holding the head of the shrunk JSON,
// with the original and shortened serialized sizes on record. In every case
// `bytes` is the UTF-8 size of the stored `content` as JSON -- for rule 3,
// the whole wrapper -- and it never exceeds `maxBytes`: the preview is
// measured after JSON escaping, since the preview is itself a JSON string
// inside a JSON document, and each unit of it may be several bytes.
function bound(content, maxBytes = MAX_SNAPSHOT_BYTES) {
  const originalBytes = sizeOf(content);
  if (originalBytes <= maxBytes) return { content, bytes: originalBytes, truncated: false };
  const shrunk = shrinkStrings(content, SHRUNK_STRING);
  const shrunkBytes = sizeOf(shrunk);
  if (shrunkBytes <= maxBytes) return { content: shrunk, bytes: shrunkBytes, truncated: true };
  const json = JSON.stringify(shrunk);
  const wrap = (preview) => ({ "[truncated]": true, original_bytes: originalBytes, shrunk_bytes: shrunkBytes, preview });
  let chars = Math.min(json.length, Math.floor(maxBytes / 2));
  let wrapper = wrap(head(json, chars));
  let bytes = sizeOf(wrapper);
  // Escaping and multi-byte characters can only enlarge the preview beyond
  // its character count, so shrink in proportion until the wrapper fits.
  while (bytes > maxBytes && chars > 0) {
    chars = Math.min(chars - 1, Math.floor(chars * (maxBytes / bytes) * 0.98));
    wrapper = wrap(head(json, chars));
    bytes = sizeOf(wrapper);
  }
  return { content: wrapper, bytes, truncated: true };
}

// `content` must already be redacted.
function build(operation, kind, content, options = {}) {
  const fitted = bound(content, options.maxBytes);
  const run = operation.run || {};
  return {
    snapshot_id: crypto.randomUUID(),
    operation_id: operation.operation_id,
    trace_id: operation.trace_id,
    span_id: operation.span_id,
    run_id: run.run_id || null,
    onboarding_id: run.onboarding_id || null,
    test_run_id: run.test_run_id || null,
    kind: KINDS.includes(kind) ? kind : String(kind).slice(0, 40),
    content: fitted.content,
    bytes: fitted.bytes,
    truncated: fitted.truncated,
    redacted: true,
    created_at: new Date().toISOString(),
  };
}

module.exports = { KINDS, MAX_SNAPSHOT_BYTES, SHRUNK_STRING, bound, build, sizeOf };
