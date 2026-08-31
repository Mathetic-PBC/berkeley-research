"use strict";

const { supabaseConfig } = require("./config");

class ServiceError extends Error {
  constructor(message, statusCode = 502, detail = "") {
    super(message);
    this.name = "ServiceError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch { value = text; }
  }
  if (!response.ok) {
    const detail = typeof value === "object" && value
      ? String(value.message || value.error_description || value.error || "")
      : String(value || "");
    throw new ServiceError("Supabase rejected the server request", response.status, detail.slice(0, 300));
  }
  return value;
}

async function serviceRequest(path, options = {}) {
  const env = options.env || process.env;
  const config = supabaseConfig(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const headers = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    Accept: "application/json",
    ...(options.headers || {}),
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchImpl(`${config.url}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  return parseResponse(response);
}

async function selectRows(table, query, options = {}) {
  const suffix = query ? `?${query}` : "";
  const value = await serviceRequest(`/rest/v1/${table}${suffix}`, options);
  return Array.isArray(value) ? value : [];
}

async function selectOne(table, query, options = {}) {
  const rows = await selectRows(table, query, options);
  return rows[0] || null;
}

async function insertRows(table, rows, options = {}) {
  return serviceRequest(`/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    ...options,
    method: "POST",
    body: rows,
    headers: {
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
}

async function patchRows(table, query, values, options = {}) {
  return serviceRequest(`/rest/v1/${table}?${query}`, {
    ...options,
    method: "PATCH",
    body: values,
    headers: {
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
}

async function deleteRows(table, query, options = {}) {
  return serviceRequest(`/rest/v1/${table}?${query}`, {
    ...options,
    method: "DELETE",
    headers: {
      Prefer: options.prefer || "return=minimal",
      ...(options.headers || {}),
    },
  });
}

async function rpc(name, body, options = {}) {
  return serviceRequest(`/rest/v1/rpc/${encodeURIComponent(name)}`, {
    ...options,
    method: "POST",
    body: body || {},
  });
}

async function verifyUser(accessToken, options = {}) {
  if (!accessToken) {
    const error = new ServiceError("Sign in to Engelbart first", 401);
    throw error;
  }
  const env = options.env || process.env;
  const config = supabaseConfig(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${config.url}/auth/v1/user`, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new ServiceError("Your Engelbart session has expired", 401);
  const user = await response.json();
  if (!user || !user.id) throw new ServiceError("Supabase returned no user", 401);

  const membership = await selectOne(
    "engelbart_members",
    `user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
    options,
  );
  if (!membership) throw new ServiceError("This account is not an Engelbart member", 403);
  return { id: String(user.id), email: String(user.email || "").toLowerCase() };
}

module.exports = {
  ServiceError,
  deleteRows,
  insertRows,
  parseResponse,
  patchRows,
  rpc,
  selectOne,
  selectRows,
  serviceRequest,
  verifyUser,
};
