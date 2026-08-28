# berkeley-research

Landing page for Mathetic's Berkeley research chats — served at **https://berkeley.mathetic.com**.

Static site with no build step:

- `/` — Berkeley research-chat landing page (`index.html`)
- `/engelbart` — Engelbart landing page and product demo
- `/engelbart/signin` — Supabase login and invite-only signup; the URL `bart auth` opens
- `/engelbart/admin` — password/TOTP-protected invite and credit administration
- `/api/engelbart-config` — browser-safe runtime configuration only
- `/api/engelbart-credentials` — authenticated, invite-entitled LiteLLM provisioning
- `/api/engelbart-device` — CLI device-authorization pairing (`start`, `approve`,
  `deny`, `poll`, `whoami`, `revoke`)

## Signing in the CLI

`npx engelbart-cli` never asks for a password. It starts a pairing session,
opens `/engelbart/signin?code=WXYZ-1234`, and polls while the member signs in and
approves that code on screen. Approval mints a CLI-scoped token — an opaque
`egb_` secret stored only as a SHA-256 digest — which the installer writes to
`~/.human-compact/auth.json` with mode `0600`.

Two secrets exist per pairing. The device code is held only by the CLI and is
never displayed; the user code is the only half that reaches the browser, so a
pairing link someone else sends cannot be approved without the member reading
the code their own terminal printed. Approval requires a browser session: an
already-installed CLI token is deliberately refused for that step.

`engelbart_touch_cli_token` rechecks `engelbart_members` on every use, so
removing a member closes their installed CLIs without hunting down each token.
Individual machines are revoked by their token row.

The Engelbart database migrations and activation instructions live in
`supabase/`. The application uses Vercel functions as the authenticated control
plane and a separate LiteLLM deployment as the inference/metering data plane.
One encrypted virtual key is stored per invited Supabase member; the Anthropic provider
key never reaches Vercel, Supabase, a browser, or the installer.

Invites are the credit entitlement. Accounts created through invite-only signup
already own one; legacy accounts must redeem an unused code on the authorization
page before a new LiteLLM key can be allocated. Existing provisioned keys remain
retrievable. Connecting a terminal without Mathetic credits remains available
for members who bring their own Claude access.

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
TOTP. After re-entering the password and a live TOTP code, the same encrypted
seed can be added to another authenticator app; those apps produce identical
codes and cannot be revoked independently. Enrollment produces eight one-time recovery codes; only their SHA-256
digests are stored, and redemption is serialized in Postgres. A password reset,
MFA enrollment, recovery-code replacement, or recovery-code use increments the
session generation and revokes every older admin cookie.

Do not deploy this branch partially. Apply the second migration, deploy a
healthy LiteLLM proxy, and add all server secrets before enabling
`LITELLM_BASE_URL`; that variable is the browser-visible feature gate.

## Source of truth

The static pages began as hand-flattened exports from the Claude Design project *Mathetic landing page design*:

- `index.html` ← `Mathetic Landing.dc.html`
- `engelbart/index.html` + `engelbart/styles.css` ← `Mathetic Demo.dc.html`
- `engelbart/demo.js` ← the ten-scene `engelbart-demo.jsx` product walkthrough, ported to native DOM animation

The design-canvas runtime (`support.js`, `image-slot.js`, React/Babel from unpkg) is not shipped; the
`<x-dc>` template, `style-hover` rules, and composition were flattened into plain HTML/CSS/JS.
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

`npm run verify:proxy` checks the live LiteLLM proxy from this side of the
boundary: it sends the dated model ids Claude Code actually uses
(`claude-sonnet-4-5-20250929`, not `claude-sonnet-4-6`) and asserts they come
back 200. A proxy whose `model_list` names models answers those with a 400, so
a student key can look perfectly healthy here and still fail on `claude`.

The proxy itself lives in **`Mathetic-PBC/engelbart-litellm`**, which Railway
builds from directly; its `config.yaml` is the only copy that takes effect.
Deliberately not duplicated here — a second copy is a copy that goes stale.
This repo holds only the control plane and the check.

`vercel dev` requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

## Hosting

- Vercel project `mathetic/berkeley-research`, git-linked to this repo; pushes to `main` deploy to production.
- Domain `berkeley.mathetic.com` is attached to the Vercel project.
- DNS lives in Cloudflare (zone `mathetic.com`): `berkeley` → CNAME to the Vercel-provided target, **DNS only** (grey cloud), same as `www`.
