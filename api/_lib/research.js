"use strict";

// Read access to the Berkeley research graph for the onboarding exploration.
// Thin wrappers over the SECURITY DEFINER RPCs added in
// 20260830120000_engelbart_research_read.sql: an interest resolves to a few
// research areas, an area to its labs, a lab to its people and work. All input
// is bounded here so nothing unvalidated reaches the database, and `options`
// (env / fetchImpl) is threaded through for tests, exactly like the rest of
// api/_lib.

const { rpc } = require("./supabase");

const MAX_INTEREST = 400;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanInterest(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, MAX_INTEREST);
}

function requireUuid(value, label) {
  const text = String(value == null ? "" : value).trim();
  if (!UUID_RE.test(text)) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

async function areas(interest, options = {}) {
  const rows = await rpc(
    "engelbart_research_areas",
    { p_interest: cleanInterest(interest), p_limit: 3 },
    options,
  );
  return Array.isArray(rows) ? rows : [];
}

async function labs(departmentId, interest, options = {}) {
  const rows = await rpc(
    "engelbart_research_labs",
    {
      p_department_id: requireUuid(departmentId, "department id"),
      p_interest: cleanInterest(interest),
      p_limit: 8,
    },
    options,
  );
  return Array.isArray(rows) ? rows : [];
}

async function lab(piId, options = {}) {
  const detail = await rpc(
    "engelbart_research_lab",
    { p_pi_id: requireUuid(piId, "lab id") },
    options,
  );
  // The function returns { pi: null, ... } for an unknown id; treat that as
  // "no such lab" rather than handing back a hollow object.
  return detail && detail.pi ? detail : null;
}

module.exports = { areas, labs, lab, cleanInterest, requireUuid, MAX_INTEREST };
