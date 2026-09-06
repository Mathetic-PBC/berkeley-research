#!/usr/bin/env node
"use strict";

// Regenerates docs/observability/example-onboarding-analysis-run.json.
//
//   node scripts/telemetry-example.js
//
// The fixture is not written by hand. It is what the REAL onboarding code
// emits -- the dispatcher, the record module, the model client, the storage,
// page-fetch and PostgREST boundaries -- run against an in-memory Supabase,
// Storage, model gateway and web, with detailed capture on. So every field
// in it is a field the implementation produces, in the shape the
// implementation produces it, and a design built against the fixture is a
// design built against the backend. Durations are those of the local run;
// in production the model call takes 30 to 90 seconds.

process.env.VERCEL_ENV = process.env.VERCEL_ENV || "preview";
process.env.VERCEL_GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA || "61d30bd0c0ffee00";
process.env.VERCEL_DEPLOYMENT_ID = process.env.VERCEL_DEPLOYMENT_ID || "dpl_ExampleDeploymentId0000";
process.env.ENGELBART_TRACE_CONTENT = "true";
delete process.env.ENGELBART_TELEMETRY_STORE;
delete process.env.ENGELBART_TELEMETRY_LOG;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { telemetry, MemorySink, bundle } = require("../api/_lib/telemetry");
const handler = require("../api/engelbart-onboarding");
const setupHandler = require("../api/engelbart-setup");

const OUT = path.resolve(__dirname, "../docs/observability/example-onboarding-analysis-run.json");

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-example-000000000000",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-example-000000000000",
  LITELLM_BASE_URL: "https://proxy.example.com",
  LITELLM_MASTER_KEY: "sk-master-example-000000000000",
  ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
};
const USER = { id: "8d4a2f7e-1c3b-4e5d-9a6f-0b1c2d3e4f5a", email: "reader@example.edu" };
const PAPER = "3f9c1b2a-7d8e-4f60-b1c2-d3e4f5a6b7c8";
const CREDS = { status: "active", apiKey: "sk-member-example-key-000000000000", baseUrl: "https://proxy.example.com",
  models: ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"], budgetUsd: 25, spendUsd: 3.41 };

function ladder(area, questions) {
  return [0, 25, 50, 75, 100].map((level, i) => ({ level, question: questions[i], sample_response: `A ${area} answer at level ${level}.` }));
}
const ANALYSIS = {
  title: "Speculative Decoding for Fast LLM Inference",
  one_liner: "A small draft model proposes several tokens at once and the large model verifies them in one pass, cutting latency without changing the output distribution.",
  date: "2023-02",
  areas: [
    { area: "Transformer inference", parent_field: "Machine learning systems", project_role: "The paper's whole contribution is a change to how a transformer generates tokens.",
      granularity_rationale: "Broad enough to cover decoding, narrow enough to exclude training.",
      questions: ladder("transformer inference", ["Have you used a chatbot that streams its answer word by word?", "Why does a language model produce one token at a time?",
        "What is the KV cache and why does it make decoding memory-bound?", "How would you measure whether a decoding change kept the output distribution unchanged?",
        "Derive the expected number of accepted draft tokens per verification step as a function of draft acceptance rate."]) },
    { area: "Probability and rejection sampling", parent_field: "Statistics", project_role: "Verification accepts or rejects draft tokens with a rejection-sampling rule that keeps the target distribution exact.",
      granularity_rationale: "The acceptance rule is the mathematical core.",
      questions: ladder("probability", ["Have you flipped a weighted coin in code?", "What does it mean for two probability distributions to be the same?",
        "Explain rejection sampling in one paragraph.", "Why does accepting a token with probability min(1, p/q) preserve the target distribution?",
        "Show the residual distribution used after a rejection is a valid probability distribution."]) },
    { area: "GPU performance engineering", parent_field: "Computer systems", project_role: "The speedup exists because verifying several tokens costs about the same as generating one.",
      granularity_rationale: "Kernels and batching, not general programming.",
      questions: ladder("GPU", ["Have you run a program on a GPU?", "What is the difference between latency and throughput?",
        "Why is batching several tokens into one forward pass nearly free on a GPU?", "How would you profile whether a decoding loop is memory-bound or compute-bound?",
        "Estimate the roofline crossover batch size for a 7B model on an A100."]) },
  ],
};

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"), crypto.randomBytes(24 * 1024), Buffer.from("\n%%EOF\n")]);
const PROJECT_PAGE = "<html><head><title>Speculative Decoding</title><style>p{}</style></head><body><h1>Speculative Decoding</h1><p>Project page for the paper. Code, slides and a demo.</p><a href='https://github.com/example/specdec'>Code</a></body></html>";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An in-memory PostgREST, Storage, model gateway and web, with the small
// delays real services have, so the fixture's durations are not all zero.
function fake() {
  const tables = { engelbart_onboardings: [], engelbart_onboarding_calibrations: [], engelbart_onboarding_turns: [] };
  let ids = 0;
  const match = (row, query) => [...new URLSearchParams(query)].every(([k, v]) => {
    if (["select", "order", "limit", "on_conflict"].includes(k)) return true;
    const m = /^eq\.(.*)$/.exec(v);
    return m ? String(row[k]) === m[1] : true;
  });
  const json = (value, status = 200, headers = {}) => ({ ok: status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    async text() { return JSON.stringify(value); }, async json() { return value; } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname.startsWith("/rest/v1/")) {
      await sleep(6 + Math.random() * 10);
      const table = u.pathname.slice("/rest/v1/".length);
      const rows = tables[table] || (tables[table] = []);
      if (method === "GET") return json(rows.filter((r) => match(r, u.search)));
      if (method === "POST") {
        const made = body.map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
        rows.push(...made);
        ids += made.length;
        return json(made, 201);
      }
      if (method === "PATCH") { const hit = rows.filter((r) => match(r, u.search)); hit.forEach((r) => Object.assign(r, body)); return json(hit); }
      if (method === "DELETE") { const keep = rows.filter((r) => !match(r, u.search)); rows.splice(0, rows.length, ...keep); return json(null, 204); }
    }
    if (u.pathname.startsWith("/storage/v1/object/")) {
      await sleep(45);
      return { ok: true, status: 200, headers: { get: (k) => ({ "content-length": String(PDF.length), "content-type": "application/pdf" })[k.toLowerCase()] || null },
        async arrayBuffer() { return PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength); }, async text() { return ""; } };
    }
    if (u.pathname === "/v1/messages") {
      await sleep(140);
      return json({
        id: "msg_01ExampleSpeculativeDecoding", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify(ANALYSIS) }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1843, output_tokens: 1276, cache_creation_input_tokens: 21470, cache_read_input_tokens: 0 },
      });
    }
    if (u.hostname === "specdec.example.edu") {
      await sleep(30);
      return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) }, async text() { return PROJECT_PAGE; } };
    }
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { tables, options: { env: ENV, fetchImpl } };
}

async function main() {
  telemetry.configure({ captureContent: true, tracePolls: false });
  const sink = new MemorySink();
  telemetry.addSink(sink);
  const db = fake();
  const deps = { credentialsFor: async () => CREDS, options: db.options, testRunId: "design-fixture-001", mode: "fixture" };

  // The page opens, the reader has already said who they are, and attaches
  // the paper; the page then starts the reading and polls while it runs.
  await handler.dispatch(USER, { action: "open" }, deps);
  await handler.dispatch(USER, { action: "step", step: 4, fields: { name: "Maya", year: "Second year", major: "Cognitive Science", depth: "technical" } }, deps);
  await handler.dispatch(USER, { action: "sources", paper_id: PAPER, paper_token: setupHandler.ownPaperToken(PAPER, USER.id, ENV),
    project_url: "https://specdec.example.edu/paper?utm_source=share", repo_url: "", paper_familiarity: 2 }, deps);
  await handler.dispatch(USER, { action: "analysis" }, deps);            // a poll: untraced, absent below
  const out = await handler.dispatch(USER, { action: "analysis", run: true }, deps);
  if (out.analysis_status !== "done") throw new Error(`the analysis did not finish: ${JSON.stringify(out)}`);
  await handler.dispatch(USER, { action: "analysis" }, deps);            // the poll that finds it done: also absent
  await telemetry.flush();

  const envelope = bundle(sink);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(envelope, null, 2)}\n`);
  const names = envelope.operations.map((o) => o.name);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${envelope.operations.length} operations in ${envelope.run.trace_ids.length} traces, `
    + `${envelope.snapshots.length} snapshots, ${envelope.events.length} events`);
  console.log(names.join(", "));
}

main().catch((error) => { console.error(error); process.exit(1); });
