# Resources: the hunt and the fitting

Source of truth: `api/_lib/onboarding-prompts.js` (`assetsPrompt`, `levelPrompt`, and the `readerBlock` / `assessmentBlock` helpers they share). Readable copy for editing; the code is what runs. Edit here and I will port it, or edit the code.

## 1. The hunt (`assetsPrompt`)

**When:** fired the moment the paper is accepted at step 5, alongside the diagnostic; the reader never waits for it.  
**Call** (`onboarding-model.js`, `assets`): Sonnet, with the server-side `web_search_20250305` tool, `max_uses: 12`; falls back to a call without the tool if the gateway refuses it (the result then carries `searched: false`). Content blocks: `PAPER_PREFIX` + the PDF as a cached document block, then this prompt. No reader information: the hunt is in the paper's register on purpose.  
**After:** `normalizeAssets` bounds every field (description <= 900 chars, at most 12 assets, up to 6 links each, `type` snapped to the list), then the server HEAD-checks every link (5 s each, at most 40) and drops any that answers 404 or 410. A projection `{title, one_liner, type}` is stored as `assets_brief` and is what the brainstorm sees.

```text
Read the paper above and identify the concrete inputs and outputs of the work: the things it rests on or produces that a person could get hold of and manipulate digitally, or at least extend. Look specifically for: datasets; tasks and apparatus; codebooks; experimental paradigms; mathematical and computational models; simulations; analysis pipelines; surveys, instruments and coding schemes; domain-specific libraries; source code; trained models; live demos. Prefer things that exist as files, repositories, services or well-specified procedures over ideas. Where the paper's own artifact is unavailable, a standard public equivalent of the same thing (the dataset it was trained on, the library it wraps) counts, and say that it is one.

For each one, hunt down where it actually lives. Search the web aggressively: project pages, GitHub, Hugging Face, Zenodo, OSF, Dataverse, lab pages, package registries, the paper's own references and supplementary material. Prefer the canonical home over a mirror. Give up to six links per asset, each with its kind. When nothing can be found, say so with availability "unavailable" rather than inventing a URL; a plausible-looking link that does not exist is worse than none.

For each asset write:
- title: a short name
- description: a short paragraph, two to four sentences, saying what it is and how the work uses it. Use the paper's and the field's own terms; do not simplify.
- one_liner: one plain sentence naming what it is, for a brainstorming prompt
- type: one of "dataset" | "task" | "codebook" | "paradigm" | "model" | "simulation" | "pipeline" | "survey" | "library" | "code" | "demo" | "other"
- links: [{"kind": "live_demo" | "source_code" | "download" | "docs" | "paper" | "other", "url": "https://..."}]
- what_you_can_do_with_it: one sentence on what a person could do with it: run, query, extend, re-analyse, modify
- availability: "usable" | "partial" | "unavailable" | "unknown"

Order by how central each is to the paper's contribution. At most 12.

Return ONLY valid JSON with nothing outside it.
{"assets": [{"title": "", "description": "", "one_liner": "", "type": "", "links": [{"kind": "", "url": ""}], "what_you_can_do_with_it": "", "availability": ""}]}
```

## 2. Fitting the list to the reader (`levelPrompt`)

**When:** fired when the last topic question is answered (`topics_done` compiles the assessment first, no model call). If the hunt is still running it answers `waiting` and the brainstorm asks again every 6 s.  
**Call** (`levelAssets`): Sonnet, web search with `max_uses: 8`, same fallback. One text block: the prompt below.  
**After:** `normalizeLeveled` keeps `locus`, `sticky`, every asset with up to three `children` (each with a `why`). The page shows the assets and children as rows; a child is marked "at your level" and shows its `why`. (The `locus` line and `sticky` pills were removed from the page today; both are still produced and still feed the direction prompt.)

### The two blocks it opens with

`readerBlock` (empty when nothing is known):

```text
# Who you are writing for

{name}, {year} studying {major}.
Explanations {depth phrase}. {depth rule -- one of the four Explanations stops' rules}

What they already know, graded from short answers they gave:
- {area}: {phrase} ({level}) -- {level description}
- ...
Start explanations where these levels say to, not lower and not higher.
```

`assessmentBlock`:

```text
How they did on the topic questions (graded against sample answers; the grade, not their self-rating, is the evidence):
- {area}: rated themselves {self phrase}; graded {graded phrase} ({level}) -- {grader's rationale}. They wrote: "{their last answer, first 240 chars}"
- ...
```

### The prompt

```text
{READER_BLOCK}
{ASSESSMENT_BLOCK}

{INTEREST: "What they seem drawn to so far: \"...\"" when the brainstorm has said so, else "They have not said what they want to make yet."}

Below are the concrete things the paper rests on or produces, written in the paper's own register.
{ASSETS_JSON: the hunt's full list, one JSON object}

First decide where the locus of problem solving would lie for this reader in a first project on this paper, and which knowledge is sticky -- the part they must actually hold in their head to make decisions -- versus the part an AI coding assistant will carry for them (they need to know what a library does and what it returns, not its syntax). Someone representing dance poses for math education needs geometry and a working notion of what pose detection returns, not computer vision.
Then, for each asset, judge from the grades above whether this reader can pick it up as it is. Where they cannot, add up to three `children`: simpler, standard, well-documented stand-ins at their level that teach the same idea or skill -- a toy dataset before the real one (MNIST before a custom image corpus), a hosted demo before the library, a notebook before the codebase, a spreadsheet before the pipeline. Search the web for real ones. Each child has the same shape as an asset plus a `why`: one sentence, to the reader, on why this is the right on-ramp for them, naming the sticky idea it teaches. Do not invent links.
Finally rewrite every asset's `description`, `one_liner` and `what_you_can_do_with_it` at the reader's register (the rule at the top). Keep every original asset, its `title`, `type` and `links`.

Return ONLY valid JSON with nothing outside it.
{"locus": "one sentence: where the problem solving lies for this reader", "sticky": ["the two to five ideas they must hold themselves"], "assets": [{"title": "", "description": "", "one_liner": "", "type": "", "links": [], "what_you_can_do_with_it": "", "availability": "", "children": [{"title": "", "description": "", "one_liner": "", "type": "", "links": [], "what_you_can_do_with_it": "", "availability": "", "why": ""}]}]}
```

## Shapes the page depends on

- Asset: `title, description, one_liner, type, links[{kind,url}], what_you_can_do_with_it, availability`. `type` in dataset | task | codebook | paradigm | model | simulation | pipeline | survey | library | code | demo | other. `availability` in usable | partial | unavailable | unknown.
- Child: an asset plus `why`. At most three per asset.
- The brainstorm is given only `{title, one_liner, type}` per asset, so the `one_liner` is the sentence that has to carry the hunt into the conversation.
- The direction prompt is given the chosen asset (or child) in full, plus `locus` and `sticky`.
