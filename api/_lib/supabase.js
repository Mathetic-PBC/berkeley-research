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
    ...describeQuery(query),
  };
}

// PostgREST query parameters that shape the request rather than filter it:
// their values are column names, directions and counts, never data.
const STRUCTURAL_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

// The structure of a PostgREST filter with its values gone. Operation
// attributes get this -- `user_id=eq.?&status=in.?&select=*` -- while the
// real values (the uuid, the email, the row ids) stay in the operation's
// `database_request` snapshot, where the debugger reads them.
function describeQuery(query) {
  const fields = [];
  const operators = [];
  const shape = [];
  for (const [key, value] of new URLSearchParams(String(query || ""))) {
    if (STRUCTURAL_PARAMS.has(key)) { shape.push(`${key}=${value}`); continue; }
    const op = /^(not\.)?([a-z]+)\./.exec(value);
    const operator = op ? `${op[1] || ""}${op[2]}` : (key === "or" || key === "and" ? key : "");
    fields.push(key);
    operators.push(operator);
    shape.push(operator && key !== "or" && key !== "and" ? `${key}=${operator}.?` : `${key}=?`);
  }
  return { querySummary: shape.join("&"), filterFields: fields, filterOperators: operators };
}

// The shared database boundary, traced. `options.trace = false` runs the
// request untraced (the telemetry store's own writes; a storage helper that
// is already its own operation); `options.trace = { name, reads, writes }`
// gives the operation a semantic name in place of the generic db.* one and
// names the stored values it reads and writes (the contract's lineage
// vocabulary); each part is optional.
//
// Attributes describe the query's structure: table, operation, the filter's
// field names and operators, status and row count. The filter's values and
// the bodies exchanged are the `database_request` / `database_response`
// snapshots, which detailed capture keeps and the redactor strips of
// credentials only.
async function serviceRequest(path, options = {}) {
  if (options.trace === false) return (await rawServiceRequest(path, options)).value;
  const meta = describe(path, options.method, options);
  const trace = options.trace && typeof options.trace === "object" ? options.trace : {};
  const name = trace.name ? String(trace.name) : meta.name;
  return telemetry.runOperation({
    name, type: "database", reads: trace.reads, writes: trace.writes,
    attributes: {
      "db.system.name": "postgrest",
      "db.operation.name": meta.name.split(".")[1],
      "db.collection.name": meta.table || undefined,
      "db.query.summary": meta.querySummary || undefined,
      "engelbart.db.rpc": meta.rpc || undefined,
      "engelbart.db.filter_fields": meta.filterFields.length ? meta.filterFields : undefined,
      "engelbart.db.filter_operators": meta.filterOperators.length ? meta.filterOperators : undefined,
      "http.request.method": meta.verb,
      "url.path": meta.pathname,
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
  describeQuery,
  insertRows,
  parseResponse,
  patchRows,
  rpc,
  selectOne,
  selectRows,
  serviceRequest,
  verifyUser,
};
