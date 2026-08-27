"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_SESSION_SECONDS,
  hashedTokenFrom,
  issueSession,
  redeemLink,
} = require("../api/_lib/cli-session");

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

const USER = { id: "user-uuid", email: "Member@Example.com" };

// Answers the two hops in order: the admin link, then the redemption.
function scripted(overrides = {}) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method, headers: init.headers || {}, body });
      if (url.includes("/auth/v1/admin/generate_link")) {
        if (overrides.linkFails) {
          return { ok: false, status: 500, async text() { return JSON.stringify({ message: "no" }); } };
        }
        return {
          ok: true,
          status: 200,
          async text() { return JSON.stringify(overrides.link || { properties: { hashed_token: "hashed-abc" } }); },
        };
      }
      if (url.includes("/auth/v1/verify")) {
        if (overrides.verifyFails) {
          return { ok: false, status: 401, async json() { return { error_description: "Token has expired" }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return overrides.session || {
              access_token: "jwt-access",
              refresh_token: "refresh-SECRET",
              token_type: "bearer",
              expires_in: 3600,
              user: { id: "user-uuid", email: "member@example.com" },
            };
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
}

test("a hashed token is read from either shape GoTrue returns it in", () => {
  assert.equal(hashedTokenFrom({ hashed_token: "a" }), "a");
  assert.equal(hashedTokenFrom({ properties: { hashed_token: "b" } }), "b");
  assert.equal(hashedTokenFrom({}), "");
  assert.equal(hashedTokenFrom(null), "");
});

test("an installed CLI trades its own token for a Supabase session", async () => {
  const script = scripted();

  const result = await issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl, now: () => 1_700_000_000_000 });

  assert.equal(result.accessToken, "jwt-access");
  assert.equal(result.userId, "user-uuid");
  assert.equal(result.email, "member@example.com");
  assert.equal(result.expiresIn, 3600);
  assert.equal(result.expiresAt, 1_700_000_000 + 3600);
  // The project the caller should talk to travels with the session, so a CLI
  // never has to be told where its own database lives.
  assert.equal(result.url, "https://project.supabase.co");
  assert.equal(result.anonKey, "anon");
});

// The reason this endpoint exists rather than shipping the browser's session:
// a refresh token is full account access, for as long as nobody notices.
test("the refresh token never leaves the server", async () => {
  const script = scripted();

  const result = await issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl });

  assert.equal(JSON.stringify(result).includes("refresh-SECRET"), false);
  assert.equal(result.refreshToken, undefined);
  assert.equal(result.refresh_token, undefined);
});

test("no email is sent and the address is the one the token resolved to", async () => {
  const script = scripted();

  await issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl });

  const link = script.calls[0];
  assert.match(link.url, /\/auth\/v1\/admin\/generate_link$/);
  assert.equal(link.method, "POST");
  assert.deepEqual(link.body, { type: "magiclink", email: "Member@Example.com" });
  assert.equal(link.headers.Authorization, "Bearer service-role");
});

// Redemption is a public GoTrue route: it takes the anon key, not the service
// role, and sending the latter would be handing a secret to a route that has
// no use for it.
test("redemption presents the anon key rather than the service role", async () => {
  const script = scripted();

  await issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl });

  const verify = script.calls[1];
  assert.match(verify.url, /\/auth\/v1\/verify$/);
  assert.equal(verify.headers.apikey, "anon");
  assert.equal(verify.headers.Authorization, undefined);
  // Verified against the live GoTrue: `token` answers 400 validation_failed
  // without an address, while `token_hash` is the parameter that takes what
  // generate_link hands back.
  assert.deepEqual(verify.body, { type: "magiclink", token_hash: "hashed-abc" });
});

test("a lifetime longer than the ceiling is capped", async () => {
  const script = scripted({
    session: { access_token: "jwt", expires_in: 60 * 60 * 24, user: { id: "user-uuid", email: "m@example.com" } },
  });

  const result = await issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl, now: () => 0 });

  assert.equal(result.expiresIn, MAX_SESSION_SECONDS);
  assert.equal(result.expiresAt, MAX_SESSION_SECONDS);
});

test("an account with no address cannot be exchanged", async () => {
  await assert.rejects(
    () => issueSession({ id: "user-uuid" }, { env: ENV, fetchImpl: async () => { throw new Error("must not be called"); } }),
    /no address/,
  );
});

test("a link Supabase will not verify is an error, not an empty session", async () => {
  const script = scripted({ verifyFails: true });
  await assert.rejects(() => issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl }), /Token has expired/);
});

test("a link Supabase declines to mint is an error, not a blank token", async () => {
  const script = scripted({ link: { properties: {} } });
  await assert.rejects(() => issueSession(USER, { env: ENV, fetchImpl: script.fetchImpl }), /no verifiable link/);
});

test("a verify answer with no access token is refused", async () => {
  await assert.rejects(
    () => redeemLink("hashed", {
      env: ENV,
      async fetchImpl() { return { ok: true, status: 200, async json() { return { msg: "nothing here" }; } }; },
    }),
    /nothing here/,
  );
});
