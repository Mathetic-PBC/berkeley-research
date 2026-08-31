"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Research = require("../api/_lib/research");

const SUPABASE_ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

// Captures each RPC call and replays a canned result, the same shape the real
// PostgREST endpoint returns for these functions.
function respondWith(value, capture) {
  return async function fetchImpl(url, options) {
    if (capture) capture.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, async text() { return JSON.stringify(value); } };
  };
}

function opts(value, capture) {
  return { env: SUPABASE_ENV, fetchImpl: respondWith(value, capture) };
}

test("labMatches() calls the retrieval RPC with a cleaned interest and a fixed limit", async () => {
  const calls = [];
  const rows = [{ pi_id: "p1", pi_name: "Preeya Khanna", lab_name: "SNE Lab", rank: 0.3 }];
  const out = await Research.labMatches("  neural   decoding  ", opts(rows, calls));
  assert.deepEqual(out, rows);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/engelbart_research_lab_matches$/);
  assert.equal(calls[0].body.p_interest, "neural decoding");   // whitespace collapsed
  assert.equal(calls[0].body.p_limit, 15);
});

test("labMatches() returns [] when the RPC yields no array", async () => {
  const out = await Research.labMatches("obscure", opts(null));
  assert.deepEqual(out, []);
});

test("lab() returns the detail when the PI exists", async () => {
  const detail = { pi: { id: "x", name: "Adam Yala" }, members: [], projects: [] };
  const out = await Research.lab("09248f57-6e82-4d85-ac71-c756bfcb3509", opts(detail));
  assert.deepEqual(out, detail);
});

test("lab() maps an unknown id (pi:null) to null rather than a hollow object", async () => {
  const out = await Research.lab(
    "09248f57-6e82-4d85-ac71-c756bfcb3509",
    opts({ pi: null, members: [], projects: [] }),
  );
  assert.equal(out, null);
});

test("lab() rejects a malformed id without a request", async () => {
  const calls = [];
  await assert.rejects(
    () => Research.lab("nope", opts(null, calls)),
    (err) => err.statusCode === 400,
  );
  assert.equal(calls.length, 0);
});

test("cleanInterest caps length and collapses whitespace", () => {
  assert.equal(Research.cleanInterest("  a\n b   c "), "a b c");
  assert.equal(Research.cleanInterest("x".repeat(1000)).length, Research.MAX_INTEREST);
  assert.equal(Research.cleanInterest(null), "");
});
