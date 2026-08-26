const test = require("node:test");
const assert = require("node:assert/strict");
const { readPublicConfig } = require("../api/engelbart-config.js");

test("returns only browser-safe configuration", () => {
  const config = readPublicConfig({
    SUPABASE_URL: "https://example.supabase.co/",
    SUPABASE_ANON_KEY: "public-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
    LITELLM_MASTER_KEY: "must-not-leak-either",
  });

  assert.deepEqual(config, {
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "public-anon-key",
    creditsEnabled: false,
  });
  assert.equal(JSON.stringify(config).includes("must-not-leak"), false);
});

test("fails closed when public Supabase configuration is incomplete", () => {
  assert.equal(readPublicConfig({ SUPABASE_URL: "https://example.supabase.co" }), null);
  assert.equal(readPublicConfig({ SUPABASE_ANON_KEY: "public-anon-key" }), null);
});
