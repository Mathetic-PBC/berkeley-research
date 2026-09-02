"use strict";

// Canonical paper PDFs live in the private Supabase Storage bucket
// `berkeley-papers`. The record stores only the stable object PATH; every read
// is a short-lived signed URL minted here with the service role, and every
// upload goes straight from the browser to Storage through a signed upload URL
// -- so the file never passes through our function (Vercel body limits) and the
// service-role key never reaches the browser.

const { supabaseConfig } = require("./config");
const { serviceRequest } = require("./supabase");

const PAPERS_BUCKET = "berkeley-papers";
const VIEW_TTL_SECONDS = 300;

function storageBase(env) {
  return `${supabaseConfig(env).url}/storage/v1`;
}

// One stable object path per paper, so a replace overwrites in place.
function paperObjectPath(paperId) {
  return `papers/${String(paperId)}.pdf`;
}

// A signed URL the browser PUTs the PDF bytes to directly. The token in the URL
// authorizes the single upload; no key is handed out.
async function signedUploadUrl(path, options = {}) {
  const value = await serviceRequest(
    `/storage/v1/object/upload/sign/${PAPERS_BUCKET}/${encodeURI(path)}`,
    // x-upsert so re-uploading to the paper's stable path (a "Replace")
    // overwrites in place rather than failing on a name clash.
    { ...options, method: "POST", body: {}, headers: { "x-upsert": "true" } },
  );
  const rel = String((value && value.url) || "");
  if (!rel) {
    const error = new Error("Storage did not return an upload URL");
    error.statusCode = 502;
    throw error;
  }
  return { uploadUrl: `${storageBase(options.env)}${rel}`, path };
}

// A short-lived signed URL to read one stored PDF. Minted per view, never
// stored on the record.
async function signedViewUrl(path, options = {}) {
  const expiresIn = Number(options.expiresIn || VIEW_TTL_SECONDS);
  const value = await serviceRequest(
    `/storage/v1/object/sign/${PAPERS_BUCKET}/${encodeURI(path)}`,
    { ...options, method: "POST", body: { expiresIn } },
  );
  const rel = String((value && (value.signedURL || value.signedUrl)) || "");
  if (!rel) return { url: "", expiresIn };
  return { url: `${storageBase(options.env)}${rel}`, expiresIn };
}

// Remove one stored PDF (used when clearing or replacing).
async function removeObject(path, options = {}) {
  return serviceRequest(`/storage/v1/object/${PAPERS_BUCKET}`, {
    ...options,
    method: "DELETE",
    body: { prefixes: [path] },
  });
}

// One stored PDF's bytes, for the analysis call. Read with the service role
// straight from the bucket; never handed to a browser.
async function downloadObject(path, options = {}) {
  const env = options.env || process.env;
  const config = supabaseConfig(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${config.url}/storage/v1/object/${PAPERS_BUCKET}/${encodeURI(path)}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: options.signal,
  });
  if (!response.ok) {
    const error = new Error("The stored paper could not be read");
    error.statusCode = 502;
    throw error;
  }
  // Refuse an oversized object on its declared length, before the body is
  // buffered: `options.maxBytes` bytes is what the caller can afford to hold.
  // A missing or unparseable header reads as 0, so the post-read check below
  // stays the real bound.
  const maxBytes = Number(options.maxBytes) || 0;
  const declared = response.headers && typeof response.headers.get === "function"
    ? Number(response.headers.get("content-length")) : 0;
  if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error("That PDF is larger than the analysis can take");
    error.statusCode = 413;
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (maxBytes > 0 && bytes.length > maxBytes) {
    const error = new Error("That PDF is larger than the analysis can take");
    error.statusCode = 413;
    throw error;
  }
  return bytes;
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
