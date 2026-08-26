"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  totpCode,
  verifyPassword,
  verifyTotp,
} = require("../api/_lib/crypto");
const { beginMfa, createSession, parseSession } = require("../api/_lib/admin-auth");

const ENV = {
  ENGELBART_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
  ENGELBART_ADMIN_SESSION_SECRET: "a-session-secret-with-more-than-thirty-two-bytes",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

test("encrypts credentials with authenticated encryption", () => {
  const encrypted = encryptSecret("sk-user-secret", ENV);
  assert.equal(decryptSecret(encrypted, ENV), "sk-user-secret");
  assert.equal(JSON.stringify(encrypted).includes("sk-user-secret"), false);
  assert.throws(() => decryptSecret({ ...encrypted, tag: Buffer.alloc(16).toString("base64url") }, ENV));
});

test("hashes admin passwords and compares them without retaining plaintext", () => {
  const encoded = hashPassword("a sufficiently long admin password");
  assert.match(encoded, /^scrypt\$16384\$8\$1\$/);
  assert.equal(encoded.includes("sufficiently"), false);
  assert.equal(verifyPassword("a sufficiently long admin password", encoded), true);
  assert.equal(verifyPassword("not the password", encoded), false);
  assert.throws(() => hashPassword("too short"), /14 to 256/);
});

test("TOTP accepts the current step and adjacent clock-skew steps only", () => {
  const secret = newTotpSecret();
  const now = Date.UTC(2026, 7, 26, 12, 0, 0);
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.equal(verifyTotp(secret, totpCode(secret, now), now), true);
  assert.equal(verifyTotp(secret, totpCode(secret, now - 30_000), now), true);
  assert.equal(verifyTotp(secret, totpCode(secret, now - 60_000), now), false);
  assert.equal(verifyTotp(secret, "12345", now), false);
});

test("recovery codes are high-entropy, normalized, and stored only as hashes", () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes) {
    assert.match(code, /^(?:[A-F0-9]{4}-){4}[A-F0-9]{4}$/);
    const digest = hashRecoveryCode(code);
    assert.equal(digest.includes(code), false);
    assert.equal(hashRecoveryCode(code.toLowerCase().replaceAll("-", " ")), digest);
  }
});

test("admin sessions are signed, expire, and carry the password generation", () => {
  const now = Date.UTC(2026, 7, 26, 12, 0, 0);
  const token = createSession(4, { env: ENV, now });
  assert.equal(parseSession(token, { env: ENV, now }).generation, 4);
  assert.equal(parseSession(token + "damage", { env: ENV, now }), null);
  assert.equal(parseSession(token, { env: ENV, now: now + 9 * 60 * 60 * 1000 }), null);
});

test("enabled MFA cannot be overwritten by beginning a new enrollment", async () => {
  let calls = 0;
  await assert.rejects(beginMfa({
    env: ENV,
    async fetchImpl() {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify([{ totp_enabled: true }]); },
      };
    },
  }), /already enabled/);
  assert.equal(calls, 1);
});
