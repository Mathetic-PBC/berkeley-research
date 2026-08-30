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
  assert.equal(payload.subgoals.length, 6);
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
