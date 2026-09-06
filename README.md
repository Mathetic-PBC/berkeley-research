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

Optional, and a stopgap: `ENGELBART_ANTHROPIC_API_KEY`. While it is set, every
model call the setup and onboarding pages make goes straight to
`api.anthropic.com` on that one key instead of through LiteLLM on the member's
key. Members still need a provisioned key (the credit gate and meter keep
reading the proxy), but nothing is metered per member and the proxy's own
upstream key is not used. The key never reaches a browser or a terminal:
`/api/engelbart-credentials` and Claude Code sessions keep using the member's
LiteLLM key, and telemetry redacts it. Remove the variable to return to the
proxy; the next deployment picks the change up.

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

## Observability

The onboarding endpoint is traced: every action is one OpenTelemetry trace
whose operations (database, storage, http, model, processing) hang from an
`onboarding.<action>` workflow, grouped into a run by the onboarding row's id.
The application talks only to the small Bart layer in `api/_lib/telemetry/`;
the records it emits and the environment variables that govern them are
documented in `docs/observability/data-contract.md`, with a real example run in
`docs/observability/example-onboarding-analysis-run.json`
(`node scripts/telemetry-example.js` regenerates it).

A deployment records itself without configuration: operations, snapshots and
events are persisted to the three `engelbart_telemetry_*` tables (migration
`20260905120000`) wherever the Supabase service role is configured. Switches:

- `ENGELBART_TRACE_CONTENT=false` — stop capturing payload snapshots (prompts, replies, page text, row bodies); on by default, redacted, bounded, never the PDF
- `ENGELBART_TELEMETRY_STORE=false` — persist nothing to Supabase (on by default when `SUPABASE_SERVICE_ROLE_KEY` is set)
- `ENGELBART_TRACE_POLLS=true` — trace the page's routine status polls too (off by default)
- `ENGELBART_TELEMETRY_LOG=true` — one JSON line per finished operation in the function log (off by default)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS`) — export spans over OTLP/HTTP (unset by default)

Only the onboarding endpoint is traced: the shared database, storage, page and
model boundaries record nothing unless a workflow root is open above them.
Telemetry never fails a request: a sink or exporter error is logged and
onboarding continues. The handler flushes before it responds, within
`ENGELBART_TELEMETRY_FLUSH_MS` (default 2000). Under `node --test` nothing is
persisted unless `ENGELBART_TELEMETRY_STORE=true` is set explicitly.

To check what a deployment persisted for one run, read-only and without
printing any captured content:

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RUN_ID=<onboarding id> npm run verify:telemetry
```

## Debugger

`/engelbart/setup/test` runs the real setup page (`setup.js`, `install.js`,
`setup.css`, unmodified) in a frame against a simulated control plane that
lives entirely in the browser, and draws beside it every request the page
makes and every operation the simulated server runs to answer it: the auth
check, each Supabase read and write, the storage upload, the model call with
its prompt, the link checks. Nothing reaches Vercel, Supabase, LiteLLM or a
model; the page's `fetch` to `/api` is answered in-page from
`engelbart/setup/test/sim-backend.js`, model replies come from
`fixture.js`, and the prompts are `prompts.js`, a verbatim copy of
`api/_lib/onboarding-prompts.js` that the debugger lets you edit per
environment. Test environments, step recordings and notes persist in that
browser's `localStorage`.

The page has two modes, switched at the top: **Simulated** is the simulator
above, which shows what the server is designed to do for each press, not what
production did. **Real runs** reads the persisted telemetry in the
`engelbart_telemetry_*` tables, the record of what production actually did,
for the signed-in member's own onboardings: a compact list of recent runs
(project or paper, actions, status, operations, server time), and one click
opens a run in the same request list and inspector. A workflow root is a
request row, the operations beneath it are its rows, and the inspector's tabs
are the recorded snapshots (model request, raw and parsed reply, database
request and response, page text, normalized result), attributes, events and
error, exactly as stored. Nothing is invented: no cost is estimated, request
bodies the server did not keep are not shown, and because the contract does
not record which stored values an operation read and wrote, the Data flow
view says lineage is unavailable rather than guessing edges.

Real runs mode is read-only. It goes through `/api/engelbart-telemetry`
(`GET` only; the member's own Supabase session; the service role stays on
the server; runs are returned only for onboarding rows the member owns; the
reads are untraced), which never changes onboarding state, calls a model or
spends credit. The simulator's reset, environments and prompt edits are hidden
in that mode; nothing in the debugger can replay or rerun a real action. The
adapter is `engelbart/setup/test/real-runs.js`, tested against the example
envelope in `docs/observability/` by `tests/debugger-real-runs.test.js`;
the endpoint by `tests/engelbart-telemetry.test.js`.

The page is flattened from the Claude Design file `Engelbart Debugger.dc.html`
into `engelbart/setup/test/` (`debugger.js`, `debugger.css`, `frame.html`,
`frame.js`), with React 18 loaded from `cdn.jsdelivr.net` under subresource
integrity, so it runs under the Engelbart CSP without `unsafe-inline` or
`unsafe-eval`. Only the frame page (`/engelbart/setup/test/frame`) may be
embedded, and only by this origin; the setup page itself keeps
`frame-ancestors 'none'`. `e2e/debugger.spec.js` opens the debugger under the
exact headers `vercel.json` deploys and fails on any CSP violation.

## Source of truth

The static pages began as hand-flattened exports from the Claude Design project *Mathetic landing page design*:

- `index.html` ← `Mathetic Landing.dc.html`
- `engelbart/index.html` + `engelbart/styles.css` ← `Mathetic Demo.dc.html`
- `engelbart/demo.js` ← the ten-scene `engelbart-demo.jsx` product walkthrough, ported to native DOM animation
- `engelbart/setup/test/` ← `Engelbart Debugger.dc.html` and its `debugger/` files, from the *Engelbart Debugger* design project

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

### Browser → CLI → browser simulation

The Playwright simulation treats `berkeley-research` and Engelbart as one
cross-process system. It serves the real setup UI against deterministic local
device/onboarding endpoints, installs the checked-out Engelbart artifact into
an isolated temporary machine, invokes the installed Claude hook, opens its
loopback workspace, edits a goal in the browser, and asserts that the next
Claude hook receives that edit. It never writes to the user's Claude or
Engelbart directories.

Put `berkeley-research` and `claude-plugins` beside each other, then run:

```sh
npm ci
npx playwright install chromium
npm run test:e2e:round-trip
```

Use `npm run test:e2e:headed` to watch the browser path. Set
`CLAUDE_PLUGINS_DIR` when the plugin checkout is elsewhere. Firefox and WebKit
exercise the browser-only handoff with `npm run test:e2e:compat`; the real
installer/hook round trip remains Chromium because native operating-system
coverage is the variable under test there.

The GitHub Actions matrix runs the installed round trip on macOS, Ubuntu, and
Windows, plus Firefox and WebKit compatibility on Ubuntu. The workflow exists
in both repositories: each pull request tests its own commit against the other
repository's `main`, while each manual dispatch accepts an alternate ref for a
coordinated two-repository change. A weekly Berkeley run catches drift after
both default branches move.

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
