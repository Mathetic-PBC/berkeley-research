"use strict";

// The pure curated-selection helper that lets a participant's chosen papers be
// the preferred/allowed pool for generation, without the bundle ever copying
// canonical paper data -- it narrows and orders canonical rows by reference.

const test = require("node:test");
const assert = require("node:assert/strict");
const Curated = require("../api/_lib/curated");

test("selectPapers narrows canonical papers to a curated selection, in the curator's order", () => {
  const papers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(Curated.selectPapers(papers, ["b", "a"]).map((p) => p.id), ["b", "a"]);
});

test("selectPapers drops ids no longer in the canonical set", () => {
  const papers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(Curated.selectPapers(papers, ["c", "gone"]).map((p) => p.id), ["c"]);
});

test("selectPapers leaves the full set when there is no selection", () => {
  const papers = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(Curated.selectPapers(papers, []).map((p) => p.id), ["a", "b"]);
  assert.deepEqual(Curated.selectPapers(papers, null).map((p) => p.id), ["a", "b"]);
});

test("selectPapers falls back to the full set when a selection resolves to nothing", () => {
  const papers = [{ id: "a" }, { id: "b" }];
  // a stale selection must never blank the pool -- better the full set than none
  assert.deepEqual(Curated.selectPapers(papers, ["gone"]).map((p) => p.id), ["a", "b"]);
});

test("selectPapers returns canonical rows by reference, never copies", () => {
  const papers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(Curated.selectPapers(papers, ["b"])[0], papers[1]);
});
