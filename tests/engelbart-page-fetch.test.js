"use strict";

// The brief's link layer: finding the links inside pasted prose, rewriting the
// ones that are unreadable as text (an arXiv PDF for its abstract page), and
// refusing everything that is not the public web. The fetch itself and the
// hostname guard are exercised in engelbart-add-lab.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const PageFetch = require("../api/_lib/page-fetch");

test("the links in a brief are found, cleaned, deduped and bounded", () => {
  const brief = [
    "Sagar Karandikar",
    "https://sagark.org/",
    "https://arxiv.org/pdf/2606.27350",
    "https://docs.chialoops.ai/en/latest/getting-started/chia-basics.html",
    "Git pull https://github.com/ucb-bar/chia.git",
    "again: https://sagark.org/",
  ].join("\n");
  assert.deepEqual(PageFetch.linksIn(brief), [
    "https://sagark.org/",
    // an arXiv PDF is unreadable as text, so it is read as its abstract page
    "https://arxiv.org/abs/2606.27350",
    "https://docs.chialoops.ai/en/latest/getting-started/chia-basics.html",
    "https://github.com/ucb-bar/chia.git",
  ]);
});

test("a brief cannot be used to reach anything but the public web", () => {
  // The same guard add-a-lab uses: a member-pasted link never becomes a
  // request to the loopback, the metadata endpoint, or a private suffix.
  const hostile = [
    "http://localhost:3000/admin",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/iam/",
    "http://[::1]/",
    "http://db.internal/dump",
    "file:///etc/passwd",
  ].join("\n");
  assert.deepEqual(PageFetch.linksIn(hostile), []);
});

test("trailing prose punctuation is not part of the link", () => {
  assert.deepEqual(PageFetch.linksIn("read https://example.com/a."), ["https://example.com/a"]);
  assert.deepEqual(PageFetch.linksIn("(see https://example.com/b)"), ["https://example.com/b"]);
});

test("a link dump is capped so one paste cannot fan out unbounded fetches", () => {
  const many = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`).join(" ");
  assert.equal(PageFetch.linksIn(many).length, PageFetch.MAX_BRIEF_LINKS);
});
