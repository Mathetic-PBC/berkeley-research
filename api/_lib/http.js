"use strict";

const MAX_JSON_BYTES = 64 * 1024;

function secureHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, status, value) {
  secureHeaders(res);
  return res.status(status).json(value);
}

async function readJson(req, limit = MAX_JSON_BYTES) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be JSON");
    error.statusCode = 400;
    throw error;
  }
}

function parseCookies(req) {
  const cookies = {};
  const raw = String(req.headers.cookie || "");
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

function bearerToken(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.headers.authorization || ""));
  return match ? match[1] : "";
}

function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  sendJson(res, 405, { error: "Method not allowed" });
  return false;
}

function publicError(error) {
  const status = Number(error && error.statusCode) || 500;
  if (status >= 500) return { status, message: "The Engelbart service is temporarily unavailable." };
  return { status, message: String(error.message || "Request failed") };
}

module.exports = {
  MAX_JSON_BYTES,
  allowMethods,
  bearerToken,
  parseCookies,
  publicError,
  readJson,
  secureHeaders,
  sendJson,
};
