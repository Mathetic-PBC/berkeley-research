# Engelbart onboarding v2: install early, brainstorm from the paper's assets, one direction

Date: 2026-09-03. Status: in progress. Extends the 2026-09-02 design. Hudson's
brief (verbatim intent, restated): after the paper is accepted the reader
installs Engelbart, answers the topic questions, brainstorms against the
paper with the concrete things it rests on, picks one deliverable, accepts or
iterates one direction and three subgoals, gets todos for the first subgoal,
and finishes by opening a new Claude chat and running `/bart`.

## 1. Steps

```
0 Name · 1 Year · 2 Major · 3 Explanations · 4 Paper · 5 Install ·
6 Topics · 7 Brainstorm · 8 Assets · 9 Direction · 10 Subgoals · 11 Todos ·
12 Done
```

Project draft, Details and Focus are gone. `profile_reused` keeps base 4:
the paper is then "Step 1 of 8".

## 2. Background work, and when it runs

| trigger | runs | writes |
| --- | --- | --- |
| Paper accepted (`sources`) | `analysis {run}` (existing) and `assets {run}` (new), both fire-and-forget from the page | `analysis*`, `assets*` |
| last Topics answer (`topics_done`) | compiles `assessment` from the calibration rows (no model) and returns; the page then fires `leveled {run}` | `assessment`, then `leveled*` |
| `leveled {run}` while `assets` still running | answers `waiting`; the page retries every 5 s during Brainstorm | |

`assets`: one Sonnet call from the cached paper prefix with the web search
tool (fallback: no tool), followed by server-side link verification (HEAD,
5 s each, capped). The reply is the full list (paper's register) and the
page-facing brief is a projection `{title, one_liner, type}` stored as
`assets_brief` for Brainstorm.

`leveled`: Sonnet with web search, given `assessment` and the reader block;
returns the same shape with optional `children` (each with `why`) and
`locus` / `sticky`. Descriptions rewritten at the reader's register.

## 3. Data (migration `20260903120000_engelbart_onboarding_plan.sql`)

`engelbart_onboardings`: step check widened to 0–12; new columns
`assets jsonb, assets_brief jsonb, assets_status, assets_error,
assets_started_at, assessment jsonb, leveled jsonb, leveled_status,
leveled_error, leveled_started_at, interest text, asset_chosen jsonb,
direction jsonb, subgoals jsonb`.

New table `engelbart_onboarding_turns`: every conversational turn
(`stage` brainstorm | asset | direction | subgoals, `asset_key`, `role`,
`content`, `card jsonb`). RLS on, grants revoked, service role only.

## 4. Actions (all on `api/engelbart-onboarding.js`)

| action | model | effect |
| --- | --- | --- |
| `assets {run\|retry}` / poll | Sonnet + search | like `analysis` |
| `answer` | Haiku | unchanged server-side; the page no longer shows the grade |
| `topics_done` | none | compiles `assessment`; step 7 |
| `leveled {run}` / poll | Sonnet + search | `waiting` until assets are done |
| `brainstorm {text?, answers?, pick?, note?}` | Sonnet | one turn: reader + assessment + brief + transcript → `{say, card, interest}`; card ∈ questions \| focus \| none |
| `asset_ask {key, question}` | Sonnet | answer about one asset; stored as a turn |
| `choose_asset {key}` | none | `asset_chosen`; step 9 |
| `direction {revise?}` | Sonnet | one direction, or a revision from feedback; stored + turn |
| `subgoals {revise?}` | Sonnet | three subgoals for the direction; stored + turn |
| `todos {regenerate?}` | Sonnet | 2–4 rows for the FIRST subgoal, plus a name |
| `create` | none | payload: one goal (the direction), three subgoals with rows on the first; `hc_profiles`; `created` |

## 5. Prompts

- `analyze`: questions are about the field and the concepts the model picks,
  never review questions about the paper; tier 0 has no jargon and reads to
  anyone from any field; the reader's chosen technical depth (step 4) is
  named for every computing term.
- `assets`: inputs and outputs of the work — datasets, tasks and apparatus,
  codebooks, experimental paradigms, mathematical and computational models,
  simulations, analysis pipelines, surveys and coding schemes, libraries,
  code — concrete and digitally manipulable or extendable; paragraph
  description of what it is and how it is used, technical register; real
  links only.
- `level`: the sticky-information / locus-of-problem-solving lens; children
  are beginner stand-ins with a `why`.
- `brainstorm`: Engelbart's brainstorm card grammar (questions
  mcq/select_all/free/open, focus, none), focused on extending the paper,
  using the brief.
- `direction`, `subgoals`, `todos`, `asset_ask`: new, register-enforced.

## 6. Page

- Install (5): OS → variant → one instruction at a time with a keyboard
  animation and a copy row (`engelbart/setup/install.js`, shared with Done).
- Topics (6): silent grade; a follow-up is asked; moving the slider on a
  follow-up asks the ladder question at that level instead.
- Brainstorm (7): a chat column with cards; after each assistant turn, once
  `leveled` is done, an "Are you ready to start planning?" card.
- Assets (8): the mockup — rows with mark, type · availability, expand for
  description / what you can do / links / per-asset chat; children rows
  "at your level" with a why; pick one.
- Direction (9), Subgoals (10): the proposal, "Looks good ›", and a
  "Change something" unfold with a chat box.
- Todos (11): rows for the first subgoal, editable; name; Create.
- Done (12): open a new terminal → `claude` → `/bart` (keyboard steps).

## 7. CLI (claude-plugins)

- The install command from step 5 carries `--no-open`; the installer says to
  return to the browser.
- `/bart` in a chat with no bound project claims the pending web setup
  (`engelbart-setup {action: pending}` with the machine token) and creates
  the project through the `setup-import` path, then binds.

## 8. Verification

- `node --test` for normalizers, record actions, dispatch, payload.
- Page smoke tests per step on the stub DOM.
- Preview deployment; Chrome against it with a session; the installer with
  `ENGELBART_API_BASE` pointed at the preview; `/bart` claims the setup.
