"use strict";

// The canonical-paper reference must survive the web setup pipeline: an
// exploration that names a paper -> explorationToPayload -> normalizePayload ->
// the stored payload. Only a valid canonical id (bounded title/url) may ride,
// and nothing that isn't the id -- no PDF, no signed URL, no storage path.

const test = require("node:test");
const assert = require("node:assert/strict");
const SetupChat = require("../api/_lib/setup-chat");
const RM = require("../api/_lib/research-model");

const PID = "11111111-2222-3333-4444-555555555555";

test("normalizePayload carries a valid canonical paper ref, bounded", () => {
  const out = SetupChat.normalizePayload({
    name: "Study drift",
    plan: { description: "d", unsure: [] },
    goals: [{ label: "Study drift", why: "w" }],
    chosen: "Study drift",
    subgoals: [],
    paper: { paper_id: PID, title: "  A   Paper ", url: "https://doi.org/x" },
  });
  assert.deepEqual(out.paper, {
    paper_id: PID, title: "A Paper", url: "https://doi.org/x",
  });
});

test("normalizePayload drops a paper ref with no valid id", () => {
  const out = SetupChat.normalizePayload({
    name: "n", chosen: "n", paper: { paper_id: "not-a-uuid", title: "t" },
  });
  assert.equal("paper" in out, false);
});

test("normalizePayload never keeps a pdf, path, or signed url on the ref", () => {
  const out = SetupChat.normalizePayload({
    name: "n", chosen: "n",
    paper: { paper_id: PID, title: "t", url: "https://s/x",
             pdf: "/etc/passwd", pdf_path: "papers/x.pdf", signedUrl: "https://s/signed" },
  });
  assert.deepEqual(Object.keys(out.paper).sort(), ["paper_id", "title", "url"]);
});

test("normalizePayload rejects a non-http url on the ref", () => {
  const out = SetupChat.normalizePayload({
    name: "n", chosen: "n",
    paper: { paper_id: PID, title: "t", url: "javascript:alert(1)" },
  });
  assert.equal(out.paper.url, "");
});

test("explorationToPayload passes a paper through for normalization", () => {
  const payload = RM.explorationToPayload({
    name: "Idea", objective: "obj",
    lanes: { brainstorm: ["one"] },
    lab: { lab_name: "Lab", pi_name: "PI" },
    paper: { paper_id: PID, title: "T", url: "https://doi.org/x" },
  });
  assert.deepEqual(payload.paper, { paper_id: PID, title: "T", url: "https://doi.org/x" });
  // and it survives the bounding pass that save_path runs it through
  const bounded = SetupChat.normalizePayload(payload);
  assert.equal(bounded.paper.paper_id, PID);
});

test("explorationToPayload omits paper when none is given (byte-identical)", () => {
  const payload = RM.explorationToPayload({
    name: "Idea", objective: "obj", lanes: { brainstorm: ["one"] }, lab: {},
  });
  assert.equal("paper" in payload, false);
});
