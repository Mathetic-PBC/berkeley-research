"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ANTHROPIC_URL, ANTHROPIC_VERSION, resolveUpstream } = require("../api/_lib/upstream");

const CREDS = { apiKey: "sk-member-key", baseUrl: "https://proxy.example.com", models: ["all-proxy-models"] };

test("without a bypass key, a model call is the member's key against the proxy", () => {
  const up = resolveUpstream(CREDS, {});
  assert.equal(up.gateway, "litellm");
  assert.equal(up.baseUrl, "https://proxy.example.com");
  assert.equal(up.apiKey, "sk-member-key");
  assert.deepEqual(up.headers, { Authorization: "Bearer sk-member-key" });
  // Blank is unset, not a key.
  assert.equal(resolveUpstream(CREDS, { ENGELBART_ANTHROPIC_API_KEY: "   " }).gateway, "litellm");
});

test("with a bypass key, it is that key straight to Anthropic, in Anthropic's own headers", () => {
  const up = resolveUpstream(CREDS, { ENGELBART_ANTHROPIC_API_KEY: " sk-ant-own " });
  assert.equal(up.gateway, "anthropic");
  assert.equal(up.baseUrl, ANTHROPIC_URL);
  assert.equal(up.apiKey, "sk-ant-own");
  assert.deepEqual(up.headers, { "x-api-key": "sk-ant-own", "anthropic-version": ANTHROPIC_VERSION });
  // The member's key goes nowhere: it is not sent, and not even carried.
  assert.equal(JSON.stringify(up).includes("sk-member-key"), false);
});
