// Checks that the LiteLLM proxy will actually serve Claude Code: the endpoints
// it calls, and the dated model ids it sends.
//
// This lives here rather than in Mathetic-PBC/engelbart-litellm on purpose. It
// is a check on the boundary, run with the same credentials Vercel uses, and it
// fails for two very different reasons: the proxy's config names models, or the
// proxy is serving an older build than the config in git. Only one of those is
// visible from inside the proxy repo.
//
//   npm run verify:proxy
//
// Reads LITELLM_BASE_URL and LITELLM_MASTER_KEY from the environment, or from
// a .env file pulled with `vercel env pull`.

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

// The ids Claude Code sends over ANTHROPIC_BASE_URL. Dated, and never the same
// strings as a hand-written model_list.
const CLAUDE_CODE_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-3-5-haiku-20241022",
  "claude-opus-4-1-20250805",
];

const env = loadEnv();
const base = env.LITELLM_BASE_URL.replace(/\/$/, "");
const headers = {
  Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
  "content-type": "application/json",
};

async function post(path, body) {
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, detail: text.slice(0, 180) };
  } catch (error) {
    return { ok: false, status: 0, detail: String(error.message || error) };
  }
}

const results = [];

for (const model of CLAUDE_CODE_MODELS) {
  const value = await post("/v1/messages", {
    model,
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  results.push({ name: `/v1/messages  ${model}`, ...value });
}

results.push({
  name: "/v1/messages/count_tokens",
  ...(await post("/v1/messages/count_tokens", {
    model: CLAUDE_CODE_MODELS[0],
    messages: [{ role: "user", content: "hi" }],
  })),
});

let failed = 0;
for (const result of results) {
  if (!result.ok) failed++;
  console.log(`${result.ok ? "ok  " : "FAIL"}  ${String(result.status).padEnd(4)} ${result.name}`);
  if (!result.ok) console.log(`        ${result.detail}`);
}

console.log(
  failed
    ? `\n${failed} of ${results.length} failed. 400s mean the running proxy still names models. Check Mathetic-PBC/engelbart-litellm: if config.yaml already has the two wildcard routes, then Railway has not deployed them and the fix is a redeploy, not an edit.`
    : `\nAll ${results.length} checks passed. Claude Code will work with a student key.`
);
process.exit(failed ? 1 : 0);
