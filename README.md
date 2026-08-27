# berkeley-research

Landing page for Mathetic's Berkeley research chats — served at **https://berkeley.mathetic.com**.

Static site with no build step:

- `/` — Berkeley research-chat landing page (`index.html`)
- `/engelbart` — Engelbart landing page and product demo
- `/engelbart/signin` — Supabase login and invite-only signup; the URL `bart auth` opens
- `/engelbart/admin` — password/TOTP-protected invite and credit administration
- `/api/engelbart-config` — browser-safe runtime configuration only
- `/api/engelbart-credentials` — authenticated per-member LiteLLM provisioning
- `litellm/` — the proxy's `config.yaml`, deployed separately on Railway

The Engelbart database migrations and activation instructions live in
`supabase/`. The application uses Vercel functions as the authenticated control
plane and a separate LiteLLM deployment as the inference/metering data plane.
One encrypted virtual key is stored per Supabase member; the Anthropic provider
key never reaches Vercel, Supabase, a browser, or the installer.

## Server configuration

Production and preview deployments require:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LITELLM_BASE_URL`
- `LITELLM_MASTER_KEY`
- `ENGELBART_CREDENTIAL_KEY` — exactly 32 random bytes, base64url encoded
- `ENGELBART_ADMIN_SESSION_SECRET` — at least 32 random bytes

The bootstrap admin code exists in the migration only as a salted scrypt
digest. Reset it from `/engelbart/admin` after the first login, then enroll
TOTP. Enrollment produces eight one-time recovery codes; only their SHA-256
digests are stored, and redemption is serialized in Postgres. A password reset,
MFA enrollment, recovery-code replacement, or recovery-code use increments the
session generation and revokes every older admin cookie.

Do not deploy this branch partially. Apply the second migration, deploy a
healthy LiteLLM proxy, and add all server secrets before enabling
`LITELLM_BASE_URL`; that variable is the browser-visible feature gate.

## Source of truth

Compiled by hand from the Claude Design project *Mathetic landing page design*:

- `index.html` ← `Mathetic Landing.dc.html`
- `engelbart/index.html` + `engelbart/demo.js` ← `Mathetic Demo.dc.html`

The design-canvas runtime (`support.js`, `image-slot.js`, React/Babel from unpkg) is not shipped; the
`<x-dc>` template, `style-hover`, and `DCLogic` component were flattened into plain HTML/CSS/JS.
To update copy or layout, edit those files directly (or re-export from the design and re-flatten).

Shipping the runtime instead was rejected on the Engelbart CSP: `support.js` compiles the
`<script data-dc-script>` body with `new Function` (needs `'unsafe-eval'`), injects React/ReactDOM
and Babel from `unpkg.com`, `fetch`es its own page URL at boot, registers an unauthenticated
`message` listener, and injects global CSS that rewrites `html`/`body` layout and `@media print`.

## Local verification

```sh
npm test
npm run check
vercel dev
```

`npm run verify:proxy` checks the live LiteLLM proxy against the dated model ids
Claude Code actually sends (`claude-sonnet-4-5-20250929`, not
`claude-sonnet-4-6`). A pinned `model_list` answers those with a 400, so a
student key can look healthy and still fail on `claude`. See `litellm/README.md`.

`vercel dev` requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

## Hosting

- Vercel project `mathetic/berkeley-research`, git-linked to this repo; pushes to `main` deploy to production.
- Domain `berkeley.mathetic.com` is attached to the Vercel project.
- DNS lives in Cloudflare (zone `mathetic.com`): `berkeley` → CNAME to the Vercel-provided target, **DNS only** (grey cloud), same as `www`.
