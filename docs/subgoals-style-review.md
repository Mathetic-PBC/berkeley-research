# Subgoals style pass — review before commit

Changes are uncommitted. This pass is confined to Subgoals wording, prompt representations, simulated outputs, and evaluation/tests. The prior foothold scope instructions remain intact. Direction, Todos, Brainstorm, onboarding UI, model selection, normalizer, and prompt override behavior are unchanged in this pass. No claude-plugins files were accessed or changed.

## Exact prompt changes

Replaced this paragraph:

> Each carries a label naming the observable capability (3–10 words), a description (two sentences defining observable done conditions), and a why (one sentence explaining why this foothold belongs here and, after the first, what it reuses).

With this exact text (applies to initial and revision calls):

```text
Write like a student/researcher project plan or a researcher's notebook, not a product specification. Every label begins with an active verb (hard constraint); labels are usually 3–8 words and name what the person is trying to accomplish. Use direct action language such as Inspect, Apply, Highlight, Compare, Test, Adjust, Measure, Reproduce, Explore, Verify, or Visualize; these are examples, not a restricted vocabulary. An action means working with the artifact, not assigning prerequisite study or setup to the human.
Descriptions are one concise sentence, usually 15–30 words. Answer: What will I be able to see, do, test, compare, or understand after this? Describe the capability/result, not the UI implementation. Do not enumerate controls/components, panels, filters, dropdowns, or columns unless essential to the research task. Avoid product-spec phrasing such as 'A panel displays', 'The interface allows', 'The window shows', 'Checkboxes let', 'A ranked list appears', 'The system provides', or 'Users can', unless the UI control itself is central to the research question.
The why is one short sentence, usually 10–25 words, explaining why this is the next foothold; do not repeat the description.
Keep the same concrete example across the first three subgoals whenever possible: inspect it, apply one idea to it, then manipulate one meaningful variable. Do not automatically expand from one example to many examples or a whole cohort; generalization can happen later.
Before returning, silently ask: Could this plausibly be written in a researcher's notebook as tomorrow's goal? If not, rewrite it more naturally. Verify every label starts with an active verb and each description and why is a concise single sentence, while preserving the scope constraints above.
```

Replaced the output example in the runtime builder and both server/browser TEMPLATES:

```json
{"subgoals": [{"label": "an outcome, 3-10 words", "description": "two sentences", "why": "one sentence"}, {}, {}]}
```

with:

```json
{"subgoals": [{"label": "active verb first, usually 3-8 words", "description": "one concise sentence, usually 15-30 words", "why": "one short sentence, usually 10-25 words"}, {}, {}]}
```

The simulator's descriptive prompt summary now appends “active-verb labels and concise notebook-style descriptions and reasons.” Its actual rendered prompt is byte-for-byte equal to the runtime prompt.

## Before/after simulator outputs

These are actual before/after **simulator fixtures**, not live Sonnet responses.

Before:

1. **See one stored chat beside its goal**

   Bart selects one real vault trace with an existing goal tree and displays its turns beside the active goal. The reader can see what the agent actually did.

   Why: A concrete chat makes the meaning of drift easier to judge.

2. **See one default drift check flag turns**

   Apply a single default goal-alignment check to that same chat. Mark a possible drift after three consecutive unserved turns.

   Why: The visible chat now shows what one drift rule means.

3. **Change the drift threshold and inspect flags**

   Let the reader change the consecutive-turn threshold from three to five on the same chat. Update the flags immediately.

   Why: The reader can judge the rule by changing one thing on the example they already know.

After:

1. **Inspect one stored chat**

   Inspect the turns in one real chat chosen by Bart alongside its active goal to follow what happened.

   Why: Start with a real conversation before deciding what might count as drift.

2. **Flag one possible drift**

   Apply one default alignment check to that same chat and flag three consecutive turns that do not serve its goal.

   Why: See what one definition of drift picks out before trying to refine it.

3. **Adjust the drift threshold**

   Change the threshold from three turns to five and check which flags remain in that same chat.

   Why: Judge the rule by seeing the effect of one change on a familiar example.

## Examples across domains

These are authored reference examples, not live generated outputs. The previous review's authored examples provide the before comparison: descriptions such as “Bart selects one real session and displays its important coding events in order. The reader can inspect what happened without first browsing the dataset.” now become one direct sentence. Microscopy previously said “Use an agent-chosen threshold to outline one cell on that same image. Display the outlined area in pixels.” Software previously said “Render that same note in a minimal preview. A sample heading appears as a formatted heading.”

### tutortrace

1. **Inspect one student’s session**

   Inspect one real TutorTrace session chosen by Bart and follow its coding events in time order.

   Why: See what the data looks like before deciding what might signal struggle.

2. **Highlight one struggle signal**

   Apply one simple default struggle rule to that same session and mark the moments where it fires.

   Why: See what one definition of struggle picks out before trying to refine it.

3. **Adjust the struggle rule**

   Change one time threshold on that same session and check which moments become highlighted or disappear.

   Why: Start judging what counts as struggle by seeing the effect of one change.

Word counts (label / description / why): 4 / 16 / 12; 4 / 17 / 13; 4 / 16 / 13.

### scientific-dataset

1. **Inspect one microscope image**

   Inspect one real microscope image chosen by Bart and locate a single cell to examine more closely.

   Why: Start with a visible example before deciding how to measure a cell.

2. **Measure the cell’s area**

   Apply a default brightness threshold to outline that cell in the same image and measure its area in pixels.

   Why: See what a threshold includes before trying to improve the measurement.

3. **Adjust the brightness threshold**

   Change the brightness threshold for that same cell and compare its new outline and area with the original result.

   Why: Judge how one choice affects the measurement on an example you already know.

Word counts (label / description / why): 4 / 17 / 12; 4 / 19 / 11; 4 / 19 / 13.

### software-project

1. **Run the editor’s sample note**

   Open the existing editor with its bundled sample note, ready to inspect the text without setting up the project yourself.

   Why: Start with something running before working out how its formatting should behave.

2. **Render the sample as Markdown**

   Render that same sample note as Markdown and check how its heading appears in the formatted result.

   Why: See one formatting case work before experimenting with the rules behind it.

3. **Test a different heading level**

   Change the heading level in that same note and check how its appearance changes in the formatted result.

   Why: Connect one edit to its effect before trying other formatting behaviors.

Word counts (label / description / why): 5 / 20 / 12; 5 / 17 / 12; 5 / 18 / 11.

## Files changed in this style pass

- api/_lib/onboarding-prompts.js — style paragraph and output example in runtime/template.
- engelbart/setup/test/prompts.js — matching browser task and template.
- engelbart/setup/test/sim-backend.js — Subgoals prompt summary only.
- engelbart/setup/test/fixture.js — concise initial/revised Subgoals; no Todos edits in this pass.
- tests/subgoals-footholds.test.js — style contract checks for initial/revision calls and synchronized overrides.
- tests/fixtures/subgoals/cases.json — names TutorTrace in the existing coding-session case and adds Student Struggle Pattern Explorer alongside the original Stuck Moment Detector regression.
- tests/fixtures/subgoals/style-examples.json — authored examples from three domains.
- tests/subgoals-style.test.js — fixture verb starts, length/sentence checks, product-language flags, negative examples, and semantic rubric coverage.
- scripts/lib/subgoals-style.cjs — evaluation-only measurements and semantic style criteria.
- scripts/eval-subgoals.cjs — evaluates actual generated output against those measurements and criteria, retaining all scope criteria.
- docs/subgoals-style-review.md — this review.

## Validation

Focused tests: 123 passed, 0 failed. Covers prompt/model, initial/revision paths, custom overrides, normalization, orchestration, simulator/debugger, and new style cases.

Full npm test: 393 passed, 0 failed with loopback binding allowed. The initial sandbox run passed 390 and hit three existing telemetry-test listen EPERM errors on 127.0.0.1. Syntax checks for the changed runtime/simulator/evaluator JavaScript and git diff --check also passed.

Live evaluation: attempted; stopped before any calls because credentials are still absent. Run with the existing supported environment credentials:

```sh
node scripts/eval-subgoals.cjs /private/tmp/subgoals-evaluation.json
```

The evaluator checks all labels for an active verb **in grammatical context**, without a production verb whitelist. It records word counts, sentence counts, product-language flags, generated outputs, and evidence for each semantic criterion. These representative evaluation cases are expected to stay within the usual word ranges; production does not forcibly truncate text to a word count. Product-language flags are advisory because the prompt permits task-essential UI language; the semantic judge assesses that exception.

Offline tests check authored examples, not live model quality. Their verb vocabulary is fixture-only and is not an exhaustive language parser. Naturalness and the same-example progression still require semantic evaluation and human review.

## Remaining product-spec language

The revised authored examples and simulator fixtures do not use the listed product-spec constructions or enumerate controls. The software example necessarily mentions rendering and formatted output, but describes the work the person is doing. The revised drift example's “default alignment check” remains somewhat technical; it is short and names the operation being investigated.

Whether actual Sonnet outputs still sound like product specifications remains unverified without live credentials. Custom prompt overrides can still replace these instructions, and cached Subgoals require revision/regeneration to receive new wording. No commit, merge, cross-repository round trip, or cross-platform merge gate was performed.

## Full current prompt for TutorTrace

```text
# Who you are writing for

Education.
Explanations in everyday language. Write for somebody who has not programmed. Prefer the everyday word to the technical one; where a technical word is unavoidable, say what it means in the same sentence -- once, plainly. Name what a thing does rather than what it is called, and never use an acronym they did not use first.

They are building on "Coding session replay" -- Recorded coding events reveal how students work.
The direction: "Student Struggle Pattern Explorer" -- Explore struggle patterns in real TutorTrace coding sessions.
Built on:
{"title":"TutorTrace coding event logs","type":"dataset","description":"Real timestamped edit and run events, grouped by session. The reader has never used these logs."}





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

Write like a student/researcher project plan or a researcher's notebook, not a product specification. Every label begins with an active verb (hard constraint); labels are usually 3–8 words and name what the person is trying to accomplish. Use direct action language such as Inspect, Apply, Highlight, Compare, Test, Adjust, Measure, Reproduce, Explore, Verify, or Visualize; these are examples, not a restricted vocabulary. An action means working with the artifact, not assigning prerequisite study or setup to the human.
Descriptions are one concise sentence, usually 15–30 words. Answer: What will I be able to see, do, test, compare, or understand after this? Describe the capability/result, not the UI implementation. Do not enumerate controls/components, panels, filters, dropdowns, or columns unless essential to the research task. Avoid product-spec phrasing such as 'A panel displays', 'The interface allows', 'The window shows', 'Checkboxes let', 'A ranked list appears', 'The system provides', or 'Users can', unless the UI control itself is central to the research question.
The why is one short sentence, usually 10–25 words, explaining why this is the next foothold; do not repeat the description.
Keep the same concrete example across the first three subgoals whenever possible: inspect it, apply one idea to it, then manipulate one meaningful variable. Do not automatically expand from one example to many examples or a whole cohort; generalization can happen later.
Before returning, silently ask: Could this plausibly be written in a researcher's notebook as tomorrow's goal? If not, rewrite it more naturally. Verify every label starts with an active verb and each description and why is a concise single sentence, while preserving the scope constraints above.
Write at the register above.

Return ONLY valid JSON with nothing outside it.
{"subgoals": [{"label": "active verb first, usually 3-8 words", "description": "one concise sentence, usually 15-30 words", "why": "one short sentence, usually 10-25 words"}, {}, {}]}
```
