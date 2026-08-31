const test = require("node:test");
const assert = require("node:assert/strict");
const Curated = require("../api/_lib/curated.js");

const PI = "11111111-1111-4111-8111-111111111111";
const STUDENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function bundleWith(lab) {
  return { version: 1, areas: [{ id: "a1", label: "Robotics", summary: "", labs: [lab] }] };
}

test("normalizeBundle keeps per-student notes keyed by a valid person id", () => {
  const notes = {};
  notes[STUDENT] = "MSC tells undergrads interested in soft robotics to contact this student.";
  notes["not-a-uuid"] = "dropped";
  notes[OTHER] = "   "; // blank after trim -> dropped
  const norm = Curated.normalizeBundle(bundleWith({
    pi_id: PI, student_ids: [STUDENT], student_notes: notes,
  }));
  const lab = norm.areas[0].labs[0];
  assert.deepEqual(Object.keys(lab.student_notes), [STUDENT]);
  assert.match(lab.student_notes[STUDENT], /soft robotics/);
});

test("normalizeBundle drops student_notes entirely when nothing survives", () => {
  const norm = Curated.normalizeBundle(bundleWith({
    pi_id: PI, student_notes: { "not-a-uuid": "x" },
  }));
  assert.equal(norm.areas[0].labs[0].student_notes, undefined);
  const none = Curated.normalizeBundle(bundleWith({ pi_id: PI }));
  assert.equal(none.areas[0].labs[0].student_notes, undefined);
});

test("normalizeBundle caps a student note at 2000 chars", () => {
  const notes = {};
  notes[STUDENT] = "x".repeat(5000);
  const norm = Curated.normalizeBundle(bundleWith({ pi_id: PI, student_notes: notes }));
  assert.equal(norm.areas[0].labs[0].student_notes[STUDENT].length, 2000);
});
