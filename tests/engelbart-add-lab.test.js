"use strict";

// "Add a lab by link": a member-pasted URL is fetched server-side, the page's
// text is the model's ONLY source, and the extraction is bounded before it
// becomes canonical rows. The URL guard keeps the fetch on public hostnames.

const test = require("node:test");
const assert = require("node:assert/strict");
const PageFetch = require("../api/_lib/page-fetch");
const RM = require("../api/_lib/research-model");

const CREDS = { apiKey: "k", baseUrl: "https://p", models: ["all"] };

test("safeHttpUrl accepts public http(s) pages only", () => {
  assert.equal(PageFetch.safeHttpUrl("https://msc.berkeley.edu/people.html"),
    "https://msc.berkeley.edu/people.html");
  assert.equal(PageFetch.safeHttpUrl("  http://lab.example.org  "),
    "http://lab.example.org/");
  for (const bad of [
    "", "not a url", "ftp://x.org/a", "file:///etc/passwd",
    "https://localhost/admin", "https://foo.localhost/", "https://db.internal/",
    "https://10.0.0.1/", "https://[::1]/", "https://intranet/", "https://x.local/",
  ]) {
    assert.throws(() => PageFetch.safeHttpUrl(bad), /public link/, bad || "(empty)");
  }
});

test("pageText strips markup and bounds the result", () => {
  const text = PageFetch.pageText(
    "<html><head><style>.x{color:red}</style><script>evil()</script></head>"
    + "<body><h1>Soft &amp; Squishy Lab</h1><p>Led by Prof&nbsp;Lee.</p>"
    + "<!-- hidden --></body></html>");
  assert.equal(text, "Soft & Squishy Lab Led by Prof Lee.");
  assert.ok(PageFetch.pageText("a".repeat(50000)).length <= 20000);
});

test("normalizeLabExtract bounds every list and drops nameless entries", () => {
  const found = RM.normalizeLabExtract({
    pi: { name: "  Prof   Lee ", title: "Professor", bio: "Robots.",
          interests: ["soft robotics", "", null, "grippers"] },
    lab_name: "Squishy Lab", department: "ME",
    students: [{ name: "Stu One", title: "PhD student" }, { title: "no name" }, "junk"],
    projects: Array(20).fill({ title: "P", description: "d" }),
    papers: [
      { title: "Paper", year: 2024, venue: "EML", url: "https://doi.org/x" },
      { title: "Old", year: 12, venue: "" },              // silly year -> null
      { year: 2020 },                                     // no title -> dropped
    ],
  });
  assert.equal(found.pi.name, "Prof Lee");
  assert.deepEqual(found.pi.interests, ["soft robotics", "grippers"]);
  assert.equal(found.students.length, 1);
  assert.equal(found.projects.length, 8);                 // MAX_EXTRACT_PROJECTS
  assert.equal(found.papers.length, 2);
  assert.equal(found.papers[0].year, 2024);
  assert.equal(found.papers[1].year, null);
});

test("extractLab grounds the model in the page text and forbids invention", async () => {
  let body = null;
  const capture = async function fetchImpl(url, init) {
    body = JSON.parse(init.body);
    return { ok: true, status: 200,
      async json() {
        return { content: [{ type: "text", text: JSON.stringify({
          pi: { name: "Prof Lee" }, lab_name: "Squishy Lab" }) }] };
      } };
  };
  const found = await RM.extractLab(
    { url: "https://lab.example.org", text: "Squishy Lab, led by Prof Lee",
      hint: "soft robotics lab" },
    CREDS, { fetchImpl: capture });
  assert.equal(found.pi.name, "Prof Lee");
  assert.equal(found.lab_name, "Squishy Lab");
  const prompt = body.messages[0].content;
  assert.match(prompt, /Squishy Lab, led by Prof Lee/);   // the page text is in
  assert.match(prompt, /never invent/);
  assert.match(prompt, /soft robotics lab/);              // the student's hint
});

test("extractLab throws on an unusable reply", async () => {
  const unusable = async function fetchImpl() {
    return { ok: true, status: 200,
      async json() { return { content: [{ type: "text", text: "not json" }] }; } };
  };
  await assert.rejects(
    RM.extractLab({ url: "https://x.org", text: "t" }, CREDS, { fetchImpl: unusable }),
    /could not be read as a lab/);
});

test("fetchPageText turns network and HTTP failures into friendly errors", async () => {
  await assert.rejects(
    PageFetch.fetchPageText("https://x.org", {
      fetchImpl: async () => { throw new Error("boom"); } }),
    /could not be reached/);
  await assert.rejects(
    PageFetch.fetchPageText("https://x.org", {
      fetchImpl: async () => ({ ok: false, status: 403, async text() { return ""; } }) }),
    /answered 403/);
  await assert.rejects(
    PageFetch.fetchPageText("https://x.org", {
      fetchImpl: async () => ({ ok: true, status: 200,
        async text() { return "<script>only()</script>"; } }) }),
    /no readable text/);
  assert.equal(
    await PageFetch.fetchPageText("https://x.org", {
      fetchImpl: async () => ({ ok: true, status: 200,
        async text() { return "<p>Hello lab</p>"; } }) }),
    "Hello lab");
});
