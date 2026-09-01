"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const SetupChat = require("../api/_lib/setup-chat");

const CREDENTIALS = {
  apiKey: "sk-member-key",
  baseUrl: "https://proxy.example.com",
  models: ["all-proxy-models"],
};

function modelSaying(replies, capture) {
  let index = 0;
  return async function fetchImpl(url, options) {
    const body = JSON.parse(options.body);
    if (capture) capture.push({ url, body, headers: options.headers });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { content: [{ type: "text", text: JSON.stringify(reply) }] };
      },
    };
  };
}

test("the first card due is always a round of questions", () => {
  assert.equal(SetupChat.stageOf([]), "questions");
  assert.equal(SetupChat.stageOf(["questions"]), "plan");
  assert.equal(SetupChat.stageOf(["questions", "questions"]), "plan");
  assert.equal(SetupChat.stageOf(["questions", "plan"]), "goals");
  assert.equal(SetupChat.stageOf(["questions", "plan", "goals"]), "todos");
  assert.equal(SetupChat.stageOf(["questions", "plan", "goals", "todos"]), "none");
  // Cards that are not stages never advance the order.
  assert.equal(SetupChat.stageOf(["none", "nonsense"]), "questions");
});

test("the transcript is bounded from the oldest end and voiced for the model", () => {
  const transcript = [];
  for (let index = 0; index < 60; index += 1) {
    transcript.push({ role: index % 2 ? "you" : "engelbart", text: `turn ${index}` });
  }
  const lines = SetupChat.compose(transcript, []);
  const spoken = lines.filter((line) => /^(you|them): /.test(line));
  assert.equal(spoken.length, SetupChat.MAX_TURNS);
  assert.equal(spoken[0], "you: turn 20");
  // The reader's turns read as "them": the model is the "you" of the form.
  assert.equal(spoken[1], "them: turn 21");
});

test("normalizeCard bounds every payload and refuses an empty card", () => {
  const card = SetupChat.normalizeCard({
    say: `  ${"x".repeat(3000)}  `,
    card: "questions",
    questions: {
      eyebrow: "scope check",
      items: [
        { title: "t".repeat(500), type: "mcq", options: ["a", { label: "b", why: "w" }] },
        { title: "typed", type: "mcq", options: [] },
        { title: "", type: "free" },
      ],
    },
  });
  assert.equal(card.card, "questions");
  assert.equal(card.say.length, 1200);
  assert.equal(card.questions.items.length, 2);
  assert.equal(card.questions.items[0].title.length, 200);
  assert.deepEqual(card.questions.items[0].options[1], { label: "b", why: "w" });
  // A choice with nothing to choose from becomes a box to type in.
  assert.equal(card.questions.items[1].type, "free");
  assert.equal(SetupChat.normalizeCard({ card: "plan", plan: {} }).card, "none");
  assert.equal(SetupChat.normalizeCard({ card: "sideways" }).card, "none");
});

test("a bare payload has its envelope put back by shape", () => {
  assert.equal(SetupChat.normalizeCard({ items: [{ title: "q" }] }).card, "questions");
  assert.equal(SetupChat.normalizeCard({ description: "the work" }).card, "plan");
  assert.equal(SetupChat.normalizeCard([{ label: "an outcome" }]).card, "goals");
  assert.equal(SetupChat.normalizeCard(["a row"]).card, "todos");
  const viaSubgoals = SetupChat.normalizeCard({
    subgoals: [{ label: "piece", todos: ["row"] }],
  });
  assert.equal(viaSubgoals.card, "todos");
  assert.equal(viaSubgoals.subgoals.length, 1);
});

test("an approved payload is bounded before it can be stored", () => {
  const payload = SetupChat.normalizePayload({
    name: `  My ${"long ".repeat(40)}Project  `,
    plan: { description: "d".repeat(5000), unsure: Array(20).fill("gap") },
    goals: Array(20).fill({ label: "g", why: "w" }),
    chosen: "g",
    todos: Array(50).fill("row"),
    subgoals: Array(20).fill({ label: "piece", todos: ["row"] }),
  });
  assert.equal(payload.name.length, 80);
  assert.equal(payload.plan.description.length, 2400);
  assert.equal(payload.plan.unsure.length, 6);
  assert.equal(payload.goals.length, 8);
  assert.equal(payload.todos.length, 20);
  // A generated project fans a phase into several goals, so the subgoal cap is
  // 12 (an Understand goal per paper, several Implement goals, etc.).
  assert.equal(payload.subgoals.length, 12);
});

test("the account's own dated sonnet wins; the alias never reaches the proxy", () => {
  assert.equal(SetupChat.pickModel(["claude-sonnet-4-5-20250929"]), "claude-sonnet-4-5-20250929");
  // A bare alias is what an unconnected subscription understands, not the
  // gateway: it is passed over in favour of the dated fallback.
  assert.equal(SetupChat.pickModel(["sonnet"]), SetupChat.FALLBACK_MODEL);
  assert.equal(SetupChat.pickModel(["all-proxy-models"]), SetupChat.FALLBACK_MODEL);
  assert.equal(SetupChat.pickModel(undefined), SetupChat.FALLBACK_MODEL);
});

test("a turn bills the member's key and forces the due card into the prompt", async () => {
  const calls = [];
  const result = await SetupChat.turn({
    transcript: [{ role: "you", text: "a nuclear reactor simulator" }],
    shown: [],
    credentials: CREDENTIALS,
  }, {
    fetchImpl: modelSaying([{
      say: "Two questions first.",
      card: "questions",
      questions: { eyebrow: "scope", items: [{ title: "New or existing?", type: "free" }] },
    }], calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.due, "questions");
  assert.equal(result.card, "questions");
  assert.equal(calls[0].url, "https://proxy.example.com/v1/messages");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-member-key");
  const prompt = calls[0].body.messages[0].content;
  assert.match(prompt, /this is a questions card/);
  assert.match(prompt, /them: a nuclear reactor simulator/);
});

test("a card out of turn is discarded, retried once, then kept as prose", async () => {
  // Reply 1: a silent plan when questions are due -> retried. Reply 2: still
  // the wrong card -> the say survives, the card does not.
  const calls = [];
  const result = await SetupChat.turn({
    transcript: [{ role: "you", text: "hello" }],
    shown: [],
    credentials: CREDENTIALS,
  }, {
    fetchImpl: modelSaying([
      { card: "plan", plan: { description: "premature plan" } },
      { say: "kept words", card: "plan", plan: { description: "still premature" } },
    ], calls),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[0].content, /That reply was discarded/);
  assert.equal(result.ok, true);
  assert.equal(result.card, "none");
  assert.equal(result.say, "kept words");
  assert.equal(result.plan.description, "");
});

test("a gateway refusal surfaces as an error, never as an empty card", async () => {
  const result = await SetupChat.turn({
    transcript: [], shown: [], credentials: CREDENTIALS,
  }, {
    async fetchImpl() {
      return { ok: false, status: 502, async json() { return { error: { message: "proxy down" } }; } };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /proxy down/);
  // A 401/429 from the proxy is the member's credit talking, and is thrown
  // so the endpoint answers 409 rather than reporting a broken model.
  await assert.rejects(
    SetupChat.turn({ transcript: [], shown: [], credentials: CREDENTIALS }, {
      async fetchImpl() {
        return { ok: false, status: 429, async json() { return {}; } };
      },
    }),
    (error) => error.statusCode === 409,
  );
});

test("a second round of questions is open while the plan is due, and only one", () => {
  // The stage never moves backwards -- the plan stays due throughout -- but
  // the model is allowed to ask once more before it has to write one.
  assert.deepEqual(SetupChat.allowedCards([]), ["questions"]);
  assert.deepEqual(SetupChat.allowedCards(["questions"]), ["plan", "questions"]);
  assert.equal(SetupChat.stageOf(["questions"]), "plan");
  // Two rounds spent: the door is shut and the plan is the only card left.
  assert.deepEqual(SetupChat.allowedCards(["questions", "questions"]), ["plan"]);
  // Past the plan, the order is strict again.
  assert.deepEqual(SetupChat.allowedCards(["questions", "plan"]), ["goals"]);
});

test("a follow-up questions card at the plan stage is drawn, not discarded", async () => {
  // The regression this covers: with only `plan` allowed, this card was thrown
  // away, its questions survived as prose, `shown` never grew, and the reader
  // was asked the same thing every round with nothing to answer.
  const calls = [];
  const result = await SetupChat.turn({
    transcript: [{ role: "you", text: "machine learning" }],
    shown: ["questions"],
    credentials: CREDENTIALS,
  }, {
    fetchImpl: modelSaying([{
      say: "One thing first.",
      card: "questions",
      questions: { eyebrow: "the task", items: [{ title: "Predicting what?", type: "free" }] },
    }], calls),
  });
  assert.equal(calls.length, 1, "a permitted card is never retried");
  assert.equal(result.ok, true);
  assert.equal(result.card, "questions");
  assert.equal(result.questions.items.length, 1);
  // The plan is still what the stage is waiting for.
  assert.equal(result.due, "plan");
  assert.match(calls[0].body.messages[0].content, /this is the round it is open on/);
});

test("the last round of questions spent, the model is told to write the plan anyway", async () => {
  const calls = [];
  const result = await SetupChat.turn({
    transcript: [{ role: "you", text: "machine learning" }],
    shown: ["questions", "questions"],
    credentials: CREDENTIALS,
  }, {
    fetchImpl: modelSaying([
      { say: "Still unclear.", card: "questions",
        questions: { eyebrow: "again", items: [{ title: "Predicting what?", type: "free" }] } },
      { say: "Here is what I think.", card: "plan",
        plan: { description: "a classifier over student behaviour", unsure: ["which behaviour"] } },
    ], calls),
  });
  assert.match(calls[0].body.messages[0].content, /asked every round of questions there is/);
  // A third round is out of turn now, so it is discarded and retried.
  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.card, "plan");
  assert.equal(result.plan.unsure.length, 1);
});

test("prose when a card is due is pushed once more before it is let through", async () => {
  // Nothing drawn means `shown` does not grow, which means the same card is
  // due next round: this is the loop that talked at the reader forever.
  const calls = [];
  const result = await SetupChat.turn({
    transcript: [{ role: "you", text: "i approve" }],
    shown: ["questions"],
    credentials: CREDENTIALS,
  }, {
    fetchImpl: modelSaying([
      { say: "I need to understand more first.", card: "none" },
      { say: "Here is what I think.", card: "plan",
        plan: { description: "a classifier over student behaviour", unsure: [] } },
    ], calls),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[0].content, /replied with prose and no card/);
  assert.equal(result.ok, true);
  assert.equal(result.card, "plan");
});

test("prose twice over keeps the words rather than losing the round", async () => {
  const result = await SetupChat.turn({
    transcript: [{ role: "you", text: "hello" }],
    shown: ["questions"],
    credentials: CREDENTIALS,
  }, {
    fetchImpl: modelSaying([{ say: "kept words", card: "none" }]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.card, "none");
  assert.equal(result.say, "kept words");
});
