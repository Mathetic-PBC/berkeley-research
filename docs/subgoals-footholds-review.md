# Subgoals foothold review

Status: implemented locally, uncommitted. No claude-plugins files were accessed or changed. Live Sonnet outputs remain unverified because this checkout and environment have no model credentials.

## Old full prompt (Stuck Moment Detector input)

```text
# Who you are writing for

Education.
Explanations in everyday language. Write for somebody who has not programmed. Prefer the everyday word to the technical one; where a technical word is unavoidable, say what it means in the same sentence -- once, plainly. Name what a thing does rather than what it is called, and never use an acronym they did not use first.

They are building on "Coding session replay" -- Recorded coding events reveal how students work.
The direction: "Stuck Moment Detector" -- Build a tool that identifies stuck/looping moments in real student coding sessions. First visible result: A coding session replay highlights possible stuck moments.
Built on:
{"title":"Student coding event logs","type":"dataset","description":"Real timestamped edit and run events, grouped by session. The reader has never used these logs."}





Break the direction into exactly three subgoals, in implementation order. Each must name a concrete, testable capability someone could tell you is working, not a phase, heading, instruction, topic, or unanswered decision. The first must be the smallest runnable technical vertical slice a coding agent can implement now without waiting for the student to browse a dataset, choose an example, collect inputs, read background, or make another decision. Prefer a usable GUI with the core input control and visible output; if the eventual input requires a human choice, first build the interface or pipeline with a tiny bundled or synthetic fixture, then put the human choice in a later subgoal. For example, "A video can be uploaded and previewed" comes before "A representative study video is chosen." The second builds the substance; the third reaches toward the paper's actual contribution or their own twist. Each carries a description (two sentences defining observable done conditions) and a why (one sentence explaining the dependency on what comes before).
Write at the register above.

Return ONLY valid JSON with nothing outside it.
{"subgoals": [{"label": "an outcome, 3-10 words", "description": "two sentences", "why": "one sentence"}, {}, {}]}
```

The old revision replaced its task instructions entirely with: “Revise the three subgoals to do what they asked. Keep what they did not object to.”

## New full prompt (same input)

```text
# Who you are writing for

Education.
Explanations in everyday language. Write for somebody who has not programmed. Prefer the everyday word to the technical one; where a technical word is unavoidable, say what it means in the same sentence -- once, plainly. Name what a thing does rather than what it is called, and never use an acronym they did not use first.

They are building on "Coding session replay" -- Recorded coding events reveal how students work.
The direction: "Stuck Moment Detector" -- Build a tool that identifies stuck/looping moments in real student coding sessions. First visible result: A coding session replay highlights possible stuck moments.
Built on:
{"title":"Student coding event logs","type":"dataset","description":"Real timestamped edit and run events, grouped by session. The reader has never used these logs."}





Propose exactly three small capability gains for the human: the next three footholds toward the approved Direction, not a feature roadmap or MVP/V2/V3 milestones. Minimize prerequisite burden on the HUMAN. Preserve the approved Direction as the eventual destination; its first visible result is context, not a requirement to build the complete capability in Subgoal 1.

Default progression, especially for an unfamiliar dataset, repository, scientific domain, tool, or system:
1. ORIENT: get one real thing into the user's hands. The agent selects a small real example/subset and makes it visible or runnable so the user can see what is there.
2. DEMONSTRATE: make one representative idea, operation, or workflow work end-to-end on that same example. Show one observable result with a sensible default chosen by the agent.
3. MANIPULATE: let the user change, compare, test, or investigate one meaningful variable or behavior on that same artifact and immediately see the effect.
These are scope heuristics, not required labels. Without an external dataset, make one concrete part visible/runnable, make one representative workflow work, then let the user change/test one meaningful behavior.

Every subgoal must produce ONE concrete observable result, introduce at most ONE substantial new conceptual burden, and reuse what the previous subgoal created (the first establishes that artifact). It must be understandable without first learning a whole domain and achievable by Bart without the user designing another subsystem. Choose sensible defaults and a small real subset/example over a generalized implementation. Keep the first subgoal small enough for the existing 2–4 implementation Todos.

The agent handles downloading data, cloning/inspecting the repository, inspecting schemas, reading docs or papers, installing dependencies, choosing a representative example/subset, and determining how to run the system as needed. Do not assign the user 'learn the dataset', 'read the documentation', 'understand the codebase', 'explore approaches', 'choose a representative example', or 'decide what variables to compare'. Understanding emerges through interacting with the artifact. Prefer an available real example; if none is accessible, explicitly identify the access limitation and a minimal labeled stand-in, never imply synthetic data is real.

Prefer one example, one rule, one parameter, one output, or one comparison before generalizing. Do not bundle major UI/system features or jump to many examples, many rules, dashboards, filtering systems, clustering/grouping, generalized pipelines, multi-rule comparison frameworks, aggregate/cohort analytics, or polished product features unless the approved Direction explicitly requires that scope as the immediate first useful result. Even then choose the smallest necessary case.

Before returning, silently check each subgoal: What is the ONE new thing the user can see or do after this? If the answer needs several major clauses joined by 'and', shrink it. Could this reasonably be the very next thing Bart builds once the preceding foothold exists? If not, shrink it. Check the progression gets the real thing into their hands, shows one idea working, then gives them one meaningful change to make; do not force it where inapplicable.

Each carries a label naming the observable capability (3–10 words), a description (two sentences defining observable done conditions), and a why (one sentence explaining why this foothold belongs here and, after the first, what it reuses).
Write at the register above.

Return ONLY valid JSON with nothing outside it.
{"subgoals": [{"label": "an outcome, 3-10 words", "description": "two sentences", "why": "one sentence"}, {}, {}]}
```

The new revision retains all the above constraints, includes the previous Subgoals and feedback, and adds: “Revise the three subgoals to address the feedback. Keep compatible work they did not object to, but shrink any inherited roadmap-sized subgoals to satisfy the foothold constraints above.”

## Implementation and scope

- api/_lib/onboarding-prompts.js: runtime Subgoals builder now uses the same SUBGOALS_TASK as its editable template slots; initial and revised requests share constraints. Updated debugger label. Existing TEMPLATES.subgoalsPrompt placeholders and override sanitization are preserved.
- engelbart/setup/test/prompts.js: matching task, revision slots, and label. Byte-for-byte equivalence is tested.
- engelbart/setup/test/sim-backend.js: descriptive Subgoals prompt summary now states the foothold progression.
- engelbart/setup/test/fixture.js: simulated initial/revised Subgoals now progress from one real chat, to one drift check, to a threshold change. Only the simulated Todos for that first Subgoal were made compatible; the production Todos prompt is unchanged.
- tests/onboarding-model.test.js: replaced obsolete Subgoals-only assertions.
- tests/onboarding.test.js: fake-response routing recognizes the Subgoals JSON schema rather than old task wording.
- tests/subgoals-footholds.test.js: six initial/revision cases across three domains verify the model-boundary request, scope instructions, preserved Direction, browser/server equivalence, override rendering, and normalized schema/order. One additional normalizer bounds test.
- tests/fixtures/subgoals/cases.json: three domain inputs and semantic output rubrics.
- scripts/eval-subgoals.cjs: opt-in live evaluation through production OM.subgoals, followed by an independent model call judging each structural criterion with evidence. Saves generated output and judgments as JSON; exits unsuccessfully if any criterion fails or credentials are missing.
- docs/subgoals-footholds-review.md: this review.

The production model family remains Sonnet with a 4096-token reply budget. The normalizer remains shape-only: label/description/why, caps 200/500/300, first three valid entries, rejects fewer than three. No added schema fields or keyword-based semantic filtering. No onboarding UI or other stage prompts changed. Existing unrelated working-tree edits were preserved.

## Illustrative examples, not live model outputs

These examples describe the intended behavior for review. They were written here, not returned by the repository's configured Sonnet call, and are not evidence of a live evaluation pass.

### Stuck Moment Detector

1. **See one real coding session.** Bart selects one real session and displays its important coding events in order. The reader can inspect what happened without first browsing the dataset. **Why here:** a concrete example comes before defining stuck behavior.
2. **See one possible stuck moment.** Apply one default rule that flags three minutes without a successful run on that same session. Show the flagged interval beside the events. **Why here:** the reader can see what a rule means on the example already in view.
3. **Change the threshold and inspect the result.** Let the reader change three minutes to five on the same session. Immediately update the flagged intervals. **Why here:** one controlled change lets the reader judge what should count as stuck.

### Unfamiliar microscopy dataset

1. **See one real microscope image.** Bart selects and displays one image from the collection. The reader can inspect the cells in that image. **Why here:** the reader sees the data before choosing an analysis.
2. **See one cell's measured area.** Use an agent-chosen threshold to outline one cell on that same image. Display the outlined area in pixels. **Why here:** one concrete result shows what the measurement means.
3. **Change the threshold and inspect the outline.** Let the reader adjust that threshold on the same image. Update the outline and its area readout immediately. **Why here:** the reader can investigate how one choice changes the measurement they just saw.

### Software without an external dataset

1. **See the editor running with a sample.** Bart runs the existing editor with its bundled note. The reader can see the sample text. **Why here:** a concrete running part gives them a starting point.
2. **See the sample rendered as Markdown.** Render that same note in a minimal preview. A sample heading appears as a formatted heading. **Why here:** one working input-to-output case makes the feature understandable.
3. **Change a heading and see its effect.** Let the reader edit the sample heading's level. Refresh its appearance in the same preview. **Why here:** a single meaningful edit reveals how the behavior works.

## Tests and limitations

Focused suite: 114 passed, 0 failed. Includes onboarding, model, prompt equivalence, debugger simulator, debugger frame, debugger page, and the new foothold tests.

Full npm test: 384 passed, 0 failed after allowing loopback binding outside the sandbox. The initial sandbox run passed 381 and failed three telemetry verifier tests solely with listen EPERM on 127.0.0.1.

git diff --check and evaluator syntax check passed.

Live evaluation attempted but blocked before any model call: no ENGELBART_ANTHROPIC_API_KEY or LITELLM_BASE_URL + LITELLM_API_KEY. With credentials configured, run:

```sh
node scripts/eval-subgoals.cjs /private/tmp/subgoals-evaluation.json
```

Offline model-boundary tests use mocked replies and do not prove generated output quality. The live semantic judge is also fallible; review its saved outputs and evidence. Prompt constraints reduce scope drift but the unchanged normalizer cannot enforce human prerequisite burden. Full custom prompt overrides intentionally remain authoritative and can omit the default guidance. Cached existing Subgoals are returned unchanged until revised or regenerated. The generator receives resource summaries, not the raw dataset; later implementation must verify availability and choose the real example.

No commit or merge performed. Cross-repository installed round-trip and macOS/Ubuntu/Windows merge gates were not run; they remain required before any merge. No setup/browser handoff code changed.
