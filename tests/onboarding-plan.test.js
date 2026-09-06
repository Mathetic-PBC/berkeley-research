"use strict";
// The behaviour the planning prompts and the brainstorm's state are meant to
// produce, checked as properties of what the model is told and of what the
// server keeps -- not as string snapshots. The scenario at the end is a reader
// drawn to a phenomenon who has never opened the dataset it lives in.

const assert = require("node:assert/strict");
const test = require("node:test");
const P = require("../api/_lib/onboarding-prompts");
const OB = require("../api/_lib/onboarding");
const OM = require("../api/_lib/onboarding-model");

const reader = { name: "Ada", year: "Third year", major: "Biology", depth: "some",
  knowledge: [{ area: "Innate immunity", level: 25 }, { area: "Single-cell analysis", level: 0 }] };
const paper = { title: "Single-cell cytokine responses of innate immune cells", one_liner: "Measures how each kind of innate immune cell answers each cytokine." };
const dataset = { title: "Cytokine-response single-cell dataset", type: "dataset", one_liner: "expression per cell, per cytokine, per cell type",
  what_you_can_do_with_it: "compare responses", links: [{ kind: "download", url: "https://x.org/data" }] };
const brief = [{ title: dataset.title, type: "dataset", one_liner: dataset.one_liner }];
const asked = { role: "assistant", content: "(asked) What pulls you in?" };
const said = { role: "user", content: "Why do different innate immune cells respond differently?" };

// --- brainstorm ------------------------------------------------------------------

test("the brainstorm is told to converge: one or two questions a card, a second round only if it matters, never a third", () => {
  const text = P.brainstormPrompt({ reader, paper, assessment: null, brief, turns: [], round: 0 });
  assert.match(text, /only enough to identify a plausible project direction/);
  assert.match(text, /Optimize for information gained, not conversation length/);
  assert.match(text, /at most one or two high-value questions in a card/);
  assert.match(text, /second round only if the first answers revealed something that would materially change/);
  assert.match(text, /Never ask a third round/);
  assert.doesNotMatch(text, /explore sideways|follow up on what they say|every turn carries a card/, "the old encouragement to keep going is gone");
});

test("the brainstorm asks about interest and intent, not about resources the reader has not opened or things the agent can find out", () => {
  const text = P.brainstormPrompt({ reader, paper, assessment: null, brief, turns: [asked, said], round: 1 });
  assert.match(text, /may not have opened the dataset, repository, code, model, simulation/);
  assert.match(text, /Do not ask them to choose between technical things they have not had a chance to understand/);
  assert.match(text, /Do not ask questions whose answers the coding agent can discover from the paper, repository, dataset, documentation/);
  assert.match(text, /what phenomenon or behavior catches their attention/);
  assert.match(text, /who or what they care about the result being useful for/);
  assert.match(text, /never ask what languages they know/);
  assert.match(text, /They: Why do different innate immune cells respond differently\?/, "the transcript is there");
});

test("readiness is asked for on every turn and does not depend on the fitted resources", () => {
  for (const round of [0, 1, 2, 3]) {
    for (const extra of [{}, { leveled_status: "running" }, { leveled_status: "done" }, { readyAsked: false }]) {
      const text = P.brainstormPrompt({ reader, paper, assessment: null, brief, turns: round ? [asked, said] : [], round, ...extra });
      assert.match(text, /"ready": true \| false/, `round ${round}`);
      assert.match(text, /Once you know \(1\) what draws them to the work and \(2\) one plausible outcome they would be excited to see, you know enough to continue: set `ready` true/);
      assert.match(text, /do not continue asking questions merely because that is still happening/);
      assert.equal(text, P.brainstormPrompt({ reader, paper, assessment: null, brief, turns: round ? [asked, said] : [], round }), "nothing about the resources' state changes the prompt");
    }
  }
  assert.doesNotMatch(P.brainstormPrompt.toString(), /leveled|readyAsked/, "the prompt has no input for it");
});

test("the model is told which round it is, and the third is refused in the prompt as it is in the state", () => {
  const at = (round) => P.brainstormPrompt({ reader, paper, assessment: null, brief, turns: [asked, said], round });
  assert.match(at(0), /Question rounds so far: none\. This turn may ask\./);
  assert.match(at(1), /Question rounds so far: one\. Ask a second only if their answers revealed something that would materially change/);
  assert.match(at(2), /Question rounds so far: two, the most allowed\. Do not ask again: set `ready` true, make the card `none`/);
  assert.equal(at(3), at(2), "past the cap the instruction is the cap's");
  assert.equal(P.BRAINSTORM_ROUNDS, 2);
});

test("the state cannot loop: a question round is a stored card, two are the most, and a turn past them is closed as ready", () => {
  const q = (n) => ({ role: "assistant", card: { card: "questions", questions: { items: [{ id: "q" + n, type: "free", title: "?" }] } } });
  const f = { role: "assistant", card: { card: "focus", focus: { options: [{ label: "A" }, { label: "B" }] } } };
  const prose = { role: "assistant", card: { card: "none" } };
  const user = { role: "user", card: { answers: { q1: "a" } } };
  assert.equal(OB.questionRounds([]), 0);
  assert.equal(OB.questionRounds([q(1), user, prose, user, f, user]), 2, "prose turns and the reader's turns are not rounds");
  // Whatever a drifting prompt makes the model return on the third round, the row keeps no card and says ready.
  const asking = { say: "One more?", card: "questions", questions: { items: [{ id: "x", type: "free", title: "One more?" }] }, interest: "cells", ready: false };
  let turns = [];
  for (let round = 0; round < 6; round++) {
    const closed = OB.closeReply(asking, OB.questionRounds(turns));
    turns.push({ role: "assistant", card: { card: closed.card, ready: closed.ready } }, user);
    if (round < P.BRAINSTORM_ROUNDS) { assert.equal(closed.card, "questions"); assert.equal(closed.ready, false); }
    else { assert.equal(closed.card, "none"); assert.equal(closed.ready, true); assert.equal(closed.questions, undefined); }
  }
  assert.equal(OB.questionRounds(turns), P.BRAINSTORM_ROUNDS, "the rounds never pass the cap however long the conversation runs");
  // Ready on the first turn is honoured as it is: the fitted list is not consulted.
  assert.deepEqual(OB.closeReply({ say: "Cells it is.", card: "none", interest: "cells", ready: true }, 0), { say: "Cells it is.", card: "none", interest: "cells", ready: true });
  // And the model layer never lets a card carry more than two questions.
  const card = OM.normalizeBrainstorm({ say: "", card: "questions", questions: { items: [{ title: "a" }, { title: "b" }, { title: "c" }] } });
  assert.equal(card.questions.items.length, 2);
});

// --- fitting the resources ------------------------------------------------------

test("fitting keeps the locus and the sticky knowledge, names the coding agent rather than a vendor, and does not treat unfamiliarity as a need for a stand-in", () => {
  const text = P.levelPrompt({ reader, assessment: { areas: [] }, assets: [dataset], interest: "why cell types differ" });
  assert.match(text, /where the locus of problem solving would lie/);
  assert.match(text, /which knowledge is sticky/);
  assert.match(text, /the part the coding agent will carry for them/);
  assert.match(text, /Engelbart's coding agent/);
  assert.match(text, /Being unfamiliar with a resource does not by itself mean they need a substitute/);
  assert.match(text, /can download, inspect, subset, run, label, summarize, and visualize the real resource/);
  assert.match(text, /they do not need to understand the schema before work can begin/);
  assert.match(text, /Distinguish the setup and orientation burden, which the agent carries, from conceptual judgment/);
  assert.match(text, /genuinely required to judge the real resource even after the agent has concretely demonstrated and explained it/);
});

test("no prompt names a vendor's coding assistant", () => {
  for (const key of P.ORDER) assert.doesNotMatch(P.TEMPLATES[key], /Claude Code|AI coding assistant/, key);
  assert.doesNotMatch(P.brainstormPrompt({ reader, paper, assessment: null, brief, turns: [], round: 0 }), /Claude/);
});

// --- direction, subgoals, todos ----------------------------------------------------

const leveled = { locus: "which cell types to compare and what a different response means", sticky: ["what a cytokine is", "what a cell type is"] };
const direction = { title: "Compare two cell types' answers", what_you_would_make: "A comparison of how two innate cell types answer one cytokine.", first_visible_result: "one cell type's response drawn" };

test("the direction is a destination the subgoals will bridge to, not a first step or a beginner's dashboard", () => {
  const text = P.directionPrompt({ reader, paper, interest: "why innate immune cells respond differently", assessment: null, turns: [asked, said], asset: dataset, leveled, previous: null, feedback: "" });
  assert.match(text, /the concrete capability, question, or result they should eventually reach/);
  assert.match(text, /describes where the project is going, NOT everything they must already understand before beginning/);
  assert.match(text, /may currently know very little about the dataset, repository, model, experimental system, or terminology; that is fine/);
  assert.match(text, /could become a meaningful extension, comparison, reproduction, or modification/);
  assert.match(text, /something they could eventually show the researcher/);
  assert.match(text, /Do not turn the direction into a generic "explore the dataset" or "build a dashboard" project/);
  assert.match(text, /Do not assume the first implementation step is the direction itself/);
  assert.doesNotMatch(text, /interactive GUI they can use immediately|thinnest working version|must not depend on the student first browsing/);
  assert.match(text, /"first_visible_result"/, "the structured output is kept");
  const revised = P.directionPrompt({ reader, paper, interest: "", assessment: null, turns: [], asset: dataset, leveled, previous: direction, feedback: "smaller" });
  assert.match(revised, /Revise the direction to do what they asked/);
});

test("subgoals minimise the human's prerequisites: the agent puts the real thing in their hands, one example end-to-end, then one decision", () => {
  const text = P.subgoalsPrompt({ reader, paper, direction, asset: dataset, leveled, previous: null, feedback: "" });
  assert.match(text, /minimum prerequisite burden on the HUMAN, not merely the minimum amount of code/);
  assert.match(text, /may not yet have downloaded the resource, opened the repository, seen the dataset, understood its structure/);
  assert.match(text, /do not make them do those things before implementation begins/);
  assert.match(text, /Subgoal 1, get the real thing into their hands: the coding agent obtains or opens the relevant resource and makes its basic structure inspectable/);
  assert.match(text, /not required to choose columns, files, examples, parameters, or methods before they have seen them/);
  assert.match(text, /Subgoal 2, make one representative example work end-to-end/);
  assert.match(text, /what went in, what happened, and what came out/);
  assert.match(text, /Subgoal 3, give them one meaningful thing to change, compare, test, or investigate/);
  assert.match(text, /begin directing the work instead of merely becoming oriented to it/);
  assert.match(text, /adapt these roles while preserving the progression: orientation, then one concrete end-to-end example, then one meaningful manipulation/);
  assert.match(text, /observable capability someone could tell you is working, not a human activity, phase, heading, topic, or unanswered decision/);
  for (const bad of ["Learn the dataset", "Read the documentation", "Understand the codebase", "Explore possible approaches", "Choose an example", "Decide what to analyze", "Study the paper"]) {
    assert.ok(text.includes(`"${bad}"`), `rejects ${bad}`);
  }
  assert.match(text, /"If the reader stopped after this subgoal, what new thing could they actually open, run, see, or do\?" If there is no concrete answer, rewrite the subgoal/);
  assert.doesNotMatch(text, /smallest runnable technical vertical slice|synthetic fixture|A representative study video is chosen/, "the code-first ordering is gone");
  assert.match(text, /"subgoals": \[\{"label"/, "the structured output is kept");
});

test("todos give the setup to the agent, prefer the smallest real subset to a synthetic one, and still name the project", () => {
  const text = P.todosPrompt({ reader, paper, direction, subgoal: { label: "The dataset opens and shows what it holds", description: "One table of cells and cytokines." }, resources: [dataset] });
  assert.match(text, /Write the TODO rows for the FIRST subgoal only/);
  assert.match(text, /two to four rows maximum/);
  assert.match(text, /should not have to perform prerequisite work before these rows can begin; the coding agent carries the setup burden/);
  for (const carried of ["download or clone the relevant resource", "inspect files, schemas, documentation, APIs, or repository structure", "install dependencies",
    "determine which parts of a large resource matter", "choose a small representative example or subset", "convert awkward source formats", "start an existing demo", "create the minimum viewer needed"]) {
    assert.ok(text.includes(carried), `the agent may ${carried}`);
  }
  for (const bad of ["understand the schema", "explore the dataset", "choose a sample", "read the repository", "decide which variables to use"]) {
    assert.ok(text.includes(`"${bad}"`), `no conceptual TODO like ${bad}`);
  }
  assert.match(text, /combine setup and plumbing operations when they do not create distinct value/);
  assert.match(text, /Do not build a polished application yet: a minimal functional table, plot, viewer, page, notebook output, or runnable example is enough/);
  assert.match(text, /orientation through interaction rather than require orientation before interaction/);
  assert.match(text, /use the smallest REAL subset that preserves its meaning; use a synthetic fixture only when the real resource genuinely cannot be accessed yet/);
  assert.match(text, /Cytokine-response single-cell dataset \(dataset\): compare responses <https:\/\/x\.org\/data>/, "the real resource is at hand, by name");
  assert.match(text, /Also propose a short project name: two to four lowercase words joined by hyphens/);
  assert.match(text, /"name": "short-hyphenated-name"/);
  assert.doesNotMatch(text, /Treat a GUI as the default first implementation|tiny bundled or synthetic fixture so implementation can begin now/);
});

// --- the scenario ----------------------------------------------------------------
//
// A reader drawn to a phenomenon -- why innate immune cells respond differently
// -- who has never opened the dataset, does not know its schema, and does not
// know the terminology yet. What the model is told at each stage must lead to:
// a direction about comparing or understanding the responses; a first subgoal
// that puts the real dataset in front of them; a second that shows one response
// end to end; a third that hands them one comparison or change. Not a dashboard
// first, and not "learn the dataset" first.

test("scenario: a reader drawn to a phenomenon who has never seen the dataset", () => {
  const interest = "why different innate immune cells respond differently to the same cytokine";
  const turns = [asked, said, { role: "assistant", content: "What would you want to be able to see by the end?" },
    { role: "user", content: "Two cell types side by side, answering the same cytokine differently." }];
  // Brainstorm: after those two answers the model knows what draws them and one outcome; it is told that is enough,
  // with the resources still being fitted, and a further round is refused by the state.
  const bs = P.brainstormPrompt({ reader, paper, assessment: null, brief, turns, round: 2 });
  assert.match(bs, /They: Two cell types side by side/);
  assert.match(bs, /Do not ask again: set `ready` true/);
  assert.equal(OB.closeReply({ say: "Which cytokine, and which columns hold it?", card: "questions", questions: { items: [{ id: "c", type: "free", title: "Which columns?" }] }, ready: false }, 2).card, "none",
    "a question about columns they have never seen is not asked");

  // Direction: about the phenomenon, built on the dataset, a destination.
  const dir = P.directionPrompt({ reader, paper, interest, assessment: null, turns, asset: dataset, leveled, previous: null, feedback: "" });
  assert.match(dir, new RegExp(`What they are drawn to: "${interest}"`));
  assert.match(dir, /Cytokine-response single-cell dataset/);
  assert.match(dir, /Where the problem solving lies for them: which cell types to compare/);
  assert.match(dir, /meaningful extension, comparison, reproduction, or modification/);
  assert.match(dir, /Do not turn the direction into a generic "explore the dataset" or "build a dashboard" project merely because they are a beginner/);
  assert.match(dir, /The coding agent and the subgoals that follow will bridge them from that starting point/);

  // Subgoals: the dataset loaded and inspectable, one response end to end, one comparison -- and never the reader's homework.
  const sg = P.subgoalsPrompt({ reader, paper, direction, asset: dataset, leveled, previous: null, feedback: "" });
  const one = sg.indexOf("Subgoal 1, get the real thing into their hands"), two = sg.indexOf("Subgoal 2, make one representative example work end-to-end"), three = sg.indexOf("Subgoal 3, give them one meaningful thing to change, compare");
  assert.ok(one > 0 && two > one && three > two, "the progression, in order");
  assert.match(sg, /what one real example looks like/);
  assert.match(sg, /comparing two cases, changing one parameter, trying another input/);
  assert.match(sg, /"Learn the dataset"/);
  assert.match(sg, /"Decide what to analyze"/);
  assert.match(sg, /Understand/, "understanding the biology is not a subgoal either: it emerges from what the agent builds");
  assert.match(sg, /understanding that should emerge from interacting with what the agent builds/);

  // Todos for that first subgoal: the agent downloads, inspects and subsets the real dataset and exposes it; the reader chooses nothing yet.
  const todo = P.todosPrompt({ reader, paper, direction, subgoal: { label: "The dataset opens and shows what it holds", description: "A table of cells, cytokines and cell types, with one real cell shown." }, resources: [dataset] });
  assert.match(todo, /The first piece of it, the one to start on now: "The dataset opens and shows what it holds"/);
  assert.match(todo, /download or clone the relevant resource; inspect files, schemas/);
  assert.match(todo, /choose a small representative example or subset/);
  assert.match(todo, /smallest REAL subset/);
  assert.match(todo, /"explore the dataset", "choose a sample"/);
  assert.match(todo, /Do not build a polished application yet/);
});
