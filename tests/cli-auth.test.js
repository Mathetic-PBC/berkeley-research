"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const CliAuth = require("../api/_lib/cli-auth");
const shared = require("../engelbart/shared.js");

const SUPABASE_ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

function respondWith(value, capture) {
  return async function fetchImpl(url, options) {
    if (capture) capture.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return { ok: true, status: 200, async text() { return JSON.stringify(value); } };
  };
}

test("pairing codes avoid the characters people mistype off a screen", () => {
  for (const banned of ["I", "L", "O", "U", "0", "1"]) {
    assert.equal(CliAuth.USER_CODE_ALPHABET.includes(banned), false, `alphabet contains ${banned}`);
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    assert.match(CliAuth.newUserCode(), /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
  }
});

// The browser normalizes what was typed and the function normalizes what
// arrives; if they ever disagree a correctly typed code reads as unknown.
test("browser and server normalize a pairing code identically", () => {
  const inputs = ["wxyz1234", "WXYZ-1234", " wxyz 1234 ", "wxyz-1234-", "WX", "", "wxyz12345"];
  for (const input of inputs) {
    assert.equal(CliAuth.normalizeUserCode(input), shared.normalizeUserCode(input), input);
    assert.equal(CliAuth.isPlausibleUserCode(input), shared.isPlausibleUserCode(input), input);
  }
  assert.equal(CliAuth.normalizeUserCode("wxyz1234"), "WXYZ-1234");
  assert.equal(CliAuth.isPlausibleUserCode("WXYZ"), false);
});

test("secrets are accepted only with their own prefix and a real length", () => {
  const token = `${CliAuth.TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  assert.equal(CliAuth.requireSecret(token, CliAuth.TOKEN_PREFIX, "Token"), token);
  assert.throws(() => CliAuth.requireSecret(token, CliAuth.DEVICE_CODE_PREFIX, "Device code"), /malformed/);
  assert.throws(() => CliAuth.requireSecret(`${CliAuth.TOKEN_PREFIX}short`, CliAuth.TOKEN_PREFIX, "Token"), /malformed/);
  assert.throws(() => CliAuth.requireSecret("", CliAuth.TOKEN_PREFIX, "Token"), /missing/);
});

test("machine labels are bounded and stripped before they are stored", () => {
  assert.equal(CliAuth.cleanLabel("  laptop.local  "), "laptop.local");
  assert.equal(CliAuth.cleanLabel("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(CliAuth.cleanLabel("x".repeat(500)).length, 100);
});

test("starting a session stores only digests and returns both halves once", async () => {
  const calls = [];
  const result = await CliAuth.startSession({ label: "laptop.local" }, {
    env: SUPABASE_ENV,
    origin: "https://berkeley.mathetic.com",
    fetchImpl: respondWith({ id: "session-uuid", user_code: "WXYZ-1234" }, calls),
  });
  assert.match(calls[0].url, /rpc\/engelbart_start_cli_session$/);
  assert.equal(calls[0].body.p_client_label, "laptop.local");
  assert.equal(calls[0].body.p_ttl_seconds, CliAuth.SESSION_TTL_SECONDS);
  // The device code is the CLI's secret; only its digest is ever sent.
  assert.equal(Object.values(calls[0].body).includes(result.deviceCode), false);
  assert.equal(calls[0].body.p_device_code_hash, CliAuth.hashSecret(result.deviceCode));
  assert.equal(calls[0].body.p_user_code, result.userCode);
  assert.ok(result.deviceCode.startsWith(CliAuth.DEVICE_CODE_PREFIX));
  assert.equal(
    result.verificationUrlComplete,
    `https://berkeley.mathetic.com/engelbart/signin?code=${result.userCode}`,
  );
});

test("polling reports every terminal state without raising", async () => {
  for (const status of ["pending", "denied", "expired"]) {
    const result = await CliAuth.pollSession(`${CliAuth.DEVICE_CODE_PREFIX}${"a".repeat(43)}`, {
      env: SUPABASE_ENV,
      fetchImpl: respondWith({ status }),
    });
    assert.equal(result.status, status);
    assert.equal(result.token, undefined);
  }
  const slow = await CliAuth.pollSession(`${CliAuth.DEVICE_CODE_PREFIX}${"a".repeat(43)}`, {
    env: SUPABASE_ENV,
    fetchImpl: respondWith({ status: "slow_down" }),
  });
  assert.equal(slow.intervalSeconds, CliAuth.POLL_INTERVAL_SECONDS * 2);
});

test("a claimed session hands back a token whose digest is what was stored", async () => {
  const calls = [];
  const result = await CliAuth.pollSession(`${CliAuth.DEVICE_CODE_PREFIX}${"a".repeat(43)}`, {
    env: SUPABASE_ENV,
    fetchImpl: respondWith({ status: "ready", email: "member@example.com" }, calls),
  });
  assert.equal(result.status, "ready");
  assert.ok(result.token.startsWith(CliAuth.TOKEN_PREFIX));
  assert.equal(calls[0].body.p_token_hash, CliAuth.hashSecret(result.token));
  assert.equal(result.email, "member@example.com");
});

test("approval refuses a code that is not a code before it reaches Postgres", async () => {
  await assert.rejects(
    CliAuth.resolveSession("nope", { id: "user-uuid", email: "m@example.com" }, true, {
      env: SUPABASE_ENV,
      fetchImpl() { throw new Error("must not reach Supabase"); },
    }),
    /not valid/,
  );
});

test("an already answered code is a conflict, an unknown one is not found", async () => {
  await assert.rejects(
    CliAuth.resolveSession("WXYZ-1234", { id: "u", email: "m@example.com" }, true, {
      env: SUPABASE_ENV,
      fetchImpl: respondWith({ resolved: false, reason: "already_resolved" }),
    }),
    (error) => error.statusCode === 409 && /already used/.test(error.message),
  );
  await assert.rejects(
    CliAuth.resolveSession("WXYZ-1234", { id: "u", email: "m@example.com" }, true, {
      env: SUPABASE_ENV,
      fetchImpl: respondWith({ resolved: false, reason: "not_found" }),
    }),
    (error) => error.statusCode === 404,
  );
});

test("CLI tokens and browser sessions reach the same authenticated endpoints", async () => {
  const calls = [];
  const cliUser = await CliAuth.verifyPrincipal(`${CliAuth.TOKEN_PREFIX}${"b".repeat(43)}`, {
    env: SUPABASE_ENV,
    fetchImpl: respondWith({ valid: true, user_id: "user-uuid", email: "Member@Example.com" }, calls),
  });
  assert.match(calls[0].url, /rpc\/engelbart_touch_cli_token$/);
  assert.deepEqual(cliUser, { id: "user-uuid", email: "member@example.com" });

  // Anything without the CLI prefix is still verified as a Supabase JWT.
  const jwtCalls = [];
  await assert.rejects(CliAuth.verifyPrincipal("header.payload.signature", {
    env: SUPABASE_ENV,
    async fetchImpl(url) {
      jwtCalls.push(url);
      return { ok: false, status: 401, async text() { return "{}"; }, async json() { return {}; } };
    },
  }));
  assert.match(jwtCalls[0], /\/auth\/v1\/user$/);
});

test("a revoked or unknown CLI token is rejected, not treated as anonymous", async () => {
  await assert.rejects(
    CliAuth.verifyCliToken(`${CliAuth.TOKEN_PREFIX}${"b".repeat(43)}`, {
      env: SUPABASE_ENV,
      fetchImpl: respondWith({ valid: false }),
    }),
    (error) => error.statusCode === 401,
  );
});
