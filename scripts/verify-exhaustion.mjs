// Checks the four things the credit-exhaustion recovery path assumes about
// LiteLLM. Every one of them is a claim about how the proxy behaves, and every
// one was taken from documentation rather than from a request -- which is
// exactly the kind of assumption that holds in a unit test with a stub in it
// and then does not hold in production.
//
// The load-bearing one is the first. Claude Code re-runs an apiKeyHelper when
// a request comes back 401 and for no other status. A key that has merely
// spent its budget answers 400 or 429, which nothing reacts to, so the server
// blocks an exhausted key to turn it into a 401. If a blocked key does not in
// fact answer 401, members sit on a dead key until the helper's cache expires
// instead of recovering on the next request.
//
//   npm run verify:exhaustion
//
// Reads LITELLM_BASE_URL and LITELLM_MASTER_KEY from the environment, or from
// a .env file pulled with `vercel env pull`. Creates a throwaway key with a
// one-cent budget and deletes it again.

import { readFileSync } from "node:fs";

function loadEnv() {
  const env = { ...process.env };
  if (!env.LITELLM_BASE_URL || !env.LITELLM_MASTER_KEY) {
    for (const file of [".env.local", ".env"]) {
      try {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
          if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^"|"$/g, "");
        }
      } catch { /* file is optional */ }
    }
  }
  if (!env.LITELLM_BASE_URL || !env.LITELLM_MASTER_KEY) {
    console.error("Set LITELLM_BASE_URL and LITELLM_MASTER_KEY, or run `vercel env pull .env.local`.");
    process.exit(2);
  }
  return env;
}

const env = loadEnv();
const base = env.LITELLM_BASE_URL.replace(/\/$/, "");
const admin = {
  Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
  "content-type": "application/json",
};

async function call(path, { method = "POST", body, headers = admin } = {}) {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { ok: response.ok, status: response.status, value, detail: String(text).slice(0, 180) };
  } catch (error) {
    return { ok: false, status: 0, value: null, detail: String(error.message || error) };
  }
}

const results = [];
function record(name, ok, status, detail = "") {
  results.push({ name, ok, status, detail });
}

// A throwaway user, so the key's own cap is the only thing under test and the
// real pool is untouched.
const userId = `verify-exhaustion-${Date.now()}`;
await call("/user/new", {
  body: { user_id: userId, user_role: "internal_user", max_budget: 1, auto_create_key: false },
});

// 2. Does /key/generate accept budget_duration? This is the knob that stops an
//    exhausted key being permanently exhausted.
const created = await call("/key/generate", {
  body: {
    user_id: userId,
    key_alias: userId,
    models: ["all-proxy-models"],
    max_budget: 0.01,
    budget_duration: "30d",
    key_type: "llm_api",
  },
});
record("/key/generate accepts budget_duration", created.ok, created.status, created.detail);

const key = created.value && (created.value.key || created.value.token);
if (!key) {
  console.log("FAIL  could not mint a test key; nothing else can be checked.");
  console.log(`      ${created.detail}`);
  process.exit(1);
}

// 3. Does /user/update accept the same? Members are capped at the user level
//    as well as the key level, and LiteLLM spends against the lower of the two.
const userUpdate = await call("/user/update", {
  body: { user_id: userId, max_budget: 2, budget_duration: "30d" },
});
record("/user/update accepts max_budget + budget_duration", userUpdate.ok, userUpdate.status, userUpdate.detail);

// 4. Informational: does /key/info report `blocked`? The code no longer
//    depends on it -- absent is treated as unknown and the state is asserted
//    anyway -- but knowing means knowing whether that costs a call per poll.
const blockedNow = await call("/key/block", { body: { key } });
const info = await call(`/key/info?key=${encodeURIComponent(key)}`, { method: "GET" });
const infoBody = (info.value && (info.value.info || info.value)) || {};
const reportsBlocked = typeof infoBody.blocked === "boolean";
record(
  `/key/info reports blocked (informational: ${reportsBlocked ? "yes" : "no, one extra call per poll"})`,
  info.ok,
  info.status,
  info.detail,
);

// 1. The one everything rests on: a blocked key must answer 401, because that
//    is the only status Claude Code re-runs a credential helper for.
const asMember = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
const blockedCall = await call("/v1/messages", {
  headers: asMember,
  body: { model: "claude-sonnet-4-5-20250929", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
});
record(
  "a blocked key answers 401 (Claude Code re-runs the helper)",
  blockedCall.status === 401,
  blockedCall.status,
  blockedCall.status === 401 ? "" : `got ${blockedCall.status}: ${blockedCall.detail}`,
);

// And that unblocking puts it back, which is what a top-up depends on.
await call("/key/unblock", { body: { key } });
const unblocked = await call("/v1/messages", {
  headers: asMember,
  body: { model: "claude-sonnet-4-5-20250929", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
});
record(
  "unblocking restores the key (a top-up takes effect)",
  unblocked.status !== 401,
  unblocked.status,
  unblocked.status === 401 ? `still 401: ${unblocked.detail}` : "",
);

await call("/key/delete", { body: { keys: [key] } });
await call("/user/delete", { body: { user_ids: [userId] } });

let failed = 0;
for (const result of results) {
  if (!result.ok) failed++;
  console.log(`${result.ok ? "ok  " : "FAIL"}  ${String(result.status).padEnd(4)} ${result.name}`);
  if (!result.ok && result.detail) console.log(`        ${result.detail}`);
}

console.log(
  failed
    ? `\n${failed} of ${results.length} failed. If the 401 check is one of them, an exhausted key will not`
      + `\nmake Claude Code re-run its credential helper, and members will sit on a dead key until the`
      + `\nhelper's cache expires rather than recovering on their next request. That is a correctness`
      + `\nproblem in the recovery path, not a configuration nit.`
    : `\nAll ${results.length} checks passed. Exhaustion recovery will behave as the server code assumes.`
);
process.exit(failed ? 1 : 0);
