"use strict";

const { supabaseConfig } = require("./config");
const { telemetry } = require("./telemetry");

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

async function rawServiceRequest(path, options = {}) {
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
  return { value: await parseResponse(response), status: response.status };
}

// What one request is, for the record: the semantic operation, the table or
// RPC it touches, and the path split from its filter. Nothing here has seen
// a header: the service-role key never reaches the telemetry layer at all.
function describe(path, method, options) {
  const [pathname, query = ""] = String(path).split("?");
  const rest = /^\/rest\/v1\/(?:rpc\/([^/?]+)|([^/?]+))/.exec(pathname);
  const verb = String(method || "GET").toUpperCase();
  const prefer = String((options.headers || {}).Prefer || options.prefer || "");
  let name = "db.request";
  if (rest && rest[1]) name = "db.rpc";
  else if (rest && rest[2]) {
    name = verb === "GET" ? "db.select"
      : verb === "POST" ? (prefer.includes("merge-duplicates") ? "db.upsert" : "db.insert")
        : verb === "PATCH" ? "db.patch"
          : verb === "DELETE" ? "db.delete" : "db.request";
  } else if (pathname.startsWith("/storage/v1/")) name = "storage.request";
  else if (pathname.startsWith("/auth/v1/")) name = "auth.request";
  return {
    name, verb, pathname, query,
    table: rest && rest[2] ? decodeURIComponent(rest[2]) : "",
    rpc: rest && rest[1] ? decodeURIComponent(rest[1]) : "",
  };
}

// The shared database boundary, traced. `options.trace = false` runs the
// request untraced (the telemetry store's own writes; a storage helper that
// is already its own operation); `options.trace = { name }` gives the
// operation a semantic name in place of the generic db.* one.
async function serviceRequest(path, options = {}) {
  if (options.trace === false) return (await rawServiceRequest(path, options)).value;
  const meta = describe(path, options.method, options);
  const name = options.trace && options.trace.name ? String(options.trace.name) : meta.name;
  return telemetry.runOperation({
    name, type: "database",
    attributes: {
      "db.system.name": "postgrest",
      "db.operation.name": meta.name.split(".")[1],
      "db.collection.name": meta.table || undefined,
      "engelbart.db.rpc": meta.rpc || undefined,
      "http.request.method": meta.verb,
      "url.path": meta.pathname,
      "url.query": meta.query || undefined,
    },
  }, async (op) => {
    op.snapshot("database_request", { method: meta.verb, path: meta.pathname, query: meta.query, body: options.body });
    try {
      const { value, status } = await rawServiceRequest(path, options);
      op.setAttributes({ "http.response.status_code": status, "engelbart.db.rows": Array.isArray(value) ? value.length : undefined });
      op.snapshot("database_response", value);
      return value;
    } catch (error) {
      if (error && error.statusCode) op.setAttribute("http.response.status_code", error.statusCode);
      throw error;
    }
  });
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
  describe,
  insertRows,
  parseResponse,
  patchRows,
  rpc,
  selectOne,
  selectRows,
  serviceRequest,
  verifyUser,
};
