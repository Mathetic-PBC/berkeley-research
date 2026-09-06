"use strict";

// A member's own Anthropic key: checked before it is kept, kept encrypted,
// handed only to a model call, and shown back as four characters.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const MemberKeys = require("../api/_lib/member-keys");
const { resolveUpstream } = require("../api/_lib/upstream");

const ENV = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon-key-0000000000",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0000000000",
  ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
};
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };
const OTHER = { id: "22222222-2222-2222-2222-222222222222", email: "o@example.com" };
const KEY = "sk-ant-api03-" + "k".repeat(40) + "wxyz";

// The table behind PostgREST, in memory, and Anthropic's /v1/models answering
// with one status.
function world({ anthropic = 200 } = {}) {
  const rows = [];
  const calls = [];
  const json = (value, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
    async text() { return value === null ? "" : JSON.stringify(value); }, async json() { return value; } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    calls.push({ url, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (u.hostname === "api.anthropic.com") {
      return json(anthropic === 200 ? { data: [] }
        : { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, anthropic);
    }
    if (u.hostname === "project.supabase.co" && u.pathname === `/rest/v1/${MemberKeys.TABLE}`) {
      const m = /user_id=eq\.([^&]+)/.exec(u.search);
      const uid = m ? decodeURIComponent(m[1]) : null;
      if (method === "GET") return json(rows.filter((r) => r.user_id === uid));
      if (method === "POST") {
        for (const r of JSON.parse(init.body)) {
          const at = rows.findIndex((x) => x.user_id === r.user_id);
          if (at >= 0) rows[at] = { ...rows[at], ...r }; else rows.push({ created_at: "t", ...r });
        }
        return json(null, 201);
      }
      if (method === "DELETE") {
        for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].user_id === uid) rows.splice(i, 1);
        return json(null, 204);
      }
    }
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { rows, calls, options: { env: ENV, fetchImpl } };
}

test("a key is checked with Anthropic, kept encrypted, and answered as four characters", async () => {
  const w = world();
  const out = await MemberKeys.setKey(USER, `  ${KEY}  `, w.options);
  assert.deepEqual(out, { set: true, last4: "wxyz" });
  const check = w.calls.find((c) => c.url.startsWith("https://api.anthropic.com/v1/models"));
  assert.equal(check.headers["x-api-key"], KEY);
  assert.equal(check.headers["anthropic-version"], "2023-06-01");
  assert.equal(w.rows.length, 1);
  const row = w.rows[0];
  assert.equal(row.user_id, USER.id);
  assert.equal(row.provider, "anthropic");
  assert.equal(row.key_last4, "wxyz");
  assert.equal(JSON.stringify(row).includes(KEY), false, "the key itself is not in the row");
  // One row per member, so the write is an upsert on them.
  const write = w.calls.find((c) => c.method === "POST" && c.url.includes(MemberKeys.TABLE));
  assert.match(write.url, /on_conflict=user_id/);
  assert.deepEqual(await MemberKeys.status(USER, w.options), { set: true, last4: "wxyz", since: row.updated_at });
  // Set again: still one row, the new tail.
  await MemberKeys.setKey(USER, "sk-ant-api03-" + "n".repeat(40) + "abcd", w.options);
  assert.equal(w.rows.length, 1);
  assert.equal((await MemberKeys.status(USER, w.options)).last4, "abcd");
});

test("the kept key comes back only as model credentials, decrypted and marked for Anthropic", async () => {
  const w = world();
  await MemberKeys.setKey(USER, KEY, w.options);
  const creds = await MemberKeys.credentials(USER, w.options);
  assert.equal(creds.status, "own");
  assert.equal(creds.gateway, "anthropic");
  assert.equal(creds.apiKey, KEY);
  const up = resolveUpstream(creds, {});
  assert.equal(up.baseUrl, "https://api.anthropic.com");
  assert.equal(up.headers["x-api-key"], KEY);
  // Nobody else's key, and nothing for a member who brought none.
  assert.equal(await MemberKeys.credentials(OTHER, w.options), null);
  assert.deepEqual(await MemberKeys.status(OTHER, w.options), { set: false });
});

test("a key Anthropic refuses is not kept, nor one that does not look like a key", async () => {
  const w = world({ anthropic: 401 });
  await assert.rejects(MemberKeys.setKey(USER, KEY, w.options), (e) => e.statusCode === 400 && /did not accept/.test(e.message));
  assert.equal(w.rows.length, 0);
  await assert.rejects(MemberKeys.setKey(USER, "sk-proj-not-anthropic-0123456789", w.options), (e) => e.statusCode === 400 && /sk-ant-/.test(e.message));
  await assert.rejects(MemberKeys.setKey(USER, "", w.options), (e) => e.statusCode === 400);
  assert.equal(w.calls.filter((c) => c.url.includes("anthropic.com")).length, 1, "a malformed key is not even sent to Anthropic");
});

test("Anthropic being unreachable, or answering oddly, is a retry, not a kept or a lost key", async () => {
  const down = { env: ENV, fetchImpl: async () => { throw new Error("ECONNRESET"); } };
  await assert.rejects(MemberKeys.setKey(USER, KEY, down), (e) => e.statusCode === 502 && /could not be reached/.test(e.message));
  const odd = world({ anthropic: 529 });
  await assert.rejects(MemberKeys.setKey(USER, KEY, odd.options), (e) => e.statusCode === 502 && /529/.test(e.message));
  assert.equal(odd.rows.length, 0);
});

test("clearing the key puts the member back on the pool", async () => {
  const w = world();
  await MemberKeys.setKey(USER, KEY, w.options);
  assert.deepEqual(await MemberKeys.clearKey(USER, w.options), { set: false });
  assert.equal(w.rows.length, 0);
  assert.equal(await MemberKeys.credentials(USER, w.options), null);
});

test("a row that will not decrypt is a clear message, not a crash or a silent fallback to the pool", async () => {
  const w = world();
  await MemberKeys.setKey(USER, KEY, w.options);
  const rotated = { ...w.options, env: { ...ENV, ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url") } };
  await assert.rejects(MemberKeys.credentials(USER, rotated), (e) => e.statusCode === 409 && /remove it and add it again/.test(e.message));
});
