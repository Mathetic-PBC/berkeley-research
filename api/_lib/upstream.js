"use strict";

// Where a model call goes, and on whose key.
//
// Normally: the member's own LiteLLM key against the proxy, which meters it.
// Two things take precedence over that, both straight to Anthropic in its own
// headers: a key the member brought themselves (member-keys.js marks those
// credentials `gateway: "anthropic"`), and ENGELBART_ANTHROPIC_API_KEY set on
// the server, one key for every member. The server-wide one is a stopgap for
// when the proxy's upstream cannot answer (its Anthropic key out of credit,
// say): the member still needs a provisioned key and the credit gate and
// meter keep reading the proxy, but no request is metered per member and the
// proxy's own upstream key is never used.
//
// Neither direct key is a credential a client is handed. `credentialsFor`
// never produces them, so the browser and the CLI keep the member's LiteLLM
// key; they exist only in the headers of a model request, and telemetry
// redacts them there.

const ANTHROPIC_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const KEY_VAR = "ENGELBART_ANTHROPIC_API_KEY";

let warned = false;

function bypassKey(env) {
  return String((env && env[KEY_VAR]) || "").trim();
}

function direct(key) {
  return {
    gateway: "anthropic",
    baseUrl: ANTHROPIC_URL,
    apiKey: key,
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
  };
}

function resolveUpstream(credentials, env = process.env) {
  if (credentials && credentials.gateway === "anthropic") return direct(String(credentials.apiKey || ""));
  const key = bypassKey(env);
  if (!key) {
    return {
      gateway: "litellm",
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
    };
  }
  // Once per process, and only for the real environment: a deployment that
  // is quietly unmetered should say so in its logs.
  if (!warned && env === process.env) {
    warned = true;
    console.warn(`${KEY_VAR} is set: every member's model calls go straight to Anthropic on that one key, unmetered, instead of through LiteLLM.`);
  }
  return direct(key);
}

module.exports = { ANTHROPIC_URL, ANTHROPIC_VERSION, KEY_VAR, resolveUpstream };
