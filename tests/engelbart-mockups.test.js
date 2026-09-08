"use strict";

// The mock-up endpoint: the bucket listed by id and name, each page served
// into a sandbox, and a member's placing checked against the bucket before
// it is written to their row and theirs alone.

const test = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../api/engelbart-mockups");
const Mockups = require("../api/_lib/mockups");

const ENV = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon-key-0000000000",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0000000000",
};
const ALICE = { id: "11111111-1111-1111-1111-111111111111", email: "alice@example.com" };
const BOB = { id: "22222222-2222-2222-2222-222222222222", email: "bob@example.com" };
const TOKENS = { "alice-token": ALICE, "bob-token": BOB };

const RAIL = "3acc7601-9cfb-4609-a2b5-50e8392a3efe";
const STEPPER = "e7df0047-4c44-4c7c-b56d-d5f485cf781c";
const DARK = "ca2053f6-fa1c-48be-ac9e-6cdcb5e81c36";
const TERMINAL = "a38ce56e-fba8-4166-bb58-ed54b3d3b9fa";
const BENTO = "b362033c-fa4a-45aa-a2dc-f5e9eca122d0";
const COVER = "99999999-9999-4999-8999-999999999999";
const OBJECTS = [
  { name: "01 Rail.html", id: RAIL, metadata: { mimetype: "text/html" } },
  { name: "02 Stepper.html", id: STEPPER, metadata: { mimetype: "text/html" } },
  { name: "03 Dark side.html", id: DARK, metadata: { mimetype: "text/plain" } },
  { name: "04 Terminal.html", id: TERMINAL, metadata: { mimetype: "text/html" } },
  { name: "05 Bento.html", id: BENTO, metadata: { mimetype: "text/html" } },
  { name: "drafts", id: null, metadata: null },
  { name: "cover.png", id: COVER, metadata: { mimetype: "image/png" } },
];
const PAGES = {
  "01 Rail.html": "<!doctype html><title>Rail</title><script>document.title='rail'</script>",
  "03 Dark side.html": "<!doctype html><title>Dark side</title>",
};

// Supabase in memory: auth by token, the members table, the bucket's listing
// and objects, and the rankings table with PostgREST's upsert.
function world() {
  const rows = [];
  const calls = [];
  const json = (value, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
    async text() { return value === null ? "" : JSON.stringify(value); }, async json() { return value; } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    calls.push({ url, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (u.hostname !== "project.supabase.co") throw new Error(`unrouted host ${url}`);
    if (u.pathname === "/auth/v1/user") {
      const user = TOKENS[String(init.headers.Authorization || "").replace(/^Bearer /, "")];
      return user ? json(user) : json({ message: "invalid JWT" }, 401);
    }
    if (u.pathname === "/rest/v1/engelbart_members") {
      const m = /user_id=eq\.([^&]+)/.exec(u.search);
      return json([{ user_id: decodeURIComponent(m[1]) }]);
    }
    if (u.pathname === "/storage/v1/object/list/mock-us" && method === "POST") return json(OBJECTS);
    if (u.pathname.startsWith("/storage/v1/object/mock-us/")) {
      const file = decodeURIComponent(u.pathname.slice("/storage/v1/object/mock-us/".length));
      if (!PAGES[file]) return json({ message: "Object not found" }, 404);
      return { ok: true, status: 200, headers: { get: () => null }, async text() { return PAGES[file]; } };
    }
    if (u.pathname === `/rest/v1/${Mockups.TABLE}`) {
      const m = /user_id=eq\.([^&]+)/.exec(u.search);
      const uid = m ? decodeURIComponent(m[1]) : null;
      if (method === "GET") return json(rows.filter((r) => r.user_id === uid));
      if (method === "POST") {
        assert.match(u.search, /on_conflict=user_id/, "a placing replaces the member's row");
        assert.match(String(init.headers.Prefer), /resolution=merge-duplicates/);
        const out = [];
        for (const r of JSON.parse(init.body)) {
          const at = rows.findIndex((x) => x.user_id === r.user_id);
          const row = at >= 0 ? { ...rows[at], ...r } : { created_at: "2026-09-08T00:00:00.000Z", ...r };
          if (at >= 0) rows[at] = row; else rows.push(row);
          out.push(row);
        }
        return json(out, 201);
      }
    }
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { rows, calls, options: { env: ENV, fetchImpl } };
}

function fakeRes() {
  return { headers: {}, statusCode: 0, payload: null, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; }, end(v) { this.body = v; return this; } };
}
function req(method, { token, url = "/api/engelbart-mockups", body } = {}) {
  return { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body || (method === "POST" ? {} : undefined) };
}
async function call(w, method, opts) {
  const res = fakeRes();
  await run(req(method, opts), res, w.options);
  return res;
}

const placing = (...ids) => ids.map((id) => ({ id }));

test("without a session nothing is listed or written", async () => {
  const w = world();
  const get = await call(w, "GET");
  assert.equal(get.statusCode, 401);
  const post = await call(w, "POST", { body: { top: placing(RAIL) } });
  assert.equal(post.statusCode, 401);
  const bad = await call(w, "GET", { token: "nobody-token" });
  assert.equal(bad.statusCode, 401);
  assert.ok(!w.calls.some((c) => c.url.includes("/storage/") || c.url.includes(Mockups.TABLE)));
  assert.equal(w.rows.length, 0);
});

test("the pages in the bucket are listed by id and name; folders and other files are not", async () => {
  const w = world();
  const res = await call(w, "GET", { token: "alice-token" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.mockups, [
    { id: RAIL, name: "01 Rail" }, { id: STEPPER, name: "02 Stepper" }, { id: DARK, name: "03 Dark side" },
    { id: TERMINAL, name: "04 Terminal" }, { id: BENTO, name: "05 Bento" },
  ]);
  assert.equal(res.payload.saved, null);
  const list = w.calls.find((c) => c.url.endsWith("/storage/v1/object/list/mock-us"));
  assert.equal(list.headers.Authorization, `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`);
});

test("a placing is checked against the bucket, named here, and written to the member's row only", async () => {
  const w = world();
  const picks = [
    { a: RAIL, b: STEPPER, winner: RAIL, at: "2026-09-08T01:02:03.000Z" },
    { a: DARK, b: TERMINAL, winner: TERMINAL, at: "not a time" },
  ];
  const res = await call(w, "POST", { token: "alice-token",
    body: { top: [{ id: BENTO, name: "spoofed" }, { id: RAIL }, TERMINAL, { id: STEPPER }], picks, entrants: 5 } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(res.payload.saved.top, [
    { rank: 1, id: BENTO, name: "05 Bento" }, { rank: 2, id: RAIL, name: "01 Rail" },
    { rank: 3, id: TERMINAL, name: "04 Terminal" }, { rank: 4, id: STEPPER, name: "02 Stepper" },
  ]);
  assert.equal(res.payload.saved.entrants, 5);
  assert.ok(res.payload.saved.updated_at);
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].user_id, ALICE.id);
  assert.deepEqual(w.rows[0].picks, [
    { a: RAIL, b: STEPPER, winner: RAIL, at: "2026-09-08T01:02:03.000Z" },
    { a: DARK, b: TERMINAL, winner: TERMINAL },
  ]);

  // Ranking again replaces the row; Bob's row is his own.
  const again = await call(w, "POST", { token: "alice-token", body: { top: placing(DARK, BENTO) } });
  assert.equal(again.statusCode, 200);
  assert.equal(w.rows.length, 1);
  assert.deepEqual(w.rows[0].top.map((t) => t.name), ["03 Dark side", "05 Bento"]);
  assert.equal(w.rows[0].entrants, 5, "unsaid, the bracket is taken to hold every mock-up");
  const bob = await call(w, "POST", { token: "bob-token", body: { top: placing(RAIL), entrants: 1 } });
  assert.equal(bob.statusCode, 200);
  assert.equal(w.rows.length, 2);
  assert.equal(w.rows[1].user_id, BOB.id);
  assert.equal(w.rows[1].entrants, 1);

  // Each member reads back their own.
  const mine = await call(w, "GET", { token: "alice-token" });
  assert.deepEqual(mine.payload.saved.top.map((t) => t.id), [DARK, BENTO]);
  const his = await call(w, "GET", { token: "bob-token" });
  assert.deepEqual(his.payload.saved.top.map((t) => t.id), [RAIL]);
});

test("a placing that names the wrong things is refused before anything is written", async () => {
  const w = world();
  const refused = async (body) => {
    const res = await call(w, "POST", { token: "alice-token", body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    return res.payload.error;
  };
  assert.match(await refused({ top: [] }), /one to 4/);
  assert.match(await refused({}), /one to 4/);
  assert.match(await refused({ top: placing(RAIL, STEPPER, DARK, TERMINAL, BENTO) }), /one to 4/);
  assert.match(await refused({ top: placing(RAIL, "not-an-id") }), /not in the bucket/);
  assert.match(await refused({ top: placing(RAIL, COVER) }), /not in the bucket/);
  assert.match(await refused({ top: placing(RAIL, RAIL) }), /twice/);
  assert.match(await refused({ top: placing(RAIL), picks: [{ a: RAIL, b: STEPPER, winner: DARK }] }), /pick/);
  assert.match(await refused({ top: placing(RAIL), picks: [{ a: RAIL, b: RAIL, winner: RAIL }] }), /pick/);
  assert.match(await refused({ top: placing(RAIL), picks: [{ a: RAIL, b: COVER, winner: RAIL }] }), /pick/);
  assert.equal(w.rows.length, 0);
  assert.ok(!w.calls.some((c) => c.method === "POST" && c.url.includes(Mockups.TABLE)));
});

test("a mock-up's HTML is served into a sandbox, by id, with no session", async () => {
  const w = world();
  const res = await call(w, "GET", { url: `/api/engelbart-mockups?html=${RAIL}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, PAGES["01 Rail.html"]);
  assert.equal(res.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(res.headers["Content-Security-Policy"], /^sandbox /);
  assert.doesNotMatch(res.headers["Content-Security-Policy"], /allow-same-origin/);
  assert.equal(res.headers["X-Frame-Options"], "SAMEORIGIN");
  assert.match(res.headers["Cache-Control"], /max-age=/);
  const read = w.calls.find((c) => c.url.includes("/storage/v1/object/mock-us/"));
  assert.equal(read.url, "https://project.supabase.co/storage/v1/object/mock-us/01%20Rail.html");
  assert.equal(read.headers.Authorization, `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.ok(!w.calls.some((c) => c.url.includes("/auth/")), "the frame carries no session, and none is asked for");

  // A page stored as text/plain is HTML all the same.
  const dark = await call(w, "GET", { url: `/api/engelbart-mockups?html=${DARK}` });
  assert.equal(dark.statusCode, 200);
  assert.equal(dark.headers["Content-Type"], "text/html; charset=utf-8");

  // Only what the listing names is read: an unknown id, a non-page, a folder.
  for (const id of ["nope", COVER, "drafts", ""]) {
    const miss = await call(w, "GET", { url: `/api/engelbart-mockups?html=${encodeURIComponent(id)}`, token: "alice-token" });
    assert.ok(id === "" ? miss.statusCode === 200 : miss.statusCode === 404, `${id}: ${miss.statusCode}`);
  }
  const gone = await call(w, "GET", { url: `/api/engelbart-mockups?html=${STEPPER}` });
  assert.equal(gone.statusCode, 502, "an object the listing names but storage cannot hand back");
});

test("the service-role key never leaves the function", async () => {
  const w = world();
  const seen = [];
  seen.push(await call(w, "GET", { token: "alice-token" }));
  seen.push(await call(w, "POST", { token: "alice-token", body: { top: placing(RAIL) } }));
  seen.push(await call(w, "GET", { url: `/api/engelbart-mockups?html=${RAIL}` }));
  seen.push(await call(w, "GET", { url: "/api/engelbart-mockups?html=nope" }));
  for (const res of seen) {
    const text = JSON.stringify(res.payload) + String(res.body) + JSON.stringify(res.headers);
    assert.ok(!text.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
  }
});
