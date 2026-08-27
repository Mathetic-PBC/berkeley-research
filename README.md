# berkeley-research

Landing page for Mathetic's Berkeley research chats — served at **https://berkeley.mathetic.com**.

Static site with no build step:

- `/` — Berkeley research-chat landing page (`index.html`)
- `/engelbart` — Supabase login and invite-only signup
- `/engelbart/admin` — password/TOTP-protected invite and credit administration
- `/api/engelbart-config` — browser-safe runtime configuration only
- `/api/engelbart-credentials` — authenticated per-member LiteLLM provisioning
- `/api/engelbart-device` — CLI device-authorization pairing (`start`, `approve`,
  `deny`, `poll`, `whoami`, `revoke`)

## Signing in the CLI

`npx engelbart-cli` never asks for a password. It starts a pairing session,
opens `/engelbart?code=WXYZ-1234`, and polls while the member signs in and
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

Compiled by hand from the Claude Design project *Mathetic landing page design* → `Mathetic Landing.dc.html`.
The design-canvas runtime (`support.js`, `image-slot.js`, React/Babel from unpkg) is not shipped; the
`<x-dc>` template, `style-hover`, and `DCLogic` component were flattened into plain HTML/CSS/JS.
To update copy or layout, edit `index.html` directly (or re-export from the design and re-flatten).

## Local verification

```sh
npm test
npm run check
vercel dev
```

`vercel dev` requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

## Hosting

- Vercel project `mathetic/berkeley-research`, git-linked to this repo; pushes to `main` deploy to production.
- Domain `berkeley.mathetic.com` is attached to the Vercel project.
- DNS lives in Cloudflare (zone `mathetic.com`): `berkeley` → CNAME to the Vercel-provided target, **DNS only** (grey cloud), same as `www`.
