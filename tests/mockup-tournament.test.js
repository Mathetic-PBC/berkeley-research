"use strict";

// The bracket behind the mock-up page: single elimination with a third-place
// match, drawn as plain data. Picking the lower-numbered side every time
// makes each bracket resolve the same way, so the placings can be pinned.

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../engelbart/mockups/tournament.js");

const names = (n) => Array.from({ length: n }, (_, i) => "m" + String(i + 1).padStart(2, "0"));
const lowest = (cur) => (cur.a < cur.b ? cur.a : cur.b);
const highest = (cur) => (cur.a > cur.b ? cur.a : cur.b);
const times = (n, s) => Array.from({ length: n }, () => s);

// Play to the end, choosing with `choose`; the round each pick was made in comes back.
function play(t, choose = lowest) {
  const rounds = [];
  let guard = 0;
  while (!T.done(t)) {
    const cur = T.current(t);
    rounds.push(T.roundName(t, cur));
    assert.equal(T.placing(t), null, "no placing until the bracket is done");
    assert.ok(T.pick(t, choose(cur), "2026-09-08T00:00:00.000Z"));
    if ((guard += 1) > 1000) throw new Error("the bracket never ends");
  }
  return rounds;
}

test("sixteen mock-ups: eight, four, two, third place, final; sixteen picks and four places", () => {
  const t = T.create(names(16));
  assert.deepEqual(T.progress(t), { made: 0, total: 16 });
  const rounds = play(t);
  assert.deepEqual(rounds, [...times(8, "Round of 16"), ...times(4, "Quarterfinal"), ...times(2, "Semifinal"), "Third place", "Final"]);
  // 1 beats 9 in the final; the semifinal losers 5 and 13 meet for third.
  assert.deepEqual(T.placing(t), ["m01", "m09", "m05", "m13"]);
  assert.deepEqual(T.progress(t), { made: 16, total: 16 });
  assert.equal(t.picks.length, 16);
  assert.ok(t.picks.every((p) => (p.winner === p.a || p.winner === p.b) && p.at === "2026-09-08T00:00:00.000Z"));
});

test("nine mock-ups: one match and seven byes, then a full eight", () => {
  const t = T.create(names(9));
  assert.equal(t.rounds[0].matches.length, 1);
  assert.deepEqual(t.rounds[0].byes, names(9).slice(2));
  const rounds = play(t);
  assert.deepEqual(rounds, ["Round of 9", ...times(4, "Quarterfinal"), ...times(2, "Semifinal"), "Third place", "Final"]);
  assert.deepEqual(T.placing(t), ["m01", "m06", "m04", "m08"]);
  assert.deepEqual(T.progress(t), { made: 9, total: 9 });
});

test("small brackets: three leaves its one semifinal loser third, two is a final, one and none decide themselves", () => {
  const three = T.create(names(3));
  assert.deepEqual(play(three), ["Round of 3", "Final"]);
  assert.deepEqual(T.placing(three), ["m01", "m03", "m02"]);
  assert.deepEqual(T.progress(three), { made: 2, total: 2 });

  const two = T.create(names(2));
  assert.deepEqual(play(two), ["Final"]);
  assert.deepEqual(T.placing(two), ["m01", "m02"]);

  const one = T.create(names(1));
  assert.ok(T.done(one));
  assert.deepEqual(T.placing(one), ["m01"]);
  assert.deepEqual(T.progress(one), { made: 0, total: 0 });

  const none = T.create([]);
  assert.ok(T.done(none));
  assert.deepEqual(T.placing(none), []);
  assert.equal(T.current(none), null);
});

test("the winner is whichever side is picked; a pick outside the match changes nothing", () => {
  const t = T.create(names(4));
  const before = JSON.stringify(t);
  assert.equal(T.pick(t, "m09"), false);
  assert.equal(T.pick(t, null), false);
  assert.equal(T.pick(t, ""), false);
  assert.equal(JSON.stringify(t), before);
  assert.deepEqual(play(t, highest), [...times(2, "Semifinal"), "Third place", "Final"]);
  assert.deepEqual(T.placing(t), ["m04", "m02", "m03", "m01"]);
  assert.equal(T.pick(t, "m04"), false, "nothing is left to decide");
});

test("the state survives a JSON round trip and is restored only for the same mock-ups", () => {
  const t = T.create(names(5));
  assert.ok(T.pick(t, T.current(t).a));
  const stored = JSON.parse(JSON.stringify(t));
  const back = T.restore(stored, names(5).reverse());
  assert.ok(back);
  assert.deepEqual(T.progress(back), { made: 1, total: 5 });
  play(back);
  assert.equal(T.placing(back).length, 4);

  assert.equal(T.restore(stored, names(6)), null);
  assert.equal(T.restore(stored, names(4)), null);
  assert.equal(T.restore(null, names(5)), null);
  assert.equal(T.restore("nonsense", names(5)), null);
  assert.equal(T.restore({ entrants: names(5), rounds: "no", picks: [] }, names(5)), null);
  assert.equal(T.restore({ entrants: names(5), rounds: [{ matches: [{ a: "m01", b: "m02", winner: "m03" }], byes: [] }], picks: [] }, names(5)), null);
  assert.equal(T.restore({ entrants: names(5), rounds: [], picks: [], third: { a: "m01" } }, names(5)), null);
});

test("shuffle is a permutation that leaves the input alone", () => {
  const list = names(16);
  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const out = T.shuffle(list, random);
  assert.deepEqual([...out].sort(), list);
  assert.notDeepEqual(out, list);
  assert.deepEqual(list, names(16));
});

test("duplicate and empty ids are dropped before the bracket is drawn", () => {
  const t = T.create(["a", "a", "", null, "b"]);
  assert.deepEqual(t.entrants, ["a", "b"]);
  assert.deepEqual(T.progress(t), { made: 0, total: 1 });
});
