# Engelbart onboarding: calibrated first project

Date: 2026-09-02. Status: approved design. Replaces the `/engelbart/setup`
conversation (questions → plan → goals → todos) with the ten-step flow in
the `onboarding-flow.html` reference, adds a prior-knowledge diagnostic
graded against sample responses, and makes the onboarding record itself
the durable store of everything the reader says.

Companion repos: `berkeley-research` (site, functions, migrations) and
`claude-plugins` (`hc` runtime: payload import, reader profile).

## 1. Goals and non-goals

Goals

- The page after account creation is the ten-step flow: Name, Year, Major,
  Explanations, Paper, Project, Topics, Details, Focus, Todos, then Done.
- The PhD paper is analysed while the reader keeps going; the analysis
  produces the calibration areas and their questions in one model call.
- Each calibration answer is graded against the prompt's sample response;
  the graded level, not the self-rating, steers the register of everything
  generated afterwards and travels to the workspace.
- Every answer, score, link, paper reference and personal field is stored
  in Supabase as it happens, not only at the end.
- Account creation requires an invite code again.
- The flow still ends in the pending-setup payload the installer already
  imports, so `npx engelbart-cli --code …` opens the project unchanged.

Non-goals

- The local `hc setup-ui` page (keyless installs) keeps its own
  conversation and its three register stops.
- Lab exploration, curated landscapes and the structured four-phase
  generator stay in place, unused by this page.
- Dark theme on the new page (the reference is light only).

## 2. Surfaces

### 2.1 Pages

- `/engelbart/setup` — rewritten `engelbart/setup/{index.html, setup.css,
  setup.js}`. Vanilla DOM, no runtime, CSP-clean (scripts from self and
  cdn.jsdelivr.net only). Signed out → `/engelbart/signin`. Signed in →
  `open` (below) and resume at the stored step.
- `/engelbart/signin` — signup regains the invite sequence: invite code +
  email → "Check the code" (`engelbart_redeem_invite`) → password → create.
  After signup with a live session, and as `emailRedirectTo`, the
  destination is `/engelbart/setup`. The pairing panel is unchanged.

### 2.2 Functions

`api/engelbart-onboarding.js` (new, `maxDuration` 120). Every action is a
POST with `Authorization: Bearer <supabase JWT>`, verified by
`verifyUser` (membership required). Model-backed actions obtain the
member's LiteLLM key through `Credits.credentialsFor(user)`; an
`exhausted` or `blocked` key answers 409 with the existing wording. The
member's key is the only model credential anywhere in the flow.

| action | input | effect | returns |
| --- | --- | --- | --- |
| `open` | `{fresh?}` | Finds the member's `open` onboarding or creates one; `fresh:true` after a `created` row starts another. Calls `credentialsFor` so a keyless account fails here, not at step 7. | `{onboarding, calibrations, credit:{status,budgetUsd,spendUsd}}` |
| `step` | `{step, fields}` | PATCH of whitelisted fields (§3.1) and `step = max(step, given)`. | `{onboarding}` |
| `sources` | `{paper_id, paper_token, project_url?, repo_url?, paper_familiarity}` | Stores the sources, marks `analysis_status=running`, then runs the analysis to completion in the same invocation (§5.1) and writes `done` or `error`. A call while `running` and younger than 180 s is a no-op answering `running`. | `{analysis_status}` |
| `analysis` | `{retry?}` | Poll. `retry:true` re-runs the analysis for the stored paper (no token needed: the paper was proven at `sources`), subject to the same 180 s running guard. | `{analysis_status, analysis?, analysis_error?}` |
| `answer` | `{area_index, question_level, self_level, answer}` | Upserts the calibration row, grades it (§5.2), and decides whether a follow-up is due. | `{graded_level, grade_confidence, grade_rationale, follow_up?:{question_level, question}}` |
| `details` | `{regenerate?}` | Generates the Details questions once; returns the stored set afterwards. | `{intro, questions}` |
| `goals` | `{regenerate?}` | Generates the four Focus goals once. | `{goals}` |
| `todos` | `{goal, regenerate?}` | Generates 2–4 todos and a proposed name for the chosen goal. | `{todos, name}` |
| `ask` | `{step, quote, question, level}` | Answers a question about selected text at the given register; stores it. | `{answer}` |
| `create` | `{project_name, goal_chosen, todos}` | Builds the payload (§6), `engelbart_save_pending_setup`, upserts `hc_profiles`, sets `status=created`. On an already-`created` row it does nothing and answers ok. | `{ok, pending_setup_id}` |

Reused unchanged: `engelbart-setup {own_paper, own_paper_saved}` for the
PDF (browser → Storage through a signed upload URL; the function never
carries the bytes), `engelbart-device {issue}` for the install code,
`engelbart-config` for the browser's Supabase client.

`paper_token` is the HMAC `own_paper` already returns: `sources` accepts a
paper only with the token that proves this member created it.

### 2.3 Prompts module

`api/_lib/onboarding-prompts.js` holds every prompt as an exported
template function with its inputs documented at the top: `analyze` (the
diagnostic prompt, verbatim), `grade`, `details`, `goals`, `todos`,
`ask`, and the shared `readerBlock`. Tests assert JSON shape and bounds,
never wording, so the goal and todo prompts can be rewritten without
touching anything else.

## 3. Data model

Migration `supabase/migrations/20260902110000_engelbart_onboarding.sql`.
Same posture as `engelbart_pending_setups`: RLS on, all grants revoked
from `anon` and `authenticated`, reached only through the functions with
the service role.

### 3.1 `engelbart_onboardings`

| column | type | notes |
| --- | --- | --- |
| id | uuid pk | |
| user_id | uuid → auth.users | cascade |
| status | text | `open` \| `created` |
| step | int | furthest step reached, 0–10 |
| name, year, major | text | `step` fields |
| depth | text | `everyday` \| `some` \| `technical` \| `expert` \| `''` |
| paper_id | uuid → berkeley.papers | null until `sources` |
| paper_title | text | from the analysis, for the rail and the payload |
| project_url, repo_url | text | as typed, bounded 500 |
| paper_familiarity | int | 0–4, the Paper step's slider |
| project_draft | text | bounded 2000 |
| analysis | jsonb | the diagnostic prompt's full JSON, normalized |
| analysis_status | text | `none` \| `running` \| `done` \| `error` |
| analysis_error | text | |
| analysis_started_at | timestamptz | |
| details | jsonb | `{intro, questions[], answers{}}` |
| goals | jsonb | the four offered |
| goal_chosen | text | label, typed or picked |
| todos | jsonb | string[] |
| project_name | text | |
| pending_setup_id | uuid | set by `create` |
| created_at, updated_at | timestamptz | |

Partial unique index on `(user_id) where status = 'open'`.

`step` whitelist: name, year, major, depth, project_draft, `details.answers`,
goal_chosen, todos, project_name.

### 3.2 `engelbart_onboarding_calibrations`

One row per question actually asked.

| column | notes |
| --- | --- |
| id, onboarding_id → onboardings (cascade), user_id | |
| area_index int, area text, parent_field text | from the analysis |
| self_level int | slider value at the time, 0/25/50/75/100 |
| question_level int | the level of the question asked |
| question, sample_response text | copied from the analysis |
| answer text | bounded 2000 |
| graded_level int null, grade_confidence real null, grade_rationale text | null when grading failed |
| asked_at, answered_at | |

Unique `(onboarding_id, area_index, question_level)`.

### 3.3 `engelbart_onboarding_asks`

`id, onboarding_id, user_id, step int, quote text, question text, level
text, answer text, created_at`.

### 3.4 `hc_profiles` (claude-plugins migration)

`tech_level` check gains `expert`; new column `knowledge jsonb not null
default '[]'`; `hc_set_profile` gains `p_knowledge jsonb default '[]'`.
`create` writes the row with the service role (`hc_set_profile` reads
`auth.uid()`, null under the service role), upserting `user_id,
display_name, year, major, tech_level, knowledge`.

Personal information therefore lives on the onboarding row and in
`hc_profiles`; the email is already `auth.users`.

## 4. Flow

The browser is a mirror of the row. Every Continue is a `step` call; a
reload calls `open` and redraws at the stored step with the stored
values. Steps and their numbers follow the reference:

0 Name · 1 Year · 2 Major · 3 Explanations · 4 Paper · 5 Project ·
6 Topics · 7 Details · 8 Focus · 9 Todos · 10 Done.

- **0–3** collect name, year (four options or typed), major (typed with
  seeds), depth (four-stop bar slider). Each Continue PATCHes.
- **4 Paper.** PDF required (`application/pdf`, ≤ 20 MB; Anthropic's own
  limit is 32 MB / 100 pages). Upload: `own_paper {title, wantsUpload}` →
  PUT to the signed URL → `own_paper_saved`. Project page and GitHub URLs
  optional. Familiarity: five-stop bar slider. Continue = `sources`, sent
  without awaiting; the page moves to 5. The rail shows "Reading your
  paper in the background" while `running`.
- **5 Project.** Free-text draft, PATCHed.
- **6 Topics.** If `analysis_status` is not `done`, the waiting screen
  polls `analysis` every 3 s (`error` shows Retry, which sends
  `analysis {retry:true}`). Then, per area in order: the area name, its `project_role`,
  a five-stop familiarity slider, and the question at the slider's level.
  Moving the slider before answering swaps the question. Answering sends
  `answer`; the response either advances (dot turns filled) or shows one
  follow-up question at the graded level. Two questions per area is the
  cap. An area's level is its last graded level, else its self-rating.
- **7 Details.** `details` generates 3–4 project-scoping questions
  (choice, multi, short) at the assessed register, with an intro line when
  the register was shifted ("Asking in plainer terms — you're newest to
  X" / "Asking more directly — …"). Answers PATCH into `details.answers`;
  Skip stores null.
- **8 Focus.** `goals` offers four goals with `why`, plus "Something
  else" with a text box.
- **9 Todos.** `todos` proposes 2–4 rows and a name. Rows are editable,
  removable, addable up to 4; Create needs 2–4 rows and a name. Create =
  `create`, then `engelbart-device {issue}`.
- **10 Done.** "✓ *name* is made", the one-line summary, the
  `npx engelbart-cli --code …` command with copy, "Get a new code", and
  "Set up another" (`open {fresh:true}`).
- **Ask about this** (steps 6–9): selecting ≥ 3 characters inside the
  content column shows the button; the panel offers four quick questions
  and a free one; answers list under "Asked" with simpler / more detail
  (re-asks at the adjacent register) and remove. All stored.

Assessed register: the reader's chosen depth, shifted one stop down when
the mean area level ≤ 25, one stop up when ≥ 75, clamped. The weakest
area is the one named in the intro line.

## 5. Model calls

All calls go to `POST {baseUrl}/v1/messages` with the member's key, as
`setup-chat.callModel` does. `pickModel` is generalised to a family:
Sonnet for `analyze`, `details`, `goals`, `todos`, `ask`; Haiku for
`grade` (fallback `claude-haiku-4-5-20251001`).

### 5.1 analyze

Inputs: `PROJECT_FAMILIARITY` (the Paper slider's label and description),
`DESIRED_TECHNICAL_DEPTH` (the Explanations stop's label and
description), the PDF, and the project URLs with their fetched text.

- The PDF is downloaded from Storage with the service role
  (`Storage.downloadObject`) and sent as a `document` content block
  (base64, `application/pdf`) placed where the prompt's
  `<phd_student_paper>` tag sits; the prompt text around it is split into
  text blocks. Page text for each URL comes from `PageFetch.fetchPageText`
  (public hosts only, 20k chars each) and sits inside `<project_urls>`.
- `max_tokens` 8192, timeout 100 s.
- The reply is normalized to the prompt's schema: 2–4 areas; exactly five
  questions per area sorted by level 0/25/50/75/100 with `capability`
  forced from the level; `title` ≤ 60, `one_liner` ≤ 300, `area` and
  `parent_field` ≤ 80, `project_role` and `granularity_rationale` ≤ 300,
  `question` ≤ 600, `sample_response` ≤ 1200; `date` kept only when it
  matches `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, else null. A reply that
  cannot be normalized to at least two complete areas is an error.
- Spike before anything else: `scripts/verify-pdf.mjs` sends a small PDF
  through the live proxy as a `document` block. If the proxy does not
  forward it, the fallback is browser-side text extraction with pdf.js
  (cdn.jsdelivr.net is already allowed) sent as text — figures and
  equations are then lost to the analysis.

### 5.2 grade

Inputs: area, the five capability definitions, the question and its
level, the sample response, the reader's answer. Output
`{level: 0|25|50|75|100, confidence: 0–1, rationale ≤ 200}`. A failed or
unparseable grade leaves `graded_level` null and the self-rating stands.
Follow-up rule: when `|graded − self| ≥ 25` and this is the area's first
question, the response carries the analysis question at the graded level.

### 5.3 details, goals, todos, ask

Each takes the shared reader block — name, year, major, depth phrase and
its register rule, and "What they already know" as one line per area with
its capability phrase and level — plus the paper's `title` and
`one_liner`, the draft, and (from Details onward) the prior answers.
Outputs, all bounded before storage:

- `details`: `{intro, questions:[{id, kind: choice|multi|short, title,
  hint?, options?, placeholder?}]}`, 3–4 questions.
- `goals`: `{goals:[{label ≤ 200, short ≤ 40, why ≤ 300}]}`, exactly 4.
- `todos`: `{todos: string[2–4] ≤ 300 each, name ≤ 80}`.
- `ask`: `{answer ≤ 1200}`.

Register is enforced by the reader block, not by canned variants.
`regenerate` re-runs a call and replaces the stored result.

Cost envelope: one PDF call of roughly 20–40k input tokens plus about ten
small calls — well under one dollar of the member's budget.

## 6. Payload and the workspace

`create` maps the row to the pending-setup payload:

```
name        project_name
plan        {description: project_draft + "\n\nBuilding on “<title>” — <one_liner>", unsure: []}
goals       the four offered as {label, why}; a typed goal is appended with why ""
chosen      goal_chosen
todos       the rows
subgoals    []
paper       {paper_id, title, url: project_url or ""}
provenance  {papers: [{paper_id, title}], idea: {title: goal_chosen, inspired: title}}
reader      {name, year, major, level, knowledge: [{area, parent_field, level, project_role}]}
```

`depth → level`: everyday→plain, some→some, technical→full,
expert→expert. `SetupChat.normalizePayload` learns `reader` (bounded,
knowledge ≤ 4 entries).

claude-plugins changes

- `hc setup-import` passes `payload["reader"]` to `READER.remember`.
- `reader.py`: `EXPERT` level with its name and rule; `normalize` accepts
  `knowledge` (≤ 4 of `{area ≤ 80, parent_field ≤ 80, level ∈
  {0,25,50,75,100}, project_role ≤ 300}`); `lines()` appends a "What they
  already know" block, one line per area with the capability phrase;
  `supabase_client.set_reader_profile` sends `p_knowledge`.
- Migration `hc_reader_knowledge`: the constraint, the column, the RPC.

## 7. Invite gate

Migration `20260902100000_engelbart_invite_gate_restored.sql` restores
the refusing bodies of `engelbart_before_user_created` (403 without a live
approval) and `engelbart_finish_signup` (raise without one), keeping
`'open'` in the members source check for rows that already exist.
`engelbart_redeem_invite` stays executable by `anon`, as the reserve-then-
signup path needs. The signin page restores the invite form from
`afe4170^`. The README's hook note is corrected.

## 8. Frontend

- `setup.css`: the reference's token block (Geist scale) and the inline
  styles turned into classes. Light only.
- `setup.js`: state = the row + transient UI (drag positions, open
  panels, ask button); `draw()` per step; an `api()` client; the three bar
  sliders are one component with pointer capture and snap-to-stop. No
  sessionStorage: the server is the truth; supabase-js keeps the session.
- Deviations from the reference: the register bar stays hidden (it is
  `showRegister:false` there); Done gains the install command; generated
  steps show a "generating" state instead of instant canned text.

## 9. Failure modes

| situation | behaviour |
| --- | --- |
| no key / credit exhausted / blocked | 409 at `open` or at the model action; the page shows the message and a link to the account page |
| analysis error | Topics shows the error and Retry (`analysis {retry:true}`) |
| analysis stuck `running` > 180 s | treated as dead; `sources` or `analysis {retry:true}` re-runs |
| grading error | `graded_level` null; self-rating stands; no follow-up |
| details / goals / todos error | inline error with Try again |
| reload anywhere | `open` → resume at the stored step |
| duplicate project name | unchanged: `hc setup-import` reports it on the machine |
| `create` twice | second call is a no-op; the page re-issues a code |
| paper token mismatch | 403 from `sources` |

## 10. Verification

- `node --test` (berkeley-research): analysis normalizer (areas, five
  levels, bounds, date), grade normalizer and follow-up rule, assessed
  register, details/goals/todos normalizers, payload mapping incl.
  `reader`, `step` whitelist, `sources` running guard, handler dispatch
  with injected fetch/rpc.
- `scripts/verify-pdf.mjs`: the live-proxy document-block spike.
- claude-plugins: `tests/test_hc_onboarding.py` grows an import case with
  `reader`; a reader test for `expert` and the knowledge block. Run with
  `env -u HC_CHAT_INFERENCE`.
- End to end in Chrome against `vercel dev` with a real invite and a real
  paper, through to a project opened by `npx engelbart-cli --code`.
- `docs/onboarding-harness.md`: the harness's behaviour, no files or line
  numbers.

## 11. Rollout (Hudson)

1. Apply `20260902100000_…invite_gate_restored.sql` and
   `20260902110000_…onboarding.sql` in project `tynpqxepuyyvxqdwzhkj`;
   apply the claude-plugins `hc_reader_knowledge` migration there too.
2. The Before User Created hook stays registered on
   `engelbart_before_user_created`.
3. Merge and push `main` in berkeley-research (Vercel deploys).
4. claude-plugins: merge, `npm run build:vendor`, install, so
   `setup-import` and the reader block go live.
