"use strict";

// Where a model call goes. Normally: the member's own LiteLLM key against the
// proxy, which meters it. With ENGELBART_ANTHROPIC_API_KEY set on the server:
// straight to Anthropic, on that one key, for every member. That is a stopgap
// for when the proxy's upstream cannot answer (its Anthropic key out of
// credit, say): the member still needs a provisioned key and the credit gate
// and meter keep reading the proxy, but no request is metered per member and
// the proxy's own upstream key is never used.
//
// The bypass key is a routing decision, not a credential. It is never part of
// what `credentialsFor` hands a browser or a terminal; it exists only in the
// headers of a model request, and telemetry redacts it there.

const ANTHROPIC_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const KEY_VAR = "ENGELBART_ANTHROPIC_API_KEY";

let warned = false;

function bypassKey(env) {
  return String((env && env[KEY_VAR]) || "").trim();
}

function resolveUpstream(credentials, env = process.env) {
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
  return {
    gateway: "anthropic",
    baseUrl: ANTHROPIC_URL,
    apiKey: key,
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
  };
}

module.exports = { ANTHROPIC_URL, ANTHROPIC_VERSION, KEY_VAR, resolveUpstream };
