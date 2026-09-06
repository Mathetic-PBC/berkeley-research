"use strict";

// Canonical paper PDFs live in the private Supabase Storage bucket
// `berkeley-papers`. The record stores only the stable object PATH; every read
// is a short-lived signed URL minted here with the service role, and every
// upload goes straight from the browser to Storage through a signed upload URL
// -- so the file never passes through our function (Vercel body limits) and the
// service-role key never reaches the browser.
//
// Each helper is one storage operation in the telemetry: the object is named
// by its path, never by its bytes, and a signed URL's token is never recorded.

const { supabaseConfig } = require("./config");
const { serviceRequest } = require("./supabase");
const { telemetry } = require("./telemetry");
const { sha256 } = require("./telemetry/redaction");

const PAPERS_BUCKET = "berkeley-papers";
const VIEW_TTL_SECONDS = 300;

function storageBase(env) {
  return `${supabaseConfig(env).url}/storage/v1`;
}

// One stable object path per paper, so a replace overwrites in place.
function paperObjectPath(paperId) {
  return `papers/${String(paperId)}.pdf`;
}

function traced(name, path, attributes, fn) {
  return telemetry.runOperation({
    name, type: "storage",
    attributes: { "engelbart.storage.bucket": PAPERS_BUCKET, "engelbart.storage.object": path, ...(attributes || {}) },
  }, fn);
}

// A signed URL the browser PUTs the PDF bytes to directly. The token in the URL
// authorizes the single upload; no key is handed out.
async function signedUploadUrl(path, options = {}) {
  return traced("storage.sign-upload", path, {}, async (op) => {
    const value = await serviceRequest(
      `/storage/v1/object/upload/sign/${PAPERS_BUCKET}/${encodeURI(path)}`,
      // x-upsert so re-uploading to the paper's stable path (a "Replace")
      // overwrites in place rather than failing on a name clash.
      { ...options, method: "POST", body: {}, headers: { "x-upsert": "true" }, trace: false },
    );
    const rel = String((value && value.url) || "");
    if (!rel) {
      const error = new Error("Storage did not return an upload URL");
      error.statusCode = 502;
      throw error;
    }
    op.setAttribute("engelbart.storage.signed", true);
    return { uploadUrl: `${storageBase(options.env)}${rel}`, path };
  });
}

// A short-lived signed URL to read one stored PDF. Minted per view, never
// stored on the record.
async function signedViewUrl(path, options = {}) {
  const expiresIn = Number(options.expiresIn || VIEW_TTL_SECONDS);
  return traced("storage.sign-view", path, { "engelbart.storage.expires_in": expiresIn }, async (op) => {
    const value = await serviceRequest(
      `/storage/v1/object/sign/${PAPERS_BUCKET}/${encodeURI(path)}`,
      { ...options, method: "POST", body: { expiresIn }, trace: false },
    );
    const rel = String((value && (value.signedURL || value.signedUrl)) || "");
    op.setAttribute("engelbart.storage.signed", Boolean(rel));
    if (!rel) return { url: "", expiresIn };
    return { url: `${storageBase(options.env)}${rel}`, expiresIn };
  });
}

// Remove one stored PDF (used when clearing or replacing).
async function removeObject(path, options = {}) {
  return traced("storage.remove", path, {}, () => serviceRequest(`/storage/v1/object/${PAPERS_BUCKET}`, {
    ...options,
    method: "DELETE",
    body: { prefixes: [path] },
    trace: false,
  }));
}

// One stored PDF's bytes, for the analysis call. Read with the service role
// straight from the bucket; never handed to a browser. This is a direct
// fetch, not a serviceRequest, so it is traced here: the operation records
// the object's path, size, type and digest -- the reference to the paper --
// and never the bytes themselves.
async function downloadObject(path, options = {}) {
  const env = options.env || process.env;
  const config = supabaseConfig(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const maxBytes = Number(options.maxBytes) || 0;
  return traced("paper.download", path, { "http.request.method": "GET", "engelbart.storage.max_bytes": maxBytes || undefined }, async (op) => {
    const response = await fetchImpl(`${config.url}/storage/v1/object/${PAPERS_BUCKET}/${encodeURI(path)}`, {
      headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
      signal: options.signal,
    });
    op.setAttribute("http.response.status_code", response.status);
    if (!response.ok) {
      const error = new Error("The stored paper could not be read");
      error.statusCode = 502;
      throw error;
    }
    // Refuse an oversized object on its declared length, before the body is
    // buffered: `options.maxBytes` bytes is what the caller can afford to hold.
    // A missing or unparseable header reads as 0, so the post-read check below
    // stays the real bound.
    const hasHeaders = response.headers && typeof response.headers.get === "function";
    const declared = hasHeaders ? Number(response.headers.get("content-length")) : 0;
    const contentType = hasHeaders ? String(response.headers.get("content-type") || "") : "";
    op.setAttributes({ "engelbart.storage.declared_bytes": Number.isFinite(declared) && declared > 0 ? declared : undefined,
      "engelbart.storage.content_type": contentType || undefined });
    if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
      const error = new Error("That PDF is larger than the analysis can take");
      error.statusCode = 413;
      throw error;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    op.setAttributes({ "engelbart.storage.bytes": bytes.length, "engelbart.storage.sha256": sha256(bytes) });
    if (maxBytes > 0 && bytes.length > maxBytes) {
      const error = new Error("That PDF is larger than the analysis can take");
      error.statusCode = 413;
      throw error;
    }
    return bytes;
  });
}

module.exports = {
  PAPERS_BUCKET,
  VIEW_TTL_SECONDS,
  paperObjectPath,
  signedUploadUrl,
  signedViewUrl,
  removeObject,
  downloadObject,
};
