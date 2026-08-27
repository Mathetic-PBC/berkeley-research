# Engelbart LiteLLM proxy

The inference and metering data plane. Deployed on Railway as
`engelbart-litellm-production`; `config.yaml` here is the source of truth.

## Why the wildcard matters

Claude Code talks to the proxy through `ANTHROPIC_BASE_URL` and sends bare,
dated model ids — `claude-sonnet-4-5-20250929`, not `claude-sonnet-4-6`. A
`model_list` that names models explicitly rejects every one of them with a 400,
so a student key that looks valid still cannot run `claude`.

Two wildcard routes fix this permanently and mean no model list is ever pinned
again — on the proxy or on the keys. Student keys carry LiteLLM's
`all-proxy-models` wildcard (see `api/_lib/credits.js`), so they reach whatever
these routes serve.

## Environment

Set on the Railway service, never on Vercel:

- `ANTHROPIC_API_KEY` — the single funded Mathetic provider key
- `LITELLM_MASTER_KEY` — must equal the `LITELLM_MASTER_KEY` in Vercel
- `DATABASE_URL` — Supabase Postgres, for virtual keys and spend

## Apply

Push `config.yaml` to whatever the Railway service builds from, redeploy, then
confirm from this repo:

```sh
npm run verify:proxy
```

That mints nothing and spends a few tokens; it checks that `/v1/messages`,
`/v1/messages/count_tokens`, and the dated model ids Claude Code actually sends
all return 200.

## Money

Nothing in this repo or the admin UI adds money. Real spend is billed to the
Anthropic account that owns `ANTHROPIC_API_KEY`. The admin "credit pool" is an
allocation ceiling only — it stops the sum of student budgets exceeding a
number you choose, and it is **not** reconciled against the Anthropic balance.
Set the pool above what the account is funded for and LiteLLM will serve until
Anthropic hard-stops every student at once.
