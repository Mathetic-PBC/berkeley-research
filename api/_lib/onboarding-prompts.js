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

- date is source-supported or \`null\`;

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
    "Offer exactly four goals a first project could be about. Each must name a concrete, testable capability they could tell you is working, not a topic, task, phase, aspiration, or decision they still need to make. A coding agent should know what to implement from the outcome alone.",
    "Order by implementation dependency, not by the order of the research story. The first goal must be the useful capability they can build now without waiting for the student to browse a dataset, choose an example, collect inputs, read background, or make another decision. Build the interface or pipeline that accepts the choice before asking the student to make that choice. For example, an outcome like \"A video can be uploaded and previewed\" comes before \"A study video is chosen.\" Favor a small runnable GUI as the first capability whenever the project can have an interactive surface.",
    "Each carries a short name (2-4 words) and one sentence on why it is worth starting there, written at the register above.",
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
    "Write the TODO rows for that first piece only. Two to four rows, in the imperative, each one thing a coding agent working with them could pick up and finish -- concrete, checkable, small enough for a session. Do not write research, planning, browsing, dataset-selection, or other human-decision rows; when a real input is not chosen yet, use a tiny bundled or synthetic fixture so implementation can begin now. Where a resource above is the right starting point, name it in the row. Do not write rows for the other pieces.",
    "Treat a GUI as the default first implementation, not later polish. Unless an interactive surface genuinely makes no sense for this direction, make the first row create or adapt a runnable GUI shell containing the project's key input control and a visible output or status region. Make the remaining rows wire the thinnest real input-to-output path and show its result in that GUI. The first round should end with something the student can operate immediately, not a static mock; reuse an existing demo or interface from the resources when one exists.",
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

// Rewriting what is on the screen at another register. Inputs: reader, from
// and to (DEPTHS keys), texts (the passages, in page order).
function rewritePrompt({ reader, from, to, texts }) {
  const was = depthOf(from), now = depthOf(to);
  const list = (Array.isArray(texts) ? texts : []).map((t, i) => `${i + 1}. ${String(t)}`).join("\n");
  return [
    ...readerBlock({ ...(reader || {}), depth: to }), "",
    `Below are ${texts.length} passages shown to the reader on one screen of a setup page. They were written ${was ? was.phrase : from}. The reader has asked for them ${now ? now.phrase : to}.`,
    now ? `The new register: ${now.rule}` : "",
    "",
    "Rewrite each passage at the new register. Keep what it says and roughly how long it is; a question stays a question, an option stays an option, a title stays a title. Keep every name, number, URL and quoted term as it is. Do not add, drop, merge or reorder passages. Where a passage is already at the new register, return it unchanged.",
    "",
    "The passages:",
    list,
    "",
    JSON_ONLY,
    `{"texts": [${texts.map(() => '"..."').join(", ")}]}  -- exactly ${texts.length} strings, in the same order`,
  ].filter((line) => line !== "").join("\n");
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

Every item must be a specific building block of THIS paper: something the authors made, collected, adapted, or depend on in a way particular to the work. Never list general-purpose tools or platforms the paper merely used -- a programming language, a general LLM or its API (ChatGPT, GPT-4o, Claude), a mainstream framework, a spreadsheet, a survey platform, a statistics package. If the paper's contribution is a way of using such a tool, the item is that way of using it (the prompt set, the pipeline, the evaluation harness), named as the authors name it, not the tool.

For each one, hunt down where it actually lives. Search the web aggressively: project pages, GitHub, Hugging Face, Zenodo, OSF, Dataverse, lab pages, package registries, the paper's own references and supplementary material. Prefer the canonical home over a mirror. Give up to six links per asset, each with its kind. When nothing can be found, say so with availability "unavailable" rather than inventing a URL; a plausible-looking link that does not exist is worse than none.

For each asset write:
- title: a short name
- description: a short paragraph, two to four sentences, saying what it is and how the work uses it. Use the paper's and the field's own terms; do not simplify.
- one_liner: one plain sentence naming what it is, for a brainstorming prompt
- type: one of ${ASSET_TYPES.map((t) => `"${t}"`).join(" | ")}
- links: [{"kind": "live_demo" | "source_code" | "download" | "docs" | "paper" | "other", "url": "https://..."}]
- what_you_can_do_with_it: one sentence on what a person could do with it: run, query, extend, re-analyse, modify
- availability: "usable" | "partial" | "unavailable" | "unknown"

Order by how central each is to the paper's contribution. At most five; fewer when the paper rests on fewer. Five specific things beat twelve that include the obvious.

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
    "They will build with Claude Code, an AI coding assistant that writes, runs and debugs the code with them. So the question for each asset is not whether they can program against it but whether they can direct the work on it: understand what it is, judge whether an output is right, and decide what to change. Code, a UI, a repository, a dataset with a clear schema are usually within reach whatever the grades say, because the assistant carries the syntax and the plumbing. What the assistant cannot carry is the sticky part: a mathematical model they cannot read, a simulation whose parameters mean nothing to them, a coding scheme that presumes theory they lack, an analysis whose validity they cannot judge.",
    "Then, for each asset, decide whether this reader can pick it up as it is, on that basis -- the domain of the asset and the grades above together, not the grades alone. Most assets need no stand-in; add `children` only when it is absolutely necessary: when the sticky part of an asset is one the grades show they do not have, so that even with the assistant they could not tell right from wrong. Then add one to three stand-ins that teach exactly that idea: simpler, standard, well-documented, and specific to the idea (a worked instance of the same model with two parameters before the paper's with twenty; a small labelled sample of the same kind of data before the corpus), never a generic tutorial, language course or tool. Search the web for real ones. Each child has the same shape as an asset plus a `why`: one sentence, to the reader, naming the sticky idea it teaches and why they need it before the paper's own. An HCI paper with a UI and a repository will usually get none; a paper resting on a complex mathematical simulation may need one for a reader graded low on that area. Do not invent links.",
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
// reader's latest turn last). Readiness is independent of resource fitting.
function brainstormPrompt(input) {
  return render("brainstormPrompt", input);
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
      : "Choose ONE direction for their first project. Not three to pick from: the one that best fits everything above. It must name a concrete capability they could build, run, or modify within a couple of weeks with an AI coding assistant, using the thing they chose; a coding agent should know what to implement next, and the start must not depend on the student first browsing a dataset, choosing an example, collecting inputs, reading background, or making another decision. Prefer a direction whose thinnest working version is an interactive GUI they can use immediately, not a backend hidden until later. It must produce something they can see or play with early -- attention first, usefulness to the PhD student second -- and it must sit where the problem solving lies for THEM, not in the part a library or the assistant will carry.",
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
    SUBGOALS_TASK,
    ...(previous ? ["Revise the three subgoals to address the feedback. Keep compatible work they did not object to, but shrink any inherited roadmap-sized subgoals to satisfy the foothold constraints above."] : []),
    "Write at the register above.",
    "",
    JSON_ONLY,
    '{"subgoals": [{"label": "active verb first, usually 3-8 words", "description": "one concise sentence, usually 15-30 words", "why": "one short sentence, usually 10-25 words"}, {}, {}]}',
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

// --- the same prompts as templates, for an environment that edits them --------------------------------
//
// The execution debugger (engelbart/setup/test/) shows every prompt above as a template with {{slots}}
// for the parts the server computes, lets a test environment edit the text, and can hand the edits to
// this server for the member's own run (`prompt_overrides` on an onboarding request). `render` fills a
// template the way the functions above build their strings; with no override it reproduces them byte
// for byte, which tests/onboarding-prompts.test.js holds it to, and the debugger's copy of TEMPLATES
// (engelbart/setup/test/prompts.js) is held equal to this one. Eleven prompts are editable; details,
// goals and the asset question are not offered and keep their functions.
const TEMPLATES = {
  analyzePrompt: "## Prompt\nYou are designing a very short prior-knowledge diagnostic for an undergraduate who wants to understand, extend, or contribute to an existing PhD student's research project.\n\nYour goal is NOT to test broad academic knowledge. Identify the 2–4 pieces of prior knowledge that would most change how another LLM should explain the project, introduce prerequisites and terminology, decompose extensions, discuss implementation and experiments, and help the student reason productively about the work.\n\n## Inputs\n\nThe student's self-reported familiarity with this kind of work is:\n{{familiarity}}\n\nThe student prefers:\n{{depth}}\n\n<phd_student_paper>\n(the paper attached above)\n</phd_student_paper>\n\n<project_urls>\n{{urls}}\n</project_urls>\n\n## Project summary\n\nProduce:\n\n- a 2–4 word title capturing the project's central idea;\n\n- a one-sentence plain-language description of what it does or investigates;\n\n- the publication/project date supported by the supplied sources.\n\nThe one-liner should be understandable without specialist knowledge while preserving the project's important idea.\n\nDo not invent a date. Use `null` if none can be determined.\n\n## Select knowledge areas\n\nChoose exactly 2–4 areas that would best calibrate how to discuss THIS PROJECT with THIS STUDENT.\n\nChoose granularity jointly from:\n\n- project requirements;\n\n- the student's self-reported experience;\n\n- desired technical depth.\n\nInclude an area only if knowing the student's level would materially change where explanations begin, their technical depth, or how the project is decomposed.\n\nPrefer areas that are CENTRAL, DISCRIMINATIVE, ACTIONABLE, COHERENT, and NON-REDUNDANT.\n\nDo not assume narrower is better. If a project's immediate dependency is too specific for the student's background, probe a broader prerequisite that better identifies their entry point. If the student is already experienced or wants greater technical depth, probe more specific project dependencies.\n\nFor a transformer-based project, for example:\n\n- not at all familiar → \"Machine Learning,\" \"Linear Algebra,\" \"PyTorch\"\n\n- moderately familiar → \"Transformer architectures\"\n\n- very familiar → specific mechanisms or methods used by the project\n\nAvoid overly broad fields like \"Computer science\" or \"Cognitive science\" when a more specific area would be informative, but do not fragment unnecessarily.\n\nUse this test:\n\n\"If we knew the student's level here, would it tell us where to begin and how technically deep to go?\"\n\nIf not, choose a broader or narrower area.\n\n## Questions\n\nFor EACH selected area, produce exactly five independently answerable calibration questions:\n\n0 — WOULDN'T KNOW WHERE TO START\n\"I wouldn't recognize most of the important concepts.\"\n\n25 — CAN FOLLOW IT\n\"I recognize the main ideas when someone explains them.\"\n\n50 — CAN EXPLAIN IT\n\"I could explain the core ideas in my own words, from memory.\"\n\n75 — CAN USE IT\n\"I could use the ideas to solve a new problem or make a design decision.\"\n\n100 — CAN REASON WITH IT\n\"I could spot mistakes, compare approaches, and explain when an idea would or wouldn't work.\"\n\nQuestions are about the AREA -- the field and the concepts you selected -- never about this paper. Do not ask the student to recall, summarise, or review anything specific to the paper: its method, results, figures, terminology, or claims. The student may not have read it. A 75- or 100-level question may use domain-specific language that is similar to what a PhD student or professor would use and could be plausibly understood by an advanced and well-versed undergraduate student. This does not mean the questions need to be longer as the level increases, though.\n\nVocabulary rises one step per level. Level 0 uses no jargon at all: an undergraduate from any field must be able to read the question and say something in reply. Level 25 may name the one or two most common terms of the area, in plain words. Levels 50 and above may use the area's own terms, but keep in mind that the amount of concepts should primarily be based on the level.\n\nThe student's chosen technical depth (above) governs every computing or programming term in every question: at \"Everyday\", avoid the term or explain it inside the question; at \"Some detail\", ordinary terms (file, function, server, dataset) stand alone and narrower ones get a few words; at \"Technical\" and \"Expert\", precise terms stand alone.\n\nLevels should progress from CONCEPTUAL FAMILIARITY to APPLIED REASONING:\n\n- 0 — RECOGNITION: Does the student know what the area is about and recognize its basic concepts? Surface unknown unknowns.\n\n- 25 — BASIC UNDERSTANDING: Can they follow the main concepts when explained or contextualized?\n\n- 50 — INDEPENDENT UNDERSTANDING: Can they explain important concepts and relationships in their own words?\n\n- 75 — APPLICATION: Can they use that understanding to solve a new problem, predict an outcome, or make a project-relevant decision?\n\n- 100 — REASONING: Can they diagnose failures, compare approaches, evaluate tradeoffs, or explain when an approach would or would not work?\n\nLevels 0–50 primarily measure familiarity and understanding; 75–100 measure productive reasoning with that knowledge. However, the goal for all of this is to gauge the student's familiarity with this specific content, NOT their general problem solving ability or aptitude.\n\nDifficulty should come from deeper understanding and reasoning, not obscure terminology, trivia, tedious mathematics, or memorization.\n\n75- and 100-level questions should be described using the paper's specific terms (since the student claims to be an expert). Lower levels may be more direct when needed to determine whether the student possesses the relevant concepts.\n\nQuestions should usually be answerable in 1–4 sentences and should not depend on incidental paper details.\n\nAvoid:\n\n- trivia, historical facts, or acronym expansion;\n\n- obscure terminology used only to increase difficulty;\n\n- exact equations unless genuinely essential;\n\n- testing multiple unrelated areas at once;\n\n- yes/no self-report such as \"Do you know PyTorch?\";\n\n- questions answerable through generic common sense without the relevant knowledge.\n\nEach question must be independently answerable and probe the same area at the intended depth.\n\n## Sample responses\n\nProvide one sample response for every question that approximately reflects the TARGET LEVEL:\n\n- 0: basic recognition or orientation;\n\n- 25: enough familiarity to follow an explanation;\n\n- 50: independent, correct conceptual understanding;\n\n- 75: successful application to a new situation;\n\n- 100: diagnosis, comparison, tradeoff reasoning, critique, or adaptation.\n\n## Source discipline\n\nBase the project summary and area selection only on the supplied task, paper, project material, URLs, repository information, and student information.\n\nDo not invent dependencies merely because they are common in the field.\n\nIf a supplied URL or repository cannot be inspected, do not pretend its contents were available.\n\n## Output\n\nReturn ONLY valid JSON with exactly this schema:\n\n{\n\"title\": \"2–4 word project title\",\n\"one_liner\": \"One sentence explaining the project in plain language.\",\n\"date\": \"YYYY, YYYY-MM-DD, or null\",\n\"areas\": [\n{\n\"area\": \"string\",\n\"parent_field\": \"string or null\",\n\"project_role\": \"One sentence explaining why this knowledge matters for understanding or extending this particular project.\",\n\"granularity_rationale\": \"One sentence explaining why this is the appropriate level of specificity for this student.\",\n\"questions\": [\n{\n\"level\": 0,\n\"capability\": \"wouldn't_know_where_to_start\",\n\"question\": \"string\",\n\"sample_response\": \"string\"\n},\n{\n\"level\": 25,\n\"capability\": \"can_follow\",\n\"question\": \"string\",\n\"sample_response\": \"string\"\n},\n{\n\"level\": 50,\n\"capability\": \"can_explain\",\n\"question\": \"string\",\n\"sample_response\": \"string\"\n},\n{\n\"level\": 75,\n\"capability\": \"can_use\",\n\"question\": \"string\",\n\"sample_response\": \"string\"\n},\n{\n\"level\": 100,\n\"capability\": \"can_reason_with\",\n\"question\": \"string\",\n\"sample_response\": \"string\"\n}\n]\n}\n]\n}\n\nBefore outputting, silently verify:\n\n- title is 2–4 words;\n\n- one-liner accurately communicates the central project idea;\n\n- date is source-supported or `null`;\n\n- exactly 2–4 areas;\n\n- area granularity reflects project requirements, student familiarity, and desired depth;\n\n- no substantial redundancy;\n\n- exactly five questions per area;\n\n- 0–50 show progressively stronger familiarity and understanding;\n\n- no question depends on having read the paper, and level 0 has no jargon;\n\n- 75 requires genuine knowledge of the domain and application;\n- 100 requires evaluation, comparison, diagnosis, or adaptation;\n\n- samples reflect the intended capability;\n\n- output is valid JSON with nothing outside it.\n",
  gradePrompt: "A student answered one short calibration question about \"{{area}}\". Estimate which capability level the answer demonstrates.\n\nThe levels:\n{{ladder}}\n\nThe question was written for level {{level}}. A sample answer at that level:\n\"\"\"\n{{sample}}\n\"\"\"\n\nThe student's answer:\n\"\"\"\n{{answer}}\n\"\"\"\n\nJudge the answer's substance, not its length or polish. An answer that shows the target level's capability scores {{level}}; one that shows less scores the highest level it does show; one that shows more (correct application, comparison, diagnosis beyond what was asked) may score higher. An answer that is empty, evasive, or wrong scores 0.\n\n" + JSON_ONLY + "\n{\"level\": 0 | 25 | 50 | 75 | 100, \"confidence\": 0.0-1.0, \"rationale\": \"one sentence, at most 200 characters\"}",
  followUpPrompt: "{{reader_block}}\nA student is being calibrated on \"{{area}}\"{{parent_field}}. They rated themselves \"{{self_label}}\" ({{self_level}}) and were asked the level-{{level}} question:\n\"\"\"\n{{question}}\n\"\"\"\nA sample answer at that level:\n\"\"\"\n{{sample}}\n\"\"\"\nThey answered:\n\"\"\"\n{{answer}}\n\"\"\"\nThe grader placed the answer at {{graded_level}} -- {{graded_label}}{{graded_rationale}}\n\nThe levels:\n{{ladder}}\n\nWrite ONE follow-up question at level {{graded_level}} that builds on what they actually said. Use their own words and examples where they gave any: probe the specific gap their answer showed if they were placed lower than they rated themselves, or the specific strength if they were placed higher. It must be a new question, not the ladder's question at that level and not a rephrasing of the one they answered; it must be about the AREA, never about the paper; and it should be answerable in one to three sentences by someone at level {{graded_level}}{{graded_desc}}.\nVocabulary follows the level: at 0 no jargon at all; at 25 only the one or two most common terms of the area, in plain words; from 50 up the area's own terms. The reader's technical depth above governs every computing term.\nAlso write a sample response that shows what a correct answer at that level looks like; it is used only to grade them and is never shown.\n\n" + JSON_ONLY + "\n{\"question\": \"the follow-up question\", \"sample_response\": \"a level-{{graded_level}} answer, one to three sentences\"}",
  assetsPrompt: "Read the paper above and identify the concrete inputs and outputs of the work: the things it rests on or produces that a person could get hold of and manipulate digitally, or at least extend. Look specifically for: datasets; tasks and apparatus; codebooks; experimental paradigms; mathematical and computational models; simulations; analysis pipelines; surveys, instruments and coding schemes; domain-specific libraries; source code; trained models; live demos. Prefer things that exist as files, repositories, services or well-specified procedures over ideas. Where the paper's own artifact is unavailable, a standard public equivalent of the same thing (the dataset it was trained on, the library it wraps) counts, and say that it is one.\n\nEvery item must be a specific building block of THIS paper: something the authors made, collected, adapted, or depend on in a way particular to the work. Never list general-purpose tools or platforms the paper merely used -- a programming language, a general LLM or its API (ChatGPT, GPT-4o, Claude), a mainstream framework, a spreadsheet, a survey platform, a statistics package. If the paper's contribution is a way of using such a tool, the item is that way of using it (the prompt set, the pipeline, the evaluation harness), named as the authors name it, not the tool.\n\nFor each one, hunt down where it actually lives. Search the web aggressively: project pages, GitHub, Hugging Face, Zenodo, OSF, Dataverse, lab pages, package registries, the paper's own references and supplementary material. Prefer the canonical home over a mirror. Give up to six links per asset, each with its kind. When nothing can be found, say so with availability \"unavailable\" rather than inventing a URL; a plausible-looking link that does not exist is worse than none.\n\nFor each asset write:\n- title: a short name\n- description: a short paragraph, two to four sentences, saying what it is and how the work uses it. Use the paper's and the field's own terms; do not simplify.\n- one_liner: one plain sentence naming what it is, for a brainstorming prompt\n- type: one of {{asset_types}}\n- links: [{\"kind\": \"live_demo\" | \"source_code\" | \"download\" | \"docs\" | \"paper\" | \"other\", \"url\": \"https://...\"}]\n- what_you_can_do_with_it: one sentence on what a person could do with it: run, query, extend, re-analyse, modify\n- availability: \"usable\" | \"partial\" | \"unavailable\" | \"unknown\"\n\nOrder by how central each is to the paper's contribution. At most five; fewer when the paper rests on fewer. Five specific things beat twelve that include the obvious.\n\n" + JSON_ONLY + "\n{\"assets\": [{\"title\": \"\", \"description\": \"\", \"one_liner\": \"\", \"type\": \"\", \"links\": [{\"kind\": \"\", \"url\": \"\"}], \"what_you_can_do_with_it\": \"\", \"availability\": \"\"}]}",
  levelPrompt: "{{reader_block}}{{assessment_block}}\n{{interest_line}}\n\nBelow are the concrete things the paper rests on or produces, written in the paper's own register.\n{{assets_json}}\n\nFirst decide where the locus of problem solving would lie for this reader in a first project on this paper, and which knowledge is sticky -- the part they must actually hold in their head to make decisions -- versus the part an AI coding assistant will carry for them (they need to know what a library does and what it returns, not its syntax). Someone representing dance poses for math education needs geometry and a working notion of what pose detection returns, not computer vision.\nThey will build with Claude Code, an AI coding assistant that writes, runs and debugs the code with them. So the question for each asset is not whether they can program against it but whether they can direct the work on it: understand what it is, judge whether an output is right, and decide what to change. Code, a UI, a repository, a dataset with a clear schema are usually within reach whatever the grades say, because the assistant carries the syntax and the plumbing. What the assistant cannot carry is the sticky part: a mathematical model they cannot read, a simulation whose parameters mean nothing to them, a coding scheme that presumes theory they lack, an analysis whose validity they cannot judge.\nThen, for each asset, decide whether this reader can pick it up as it is, on that basis -- the domain of the asset and the grades above together, not the grades alone. Most assets need no stand-in; add `children` only when it is absolutely necessary: when the sticky part of an asset is one the grades show they do not have, so that even with the assistant they could not tell right from wrong. Then add one to three stand-ins that teach exactly that idea: simpler, standard, well-documented, and specific to the idea (a worked instance of the same model with two parameters before the paper's with twenty; a small labelled sample of the same kind of data before the corpus), never a generic tutorial, language course or tool. Search the web for real ones. Each child has the same shape as an asset plus a `why`: one sentence, to the reader, naming the sticky idea it teaches and why they need it before the paper's own. An HCI paper with a UI and a repository will usually get none; a paper resting on a complex mathematical simulation may need one for a reader graded low on that area. Do not invent links.\nFinally rewrite every asset's `description`, `one_liner` and `what_you_can_do_with_it` at the reader's register (the rule at the top). Keep every original asset, its `title`, `type` and `links`.\n\n" + JSON_ONLY + "\n{\"locus\": \"one sentence: where the problem solving lies for this reader\", \"sticky\": [\"the two to five ideas they must hold themselves\"], \"assets\": [{\"title\": \"\", \"description\": \"\", \"one_liner\": \"\", \"type\": \"\", \"links\": [], \"what_you_can_do_with_it\": \"\", \"availability\": \"\", \"children\": [{\"title\": \"\", \"description\": \"\", \"one_liner\": \"\", \"type\": \"\", \"links\": [], \"what_you_can_do_with_it\": \"\", \"availability\": \"\", \"why\": \"\"}]}]}",
  brainstormPrompt: "{{reader_block}}{{assessment_block}}They are about to start a first project that builds on \"{{paper_title}}\" -- {{paper_one_liner}}{{brief_block}}{{transcript_block}}\nYou are brainstorming with them only to learn enough interest for the next Direction call to propose one useful project. There is no Path Agent in onboarding. Usually gather about three high-surface-area preference signals, with a hard cap of three meaningful user responses; do not exhaustively interview them.\nStart by contributing 2\u20134 grounded possibilities from the paper, reader, assessment, and available resource brief, one short sentence per possibility. Offer them in a single focus or question card with little or no preamble. Do not invent facts about resources you have not inspected. If unusually specific intent already covers the useful preference dimensions, no question is needed.\nAsk at most ONE meaningful question per turn, including prose and card together. Ask only when the answer materially changes the Direction AND is a human preference or judgment Bart cannot discover. A questions card has at most one item. Never repeat expertise, prior building experience, paper familiarity, or available-resource questions already answered by context. Never ask what columns exist, how a repo works, which examples are available, or whether an implementation exists. Bart handles discoverable facts and coding/setup; programming ability is not a constraint or a question.\nProbe a different dimension with each question: (1) what part of the material interests the student, (2) what they want to do with it, and (3) what they would like to discover, change, or compare. These are preference signals, not a rigid questionnaire: use context and each response to identify the next missing dimension. Never ask multiple questions that merely narrow the same preference. A choice such as 'the repeated failure one' supplies the material-interest signal; it usually does not supply the other two. Move to a new dimension rather than asking which kind of repeated failure they mean.\nStop earlier only when the student has already given unusually specific intent that covers the useful preference dimensions; one response may contain several signals. Otherwise aim for about three complementary signals before ready:true. Do not re-ask dimensions already supplied. After the third meaningful user response return ready:true, card:none, with the best available understanding, even if something remains uncertain. Resolve option references from the offered choices. Summarize all gathered signals together in interest, not just the most recent answer.\nCapture an emerging interest, not a finished build proposal: for example, 'Interested in repeated failed-run loops as a signal of student struggle.' Direction chooses the concrete project; Subgoals and Todos plan it later. Do not generate a project proposal, roadmap, feature list, architecture, implementation sequence, subgoals, or todos here.\nReadiness depends only on enough human context, NEVER resource fitting or other background work. If sufficient preference signals or unusually specific intent are already clear while resources load, set ready:true and stop questioning; the application will handle waiting. Never use questions as filler.\nWrite like a student/researcher talking through ideas at a table. Keep responses short: one sentence per possibility, at most one question, and little or no preamble. Avoid product-spec language. Write at the register above.\nReply with ONE JSON object and nothing else:\n{\"say\": \"<one short reflection, or empty when the card says it all>\",\n \"card\": \"questions\" | \"focus\" | \"none\",\n \"questions\": {\"eyebrow\": \"<short label>\", \"items\": [{\"id\": \"<short slug>\", \"type\": \"mcq\" | \"select_all\" | \"free\" | \"open\", \"title\": \"<the one question>\", \"subtitle\": \"<optional>\", \"options\": [{\"label\": \"<one grounded possibility>\", \"why\": \"<optional short explanation>\"}], \"placeholder\": \"<for free and open>\"}]},\n \"focus\": {\"title\": \"<the one preference question>\", \"options\": [{\"label\": \"<one grounded possibility>\", \"why\": \"<optional short explanation>\"}]},\n \"interest\": \"<one concise sentence about their emerging interest; empty only if still unknown>\"{{ready_key}}}\nOnly include fields for the named card. Use 2\u20134 options for choices. Do not ask a second question in say when a card asks one{{none_rule}}{{opening_line}}{{ready_line}}" ,
  directionPrompt: "{{reader_block}}{{assessment_block}}\nThey are starting a first project that builds on \"{{paper_title}}\" -- {{paper_one_liner}}\n{{interest_line}}\n{{locus_line}}\n{{sticky_line}}\nThe thing they chose to build on:\n{{asset_json}}{{transcript_block}}\n\n{{previous_head}}\n{{previous_json}}\n{{feedback_line}}\n\n{{task}}\nWrite at the register above.\n\n" + JSON_ONLY + "\n{\"title\": \"2-6 words\", \"what_you_would_make\": \"two or three sentences, to them\", \"uses\": [\"what it uses, by title\"], \"why_it_fits\": \"one or two sentences: why this one, for them, given what they said and how they did\", \"first_visible_result\": \"one sentence: the first thing they would see working\"}",
  subgoalsPrompt: "{{reader_block}}\nThey are building on \"{{paper_title}}\" -- {{paper_one_liner}}\nThe direction: \"{{direction_title}}\" -- {{direction_what}}{{first_visible}}\nBuilt on:\n{{asset_json}}\n{{locus_line}}\n{{previous_head}}\n{{previous_json}}\n{{feedback_line}}\n\n{{task}}\nWrite at the register above.\n\n" + JSON_ONLY + "\n{\"subgoals\": [{\"label\": \"active verb first, usually 3-8 words\", \"description\": \"one concise sentence, usually 15-30 words\", \"why\": \"one short sentence, usually 10-25 words\"}, {}, {}]}",
  todosPrompt: "{{reader_block}}{{resources_block}}\nThey are building on \"{{paper_title}}\" -- {{paper_one_liner}}\nThe direction: \"{{direction_title}}\" -- {{direction_what}}\nThe first piece of it, the one to start on now: \"{{subgoal_label}}\"{{subgoal_desc}}\n\nWrite the TODO rows for that first piece only. Two to four rows, in the imperative, each one thing a coding agent working with them could pick up and finish -- concrete, checkable, small enough for a session. Do not write research, planning, browsing, dataset-selection, or other human-decision rows; when a real input is not chosen yet, use a tiny bundled or synthetic fixture so implementation can begin now. Where a resource above is the right starting point, name it in the row. Do not write rows for the other pieces.\nTreat a GUI as the default first implementation, not later polish. Unless an interactive surface genuinely makes no sense for this direction, make the first row create or adapt a runnable GUI shell containing the project's key input control and a visible output or status region. Make the remaining rows wire the thinnest real input-to-output path and show its result in that GUI. The first round should end with something the student can operate immediately, not a static mock; reuse an existing demo or interface from the resources when one exists.\nAlso propose a short project name: two to four lowercase words joined by hyphens.\nWrite at the register above.\n\n" + JSON_ONLY + "\n{\"todos\": [\"row\", \"row\"], \"name\": \"short-hyphenated-name\"}",
  askPrompt: "{{reader_block}}{{resources_block}}\nContext: they are setting up a first project building on \"{{paper_title}}\" -- {{paper_one_liner}}\nThey selected this text on the page: \"{{quote}}\"\nThey ask: \"{{question}}\"\n\nAnswer in at most four sentences at the register above. If the question is whether something is too much for a first project, say so plainly and name the smaller version.\n\n" + JSON_ONLY + "\n{\"answer\": \"...\"}",
  rewritePrompt: "{{reader_block}}Below are {{count}} passages shown to the reader on one screen of a setup page. They were written {{from_phrase}}. The reader has asked for them {{to_phrase}}.\n{{to_rule}}Rewrite each passage at the new register. Keep what it says and roughly how long it is; a question stays a question, an option stays an option, a title stays a title. Keep every name, number, URL and quoted term as it is. Do not add, drop, merge or reorder passages. Where a passage is already at the new register, return it unchanged.\nThe passages:\n{{list}}" + JSON_ONLY + "\n{\"texts\": [{{json_slots}}]}  -- exactly {{count}} strings, in the same order"
};
const LABELS = { analyzePrompt: "Read the paper", assetsPrompt: "Hunt for the paper's things", gradePrompt: "Grade an answer", followUpPrompt: "Write a follow-up", levelPrompt: "Fit the resources to the reader",
  brainstormPrompt: "Brainstorm turn", directionPrompt: "Propose a direction", subgoalsPrompt: "Propose three footholds", todosPrompt: "Write todos", askPrompt: "Answer a question about selected text", rewritePrompt: "Rewrite at another register" };
const ORDER = ["analyzePrompt", "assetsPrompt", "gradePrompt", "followUpPrompt", "levelPrompt", "brainstormPrompt", "directionPrompt", "subgoalsPrompt", "todosPrompt", "askPrompt", "rewritePrompt"];
const OVERRIDE_MAX_CHARS = 32000;

function ladderText() {
  return LADDER.map((r) => `${r.level} -- ${r.label}: ${r.desc}`).join("\n");
}
const J = (v) => JSON.stringify(v == null ? {} : v, null, 0);

const DIRECTION_TASK = "Choose ONE direction for their first project. Not three to pick from: the one that best fits everything above. It must name a concrete capability they could build, run, or modify within a couple of weeks with an AI coding assistant, using the thing they chose; a coding agent should know what to implement next, and the start must not depend on the student first browsing a dataset, choosing an example, collecting inputs, reading background, or making another decision. Prefer a direction whose thinnest working version is an interactive GUI they can use immediately, not a backend hidden until later. It must produce something they can see or play with early -- attention first, usefulness to the PhD student second -- and it must sit where the problem solving lies for THEM, not in the part a library or the assistant will carry.";
const SUBGOALS_TASK = "Propose exactly three small capability gains for the human: the next three footholds toward the approved Direction, not a feature roadmap or MVP/V2/V3 milestones. Minimize prerequisite burden on the HUMAN. Preserve the approved Direction as the eventual destination; its first visible result is context, not a requirement to build the complete capability in Subgoal 1.\n\nDefault progression, especially for an unfamiliar dataset, repository, scientific domain, tool, or system:\n1. ORIENT: get one real thing into the user's hands. The agent selects a small real example/subset and makes it visible or runnable so the user can see what is there.\n2. DEMONSTRATE: make one representative idea, operation, or workflow work end-to-end on that same example. Show one observable result with a sensible default chosen by the agent.\n3. MANIPULATE: let the user change, compare, test, or investigate one meaningful variable or behavior on that same artifact and immediately see the effect.\nThese are scope heuristics, not required labels. Without an external dataset, make one concrete part visible/runnable, make one representative workflow work, then let the user change/test one meaningful behavior.\n\nEvery subgoal must produce ONE concrete observable result, introduce at most ONE substantial new conceptual burden, and reuse what the previous subgoal created (the first establishes that artifact). It must be understandable without first learning a whole domain and achievable by Bart without the user designing another subsystem. Choose sensible defaults and a small real subset/example over a generalized implementation. Keep the first subgoal small enough for the existing 2–4 implementation Todos.\n\nThe agent handles downloading data, cloning/inspecting the repository, inspecting schemas, reading docs or papers, installing dependencies, choosing a representative example/subset, and determining how to run the system as needed. Do not assign the user 'learn the dataset', 'read the documentation', 'understand the codebase', 'explore approaches', 'choose a representative example', or 'decide what variables to compare'. Understanding emerges through interacting with the artifact. Prefer an available real example; if none is accessible, explicitly identify the access limitation and a minimal labeled stand-in, never imply synthetic data is real.\n\nPrefer one example, one rule, one parameter, one output, or one comparison before generalizing. Do not bundle major UI/system features or jump to many examples, many rules, dashboards, filtering systems, clustering/grouping, generalized pipelines, multi-rule comparison frameworks, aggregate/cohort analytics, or polished product features unless the approved Direction explicitly requires that scope as the immediate first useful result. Even then choose the smallest necessary case.\n\nBefore returning, silently check each subgoal: What is the ONE new thing the user can see or do after this? If the answer needs several major clauses joined by 'and', shrink it. Could this reasonably be the very next thing Bart builds once the preceding foothold exists? If not, shrink it. Check the progression gets the real thing into their hands, shows one idea working, then gives them one meaningful change to make; do not force it where inapplicable.\n\nWrite like a student/researcher project plan or a researcher's notebook, not a product specification. Every label begins with an active verb (hard constraint); labels are usually 3–8 words and name what the person is trying to accomplish. Use direct action language such as Inspect, Apply, Highlight, Compare, Test, Adjust, Measure, Reproduce, Explore, Verify, or Visualize; these are examples, not a restricted vocabulary. An action means working with the artifact, not assigning prerequisite study or setup to the human.\nDescriptions are one concise sentence, usually 15–30 words. Answer: What will I be able to see, do, test, compare, or understand after this? Describe the capability/result, not the UI implementation. Do not enumerate controls/components, panels, filters, dropdowns, or columns unless essential to the research task. Avoid product-spec phrasing such as 'A panel displays', 'The interface allows', 'The window shows', 'Checkboxes let', 'A ranked list appears', 'The system provides', or 'Users can', unless the UI control itself is central to the research question.\nThe why is one short sentence, usually 10–25 words, explaining why this is the next foothold; do not repeat the description.\nKeep the same concrete example across the first three subgoals whenever possible: inspect it, apply one idea to it, then manipulate one meaningful variable. Do not automatically expand from one example to many examples or a whole cohort; generalization can happen later.\nBefore returning, silently ask: Could this plausibly be written in a researcher's notebook as tomorrow's goal? If not, rewrite it more naturally. Verify every label starts with an active verb and each description and why is a concise single sentence, while preserving the scope constraints above.";

// The slot values for one call, from the same input the prompt's function takes. Blocks reproduce
// the functions' joins: a leading block ends with its own newline when present, a block in the middle
// begins with one; the two prompts that drop blank lines (brainstorm, rewrite) get blocks with theirs
// dropped and templates with no blank lines.
function slots(key, v) {
  v = v || {};
  const head = (arr) => (arr.length ? arr.join("\n") + "\n" : "");
  const mid = (arr) => (arr.length ? "\n" + arr.join("\n") : "");
  const tight = (arr) => arr.filter((l) => l !== "");
  const paper = v.paper || {};
  if (key === "analyzePrompt") return { familiarity: v.familiarityLabel + (v.familiarityDesc ? " -- " + v.familiarityDesc : ""), depth: v.depthLabel + (v.depthDesc ? " -- " + v.depthDesc : ""), urls: v.urls || "(none supplied)" };
  if (key === "gradePrompt") return { area: v.area, ladder: ladderText(), level: v.level, sample: v.sample, answer: v.answer };
  if (key === "followUpPrompt") { const at = rung(v.graded_level), self = rung(v.self_level); return { reader_block: head(readerBlock(v.reader)), area: v.area, parent_field: v.parent_field ? " (" + v.parent_field + ")" : "", self_label: self ? self.label : v.self_level, self_level: v.self_level, level: v.level, question: v.question, sample: v.sample || "(none)", answer: v.answer, graded_level: v.graded_level, graded_label: at ? at.label : "", graded_rationale: v.graded_rationale ? ": " + v.graded_rationale : ".", ladder: ladderText(), graded_desc: at ? " (" + at.desc.toLowerCase() + ")" : "" }; }
  if (key === "assetsPrompt") return { asset_types: ASSET_TYPES.map((t) => "\"" + t + "\"").join(" | ") };
  if (key === "levelPrompt") return { reader_block: head(readerBlock(v.reader)), assessment_block: head(assessmentBlock(v.assessment)), interest_line: v.interest ? "What they seem drawn to so far: \"" + v.interest + "\"" : "They have not said what they want to make yet.", assets_json: J({ assets: v.assets || [] }) };
  if (key === "brainstormPrompt") { const opening = !(Array.isArray(v.turns) && v.turns.length);
    return { reader_block: head(tight(readerBlock(v.reader))), assessment_block: head(tight(assessmentBlock(v.assessment))), paper_title: paper.title, paper_one_liner: paper.one_liner, brief_block: mid(tight(briefBlock(v.brief))), transcript_block: mid(tight(transcriptBlock(v.turns))),
      ready_key: ",\n \"ready\": true | false", none_rule: "; `none` is allowed only with `ready` true.", opening_line: opening ? "\nThis is the opening turn: contribute grounded possibilities before asking for a preference." : "",
      ready_line: "\nAlways return ready. Human context alone determines readiness; background resource fitting does not. Meaningful user responses so far: " + (Array.isArray(v.turns) ? v.turns.filter(function (t) { return t.role === "user" && String(t.content || "").trim() && String(t.content).trim() !== "(skipped those)"; }).length : 0) + ". At three responses, return ready:true with no question." }; }
  if (key === "directionPrompt") { const lv = v.leveled || {}; return { reader_block: head(readerBlock(v.reader)), assessment_block: head(assessmentBlock(v.assessment)), paper_title: paper.title, paper_one_liner: paper.one_liner,
    interest_line: v.interest ? "What they are drawn to: \"" + v.interest + "\"" : "", locus_line: lv.locus ? "Where the problem solving lies for them: " + lv.locus : "", sticky_line: Array.isArray(lv.sticky) && lv.sticky.length ? "What they must hold in their head: " + lv.sticky.join("; ") : "",
    asset_json: J(v.asset), transcript_block: mid(transcriptBlock(v.turns, 16)), previous_head: v.previous ? "The direction you proposed before:" : "", previous_json: v.previous ? J(v.previous) : "", feedback_line: v.feedback ? "What they want changed: \"" + v.feedback + "\"" : "",
    task: v.previous ? "Revise the direction to do what they asked. Keep what they did not object to." : DIRECTION_TASK }; }
  if (key === "subgoalsPrompt") { const lv = v.leveled || {}, d = v.direction || {}; return { reader_block: head(readerBlock(v.reader)), paper_title: paper.title, paper_one_liner: paper.one_liner, direction_title: d.title, direction_what: d.what_you_would_make || "", first_visible: d.first_visible_result ? " First visible result: " + d.first_visible_result : "",
    asset_json: J(v.asset), locus_line: lv.locus ? "Where the problem solving lies for them: " + lv.locus : "", previous_head: v.previous ? "The subgoals you proposed before:" : "", previous_json: v.previous ? J(v.previous) : "", feedback_line: v.feedback ? "What they want changed: \"" + v.feedback + "\"" : "",
    task: SUBGOALS_TASK + (v.previous ? "\n" + "Revise the three subgoals to address the feedback. Keep compatible work they did not object to, but shrink any inherited roadmap-sized subgoals to satisfy the foothold constraints above." : "") }; }
  if (key === "todosPrompt") { const d = v.direction || {}, sg = v.subgoal || {}; return { reader_block: head(readerBlock(v.reader)), resources_block: head(resourcesBlock(v.resources)), paper_title: paper.title, paper_one_liner: paper.one_liner, direction_title: d.title, direction_what: d.what_you_would_make || "", subgoal_label: sg.label, subgoal_desc: sg.description ? " -- " + sg.description : "" }; }
  if (key === "askPrompt") return { reader_block: head(readerBlock(v.reader)), resources_block: head(resourcesBlock(v.resources)), paper_title: paper.title, paper_one_liner: paper.one_liner, quote: v.quote, question: v.question };
  if (key === "rewritePrompt") { const was = depthOf(v.from), now = depthOf(v.to), texts = Array.isArray(v.texts) ? v.texts : [];
    const list = texts.map((t, i) => (i + 1) + ". " + String(t)).join("\n");
    return { reader_block: head(tight(readerBlock({ ...(v.reader || {}), depth: v.to }))), count: texts.length, from_phrase: was ? was.phrase : v.from, to_phrase: now ? now.phrase : v.to, to_rule: now ? "The new register: " + now.rule + "\n" : "", list: list ? list + "\n" : "", json_slots: texts.map(() => "\"...\"").join(", ") }; }
  return {};
}

function render(key, input, overrides) {
  const tpl = overrides && overrides[key] != null ? overrides[key] : TEMPLATES[key];
  if (tpl == null) return "";
  const s = slots(key, input || {});
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (s[k] == null ? "" : String(s[k])));
}

// What a request may carry as `prompt_overrides`: an object naming editable prompts with their full
// text. Anything else -- unknown names, non-strings, text past the bound -- is dropped, and nothing
// usable is null. Bounded so a request cannot carry more than the eleven prompts' worth of text.
function sanitizeOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of ORDER) {
    const v = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
    if (typeof v !== "string") continue;
    const s = v.replace(/\r/g, "");
    if (!s.trim() || s.length > OVERRIDE_MAX_CHARS) continue;
    if (s === TEMPLATES[key]) continue;
    out[key] = s;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  TEMPLATES, LABELS, ORDER, OVERRIDE_MAX_CHARS, slots, render, sanitizeOverrides,
  DEPTHS, FAMILIARITY, LADDER, JSON_ONLY, ASSET_TYPES,
  depthOf, rung, readerBlock, assessmentBlock, briefBlock, transcriptBlock,
  analyzePrompt, gradePrompt, followUpPrompt, rewritePrompt, detailsPrompt, goalsPrompt, todosPrompt, askPrompt,
  PAPER_PREFIX, assetsPrompt, levelPrompt, brainstormPrompt, assetAskPrompt, directionPrompt, subgoalsPrompt, resourcesBlock,
};
