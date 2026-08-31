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

test("areas() calls the areas RPC with a cleaned interest and a fixed limit", async () => {
  const calls = [];
  const rows = [{ department_id: "d", area: "Chemistry", slug: "chemistry", n_labs: 3, rank: 0.2 }];
  const out = await Research.areas("  quantum   sensing  ", opts(rows, calls));
  assert.deepEqual(out, rows);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/engelbart_research_areas$/);
  assert.equal(calls[0].body.p_interest, "quantum sensing");   // whitespace collapsed
  assert.equal(calls[0].body.p_limit, 3);
});

test("labs() requires a valid department uuid before hitting the database", async () => {
  const calls = [];
  await assert.rejects(
    () => Research.labs("not-a-uuid", "photonics", opts([], calls)),
    (err) => err.statusCode === 400 && /department id/i.test(err.message),
  );
  assert.equal(calls.length, 0, "no request should be made for a bad id");
});

test("labs() forwards a valid uuid and cleaned interest", async () => {
  const calls = [];
  const id = "bbebea61-ad9e-4ed5-bd49-88895a0e0619";
  await Research.labs(id, "  neural  decoding ", opts([], calls));
  assert.equal(calls[0].body.p_department_id, id);
  assert.equal(calls[0].body.p_interest, "neural decoding");
  assert.equal(calls[0].body.p_limit, 8);
  assert.match(calls[0].url, /engelbart_research_labs$/);
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
