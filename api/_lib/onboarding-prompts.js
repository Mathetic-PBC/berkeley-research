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
