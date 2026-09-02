# Calibrated Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/engelbart/setup` with the ten-step calibrated onboarding: profile → paper (analysed in parallel) → graded prior-knowledge diagnostic → register-conditioned project generation → the pending-setup payload the installer already imports, with every answer persisted as it happens and the invite gate back on account creation.

**Architecture:** One new Vercel function (`api/engelbart-onboarding.js`) owns an `engelbart_onboardings` row per reader and every model call, all billed to the member's LiteLLM key. The browser page is a mirror of that row. Prompts live in one module so the goal/todo prompts can be rewritten without touching the harness. The `hc` runtime learns a fourth register and a per-area knowledge block.

**Tech Stack:** Vercel Node functions (CommonJS, no deps), Supabase (PostgREST via service role, Storage), LiteLLM `/v1/messages`, vanilla DOM page under the `/engelbart` CSP, `node --test`; `hc` Python + `pytest`.

**Spec:** `docs/superpowers/specs/2026-09-02-engelbart-onboarding-design.md`

**Reference UI:** `docs/superpowers/reference/onboarding-flow/{markup.html,script.js,tokens.css}` — the Claude Design export's DOM, logic and tokens. The page is a flattening of `markup.html`, the way `engelbart/demo.js` flattened the demo (README "Source of truth").

## Global Constraints

- berkeley-research branch `feat/onboarding-calibration`; claude-plugins branch `feat/onboarding-reconnect-reader`.
- No npm dependencies in berkeley-research. `npm run check` (node --check on every js) and `npm test` must stay green (130 tests now).
- `/engelbart` CSP: scripts only from `'self'` and `https://cdn.jsdelivr.net`; no inline `<script>`/`<style>`; `connect-src` self + Supabase.
- Every `engelbart_*` table: RLS on, `revoke all … from anon, authenticated`, reached only through functions with the service role.
- Model calls: `POST {baseUrl}/v1/messages`, `Authorization: Bearer <member key>`; never the master key, never the provider key.
- Bound every model output and every reader field before storage; caps are in the spec §3 and §5.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo`.
- hc tests run with `env -u HC_CHAT_INFERENCE`.

## File map

berkeley-research

- Create `scripts/verify-pdf.mjs` — live-proxy spike: a PDF `document` block through `/v1/messages`.
- Create `supabase/migrations/20260902100000_engelbart_invite_gate_restored.sql`.
- Create `supabase/migrations/20260902110000_engelbart_onboarding.sql`.
- Create `api/_lib/onboarding-prompts.js` — every prompt template + capability ladder + reader block.
- Create `api/_lib/onboarding-model.js` — `callModel` with content blocks, `pickModel(models, family)`, normalizers for analysis/grade/details/goals/todos/ask.
- Create `api/_lib/onboarding.js` — record operations (open/step/sources/analysis/answer/generate/create), assessed register, follow-up rule, payload mapping.
- Create `api/engelbart-onboarding.js` — the handler (action dispatch only).
- Modify `api/_lib/storage.js` — `downloadObject(path)`.
- Modify `api/_lib/setup-chat.js` — `normalizePayload` learns `reader`; `pickModel` gains a family argument.
- Modify `vercel.json` — `maxDuration` for the new function.
- Rewrite `engelbart/setup/index.html`, `engelbart/setup/setup.css`, `engelbart/setup/setup.js`.
- Modify `engelbart/signin/index.html`, `engelbart/app.js` — invite form; redirect to `/engelbart/setup`.
- Modify `supabase/README.md` — hook note.
- Create `docs/onboarding-harness.md`.
- Tests: `tests/onboarding-model.test.js`, `tests/onboarding.test.js`, `tests/engelbart-onboarding.test.js`, `tests/signin-invite.test.js`.

claude-plugins

- Create `supabase/migrations/20260902120000_hc_reader_knowledge.sql`.
- Modify `hc/src/human_compact/trajectory/reader.py`, `hc/src/human_compact/trajectory/supabase_client.py` (`set_reader_profile`), `hc/src/human_compact/cli.py` (`setup_import_main`).
- Tests: `tests/test_reader_profile.py` (extend), `tests/test_setup_import_reader.py` (new).

---

### Task 1: PDF document-block spike

**Files:**
- Create: `scripts/verify-pdf.mjs`
- Modify: `package.json` (script `verify:pdf`)

**Interfaces:**
- Produces: a yes/no on whether the live proxy forwards an Anthropic `document` block. Task 4's `analyze` uses `document` when yes; when no, Task 7 adds pdf.js text extraction in the browser and Task 4 sends text.

- [ ] **Step 1: Write the script**

```js
// scripts/verify-pdf.mjs
// Does the live LiteLLM proxy forward an Anthropic `document` block (base64 PDF)
// on /v1/messages? Run with LITELLM_BASE_URL and a member or master key in
// LITELLM_KEY. Exit 0 = forwarded (the model names the title); 1 = not.
import { readFileSync } from "node:fs";

const base = String(process.env.LITELLM_BASE_URL || "").replace(/\/$/, "");
const key = process.env.LITELLM_KEY || process.env.LITELLM_MASTER_KEY;
const model = process.env.MODEL || "claude-sonnet-4-5-20250929";
if (!base || !key) { console.error("LITELLM_BASE_URL and LITELLM_KEY are required"); process.exit(2); }

// A one-page PDF whose only text is a made-up title, built inline so the
// spike needs no fixture file.
const TITLE = "Zebra Lattice Tuning";
function tinyPdf(text) {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  const stream = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const pdf = process.argv[2] ? readFileSync(process.argv[2]) : tinyPdf(TITLE);
const response = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model, max_tokens: 200,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf",
        data: pdf.toString("base64") } },
      { type: "text", text: "Reply with only the document's title, verbatim." },
    ] }],
  }),
});
const body = await response.json().catch(() => ({}));
const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
console.log(`${response.status} ${text.slice(0, 200)}`);
if (!response.ok) { console.error(JSON.stringify(body).slice(0, 400)); process.exit(1); }
process.exit(process.argv[2] || text.includes(TITLE) ? 0 : 1);
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`: `"verify:pdf": "node scripts/verify-pdf.mjs"`.

- [ ] **Step 3: Run it against the live proxy**

Run: `vercel env pull .env.spike --environment=production` (the repo is linked; `.env*` is gitignored — confirm with `git check-ignore .env.spike`, add to `.gitignore` if not), then
`set -a; . ./.env.spike; set +a; LITELLM_KEY="$LITELLM_MASTER_KEY" npm run verify:pdf`
Expected: `200 Zebra Lattice Tuning` and exit 0. If exit 1 with a 400 naming `document`/`unsupported`, record the outcome in the commit message and Task 4 Step 6 / Task 7 Step 7 take the text fallback.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-pdf.mjs package.json
git commit -m "Spike: PDF document blocks through the proxy (result: <forwarded|not forwarded>)

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---

### Task 2: Invite gate back on account creation

**Files:**
- Create: `supabase/migrations/20260902100000_engelbart_invite_gate_restored.sql`
- Modify: `engelbart/signin/index.html` (signup view), `engelbart/app.js` (signup handlers), `supabase/README.md`
- Test: `tests/signin-invite.test.js`

**Interfaces:**
- Consumes: `engelbart_redeem_invite(invite_code, signup_email)` (anon-executable, unchanged).
- Produces: signup requires a reserved invite; after a signup that returns a session the page navigates to `/engelbart/setup`; `emailRedirectTo` is `/engelbart/setup`.

- [ ] **Step 1: Write the failing page test**

```js
// tests/signin-invite.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "engelbart", "signin", "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "engelbart", "app.js"), "utf8");

test("signup asks for the invite code before the password", () => {
  assert.match(page, /id="invite-form"/);
  assert.match(page, /id="invite-code"/);
  assert.match(page, /id="signup-options" class="stack hidden"/);
  assert.ok(page.indexOf('id="invite-form"') < page.indexOf('id="password-signup-form"'));
});

test("the invite is reserved through engelbart_redeem_invite and signup lands on setup", () => {
  assert.match(app, /client\.rpc\("engelbart_redeem_invite"/);
  assert.match(app, /emailRedirectTo: window\.location\.origin \+ "\/engelbart\/setup"/);
  assert.match(app, /window\.location\.href = "\/engelbart\/setup"/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/signin-invite.test.js`
Expected: FAIL (no `invite-form`).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260902100000_engelbart_invite_gate_restored.sql
-- The invite gate returns to account creation. 20260828150000 opened signup
-- and moved the code to the credit claim; the onboarding that follows
-- signup now spends the member's key on its first screen, so an account
-- without an invite is an account that cannot do anything. The credit
-- claim keeps consuming the bound invite; 'open' stays a legal source for
-- the rows that already exist.

create or replace function public.engelbart_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  signup_email text;
  approved boolean;
begin
  signup_email := lower(trim(coalesce(event -> 'user' ->> 'email', '')));
  select exists (
    select 1
    from public.engelbart_signup_approvals approval
    join public.engelbart_invites invite on invite.id = approval.invite_id
    where approval.email = signup_email
      and approval.expires_at > now()
      and invite.expires_at > now()
      and invite.used_at is null
      and invite.reserved_email = signup_email
  ) into approved;
  if approved then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'A valid Engelbart invite is required to create an account.'));
end;
$$;

create or replace function public.engelbart_finish_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text;
  approved_invite uuid;
begin
  normalized_email := lower(trim(coalesce(new.email, '')));
  select approval.invite_id into approved_invite
  from public.engelbart_signup_approvals approval
  join public.engelbart_invites invite on invite.id = approval.invite_id
  where approval.email = normalized_email
    and approval.expires_at > now()
    and invite.expires_at > now()
    and invite.used_at is null
    and invite.reserved_email = normalized_email
  for update of approval, invite;
  if approved_invite is null then
    raise exception 'A valid Engelbart invite is required to create an account.';
  end if;
  insert into public.engelbart_members (user_id, invite_id, source)
  values (new.id, approved_invite, 'invite');
  update public.engelbart_invites
  set used_by = new.id, used_at = now()
  where id = approved_invite;
  delete from public.engelbart_signup_approvals where invite_id = approved_invite;
  return new;
end;
$$;
```

- [ ] **Step 4: Restore the invite form in the signup view**

In `engelbart/signin/index.html`, replace the contents of `<div id="signup-view" class="hidden">` with the `afe4170^` version (`git show afe4170^:engelbart/signin/index.html`, the `signup-view` block): an `invite-form` (fields `invite-code`, `signup-email`, button "Check the code", fine print "The code holds this email for you for 30 minutes.", `invite-status`), then `signup-options` (readonly `approved-email`, `password-signup-form` with `signup-password`, "Create account", `change-invite` link button). Update the `def-signup` span to "Your invite code reserves one account, and one Claude credit." and the meta description to "…or create an account with your invite code."

- [ ] **Step 5: Restore the handlers in app.js**

In `engelbart/app.js`: add `approvedEmail`, the `inviteForm/inviteCode/inviteStatus/signupOptions/approvedEmail/changeInvite` element lookups, `DEF.signup = "Your invite code reserves one account, and one Claude credit."`, and the three handlers from `git show afe4170^:engelbart/app.js` (`inviteCode` input normaliser, `inviteForm` submit calling `client.rpc("engelbart_redeem_invite", { invite_code, signup_email })` and revealing `signup-options`, `changeInvite` click). The `passwordSignupForm` submit signs up with `email: approvedEmail` and:

```js
      options: { emailRedirectTo: window.location.origin + "/engelbart/setup" },
    });
    setBusy(el.passwordSignupForm, false);
    if (result.error) {
      setStatus(el.signupStatus, shared.safeMessage(result.error, "Could not create the account."), "error");
      return;
    }
    if (result.data.session) {
      // The account exists and is signed in: setting up the first project is
      // the next thing, and it has its own page.
      window.location.href = "/engelbart/setup";
      return;
    }
    setStatus(el.signupStatus, "Check your email to confirm the account; the link opens your project setup.", "success");
```

- [ ] **Step 6: Correct the README hook note**

In `supabase/README.md` step 2, replace the parenthetical with: "(Restored by `20260902100000`: the hook refuses a signup whose email has no live invite reservation.)"

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including `tests/signin-invite.test.js`; `tests/signin-pairing.test.js` unchanged.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260902100000_engelbart_invite_gate_restored.sql engelbart/signin/index.html engelbart/app.js supabase/README.md tests/signin-invite.test.js
git commit -m "Signup needs an invite again, and lands on project setup

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---

### Task 3: Onboarding tables

**Files:**
- Create: `supabase/migrations/20260902110000_engelbart_onboarding.sql`

**Interfaces:**
- Produces: tables `engelbart_onboardings`, `engelbart_onboarding_calibrations`, `engelbart_onboarding_asks` with the columns in spec §3, written by Task 5 through PostgREST with the service role.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260902110000_engelbart_onboarding.sql
-- The onboarding record: everything a reader says on /engelbart/setup, kept
-- as it is said. One live row per account; the row is the truth the page
-- mirrors, so a closed tab loses nothing and an abandoned flow still
-- leaves its calibration behind. Same posture as engelbart_pending_setups:
-- neither the browser nor the CLI reaches these tables directly.

create table if not exists public.engelbart_onboardings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'created')),
  step integer not null default 0 check (step between 0 and 10),
  name text not null default '',
  year text not null default '',
  major text not null default '',
  depth text not null default ''
    check (depth in ('', 'everyday', 'some', 'technical', 'expert')),
  paper_id uuid references berkeley.papers (id) on delete set null,
  paper_title text not null default '',
  project_url text not null default '',
  repo_url text not null default '',
  paper_familiarity integer check (paper_familiarity between 0 and 4),
  project_draft text not null default '',
  analysis jsonb,
  analysis_status text not null default 'none'
    check (analysis_status in ('none', 'running', 'done', 'error')),
  analysis_error text not null default '',
  analysis_started_at timestamptz,
  details jsonb,
  goals jsonb,
  goal_chosen text not null default '',
  todos jsonb,
  project_name text not null default '',
  pending_setup_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists engelbart_onboardings_one_open_idx
  on public.engelbart_onboardings (user_id) where status = 'open';
create index if not exists engelbart_onboardings_user_idx
  on public.engelbart_onboardings (user_id, created_at desc);

create table if not exists public.engelbart_onboarding_calibrations (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.engelbart_onboardings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  area_index integer not null check (area_index between 0 and 3),
  area text not null default '',
  parent_field text not null default '',
  self_level integer not null check (self_level in (0, 25, 50, 75, 100)),
  question_level integer not null check (question_level in (0, 25, 50, 75, 100)),
  question text not null default '',
  sample_response text not null default '',
  answer text not null default '',
  graded_level integer check (graded_level in (0, 25, 50, 75, 100)),
  grade_confidence real check (grade_confidence between 0 and 1),
  grade_rationale text not null default '',
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  unique (onboarding_id, area_index, question_level)
);

create table if not exists public.engelbart_onboarding_asks (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.engelbart_onboardings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  step integer not null default 0,
  quote text not null default '',
  question text not null default '',
  level text not null default '',
  answer text not null default '',
  created_at timestamptz not null default now()
);

alter table public.engelbart_onboardings enable row level security;
alter table public.engelbart_onboarding_calibrations enable row level security;
alter table public.engelbart_onboarding_asks enable row level security;

revoke all on public.engelbart_onboardings from anon, authenticated;
revoke all on public.engelbart_onboarding_calibrations from anon, authenticated;
revoke all on public.engelbart_onboarding_asks from anon, authenticated;
```

- [ ] **Step 2: Check it parses**

Run: `supabase db lint --help >/dev/null 2>&1; node -e "const s=require('fs').readFileSync('supabase/migrations/20260902110000_engelbart_onboarding.sql','utf8'); if(!/engelbart_onboardings_one_open_idx/.test(s)) process.exit(1)"`
Expected: exit 0. (The SQL runs in the project's editor at rollout; there is no local database.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260902110000_engelbart_onboarding.sql
git commit -m "Onboarding record tables

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---
### Task 4: Prompts and model module

**Files:**
- Create: `api/_lib/onboarding-prompts.js`
- Create: `api/_lib/onboarding-model.js`
- Modify: `api/_lib/setup-chat.js` (`pickModel(models, family = "sonnet")`)
- Test: `tests/onboarding-model.test.js`

**Interfaces:**
- Consumes: `credentials = {apiKey, baseUrl, models}` from `Credits.credentialsFor`.
- Produces (`onboarding-model.js`):
  - `callModel({system?, content, family?, maxTokens?, timeoutMs?}, credentials, options)` → parsed JSON object or `null`; `content` is an Anthropic content-block array.
  - `analyze({familiarityLabel, familiarityDesc, depthLabel, depthDesc, pdfBase64|pdfText, urls:[{url,text}]}, credentials, options)` → normalized analysis `{title, one_liner, date, areas[]}` or throws `statusCode 502`.
  - `grade({area, question, level, sample, answer}, credentials, options)` → `{level, confidence, rationale}` or `null`.
  - `details/goals/todos/ask(input, credentials, options)` → normalized objects (shapes below).
  - `normalizeAnalysis(raw)`, `normalizeGrade(raw)`, `normalizeDetails(raw)`, `normalizeGoals(raw)`, `normalizeTodos(raw)`, `normalizeAsk(raw)` — pure, exported for tests.
- Produces (`onboarding-prompts.js`): `LADDER` (five capability definitions), `DEPTHS` (four register stops with labels, descriptions and rules), `FAMILIARITY` (five paper-familiarity stops), `readerBlock(reader)`, and template functions `analyzePrompt`, `gradePrompt`, `detailsPrompt`, `goalsPrompt`, `todosPrompt`, `askPrompt`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/onboarding-model.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const OM = require("../api/_lib/onboarding-model");
const P = require("../api/_lib/onboarding-prompts");

const CREDS = { apiKey: "k", baseUrl: "https://p", models: ["all-proxy-models"] };

function modelSaying(reply, capture) {
  return async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    if (capture) capture.push({ url, body, headers: init.headers });
    return { ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: JSON.stringify(reply) }] }; } };
  };
}

function fiveQuestions() {
  return [0, 25, 50, 75, 100].map((level) => ({
    level, capability: "x", question: `q${level}`, sample_response: `s${level}`,
  }));
}

test("normalizeAnalysis keeps 2-4 areas of exactly five levelled questions", () => {
  const out = OM.normalizeAnalysis({
    title: "A B C D E F", one_liner: "x".repeat(400), date: "2024-13",
    areas: [
      { area: "Transformers", parent_field: "ML", project_role: "r", granularity_rationale: "g",
        questions: fiveQuestions().reverse() },
      { area: "PyTorch", questions: fiveQuestions().concat([{ level: 50, question: "dup" }]) },
      { area: "Short", questions: fiveQuestions().slice(0, 4) },     // dropped: not five
    ],
  });
  assert.equal(out.title, "A B C D E F");
  assert.equal(out.one_liner.length, 300);
  assert.equal(out.date, null);
  assert.equal(out.areas.length, 2);
  assert.deepEqual(out.areas[0].questions.map((q) => q.level), [0, 25, 50, 75, 100]);
  assert.equal(out.areas[0].questions[3].capability, "can_use");
  assert.equal(out.areas[1].parent_field, "");
  assert.equal(OM.normalizeAnalysis({ title: "t", date: "2023-05-01", areas: [] }), null);
  assert.equal(OM.normalizeAnalysis({ title: "t", date: "2023", areas: [
    { area: "one", questions: fiveQuestions() }] }), null);                 // fewer than two
});

test("normalizeGrade snaps to the ladder and bounds the rationale", () => {
  assert.deepEqual(OM.normalizeGrade({ level: 60, confidence: 1.7, rationale: "r".repeat(300) }),
    { level: 50, confidence: 1, rationale: "r".repeat(200) });
  assert.equal(OM.normalizeGrade({ level: "no" }), null);
  assert.equal(OM.normalizeGrade(null), null);
});

test("details, goals, todos and ask are bounded to their shapes", () => {
  const d = OM.normalizeDetails({ intro: "i", questions: [
    { id: "who", kind: "choice", title: "Who?", options: ["me", "team", "", 7] },
    { id: "first", kind: "multi", title: "First?", options: ["a"] },
    { kind: "short", title: "Never?", placeholder: "p", hint: "h" },
    { id: "x", kind: "weird", title: "?" },
    { id: "5", kind: "short", title: "five" }, { id: "6", kind: "short", title: "six" },
  ] });
  assert.equal(d.questions.length, 4);
  assert.deepEqual(d.questions[0].options, ["me", "team"]);
  assert.equal(d.questions[2].id, "q3");
  assert.equal(d.questions[3].kind, "short");                     // unknown kind -> short
  assert.equal(OM.normalizeDetails({ questions: [{ title: "only one" }] }), null); // fewer than 3

  const g = OM.normalizeGoals({ goals: [1, 2, 3, 4, 5].map((n) => ({ label: `g${n}`, short: `s${n}`, why: `w${n}` })) });
  assert.equal(g.goals.length, 4);
  assert.equal(OM.normalizeGoals({ goals: [{ label: "a" }] }), null);

  const t = OM.normalizeTodos({ todos: ["a", "", "b", "c", "d", "e"], name: "n".repeat(100) });
  assert.deepEqual(t.todos, ["a", "b", "c", "d"]);
  assert.equal(t.name.length, 80);
  assert.equal(OM.normalizeTodos({ todos: ["one"] }), null);

  assert.equal(OM.normalizeAsk({ answer: "a".repeat(2000) }).answer.length, 1200);
  assert.equal(OM.normalizeAsk({}), null);
});

test("analyze sends the PDF as a document block where the paper tag sits, and bills the member key", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: "2024", areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  const out = await OM.analyze({
    familiarityLabel: P.FAMILIARITY[1].label, familiarityDesc: P.FAMILIARITY[1].desc,
    depthLabel: P.DEPTHS[0].label, depthDesc: P.DEPTHS[0].desc,
    pdfBase64: "JVBERi0=", urls: [{ url: "https://x.org", text: "page text" }],
  }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  assert.equal(out.areas.length, 2);
  const { body, headers } = calls[0];
  assert.equal(headers.Authorization, "Bearer k");
  assert.equal(body.max_tokens, 8192);
  const blocks = body.messages[0].content;
  const doc = blocks.findIndex((b) => b.type === "document");
  assert.ok(doc > 0 && doc < blocks.length - 1);
  assert.equal(blocks[doc].source.media_type, "application/pdf");
  assert.match(blocks[doc - 1].text, /<phd_student_paper>\s*$/);
  assert.match(blocks[doc + 1].text, /^\s*<\/phd_student_paper>/);
  assert.match(blocks[doc + 1].text, /https:\/\/x\.org[\s\S]*page text/);
  assert.match(blocks[0].text, /I can follow it|CAN FOLLOW/i);
});

test("analyze with text instead of a PDF sends one text block", async () => {
  const calls = [];
  const reply = { title: "T", one_liner: "o", date: null, areas: [
    { area: "A", questions: fiveQuestions() }, { area: "B", questions: fiveQuestions() }] };
  await OM.analyze({ familiarityLabel: "f", familiarityDesc: "", depthLabel: "d", depthDesc: "",
    pdfText: "paper words", urls: [] }, CREDS, { fetchImpl: modelSaying(reply, calls) });
  const blocks = calls[0].body.messages[0].content;
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /<phd_student_paper>\s*paper words\s*<\/phd_student_paper>/);
});

test("grade asks haiku and analyze asks sonnet", async () => {
  const calls = [];
  const creds = { ...CREDS, models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"] };
  await OM.grade({ area: "A", question: "q", level: 50, sample: "s", answer: "a" }, creds,
    { fetchImpl: modelSaying({ level: 50, confidence: 0.8, rationale: "ok" }, calls) });
  assert.equal(calls[0].body.model, "claude-haiku-4-5-20251001");
  assert.equal(OM.pickModel(["all-proxy-models"], "haiku"), "claude-haiku-4-5-20251001");
  assert.equal(OM.pickModel(["all-proxy-models"], "sonnet"), "claude-sonnet-4-5-20250929");
});

test("a spent key answers 409, a broken gateway 502, and unparseable JSON is null", async () => {
  await assert.rejects(OM.callModel({ content: [{ type: "text", text: "x" }] }, CREDS, {
    fetchImpl: async () => ({ ok: false, status: 429, async json() { return { error: { message: "budget" } }; } }),
  }), (e) => e.statusCode === 409);
  await assert.rejects(OM.callModel({ content: [{ type: "text", text: "x" }] }, CREDS, {
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }),
  }), (e) => e.statusCode === 502);
  assert.equal(await OM.callModel({ content: [{ type: "text", text: "x" }] }, CREDS, {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { content: [{ type: "text", text: "not json" }] }; } }),
  }), null);
});

test("readerBlock names the person, the register rule, and what they already know", () => {
  const lines = P.readerBlock({ name: "Maya", year: "Second year", major: "Cognitive Science",
    depth: "some", knowledge: [{ area: "Transformers", level: 25 }, { area: "PyTorch", level: 75 }] });
  const text = lines.join("\n");
  assert.match(text, /Maya/);
  assert.match(text, /Cognitive Science/);
  assert.match(text, /Transformers: can follow it \(25\)/i);
  assert.match(text, /PyTorch: can use it \(75\)/i);
  assert.match(text, P.DEPTHS[1].rule.split("\n")[0].slice(0, 20));
  assert.deepEqual(P.readerBlock({}), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/onboarding-model.test.js`
Expected: FAIL — `Cannot find module '../api/_lib/onboarding-model'`.

- [ ] **Step 3: Write the prompts module**

```js
// api/_lib/onboarding-prompts.js
"use strict";

// Every prompt the onboarding sends, in one place. The harness around them
// (onboarding.js, onboarding-model.js) reads shapes, never wording, so any
// template here can be rewritten freely. Inputs each template expects are
// documented above it. `analyzePrompt` is the diagnostic prompt verbatim.

// The five capability stops the diagnostic asks at. `level` is what the
// slider, the grader and the workspace all speak; `capability` is the
// prompt's own slug; `phrase` is how a person says it.
const LADDER = [
  { level: 0, capability: "wouldn't_know_where_to_start", phrase: "wouldn't know where to start",
    label: "Wouldn't know where to start", desc: "I wouldn't recognize most of the important concepts." },
  { level: 25, capability: "can_follow", phrase: "can follow it",
    label: "I can follow it", desc: "I recognize the main ideas when someone explains them." },
  { level: 50, capability: "can_explain", phrase: "can explain it",
    label: "I can explain it", desc: "I could explain the core ideas in my own words, from memory." },
  { level: 75, capability: "can_use", phrase: "can use it",
    label: "I can use it", desc: "I could use the ideas to solve a new problem or make a design decision." },
  { level: 100, capability: "can_reason_with", phrase: "can reason with it",
    label: "I can reason with it", desc: "I could spot mistakes, compare approaches, and explain when an idea would or wouldn't work." },
];

// How technical explanations should be: the four stops of the Explanations
// step. `rule` is the sentence the model is given; `hc` is the level name
// the workspace's reader profile stores.
const DEPTHS = [
  { key: "everyday", label: "Everyday", phrase: "in everyday language", hc: "plain",
    desc: "Plain words, no jargon, analogies where they help.",
    rule: "Write for somebody who has not programmed. Prefer the everyday word to the technical one; where a technical word is unavoidable, say what it means in the same sentence -- once, plainly. Name what a thing does rather than what it is called, and never use an acronym they did not use first." },
  { key: "some", label: "Some detail", phrase: "with some technical detail", hc: "some",
    desc: "Uses some technical language when necessary; assumes some familiarity.",
    rule: "Write for somebody who codes a little. Ordinary terms -- file, function, branch, server, test -- can stand on their own; anything narrower than that gets a few words saying what it is, the first time it appears." },
  { key: "technical", label: "Technical", phrase: "technical", hc: "full",
    desc: "Assumes you know the field well; explanations of niche concepts.",
    rule: "Write for somebody fluent. Use the precise term and do not gloss it: an explanation they did not need is an explanation in their way." },
  { key: "expert", label: "Expert", phrase: "expert-level", hc: "expert",
    desc: "Terse and precise; uses specific jargon and references advanced concepts.",
    rule: "Write for a peer. Terse, precise, specific jargon and references to advanced work without introduction; assume they will look up anything they do not know." },
];

// The Paper step's familiarity slider: the reader's own guess at where they
// stand with THIS project, before any question is asked.
const FAMILIARITY = [
  { level: 0, label: "I'm completely lost", desc: "I wouldn't understand what the project does or what to learn first." },
  { level: 1, label: "I wouldn't know where to start", desc: "I follow the main ideas, but wouldn't know how to start building or contributing." },
  { level: 2, label: "I can get oriented", desc: "I grasp the general ideas, but need heavy guidance on the paper, code, or methods." },
  { level: 3, label: "I can get started", desc: "I can navigate the paper and code, spot what to learn, and begin a task with little guidance." },
  { level: 4, label: "I can extend it", desc: "I can independently implement, troubleshoot, compare approaches, and design extensions." },
];

const JSON_ONLY = "Return ONLY valid JSON with nothing outside it.";

function depthOf(key) {
  return DEPTHS.find((d) => d.key === key) || null;
}

function rung(level) {
  return LADDER.find((r) => r.level === Number(level)) || null;
}

// The block every generation prompt carries: who this is for, how
// technical to be, and what the grader found they already know. Nothing at
// all when nothing is known -- a prompt should not apologise for that.
// reader = {name, year, major, depth, knowledge:[{area, level}]}
function readerBlock(reader) {
  reader = reader && typeof reader === "object" ? reader : {};
  const name = String(reader.name || "").trim();
  const year = String(reader.year || "").trim();
  const major = String(reader.major || "").trim();
  const depth = depthOf(reader.depth);
  const knowledge = (Array.isArray(reader.knowledge) ? reader.knowledge : [])
    .filter((k) => k && String(k.area || "").trim() && rung(k.level));
  if (!name && !year && !major && !depth && !knowledge.length) return [];
  const out = ["# Who you are writing for", ""];
  const who = [name, [year, major].filter(Boolean).join(" studying ")].filter(Boolean).join(", ");
  if (who) out.push(who + ".");
  if (depth) out.push(`Explanations ${depth.phrase}. ${depth.rule}`);
  if (knowledge.length) {
    out.push("", "What they already know, graded from short answers they gave:");
    for (const k of knowledge) {
      const r = rung(k.level);
      out.push(`- ${String(k.area).trim()}: ${r.phrase} (${r.level}) -- ${r.desc}`);
    }
    out.push("Start explanations where these levels say to, not lower and not higher.");
  }
  return out;
}

// The diagnostic. Inputs: familiarityLabel/familiarityDesc (a FAMILIARITY
// stop), depthLabel/depthDesc (a DEPTHS stop). The paper and the URLs are
// spliced in by onboarding-model.analyze around the two tags below, so this
// returns the text BEFORE the paper tag and the text AFTER it, separately.
function analyzePrompt({ familiarityLabel, familiarityDesc, depthLabel, depthDesc }) {
  const before = `## Prompt
You are designing a very short prior-knowledge diagnostic for an undergraduate who wants to understand, extend, or contribute to an existing PhD student's research project.

Your goal is NOT to test broad academic knowledge. Identify the 2–4 pieces of prior knowledge that would most change how another LLM should explain the project, introduce prerequisites and terminology, decompose extensions, discuss implementation and experiments, and help the student reason productively about the work.

## Inputs

The student's self-reported familiarity with this kind of work is:
${familiarityLabel}${familiarityDesc ? " -- " + familiarityDesc : ""}

The student prefers:
${depthLabel}${depthDesc ? " -- " + depthDesc : ""}

<phd_student_paper>
`;
  const after = `
</phd_student_paper>

<project_urls>
%URLS%
</project_urls>

## Project summary

Produce:

- a 2–4 word title capturing the project's central idea;

- a one-sentence plain-language description of what it does or investigates;

- the publication/project date supported by the supplied sources.

The one-liner should be understandable without specialist knowledge while preserving the project's important idea.

Do not invent a date. Use \`null\` if none can be determined.

## Select knowledge areas

Choose exactly 2–4 areas that would best calibrate how to discuss THIS PROJECT with THIS STUDENT.

Choose granularity jointly from:

- project requirements;

- the student's self-reported experience;

- desired technical depth.

Include an area only if knowing the student's level would materially change where explanations begin, their technical depth, or how the project is decomposed.

Prefer areas that are CENTRAL, DISCRIMINATIVE, ACTIONABLE, COHERENT, and NON-REDUNDANT.

Do not assume narrower is better. If a project's immediate dependency is too specific for the student's background, probe a broader prerequisite that better identifies their entry point. If the student is already experienced or wants greater technical depth, probe more specific project dependencies.

For a transformer-based project, for example:

- not at all familiar → "Machine Learning," "Linear Algebra," "PyTorch"

- moderately familiar → "Transformer architectures"

- very familiar → specific mechanisms or methods used by the project

Avoid overly broad fields like "Computer science" or "Cognitive science" when a more specific area would be informative, but do not fragment unnecessarily.

Use this test:

"If we knew the student's level here, would it tell us where to begin and how technically deep to go?"

If not, choose a broader or narrower area.

## Questions

For EACH selected area, produce exactly five independently answerable calibration questions:

0 — WOULDN'T KNOW WHERE TO START
"I wouldn't recognize most of the important concepts."

25 — CAN FOLLOW IT
"I recognize the main ideas when someone explains them."

50 — CAN EXPLAIN IT
"I could explain the core ideas in my own words, from memory."

75 — CAN USE IT
"I could use the ideas to solve a new problem or make a design decision."

100 — CAN REASON WITH IT
"I could spot mistakes, compare approaches, and explain when an idea would or wouldn't work."

Levels should progress from CONCEPTUAL FAMILIARITY to APPLIED REASONING:

- 0 — RECOGNITION: Does the student know what the area is about and recognize its basic concepts? Surface unknown unknowns.

- 25 — BASIC UNDERSTANDING: Can they follow the main concepts when explained or contextualized?

- 50 — INDEPENDENT UNDERSTANDING: Can they explain important concepts and relationships in their own words?

- 75 — APPLICATION: Can they use that understanding to solve a new problem, predict an outcome, or make a project-relevant decision?

- 100 — REASONING: Can they diagnose failures, compare approaches, evaluate tradeoffs, or explain when an approach would or would not work?

Levels 0–50 primarily measure familiarity and understanding; 75–100 measure productive reasoning with that knowledge.

Difficulty should come from deeper understanding and reasoning, not obscure terminology, trivia, tedious mathematics, or memorization.

Whenever possible, ground 75- and 100-level questions in realistic situations from THIS PROJECT. Lower levels may be more direct when needed to determine whether the student possesses the relevant concepts.

Questions should usually be answerable in 1–4 sentences and should not depend on incidental paper details.

Avoid:

- trivia, historical facts, or acronym expansion;

- obscure terminology used only to increase difficulty;

- exact equations unless genuinely essential;

- testing multiple unrelated areas at once;

- yes/no self-report such as "Do you know PyTorch?";

- questions answerable through generic common sense without the relevant knowledge.

Each question must be independently answerable and probe the same area at the intended depth.

## Sample responses

Provide one sample response for every question that approximately reflects the TARGET LEVEL:

- 0: basic recognition or orientation;

- 25: enough familiarity to follow an explanation;

- 50: independent, correct conceptual understanding;

- 75: successful application to a new situation;

- 100: diagnosis, comparison, tradeoff reasoning, critique, or adaptation.

## Source discipline

Base the project summary and area selection only on the supplied task, paper, project material, URLs, repository information, and student information.

Do not invent dependencies merely because they are common in the field.

If a supplied URL or repository cannot be inspected, do not pretend its contents were available.

## Output

Return ONLY valid JSON with exactly this schema:

{
"title": "2–4 word project title",
"one_liner": "One sentence explaining the project in plain language.",
"date": "YYYY, YYYY-MM-DD, or null",
"areas": [
{
"area": "string",
"parent_field": "string or null",
"project_role": "One sentence explaining why this knowledge matters for understanding or extending this particular project.",
"granularity_rationale": "One sentence explaining why this is the appropriate level of specificity for this student.",
"questions": [
{
"level": 0,
"capability": "wouldn't_know_where_to_start",
"question": "string",
"sample_response": "string"
},
{
"level": 25,
"capability": "can_follow",
"question": "string",
"sample_response": "string"
},
{
"level": 50,
"capability": "can_explain",
"question": "string",
"sample_response": "string"
},
{
"level": 75,
"capability": "can_use",
"question": "string",
"sample_response": "string"
},
{
"level": 100,
"capability": "can_reason_with",
"question": "string",
"sample_response": "string"
}
]
}
]
}

Before outputting, silently verify:

- title is 2–4 words;

- one-liner accurately communicates the central project idea;

- date is source-supported or \`null\`;

- exactly 2–4 areas;

- area granularity reflects project requirements, student familiarity, and desired depth;

- no substantial redundancy;

- exactly five questions per area;

- 0–50 show progressively stronger familiarity and understanding;

- 75 requires genuine application;
- 100 requires evaluation, comparison, diagnosis, or adaptation;

- samples reflect the intended capability;

- output is valid JSON with nothing outside it.
`;
  return { before, after };
}

// Grading one answer. Inputs: area, question, level (the question's), sample
// (the prompt's sample_response for that level), answer (the reader's).
function gradePrompt({ area, question, level, sample, answer }) {
  const ladder = LADDER.map((r) => `${r.level} -- ${r.label}: ${r.desc}`).join("\n");
  return `A student answered one short calibration question about "${area}". Estimate which capability level the answer demonstrates.

The levels:
${ladder}

The question was written for level ${level}. A sample answer at that level:
"""
${sample}
"""

The student's answer:
"""
${answer}
"""

Judge the answer's substance, not its length or polish. An answer that shows the target level's capability scores ${level}; one that shows less scores the highest level it does show; one that shows more (correct application, comparison, diagnosis beyond what was asked) may score higher. An answer that is empty, evasive, or wrong scores 0.

${JSON_ONLY}
{"level": 0 | 25 | 50 | 75 | 100, "confidence": 0.0-1.0, "rationale": "one sentence, at most 200 characters"}`;
}

// The project-scoping questions of the Details step. Inputs: reader (for
// readerBlock), paper {title, one_liner}, draft, registerNote (a sentence
// saying the register was shifted, or "").
function detailsPrompt({ reader, paper, draft, registerNote }) {
  return [
    ...readerBlock(reader), "",
    `They are building on "${paper.title}" -- ${paper.one_liner}`,
    `Their project, in their words: "${draft}"`,
    registerNote ? registerNote : "",
    "",
    "Ask 3 or 4 questions that would change what their first project should be: who it is for, what it must do first, what it must never do, what they already have. Never ask what they already said. Prefer choices they can pick from; one question may be free text.",
    "Phrase every question and every option at the register above; the options are the reader's own likely answers, not jargon.",
    "",
    JSON_ONLY,
    '{"intro": "one short line, or empty", "questions": [{"id": "slug", "kind": "choice" | "multi" | "short", "title": "the question", "hint": "optional", "options": ["..."], "placeholder": "for short"}]}',
  ].filter((line) => line !== null).join("\n");
}

// Four goals to choose a first project from. Inputs: reader, paper, draft,
// details {questions, answers} (answers keyed by question id).
function goalsPrompt({ reader, paper, draft, details }) {
  const answered = (details && Array.isArray(details.questions) ? details.questions : [])
    .map((q) => {
      const a = details.answers ? details.answers[q.id] : null;
      if (a == null || a === "") return "";
      return `- ${q.title} ${Array.isArray(a) ? a.join("; ") : a}`;
    }).filter(Boolean);
  return [
    ...readerBlock(reader), "",
    `They are building on "${paper.title}" -- ${paper.one_liner}`,
    `Their project, in their words: "${draft}"`,
    answered.length ? "What they said when asked:" : "", ...answered,
    "",
    "Offer exactly four goals a first project could be about, each an outcome they could tell you they had reached, not a task and not a phase. Order them so the first is the one everything else depends on. Each carries a short name (2-4 words) and one sentence on why it is worth starting there, written at the register above.",
    "",
    JSON_ONLY,
    '{"goals": [{"label": "the outcome", "short": "2-4 words", "why": "one sentence"}]}',
  ].join("\n");
}

// The rows for the chosen goal, and a name for the project. Inputs: reader,
// paper, draft, goal (the label), details.
function todosPrompt({ reader, paper, draft, goal, details }) {
  return [
    ...readerBlock(reader), "",
    `They are building on "${paper.title}" -- ${paper.one_liner}`,
    `Their project, in their words: "${draft}"`,
    `The goal they picked: "${goal}"`,
    "",
    "Write 2 to 4 TODO rows for that goal: each one piece of work in the imperative that a coding agent could pick up and finish in one sitting, ordered easiest first, each naming its finish line. No phases, no headings. Then propose a project name of two or three words a folder could be called.",
    "Write at the register above.",
    "",
    JSON_ONLY,
    '{"todos": ["..."], "name": "two or three words"}',
  ].join("\n");
}

// "Ask about this": a question about text the reader selected. Inputs:
// reader (with depth set to the register asked for), paper, quote, question.
function askPrompt({ reader, paper, quote, question }) {
  return [
    ...readerBlock(reader), "",
    `Context: they are setting up a first project building on "${paper.title}" -- ${paper.one_liner}`,
    `They selected this text on the page: "${quote}"`,
    `They ask: "${question}"`,
    "",
    "Answer in at most four sentences at the register above. If the question is whether something is too much for a first project, say so plainly and name the smaller version.",
    "",
    JSON_ONLY,
    '{"answer": "..."}',
  ].join("\n");
}

module.exports = {
  DEPTHS, FAMILIARITY, LADDER, JSON_ONLY,
  depthOf, rung, readerBlock,
  analyzePrompt, gradePrompt, detailsPrompt, goalsPrompt, todosPrompt, askPrompt,
};
```

- [ ] **Step 4: Generalise `pickModel` in setup-chat.js**

Replace `pickModel`:

```js
const FALLBACKS = { sonnet: "claude-sonnet-4-5-20250929", haiku: "claude-haiku-4-5-20251001" };

// The dated id of one model family the account may use; the bare alias a
// member's own subscription understands is not one the gateway answers to.
function pickModel(models, family = "sonnet") {
  const want = FALLBACKS[family] ? family : "sonnet";
  for (const name of Array.isArray(models) ? models : []) {
    if (typeof name === "string" && name.includes(want) && /\d{8}/.test(name)) return name;
  }
  return FALLBACKS[want];
}
```

Keep `FALLBACK_MODEL = FALLBACKS.sonnet` exported (tests reference it).

- [ ] **Step 5: Write the model module**

```js
// api/_lib/onboarding-model.js
"use strict";

// The onboarding's model calls: one client that speaks Anthropic content
// blocks (the paper travels as a `document`), and one normalizer per reply
// shape. Every reply is model output on its way into the reader's record
// and into later prompts, so all of it is bounded and none of it trusted.

const { pickModel } = require("./setup-chat");
const P = require("./onboarding-prompts");

const MAX_REPLY_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 90 * 1000;
const ANALYZE_TOKENS = 8192;
const ANALYZE_TIMEOUT_MS = 100 * 1000;
const MAX_PAGE_TEXT = 20000;
const LEVELS = [0, 25, 50, 75, 100];

function one(value, cap) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, cap);
}

function long(value, cap) {
  return String(value == null ? "" : value).replace(/\r/g, "").trim().slice(0, cap);
}

function extractJson(text) {
  const value = String(text || "");
  try { return JSON.parse(value); } catch { /* fall through */ }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

async function callModel(request, credentials, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const body = {
    model: pickModel(credentials.models, request.family || "sonnet"),
    max_tokens: request.maxTokens || MAX_REPLY_TOKENS,
    messages: [{ role: "user", content: request.content }],
  };
  if (request.system) body.system = request.system;
  const response = await fetchImpl(`${credentials.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
    body: JSON.stringify(body),
    signal: options.signal || AbortSignal.timeout(request.timeoutMs || MODEL_TIMEOUT_MS),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = value && value.error && (value.error.message || value.error);
    const error = new Error(one(detail, 200) || `The model gateway answered ${response.status}`);
    // 401/429 is the member's key spent or throttled: a 409 the page can
    // show, not a 502 that reads as our outage.
    error.statusCode = response.status === 401 || response.status === 429 ? 409 : 502;
    throw error;
  }
  const text = (Array.isArray(value.content) ? value.content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text || "")).join("\n");
  return extractJson(text);
}

function text(value) {
  return { type: "text", text: value };
}

// --- analysis ---------------------------------------------------------------

function normalizeDate(value) {
  const s = one(value, 10);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return null;
  const [, m, d] = s.split("-").map(Number);
  if (m !== undefined && (m < 1 || m > 12)) return null;
  if (d !== undefined && (d < 1 || d > 31)) return null;
  return s;
}

function normalizeArea(value, index) {
  if (!value || typeof value !== "object") return null;
  const area = one(value.area, 80);
  if (!area) return null;
  const byLevel = new Map();
  for (const q of Array.isArray(value.questions) ? value.questions : []) {
    if (!q || typeof q !== "object") continue;
    const level = Number(q.level);
    if (!LEVELS.includes(level) || byLevel.has(level)) continue;
    const question = long(q.question, 600);
    if (!question) continue;
    byLevel.set(level, { level, capability: P.rung(level).capability,
      question, sample_response: long(q.sample_response, 1200) });
  }
  if (byLevel.size !== 5) return null;
  return {
    index, area,
    parent_field: one(value.parent_field, 80),
    project_role: long(value.project_role, 300),
    granularity_rationale: long(value.granularity_rationale, 300),
    questions: LEVELS.map((level) => byLevel.get(level)),
  };
}

function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const areas = (Array.isArray(raw.areas) ? raw.areas : [])
    .map(normalizeArea).filter(Boolean).slice(0, 4)
    .map((a, index) => ({ ...a, index }));
  if (areas.length < 2) return null;
  return {
    title: one(raw.title, 60),
    one_liner: long(raw.one_liner, 300),
    date: normalizeDate(raw.date),
    areas,
  };
}

// input = {familiarityLabel, familiarityDesc, depthLabel, depthDesc,
//          pdfBase64 | pdfText, urls: [{url, text}]}
async function analyze(input, credentials, options = {}) {
  const { before, after } = P.analyzePrompt(input);
  const urls = (Array.isArray(input.urls) ? input.urls : [])
    .map((u) => `${one(u.url, 500)}\n${long(u.text, MAX_PAGE_TEXT)}`.trim()).filter(Boolean)
    .join("\n\n") || "(none supplied)";
  const tail = after.replace("%URLS%", urls);
  const content = input.pdfBase64
    ? [text(before),
       { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } },
       text(tail)]
    : [text(before + long(input.pdfText, 400000) + tail)];
  const raw = await callModel({ content, family: "sonnet", maxTokens: ANALYZE_TOKENS,
    timeoutMs: ANALYZE_TIMEOUT_MS }, credentials, options);
  const analysis = normalizeAnalysis(raw);
  if (!analysis) {
    const error = new Error("The paper analysis did not come back in a usable shape");
    error.statusCode = 502;
    throw error;
  }
  return analysis;
}

// --- grading ----------------------------------------------------------------

function normalizeGrade(raw) {
  if (!raw || typeof raw !== "object") return null;
  const level = Number(raw.level);
  if (!Number.isFinite(level)) return null;
  const snapped = LEVELS.reduce((best, l) => Math.abs(l - level) < Math.abs(best - level) ? l : best, 0);
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  return { level: snapped, confidence, rationale: one(raw.rationale, 200) };
}

async function grade(input, credentials, options = {}) {
  let raw;
  try {
    raw = await callModel({ content: [text(P.gradePrompt(input))], family: "haiku", maxTokens: 300 },
      credentials, options);
  } catch (error) {
    if (error.statusCode === 409) throw error;
    return null;
  }
  return normalizeGrade(raw);
}

// --- generation -------------------------------------------------------------

const KINDS = ["choice", "multi", "short"];

function normalizeDetails(raw) {
  if (!raw || typeof raw !== "object") return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((q, i) => {
    if (!q || typeof q !== "object") return null;
    const title = one(q.title, 200);
    if (!title) return null;
    const kind = KINDS.includes(q.kind) ? q.kind : "short";
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => one(typeof o === "object" && o ? o.label : o, 120)).filter(Boolean).slice(0, 6);
    const out = { id: one(q.id, 40) || `q${i + 1}`, kind: options.length ? kind : "short", title,
      hint: one(q.hint, 200) };
    if (out.kind === "short") out.placeholder = one(q.placeholder, 120);
    else out.options = options;
    return out;
  }).filter(Boolean).slice(0, 4);
  if (questions.length < 3) return null;
  return { intro: one(raw.intro, 200), questions };
}

function normalizeGoals(raw) {
  if (!raw || typeof raw !== "object") return null;
  const goals = (Array.isArray(raw.goals) ? raw.goals : []).map((g) => {
    if (!g || typeof g !== "object") return null;
    const label = one(g.label, 200);
    return label ? { label, short: one(g.short, 40), why: one(g.why, 300) } : null;
  }).filter(Boolean).slice(0, 4);
  if (goals.length < 4) return null;
  return { goals };
}

function normalizeTodos(raw) {
  if (!raw || typeof raw !== "object") return null;
  const todos = (Array.isArray(raw.todos) ? raw.todos : []).map((t) => one(t, 300)).filter(Boolean).slice(0, 4);
  if (todos.length < 2) return null;
  return { todos, name: one(raw.name, 80) };
}

function normalizeAsk(raw) {
  if (!raw || typeof raw !== "object") return null;
  const answer = long(raw.answer, 1200);
  return answer ? { answer } : null;
}

async function generate(prompt, normalize, credentials, options, what) {
  const raw = await callModel({ content: [text(prompt)], family: "sonnet" }, credentials, options);
  const out = normalize(raw);
  if (!out) {
    const error = new Error(`The ${what} did not come back in a usable shape`);
    error.statusCode = 502;
    throw error;
  }
  return out;
}

const details = (input, c, o) => generate(P.detailsPrompt(input), normalizeDetails, c, o, "questions");
const goals = (input, c, o) => generate(P.goalsPrompt(input), normalizeGoals, c, o, "goals");
const todos = (input, c, o) => generate(P.todosPrompt(input), normalizeTodos, c, o, "todos");
const ask = (input, c, o) => generate(P.askPrompt(input), normalizeAsk, c, o, "answer");

module.exports = {
  LEVELS, MAX_PAGE_TEXT,
  callModel, pickModel, extractJson,
  analyze, grade, details, goals, todos, ask,
  normalizeAnalysis, normalizeGrade, normalizeDetails, normalizeGoals, normalizeTodos, normalizeAsk,
};
```

- [ ] **Step 6: Apply the spike's verdict**

If Task 1 found `document` blocks are not forwarded: in `analyze`, always take the text branch (`input.pdfText`), and note in the module comment that the browser extracts text (Task 7 Step 7). Keep the `document` branch behind `input.pdfBase64` regardless — the test above covers both.

- [ ] **Step 7: Run the tests**

Run: `node --test tests/onboarding-model.test.js tests/setup-chat.test.js tests/engelbart-research-model.test.js`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add api/_lib/onboarding-prompts.js api/_lib/onboarding-model.js api/_lib/setup-chat.js tests/onboarding-model.test.js
git commit -m "Onboarding prompts and model client: the diagnostic, grading, generation

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---
### Task 5: The onboarding record

**Files:**
- Create: `api/_lib/onboarding.js`
- Modify: `api/_lib/storage.js` (add `downloadObject`), `api/_lib/setup-chat.js` (`normalizePayload` learns `reader`), `api/engelbart-setup.js` (export `ownPaperToken`)
- Test: `tests/onboarding.test.js`

**Interfaces:**
- Consumes: `OM.*` and `P.*` from Task 4; `supabase.{selectRows, selectOne, insertRows, patchRows, rpc}`; `Credits.credentialsFor(user, options)`; `PageFetch.{safeHttpUrl, fetchPageText}`; `Storage.paperObjectPath`; `Curated.optUuid`.
- Produces (`onboarding.js`), every function taking `(user, …, options)` where `options = {env?, fetchImpl?}` reaches every Supabase and model call:
  - `open(user, {fresh}, options)` → `{onboarding, calibrations}`
  - `step(user, row, {step, fields}, options)` → `{onboarding}`
  - `sources(user, row, body, credentials, options)` → `{analysis_status, analysis_error?}`
  - `analysis(user, row, {retry}, credentials, options)` → `{analysis_status, analysis?, analysis_error?}`
  - `answer(user, row, calibrations, body, credentials, options)` → `{graded_level, grade_confidence, grade_rationale, follow_up?}`
  - `details/goals(user, row, calibrations, {regenerate}, credentials, options)`, `todos(user, row, calibrations, {goal, regenerate}, credentials, options)`, `ask(user, row, calibrations, body, credentials, options)`
  - `create(user, row, calibrations, body, options)` → `{ok, pending_setup_id}`
  - pure: `areaLevels(analysis, calibrations)`, `knowledgeOf(analysis, calibrations)`, `assessedDepth(depthKey, levels)`, `readerOf(row, calibrations)`, `toPayload(row, calibrations)`, `STEP_FIELDS`.
- Produces (`storage.js`): `downloadObject(path, options)` → `Buffer`.
- Produces (`setup-chat.js`): `normalizePayload` keeps `reader = {name ≤60, year ≤40, major ≤80, level ∈ plain|some|full|expert, knowledge ≤4 of {area ≤80, parent_field ≤80, level ∈ LEVELS, project_role ≤300}}`; exported `normalizeReader`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/onboarding.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const OB = require("../api/_lib/onboarding");
const SetupChat = require("../api/_lib/setup-chat");
const setupHandler = require("../api/engelbart-setup");

const ENV = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-role", LITELLM_BASE_URL: "https://proxy.example.com",
  LITELLM_MASTER_KEY: "sk-master", ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
};
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };
const PAPER = "22222222-2222-2222-2222-222222222222";
const CREDS = { apiKey: "k", baseUrl: "https://proxy.example.com", models: ["all-proxy-models"] };

function five() {
  return [0, 25, 50, 75, 100].map((level) => ({ level, capability: "x", question: `q${level}`, sample_response: `s${level}` }));
}
const ANALYSIS = { title: "Zebra Tuning", one_liner: "It tunes zebras.", date: "2024", areas: [
  { index: 0, area: "Transformers", parent_field: "ML", project_role: "core", granularity_rationale: "g", questions: five() },
  { index: 1, area: "PyTorch", parent_field: "", project_role: "code", granularity_rationale: "g", questions: five() },
] };

// An in-memory PostgREST + Storage + model gateway, routed by URL. Rows are
// keyed per table; PATCH/GET filters understand `col=eq.value` only.
function fake({ model = {}, pdf = Buffer.from("%PDF-1.4 fake") } = {}) {
  const tables = { engelbart_onboardings: [], engelbart_onboarding_calibrations: [],
    engelbart_onboarding_asks: [], hc_profiles: [] };
  const calls = [];
  const rpcs = [];
  let ids = 0;
  function match(row, query) {
    return [...new URLSearchParams(query)].every(([k, v]) => {
      if (k === "select" || k === "order" || k === "limit" || k === "on_conflict") return true;
      const m = /^eq\.(.*)$/.exec(v);
      return m ? String(row[k]) === m[1] : true;
    });
  }
  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (value, status = 200) => ({ ok: status < 300, status, async text() { return JSON.stringify(value); }, async json() { return value; },
      async arrayBuffer() { return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength); } });
    if (u.pathname.startsWith("/rest/v1/rpc/")) { rpcs.push({ name: u.pathname.split("/").pop(), body }); return json("33333333-3333-3333-3333-333333333333"); }
    if (u.pathname.startsWith("/rest/v1/")) {
      const table = u.pathname.slice("/rest/v1/".length);
      const rows = tables[table];
      if (method === "GET") return json(rows.filter((r) => match(r, u.search)));
      if (method === "POST") {
        const made = body.map((r) => ({ id: `id-${++ids}`, created_at: "t", ...r }));
        if (String((init.headers || {}).Prefer || "").includes("merge-duplicates")) {
          for (const m of made) { const i = rows.findIndex((r) => r.user_id === m.user_id); if (i >= 0) rows[i] = { ...rows[i], ...m }; else rows.push(m); }
        } else rows.push(...made);
        return json(made);
      }
      if (method === "PATCH") { const hit = rows.filter((r) => match(r, u.search)); hit.forEach((r) => Object.assign(r, body)); return json(hit); }
    }
    if (u.pathname.startsWith("/storage/v1/object/")) return { ok: true, status: 200, async arrayBuffer() { return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength); }, async text() { return ""; } };
    if (u.pathname === "/v1/messages") {
      const text = body.messages[0].content.map((b) => b.text || "").join("\n");
      const reply = /prior-knowledge diagnostic/.test(text) ? model.analysis
        : /calibration question/.test(text) ? model.grade
        : /Ask 3 or 4 questions/.test(text) ? model.details
        : /exactly four goals/.test(text) ? model.goals
        : /TODO rows/.test(text) ? model.todos : model.ask;
      return json({ content: [{ type: "text", text: JSON.stringify(reply) }] });
    }
    if (u.hostname === "x.org") return { ok: true, status: 200, headers: { get: () => "text/html" }, async text() { return "<p>project page</p>"; } };
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { tables, calls, rpcs, options: { env: ENV, fetchImpl } };
}

test("open creates one live row and finds it again; a created row is shown, fresh starts over", async () => {
  const db = fake();
  const first = await OB.open(USER, {}, db.options);
  assert.equal(first.onboarding.status, "open");
  const again = await OB.open(USER, {}, db.options);
  assert.equal(again.onboarding.id, first.onboarding.id);
  db.tables.engelbart_onboardings[0].status = "created";
  const shown = await OB.open(USER, {}, db.options);
  assert.equal(shown.onboarding.status, "created");
  const fresh = await OB.open(USER, { fresh: true }, db.options);
  assert.equal(fresh.onboarding.status, "open");
  assert.notEqual(fresh.onboarding.id, first.onboarding.id);
});

test("step keeps only whitelisted fields, bounds them, and never moves step backwards", async () => {
  const db = fake();
  const { onboarding } = await OB.open(USER, {}, db.options);
  const out = await OB.step(USER, onboarding, { step: 3, fields: { name: "  Maya ", depth: "expert",
    status: "created", analysis_status: "done", project_draft: "d".repeat(3000) } }, db.options);
  assert.equal(out.onboarding.name, "Maya");
  assert.equal(out.onboarding.depth, "expert");
  assert.equal(out.onboarding.status, "open");
  assert.equal(out.onboarding.project_draft.length, 2000);
  const back = await OB.step(USER, out.onboarding, { step: 1, fields: { depth: "nope" } }, db.options);
  assert.equal(back.onboarding.step, 3);
  assert.equal(back.onboarding.depth, "expert");                  // an unknown depth changes nothing
});

test("sources needs the paper token, then analyses to completion and stores the result", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  await assert.rejects(OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: "bad", paper_familiarity: 2 }, CREDS, db.options),
    (e) => e.statusCode === 403);
  const token = setupHandler.ownPaperToken(PAPER, USER.id, ENV);
  const out = await OB.sources(USER, onboarding, { paper_id: PAPER, paper_token: token, project_url: "https://x.org/p",
    repo_url: "", paper_familiarity: 2 }, CREDS, db.options);
  assert.equal(out.analysis_status, "done");
  const row = db.tables.engelbart_onboardings[0];
  assert.equal(row.paper_id, PAPER);
  assert.equal(row.paper_title, "Zebra Tuning");
  assert.equal(row.analysis.areas.length, 2);
  const modelCall = db.calls.find((c) => c.url.endsWith("/v1/messages"));
  const blocks = JSON.parse(modelCall.init.body).messages[0].content;
  assert.equal(blocks[1].type, "document");
  assert.match(blocks[2].text, /project page/);
});

test("a running analysis younger than three minutes is not started twice", async () => {
  const db = fake({ model: { analysis: ANALYSIS } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { paper_id: PAPER, analysis_status: "running",
    analysis_started_at: new Date().toISOString() });
  const out = await OB.analysis(USER, db.tables.engelbart_onboardings[0], { retry: true }, CREDS, db.options);
  assert.equal(out.analysis_status, "running");
  assert.equal(db.calls.filter((c) => c.url.endsWith("/v1/messages")).length, 0);
  db.tables.engelbart_onboardings[0].analysis_started_at = new Date(Date.now() - 200000).toISOString();
  const again = await OB.analysis(USER, db.tables.engelbart_onboardings[0], { retry: true }, CREDS, db.options);
  assert.equal(again.analysis_status, "done");
});

test("answer stores the row, grades it, and asks a follow-up when the grade disagrees", async () => {
  const db = fake({ model: { grade: { level: 25, confidence: 0.9, rationale: "recognises only" } } });
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { analysis: ANALYSIS, analysis_status: "done" });
  const out = await OB.answer(USER, db.tables.engelbart_onboardings[0], [], { area_index: 0, question_level: 75,
    self_level: 75, answer: "I think it's about attention" }, CREDS, db.options);
  assert.equal(out.graded_level, 25);
  assert.deepEqual(out.follow_up, { question_level: 25, question: "q25" });
  const cal = db.tables.engelbart_onboarding_calibrations[0];
  assert.equal(cal.sample_response, "s75");
  assert.equal(cal.graded_level, 25);
  // Second question in the same area: no further follow-up, whatever the grade.
  const second = await OB.answer(USER, db.tables.engelbart_onboardings[0], db.tables.engelbart_onboarding_calibrations,
    { area_index: 0, question_level: 25, self_level: 75, answer: "It weights inputs" }, CREDS, db.options);
  assert.equal(second.follow_up, undefined);
  assert.deepEqual(OB.areaLevels(ANALYSIS, db.tables.engelbart_onboarding_calibrations), [25, null]);
});

test("assessedDepth shifts one stop on the graded mean and names the weakest area", () => {
  assert.deepEqual(OB.assessedDepth("technical", [25, 0]), { key: "some", shift: -1, weakest: 1 });
  assert.deepEqual(OB.assessedDepth("some", [75, 100]), { key: "technical", shift: 1, weakest: 0 });
  assert.deepEqual(OB.assessedDepth("everyday", [0, 25]), { key: "everyday", shift: 0, weakest: 0 });
  assert.deepEqual(OB.assessedDepth("some", [null, null]), { key: "some", shift: 0, weakest: -1 });
});

test("create maps the record to the pending payload, writes the profile, and is idempotent", async () => {
  const db = fake();
  const { onboarding } = await OB.open(USER, {}, db.options);
  Object.assign(db.tables.engelbart_onboardings[0], { name: "Maya", year: "Second year", major: "CogSci",
    depth: "technical", paper_id: PAPER, paper_title: "Zebra Tuning", project_url: "https://x.org/p",
    project_draft: "A tool", analysis: ANALYSIS, analysis_status: "done",
    goals: { goals: [1, 2, 3, 4].map((n) => ({ label: `G${n}`, short: `s${n}`, why: `w${n}` })) } });
  db.tables.engelbart_onboarding_calibrations.push({ onboarding_id: onboarding.id, user_id: USER.id, area_index: 0,
    question_level: 50, self_level: 50, graded_level: 50, answered_at: "2026-09-02T00:00:00Z" });
  const out = await OB.create(USER, db.tables.engelbart_onboardings[0], db.tables.engelbart_onboarding_calibrations,
    { project_name: "zebra-tuner", goal_chosen: "G2", todos: ["do a", "do b"] }, db.options);
  assert.equal(out.ok, true);
  const saved = db.rpcs.find((r) => r.name === "engelbart_save_pending_setup").body.p_payload;
  assert.equal(saved.name, "zebra-tuner");
  assert.equal(saved.chosen, "G2");
  assert.deepEqual(saved.todos, ["do a", "do b"]);
  assert.equal(saved.goals.length, 4);
  assert.match(saved.plan.description, /A tool[\s\S]*Building on “Zebra Tuning” — It tunes zebras\./);
  assert.deepEqual(saved.paper, { paper_id: PAPER, title: "Zebra Tuning", url: "https://x.org/p" });
  assert.equal(saved.reader.level, "full");
  assert.deepEqual(saved.reader.knowledge, [{ area: "Transformers", parent_field: "ML", level: 50, project_role: "core" }]);
  const profile = db.tables.hc_profiles[0];
  assert.equal(profile.tech_level, "full");
  assert.equal(profile.display_name, "Maya");
  assert.equal(db.tables.engelbart_onboardings[0].status, "created");
  const twice = await OB.create(USER, db.tables.engelbart_onboardings[0], [], { project_name: "other" }, db.options);
  assert.equal(twice.ok, true);
  assert.equal(db.rpcs.filter((r) => r.name === "engelbart_save_pending_setup").length, 1);
});

test("normalizePayload keeps a bounded reader and drops a broken one", () => {
  const out = SetupChat.normalizePayload({ name: "n", plan: { description: "d" }, reader: { name: "x".repeat(100),
    level: "expert", knowledge: [{ area: "A", level: 50 }, { area: "", level: 50 }, { area: "B", level: 33 }] } });
  assert.equal(out.reader.name.length, 60);
  assert.equal(out.reader.level, "expert");
  assert.deepEqual(out.reader.knowledge, [{ area: "A", parent_field: "", level: 50, project_role: "" }]);
  assert.equal(SetupChat.normalizePayload({ name: "n", reader: "junk" }).reader, undefined);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/onboarding.test.js`
Expected: FAIL — `Cannot find module '../api/_lib/onboarding'`.

- [ ] **Step 3: Export `ownPaperToken` from engelbart-setup.js and accept an env**

Change the function to `function ownPaperToken(paperId, userId, env = process.env) { return crypto.createHmac("sha256", encryptionKey(env)).update(\`own-paper:${paperId}:${userId}\`).digest("base64url"); }` and after `module.exports = handler;` add `module.exports.ownPaperToken = ownPaperToken;`.

- [ ] **Step 4: Add `downloadObject` to storage.js**

```js
// One stored PDF's bytes, for the analysis call. Read with the service role
// straight from the bucket; never handed to a browser.
async function downloadObject(path, options = {}) {
  const env = options.env || process.env;
  const config = supabaseConfig(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const response = await fetchImpl(`${config.url}/storage/v1/object/${PAPERS_BUCKET}/${encodeURI(path)}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: options.signal,
  });
  if (!response.ok) {
    const error = new Error("The stored paper could not be read");
    error.statusCode = 502;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}
```

Export it.

- [ ] **Step 5: Teach `normalizePayload` about `reader`**

In `setup-chat.js`, above `normalizePayload`:

```js
const READER_LEVELS = ["plain", "some", "full", "expert"];
const KNOWLEDGE_LEVELS = [0, 25, 50, 75, 100];

// Who the project is for, as the workspace's reader profile stores it, plus
// what the diagnostic found they already know. Bounded like everything else
// in the payload; dropped whole when it is not an object.
function normalizeReader(value) {
  if (!value || typeof value !== "object") return null;
  const level = String(value.level || "").trim().toLowerCase();
  const knowledge = (Array.isArray(value.knowledge) ? value.knowledge : []).map((k) => {
    if (!k || typeof k !== "object") return null;
    const area = one(k.area, 80);
    const lvl = Number(k.level);
    if (!area || !KNOWLEDGE_LEVELS.includes(lvl)) return null;
    return { area, parent_field: one(k.parent_field, 80), level: lvl, project_role: one(k.project_role, 300) };
  }).filter(Boolean).slice(0, 4);
  return {
    name: one(value.name, 60), year: one(value.year, 40), major: one(value.major, 80),
    level: READER_LEVELS.includes(level) ? level : "",
    knowledge,
  };
}
```

In `normalizePayload`, after provenance: `const reader = normalizeReader(value.reader); if (reader) out.reader = reader;`. Export `normalizeReader`.

- [ ] **Step 6: Write the record module**

```js
// api/_lib/onboarding.js
"use strict";

// The onboarding record: one live row per reader, written as they go, and
// the operations the page performs on it. Everything the reader types is
// bounded here before it is stored; everything the model answers was
// bounded in onboarding-model. The row is the truth the page mirrors.

const crypto = require("node:crypto");
const OM = require("./onboarding-model");
const P = require("./onboarding-prompts");
const Storage = require("./storage");
const PageFetch = require("./page-fetch");
const Curated = require("./curated");
const SetupChat = require("./setup-chat");
const { insertRows, patchRows, selectRows, rpc } = require("./supabase");

const TABLE = "engelbart_onboardings";
const CALIBRATIONS = "engelbart_onboarding_calibrations";
const ASKS = "engelbart_onboarding_asks";
const PROFILES = "hc_profiles";
const RUNNING_STALE_MS = 180 * 1000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const DEPTH_KEYS = P.DEPTHS.map((d) => d.key);

function one(value, cap) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, cap);
}
function long(value, cap) {
  return String(value == null ? "" : value).replace(/\r/g, "").trim().slice(0, cap);
}
function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function eq(column, value) {
  return `${column}=eq.${encodeURIComponent(String(value))}`;
}

// --- the row ------------------------------------------------------------------

async function rowsOf(user, options) {
  return selectRows(TABLE, `${eq("user_id", user.id)}&select=*&order=created_at.desc`, options);
}

async function calibrationsOf(row, options) {
  return selectRows(CALIBRATIONS, `${eq("onboarding_id", row.id)}&select=*&order=asked_at.asc`, options);
}

async function patch(row, values, options) {
  const rows = await patchRows(TABLE, `${eq("id", row.id)}`, { ...values, updated_at: new Date().toISOString() }, options);
  const updated = Array.isArray(rows) && rows[0] ? rows[0] : { ...row, ...values };
  Object.assign(row, updated);
  return row;
}

function publicRow(row) {
  const { user_id, ...rest } = row;
  return rest;
}

// The live row: the open one, else the newest created one (the page shows
// Done again), else a new one. `fresh` skips a created row and starts over.
async function open(user, body, options = {}) {
  const rows = await rowsOf(user, options);
  let row = rows.find((r) => r.status === "open");
  if (!row && !(body && body.fresh)) row = rows.find((r) => r.status === "created");
  if (!row) {
    const made = await insertRows(TABLE, [{ user_id: user.id }], options);
    row = Array.isArray(made) ? made[0] : made;
  }
  const calibrations = await calibrationsOf(row, options);
  return { onboarding: publicRow(row), calibrations: calibrations.map(publicRow) };
}

// --- step: the fields the page may write ------------------------------------

const STEP_FIELDS = {
  name: (v) => one(v, 60),
  year: (v) => one(v, 40),
  major: (v) => one(v, 80),
  depth: (v) => (DEPTH_KEYS.includes(String(v)) ? String(v) : undefined),
  project_draft: (v) => long(v, 2000),
  goal_chosen: (v) => one(v, 200),
  todos: (v) => (Array.isArray(v) ? v.map((t) => one(t, 300)).filter(Boolean).slice(0, 4) : undefined),
  project_name: (v) => one(v, 80),
};

function requireOpen(row) {
  if (!row || row.status !== "open") throw fail("This setup is already finished", 409);
}

async function step(user, row, body, options = {}) {
  requireOpen(row);
  const fields = body && body.fields && typeof body.fields === "object" ? body.fields : {};
  const values = {};
  for (const [key, clean] of Object.entries(STEP_FIELDS)) {
    if (!(key in fields)) continue;
    const value = clean(fields[key]);
    if (value !== undefined) values[key] = value;
  }
  if (fields.details_answers && typeof fields.details_answers === "object" && row.details) {
    const answers = { ...(row.details.answers || {}) };
    for (const q of row.details.questions || []) {
      if (!(q.id in fields.details_answers)) continue;
      const a = fields.details_answers[q.id];
      answers[q.id] = a == null ? null : Array.isArray(a) ? a.map((x) => one(x, 120)).slice(0, 6) : long(a, 1000);
    }
    values.details = { ...row.details, answers };
  }
  const asked = Number(body && body.step);
  if (Number.isInteger(asked)) values.step = Math.max(Number(row.step) || 0, Math.min(10, Math.max(0, asked)));
  await patch(row, values, options);
  return { onboarding: publicRow(row) };
}

// --- sources and the analysis ------------------------------------------------

function ownPaperToken(paperId, userId, env) {
  return require("../engelbart-setup").ownPaperToken(paperId, userId, env);
}

function optionalUrl(value) {
  const text = one(value, 500);
  if (!text) return "";
  try { return PageFetch.safeHttpUrl(text); } catch { throw fail("Links must be public http(s) pages", 400); }
}

function analysisRunning(row, now = Date.now()) {
  if (row.analysis_status !== "running") return false;
  const started = Date.parse(row.analysis_started_at || "") || 0;
  return now - started < RUNNING_STALE_MS;
}

async function pageTexts(row, options) {
  const out = [];
  for (const url of [row.project_url, row.repo_url]) {
    if (!url) continue;
    let text = "";
    try { text = await PageFetch.fetchPageText(url, options); } catch { text = "(could not be fetched)"; }
    out.push({ url, text });
  }
  return out;
}

async function runAnalysis(user, row, credentials, options) {
  await patch(row, { analysis_status: "running", analysis_started_at: new Date().toISOString(), analysis_error: "" }, options);
  try {
    const pdf = await Storage.downloadObject(Storage.paperObjectPath(row.paper_id), options);
    if (pdf.length > MAX_PDF_BYTES) throw fail("That PDF is larger than 20 MB", 413);
    const familiarity = P.FAMILIARITY[Number(row.paper_familiarity) || 0];
    const depth = P.depthOf(row.depth) || P.DEPTHS[0];
    const analysis = await OM.analyze({
      familiarityLabel: familiarity.label, familiarityDesc: familiarity.desc,
      depthLabel: depth.label, depthDesc: depth.desc,
      pdfBase64: pdf.toString("base64"),
      urls: await pageTexts(row, options),
    }, credentials, options);
    await patch(row, { analysis, analysis_status: "done", paper_title: analysis.title }, options);
    return { analysis_status: "done", analysis };
  } catch (error) {
    await patch(row, { analysis_status: "error", analysis_error: one(error.message, 300) || "analysis failed" }, options);
    if (error.statusCode === 409) throw error;
    return { analysis_status: "error", analysis_error: row.analysis_error };
  }
}

async function sources(user, row, body, credentials, options = {}) {
  requireOpen(row);
  const paperId = Curated.optUuid(body && body.paper_id);
  if (!paperId) throw fail("Add the paper first", 400);
  const expected = ownPaperToken(paperId, user.id, options.env);
  const given = String((body && body.paper_token) || "");
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw fail("That paper is not yours to analyse", 403);
  const familiarity = Number(body.paper_familiarity);
  if (!Number.isInteger(familiarity) || familiarity < 0 || familiarity > 4) throw fail("Say how familiar you are with the paper", 400);
  if (analysisRunning(row)) return { analysis_status: "running" };
  await patch(row, { paper_id: paperId, project_url: optionalUrl(body.project_url), repo_url: optionalUrl(body.repo_url),
    paper_familiarity: familiarity, analysis: null, paper_title: "" }, options);
  return runAnalysis(user, row, credentials, options);
}

async function analysis(user, row, body, credentials, options = {}) {
  if (body && body.retry) {
    if (!row.paper_id) throw fail("Add the paper first", 400);
    if (analysisRunning(row)) return { analysis_status: "running" };
    return runAnalysis(user, row, credentials, options);
  }
  const out = { analysis_status: row.analysis_status };
  if (row.analysis_status === "done") out.analysis = row.analysis;
  if (row.analysis_status === "error") out.analysis_error = row.analysis_error;
  return out;
}

// --- calibration -------------------------------------------------------------

function questionAt(analysisValue, areaIndex, level) {
  const area = analysisValue && Array.isArray(analysisValue.areas) ? analysisValue.areas[areaIndex] : null;
  if (!area) return null;
  const q = area.questions.find((x) => x.level === level);
  return q ? { area, question: q } : null;
}

async function answer(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
  const areaIndex = Number(body.area_index);
  const level = Number(body.question_level);
  const self = Number(body.self_level);
  const said = long(body.answer, 2000);
  if (!OM.LEVELS.includes(level) || !OM.LEVELS.includes(self)) throw fail("That level is not on the ladder", 400);
  if (!said) throw fail("Write an answer first", 400);
  const found = questionAt(row.analysis, areaIndex, level);
  if (!found) throw fail("That question is not in this analysis", 400);
  const prior = calibrations.filter((c) => Number(c.area_index) === areaIndex);
  const existing = prior.find((c) => Number(c.question_level) === level);
  const values = { area: found.area.area, parent_field: found.area.parent_field, self_level: self,
    question: found.question.question, sample_response: found.question.sample_response,
    answer: said, answered_at: new Date().toISOString(), graded_level: null, grade_confidence: null, grade_rationale: "" };
  let cal;
  if (existing) {
    const rows = await patchRows(CALIBRATIONS, `${eq("id", existing.id)}`, values, options);
    cal = Object.assign(existing, rows[0] || values);
  } else {
    const rows = await insertRows(CALIBRATIONS, [{ onboarding_id: row.id, user_id: user.id, area_index: areaIndex,
      question_level: level, ...values }], options);
    cal = rows[0];
    calibrations.push(cal);
  }
  const graded = await OM.grade({ area: found.area.area, question: found.question.question, level,
    sample: found.question.sample_response, answer: said }, credentials, options);
  if (graded) {
    const rows = await patchRows(CALIBRATIONS, `${eq("id", cal.id)}`, { graded_level: graded.level,
      grade_confidence: graded.confidence, grade_rationale: graded.rationale }, options);
    Object.assign(cal, rows[0] || {}, { graded_level: graded.level, grade_confidence: graded.confidence, grade_rationale: graded.rationale });
  }
  const out = { graded_level: cal.graded_level, grade_confidence: cal.grade_confidence, grade_rationale: cal.grade_rationale };
  // One follow-up, at the level the grade found, when it disagrees with the
  // self-rating and this was the area's first question.
  const first = prior.length === 0 || (prior.length === 1 && prior[0].id === cal.id);
  if (first && graded && Math.abs(graded.level - self) >= 25 && graded.level !== level) {
    const next = questionAt(row.analysis, areaIndex, graded.level);
    if (next) out.follow_up = { question_level: graded.level, question: next.question.question };
  }
  return out;
}

// Each area's level: the last answered question's graded level, else its
// self-rating; null for an area never answered.
function areaLevels(analysisValue, calibrations) {
  const areas = analysisValue && Array.isArray(analysisValue.areas) ? analysisValue.areas : [];
  return areas.map((_, i) => {
    const mine = (calibrations || []).filter((c) => Number(c.area_index) === i && c.answered_at)
      .sort((a, b) => String(a.answered_at).localeCompare(String(b.answered_at)));
    if (!mine.length) return null;
    const last = mine[mine.length - 1];
    return last.graded_level == null ? Number(last.self_level) : Number(last.graded_level);
  });
}

function knowledgeOf(analysisValue, calibrations) {
  const levels = areaLevels(analysisValue, calibrations);
  return levels.map((level, i) => (level == null ? null : {
    area: analysisValue.areas[i].area, parent_field: analysisValue.areas[i].parent_field,
    level, project_role: analysisValue.areas[i].project_role,
  })).filter(Boolean);
}

// The register everything after Topics is written at: the chosen depth,
// shifted one stop down when the graded mean is at or below "can follow",
// one stop up at or above "can use".
function assessedDepth(depthKey, levels) {
  const known = (levels || []).filter((l) => l != null);
  const index = Math.max(0, DEPTH_KEYS.indexOf(depthKey));
  if (!known.length) return { key: DEPTH_KEYS[index], shift: 0, weakest: -1 };
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  const shift = mean <= 25 ? -1 : mean >= 75 ? 1 : 0;
  const to = Math.max(0, Math.min(DEPTH_KEYS.length - 1, index + shift));
  let weakest = -1;
  (levels || []).forEach((l, i) => { if (l != null && (weakest < 0 || l < levels[weakest])) weakest = i; });
  return { key: DEPTH_KEYS[to], shift: to - index, weakest };
}

function readerOf(row, calibrations) {
  const levels = areaLevels(row.analysis, calibrations);
  const assessed = assessedDepth(row.depth, levels);
  return { name: row.name, year: row.year, major: row.major, depth: assessed.key,
    knowledge: knowledgeOf(row.analysis, calibrations), assessed };
}

function registerNote(row, reader) {
  const { assessed } = reader;
  if (assessed.shift < 0) {
    const area = assessed.weakest >= 0 ? row.analysis.areas[assessed.weakest].area.toLowerCase() : "the paper's areas";
    return `Note: the reader is newest to ${area}; ask in plainer terms than their chosen register.`;
  }
  if (assessed.shift > 0) return "Note: the reader graded strongly across the paper's areas; ask more directly.";
  return "";
}

function introFor(row, reader) {
  const { assessed } = reader;
  if (assessed.shift < 0) {
    const area = assessed.weakest >= 0 ? row.analysis.areas[assessed.weakest].area.toLowerCase() : "the topics";
    return `Asking in plainer terms — you're newest to ${area}.`;
  }
  if (assessed.shift > 0) return "Asking more directly — you answered strongly across the paper's areas.";
  return "";
}

function paperOf(row) {
  const a = row.analysis || {};
  return { title: one(a.title || row.paper_title, 60), one_liner: one(a.one_liner, 300) };
}

// --- generation ---------------------------------------------------------------

async function details(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.analysis_status !== "done") throw fail("The paper is still being read", 409);
  if (row.details && row.details.questions && !(body && body.regenerate)) return row.details;
  const reader = readerOf(row, calibrations);
  const made = await OM.details({ reader, paper: paperOf(row), draft: row.project_draft, registerNote: registerNote(row, reader) },
    credentials, options);
  const value = { intro: made.intro || introFor(row, reader), questions: made.questions, answers: {} };
  await patch(row, { details: value }, options);
  return value;
}

async function goals(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  if (row.goals && row.goals.goals && !(body && body.regenerate)) return row.goals;
  const reader = readerOf(row, calibrations);
  const made = await OM.goals({ reader, paper: paperOf(row), draft: row.project_draft, details: row.details || {} },
    credentials, options);
  await patch(row, { goals: made }, options);
  return made;
}

async function todos(user, row, calibrations, body, credentials, options = {}) {
  requireOpen(row);
  const goal = one(body && body.goal, 200);
  if (!goal) throw fail("Pick a goal first", 400);
  if (row.todos && row.goal_chosen === goal && !(body && body.regenerate)) return { todos: row.todos, name: row.project_name };
  const reader = readerOf(row, calibrations);
  const made = await OM.todos({ reader, paper: paperOf(row), draft: row.project_draft, goal, details: row.details || {} },
    credentials, options);
  await patch(row, { todos: made.todos, goal_chosen: goal, project_name: row.project_name || made.name }, options);
  return { todos: made.todos, name: row.project_name };
}

async function ask(user, row, calibrations, body, credentials, options = {}) {
  const quote = one(body && body.quote, 240);
  const question = one(body && body.question, 300);
  if (!question) throw fail("Ask something first", 400);
  const reader = readerOf(row, calibrations);
  if (DEPTH_KEYS.includes(String(body && body.level))) reader.depth = String(body.level);
  const made = await OM.ask({ reader, paper: paperOf(row), quote, question }, credentials, options);
  await insertRows(ASKS, [{ onboarding_id: row.id, user_id: user.id, step: Number(body.step) || 0, quote, question,
    level: reader.depth, answer: made.answer }], options);
  return { answer: made.answer, level: reader.depth };
}

// --- create -------------------------------------------------------------------

function toPayload(row, calibrations) {
  const paper = paperOf(row);
  const reader = readerOf(row, calibrations);
  const depth = P.depthOf(reader.depth) || P.DEPTHS[0];
  const offered = (row.goals && Array.isArray(row.goals.goals) ? row.goals.goals : [])
    .map((g) => ({ label: g.label, why: g.why }));
  if (row.goal_chosen && !offered.some((g) => g.label === row.goal_chosen)) offered.push({ label: row.goal_chosen, why: "" });
  const payload = {
    name: row.project_name,
    plan: { description: [row.project_draft, paper.title ? `Building on “${paper.title}” — ${paper.one_liner}` : ""]
      .filter(Boolean).join("\n\n"), unsure: [] },
    goals: offered,
    chosen: row.goal_chosen,
    todos: Array.isArray(row.todos) ? row.todos : [],
    subgoals: [],
    reader: { name: reader.name, year: reader.year, major: reader.major, level: depth.hc, knowledge: reader.knowledge },
  };
  if (row.paper_id) {
    payload.paper = { paper_id: row.paper_id, title: paper.title, url: row.project_url || "" };
    payload.provenance = { papers: [{ paper_id: row.paper_id, title: paper.title }],
      idea: { title: row.goal_chosen, inspired: paper.title } };
  }
  return payload;
}

async function create(user, row, calibrations, body, options = {}) {
  if (row.status === "created") return { ok: true, pending_setup_id: row.pending_setup_id };
  const values = {};
  if (body && "project_name" in body) values.project_name = one(body.project_name, 80);
  if (body && "goal_chosen" in body) values.goal_chosen = one(body.goal_chosen, 200);
  if (body && Array.isArray(body.todos)) values.todos = body.todos.map((t) => one(t, 300)).filter(Boolean).slice(0, 4);
  Object.assign(row, values);
  if (!row.project_name) throw fail("Name this project first", 400);
  if (!row.goal_chosen) throw fail("Pick a goal first", 400);
  if (!Array.isArray(row.todos) || row.todos.length < 2) throw fail("At least two todos", 400);
  const payload = SetupChat.normalizePayload(toPayload(row, calibrations));
  const saved = await rpc("engelbart_save_pending_setup", { p_user_id: user.id, p_payload: payload }, options);
  const pendingId = typeof saved === "string" ? saved : (saved && saved.id) || null;
  await insertRows(PROFILES, [{ user_id: user.id, display_name: payload.reader.name, year: payload.reader.year,
    major: payload.reader.major, tech_level: payload.reader.level, knowledge: payload.reader.knowledge,
    updated_at: new Date().toISOString() }], { ...options, query: "on_conflict=user_id",
    prefer: "resolution=merge-duplicates,return=representation" });
  await patch(row, { ...values, status: "created", pending_setup_id: pendingId, step: 10 }, options);
  return { ok: true, pending_setup_id: pendingId };
}

module.exports = {
  STEP_FIELDS, RUNNING_STALE_MS, MAX_PDF_BYTES,
  open, step, sources, analysis, answer, details, goals, todos, ask, create,
  areaLevels, knowledgeOf, assessedDepth, readerOf, toPayload, analysisRunning, publicRow,
};
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/onboarding.test.js tests/onboarding-model.test.js tests/setup-chat.test.js`
Expected: all pass. If `insertRows` ignores `options.query`, check `supabase.js` — it appends `?${options.query}`; the upsert relies on that.

- [ ] **Step 8: Commit**

```bash
git add api/_lib/onboarding.js api/_lib/storage.js api/_lib/setup-chat.js api/engelbart-setup.js tests/onboarding.test.js
git commit -m "The onboarding record: open, step, sources, calibration, generation, create

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---
### Task 6: The handler

**Files:**
- Create: `api/engelbart-onboarding.js`
- Modify: `vercel.json` (`functions["api/engelbart-onboarding.js"].maxDuration = 120`)
- Test: `tests/engelbart-onboarding.test.js`

**Interfaces:**
- Consumes: everything from Task 5 (`OB.*`), `verifyUser`, `Credits.credentialsFor`, `http.{allowMethods, bearerToken, publicError, readJson, sendJson}`.
- Produces: `POST /api/engelbart-onboarding` dispatching `body.action` to `open | step | sources | analysis | answer | details | goals | todos | ask | create`. `module.exports = handler; handler.dispatch = dispatch` where `dispatch(user, body, options)` is the testable core taking injected `options`.

- [ ] **Step 1: Write the failing test**

```js
// tests/engelbart-onboarding.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/engelbart-onboarding");

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };

// The dispatcher is exercised with an injected record module so the handler's
// own job -- naming actions, loading the row, gating on credit -- is what the
// test sees.
function deps(overrides = {}) {
  const row = { id: "row-1", user_id: USER.id, status: "open", step: 0, analysis_status: "none" };
  return {
    credentialsFor: async () => ({ status: "active", apiKey: "k", baseUrl: "https://p", models: [], budgetUsd: 25, spendUsd: 1 }),
    OB: {
      open: async () => ({ onboarding: row, calibrations: [] }),
      step: async (u, r, b) => ({ onboarding: { ...r, step: b.step } }),
      sources: async () => ({ analysis_status: "done" }),
      analysis: async () => ({ analysis_status: "none" }),
      answer: async () => ({ graded_level: 50 }),
      details: async () => ({ intro: "", questions: [] }),
      goals: async () => ({ goals: [] }),
      todos: async () => ({ todos: [], name: "" }),
      ask: async () => ({ answer: "a" }),
      create: async () => ({ ok: true, pending_setup_id: "p" }),
      ...overrides.OB,
    },
    ...overrides,
  };
}

test("open returns the row, the calibrations and the credit meter", async () => {
  const out = await handler.dispatch(USER, { action: "open" }, deps());
  assert.equal(out.onboarding.id, "row-1");
  assert.deepEqual(out.credit, { status: "active", budgetUsd: 25, spendUsd: 1 });
  assert.equal(out.apiKey, undefined);
});

test("a spent key stops the flow at open with the credit wording", async () => {
  await assert.rejects(handler.dispatch(USER, { action: "open" }, deps({
    credentialsFor: async () => ({ status: "exhausted" }) })), (e) => e.statusCode === 409 && /credit/i.test(e.message));
});

test("model actions receive the member's credentials; step does not need them", async () => {
  let seen = null;
  const d = deps({ OB: { details: async (u, r, c, b, credentials) => { seen = credentials; return { intro: "", questions: [] }; } },
    credentialsFor: async () => ({ status: "active", apiKey: "member", baseUrl: "https://p", models: [] }) });
  await handler.dispatch(USER, { action: "details" }, d);
  assert.equal(seen.apiKey, "member");
  let asked = 0;
  await handler.dispatch(USER, { action: "step", step: 2, fields: {} }, deps({ credentialsFor: async () => { asked += 1; return { status: "active" }; } }));
  assert.equal(asked, 0);
});

test("an unknown action is a 400", async () => {
  await assert.rejects(handler.dispatch(USER, { action: "dance" }, deps()), (e) => e.statusCode === 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/engelbart-onboarding.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler**

```js
// api/engelbart-onboarding.js
"use strict";

// The onboarding page's one endpoint. Every action names the member by their
// Supabase session, loads their live onboarding row, and -- for anything that
// asks the model -- bills their own credit key, exactly as the setup
// conversation did. The record module does the work; this file only routes.

const Credits = require("./_lib/credits");
const OnboardingRecord = require("./_lib/onboarding");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

const MODEL_ACTIONS = new Set(["open", "sources", "analysis", "answer", "details", "goals", "todos", "ask"]);

function spent(credentials) {
  return credentials.status === "exhausted" || credentials.status === "blocked";
}

async function memberCredentials(user, d) {
  const credentials = await (d.credentialsFor || Credits.credentialsFor)(user, d.options || {});
  if (spent(credentials)) {
    const error = new Error("Your Engelbart Claude credit is used up, so setup cannot run right now. Reach out to us to top it up.");
    error.statusCode = 409;
    throw error;
  }
  return credentials;
}

// d = {OB?, credentialsFor?, options?} -- injected by tests; production uses
// the real modules and process.env.
async function dispatch(user, body, d = {}) {
  const OB = d.OB || OnboardingRecord;
  const options = d.options || {};
  const action = String(body.action || "");
  const credentials = MODEL_ACTIONS.has(action) ? await memberCredentials(user, d) : null;

  if (action === "open") {
    const out = await OB.open(user, body, options);
    return { ...out, credit: { status: credentials.status, budgetUsd: credentials.budgetUsd, spendUsd: credentials.spendUsd } };
  }
  const { onboarding: row, calibrations } = await OB.open(user, {}, options);
  if (action === "step") return OB.step(user, row, body, options);
  if (action === "sources") return OB.sources(user, row, body, credentials, options);
  if (action === "analysis") return OB.analysis(user, row, body, credentials, options);
  if (action === "answer") return OB.answer(user, row, calibrations, body, credentials, options);
  if (action === "details") return OB.details(user, row, calibrations, body, credentials, options);
  if (action === "goals") return OB.goals(user, row, calibrations, body, credentials, options);
  if (action === "todos") return OB.todos(user, row, calibrations, body, credentials, options);
  if (action === "ask") return OB.ask(user, row, calibrations, body, credentials, options);
  if (action === "create") return OB.create(user, row, calibrations, body, options);
  const error = new Error("Unknown Engelbart onboarding action");
  error.statusCode = 400;
  throw error;
}

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const user = await verifyUser(bearerToken(req));
    return sendJson(res, 200, await dispatch(user, body));
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
module.exports.dispatch = dispatch;
```

Note `OB.open` inside `dispatch` re-reads the row for every action: `open()` in Task 5 returns `publicRow(row)` (no `user_id`), and the record functions only need `id`, `status`, `step`, `analysis*`, `details`, `goals`, `todos`, `goal_chosen`, `project_name`, `paper_*`, `depth`, `name/year/major`, `project_draft` — all present. `patch()` filters by `id`.

- [ ] **Step 4: vercel.json**

Add under `functions`: `"api/engelbart-onboarding.js": { "maxDuration": 120 }`.

- [ ] **Step 5: Run the suite**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add api/engelbart-onboarding.js vercel.json tests/engelbart-onboarding.test.js
git commit -m "The onboarding endpoint

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---
### Task 7: The page, steps Name → Project

**Files:**
- Rewrite: `engelbart/setup/index.html`, `engelbart/setup/setup.css`, `engelbart/setup/setup.js`
- Test: `tests/setup-page.test.js`

**Interfaces:**
- Consumes: `/api/engelbart-config` (Supabase client), `/api/engelbart-onboarding` (Task 6), `/api/engelbart-setup {own_paper, own_paper_saved}`.
- Produces: `setup.js` exposes nothing global; its state object `st` and functions `api(action, body)`, `draw()`, `go(n)`, `slider(opts)`, `railView()` are the frame Task 8 fills for steps 6–10 (`drawTopics`, `drawDetails`, `drawFocus`, `drawTodos`, `drawDone`, `askPanel`), which Task 7 leaves as stubs that render the "generating" indicator.

The visual spec is `docs/superpowers/reference/onboarding-flow/markup.html` (DOM and inline styles per step) with `script.js` (behaviour) and `tokens.css` (tokens). Flatten it: every inline `style="…"` becomes a class in `setup.css`; every `sc-if` becomes a branch in a `drawX()` function; every `sc-for` a loop; `sc-camel-on-*` an `addEventListener`. Fixture data in `script.js` (`GOALS`, `TODOS`, `PROJECT_QS`, `ANALYSIS_FALLBACK`, `GLOSS`) is NOT ported — the server generates those.

- [ ] **Step 1: Write the failing page test**

```js
// tests/setup-page.test.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "setup.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "engelbart", "setup", "setup.css"), "utf8");

test("the setup page ships no inline script or style and loads its own files", () => {
  assert.doesNotMatch(html, /<script>[^<]/);
  assert.doesNotMatch(html, /<style>/);
  assert.match(html, /href="\/engelbart\/setup\/setup\.css"/);
  assert.match(html, /src="\/engelbart\/setup\/setup\.js"/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@/);
});

test("the page talks to the onboarding endpoint and the paper upload", () => {
  assert.match(js, /"\/api\/engelbart-onboarding"/);
  assert.match(js, /action: "own_paper"/);
  assert.match(js, /action: "own_paper_saved"/);
  assert.match(js, /action: "sources"/);
  assert.match(js, /"\/engelbart\/signin"/);
});

test("the rail names the ten steps in order", () => {
  const labels = ["Name", "Year", "Major", "Explanations", "Paper", "Project", "Topics", "Details", "Focus", "Todos"];
  const found = /var LABELS = \[([^\]]*)\]/.exec(js);
  assert.ok(found, "LABELS array");
  assert.deepEqual(JSON.parse("[" + found[1] + "]"), labels);
});

test("the stylesheet carries the reference tokens", () => {
  assert.match(css, /--blue-600:#0070f3/);
  assert.match(css, /--gray-900:#171717/);
  assert.match(css, /@keyframes rise/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/setup-page.test.js`
Expected: FAIL (old page has no `LABELS`, no onboarding endpoint).

- [ ] **Step 3: index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Set up your first project · Engelbart</title>
  <meta name="description" content="Tell Engelbart who you are and which paper you are building on; it writes your first project.">
  <meta name="robots" content="noindex, nofollow">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/engelbart/setup/setup.css">
</head>
<body>
  <div class="ob" id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.min.js" integrity="sha384-yiVMs0R/Jyz7OhoXa/DsEMUSBLjEhr/QJta2ONO+zB6I8/GmNg/7AUFrZmAJV7KV" crossorigin="anonymous"></script>
  <script src="/engelbart/setup/setup.js"></script>
</body>
</html>
```

- [ ] **Step 4: setup.css**

Start from `tokens.css` verbatim (the `:root` scale, semantic, type, space, radius and motion blocks plus the `rise/pulse/pop/spot` keyframes and the `input.range` rules). Then add the classes below, one per inline style in `markup.html` (names are the contract Task 8 reuses):

```css
/* frame */
.ob{min-height:100vh;display:flex;background:var(--bg);color:var(--ink);font-family:var(--font-sans)}
.ob-rail{width:var(--rail-width);flex:none;background:var(--panel2);border-right:1px solid var(--bd);display:flex;flex-direction:column;padding:36px var(--space-8);overflow-y:auto}
.ob-brand{font:var(--text-brand);letter-spacing:var(--track-brand)}
.ob-caption{margin-top:10px;font:var(--text-12);color:var(--fnt)}
.ob-steps{margin-top:var(--space-9);display:flex;flex-direction:column}
.ob-con{display:block;width:1.5px;height:12px;margin-left:20px;background:var(--bd);transition:background var(--dur-slow)}
.ob-con[data-on="1"]{background:var(--acc)}
.ob-row{display:flex;align-items:center;gap:var(--space-4);padding:8px 12px;border-radius:var(--radius-sm);border:1px solid transparent}
.ob-row[data-active="1"]{background:var(--panel);border-color:var(--bd)}
.ob-row[data-reach="1"]{cursor:pointer}
.ob-row[data-reach="1"]:hover{background:var(--hov)}
.ob-circle{flex:none;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:var(--text-microcap);border:1.5px solid var(--bd2);color:var(--fnt);background:var(--panel2);transition:background var(--dur-slow)}
.ob-circle[data-state="done"]{background:var(--acc);color:var(--onacc);border:none}
.ob-circle[data-state="now"]{border:1.5px solid var(--ink);color:var(--ink);background:var(--panel)}
.ob-label{display:block;font:500 13px/1.3 var(--font-sans);color:var(--fnt)}
.ob-label[data-active="1"]{color:var(--ink)}
.ob-label[data-done="1"]{font:var(--text-microcap);letter-spacing:1.2px;text-transform:uppercase;color:var(--fnt)}
.ob-value{display:block;margin-top:3px;font:500 12.5px/1.3 var(--font-sans);color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-reading{margin-top:28px;display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px dashed var(--bd2);border-radius:var(--radius-md);animation:rise var(--dur-rise) both;font:var(--text-12);color:var(--mut)}
.ob-main{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:var(--space-9)}
.ob-body{width:var(--wizard-body-width);max-width:100%}
.ob-content{position:relative}
.ob-step{animation:rise var(--dur-rise) var(--ease-rise) both}
.ob-count{font:var(--text-microcap-lg);letter-spacing:var(--track-microcap-lg);text-transform:uppercase;color:var(--fnt)}
.ob-title{margin-top:14px;font:500 24px/1.35 var(--font-sans);letter-spacing:-0.3px;text-wrap:pretty}
.ob-sub{margin-top:6px;font:var(--text-12-5);color:var(--fnt);text-wrap:pretty}
.ob-field{margin-top:var(--space-7);padding:var(--pad-field);background:var(--tint);border:1px solid var(--bd);border-radius:var(--radius-sm)}
.ob-field input,.ob-field textarea{all:unset;display:block;width:100%;font:14px/1.6 var(--font-sans);color:var(--ink)}
.ob-field textarea{font:14px/1.7 var(--font-sans);resize:none;min-height:64px}
.ob-actions{display:flex;justify-content:flex-end;margin-top:var(--space-6)}
.ob-actions[data-between="1"]{justify-content:space-between;align-items:center;gap:12px}
.ob-cta{display:inline-flex;align-items:center;gap:7px;padding:var(--pad-btn-lg);font:var(--text-microcap-btn-lg);letter-spacing:var(--track-btn-lg);text-transform:uppercase;border-radius:var(--radius-pill);transition:opacity var(--dur-fast);color:var(--onacc);background:var(--ink);border:1px solid var(--ink);cursor:pointer}
.ob-cta:hover{opacity:var(--hover-opacity)}
.ob-cta[disabled]{color:var(--fnt);background:var(--hov);border-color:var(--bd);cursor:default;opacity:1}
.ob-ghost{padding:9px 16px;font:var(--text-microcap-btn-lg);letter-spacing:var(--track-btn-lg);text-transform:uppercase;color:var(--mut);background:transparent;border:1px solid var(--bd);border-radius:var(--radius-pill);cursor:pointer}
.ob-ghost:hover{color:var(--ink);border-color:var(--bd2)}
.ob-hint{font:var(--text-11);color:var(--fnt)}
.ob-err{margin-top:12px;font:var(--text-12);color:var(--del)}
/* options */
.ob-opts{margin-top:var(--space-7);display:flex;flex-direction:column;gap:8px}
.ob-opt{display:flex;align-items:center;gap:11px;padding:var(--pad-opt-lg);border-radius:var(--radius-sm);cursor:pointer;transition:border-color var(--dur-fast),background var(--dur-fast);border:1px solid var(--bd)}
.ob-opt:hover{background:var(--hov)}
.ob-opt[data-on="1"]{border-color:var(--ink)}
.ob-opt[data-on="1"]:hover{background:transparent}
.ob-mark{flex:none;width:11px;height:11px;border-radius:50%;border:1.5px solid var(--bd2)}
.ob-mark[data-square="1"]{border-radius:3px}
.ob-opt[data-on="1"] .ob-mark{border-color:var(--ink);background:var(--ink)}
.ob-opt-text{font:13px/1.4 var(--font-sans);color:var(--mut)}
.ob-opt[data-on="1"] .ob-opt-text{color:var(--ink)}
.ob-seeds{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.ob-seed{padding:6px 12px;font:12px/1.4 var(--font-sans);color:var(--mut);background:transparent;border:1px solid var(--bd);border-radius:var(--radius-pill);cursor:pointer}
.ob-seed:hover{color:var(--ink);border-color:var(--bd2);background:var(--hov)}
/* bar slider (depth, paper familiarity, area familiarity) */
.ob-slider{display:flex;flex-direction:column;gap:12px;user-select:none}
.ob-slider-name{font:var(--text-stop-title);color:var(--acc)}
.ob-slider-desc{margin-top:3px;font:13px/1.5 var(--font-sans);color:var(--mut);text-wrap:pretty}
.ob-track{position:relative;height:56px;touch-action:none;cursor:grab}
.ob-track[data-drag="1"]{cursor:grabbing}
.ob-bars{position:absolute;left:0;right:0;top:0;height:42px;display:flex;align-items:flex-end;gap:8px}
.ob-bar{flex:1;position:relative;overflow:hidden;border-radius:6px;background:var(--bd)}
.ob-bar-fill{position:absolute;inset:0;background:var(--acc);transition:width .25s cubic-bezier(.2,.8,.2,1)}
.ob-track[data-drag="1"] .ob-bar-fill,.ob-track[data-drag="1"] .ob-thumb,.ob-track[data-drag="1"] .ob-line-on{transition:none}
.ob-line{position:absolute;left:0;right:0;top:46px;height:1px;background:var(--bd)}
.ob-line-on{position:absolute;left:0;top:46px;height:1px;background:var(--acc);transition:width .25s cubic-bezier(.2,.8,.2,1)}
.ob-thumb{position:absolute;top:40px;width:13px;height:13px;border-radius:50%;background:var(--panel);border:2px solid var(--acc);box-sizing:border-box;box-shadow:0 0 0 3px var(--panel);transform:translateX(-50%);transition:left .25s cubic-bezier(.2,.8,.2,1)}
.ob-spot{position:absolute;top:46px;width:28px;height:28px;border-radius:50%;background:rgba(0,112,243,.35);pointer-events:none;animation:spot 1s ease-out 3}
.ob-ends{display:flex;justify-content:space-between;font:var(--text-microcap);letter-spacing:1.2px;text-transform:uppercase;color:var(--bd2)}
.ob-stops{display:grid;gap:8px}
.ob-stop{background:none;border:0;padding:0;cursor:pointer;font:400 13px/1.4 var(--font-sans);color:var(--fnt);text-align:center;transition:color .2s}
.ob-stop[data-on="1"]{font-weight:500;color:var(--ink)}
.ob-panel{margin-top:var(--space-7);padding:20px 22px;border:1px solid var(--bd);border-radius:var(--radius-lg);background:var(--tint);display:flex;flex-direction:column;gap:18px}
/* paper */
.ob-card{margin-top:var(--space-7);background:var(--panel);border:1px solid var(--bd);border-radius:var(--radius-lg);padding:24px 20px;display:flex;flex-direction:column;gap:24px}
.ob-stack{border-radius:16px;background:var(--panel2);overflow:hidden;display:flex;flex-direction:column}
.ob-drop{display:flex;flex-direction:column;align-items:center;gap:12px;padding:34px 24px 28px;background:var(--panel2);cursor:pointer;transition:background .2s;text-align:center}
.ob-drop[data-over="1"]{background:var(--hov)}
.ob-drop-icon{width:44px;height:56px;border-radius:8px;background:var(--panel);box-shadow:0 1px 3px rgba(0,0,0,.08),0 6px 16px -8px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;color:var(--acc);font-size:28px;font-weight:300;line-height:1}
.ob-drop-title{font-size:19px;font-weight:500;letter-spacing:-0.2px}
.ob-drop-sub{font-size:14px;color:var(--mut)}
.ob-file{display:flex;align-items:center;gap:14px;padding:18px 18px 18px 20px}
.ob-file-icon{width:32px;height:40px;flex:none;border-radius:5px;background:var(--panel);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.ob-file-name{font-size:15px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-file-meta{font-size:13px;color:var(--mut)}
.ob-link{font:inherit;font-size:13px;border:0;background:none;color:var(--acc);cursor:pointer;padding:0}
.ob-urlrow{display:flex;flex-direction:column;border-top:1px solid var(--bd)}
.ob-urlbtn{display:flex;align-items:center;gap:12px;padding:15px 18px;border:0;background:none;font:inherit;font-size:15px;color:var(--ink);cursor:pointer;text-align:left}
.ob-urlbtn .h{font-size:13px;color:var(--fnt);flex:1}
.ob-urlbtn .s{font-size:13px;color:var(--fnt)}
.ob-urlbtn .c{color:var(--bd2);font-size:16px;display:inline-block;transition:transform .2s}
.ob-urlbtn[data-open="1"] .c{transform:rotate(90deg)}
.ob-urlbody{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .26s var(--ease-rise),opacity .2s}
.ob-urlbody[data-open="1"]{grid-template-rows:1fr;opacity:1}
.ob-urlbody>div{overflow:hidden;min-height:0}
.ob-urlbody input{width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:11px 14px;margin:0 18px 14px;border:1px solid var(--bd);border-radius:var(--radius-md);outline:none;background:var(--panel);color:var(--ink)}
.ob-urlbody input:focus{border-color:var(--bd2)}
/* thinking */
.ob-dots{display:grid;grid-template-columns:repeat(3,4px);gap:2.5px}
.ob-dot{width:4px;height:4px;border-radius:50%;background:var(--ink);opacity:.15;animation:pulse 1.1s ease-in-out infinite}
.ob-wait{animation:rise var(--dur-rise) both;display:flex;flex-direction:column;align-items:center;text-align:center;padding:40px 0}
.ob-wait-t{margin-top:18px;font:500 16px/1.4 var(--font-sans)}
.ob-wait-s{margin-top:6px;font:var(--text-12-5);color:var(--fnt)}
@media(max-width:760px){.ob-rail{display:none}.ob-main{align-items:flex-start;padding:28px 20px}}
```

Task 8 appends the topics/details/focus/todos/done/ask classes to the same file.

- [ ] **Step 5: setup.js — frame, boot, api, rail, slider, steps 0–5**

```js
/* Setting up a first project, after an account exists.
 *
 * Ten steps, one row on the server: every Continue writes what was typed,
 * so a closed tab loses nothing and a reload redraws at the stored step.
 * The paper is read in the background from the moment it is submitted;
 * the reader keeps going and meets its questions two steps later.
 *
 * The rendering follows docs/superpowers/reference/onboarding-flow/
 * markup.html, flattened to plain DOM under the /engelbart CSP. */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var API = "/api/engelbart-onboarding";
  var SETUP_API = "/api/engelbart-setup";
  var DEVICE_API = "/api/engelbart-device";

  var LABELS = ["Name", "Year", "Major", "Explanations", "Paper", "Project", "Topics", "Details", "Focus", "Todos"];
  var YEARS = ["First year", "Second year", "Third year", "Fourth year"];
  var MAJORS = ["Computer Science", "Electrical Engineering & Computer Sciences", "Data Science", "Cognitive Science",
    "Molecular & Cell Biology", "Bioengineering", "Mechanical Engineering", "Applied Mathematics", "Statistics", "Physics",
    "Economics", "Business Administration", "Political Science", "Psychology", "Public Health", "English", "History",
    "Sociology", "Architecture", "Undeclared"];
  var DEPTHS = [
    { key: "everyday", label: "Everyday", phrase: "in everyday language", desc: "Plain words, no jargon, analogies where they help." },
    { key: "some", label: "Some detail", phrase: "with some technical detail", desc: "Uses some technical language when necessary; assumes some familiarity." },
    { key: "technical", label: "Technical", phrase: "technical", desc: "Assumes you know the field well; explanations of niche concepts." },
    { key: "expert", label: "Expert", phrase: "expert-level", desc: "Terse and precise; uses specific jargon and references advanced concepts." }
  ];
  var FAMILIARITY = [
    { label: "I'm completely lost", desc: "I wouldn't understand what the project does or what to learn first." },
    { label: "I wouldn't know where to start", desc: "I follow the main ideas, but wouldn't know how to start building or contributing." },
    { label: "I can get oriented", desc: "I grasp the general ideas, but need heavy guidance on the paper, code, or methods." },
    { label: "I can get started", desc: "I can navigate the paper and code, spot what to learn, and begin a task with little guidance." },
    { label: "I can extend it", desc: "I can independently implement, troubleshoot, compare approaches, and design extensions." }
  ];
  var LADDER = [
    { level: 0, label: "Wouldn't know where to start", desc: "I wouldn't recognize most of the important concepts." },
    { level: 25, label: "I can follow it", desc: "I recognize the main ideas when someone explains them." },
    { level: 50, label: "I can explain it", desc: "I could explain the core ideas in my own words, from memory." },
    { level: 75, label: "I can use it", desc: "I could use the ideas to solve a new problem or make a design decision." },
    { level: 100, label: "I can reason with it", desc: "I could spot mistakes, compare approaches, and explain when an idea would or wouldn't work." }
  ];
  var MAX_PDF = 20 * 1024 * 1024;

  var client = null;    // supabase client
  var session = null;   // the member's session

  // The row is the truth; `ui` is what only this tab knows.
  var st = {
    screen: "loading",  // loading | signin | flow | error
    row: null,          // the onboarding row as the server last returned it
    cals: [],           // calibration rows
    credit: null,
    step: 0,            // the step on screen (row.step is the furthest reached)
    ui: {
      yearOther: false, yearText: "",
      depthPos: 0.25, depthTouched: false, depthDrag: false,
      pfile: null,      // { name, meta, id, token } once uploaded; { name, meta, uploading } meanwhile
      pover: false, popen: null, plink: "", prepo: "", pfam: 0.2, pdrag: false,
      draft: "",
      // Task 8 adds: fIdx, fam{}, fAnswer, followUp, qIdx, answers{}, goalPick, goalOther, todos[], newTodo, projName,
      // askBtn, askOpen, askQuote, askText, asks[], made
    },
    busy: "",           // what is being generated, for the indicator
    error: ""
  };

  // --- helpers ---------------------------------------------------------------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function on(node, event, fn) { node.addEventListener(event, fn); return node; }
  function str(v) { return v == null ? "" : String(v); }
  function trunc(t, n) { t = str(t); return t.length > n ? t.slice(0, n - 1).trim() + "…" : t; }
  function snap(pos, n) { return Math.max(0, Math.min(n - 1, Math.ceil(pos * n) - 1)); }

  function api(action, body) {
    return fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (session && session.access_token) },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (value) {
        if (!r.ok) { var e = new Error(value.error || "the request failed"); e.status = r.status; throw e; }
        return value;
      });
    });
  }

  function setupApi(action, body) {
    return fetch(SETUP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (session && session.access_token) },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    }).then(function (r) { return r.json().then(function (v) { if (!r.ok) throw new Error(v.error || "the request failed"); return v; }); });
  }

  // One write per Continue. The row comes back and replaces ours.
  function save(step, fields) {
    return api("step", { step: step, fields: fields || {} }).then(function (out) {
      st.row = out.onboarding;
      return out;
    });
  }

  function go(n) {
    st.step = n;
    st.error = "";
    if (st.ui.askOpen) st.ui.askOpen = false;
    st.ui.askBtn = null;
    draw();
  }

  function adopt(out) {
    st.row = out.onboarding;
    st.cals = out.calibrations || [];
    if (out.credit) st.credit = out.credit;
    var r = st.row;
    st.ui.yearOther = !!r.year && YEARS.indexOf(r.year) < 0;
    st.ui.yearText = st.ui.yearOther ? r.year : "";
    var d = DEPTHS.map(function (x) { return x.key; }).indexOf(r.depth);
    if (d >= 0) { st.ui.depthPos = (d + 1) / 4; st.ui.depthTouched = true; }
    st.ui.plink = r.project_url || ""; st.ui.prepo = r.repo_url || "";
    if (r.paper_id) st.ui.pfile = { name: r.paper_title || "Your paper", meta: "PDF", id: r.paper_id, token: st.ui.pfile && st.ui.pfile.token };
    if (typeof r.paper_familiarity === "number") st.ui.pfam = (r.paper_familiarity + 1) / 5;
    st.ui.draft = r.project_draft || "";
    st.ui.goalPick = r.goal_chosen || ""; st.ui.todos = (r.todos || []).slice(); st.ui.projName = r.project_name || "";
    st.step = r.status === "created" ? 10 : Math.min(9, r.step || 0);
  }

  // --- the rail ----------------------------------------------------------------

  function depthIndex() { return snap(st.ui.depthPos, 4); }
  function railValues() {
    var r = st.row || {}, u = st.ui;
    return [str(r.name), str(r.year), str(r.major), r.depth ? DEPTHS[depthIndex()].label : "",
      u.pfile ? trunc(u.pfile.name, 26) : "", trunc(str(r.project_draft), 26),
      r.analysis && st.step > 6 ? r.analysis.areas.length + " areas" : "",
      r.details && st.step > 7 ? Object.keys(r.details.answers || {}).length + " of " + r.details.questions.length + " answered" : "",
      st.step > 8 ? trunc(str(r.goal_chosen), 26) : "", st.step >= 10 ? (r.todos || []).length + " todos" : ""];
  }

  function railView() {
    var rail = el("div", "ob-rail");
    rail.appendChild(el("div", "ob-brand", "Engelbart"));
    rail.appendChild(el("div", "ob-caption", "Setting up your first project"));
    var steps = el("div", "ob-steps");
    var vals = railValues(), reach = (st.row && st.row.step) || 0;
    LABELS.forEach(function (label, i) {
      var wrap = el("div");
      if (i > 0) { var con = el("span", "ob-con"); con.setAttribute("data-on", st.step >= i ? "1" : "0"); wrap.appendChild(con); }
      var done = !!vals[i] && st.step > i, active = st.step === i, reachable = i <= reach && st.step < 10;
      var row = el("div", "ob-row");
      row.setAttribute("data-active", active ? "1" : "0");
      row.setAttribute("data-reach", reachable && !active ? "1" : "0");
      if (reachable && !active) on(row, "click", function () { go(i); });
      var circle = el("span", "ob-circle", done ? "✓" : String(i + 1));
      circle.setAttribute("data-state", done ? "done" : active ? "now" : "todo");
      row.appendChild(circle);
      var text = el("span"); text.style.flex = "1"; text.style.minWidth = "0";
      var lab = el("span", "ob-label", label);
      lab.setAttribute("data-active", active ? "1" : "0"); lab.setAttribute("data-done", done && !active ? "1" : "0");
      text.appendChild(lab);
      if (done && !active) text.appendChild(el("span", "ob-value", vals[i]));
      row.appendChild(text); wrap.appendChild(row); steps.appendChild(wrap);
    });
    rail.appendChild(steps);
    if (st.row && st.row.analysis_status === "running") {
      var reading = el("div", "ob-reading");
      reading.appendChild(dots());
      reading.appendChild(el("span", "", "Reading your paper in the background"));
      rail.appendChild(reading);
    }
    return rail;
  }

  function dots() {
    var grid = el("span", "ob-dots");
    for (var i = 0; i < 9; i++) { var d = el("span", "ob-dot"); d.style.animationDelay = (i * 90) + "ms"; grid.appendChild(d); }
    return grid;
  }

  // --- the bar slider ----------------------------------------------------------
  // opts = { stops: [{label, desc}], pos: 0-1, drag: bool, onPos(p), onDrag(bool), onCommit(p), ends: [a,b], grid: bool }
  function slider(opts) {
    var n = opts.stops.length, idx = snap(opts.pos, n), box = el("div", "ob-slider");
    var head = el("div");
    head.appendChild(el("div", "ob-slider-name", opts.stops[idx].label));
    head.appendChild(el("div", "ob-slider-desc", opts.stops[idx].desc));
    box.appendChild(head);
    var track = el("div", "ob-track"); track.setAttribute("data-drag", opts.drag ? "1" : "0");
    var bars = el("div", "ob-bars");
    for (var b = 0; b < n; b++) {
      var bar = el("div", "ob-bar"); bar.style.height = (25 + 75 * (b / (n - 1))) + "%";
      var fill = el("div", "ob-bar-fill"); fill.style.width = (Math.min(1, Math.max(0, opts.pos * n - b)) * 100).toFixed(1) + "%";
      bar.appendChild(fill); bars.appendChild(bar);
    }
    track.appendChild(bars);
    track.appendChild(el("div", "ob-line"));
    var lineOn = el("div", "ob-line-on"); lineOn.style.width = (opts.pos * 100).toFixed(2) + "%"; track.appendChild(lineOn);
    var thumb = el("div", "ob-thumb"); thumb.style.left = (opts.pos * 100).toFixed(2) + "%"; track.appendChild(thumb);
    function pos(e) { var r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
    on(track, "pointerdown", function (e) { track.setPointerCapture(e.pointerId); opts.onDrag(true); opts.onPos(pos(e)); });
    on(track, "pointermove", function (e) { if (opts.drag) opts.onPos(pos(e)); });
    function up() { if (!opts.drag) return; opts.onDrag(false); opts.onCommit(Math.max(1, Math.min(n, Math.ceil(opts.pos * n))) / n); }
    on(track, "pointerup", up); on(track, "pointercancel", up);
    box.appendChild(track);
    if (opts.grid) {
      var stops = el("div", "ob-stops"); stops.style.gridTemplateColumns = "repeat(" + n + ",1fr)";
      opts.stops.forEach(function (s, i) {
        var bt = el("button", "ob-stop", s.label); bt.setAttribute("data-on", i === idx ? "1" : "0");
        on(bt, "click", function () { opts.onCommit((i + 1) / n); }); stops.appendChild(bt);
      });
      box.appendChild(stops);
    } else {
      var ends = el("div", "ob-ends"); ends.appendChild(el("span", "", opts.ends[0])); ends.appendChild(el("span", "", opts.ends[1])); box.appendChild(ends);
    }
    return box;
  }

  // --- drawing -----------------------------------------------------------------

  function draw() {
    app.textContent = "";
    if (st.screen === "loading") { app.appendChild(el("div", "ob-wait", st.error || "Waking up…")); return; }
    if (st.screen === "signin") { window.location.href = "/engelbart/signin"; return; }
    if (st.screen === "error") { var e = el("div", "ob-wait"); e.appendChild(el("div", "ob-err", st.error)); app.appendChild(e); return; }
    app.appendChild(railView());
    var main = el("div", "ob-main"), body = el("div", "ob-body"), content = el("div", "ob-content");
    content.id = "content";
    var drawers = [drawName, drawYear, drawMajor, drawDepth, drawPaper, drawProject, drawTopics, drawDetails, drawFocus, drawTodos, drawDone];
    drawers[st.step](content);
    if (st.error) content.appendChild(el("div", "ob-err", st.error));
    body.appendChild(content);
    if (typeof askPanel === "function") askPanel(body);
    main.appendChild(body); app.appendChild(main);
    var focus = content.querySelector("[autofocus]"); if (focus) focus.focus();
  }

  function stepBox(content, count, title) {
    var box = el("div", "ob-step");
    box.appendChild(el("div", "ob-count", count));
    if (title) box.appendChild(el("div", "ob-title", title));
    content.appendChild(box);
    return box;
  }

  function cta(label, disabled, fn) {
    var b = el("button", "ob-cta"); b.appendChild(el("span", "", label)); var go = el("span", "", "›"); go.style.fontSize = "12px"; b.appendChild(go);
    if (disabled) b.setAttribute("disabled", "disabled"); else on(b, "click", fn);
    return b;
  }

  function field(value, placeholder, oninput, onenter, multiline) {
    var box = el("div", "ob-field"), input = el(multiline ? "textarea" : "input");
    input.value = value; input.placeholder = placeholder; input.spellcheck = false; input.setAttribute("autofocus", "");
    if (multiline) input.rows = 3;
    on(input, "input", function () { oninput(input.value); });
    on(input, "keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && onenter) { e.preventDefault(); onenter(); } });
    box.appendChild(input); return box;
  }

  function option(label, on_, pick, square) {
    var row = el("div", "ob-opt"); row.setAttribute("data-on", on_ ? "1" : "0");
    var mark = el("span", "ob-mark"); if (square) mark.setAttribute("data-square", "1"); row.appendChild(mark);
    row.appendChild(el("span", "ob-opt-text", label)); on(row, "click", pick); return row;
  }

  function fail(error) { st.busy = ""; st.error = error.message || "something went wrong"; draw(); }

  // 0 Name
  function drawName(content) {
    var box = stepBox(content, "Step 1 of 10", "What is your name?");
    var name = str(st.row.name);
    var next = function () { if (!name.trim()) return; save(1, { name: name.trim() }).then(function () { go(1); }).catch(fail); };
    box.appendChild(field(name, "type your name…", function (v) { name = v; st.row.name = v; refreshCta(); }, next));
    var acts = el("div", "ob-actions"); var button = cta("Continue", !name.trim(), next); acts.appendChild(button); box.appendChild(acts);
    function refreshCta() { if (name.trim()) { button.removeAttribute("disabled"); button.onclick = next; } else button.setAttribute("disabled", "disabled"); }
  }

  // 1 Year
  function drawYear(content) {
    var box = stepBox(content, "Step 2 of 10", "What year are you?");
    var opts = el("div", "ob-opts");
    YEARS.forEach(function (label) {
      opts.appendChild(option(label, !st.ui.yearOther && st.row.year === label, function () {
        st.ui.yearOther = false; st.row.year = label; draw();
        setTimeout(function () { save(2, { year: label }).then(function () { go(2); }).catch(fail); }, 180);
      }));
    });
    opts.appendChild(option("Something else", st.ui.yearOther, function () { st.ui.yearOther = !st.ui.yearOther; st.row.year = ""; draw(); }));
    box.appendChild(opts);
    if (st.ui.yearOther) {
      var next = function () { if (!st.ui.yearText.trim()) return; save(2, { year: st.ui.yearText.trim() }).then(function () { go(2); }).catch(fail); };
      box.appendChild(field(st.ui.yearText, "transferring, fifth-year, grad…", function (v) { st.ui.yearText = v; button.disabled = !v.trim(); }, next));
      var acts = el("div", "ob-actions"); var button = cta("Continue", !st.ui.yearText.trim(), next); acts.appendChild(button); box.appendChild(acts);
    }
  }

  // 2 Major
  function drawMajor(content) {
    var box = stepBox(content, "Step 3 of 10", "What is your major?");
    var major = str(st.row.major);
    var next = function () { if (!major.trim()) return; save(3, { major: major.trim() }).then(function () { go(3); }).catch(fail); };
    box.appendChild(field(major, "start typing…", function (v) { major = v; st.row.major = v; draw(); }, next));
    var typed = major.trim().toLowerCase(), seeds = el("div", "ob-seeds");
    MAJORS.filter(function (m) { var low = m.toLowerCase(); return low !== typed && (!typed || low.indexOf(typed) >= 0); }).slice(0, 6)
      .forEach(function (m) { seeds.appendChild(on(el("button", "ob-seed", m), "click", function () {
        st.row.major = m; draw(); setTimeout(function () { save(3, { major: m }).then(function () { go(3); }).catch(fail); }, 180); })); });
    box.appendChild(seeds);
    var acts = el("div", "ob-actions"); acts.appendChild(cta("Continue", !major.trim(), next)); box.appendChild(acts);
  }

  // 3 Explanations
  function drawDepth(content) {
    var box = stepBox(content, "Step 4 of 10", "How technical should explanations be?");
    var panel = el("div", "ob-panel");
    panel.appendChild(slider({ stops: DEPTHS, pos: st.ui.depthPos, drag: st.ui.depthDrag, grid: true,
      onPos: function (p) { st.ui.depthPos = p; st.ui.depthTouched = true; draw(); },
      onDrag: function (d) { st.ui.depthDrag = d; },
      onCommit: function (p) { st.ui.depthPos = p; st.ui.depthDrag = false; st.ui.depthTouched = true; st.row.depth = DEPTHS[depthIndex()].key; draw(); } }));
    box.appendChild(panel);
    var acts = el("div", "ob-actions"); acts.setAttribute("data-between", "1");
    acts.appendChild(el("span", "ob-hint", st.ui.depthTouched ? "You can change this later." : "Everyday is the default · drag to change · you can adjust it later"));
    acts.appendChild(cta("Continue", false, function () {
      save(4, { depth: DEPTHS[depthIndex()].key }).then(function () { go(4); }).catch(fail);
    }));
    box.appendChild(acts);
  }

  // 4 Paper -- the PDF goes to Storage first; the row learns its id at Continue.
  function upload(file) {
    if (!file || file.type !== "application/pdf") { st.error = "Drop a PDF."; draw(); return; }
    if (file.size > MAX_PDF) { st.error = "That PDF is larger than 20 MB."; draw(); return; }
    var name = file.name.replace(/\.pdf$/i, ""), meta = "PDF · " + (file.size / 1024 / 1024).toFixed(1) + " MB";
    st.ui.pfile = { name: name, meta: meta, uploading: true }; st.error = ""; draw();
    setupApi("own_paper", { title: name, wantsUpload: true }).then(function (made) {
      return fetch(made.upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf", "x-upsert": "true" }, body: file })
        .then(function (r) { if (!r.ok) throw new Error("the upload failed"); return setupApi("own_paper_saved", { id: made.id, token: made.token }); })
        .then(function () { st.ui.pfile = { name: name, meta: meta, id: made.id, token: made.token }; draw(); });
    }).catch(function (e) { st.ui.pfile = null; fail(e); });
  }

  function drawPaper(content) {
    var box = stepBox(content, "Step 5 of 10", "Which paper are you building on?");
    var card = el("div", "ob-card"), stack = el("div", "ob-stack"), p = st.ui.pfile;
    if (!p) {
      var drop = el("label", "ob-drop"); drop.setAttribute("data-over", st.ui.pover ? "1" : "0");
      drop.appendChild(el("div", "ob-drop-icon", "+"));
      var t = el("div"); t.appendChild(el("div", "ob-drop-title", "Add the PhD student's paper")); t.appendChild(el("div", "ob-drop-sub", "Drop a PDF or click to choose")); drop.appendChild(t);
      var input = el("input"); input.type = "file"; input.accept = "application/pdf"; input.style.display = "none";
      on(input, "change", function () { upload(input.files[0]); }); drop.appendChild(input);
      on(drop, "dragover", function (e) { e.preventDefault(); if (!st.ui.pover) { st.ui.pover = true; drop.setAttribute("data-over", "1"); } });
      on(drop, "dragleave", function () { st.ui.pover = false; drop.setAttribute("data-over", "0"); });
      on(drop, "drop", function (e) { e.preventDefault(); st.ui.pover = false; upload(e.dataTransfer.files[0]); });
      stack.appendChild(drop);
    } else {
      var row = el("div", "ob-file"); row.appendChild(el("div", "ob-file-icon"));
      var txt = el("div"); txt.style.flex = "1"; txt.style.minWidth = "0";
      txt.appendChild(el("div", "ob-file-name", p.name)); txt.appendChild(el("div", "ob-file-meta", p.uploading ? "Uploading…" : p.meta)); row.appendChild(txt);
      row.appendChild(on(el("button", "ob-link", "Replace"), "click", function () { st.ui.pfile = null; draw(); }));
      stack.appendChild(row);
    }
    [{ key: "plink", label: "Project page" }, { key: "prepo", label: "GitHub" }].forEach(function (r) {
      var wrap = el("div", "ob-urlrow"), open_ = st.ui.popen === r.key, val = st.ui[r.key];
      var btn = el("button", "ob-urlbtn"); btn.setAttribute("data-open", open_ ? "1" : "0");
      btn.appendChild(el("span", "", r.label)); btn.appendChild(el("span", "h", "optional"));
      btn.appendChild(el("span", "s", val.trim() && !open_ ? hostOf(val) : "")); btn.appendChild(el("span", "c", "›"));
      on(btn, "click", function () { st.ui.popen = open_ ? null : r.key; draw(); });
      wrap.appendChild(btn);
      var body = el("div", "ob-urlbody"); body.setAttribute("data-open", open_ ? "1" : "0"); var inner = el("div");
      var input = el("input"); input.value = val; input.placeholder = "https://"; input.tabIndex = open_ ? 0 : -1; if (open_) input.setAttribute("autofocus", "");
      on(input, "input", function () { st.ui[r.key] = input.value; });
      on(input, "keydown", function (e) { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); st.ui.popen = null; draw(); } });
      inner.appendChild(input); body.appendChild(inner); wrap.appendChild(body); stack.appendChild(wrap);
    });
    card.appendChild(stack);
    card.appendChild(slider({ stops: FAMILIARITY, pos: st.ui.pfam, drag: st.ui.pdrag, ends: ["Beginner", "Expert"],
      onPos: function (v) { st.ui.pfam = v; draw(); }, onDrag: function (d) { st.ui.pdrag = d; },
      onCommit: function (v) { st.ui.pfam = v; st.ui.pdrag = false; draw(); } }));
    var acts = el("div", "ob-actions");
    var ready = p && p.id && !p.uploading;
    acts.appendChild(cta("Continue", !ready, function () {
      var body = { paper_id: p.id, paper_token: p.token, project_url: st.ui.plink.trim(), repo_url: st.ui.prepo.trim(), paper_familiarity: snap(st.ui.pfam, 5) };
      st.row.analysis_status = "running";
      // Not awaited: the reader moves on while the paper is read.
      api("sources", body).then(function (out) { st.row.analysis_status = out.analysis_status; if (out.analysis_error) st.row.analysis_error = out.analysis_error; draw(); })
        .catch(function (e) { st.row.analysis_status = "error"; st.row.analysis_error = e.message; draw(); });
      save(5, {}).then(function () { go(5); }).catch(fail);
    }));
    card.appendChild(acts); box.appendChild(card);
  }

  function hostOf(u) { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }

  // 5 Project
  function drawProject(content) {
    var box = stepBox(content, "Step 6 of 10", "What's your project?");
    var next = function () { if (!st.ui.draft.trim()) return; save(6, { project_draft: st.ui.draft.trim() }).then(function () { go(6); }).catch(fail); };
    box.appendChild(field(st.ui.draft, "e.g. a command-line tool that reads a paper and turns its method into runnable code",
      function (v) { st.ui.draft = v; button.disabled = !v.trim(); }, next, true));
    var acts = el("div", "ob-actions"); var button = cta("Continue", !st.ui.draft.trim(), next); acts.appendChild(button); box.appendChild(acts);
  }

  // Steps 6-10 are drawn by the second half of this file (Task 8); until then
  // they show the generating indicator.
  function generating(content, text) { var w = el("div", "ob-wait"); w.appendChild(dots()); w.appendChild(el("div", "ob-wait-t", text)); content.appendChild(w); }
  function drawTopics(c) { generating(c, "Still reading your paper"); }
  function drawDetails(c) { generating(c, "Writing your questions"); }
  function drawFocus(c) { generating(c, "Writing goals"); }
  function drawTodos(c) { generating(c, "Writing todos"); }
  function drawDone(c) { generating(c, "Done"); }
  var askPanel = null;

  // --- boot --------------------------------------------------------------------

  function boot() {
    draw();
    fetch("/api/engelbart-config", { headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("Engelbart is not configured on this deployment"); return r.json(); })
      .then(function (config) {
        client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey,
          { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
        client.auth.onAuthStateChange(function (_e, next) { if (!next && session) { session = null; st.screen = "signin"; draw(); } });
        return client.auth.getSession();
      })
      .then(function (out) {
        session = out.data && out.data.session;
        if (!session) { st.screen = "signin"; draw(); return; }
        return api("open").then(function (opened) { adopt(opened); st.screen = "flow"; draw(); });
      })
      .catch(function (e) { st.screen = "error"; st.error = e.message; draw(); });
  }

  boot();
})();
```

- [ ] **Step 6: Run the tests and load the page**

Run: `npm test && npm run check`, then `vercel dev` and open `http://localhost:3000/engelbart/setup` signed in: walk Name → Project; reload at Project and confirm it resumes there with the values in the rail.
Expected: tests pass; the six steps write through (`engelbart_onboardings` row visible in the Supabase table editor).

- [ ] **Step 7: If Task 1 chose the text fallback**

Load pdf.js from jsdelivr in `index.html` (`https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs` as a module script with `pdfjsLib.GlobalWorkerOptions.workerSrc` pointed at the matching `pdf.worker.min.mjs`), extract page text in `upload()` (join `getTextContent().items[].str` per page, cap 400 000 chars) and send it as `paper_text` in `sources`; the server passes it as `pdfText` (Task 5 `runAnalysis` reads `body.paper_text` when set instead of downloading). Skip this step otherwise.

- [ ] **Step 8: Commit**

```bash
git add engelbart/setup/index.html engelbart/setup/setup.css engelbart/setup/setup.js tests/setup-page.test.js
git commit -m "Setup page: profile, paper, and project, written to the record as they go

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---
### Task 8: The page, steps Topics → Done, and Ask about this

**Files:**
- Modify: `engelbart/setup/setup.js` (replace the five stubs and `askPanel`), `engelbart/setup/setup.css` (append)
- Test: `tests/setup-page.test.js` (extend)

**Interfaces:**
- Consumes: Task 7's `st`, `api`, `save`, `go`, `draw`, `slider`, `stepBox`, `cta`, `field`, `option`, `dots`, `generating`, `fail`, `LADDER`, `DEPTHS`; server actions `analysis`, `answer`, `details`, `goals`, `todos`, `ask`, `create`; `engelbart-device {issue}`.
- Produces: the finished page.

- [ ] **Step 1: Extend the page test**

Append to `tests/setup-page.test.js`:

```js
test("the second half asks, grades, generates and creates", () => {
  for (const action of ["analysis", "answer", "details", "goals", "todos", "ask", "create"]) {
    assert.match(js, new RegExp(`api\\("${action}"`), action);
  }
  assert.match(js, /action: "issue"/);
  assert.match(js, /npx engelbart-cli --code /);
  assert.match(js, /Ask about this/);
});
```

Run: `node --test tests/setup-page.test.js` → FAIL on the new test.

- [ ] **Step 2: Append the styles**

```css
/* topics */
.ob-paper{margin-top:16px;display:flex;gap:14px;align-items:center;padding:12px 14px;background:var(--panel2);border:1px solid var(--bd);border-radius:var(--radius-md)}
.ob-paper-icon{width:40px;height:52px;flex:none;border-radius:3px;border:1px solid var(--bd);background:var(--panel);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.ob-paper-title{font:500 13.5px/1.35 var(--font-sans);color:var(--ink)}
.ob-paper-venue{flex:none;font:var(--text-microcap);letter-spacing:1.2px;text-transform:uppercase;color:var(--bd2)}
.ob-paper-sum{font:12.5px/1.55 var(--font-sans);color:var(--fnt);text-wrap:pretty}
.ob-area{margin-top:14px;padding:20px 18px 16px;border:1px solid var(--bd);border-radius:var(--radius-lg);background:var(--panel);display:flex;flex-direction:column;gap:18px}
.ob-area-head{position:relative;display:flex;justify-content:center;align-items:center;min-height:30px}
.ob-area-n{position:absolute;left:0;font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--bd2)}
.ob-area-name{font:500 24px/1.3 var(--font-sans);letter-spacing:-0.3px;color:var(--ink);text-align:center}
.ob-area-role{font:var(--text-12-5);color:var(--fnt);text-align:center;text-wrap:pretty}
.ob-q-label{margin-top:10px;font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--fnt)}
.ob-q{margin-top:8px;font:14px/1.55 var(--font-sans);color:var(--ink);text-wrap:pretty}
.ob-q-skel{margin-top:10px;height:14px;width:80%;border-radius:4px;background:var(--bd);animation:pulse 1.2s ease-in-out infinite}
.ob-answer{margin-top:10px;padding:10px 12px;background:var(--panel2);border:1px solid var(--bd);border-radius:var(--radius-sm);transition:border-color 200ms}
.ob-answer[data-filled="1"]{border-color:var(--bd2)}
.ob-answer input{all:unset;display:block;width:100%;font:13.5px/1.6 var(--font-sans);color:var(--ink)}
.ob-grade{margin-top:10px;display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px dashed var(--bd2);border-radius:var(--radius-md);font:var(--text-12);color:var(--mut)}
.ob-grade .tag{flex:none;font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--fnt);line-height:1.6}
.ob-nav{display:flex;align-items:center;margin-top:20px}
.ob-nav[data-rule="1"]{margin-top:24px;padding-top:16px;border-top:1px solid var(--bd)}
.ob-arrow{flex:none;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font:15px/1 var(--font-sans);color:var(--fnt);background:transparent;border:1px solid var(--bd);border-radius:50%;cursor:pointer;transition:color var(--dur-fast),border-color var(--dur-fast)}
.ob-arrow:hover{color:var(--ink);border-color:var(--bd2)}
.ob-arrow[disabled]{opacity:.35;cursor:default}
.ob-pdots{flex:1;display:flex;align-items:center;justify-content:center;gap:6px}
.ob-pdot{display:block;height:6px;width:6px;border-radius:999px;background:var(--bd2);transition:width var(--dur-med),background var(--dur-med);cursor:pointer}
.ob-pdot[data-done="1"]{background:var(--fnt)}
.ob-pdot[data-on="1"]{width:20px;background:var(--acc)}
.ob-nav-end{display:flex;align-items:center;gap:8px}
/* details */
.ob-head{display:flex;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid var(--bd)}
.ob-intro{margin-top:16px;display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:1px dashed var(--bd2);border-radius:var(--radius-md)}
.ob-intro .tag{flex:none;font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--fnt);line-height:1.6}
.ob-intro .t{flex:1;font:var(--text-12);color:var(--mut);text-wrap:pretty}
.ob-question{margin-top:20px;font:var(--text-question);letter-spacing:var(--track-question);text-wrap:pretty}
.ob-multi-note{margin-top:8px;font:11px/1.4 var(--font-sans);color:var(--bd2);padding-left:4px}
/* focus */
.ob-goal{display:flex;align-items:flex-start;gap:11px;padding:13px 14px;border-radius:var(--radius-sm);cursor:pointer;transition:border-color var(--dur-fast),background var(--dur-fast);border:1px solid var(--bd)}
.ob-goal:hover{background:var(--hov)}
.ob-goal[data-on="1"]{border-color:var(--ink);background:transparent}
.ob-goal .ob-mark{margin-top:4px}
.ob-goal-label{display:block;font:500 13.5px/1.5 var(--font-sans);color:var(--mut)}
.ob-goal[data-on="1"] .ob-goal-label{color:var(--ink)}
.ob-goal-why{display:block;margin-top:3px;font:var(--text-12);color:var(--fnt);text-wrap:pretty}
/* todos */
.ob-cap{margin-top:18px;font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--fnt)}
.ob-goal-title{margin-top:6px;font:var(--text-goal-title);letter-spacing:var(--track-goal-title);color:var(--ink);text-wrap:pretty}
.ob-rows{margin-top:16px;display:flex;flex-direction:column}
.ob-trow{display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid var(--line-soft)}
.ob-trow .dash{flex:none;font:13px/1 var(--font-sans);color:var(--fnt)}
.ob-trow input{all:unset;display:block;flex:1;font:13px/1.6 var(--font-sans);color:var(--ink)}
.ob-trow .x{flex:none;padding:0 3px;font:13px/1 var(--font-sans);color:var(--bd2);background:none;border:none;cursor:pointer}
.ob-trow .x:hover{color:var(--del)}
.ob-namerow{margin-top:22px;display:flex;align-items:center;gap:10px;padding:5px 5px 5px 16px;background:var(--panel2);border:1px solid var(--bd);border-radius:var(--radius-pill)}
.ob-namerow input{all:unset;display:block;flex:1;font:500 14px/1.5 var(--font-sans);color:var(--ink)}
.ob-pill{padding:8px 14px;font:var(--text-microcap-btn-lg);letter-spacing:var(--track-btn-lg);text-transform:uppercase;border-radius:var(--radius-pill);color:var(--onacc);background:var(--ink);border:1px solid var(--ink);cursor:pointer}
.ob-pill[disabled]{color:var(--fnt);background:var(--hov);border-color:var(--bd);cursor:default}
/* done */
.ob-done{text-align:center}
.ob-check{display:inline-flex;width:44px;height:44px;border-radius:50%;background:var(--acc);color:var(--onacc);align-items:center;justify-content:center;font:16px/1 var(--font-sans)}
.ob-done-t{margin-top:20px;font:500 24px/1.35 var(--font-sans);letter-spacing:-0.3px}
.ob-done-s{margin-top:10px;font:13px/1.7 var(--font-sans);color:var(--fnt);text-wrap:pretty}
.ob-cmd{display:flex;align-items:center;gap:10px;margin:22px auto 0;max-width:460px;padding:9px 8px 9px 14px;background:var(--tint);border:1px solid var(--bd);border-radius:var(--radius-pill);text-align:left}
.ob-cmd-text{flex:1;font:var(--text-mono);color:var(--ink);user-select:all;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-cmd-copy{flex:none;padding:5px 12px;font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--mut);background:var(--panel);border:1px solid var(--bd);border-radius:var(--radius-pill);cursor:pointer}
.ob-done-acts{display:flex;justify-content:center;gap:9px;margin-top:26px}
/* ask */
.ob-askbtn{position:absolute;z-index:5;transform:translate(-50%,-100%);margin-top:-8px;padding:7px 12px;font:var(--text-microcap-lg);letter-spacing:1.2px;text-transform:uppercase;color:var(--onacc);background:var(--ink);border:1px solid var(--ink);border-radius:var(--radius-pill);cursor:pointer;animation:pop 140ms both}
.ob-ask{margin-top:22px;padding:14px 16px;border:1px solid var(--ink);border-radius:var(--radius-md);background:var(--panel);animation:rise 200ms both}
.ob-ask-quote{margin-top:8px;font:italic 13px/1.6 var(--font-sans);color:var(--mut);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ob-ask-row{margin-top:12px;display:flex;align-items:center;gap:10px;padding:5px 5px 5px 14px;background:var(--panel2);border:1px solid var(--bd);border-radius:var(--radius-pill)}
.ob-ask-row input{all:unset;display:block;flex:1;font:13px/1.5 var(--font-sans);color:var(--ink)}
.ob-asked{margin-top:22px;display:flex;flex-direction:column;gap:10px}
.ob-asked-cap{font:var(--text-microcap);letter-spacing:1.4px;text-transform:uppercase;color:var(--fnt);padding-bottom:8px;border-bottom:1px solid var(--bd)}
.ob-ask-item{padding:12px 14px;border:1px solid var(--bd);border-radius:var(--radius-md);background:var(--panel);animation:rise 200ms both}
.ob-ask-item .q{margin-top:6px;font:500 13px/1.5 var(--font-sans);color:var(--ink)}
.ob-ask-item .a{margin-top:10px;font:13px/1.75 var(--font-sans);color:var(--mut);text-wrap:pretty;white-space:pre-wrap}
.ob-ask-item .quote{font:italic 12px/1.5 var(--font-sans);color:var(--fnt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-ask-tools{display:flex;align-items:center;gap:10px;margin-top:10px}
.ob-tiny{padding:0;font:var(--text-microcap);letter-spacing:1.2px;text-transform:uppercase;background:none;border:none;color:var(--fnt);cursor:pointer}
.ob-tiny[disabled]{color:var(--bd);cursor:default}
```

- [ ] **Step 3: Replace the stubs in setup.js**

Delete the five stub functions and `var askPanel = null;`, add to `st.ui` the fields named in Task 7's comment, and insert:

```js
  // --- 6 Topics ------------------------------------------------------------------
  //
  // Per area: a familiarity slider and the question at its level. Answering
  // sends it for grading; a grade that disagrees brings one follow-up at the
  // level it found. Two questions per area is the cap.

  var poll = null;
  function pollAnalysis() {
    if (poll) return;
    poll = setInterval(function () {
      if (st.step !== 6) { clearInterval(poll); poll = null; return; }
      api("analysis").then(function (out) {
        st.row.analysis_status = out.analysis_status;
        if (out.analysis) st.row.analysis = out.analysis;
        if (out.analysis_error) st.row.analysis_error = out.analysis_error;
        if (out.analysis_status !== "running") { clearInterval(poll); poll = null; }
        draw();
      }).catch(function () {});
    }, 3000);
  }

  function famOf(i) { var v = st.ui.fam[i]; return typeof v === "number" ? v : 0.2; }
  function levelOf(i) { return LADDER[snap(famOf(i), 5)].level; }
  function answeredArea(i) { return st.cals.some(function (c) { return c.area_index === i && c.answered_at; }); }

  function drawTopics(content) {
    var r = st.row;
    if (r.analysis_status === "error") {
      var box = stepBox(content, "Step 7 of 10", "The paper could not be read");
      box.appendChild(el("div", "ob-sub", r.analysis_error || "Something went wrong while reading it."));
      var acts = el("div", "ob-actions"); acts.appendChild(cta("Try again", false, function () {
        st.row.analysis_status = "running"; draw();
        api("analysis", { retry: true }).then(function (out) { st.row.analysis_status = out.analysis_status; if (out.analysis) st.row.analysis = out.analysis; if (out.analysis_error) st.row.analysis_error = out.analysis_error; draw(); }).catch(fail);
      })); box.appendChild(acts); return;
    }
    if (r.analysis_status !== "done" || !r.analysis) {
      var w = el("div", "ob-wait"); w.appendChild(dots()); w.appendChild(el("div", "ob-wait-t", "Still reading your paper"));
      w.appendChild(el("div", "ob-wait-s", "Questions about it come next.")); content.appendChild(w); pollAnalysis(); return;
    }
    var a = r.analysis, areas = a.areas, fi = Math.min(st.ui.fIdx || 0, areas.length - 1), area = areas[fi];
    var box2 = el("div", "ob-step");
    box2.appendChild(el("div", "ob-count", "Step 7 of 10 · Topics"));
    box2.appendChild(el("div", "ob-title", "How familiar are you with what the paper leans on?"));
    var paper = el("div", "ob-paper"); paper.appendChild(el("div", "ob-paper-icon"));
    var pt = el("div"); pt.style.flex = "1"; pt.style.minWidth = "0";
    var line = el("div"); line.style.display = "flex"; line.style.justifyContent = "space-between"; line.style.gap = "12px"; line.style.flexWrap = "wrap";
    line.appendChild(el("span", "ob-paper-title", a.title)); line.appendChild(el("span", "ob-paper-venue", a.date || "")); pt.appendChild(line);
    pt.appendChild(el("div", "ob-paper-sum", a.one_liner)); paper.appendChild(pt); box2.appendChild(paper);

    var card = el("div", "ob-area");
    var head = el("div", "ob-area-head"); head.appendChild(el("span", "ob-area-n", (fi + 1) + " / " + areas.length));
    head.appendChild(el("div", "ob-area-name", area.area)); card.appendChild(head);
    if (area.project_role) card.appendChild(el("div", "ob-area-role", area.project_role));
    var follow = st.ui.followUp && st.ui.followUp.area === fi ? st.ui.followUp : null;
    var level = follow ? follow.question_level : levelOf(fi);
    var q = area.questions.filter(function (x) { return x.level === level; })[0];
    var key = fi + ":" + level, answer = (st.ui.fAnswers || {})[key] || "";
    var locked = !!follow;   // the follow-up's level is the grade's, not the slider's
    card.appendChild(slider({ stops: LADDER, pos: famOf(fi), drag: !!st.ui.fdrag, ends: ["Beginner", "Expert"],
      onPos: function (v) { if (locked) return; st.ui.fam[fi] = v; draw(); }, onDrag: function (d) { st.ui.fdrag = d; },
      onCommit: function (v) { if (locked) return; st.ui.fam[fi] = v; st.ui.fdrag = false; draw(); } }));
    var qbox = el("div"); qbox.appendChild(el("div", "ob-q-label", follow ? "One more, at the level your answer showed" : "Question"));
    qbox.appendChild(el("div", "ob-q", q.question));
    var ab = el("div", "ob-answer"); ab.setAttribute("data-filled", answer.trim() ? "1" : "0");
    var input = el("input"); input.value = answer; input.placeholder = "one sentence is enough…"; input.spellcheck = false; input.setAttribute("autofocus", "");
    on(input, "input", function () { st.ui.fAnswers[key] = input.value; ab.setAttribute("data-filled", input.value.trim() ? "1" : "0"); next.disabled = !input.value.trim(); });
    on(input, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    ab.appendChild(input); qbox.appendChild(ab);
    var lastGrade = st.ui.lastGrade && st.ui.lastGrade.area === fi ? st.ui.lastGrade : null;
    if (lastGrade) { var g = el("div", "ob-grade"); g.appendChild(el("span", "tag", "Graded")); g.appendChild(el("span", "", lastGrade.text)); qbox.appendChild(g); }
    card.appendChild(qbox); box2.appendChild(card);

    var last = fi === areas.length - 1;
    function submit() {
      var said = (st.ui.fAnswers[key] || "").trim(); if (!said || st.busy) return;
      st.busy = "grading"; next.disabled = true;
      api("answer", { area_index: fi, question_level: level, self_level: levelOf(fi), answer: said }).then(function (out) {
        st.busy = "";
        st.cals = st.cals.filter(function (c) { return !(c.area_index === fi && c.question_level === level); });
        st.cals.push({ area_index: fi, question_level: level, answered_at: new Date().toISOString(), graded_level: out.graded_level });
        if (out.follow_up) {
          st.ui.followUp = { area: fi, question_level: out.follow_up.question_level };
          st.ui.lastGrade = { area: fi, text: "Your answer read as “" + LADDER.filter(function (l) { return l.level === out.graded_level; })[0].label.toLowerCase() + "”" + (out.grade_rationale ? " — " + out.grade_rationale : "") };
          draw(); return;
        }
        st.ui.followUp = null; st.ui.lastGrade = null;
        if (last) save(7, {}).then(function () { go(7); }).catch(fail); else { st.ui.fIdx = fi + 1; draw(); }
      }).catch(fail);
    }
    var nav = el("div", "ob-nav");
    var back = el("button", "ob-arrow", "←"); if (fi === 0) back.setAttribute("disabled", "disabled"); else on(back, "click", function () { st.ui.followUp = null; st.ui.fIdx = fi - 1; draw(); });
    nav.appendChild(back);
    var pd = el("span", "ob-pdots"); areas.forEach(function (_, i) { var d = el("span", "ob-pdot"); d.setAttribute("data-on", i === fi ? "1" : "0"); d.setAttribute("data-done", answeredArea(i) ? "1" : "0"); on(d, "click", function () { st.ui.followUp = null; st.ui.fIdx = i; draw(); }); pd.appendChild(d); });
    nav.appendChild(pd);
    var next = cta(st.busy === "grading" ? "Grading…" : last && !follow ? "On to the project" : "Next", !answer.trim() || !!st.busy, submit);
    nav.appendChild(next); box2.appendChild(nav); content.appendChild(box2);
  }

  // --- 7 Details ---------------------------------------------------------------

  function drawDetails(content) {
    var r = st.row;
    if (!r.details || !r.details.questions) {
      if (!st.busy) { st.busy = "details"; api("details").then(function (d) { st.busy = ""; st.row.details = d; st.ui.qIdx = 0; draw(); }).catch(fail); }
      generating(content, "Writing your questions"); return;
    }
    var qs = r.details.questions, qi = Math.min(st.ui.qIdx || 0, qs.length - 1), q = qs[qi], answers = r.details.answers || {};
    var ans = answers[q.id];
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Step 8 of 10 · Details")); head.appendChild(el("span", "ob-count", (qi + 1) + " of " + qs.length)); box.appendChild(head);
    if (r.details.intro) { var intro = el("div", "ob-intro"); intro.appendChild(el("span", "tag", "Taken into account")); intro.appendChild(el("span", "t", r.details.intro)); box.appendChild(intro); }
    box.appendChild(el("div", "ob-question", q.title));
    if (q.hint) box.appendChild(el("div", "ob-sub", q.hint));
    function setAns(v) { answers[q.id] = v; r.details.answers = answers; draw(); }
    if (q.kind === "short") {
      box.appendChild(field(typeof ans === "string" ? ans : "", q.placeholder || "", function (v) { answers[q.id] = v; r.details.answers = answers; nextBtn.disabled = !v.trim(); }, advance, true));
    } else {
      var opts = el("div", "ob-opts"); opts.style.marginTop = "16px";
      var multi = q.kind === "multi", cur = Array.isArray(ans) ? ans : [];
      q.options.forEach(function (label) {
        var on_ = multi ? cur.indexOf(label) >= 0 : ans === label;
        opts.appendChild(option(label, on_, function () { if (multi) setAns(on_ ? cur.filter(function (x) { return x !== label; }) : cur.concat([label])); else setAns(on_ ? null : label); }, multi));
      });
      box.appendChild(opts);
      if (multi) box.appendChild(el("div", "ob-multi-note", "Pick all that apply."));
    }
    var empty = ans == null || ans === "" || (Array.isArray(ans) && !ans.length) || (typeof ans === "string" && !ans.trim());
    var lastQ = qi >= qs.length - 1;
    function persist() { var f = {}; f[q.id] = answers[q.id] == null ? null : answers[q.id]; return save(lastQ ? 8 : 7, { details_answers: f }); }
    function advance() { if (empty && !(typeof answers[q.id] === "string" && answers[q.id].trim())) return; persist().then(function () { if (lastQ) go(8); else { st.ui.qIdx = qi + 1; draw(); } }).catch(fail); }
    var nav = el("div", "ob-nav"); nav.setAttribute("data-rule", "1");
    var back = el("button", "ob-arrow", "←"); if (qi === 0) back.setAttribute("disabled", "disabled"); else on(back, "click", function () { st.ui.qIdx = qi - 1; draw(); });
    nav.appendChild(back);
    var pd = el("span", "ob-pdots"); qs.forEach(function (_, i) { var d = el("span", "ob-pdot"); d.setAttribute("data-on", i === qi ? "1" : "0"); on(d, "click", function () { st.ui.qIdx = i; draw(); }); pd.appendChild(d); }); nav.appendChild(pd);
    var end = el("div", "ob-nav-end");
    end.appendChild(on(el("button", "ob-ghost", "Skip"), "click", function () { answers[q.id] = null; r.details.answers = answers; persist().then(function () { if (lastQ) go(8); else { st.ui.qIdx = qi + 1; draw(); } }).catch(fail); }));
    var nextBtn = cta(lastQ ? "Pick a focus" : "Next", empty, advance); end.appendChild(nextBtn); nav.appendChild(end); box.appendChild(nav);
    content.appendChild(box);
  }

  // --- 8 Focus -----------------------------------------------------------------

  function drawFocus(content) {
    var r = st.row;
    if (!r.goals || !r.goals.goals) {
      if (!st.busy) { st.busy = "goals"; api("goals").then(function (g) { st.busy = ""; st.row.goals = g; draw(); }).catch(fail); }
      generating(content, "Writing goals"); return;
    }
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Step 9 of 10 · Focus")); head.appendChild(el("span", "ob-count", "One goal")); box.appendChild(head);
    box.appendChild(el("div", "ob-question", "What should the first project be about?"));
    box.appendChild(el("div", "ob-sub", "Pick one. The rest can be later projects."));
    var list = el("div", "ob-opts"); list.style.marginTop = "16px";
    var rows = r.goals.goals.concat([{ label: "Something else", why: "tell it what to start on instead and it will use that", other: true }]);
    rows.forEach(function (g) {
      var on_ = g.other ? st.ui.goalOtherOn : st.ui.goalPick === g.label;
      var row = el("div", "ob-goal"); row.setAttribute("data-on", on_ ? "1" : "0"); row.appendChild(el("span", "ob-mark"));
      var t = el("span"); t.style.flex = "1"; t.style.minWidth = "0"; t.appendChild(el("span", "ob-goal-label", g.label)); t.appendChild(el("span", "ob-goal-why", g.why)); row.appendChild(t);
      on(row, "click", function () { if (g.other) { st.ui.goalOtherOn = !on_; st.ui.goalPick = ""; } else { st.ui.goalOtherOn = false; st.ui.goalPick = on_ ? "" : g.label; } draw(); });
      list.appendChild(row);
    });
    box.appendChild(list);
    if (st.ui.goalOtherOn) box.appendChild(field(st.ui.goalOther || "", "what to start on instead…", function (v) { st.ui.goalOther = v; gen.disabled = !v.trim(); }, null));
    var chosen = st.ui.goalOtherOn ? str(st.ui.goalOther).trim() : st.ui.goalPick;
    var acts = el("div", "ob-actions");
    var gen = cta("Write todos", !chosen, function () {
      st.busy = "todos"; draw();
      api("todos", { goal: chosen }).then(function (out) { st.busy = ""; st.row.goal_chosen = chosen; st.ui.todos = out.todos.slice(); st.ui.projName = out.name || st.ui.projName; st.row.step = Math.max(st.row.step, 9); go(9); }).catch(fail);
    });
    acts.appendChild(gen); box.appendChild(acts); content.appendChild(box);
    if (st.busy === "todos") { content.textContent = ""; generating(content, "Writing todos"); }
  }

  // --- 9 Todos -----------------------------------------------------------------

  function drawTodos(content) {
    var todos = st.ui.todos || [], n = todos.length, canAdd = n < 4;
    var box = el("div", "ob-step");
    var head = el("div", "ob-head"); head.appendChild(el("span", "ob-count", "Step 10 of 10 · Todos")); head.appendChild(el("span", "ob-count", n + " of 4")); box.appendChild(head);
    box.appendChild(el("div", "ob-cap", "Goal")); box.appendChild(el("div", "ob-goal-title", st.row.goal_chosen));
    var rows = el("div", "ob-rows");
    todos.forEach(function (t, i) {
      var row = el("div", "ob-trow"); row.appendChild(el("span", "dash", "–"));
      var input = el("input"); input.value = t; input.spellcheck = false; on(input, "input", function () { todos[i] = input.value; }); row.appendChild(input);
      row.appendChild(on(el("button", "x", "×"), "click", function () { todos.splice(i, 1); draw(); })); rows.appendChild(row);
    });
    if (canAdd) {
      var add = el("div", "ob-trow"); add.appendChild(el("span", "dash", "–"));
      var ni = el("input"); ni.value = st.ui.newTodo || ""; ni.placeholder = "add a todo…"; ni.spellcheck = false;
      on(ni, "input", function () { st.ui.newTodo = ni.value; });
      on(ni, "keydown", function (e) { if (e.key === "Enter" && ni.value.trim()) { todos.push(ni.value.trim()); st.ui.newTodo = ""; draw(); } });
      add.appendChild(ni); rows.appendChild(add);
    }
    box.appendChild(rows);
    box.appendChild(el("div", "ob-hint", n < 2 ? "At least two todos." : n >= 4 ? "Four is the cap — keep the first project small." : "Edit, remove, or add up to " + (4 - n) + " more."));
    var name = el("div", "ob-namerow"); var input = el("input"); input.value = st.ui.projName || ""; input.placeholder = "project name…"; input.spellcheck = false;
    on(input, "input", function () { st.ui.projName = input.value; create.disabled = off(); }); name.appendChild(input);
    function off() { var clean = todos.filter(function (t) { return t.trim(); }); return clean.length < 2 || clean.length > 4 || !(st.ui.projName || "").trim(); }
    var create = el("button", "ob-pill"); create.appendChild(el("span", "", "Create project ")); create.appendChild(el("span", "", "›")); if (off()) create.setAttribute("disabled", "disabled");
    on(create, "click", function () {
      if (off()) return; st.busy = "create"; draw();
      var clean = todos.map(function (t) { return t.trim(); }).filter(Boolean);
      api("create", { project_name: st.ui.projName.trim(), goal_chosen: st.row.goal_chosen, todos: clean })
        .then(function () { return issueCode(); })
        .then(function () { st.busy = ""; st.row.status = "created"; st.row.project_name = st.ui.projName.trim(); st.row.todos = clean; go(10); })
        .catch(fail);
    });
    name.appendChild(create); box.appendChild(name); content.appendChild(box);
    if (st.busy === "create") { content.textContent = ""; generating(content, "Making " + (st.ui.projName || "your project")); }
  }

  function issueCode() {
    return fetch(DEVICE_API, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ action: "issue" }) }).then(function (r) { return r.json().then(function (v) { if (!r.ok) throw new Error(v.error || "could not issue a setup code"); st.ui.made = { code: v.code, expiresInSeconds: v.expiresInSeconds }; return v; }); });
  }

  // --- 10 Done -----------------------------------------------------------------

  function drawDone(content) {
    var r = st.row, box = el("div", "ob-step ob-done");
    box.appendChild(el("span", "ob-check", "✓"));
    box.appendChild(el("div", "ob-done-t", (r.project_name || "Your project") + " is made"));
    var d = DEPTHS.filter(function (x) { return x.key === r.depth; })[0];
    box.appendChild(el("div", "ob-done-s", "One goal and " + (r.todos || []).length + " todos, written for " + r.name + " — explanations " + (d ? d.phrase : "in everyday language") + "."));
    if (!st.ui.made) { generating(box, "Getting your install code"); issueCode().then(draw).catch(fail); }
    else {
      var cmd = "npx engelbart-cli --code " + st.ui.made.code, row = el("div", "ob-cmd");
      row.appendChild(el("span", "ob-cmd-text", cmd));
      var copy = el("button", "ob-cmd-copy", "Copy");
      on(copy, "click", function () { navigator.clipboard.writeText(cmd).then(function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1400); }, function () {}); });
      row.appendChild(copy); box.appendChild(row);
      var mins = Math.round((st.ui.made.expiresInSeconds || 900) / 60);
      box.appendChild(el("div", "ob-done-s", "Run that in a terminal on the machine you build on. It installs Engelbart, connects this account, and opens the project — no second sign-in. The code works once and expires in " + mins + " minutes."));
    }
    var acts = el("div", "ob-done-acts");
    acts.appendChild(on(el("button", "ob-ghost", "Get a new code"), "click", function () { st.ui.made = null; draw(); }));
    acts.appendChild(on(el("button", "ob-ghost", "Set up another"), "click", function () { api("open", { fresh: true }).then(function (o) { st.ui = { fam: {}, fAnswers: {}, todos: [] }; adopt(o); draw(); }).catch(fail); }));
    box.appendChild(acts); content.appendChild(box);
  }

  // --- Ask about this ----------------------------------------------------------
  //
  // From Topics on, selecting text in the content column offers a question
  // about it; the answer comes back at the reader's register and can be
  // re-asked one stop simpler or deeper.

  var QUICK = ["What does this mean?", "Why does this matter?", "Give me an example", "Is this too much for a first project?"];
  document.addEventListener("mouseup", function (e) {
    if (e.target && e.target.closest && e.target.closest("[data-askbtn]")) return;
    setTimeout(function () {
      var sel = window.getSelection(), t = sel ? sel.toString().trim() : "", c = document.getElementById("content");
      if (!t || t.length < 3 || !c || !sel.rangeCount || !c.contains(sel.anchorNode) || st.step < 6 || st.step > 9) { if (st.ui.askBtn) { st.ui.askBtn = null; draw(); } return; }
      var r = sel.getRangeAt(0).getBoundingClientRect(), cr = c.getBoundingClientRect();
      st.ui.askBtn = { text: t.slice(0, 240), x: r.left - cr.left + r.width / 2, y: r.top - cr.top }; draw();
    }, 0);
  });

  function askPanel(body) {
    var content = body.querySelector("#content");
    if (st.ui.askBtn && !st.ui.askOpen) {
      var b = el("button", "ob-askbtn", "Ask about this"); b.setAttribute("data-askbtn", "1");
      b.style.left = st.ui.askBtn.x + "px"; b.style.top = st.ui.askBtn.y + "px";
      on(b, "click", function () { st.ui.askQuote = st.ui.askBtn.text; st.ui.askOpen = true; st.ui.askBtn = null; st.ui.askText = ""; var s = window.getSelection(); if (s) s.removeAllRanges(); draw(); });
      content.appendChild(b);
    }
    if (st.ui.askOpen) {
      var panel = el("div", "ob-ask"); panel.appendChild(el("div", "ob-cap", "Asking about")); panel.firstChild.style.marginTop = "0";
      panel.appendChild(el("div", "ob-ask-quote", "“" + st.ui.askQuote + "”"));
      var quick = el("div", "ob-seeds"); QUICK.forEach(function (q) { quick.appendChild(on(el("button", "ob-seed", q), "click", function () { sendAsk(q); })); }); panel.appendChild(quick);
      var row = el("div", "ob-ask-row"); var input = el("input"); input.value = st.ui.askText || ""; input.placeholder = "or ask your own question…"; input.setAttribute("autofocus", "");
      on(input, "input", function () { st.ui.askText = input.value; send.disabled = !input.value.trim(); });
      on(input, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendAsk(); } if (e.key === "Escape") { st.ui.askOpen = false; draw(); } });
      row.appendChild(input); var send = el("button", "ob-pill", "Ask"); if (!(st.ui.askText || "").trim()) send.setAttribute("disabled", "disabled"); on(send, "click", function () { sendAsk(); }); row.appendChild(send); panel.appendChild(row);
      var cancel = el("div"); cancel.style.display = "flex"; cancel.style.justifyContent = "flex-end"; cancel.style.marginTop = "8px";
      cancel.appendChild(on(el("button", "ob-tiny", "cancel"), "click", function () { st.ui.askOpen = false; draw(); })); panel.appendChild(cancel);
      body.appendChild(panel);
    }
    var asks = st.ui.asks || [];
    if (asks.length) {
      var list = el("div", "ob-asked"); list.appendChild(el("div", "ob-asked-cap", "Asked"));
      asks.forEach(function (k) {
        var item = el("div", "ob-ask-item"); item.appendChild(el("div", "quote", "“" + k.quote + "”")); item.appendChild(el("div", "q", k.question));
        if (k.thinking) { var th = el("div"); th.style.marginTop = "10px"; th.appendChild(dots()); item.appendChild(th); }
        else {
          item.appendChild(el("div", "a", k.answer));
          var tools = el("div", "ob-ask-tools"); var di = DEPTHS.map(function (x) { return x.key; }).indexOf(k.level);
          tools.appendChild(el("span", "ob-tiny", DEPTHS[di].label));
          var simpler = el("button", "ob-tiny", "simpler"); if (di === 0) simpler.setAttribute("disabled", "disabled"); else on(simpler, "click", function () { reask(k, DEPTHS[di - 1].key); });
          var deeper = el("button", "ob-tiny", "more detail"); if (di === DEPTHS.length - 1) deeper.setAttribute("disabled", "disabled"); else on(deeper, "click", function () { reask(k, DEPTHS[di + 1].key); });
          tools.appendChild(simpler); tools.appendChild(deeper);
          var rm = el("button", "ob-tiny", "×"); rm.style.marginLeft = "auto"; on(rm, "click", function () { st.ui.asks = st.ui.asks.filter(function (x) { return x !== k; }); draw(); }); tools.appendChild(rm);
          item.appendChild(tools);
        }
        list.appendChild(item);
      });
      body.appendChild(list);
    }
  }

  function sendAsk(text) {
    var question = str(text || st.ui.askText).trim(); if (!question) return;
    var k = { quote: st.ui.askQuote, question: question, thinking: true, level: st.row.depth || "everyday" };
    st.ui.asks = [k].concat(st.ui.asks || []); st.ui.askOpen = false; st.ui.askText = ""; draw();
    api("ask", { step: st.step, quote: k.quote, question: question }).then(function (out) { k.thinking = false; k.answer = out.answer; k.level = out.level; draw(); })
      .catch(function (e) { k.thinking = false; k.answer = e.message; draw(); });
  }

  function reask(k, level) {
    k.thinking = true; draw();
    api("ask", { step: st.step, quote: k.quote, question: k.question, level: level }).then(function (out) { k.thinking = false; k.answer = out.answer; k.level = out.level; draw(); })
      .catch(function (e) { k.thinking = false; k.answer = e.message; draw(); });
  }
```

In Task 7's `st.ui` initialiser add: `fIdx: 0, fam: {}, fAnswers: {}, fdrag: false, followUp: null, lastGrade: null, qIdx: 0, goalPick: "", goalOther: "", goalOtherOn: false, todos: [], newTodo: "", projName: "", askBtn: null, askOpen: false, askQuote: "", askText: "", asks: [], made: null`.

In `adopt()`: when `r.status === "created"` and `st.ui.made` is null the Done step fetches a code itself; nothing else to add.

- [ ] **Step 4: Run the tests, then walk the page**

Run: `npm test && npm run check`, then `vercel dev`: from a fresh account with a real invite, walk all ten steps with a real PDF. Check in the Supabase table editor that `engelbart_onboarding_calibrations` holds one row per question answered with `graded_level` set, that `engelbart_onboarding_asks` holds each Ask, that `engelbart_pending_setups` holds the payload with `reader.knowledge`, and that `hc_profiles` has the row.
Expected: tests pass; every table filled; the install code shown.

- [ ] **Step 5: Commit**

```bash
git add engelbart/setup/setup.js engelbart/setup/setup.css tests/setup-page.test.js
git commit -m "Setup page: topics, details, focus, todos, done, and Ask about this

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---
### Task 9: hc — the fourth register and the knowledge block (claude-plugins)

**Files (claude-plugins, branch `feat/onboarding-reconnect-reader`):**
- Create: `supabase/migrations/20260902120000_hc_reader_knowledge.sql`
- Modify: `hc/src/human_compact/trajectory/reader.py`, `hc/src/human_compact/trajectory/supabase_client.py:1008-1025` (`set_reader_profile`), `hc/src/human_compact/cli.py` (`setup_import_main`, after `SETUP.commit`)
- Test: `tests/test_reader_profile.py` (extend), `tests/test_setup_import_reader.py` (new)

**Interfaces:**
- Consumes: the payload's `reader` object from Task 5 (`{name, year, major, level, knowledge:[{area, parent_field, level, project_role}]}`).
- Produces: `READER.EXPERT = "expert"`; `READER.normalize(value)` returns `{name, year, major, level, knowledge}`; `READER.lines(profile)` includes a "What they already know" block; `READER.CAPABILITY = {0: …, 25: …, 50: …, 75: …, 100: …}`; `hc_set_profile(p_name, p_year, p_major, p_level, p_knowledge jsonb)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_reader_profile.py` (inside `NormalizeTests`, replacing `test_a_level_nobody_offered_is_no_level`'s `"expert"` entry with `"guru"`):

```python
    def test_expert_is_a_fourth_stop(self):
        self.assertEqual("expert", READER.normalize({"level": "expert"})["level"])

    def test_knowledge_is_bounded_and_snapped_to_the_ladder(self):
        held = READER.normalize({"knowledge": [
            {"area": "Transformers", "parent_field": "ML", "level": 75, "project_role": "core"},
            {"area": "", "level": 50},                 # no area: dropped
            {"area": "PyTorch", "level": 33},           # off the ladder: dropped
            {"area": "x" * 200, "level": "25"},         # bounded, string level ok
            {"area": "A", "level": 0}, {"area": "B", "level": 0}, {"area": "C", "level": 0},
        ]})
        self.assertEqual(3 + 1, len(held["knowledge"]))
        self.assertEqual("Transformers", held["knowledge"][0]["area"])
        self.assertEqual(75, held["knowledge"][0]["level"])
        self.assertEqual(80, len(held["knowledge"][1]["area"]))
        self.assertEqual(25, held["knowledge"][1]["level"])
        self.assertEqual([], READER.normalize({"knowledge": "junk"})["knowledge"])
```

And a new test class in the same file:

```python
class KnowledgeLinesTests(unittest.TestCase):
    def test_the_block_names_each_area_at_its_capability(self):
        text = "\n".join(READER.lines({"name": "Maya", "level": "expert", "knowledge": [
            {"area": "Transformers", "level": 25}, {"area": "PyTorch", "level": 75}]}))
        self.assertIn("What they already know", text)
        self.assertIn("Transformers: can follow it (25)", text)
        self.assertIn("PyTorch: can use it (75)", text)
        self.assertIn(READER.LEVEL_RULES["expert"][0], text)

    def test_no_knowledge_adds_no_block(self):
        text = "\n".join(READER.lines({"name": "Maya", "level": "plain"}))
        self.assertNotIn("already know", text)
```

New file `tests/test_setup_import_reader.py`:

```python
"""A project approved on the web arrives with who it is for."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hc" / "src"))

from human_compact import cli  # noqa: E402
from human_compact.trajectory import reader as READER  # noqa: E402


class SetupImportReaderTests(unittest.TestCase):
    def test_the_payloads_reader_is_remembered_before_the_workspace_opens(self):
        payload = {"name": "zebra-tuner", "plan": {"description": "d"}, "goals": [{"label": "G", "why": ""}],
                   "chosen": "G", "todos": ["a", "b"],
                   "reader": {"name": "Maya", "year": "Second year", "major": "CogSci", "level": "expert",
                              "knowledge": [{"area": "Transformers", "level": 25}]}}
        remembered = {}
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(cli, "chat_ui_main", side_effect=lambda argv: print("http://127.0.0.1:1/")), \
             mock.patch("human_compact.trajectory.setup_chat.commit",
                        return_value={"ok": True, "tree_session": "s", "cwd": tmp, "name": "zebra-tuner"}), \
             mock.patch.object(READER, "remember", side_effect=lambda value, root=None: remembered.update(value) or {"ok": True}):
            with mock.patch("sys.stdin", new=__import__("io").StringIO(json.dumps(payload))):
                cli.setup_import_main(["--stdin", "--no-open"])
        self.assertEqual("Maya", remembered["name"])
        self.assertEqual("expert", remembered["level"])
        self.assertEqual(25, remembered["knowledge"][0]["level"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/claude-plugins && env -u HC_CHAT_INFERENCE python3 -m pytest tests/test_reader_profile.py tests/test_setup_import_reader.py -q`
Expected: FAIL (no `expert`, no `knowledge`, no remember call).

- [ ] **Step 3: reader.py**

Add after `FULL = "full"`:

```python
EXPERT = "expert"
LEVELS = (PLAIN, SOME, FULL, EXPERT)
```

Add `EXPERT: "Expert"` to `LEVEL_NAMES` and to `LEVEL_RULES`:

```python
    EXPERT: [
        "Write for a peer. Terse, precise, specific jargon and references to",
        "advanced work without introduction; assume they will look up",
        "anything they do not know.",
    ],
```

Add the capability ladder and the knowledge bounds:

```python
# What the web onboarding found they already know, one line per area. The
# level is the diagnostic's ladder; the phrase is how the prompt says it.
CAPABILITY = {0: "wouldn't know where to start", 25: "can follow it",
              50: "can explain it", 75: "can use it", 100: "can reason with it"}
MAX_AREAS = 4
MAX_AREA = 80
MAX_ROLE = 300


def _knowledge(value) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for row in value if isinstance(value, list) else []:
        if not isinstance(row, dict):
            continue
        area = _one(row.get("area"), MAX_AREA)
        try:
            level = int(row.get("level"))
        except (TypeError, ValueError):
            continue
        if not area or level not in CAPABILITY:
            continue
        out.append({"area": area, "parent_field": _one(row.get("parent_field"), MAX_AREA),
                    "level": level, "project_role": _one(row.get("project_role"), MAX_ROLE)})
        if len(out) >= MAX_AREAS:
            break
    return out
```

`blank()` returns `{"name": "", "year": "", "major": "", "level": "", "knowledge": []}`; `normalize()` adds `"knowledge": _knowledge(value.get("knowledge"))`; `answered()` becomes `any(v for v in normalize(profile).values())`. In `lines()`, after the rule:

```python
    known = profile["knowledge"]
    if known:
        if out[-1] != "":
            out.append("")
        out.append("What they already know, graded from short answers they gave:")
        for row in known:
            out.append("- %s: %s (%d)" % (row["area"], CAPABILITY[row["level"]], row["level"]))
        out.append("Start explanations where these levels say to, not lower and not higher.")
```

- [ ] **Step 4: supabase_client.set_reader_profile and the migration**

In `set_reader_profile`, add `"p_knowledge": profile.get("knowledge") or []` to the RPC body.

```sql
-- supabase/migrations/20260902120000_hc_reader_knowledge.sql
-- A fourth register, and what the reader already knows: the web onboarding
-- grades short answers per area and the workspace pitches every prompt at
-- those levels. Kept on hc_profiles beside the other four answers.

alter table public.hc_profiles
  add column if not exists knowledge jsonb not null default '[]'::jsonb;

alter table public.hc_profiles
  drop constraint if exists hc_profiles_tech_level_known;
alter table public.hc_profiles
  add constraint hc_profiles_tech_level_known
  check (tech_level in ('', 'plain', 'some', 'full', 'expert'));

drop function if exists public.hc_set_profile(text, text, text, text);

create or replace function public.hc_set_profile(
  p_name text, p_year text, p_major text, p_level text,
  p_knowledge jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid   uuid := (select auth.uid());
  level text := btrim(coalesce(p_level, ''));
begin
  if uid is null then
    raise exception 'hc_set_profile: no authenticated user';
  end if;
  if level not in ('', 'plain', 'some', 'full', 'expert') then
    level := '';
  end if;
  insert into public.hc_profiles
         (user_id, display_name, year, major, tech_level, knowledge, updated_at)
  values (uid,
          left(btrim(coalesce(p_name, '')), 60),
          left(btrim(coalesce(p_year, '')), 40),
          left(btrim(coalesce(p_major, '')), 80),
          level,
          case when jsonb_typeof(p_knowledge) = 'array' then p_knowledge else '[]'::jsonb end,
          now())
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        year         = excluded.year,
        major        = excluded.major,
        tech_level   = excluded.tech_level,
        knowledge    = excluded.knowledge,
        updated_at   = now();
  return jsonb_build_object(
    'ok', true,
    'profile', (select jsonb_build_object(
                         'name', p.display_name, 'year', p.year,
                         'major', p.major, 'level', p.tech_level,
                         'knowledge', p.knowledge)
                  from public.hc_profiles p where p.user_id = uid));
end $$;

revoke all on function public.hc_set_profile(text, text, text, text, jsonb) from public;
grant execute on function public.hc_set_profile(text, text, text, text, jsonb) to authenticated;
```

- [ ] **Step 5: cli.py setup_import_main**

After the `result = SETUP.commit(...)` block succeeds and before the workspace launch:

```python
    # Who the project is for came with it. Remembered before the workspace
    # opens, so its first prompt is already in the reader's register.
    reader = payload.get("reader")
    if isinstance(reader, dict) and reader:
        from .trajectory import reader as READER
        READER.remember(reader)
```

- [ ] **Step 6: Run the hc suites**

Run: `env -u HC_CHAT_INFERENCE python3 -m pytest tests/test_reader_profile.py tests/test_setup_import_reader.py tests/test_setup_chat.py tests/test_hc_onboarding.py -q`
Expected: all pass. Note `test_a_level_nobody_offered_is_no_level` now uses `"guru"` in place of `"expert"`.

- [ ] **Step 7: Commit (claude-plugins)**

```bash
git add supabase/migrations/20260902120000_hc_reader_knowledge.sql hc/src/human_compact/trajectory/reader.py hc/src/human_compact/trajectory/supabase_client.py hc/src/human_compact/cli.py tests/test_reader_profile.py tests/test_setup_import_reader.py
git commit -m "Reader profile: an expert register, and what the diagnostic found they know

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---

### Task 10: The harness, described

**Files:**
- Create: `docs/onboarding-harness.md`

**Interfaces:** none; the deliverable Hudson asked for. Behaviour only — no file names, no line numbers.

- [ ] **Step 1: Write it**

Sections, each two to six sentences: *What the reader does* (the ten steps as they experience them); *What runs in parallel* (the paper read starts at the Paper step, the reader keeps going, Topics waits only if it must; a retry is the same read again); *What is asked and why* (the diagnostic picks 2–4 areas that would change how the project is explained, one question per area at the reader's own rating, graded against a sample; a disagreement earns one follow-up); *What the grade changes* (the register of every later question, goal and todo shifts one stop when the graded mean is low or high; the weakest area is named); *What is kept* (the row as it fills, one row per question with self-rating and grade, every Ask; the profile on the account; the pending payload the installer claims); *Where the key comes from and what it pays for* (invite → account → credit key; every model call bills it; a spent key stops the flow with a message); *What reaches the machine* (the install code, the payload, the reader profile and knowledge levels in every workspace prompt); *What can go wrong and what the reader sees* (the failure table from the spec, in prose); *Where to change the prompts* (one module, six templates, tests pin shapes not words).

- [ ] **Step 2: Commit**

```bash
git add docs/onboarding-harness.md
git commit -m "Docs: how the onboarding harness behaves

Claude-Session: https://claude.ai/code/session_01QeUSmVvePHhJCEsoi1eEvo"
```

---

### Task 11: End to end

**Files:** none new.

- [ ] **Step 1: Migrations** — Hudson applies `20260902100000`, `20260902110000` and the claude-plugins `20260902120000` in project `tynpqxepuyyvxqdwzhkj`.
- [ ] **Step 2: Local run** — `vercel env pull .env.local` then `vercel dev`; in Chrome: `/engelbart/signin` → Create account with a fresh invite (`engelbart_generate_invite` from the admin page) → lands on `/engelbart/setup` → all ten steps with a real paper → install code.
- [ ] **Step 3: Machine** — on this Mac, `npx engelbart-cli --code <code>` against the preview (`ENGELBART_API_BASE=http://localhost:3000`), confirm the project opens with the paper on the goal's Paper tab and `reader.json` holding `expert`/knowledge; open the Understanding tab and confirm the prompt's "What they already know" block via `hc` logs.
- [ ] **Step 4: Record** — screenshots of Topics with a follow-up and of Done into the PR description; `npm test`, `npm run check`, and the hc suite outputs quoted verbatim.

## Self-review

- Spec §2.1 pages → Tasks 2, 7, 8. §2.2 actions → Tasks 5, 6. §2.3 prompts → Task 4. §3 tables → Tasks 3, 9. §4 flow → Tasks 7, 8. §5 model calls → Task 4 (+ Task 1 spike). §6 payload/hc → Tasks 5, 9. §7 invite → Task 2. §8 frontend → Tasks 7, 8. §9 failure modes → Tasks 5 (guards), 8 (retry, 409 wording). §10 verification → each task's tests + Task 11. §11 rollout → Task 11.
- Names used across tasks: `OB.open/step/sources/analysis/answer/details/goals/todos/ask/create` (Task 5) match Task 6's dispatch; `P.DEPTHS/FAMILIARITY/LADDER/readerBlock/depthOf/rung` (Task 4) match Task 5's uses; `OM.LEVELS/analyze/grade/details/goals/todos/ask` match; `Storage.downloadObject` (Task 5) and `ownPaperToken(paperId, userId, env)` (Task 5 Step 3) match `sources`; the page's `LABELS`, `api`, `save`, `go`, `slider`, `stepBox`, `cta`, `field`, `option`, `dots`, `generating`, `fail` (Task 7) match Task 8.
- Known simplification, stated: the follow-up rule fires only once per area, so an area is measured by at most two items; the register shift uses the mean of graded levels across areas (no weighting by `project_role`).
