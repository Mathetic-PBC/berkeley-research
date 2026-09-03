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

Questions are about the AREA -- the field and the concepts you selected -- never about this paper. Do not ask the student to recall, summarise, or review anything specific to the paper: its method, results, figures, terminology, or claims. The student may not have read it. A 75- or 100-level question may describe a realistic situation of the kind this project involves, but it must be answerable by someone who knows the area and has never seen the paper.

Vocabulary rises one step per level. Level 0 uses no jargon at all: an undergraduate from any field must be able to read the question and say something in reply. Level 25 may name the one or two most common terms of the area, in plain words. Levels 50 and above may use the area's own terms.

The student's chosen technical depth (above) governs every computing or programming term in every question: at "Everyday", avoid the term or explain it inside the question; at "Some detail", ordinary terms (file, function, server, dataset) stand alone and narrower ones get a few words; at "Technical" and "Expert", precise terms stand alone.

Levels should progress from CONCEPTUAL FAMILIARITY to APPLIED REASONING:

- 0 — RECOGNITION: Does the student know what the area is about and recognize its basic concepts? Surface unknown unknowns.

- 25 — BASIC UNDERSTANDING: Can they follow the main concepts when explained or contextualized?

- 50 — INDEPENDENT UNDERSTANDING: Can they explain important concepts and relationships in their own words?

- 75 — APPLICATION: Can they use that understanding to solve a new problem, predict an outcome, or make a project-relevant decision?

- 100 — REASONING: Can they diagnose failures, compare approaches, evaluate tradeoffs, or explain when an approach would or would not work?

Levels 0–50 primarily measure familiarity and understanding; 75–100 measure productive reasoning with that knowledge.

Difficulty should come from deeper understanding and reasoning, not obscure terminology, trivia, tedious mathematics, or memorization.

Whenever possible, ground 75- and 100-level questions in realistic situations of the KIND this project involves, described in the area's general terms rather than the paper's specifics. Lower levels may be more direct when needed to determine whether the student possesses the relevant concepts.

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

- no question depends on having read the paper, and level 0 has no jargon;

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

// The one follow-up in an area, written from what the reader actually said.
// Inputs: reader (for readerBlock), area, parent_field, question (the ladder
// question they answered), level (its level), self_level, answer (theirs),
// graded_level (where the grader placed them), graded_rationale, sample (the
// answered question's sample response).
function followUpPrompt({ reader, area, parent_field, question, level, self_level, answer, graded_level, graded_rationale, sample }) {
  const at = rung(graded_level), was = rung(level), self = rung(self_level);
  const ladder = LADDER.map((r) => `${r.level} -- ${r.label}: ${r.desc}`).join("\n");
  return [
    ...readerBlock(reader), "",
    `A student is being calibrated on "${area}"${parent_field ? ` (${parent_field})` : ""}. They rated themselves "${self ? self.label : self_level}" (${self_level}) and were asked the level-${level} question:`,
    `"""`, question, `"""`,
    "A sample answer at that level:",
    `"""`, sample || "(none)", `"""`,
    "They answered:",
    `"""`, answer, `"""`,
    `The grader placed the answer at ${graded_level} -- ${at ? at.label : ""}${graded_rationale ? `: ${graded_rationale}` : "."}`,
    "",
    "The levels:", ladder, "",
    `Write ONE follow-up question at level ${graded_level} that builds on what they actually said. Use their own words and examples where they gave any: probe the specific gap their answer showed if they were placed lower than they rated themselves, or the specific strength if they were placed higher. It must be a new question, not the ladder's question at that level and not a rephrasing of the one they answered; it must be about the AREA, never about the paper; and it should be answerable in one to three sentences by someone at level ${graded_level}${at ? ` (${at.desc.toLowerCase()})` : ""}.`,
    "Vocabulary follows the level: at 0 no jargon at all; at 25 only the one or two most common terms of the area, in plain words; from 50 up the area's own terms. The reader's technical depth above governs every computing term.",
    "Also write a sample response that shows what a correct answer at that level looks like; it is used only to grade them and is never shown.",
    "",
    JSON_ONLY,
    '{"question": "the follow-up question", "sample_response": "a level-' + graded_level + ' answer, one to three sentences"}',
  ].join("\n");
}

// The project-scoping questions of the Details step. Inputs: reader (for
// readerBlock), paper {title, one_liner}, draft, registerNote (a sentence
// saying the register was shifted, or "").
function detailsPrompt({ reader, paper, draft, registerNote, resources }) {
  return [
    ...readerBlock(reader), ...resourcesBlock(resources), "",
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
function goalsPrompt({ reader, paper, draft, details, resources }) {
  const answered = (details && Array.isArray(details.questions) ? details.questions : [])
    .map((q) => {
      const a = details.answers ? details.answers[q.id] : null;
      if (a == null || a === "") return "";
      return `- ${q.title} ${Array.isArray(a) ? a.join("; ") : a}`;
    }).filter(Boolean);
  return [
    ...readerBlock(reader), ...resourcesBlock(resources), "",
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

// The rows for the FIRST subgoal of the direction, and a name for the
// project. Inputs: reader, paper {title, one_liner}, direction, subgoal,
// resources (the leveled assets, for resourcesBlock).
function todosPrompt({ reader, paper, direction, subgoal, resources }) {
  const d = direction || {};
  const sg = subgoal || {};
  return [
    ...readerBlock(reader), ...resourcesBlock(resources), "",
    `They are building on "${paper.title}" -- ${paper.one_liner}`,
    `The direction: "${d.title}" -- ${d.what_you_would_make || ""}`,
    `The first piece of it, the one to start on now: "${sg.label}"${sg.description ? " -- " + sg.description : ""}`,
    "",
    "Write the TODO rows for that first piece only. Two to four rows, in the imperative, each one thing a coding agent working with them could pick up and finish -- concrete, checkable, small enough for a session. The first row must produce something they can see or run. Where a resource above is the right starting point, name it in the row. Do not write rows for the other pieces.",
    "Also propose a short project name: two to four lowercase words joined by hyphens.",
    "Write at the register above.",
    "",
    JSON_ONLY,
    '{"todos": ["row", "row"], "name": "short-hyphenated-name"}',
  ].join("\n");
}

// "Ask about this": a question about text the reader selected. Inputs:
// reader (with depth set to the register asked for), paper, quote, question.
function askPrompt({ reader, paper, quote, question, resources }) {
  return [
    ...readerBlock(reader), ...resourcesBlock(resources), "",
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

// The paper as a shared, cacheable prefix. Both calls that read the whole
// paper -- the diagnostic and the asset hunt -- begin with these same two
// blocks, so the second pays for the cached tokens rather than the paper.
const PAPER_PREFIX = "The PhD student's paper follows as an attached document. Every prompt below refers to it as \"the paper\".";

const ASSET_TYPES = ["dataset", "task", "codebook", "paradigm", "model", "simulation", "pipeline", "survey", "library", "code", "demo", "other"];

// What the work rests on or produces that a person could get hold of. In the
// paper's own register: this is NOT shown to a student as it is (levelPrompt
// re-cuts it), so it should use the field's terms. Inputs: none beyond the
// paper, which the caller supplies as the cached prefix.
function assetsPrompt() {
  return `Read the paper above and identify the concrete inputs and outputs of the work: the things it rests on or produces that a person could get hold of and manipulate digitally, or at least extend. Look specifically for: datasets; tasks and apparatus; codebooks; experimental paradigms; mathematical and computational models; simulations; analysis pipelines; surveys, instruments and coding schemes; domain-specific libraries; source code; trained models; live demos. Prefer things that exist as files, repositories, services or well-specified procedures over ideas. Where the paper's own artifact is unavailable, a standard public equivalent of the same thing (the dataset it was trained on, the library it wraps) counts, and say that it is one.

For each one, hunt down where it actually lives. Search the web aggressively: project pages, GitHub, Hugging Face, Zenodo, OSF, Dataverse, lab pages, package registries, the paper's own references and supplementary material. Prefer the canonical home over a mirror. Give up to six links per asset, each with its kind. When nothing can be found, say so with availability "unavailable" rather than inventing a URL; a plausible-looking link that does not exist is worse than none.

For each asset write:
- title: a short name
- description: a short paragraph, two to four sentences, saying what it is and how the work uses it. Use the paper's and the field's own terms; do not simplify.
- one_liner: one plain sentence naming what it is, for a brainstorming prompt
- type: one of ${ASSET_TYPES.map((t) => `"${t}"`).join(" | ")}
- links: [{"kind": "live_demo" | "source_code" | "download" | "docs" | "paper" | "other", "url": "https://..."}]
- what_you_can_do_with_it: one sentence on what a person could do with it: run, query, extend, re-analyse, modify
- availability: "usable" | "partial" | "unavailable" | "unknown"

Order by how central each is to the paper's contribution. At most 12.

${JSON_ONLY}
{"assets": [{"title": "", "description": "", "one_liner": "", "type": "", "links": [{"kind": "", "url": ""}], "what_you_can_do_with_it": "", "availability": ""}]}`;
}

// What the topic questions found, as a block. assessment = {areas:[{area,
// self_level, graded_level, rationale, answers:[...]}], mean, depth}.
function assessmentBlock(assessment) {
  const a = assessment && typeof assessment === "object" ? assessment : null;
  const areas = a && Array.isArray(a.areas) ? a.areas : [];
  if (!areas.length) return [];
  const out = ["", "How they did on the topic questions (graded against sample answers; the grade, not their self-rating, is the evidence):"];
  for (const x of areas) {
    const r = rung(x.graded_level != null ? x.graded_level : x.self_level);
    const said = Array.isArray(x.answers) && x.answers.length ? ` They wrote: "${String(x.answers[x.answers.length - 1]).slice(0, 240)}"` : "";
    out.push(`- ${x.area}: rated themselves ${rung(x.self_level) ? rung(x.self_level).phrase : "?"}; graded ${r ? r.phrase + " (" + r.level + ")" : "ungraded"}${x.rationale ? " -- " + x.rationale : ""}.${said}`);
  }
  return out;
}

// The assets, re-cut for one reader. Inputs: reader (with graded knowledge),
// assessment, assets (the raw list). The lens: level is set by the sticky
// information and where the locus of problem solving lies for THIS reader,
// not by the paper's field in general.
function levelPrompt({ reader, assessment, assets, interest }) {
  return [
    ...readerBlock(reader), ...assessmentBlock(assessment), "",
    interest ? `What they seem drawn to so far: "${interest}"` : "They have not said what they want to make yet.",
    "",
    "Below are the concrete things the paper rests on or produces, written in the paper's own register.",
    JSON.stringify({ assets }, null, 0),
    "",
    "First decide where the locus of problem solving would lie for this reader in a first project on this paper, and which knowledge is sticky -- the part they must actually hold in their head to make decisions -- versus the part an AI coding assistant will carry for them (they need to know what a library does and what it returns, not its syntax). Someone representing dance poses for math education needs geometry and a working notion of what pose detection returns, not computer vision.",
    "Then, for each asset, judge from the grades above whether this reader can pick it up as it is. Where they cannot, add up to three `children`: simpler, standard, well-documented stand-ins at their level that teach the same idea or skill -- a toy dataset before the real one (MNIST before a custom image corpus), a hosted demo before the library, a notebook before the codebase, a spreadsheet before the pipeline. Search the web for real ones. Each child has the same shape as an asset plus a `why`: one sentence, to the reader, on why this is the right on-ramp for them, naming the sticky idea it teaches. Do not invent links.",
    "Finally rewrite every asset's `description`, `one_liner` and `what_you_can_do_with_it` at the reader's register (the rule at the top). Keep every original asset, its `title`, `type` and `links`.",
    "",
    JSON_ONLY,
    '{"locus": "one sentence: where the problem solving lies for this reader", "sticky": ["the two to five ideas they must hold themselves"], "assets": [{"title": "", "description": "", "one_liner": "", "type": "", "links": [], "what_you_can_do_with_it": "", "availability": "", "children": [{"title": "", "description": "", "one_liner": "", "type": "", "links": [], "what_you_can_do_with_it": "", "availability": "", "why": ""}]}]}',
  ].join("\n");
}

// The brainstorm's mini list: what the paper rests on, one line each.
function briefBlock(brief) {
  const list = Array.isArray(brief) ? brief : [];
  if (!list.length) return [];
  return ["", "The concrete things the paper rests on or produces (a separate search is finding where each lives; do not promise links):",
    ...list.map((b) => `- ${b.title} (${b.type}): ${b.one_liner || ""}`)];
}

function transcriptBlock(turns, cap = 24) {
  const list = (Array.isArray(turns) ? turns : []).slice(-cap);
  if (!list.length) return [];
  return ["", "The conversation so far:", ...list.map((t) => `${t.role === "user" ? "They" : "You"}: ${String(t.content || "").slice(0, 1200)}`)];
}

// One brainstorm turn. Engelbart's brainstorm card grammar (questions,
// focus, none), pointed at extending this paper. Inputs: reader, paper,
// assessment, brief (assets_brief), turns (the transcript so far, the
// reader's latest turn last), leveledReady (whether the plan can start).
function brainstormPrompt({ reader, paper, assessment, brief, turns }) {
  return [
    ...readerBlock(reader), ...assessmentBlock(assessment), "",
    `They are about to start a first project that builds on "${paper.title}" -- ${paper.one_liner}`,
    ...briefBlock(brief),
    ...transcriptBlock(turns),
    "",
    "You are brainstorming with them about what to build. Many people arrive with a vague sense -- something between computer science and education, electrical engineering and music -- and some with a narrow one. Your job is to find, with them, the piece of this paper worth extending or reproducing in a small first project that would hold their attention, and to learn what they already know along the way. Ask about their familiarity with the things above, follow up on what they say, explore sideways, and reflect back what you hear. Use the graded levels above: do not ask what the grades already answered.",
    "",
    "Reply with ONE JSON object and nothing else:",
    '{"say": "<what you say to them, plain prose, two to five sentences>",',
    ' "card": "questions" | "focus" | "none",',
    ' "questions": {"eyebrow": "<two or three words>", "items": [{"id": "<short slug>", "type": "mcq" | "select_all" | "free" | "open", "title": "<the question>", "subtitle": "<optional>", "options": [{"label": "<the choice>", "why": "<optional: what it buys them>"}], "placeholder": "<for free and open>"}]},',
    ' "focus": {"title": "<what you are asking them to choose between>", "options": [{"label": "<one reading of what they could build>", "why": "<why this one>"}]},',
    ' "interest": "<one sentence: what they seem drawn to so far, in the third person; empty if you cannot tell yet>"}',
    "",
    "Only the key for the card you name is read. `questions` is for one to three questions whose answers change what you would suggest -- mcq (one answer), select_all (say so in the subtitle), free (one line), open (a paragraph); never questions you could assume the answer to. `focus` is for when what they want could be read two or three ways and which one decides everything after it; two to four options with a why each. `none` is for a turn that only needs prose. Do not propose goals, todos, or a plan; that comes later. Keep `say` short. Write at the register above.",
  ].join("\n");
}

// A question about one asset. Inputs: reader, paper, asset (the leveled
// entry, with children if any), thread (prior turns on this asset), question.
function assetAskPrompt({ reader, paper, asset, thread, question }) {
  return [
    ...readerBlock(reader), "",
    `Context: they are choosing what to build on from "${paper.title}" -- ${paper.one_liner}`,
    "The thing they are asking about:",
    JSON.stringify(asset, null, 0),
    ...transcriptBlock(thread, 12),
    "",
    `They ask: "${question}"`,
    "",
    "Answer in two to five sentences at the register above. Be concrete: what they would actually change first, how long it takes to get running, why it is in the paper, what it would teach them. Refer to the links above by kind when they matter; do not invent others.",
    "",
    JSON_ONLY,
    '{"answer": "..."}',
  ].join("\n");
}

// One direction, or a revision of it. Inputs: reader, paper, interest,
// assessment, turns (the brainstorm, condensed by cap), asset (the one they
// picked), leveled ({locus, sticky}), previous (the direction being revised,
// or null), feedback (their change request, or "").
function directionPrompt({ reader, paper, interest, assessment, turns, asset, leveled, previous, feedback }) {
  const lv = leveled || {};
  return [
    ...readerBlock(reader), ...assessmentBlock(assessment), "",
    `They are starting a first project that builds on "${paper.title}" -- ${paper.one_liner}`,
    interest ? `What they are drawn to: "${interest}"` : "",
    lv.locus ? `Where the problem solving lies for them: ${lv.locus}` : "",
    Array.isArray(lv.sticky) && lv.sticky.length ? `What they must hold in their head: ${lv.sticky.join("; ")}` : "",
    "The thing they chose to build on:",
    JSON.stringify(asset || {}, null, 0),
    ...transcriptBlock(turns, 16),
    previous ? "" : "",
    previous ? "The direction you proposed before:" : "",
    previous ? JSON.stringify(previous, null, 0) : "",
    feedback ? `What they want changed: "${feedback}"` : "",
    "",
    previous
      ? "Revise the direction to do what they asked. Keep what they did not object to."
      : "Choose ONE direction for their first project. Not three to pick from: the one that best fits everything above. It must be something they could build, run, or modify within a couple of weeks with an AI coding assistant, using the thing they chose; it must produce something they can see or play with early -- attention first, usefulness to the PhD student second; and it must sit where the problem solving lies for THEM, not in the part a library or the assistant will carry.",
    "Write at the register above.",
    "",
    JSON_ONLY,
    '{"title": "2-6 words", "what_you_would_make": "two or three sentences, to them", "uses": ["what it uses, by title"], "why_it_fits": "one or two sentences: why this one, for them, given what they said and how they did", "first_visible_result": "one sentence: the first thing they would see working"}',
  ].join("\n");
}

// Three subgoals for the direction, or a revision. Inputs: reader, paper,
// direction, asset, leveled, previous (the subgoals being revised, or null),
// feedback.
function subgoalsPrompt({ reader, paper, direction, asset, leveled, previous, feedback }) {
  const lv = leveled || {};
  const d = direction || {};
  return [
    ...readerBlock(reader), "",
    `They are building on "${paper.title}" -- ${paper.one_liner}`,
    `The direction: "${d.title}" -- ${d.what_you_would_make || ""}${d.first_visible_result ? " First visible result: " + d.first_visible_result : ""}`,
    "Built on:",
    JSON.stringify(asset || {}, null, 0),
    lv.locus ? `Where the problem solving lies for them: ${lv.locus}` : "",
    previous ? "The subgoals you proposed before:" : "",
    previous ? JSON.stringify(previous, null, 0) : "",
    feedback ? `What they want changed: "${feedback}"` : "",
    "",
    previous
      ? "Revise the three subgoals to do what they asked. Keep what they did not object to."
      : "Break the direction into exactly three subgoals, in order. Each is an outcome someone could tell you they had reached, not a phase or a heading. The first must be the smallest thing that produces the first visible result; the second builds the substance; the third reaches toward the paper's actual contribution or their own twist. Each carries a description (two sentences, what done looks like) and a why (one sentence, why it comes where it does).",
    "Write at the register above.",
    "",
    JSON_ONLY,
    '{"subgoals": [{"label": "an outcome, 3-10 words", "description": "two sentences", "why": "one sentence"}, {}, {}]}',
  ].join("\n");
}

// The resources a reader has at hand, appended to every user-facing prompt
// once they exist. Empty when there are none.
function resourcesBlock(resources) {
  const list = Array.isArray(resources) ? resources : [];
  if (!list.length) return [];
  const out = ["", "Resources at hand (from the paper; children are stand-ins at their level):"];
  for (const r of list) {
    const link = Array.isArray(r.links) && r.links[0] ? ` <${r.links[0].url}>` : "";
    out.push(`- ${r.title} (${r.type}): ${r.what_you_can_do_with_it || r.one_liner || r.description || ""}${link}`);
    for (const c of Array.isArray(r.children) ? r.children : []) {
      const clink = Array.isArray(c.links) && c.links[0] ? ` <${c.links[0].url}>` : "";
      out.push(`  - start with ${c.title} (${c.type}): ${c.what_you_can_do_with_it || c.one_liner || c.description || ""}${clink}`);
    }
  }
  return out;
}

module.exports = {
  DEPTHS, FAMILIARITY, LADDER, JSON_ONLY, ASSET_TYPES,
  depthOf, rung, readerBlock, assessmentBlock, briefBlock, transcriptBlock,
  analyzePrompt, gradePrompt, followUpPrompt, detailsPrompt, goalsPrompt, todosPrompt, askPrompt,
  PAPER_PREFIX, assetsPrompt, levelPrompt, brainstormPrompt, assetAskPrompt, directionPrompt, subgoalsPrompt, resourcesBlock,
};
