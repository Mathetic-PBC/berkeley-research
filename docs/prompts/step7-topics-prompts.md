# Step 7 (Topics): the prompts behind the questions

Source of truth: `api/_lib/onboarding-prompts.js` (`analyzePrompt`, `gradePrompt`). This file is a readable copy for editing the questions; the code is what runs. Edit the prompt in the code, or edit here and I will port it.

## How the call is assembled (`api/_lib/onboarding-model.js`, `analyze`)

One Sonnet call, fired when the paper is accepted at step 5. Content blocks, in order:

1. `PAPER_PREFIX` text and the paper PDF as a document block with `cache_control` (shared with the asset hunt).
2. The `before` text below, then the literal `(the paper attached above)` where the paper would sit, then the `after` text with `%URLS%` replaced by the fetched project/repo page text (or `(none supplied)`).

Interpolations: `{FAMILIARITY_LABEL} -- {FAMILIARITY_DESC}` is the Paper step's familiarity slider stop (five stops: "I'm completely lost" … "I can extend it"); `{DEPTH_LABEL} -- {DEPTH_DESC}` is the Explanations step's stop (Everyday, Some detail, Technical, Expert).

The reply is normalized (`normalizeAnalysis`): 2 to 4 areas, exactly five questions per area at levels 0/25/50/75/100, each with a `sample_response` the grader uses. The page shows the question at the level the reader's slider sits on; the sample responses are never shown.

## `before`

```text
## Prompt
You are designing a very short prior-knowledge diagnostic for an undergraduate who wants to understand, extend, or contribute to an existing PhD student's research project.

Your goal is NOT to test broad academic knowledge. Identify the 2–4 pieces of prior knowledge that would most change how another LLM should explain the project, introduce prerequisites and terminology, decompose extensions, discuss implementation and experiments, and help the student reason productively about the work.

## Inputs

The student's self-reported familiarity with this kind of work is:
{FAMILIARITY_LABEL} -- {FAMILIARITY_DESC}

The student prefers:
{DEPTH_LABEL} -- {DEPTH_DESC}

<phd_student_paper>
```

## `after`

```text

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

Do not invent a date. Use `null` if none can be determined.

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

Questions are about the AREA -- the field and the concepts you selected -- never about this paper. Do not ask the student to recall, summarise, or review anything specific to the paper: its method, results, figures, terminology, or claims. The student may not have read it. A 75- or 100-level question may use domain-specific language that is similar to what a PhD student or professor would use and could be plausibly understood by an advanced and well-versed undergraduate student. This does not mean the questions need to be longer as the level increases, though.

Vocabulary rises one step per level. Level 0 uses no jargon at all: an undergraduate from any field must be able to read the question and say something in reply. Level 25 may name the one or two most common terms of the area, in plain words. Levels 50 and above may use the area's own terms, but keep in mind that the amount of concepts should primarily be based on the level.

The student's chosen technical depth (above) governs every computing or programming term in every question: at "Everyday", avoid the term or explain it inside the question; at "Some detail", ordinary terms (file, function, server, dataset) stand alone and narrower ones get a few words; at "Technical" and "Expert", precise terms stand alone.

Levels should progress from CONCEPTUAL FAMILIARITY to APPLIED REASONING:

- 0 — RECOGNITION: Does the student know what the area is about and recognize its basic concepts? Surface unknown unknowns.

- 25 — BASIC UNDERSTANDING: Can they follow the main concepts when explained or contextualized?

- 50 — INDEPENDENT UNDERSTANDING: Can they explain important concepts and relationships in their own words?

- 75 — APPLICATION: Can they use that understanding to solve a new problem, predict an outcome, or make a project-relevant decision?

- 100 — REASONING: Can they diagnose failures, compare approaches, evaluate tradeoffs, or explain when an approach would or would not work?

Levels 0–50 primarily measure familiarity and understanding; 75–100 measure productive reasoning with that knowledge. However, the goal for all of this is to gauge the student's familiarity with this specific content, NOT their general problem solving ability or aptitude.

Difficulty should come from deeper understanding and reasoning, not obscure terminology, trivia, tedious mathematics, or memorization.

75- and 100-level questions should be described using the paper's specific terms (since the student claims to be an expert). Lower levels may be more direct when needed to determine whether the student possesses the relevant concepts.

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

- date is source-supported or `null`;

- exactly 2–4 areas;

- area granularity reflects project requirements, student familiarity, and desired depth;

- no substantial redundancy;

- exactly five questions per area;

- 0–50 show progressively stronger familiarity and understanding;

- no question depends on having read the paper, and level 0 has no jargon;

- 75 requires genuine knowledge of the domain and application;
- 100 requires evaluation, comparison, diagnosis, or adaptation;

- samples reflect the intended capability;

- output is valid JSON with nothing outside it.
```

## Grading one answer (`gradePrompt`, Haiku, 300 tokens)

Runs when the reader submits an answer. `{LEVEL}` is the level of the question asked; `{SAMPLE_RESPONSE}` is that question's sample from the analysis above.

```text
A student answered one short calibration question about "{AREA}". Estimate which capability level the answer demonstrates.

The levels:
{LADDER: the five levels, one per line, "level -- label: desc"}

The question was written for level {LEVEL}. A sample answer at that level:
"""
{SAMPLE_RESPONSE}
"""

The student's answer:
"""
{STUDENT_ANSWER}
"""

Judge the answer's substance, not its length or polish. An answer that shows the target level's capability scores {LEVEL}; one that shows less scores the highest level it does show; one that shows more (correct application, comparison, diagnosis beyond what was asked) may score higher. An answer that is empty, evasive, or wrong scores 0.

Return ONLY valid JSON with nothing outside it.
{"level": 0 | 25 | 50 | 75 | 100, "confidence": 0.0-1.0, "rationale": "one sentence, at most 200 characters"}
```

## What happens with the grade

- The grade is stored on the calibration row and never shown.
- When the graded level differs from the self-rated level by a full stop or more, and this was the area's first question, one follow-up is asked at the graded level. Two questions per area is the cap.
- The follow-up prompt (`followUpPrompt`, Sonnet) takes the area, the question, the reader's answer, the self-rating and the graded level, and writes ONE new question at the graded level that builds on what the reader actually said, plus a sample response for grading. It is stored unanswered on the calibration row; the ladder's question at that level stands in when the writing fails.
