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

A member can bring their own Anthropic API key from the setup page's rail
("Use your own Anthropic key"). The key is checked against Anthropic, stored
encrypted under `ENGELBART_CREDENTIAL_KEY` in `engelbart_member_model_keys`
(migration `20260906120000_engelbart_member_model_keys.sql`), and that
member's setup model calls then go straight to `api.anthropic.com` on it; the
pool is neither asked nor allowed to refuse them. The page only ever sees the
key's last four characters, and Claude Code sessions keep using the member's
LiteLLM key.

Optional, and a stopgap: `ENGELBART_ANTHROPIC_API_KEY`. While it is set, every
model call the setup and onboarding pages make goes straight to
`api.anthropic.com` on that one key instead of through LiteLLM on the member's
key (a key the member brought still wins). Members still need a provisioned
key (the credit gate and meter keep reading the proxy), but nothing is metered
per member and the proxy's own upstream key is not used. The key never reaches
a browser or a terminal: `/api/engelbart-credentials` and Claude Code sessions
keep using the member's LiteLLM key, and telemetry redacts it. Remove the
variable to return to the proxy; the next deployment picks the change up.

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
`engelbart/setup/test/sim-backend.js`, model replies come from a **test
case** in `fixture.js` (`EGB_FIXTURES`: one paper and the saved model outputs
for it; *Inspectable Intent in Agentic Programming* is the one there is, and
another is another entry in the same shapes), and the prompts are
`prompts.js`, a verbatim copy of `api/_lib/onboarding-prompts.js` that the
debugger lets you edit per environment, one prompt at a time on a tab each;
an edited tab is marked. A simulated run is deterministic and is not a
reading of anything: the PDF you drop on the Paper step is kept by name and
size only, and the analysis, the asset hunt and everything after them are the
test case's saved outputs whatever the file was. The strip under the top bar
says so (*Simulated test case · Inspectable Intent in Agentic Programming ·
Model outputs in this mode come from a saved fixture. Uploaded PDFs do not
change the fixture.*), names the case, and lets you pick another; each
environment is configured with one, its card names it, and changing it starts
the environment's simulated account over. The simulator says the same in
what it records: the paper download names the uploaded file and that its
bytes are not read, and every model operation's meta says `answered_from:
fixture <id>`.
The page opens on a dashboard of test environments, each with
its own simulated account, step recordings, notes and graph layout; nothing
runs until one is opened. A card's Configure edits an environment and its
Reset drops the simulated account and the step recordings (the participant,
prompts and notes stay) without opening it; an open environment resets from
the top bar, which also reloads the product at step one. Environments, step
recordings and notes persist in that browser's `localStorage`.

The page has two modes, named on the URL, with the same composition in both:
the setup page on the left; the request list, the operation inspector, the
Data flow view and the Prompts view on the right. The Prompts view groups the
run's model calls by the prompt each sent (a tab per prompt, in the order the
reader meets them, edited prompts marked) and shows each call's message as the
model received it and the reply as parsed, with the rest of the call one click
away in the request list. **Simulated**, the plain URL, is the
simulator above: it shows what the server is designed to do for each press,
not what production did. **Real** (`/engelbart/setup/test?mode=real`) puts
the same setup page against the real endpoints, signed in as you (the frame
uses your real Supabase session; nothing is intercepted), and draws beside it
what the server actually did: the PDF you upload goes to Storage, the model
reads that object, and the reading you see is of that paper. The two are
named side by side in the top bar as links (the mode is the URL's; the page
stores nothing about it), and the strip under the bar says which backend the
product is on. They are two adapters in `frame.js` with no path between them:
`SimulatedBackend` runs in `frame.html`, which loads the simulator and its
test cases; `RealBackend` runs in `frame-real.html`, which loads neither, so
nothing in that frame can answer in the model's place, and a request the
backend fails is shown as the failure it was. Should the real backend ever
find the simulator's scripts loaded beside it (`frame.html?mode=real`, say),
it refuses to start rather than run beside them: every request fails with
the reason, and the strip shows it.
Every action's reply names the trace it produced in an `x-engelbart-trace-id`
header; the page reads that trace from `/api/engelbart-telemetry?trace=` the
moment the reply lands and places the recorded operations under the request
row. So pressing Continue on the left shows `onboarding · step` on the right
with the row load, the calibration and turn reads and the database write
beneath it, and starting an analysis shows the paper download, the page
fetches, the context construction, the model call and the persist. The
inspector's tabs are the recorded snapshots (model request, raw and parsed
reply, database request and response, page text, normalized result),
attributes, events and error, exactly as stored, credentials redacted before
storage. Requests the server does not trace (the config read, routine status
polls, the browser's direct upload to Storage) are listed too, marked
untraced, consecutive polls folded into one row. The run picker in the top
bar opens an earlier onboarding of yours into the same panel. Nothing
is invented: no cost is estimated, request bodies the server did not keep are
not shown, and the Data flow view draws only the reads and writes the server
recorded for each operation (`engelbart.lineage.reads` / `.writes`, see the
contract's *Lineage*); a run recorded before the server kept those says so
rather than guessing edges.

Real mode performs real actions: the product on the left does real work as
you, exactly as at `/engelbart/setup`, so a model call spends real credit,
Continue writes your onboarding and a dropped PDF is uploaded. The panel on
the right only reads. It goes through `/api/engelbart-telemetry` (`GET` only;
the member's own Supabase session; the service role stays on the server;
runs and traces are returned only for the member's own onboardings; the reads
are untraced), which never changes onboarding state, calls a model or spends
credit. The simulator's reset, environments and speed are hidden in that
mode, the setup page's own test bar is never enabled there, and nothing in
the debugger can replay or rerun a real action. One control does reach the
real backend: the prompts picker in the top bar chooses an environment whose
edited prompts the product's model calls use for your own run (the frame adds
them to the model actions as `prompt_overrides`; the server renders them with
the same slots as its own, names the prompt and marks it edited in every model
operation's record, and never stores them). Server prompts is the default and
the choice is remembered in the browser. The frame
(`frame.js`) reports each request and reply to the page with credentials,
tokens and signed URLs redacted. The adapter is
`engelbart/setup/test/real-runs.js`, tested against the example envelope in
`docs/observability/` by `tests/debugger-real-runs.test.js`; the frame by
`tests/debugger-frame.test.js`, the page by `tests/debugger-page.test.js`,
the endpoint by `tests/engelbart-telemetry.test.js`, and `e2e/debugger.spec.js`
drives both modes in Chromium under the deployed headers.

The page is flattened from the Claude Design file `Engelbart Debugger.dc.html`
into `engelbart/setup/test/` (`debugger.js`, `debugger.css`, `frame.html`,
`frame-real.html`, `frame.js`), with React 18 loaded from `cdn.jsdelivr.net`
under subresource integrity, so it runs under the Engelbart CSP without
`unsafe-inline` or `unsafe-eval`. Only the two frame pages
(`/engelbart/setup/test/frame`, `/engelbart/setup/test/frame-real`) may be
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
