/* The bracket behind /engelbart/mockups: single elimination over the
 * mock-ups, two at a time, until four places are decided. Pure data in and
 * out -- the state is a plain object the page keeps in localStorage between
 * picks, so a refresh resumes where it left off, and node tests drive it
 * with no document at all.
 *
 * The first round fills a bracket whose size is the next power of two: the
 * entrants that do not fit into the half play, the rest sit out, and every
 * later round is full. The round that leaves two also leaves two losers,
 * who meet for third place before the final. Sixteen mock-ups: eight, four,
 * two, third place, final -- sixteen picks. */
(function attachEngelbartTournament(root, factory) {
  var mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  root.EngelbartTournament = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEngelbartTournament() {
  "use strict";

  var PLACES = 4;

  function ids(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (v) {
      var id = v == null ? "" : String(v);
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  // Fisher-Yates over a copy; `random` is injectable so a test can fix it.
  function shuffle(list, random) {
    var out = (list || []).slice(), r = random || Math.random;
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(r() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  // Nine entrants: one match, seven byes, then eight. Sixteen: eight matches.
  function firstRound(entrants) {
    var n = entrants.length, size = 1;
    while (size < n) size *= 2;
    var matches = n > 1 ? n - size / 2 : 0;
    var round = { matches: [], byes: [] };
    for (var i = 0; i < matches; i += 1) round.matches.push({ a: entrants[2 * i], b: entrants[2 * i + 1], winner: null });
    for (var j = 2 * matches; j < n; j += 1) round.byes.push(entrants[j]);
    return round;
  }

  function nextRound(advancing) {
    var round = { matches: [], byes: [] };
    for (var i = 0; i + 1 < advancing.length; i += 2) round.matches.push({ a: advancing[i], b: advancing[i + 1], winner: null });
    if (advancing.length % 2) round.byes.push(advancing[advancing.length - 1]);
    return round;
  }

  function complete(round) { return round.matches.every(function (m) { return m.winner; }); }
  function loser(m) { return m.winner === m.a ? m.b : m.a; }
  function winners(round) { return round.matches.map(function (m) { return m.winner; }).concat(round.byes); }
  function losers(round) { return round.matches.filter(function (m) { return m.winner; }).map(loser); }

  // After a pick: once the round is done, either one is left (the champion)
  // or the next round is drawn. Two left means the round's two losers meet
  // for third place first.
  function settle(t) {
    var last = t.rounds[t.rounds.length - 1];
    if (!last || !complete(last)) return;
    var adv = winners(last);
    if (adv.length <= 1) return;
    if (adv.length === 2 && !t.third) {
      var out = losers(last);
      if (out.length === 2) t.third = { a: out[0], b: out[1], winner: null };
    }
    t.rounds.push(nextRound(adv));
  }

  function create(list) {
    var entrants = ids(list);
    var t = { entrants: entrants, rounds: [], third: null, picks: [] };
    if (entrants.length) { t.rounds.push(firstRound(entrants)); settle(t); }
    return t;
  }

  // The match to show now: third place once it is set, else the first
  // unplayed match of the current round; null once everything is decided.
  function current(t) {
    if (t.third && !t.third.winner) return { kind: "third", a: t.third.a, b: t.third.b, index: 0, of: 1 };
    var last = t.rounds[t.rounds.length - 1];
    if (!last) return null;
    for (var i = 0; i < last.matches.length; i += 1) {
      var m = last.matches[i];
      if (!m.winner) return { kind: "round", round: t.rounds.length - 1, index: i, of: last.matches.length, a: m.a, b: m.b };
    }
    return null;
  }

  // The better of the two on screen. False, and nothing changes, when the
  // id is not one of them or there is nothing left to decide.
  function pick(t, winner, at) {
    var cur = current(t);
    var id = winner == null ? "" : String(winner);
    if (!cur || (id !== cur.a && id !== cur.b)) return false;
    var m = cur.kind === "third" ? t.third : t.rounds[cur.round].matches[cur.index];
    m.winner = id;
    t.picks.push({ a: cur.a, b: cur.b, winner: id, at: at || new Date().toISOString() });
    if (cur.kind !== "third") settle(t);
    return true;
  }

  function done(t) { return !current(t); }

  // First to fourth: the final's winner and loser, then third place's, or
  // the one semifinal loser a bracket of three leaves. Null until done.
  function placing(t) {
    if (!done(t)) return null;
    var n = t.rounds.length, last = t.rounds[n - 1], out = [];
    if (!last) return out;
    if (last.matches.length === 1) out.push(last.matches[0].winner, loser(last.matches[0]));
    else out.push.apply(out, last.byes);
    if (t.third) out.push(t.third.winner, loser(t.third));
    else if (n > 1) out.push.apply(out, losers(t.rounds[n - 2]));
    return out.slice(0, PLACES);
  }

  // Picks made and picks in all: n - 1 matches decide a champion, and one
  // more decides third place when there were four or more to begin with.
  function progress(t) {
    var n = t.entrants.length;
    return { made: t.picks.length, total: n > 0 ? n - 1 + (n >= 4 ? 1 : 0) : 0 };
  }

  function roundName(t, cur) {
    if (!cur) return "";
    if (cur.kind === "third") return "Third place";
    var round = t.rounds[cur.round];
    var count = round.matches.length * 2 + round.byes.length;
    if (count === 2) return "Final";
    if (count === 4) return "Semifinal";
    if (count === 8) return "Quarterfinal";
    return "Round of " + count;
  }

  // A stored state is taken back only when it was drawn from the same
  // entrants; anything else, and the bracket starts again.
  function restore(state, list) {
    if (!state || typeof state !== "object") return null;
    if (!Array.isArray(state.entrants) || !Array.isArray(state.rounds) || !Array.isArray(state.picks)) return null;
    var want = ids(list).sort(), have = ids(state.entrants).sort();
    if (want.length !== have.length || have.length !== state.entrants.length) return null;
    for (var i = 0; i < want.length; i += 1) if (want[i] !== have[i]) return null;
    var okMatch = function (m) { return m && typeof m === "object" && typeof m.a === "string" && typeof m.b === "string" && (m.winner === null || m.winner === m.a || m.winner === m.b); };
    for (var r = 0; r < state.rounds.length; r += 1) {
      var round = state.rounds[r];
      if (!round || !Array.isArray(round.matches) || !Array.isArray(round.byes) || !round.matches.every(okMatch)) return null;
    }
    if (state.third !== null && state.third !== undefined && !okMatch(state.third)) return null;
    return { entrants: state.entrants.slice(), rounds: state.rounds, third: state.third || null, picks: state.picks };
  }

  return {
    PLACES: PLACES,
    create: create,
    current: current,
    pick: pick,
    done: done,
    placing: placing,
    progress: progress,
    roundName: roundName,
    restore: restore,
    shuffle: shuffle,
  };
});
