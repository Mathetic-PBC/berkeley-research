# Background Paper Grounding implementation report

1. **Starting main:** `576c138a9f19f9f5ac7536a618333684ced535dd`, fetched from Mathetic-PBC/berkeley-research. This includes PR #93 and the subsequently merged Ask modal. Branch: `feat/background-paper-grounding`.

2. **Old call graph:** Browser Direction → `plan` → resources → grounding → canonical PDF download → `OM.paperGrounding` → draft → review. The resumable job held extracted evidence in its input until review persisted `analysis.grounding`. Legacy Direction/Subgoals/Todos used `ensurePaperGrounding()`, which directly downloaded the PDF, called the model, checked supersession, and patched Analysis.

3. **New call graph:** Paper submission still starts Analysis and Asset Hunt independently. Analysis success → browser independently starts the persisted Brainstorm opening and the shared `paper_grounding` job. The grounding claim owner downloads the canonical PDF, calls the unchanged Sonnet extraction, and atomically saves `analysis.grounding`. Direction → resources → shared grounding completion/reuse → draft → review. Legacy planning endpoints use the same shared job.

4. **Exact background start:** `readingUpdate()` after Analysis reaches done, and the safe `draw()` lifecycle for an already-analyzed open onboarding. `maybeWarmGrounding()` has no visible-step dependency. It does not redraw when background work finishes. Install, Brainstorm, Topics, Skip Topics, Asset Hunt, fitting and resource selection remain independent.

5. **Persistence/API:** Existing `planning.paper_grounding` JSON stores `status` (none/running/done/error), `started_at`, `finished_at`, error type/message, and the live claim token/lease. An absent job is none; a completed/error job drops its token/lease. The result remains `analysis.grounding`. No new table or lifecycle columns. The existing action supports `{run:true}`, a body without run/retry for a model-credential-free poll, and `{retry:true}`. Responses expose `grounding_status`, `grounding_error`, `grounding_started_at`, and completed `grounding`.

6. **Duplicate prevention:** Server-only `engelbart_grounding_transition` locks the onboarding row, verifies owner and paper, and grants one lease. All other callers join running work. Save requires the same paper and token and atomically merges the evidence into the current Analysis. Completed valid evidence is returned before claiming, including explicit retries.

7. **Reload:** Valid evidence is immediately reused. A running job is polled; an expired job is reported as none and reclaimed by the next run. A missing job starts automatically. Persisted errors do not automatically restart on reload. Direction's retry button explicitly authorizes a grounding retry.

8. **Stale/timeout recovery:** Vercel's onboarding ceiling is 300 seconds. Planning requests have a 270-second budget; grounding caps its application budget at 250 seconds, never extends a caller deadline, gives the model at most 200 seconds, and uses the existing 15-second PDF download cap and 10-second save reserve. A 310-second lease prevents recovery from overlapping a still-live hosting invocation. Application timeouts save a retryable error; killed invocations recover after lease expiry. A stale token cannot overwrite a successor.

9. **Paper replacement:** A before-update trigger removes grounding and its whole job when `paper_id` changes. Old saves fail paper/token checks. Re-reading lightweight Analysis for the same canonical PDF preserves valid existing grounding. The previous Brainstorm/calibration replacement cleanup stays intact.

10. **Direction states:** Done → reuse and advance to draft with no PDF/model read. Running → persist its planning position, return “Reading the paper,” and poll without holding a plan lease across calls. None → claim the same job as a recovery path. Error → retain inputs and show a retryable error; a click on Try again opts into retry. The draft/review path explicitly requires normalized valid grounding. Grounding's arrival is excluded from planning context identity; every other Analysis/user/resource field still compares exactly.

11. **Legacy compatibility:** Valid `analysis.grounding` is done even without job metadata. Valid evidence in an older same-paper resumable job is promoted to Analysis without extraction. Normalization and downstream review requirements remain intact. No completed records are rewritten by a bulk migration.

12. **Model calls:** Before: normally one successful full extraction, first incurred at Direction, with independent legacy callers lacking a shared claim. After: normally one successful full extraction earlier, shared across background requests, reloads, Direction, Subgoals and Todos. Direction normally incurs zero full grounding calls. Explicit retries after failure remain possible.

13. **Tests added/updated:** Real PostgreSQL (PGlite) exercises the actual migration/RPC for competing callers, running Direction joins, completed reuse, legacy Analysis and planning evidence, poll-only behavior, ownership, invalid evidence, explicit timeout retry, real AbortSignal deadline handling, expired leases, old tokens, in-flight paper replacement and same-paper Analysis refresh. Browser smoke tests cover start on Install, non-blocking progression, skipped Topics, reload, error suppression and explicit retry. Dispatcher tests verify polls need no model credentials. Existing PR #93 and planning tests remain in the suite.

14. **Full local results:** `npm test`: 478 passed. `npm run check` and `git diff --check`: passed. `npm ci` completed. Native installed round trip: 2 passed after `npx playwright install chromium`, using clean companion checkout `7e9820faec47610265b2bf033b75f2a2898e71cd`. The test retains the real installer, wheel, installed hook and isolated loopback UI boundaries.

15. **Browser compatibility:** New Paper → Install → Brainstorm → Topics → Assets → Direction lifecycle test passed in Chromium, Firefox and WebKit. It holds grounding open, reloads to join it, skips Topics, selects a resource, and verifies Direction waits for the same job. The compatibility command also exercises the existing OS install handoff: 4 passed. The full Playwright suite passed all 10 tests, including these cases and both debugger modes.

16. **Migration/deployment:** Apply `20260908080000_background_paper_grounding.sql` after existing 0500/0600/0700 migrations and before deploying this backend/frontend. It adds validity/job RPC functions and a paper-change/Analysis preservation trigger, and replaces the plan transition function to ignore only independently arriving grounding in context equality. No production migration has been applied by this task. No claude-plugins change or CLI version bump. Cross-platform GitHub Actions must pass before merge.

17. **Files changed:**
    - `api/_lib/grounding-job.js` — shared lifecycle.
    - `api/_lib/onboarding.js` — action and legacy callers.
    - `api/_lib/onboarding-model.js` — bounded grounding timeout.
    - `api/_lib/resumable-plan.js` — shared grounding wait/reuse and context.
    - `api/engelbart-onboarding.js` — poll semantics.
    - `engelbart/setup/setup.js` — background lifecycle, retry, context matching.
    - `engelbart/setup/test/sim-backend.js` — simulator parity.
    - `supabase/migrations/20260908080000_background_paper_grounding.sql`.
    - `tests/resumable-plan.test.js`, `tests/onboarding.test.js`, `tests/engelbart-onboarding.test.js`, `tests/setup-page-smoke.test.js`.
    - `e2e/background-grounding.spec.js`, `playwright.config.js`.
    - This report.

18. **Remaining limits/risks:** Real hosted Sonnet latency and live-paper output quality were not benchmarked; extraction content, token allowance and quality/review rules are unchanged. A browser that closes before initiating grounding leaves Direction/reload to recover it. A killed request can require waiting for the 130-second lease. If extraction succeeds but database persistence is lost, recovery may repeat that unrecorded work. Deployment must coordinate the additive migration and updated functions. Telemetry uses existing PDF-byte/secret redaction; job traces identify caller, start/reuse/join, stale recovery, retries, timeout/error and supersession without logging raw PDFs or credentials.

## Longer planning requests

Apply `20260908230000_longer_planning_leases.sql` before deploying the longer request budgets. It replaces only the planning/grounding transition functions (same arguments and grants), extends newly claimed leases to 310 seconds, and does not rewrite onboarding rows. Grounding, planning drafts, corrections and reviews allow 200 seconds per model call. Vercel’s onboarding function is configured for 300 seconds; verify the deployment accepts that duration. Ordinary actions retain 110-second request budgets. Existing caller deadlines, bounded resource probes, paper-download limits and explicit retry behavior remain intact. No installed-client change is required.
