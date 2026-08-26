"use strict";

const crypto = require("node:crypto");
const { encryptionKey } = require("./config");

function encryptSecret(value, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptSecret(value, env = process.env) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(env),
    Buffer.from(String(value.iv || ""), "base64url"),
  );
  decipher.setAuthTag(Buffer.from(String(value.tag || ""), "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(String(value.ciphertext || ""), "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function parsePasswordHash(encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (n !== 16384 || r !== 8 || p !== 1 || salt.length !== 16 || hash.length !== 32) return null;
  return { n, r, p, salt, hash };
}

function verifyPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const actual = crypto.scryptSync(String(password || ""), parsed.salt, parsed.hash.length, {
    N: parsed.n, r: parsed.r, p: parsed.p, maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, parsed.hash);
}

function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 14 || value.length > 256) {
    const error = new Error("Admin password must contain 14 to 256 characters");
    error.statusCode = 400;
    throw error;
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, 32, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text || "").toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret, timestamp = Date.now(), stepOffset = 0) {
  const counter = Math.floor(timestamp / 30_000) + stepOffset;
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(bytes).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

function verifyTotp(secret, candidate, timestamp = Date.now()) {
  const provided = Buffer.from(String(candidate || "").trim());
  if (!/^\d{6}$/.test(provided.toString())) return false;
  return [-1, 0, 1].some((offset) => {
    const expected = Buffer.from(totpCode(secret, timestamp, offset));
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function normalizeRecoveryCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-F0-9]/g, "");
}

function hashRecoveryCode(value) {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(value)).digest("base64url");
}

function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const compact = crypto.randomBytes(10).toString("hex").toUpperCase();
    return compact.match(/.{1,4}/g).join("-");
  });
}

module.exports = {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  parsePasswordHash,
  totpCode,
  verifyPassword,
  verifyTotp,
};
