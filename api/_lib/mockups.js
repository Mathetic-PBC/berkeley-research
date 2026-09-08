"use strict";

// The design mock-ups in the `mock-us` storage bucket, and each member's
// placing of them. A mock-up is one HTML object in the bucket: its id is the
// storage object's id, and its name is the file name without the extension.
// The bucket is read with the service role, whether or not it is public, and
// each mock-up's HTML is handed to the page to draw in a sandboxed frame --
// the objects are served as text/plain from storage, and their scripts must
// not run on the page's origin either way.
//
// One row per member in engelbart_mockup_rankings, replaced when they rank
// again: the top four as [{rank, id, name}], every pick they made, and how
// many mock-ups were in the bracket. Only the service role touches the
// table; the browser reaches it through /api/engelbart-mockups.

const { supabaseConfig } = require("./config");
const { insertRows, selectOne, serviceRequest } = require("./supabase");

const BUCKET = "mock-us";
const TABLE = "engelbart_mockup_rankings";
const PLACES = 4;
const LIST_LIMIT = 500;
const MAX_PICKS = 1000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const RANKING_COLUMNS = "user_id,top,entrants,created_at,updated_at";

function bucket(env) {
  return String((env || process.env).ENGELBART_MOCKUPS_BUCKET || "").trim() || BUCKET;
}

// Listing and ranking are not part of any onboarding run; they leave no trace.
function quiet(options) {
  return { ...options, trace: false };
}

function refuse(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function byUser(user) {
  return `user_id=eq.${encodeURIComponent(user.id)}`;
}

// Every HTML object in the bucket, by name. Folders (no id) and anything
// that is not a page are left out.
async function listMockups(options = {}) {
  const value = await serviceRequest(`/storage/v1/object/list/${bucket(options.env)}`, {
    ...quiet(options),
    method: "POST",
    body: { prefix: "", limit: LIST_LIMIT, offset: 0, sortBy: { column: "name", order: "asc" } },
  });
  return (Array.isArray(value) ? value : [])
    .filter((o) => o && o.id && /\.html?$/i.test(String(o.name || "")))
    .map((o) => ({ id: String(o.id), name: String(o.name).replace(/\.html?$/i, ""), file: String(o.name) }));
}

// One mock-up's HTML, by id. Only an object the listing names is read, so
// this serves the bucket's pages and nothing else.
async function readMockup(id, options = {}) {
  const mockups = await listMockups(options);
  const hit = mockups.find((m) => m.id === String(id || ""));
  if (!hit) throw refuse("No such mock-up", 404);
  const env = options.env || process.env;
  const config = supabaseConfig(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${config.url}/storage/v1/object/${bucket(env)}/${encodeURI(hit.file)}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: options.signal,
  });
  if (!response.ok) throw refuse("The mock-up could not be read", 502);
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw refuse("That mock-up is too large to serve", 413);
  return { id: hit.id, name: hit.name, file: hit.file, html };
}

function publicRanking(row) {
  if (!row) return null;
  return {
    top: Array.isArray(row.top) ? row.top : [],
    entrants: Number(row.entrants) || 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadRanking(user, options = {}) {
  const row = await selectOne(TABLE, `${byUser(user)}&select=${RANKING_COLUMNS}`, quiet(options));
  return row && row.user_id === user.id ? publicRanking(row) : null;
}

// The placing the page sends: one to four mock-up ids, first to fourth, each
// in the bucket and none twice; and the picks, each between two mock-ups in
// the bucket with the winner one of them. Names are looked up here, never
// trusted from the request.
function checkPlacing(body, byId) {
  const rawTop = Array.isArray(body && body.top) ? body.top : [];
  if (!rawTop.length || rawTop.length > PLACES) throw refuse(`The placing names one to ${PLACES} mock-ups`, 400);
  const seen = new Set();
  const top = [];
  for (const entry of rawTop) {
    const id = String((entry && typeof entry === "object" ? entry.id : entry) || "");
    const mockup = byId.get(id);
    if (!mockup) throw refuse("The placing names a mock-up that is not in the bucket", 400);
    if (seen.has(id)) throw refuse("The placing names a mock-up twice", 400);
    seen.add(id);
    top.push({ rank: top.length + 1, id, name: mockup.name });
  }
  const rawPicks = Array.isArray(body.picks) ? body.picks : [];
  if (rawPicks.length > MAX_PICKS) throw refuse("Too many picks", 400);
  const picks = rawPicks.map((p) => {
    const a = String((p && p.a) || "");
    const b = String((p && p.b) || "");
    const winner = String((p && p.winner) || "");
    if (!byId.has(a) || !byId.has(b) || a === b || (winner !== a && winner !== b)) {
      throw refuse("A pick names mock-ups that are not in the bucket", 400);
    }
    const at = p && typeof p.at === "string" && !Number.isNaN(Date.parse(p.at)) ? new Date(p.at).toISOString() : null;
    return at ? { a, b, winner, at } : { a, b, winner };
  });
  const entrants = Number.isInteger(body.entrants) && body.entrants >= top.length ? Math.min(body.entrants, byId.size) : byId.size;
  return { top, picks, entrants };
}

async function saveRanking(user, body, options = {}) {
  const mockups = await listMockups(options);
  const byId = new Map(mockups.map((m) => [m.id, m]));
  const { top, picks, entrants } = checkPlacing(body || {}, byId);
  const updated_at = new Date().toISOString();
  const rows = await insertRows(TABLE, [{ user_id: user.id, top, picks, entrants, updated_at }], {
    ...quiet(options), query: "on_conflict=user_id", prefer: "resolution=merge-duplicates,return=representation",
  });
  const row = Array.isArray(rows) && rows[0] ? rows[0] : { top, entrants, updated_at };
  return publicRanking(row);
}

module.exports = {
  BUCKET,
  MAX_HTML_BYTES,
  PLACES,
  TABLE,
  bucket,
  checkPlacing,
  listMockups,
  loadRanking,
  readMockup,
  saveRanking,
};
