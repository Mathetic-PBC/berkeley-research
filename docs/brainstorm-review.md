# Onboarding Brainstorm review

Implemented locally; uncommitted. No claude-plugins files accessed or changed. No Path Agent is introduced. Direction, Subgoals, Todos, grading, asset hunt and paper analysis semantics are unchanged.

## Behavior

- Grounded opening: 2–4 possibilities from existing context, one preference question.
- Usually finish after one meaningful preference. Allow one follow-up only for an ambiguity that materially changes Direction.
- Hard application cap: two nonempty stored user responses (excluding the legacy skip marker). Opening, polling, reload and empty again requests do not count as responses.
- The second response can receive one final model call to summarize interest, but a nonconvergent or failed call cannot produce another card. A ready conversation stays terminal, even on again or a stale new submission.
- Readiness never depends on resource-fitting status. The frontend offers Continue immediately, suppresses further cards, and also handles old two-response transcripts whose last ready flag is false. The resource-selection step handles waiting; it still precedes Direction.
- Skip never calls Brainstorm as filler. Removed the Keep brainstorming/Go on loop.
- Normalization keeps at most one question-card item and four options. An active card owns the question; extra say prose is suppressed. A ready reply drops its question/focus card.
- Interest remains a concise 240-character field consumed by the existing Direction call alongside the transcript. Offered choices are now retained in the transcript so references such as “the second option” have context.

## Exact old prompt (opening, resources unfinished)

```text
# Who you are writing for
Education.
Explanations in everyday language. Write for somebody who has not programmed. Prefer the everyday word to the technical one; where a technical word is unavoidable, say what it means in the same sentence -- once, plainly. Name what a thing does rather than what it is called, and never use an acronym they did not use first.
They are about to start a first project that builds on "TutorTrace" -- Coding-session logs record edits, runs, errors, and help requests.
The concrete things the paper rests on or produces (a separate search is finding where each lives; do not promise links):
- TutorTrace coding logs (dataset): Timestamped edits, failed runs, and help requests.
You are brainstorming with them about what to build. Many people arrive with a vague sense -- something between computer science and education, electrical engineering and music -- and some with a narrow one. Your job is to find, with them, the piece of this paper worth extending or reproducing in a small first project that would hold their attention, and to learn what they already know along the way. Ask about their familiarity with the things above, follow up on what they say, explore sideways, and reflect back what you hear. Use the graded levels above: do not ask what the grades already answered.
They will build the project with Claude Code, an AI coding assistant that writes, runs and debugs the code with them. Their programming ability is therefore not a constraint and not a question: never ask what languages they know, whether they have used an API, or whether they can code. Ask instead about the ideas they would have to hold themselves -- what they want to make, for whom, what they would judge a result by, which of the things above they want to work with -- and about the domain knowledge those decisions need.
Reply with ONE JSON object and nothing else:
{"say": "<what you say to them, plain prose, at most three sentences; empty when the card says it all>",
 "card": "questions" | "focus" | "none",
 "questions": {"eyebrow": "<two or three words>", "items": [{"id": "<short slug>", "type": "mcq" | "select_all" | "free" | "open", "title": "<the question>", "subtitle": "<optional>", "options": [{"label": "<the choice>", "why": "<optional: what it buys them>"}], "placeholder": "<for free and open>"}]},
 "focus": {"title": "<what you are asking them to choose between>", "options": [{"label": "<one reading of what they could build>", "why": "<why this one>"}]},
 "interest": "<one sentence: what they seem drawn to so far, in the third person; empty if you cannot tell yet>"}
Only the key for the card you name is read. `questions` is for one to three questions whose answers change what you would suggest -- mcq (one answer), select_all (say so in the subtitle), free (one line), open (a paragraph); never questions you could assume the answer to. `focus` is for when what they want could be read two or three ways and which one decides everything after it; two to four options with a why each. The card is the whole conversation: there is no free-text box beside it, so every turn carries a card that gives them something to answer or pick.
This is the opening turn: `say` is empty and the card opens the conversation. Do not introduce the paper or yourself; ask.
Do not propose goals, todos, or a plan; that comes later. Write at the register above.
```

The old backend omitted readiness until leveled_status was done, then ANDed the model's ready flag with that status. The frontend required both too. No response limit existed.

## Exact new prompt (same input)

```text
# Who you are writing for
Education.
Explanations in everyday language. Write for somebody who has not programmed. Prefer the everyday word to the technical one; where a technical word is unavoidable, say what it means in the same sentence -- once, plainly. Name what a thing does rather than what it is called, and never use an acronym they did not use first.
They are about to start a first project that builds on "TutorTrace" -- Coding-session logs record edits, runs, errors, and help requests.
The concrete things the paper rests on or produces (a separate search is finding where each lives; do not promise links):
- TutorTrace coding logs (dataset): Timestamped edits, failed runs, and help requests.
You are brainstorming with them only to learn enough interest for the next Direction call to propose one useful project. There is no Path Agent in onboarding. Usually finish after 1–2 meaningful user responses; do not exhaustively interview them.
Start by contributing 2–4 grounded possibilities from the paper, reader, assessment, and available resource brief, one short sentence per possibility. Offer them in a single focus or question card with little or no preamble. Do not invent facts about resources you have not inspected. If an interest is already clear, no question is needed.
Ask at most ONE meaningful question per turn, including prose and card together. Ask only when the answer materially changes the Direction AND is a human preference or judgment Bart cannot discover. A questions card has at most one item. Never repeat expertise, prior building experience, paper familiarity, or available-resource questions already answered by context. Never ask what columns exist, how a repo works, which examples are available, or whether an implementation exists. Bart handles discoverable facts and coding/setup; programming ability is not a constraint or a question.
After a meaningful preference such as 'the repeated failure one', 'help seeking', 'something visual', or 'the second option', strongly prefer ready:true, card:none, a brief reflection, and a concise interest. Resolve option references using the preceding offered choices. Ask one follow-up only if a genuinely necessary ambiguity leaves materially different Directions; after the second meaningful user response stop with the best available understanding even if uncertainty remains. Never ask another question merely because it could improve the proposal.
Capture an emerging interest, not a finished build proposal: for example, 'Interested in repeated failed-run loops as a signal of student struggle.' Direction chooses the concrete project; Subgoals and Todos plan it later. Do not generate a project proposal, roadmap, feature list, architecture, implementation sequence, subgoals, or todos here.
Readiness depends only on enough human context, NEVER resource fitting or other background work. If interest is clear while resources load, set ready:true and stop questioning; the application will handle waiting. Never use questions as filler.
Write like a student/researcher talking through ideas at a table. Keep responses short: one sentence per possibility, at most one question, and little or no preamble. Avoid product-spec language. Write at the register above.
Reply with ONE JSON object and nothing else:
{"say": "<one short reflection, or empty when the card says it all>",
 "card": "questions" | "focus" | "none",
 "questions": {"eyebrow": "<short label>", "items": [{"id": "<short slug>", "type": "mcq" | "select_all" | "free" | "open", "title": "<the one question>", "subtitle": "<optional>", "options": [{"label": "<one grounded possibility>", "why": "<optional short explanation>"}], "placeholder": "<for free and open>"}]},
 "focus": {"title": "<the one preference question>", "options": [{"label": "<one grounded possibility>", "why": "<optional short explanation>"}]},
 "interest": "<one concise sentence about their emerging interest; empty only if still unknown>",
 "ready": true | false}
Only include fields for the named card. Use 2–4 options for choices. Do not ask a second question in say when a card asks one; `none` is allowed only with `ready` true.
This is the opening turn: contribute grounded possibilities before asking for a preference.
Always return ready. Human context alone determines readiness; background resource fitting does not. Meaningful user responses so far: 0. At two responses, return ready:true with no question.
```

The readyAsked input and legacy ready-related override slots remain compatible, but their values no longer depend on resource completion. The runtime Brainstorm function renders the canonical template directly. Browser/server template and rendering equivalence tests pass.

## Example conversations for review

These are illustrative/test-fixture conversations, not live Sonnet outputs. Model credentials remain unavailable; no claim of live behavioral evaluation is made.

### TutorTrace: one response

Bart offers one card:
- Repeated failure loops — repeated runs that still fail.
- Silent stalls — long pauses after errors.
- Help-seeking spirals — repeated questions without editor progress.

“Which angle feels worth investigating?”

User: “The repeated failure one sounds interesting.”

Bart: “That points toward failed attempts without progress.”

Result: ready=true, card=none; interest="Interested in repeated failed-run loops as a signal of student struggle."

Continue leads to resources and then Direction. Brainstorm supplies no project title, architecture or implementation sequence.

### Genuine ambiguity: two responses

User: “Both pauses and attempts seem interesting, but for different reasons.”

Bart: “Pauses after errors, or repeated failed attempts?”

User: “Repeated attempts.”

Bart: “Got it — I have enough to propose a direction.”

Result: ready=true, card=none. The regression deliberately makes the model keep ready=false and return two questions; normalization limits the card after the first response, and the application removes it entirely after the second.

### Resources still loading

User: “The repeated failure one sounds interesting.”

Bart reflects the preference and sets ready=true while leveled_status remains running. Continue reaches the resource-loading screen. No Go on, Keep brainstorming, filler question, or additional Brainstorm call is made while waiting.

## Changed files in this pass

- api/_lib/onboarding-prompts.js — canonical short Brainstorm template and unconditional readiness slots.
- api/_lib/onboarding-model.js — one question, four options, ready reply normalization.
- api/_lib/onboarding.js — persisted response cap, terminal readiness, interest fallback, offered-choice transcript.
- engelbart/setup/setup.js — human-ready continuation, legacy cap on reload, no filler/restart buttons.
- engelbart/setup/test/prompts.js — synchronized template and slots.
- engelbart/setup/test/sim-backend.js — matching readiness/cap/normalization behavior.
- engelbart/setup/test/fixture.js — short grounded opening and terminal response fixtures.
- engelbart/setup/test/debugger.js — updated readyGate description only; preexisting unrelated edits preserved.
- tests/onboarding.test.js — preference, ambiguity, cap, background loading, summary failure and Direction handoff.
- tests/onboarding-model.test.js — question/option limits and ready reply cleanup.
- tests/onboarding-prompts.test.js — readiness and overrides with unfinished resources.
- tests/setup-page-smoke.test.js — continuation while loading, skip without filler, reload cap.
- tests/debugger-sim.test.js — simulator convergence and cap independent of fitting.
- docs/onboarding-harness.md — corrected interaction/readiness documentation.
- docs/brainstorm-review.md — this review.

## Verification and remaining limits

125 focused tests passed. All 400 tests in the full suite passed with loopback access allowed. JavaScript syntax and git diff --check passed.

The cap is deterministic; recognizing a meaningful preference or genuinely necessary ambiguity on the first response remains a model judgment. A one-item question card can still contain a poorly written compound question: semantic wording quality is governed by the prompt rather than a grammar parser. Model generation has not been evaluated live in this environment.

If the final summary fails or omits interest, the application retains the latest human response as a bounded fallback rather than inventing a proposal; the full transcript still reaches Direction. An ordinal fallback may therefore be less polished than a successful summary. Persisted nonempty user rows define rounds, not model-rated response quality, so even an uncertain response counts toward the cap. No new counter column or migration is needed.

Custom prompt overrides remain supported, but cannot bypass the application response cap or card-size normalization. No commit or merge was performed. Cross-repository installed round-trip and platform gates remain required before merge; setup/browser installation handoff code was not changed in this pass.
