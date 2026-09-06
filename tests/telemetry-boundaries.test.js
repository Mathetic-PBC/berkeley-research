"use strict";

// The instrumented boundaries, through the real modules: the model client,
// PostgREST, Storage, page fetch, the dispatcher's workflow and poll rule, and
// the whole paper-analysis path as one trace.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { telemetry, MemorySink, tree } = require("../api/_lib/telemetry");
const OM = require("../api/_lib/onboarding-model");
const OB = require("../api/_lib/onboarding");
const Storage = require("../api/_lib/storage");
const PageFetch = require("../api/_lib/page-fetch");
const Supabase = require("../api/_lib/supabase");
const handler = require("../api/engelbart-onboarding");
const setupHandler = require("../api/engelbart-setup");

const SERVICE_KEY = "service-role-key-must-never-appear-0000";
const MEMBER_KEY = "sk-member-key-must-never-appear-0000";
const ENV = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon-key-0000000000",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, LITELLM_BASE_URL: "https://proxy.example.com",
  LITELLM_MASTER_KEY: "sk-master-0000000000", ENGELBART_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
};
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "m@example.com" };
const PAPER = "22222222-2222-2222-2222-222222222222";
const CREDS = { status: "active", apiKey: MEMBER_KEY, baseUrl: "https://proxy.example.com", models: ["claude-sonnet-4-5-20250929"] };
const PDF = Buffer.concat([Buffer.from("%PDF-1.4 fake paper "), crypto.randomBytes(2048)]);

function five() {
  return [0, 25, 50, 75, 100].map((level) => ({ level, question: `q${level}`, sample_response: `s${level}` }));
}
const ANALYSIS = { title: "Zebra Tuning", one_liner: "It tunes zebras.", date: "2024", areas: [
  { area: "Transformers", parent_field: "ML", project_role: "core", granularity_rationale: "g", questions: five() },
  { area: "PyTorch", parent_field: "", project_role: "code", granularity_rationale: "g", questions: five() },
] };

// The onboarding tests' in-memory Supabase, Storage, gateway and web, cut to
// what these tests need. The gateway answers with a full Anthropic envelope.
function fake({ modelStatus = 200, reply = ANALYSIS } = {}) {
  const tables = { engelbart_onboardings: [], engelbart_onboarding_calibrations: [], engelbart_onboarding_turns: [] };
  const calls = [];
  let ids = 0;
  const match = (row, query) => [...new URLSearchParams(query)].every(([k, v]) => {
    if (["select", "order", "limit", "on_conflict"].includes(k)) return true;
    const m = /^eq\.(.*)$/.exec(v);
    return m ? String(row[k]) === m[1] : true;
  });
  const json = (value, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
    async text() { return JSON.stringify(value); }, async json() { return value; } });
  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname.startsWith("/rest/v1/")) {
      const rows = tables[u.pathname.slice("/rest/v1/".length)] || [];
      if (method === "GET") return json(rows.filter((r) => match(r, u.search)));
      if (method === "POST") { const made = body.map((r) => ({ id: `id-${++ids}`, created_at: "t", ...r })); rows.push(...made); return json(made, 201); }
      if (method === "PATCH") { const hit = rows.filter((r) => match(r, u.search)); hit.forEach((r) => Object.assign(r, body)); return json(hit); }
      if (method === "DELETE") return json(null, 204);
    }
    if (u.pathname.startsWith("/storage/v1/object/upload/sign/")) return json({ url: "/object/upload/sign/berkeley-papers/papers/x.pdf?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJwYXBlcnMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ" });
    if (u.pathname.startsWith("/storage/v1/object/")) {
      return { ok: true, status: 200, headers: { get: (k) => ({ "content-length": String(PDF.length), "content-type": "application/pdf" })[k.toLowerCase()] || null },
        async arrayBuffer() { return PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength); }, async text() { return ""; } };
    }
    if (u.pathname === "/v1/messages") {
      if (modelStatus !== 200) return json({ type: "error", error: { type: "api_error", message: "the gateway fell over" } }, modelStatus);
      return json({ id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn",
        content: [{ type: "text", text: `Here you go:\n${JSON.stringify(reply)}` }],
        usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0 } });
    }
    if (method === "HEAD") return { ok: true, status: u.pathname === "/gone" ? 404 : 200, async text() { return ""; } };
    if (u.hostname === "x.org") return { ok: true, status: 200, headers: { get: () => "text/html" }, async text() { return "<html><script>x()</script><p>project &amp; page</p></html>"; } };
    throw new Error(`unrouted ${method} ${url}`);
  }
  return { tables, calls, options: { env: ENV, fetchImpl } };
}

// Each test gets a fresh sink on the shared layer, with capture on unless said.
function observe(settings = {}) {
  const sink = new MemorySink();
  const remove = telemetry.addSink(sink);
  const before = { ...telemetry.settings };
  telemetry.configure({ captureContent: true, tracePolls: false, ...settings });
  return { sink, done() { remove(); telemetry.configure(before); } };
}

function everything(sink) {
  return JSON.stringify({ operations: sink.operations, snapshots: sink.snapshots, events: sink.events });
}

// Boundaries record only under a workflow root, as they run in the handler.
const inWorkflow = (fn) => telemetry.runOperation({ name: "onboarding.test", type: "workflow" }, fn);

test("a model call is a model child of the workflow, completed, with the four stages kept apart", async () => {
  const { sink, done } = observe();
  try {
    const db = fake();
    const analysis = await telemetry.runOperation({ name: "onboarding.analysis", type: "workflow" }, () => OM.analyze({
      familiarityLabel: "some", familiarityDesc: "d", depthLabel: "technical", depthDesc: "d",
      pdfBase64: PDF.toString("base64"), urls: [{ url: "https://x.org/p", text: "project page" }],
    }, CREDS, db.options));
    assert.equal(analysis.title, "Zebra Tuning");
    const root = sink.one("onboarding.analysis");
    const model = sink.one("model.analysis");
    assert.equal(model.type, "model");
    assert.equal(model.status, "completed");
    assert.equal(model.parent_span_id, root.span_id);
    assert.equal(model.trace_id, root.trace_id);
    assert.equal(model.attributes["gen_ai.request.model"], "claude-sonnet-4-5-20250929");
    assert.equal(model.attributes["gen_ai.request.max_tokens"], 8192);
    assert.equal(model.attributes["server.address"], "proxy.example.com");
    assert.equal(model.attributes["http.response.status_code"], 200);
    assert.equal(model.attributes["gen_ai.usage.input_tokens"], 1200);
    assert.equal(model.attributes["engelbart.model.cache_creation_input_tokens"], 9000);
    assert.deepEqual(model.attributes["gen_ai.response.finish_reasons"], ["end_turn"]);
    assert.deepEqual(model.attributes["engelbart.model.block_types"], ["text", "document", "text"]);
    assert.equal(model.attributes["engelbart.model.parsed"], true);
    // Stage 1: the request as sent, byte for byte what went over the wire.
    const sent = JSON.parse(db.calls.find((c) => c.url.endsWith("/v1/messages")).init.body);
    const request = sink.snapshots.find((s) => s.kind === "model_request");
    assert.equal(request.operation_id, model.operation_id);
    assert.equal(request.content.url, "https://proxy.example.com/v1/messages");
    assert.equal(request.content.body.model, sent.model);
    assert.equal(request.content.body.max_tokens, sent.max_tokens);
    assert.equal(request.content.body.messages[0].content[2].text, sent.messages[0].content[2].text);
    // ...except the PDF, which is a reference, not a copy.
    const doc = request.content.body.messages[0].content[1];
    assert.equal(doc.type, "document");
    assert.equal(doc.source.data, "[redacted]");
    assert.equal(doc.source.source_ref["[bytes]"], PDF.length);
    assert.equal(doc.source.source_ref.sha256, crypto.createHash("sha256").update(PDF).digest("hex"));
    assert.equal(request.content.headers, undefined);
    // Stages 2, 3, 4.
    const raw = sink.snapshots.find((s) => s.kind === "model_raw_response");
    assert.equal(raw.content.usage.output_tokens, 300);
    assert.match(raw.content.content[0].text, /^Here you go:/);
    const parsed = sink.snapshots.find((s) => s.kind === "model_parsed_response");
    assert.equal(parsed.content.title, "Zebra Tuning");
    assert.equal(parsed.content.areas[0].questions[0].capability, undefined);   // parsed, not yet normalized
    const normalize = sink.one("analysis.normalize");
    assert.equal(normalize.type, "processing");
    assert.equal(normalize.parent_span_id, root.span_id);
    assert.equal(normalize.attributes["engelbart.normalized"], true);
    const normalized = sink.snapshots.find((s) => s.kind === "normalized_result");
    assert.equal(normalized.operation_id, normalize.operation_id);
    assert.equal(normalized.content.areas[0].questions[0].capability, "wouldn't_know_where_to_start");   // normalization added it
    assert.deepEqual(Object.keys(model.snapshots).sort(), ["model_parsed_response", "model_raw_response", "model_request"]);
    // The request construction is its own step, before the model.
    const construct = sink.one("analysis.construct-request");
    assert.equal(construct.attributes["engelbart.analysis.paper_mode"], "pdf_base64");
    assert.ok(construct.ended_at <= model.started_at);
    // Nothing anywhere holds the member's key or the PDF bytes.
    const all = everything(sink);
    assert.doesNotMatch(all, new RegExp(MEMBER_KEY));
    assert.equal(all.includes(PDF.toString("base64").slice(0, 64)), false);
  } finally { done(); }
});

test("a model failure marks the model and workflow spans failed and the application sees its own error", async () => {
  const { sink, done } = observe({ captureContent: false });
  try {
    const db = fake({ modelStatus: 500 });
    await assert.rejects(
      telemetry.runOperation({ name: "onboarding.direction", type: "workflow" }, () => OM.direction({ reader: {}, paper: {}, asset: {} }, CREDS, db.options)),
      (e) => e.statusCode === 502 && e.message === "the gateway fell over",
    );
    const model = sink.one("model.direction");
    assert.equal(model.status, "failed");
    assert.equal(model.attributes["http.response.status_code"], 500);
    assert.equal(model.error.status_code, 502);
    assert.equal(model.error.message, "the gateway fell over");
    assert.equal(sink.one("onboarding.direction").status, "failed");
    assert.equal(sink.byName("direction.normalize").length, 0);     // never reached, so never a node
    assert.equal(sink.snapshots.length, 0);                           // capture off: no error_detail either
    // grade() swallows a non-409 failure by design and answers null; the span still says failed.
    const graded = await inWorkflow(() => OM.grade({ area: "a", question: "q", level: 50, sample: "s", answer: "a" }, CREDS, db.options));
    assert.equal(graded, null);
    assert.equal(sink.one("model.grade").status, "failed");
  } finally { done(); }
});

test("the PostgREST boundary records the operation, table, filter, status and row count, and never a credential", async () => {
  const { sink, done } = observe();
  try {
    const db = fake();
    db.tables.engelbart_onboardings.push({ id: "row-1", user_id: USER.id, status: "open" });
    // Outside a workflow the boundary is untraced: no operation, no event, no snapshot.
    const rootless = await Supabase.selectRows("engelbart_onboardings", `user_id=eq.${USER.id}&select=*`, db.options);
    assert.equal(rootless.length, 1);
    assert.deepEqual([sink.started.length, sink.operations.length, sink.events.length, sink.snapshots.length], [0, 0, 0, 0]);
    await inWorkflow(async () => {
      const rows = await Supabase.selectRows("engelbart_onboardings", `user_id=eq.${USER.id}&select=*`, db.options);
      assert.equal(rows.length, 1);
      await Supabase.patchRows("engelbart_onboardings", "id=eq.row-1", { step: 3 }, db.options);
      await Supabase.insertRows("engelbart_onboarding_turns", [{ content: "hi" }], { ...db.options, query: "on_conflict=id", prefer: "resolution=merge-duplicates,return=representation" });
      await Supabase.rpc("engelbart_save_pending_setup", { p_user_id: USER.id }, { ...db.options, fetchImpl: async () => ({ ok: true, status: 200, async text() { return '"abc"'; } }) });
      await Supabase.selectRows("engelbart_onboardings", "id=eq.row-1", { ...db.options, trace: { name: "analysis.check-superseded" } });
    });
    const select = sink.one("db.select");
    assert.equal(select.parent_span_id, sink.one("onboarding.test").span_id);
    assert.equal(select.type, "database");
    assert.equal(select.attributes["db.collection.name"], "engelbart_onboardings");
    assert.equal(select.attributes["db.operation.name"], "select");
    assert.equal(select.attributes["url.path"], "/rest/v1/engelbart_onboardings");
    // Attributes hold the query's structure, never its values...
    assert.equal(select.attributes["url.query"], undefined);
    assert.equal(select.attributes["db.query.summary"], "user_id=eq.?&select=*");
    assert.deepEqual(select.attributes["engelbart.db.filter_fields"], ["user_id"]);
    assert.deepEqual(select.attributes["engelbart.db.filter_operators"], ["eq"]);
    assert.doesNotMatch(JSON.stringify(sink.operations.map((o) => o.attributes)), new RegExp(USER.id));
    assert.doesNotMatch(JSON.stringify(sink.events.map((e) => e.attributes)), new RegExp(USER.id));
    // ...while the snapshots keep the real filter and the rows it returned, for debugging.
    const selectRequest = sink.snapshots.find((s) => s.operation_id === select.operation_id && s.kind === "database_request");
    assert.equal(selectRequest.content.query, `user_id=eq.${USER.id}&select=*`);
    const selectResponse = sink.snapshots.find((s) => s.operation_id === select.operation_id && s.kind === "database_response");
    assert.equal(selectResponse.content[0].user_id, USER.id);
    assert.equal(select.attributes["http.response.status_code"], 200);
    assert.equal(select.attributes["engelbart.db.rows"], 1);
    // The structure of harder filters, with modifiers kept and values gone.
    assert.deepEqual(Supabase.describeQuery("id=in.(a,b)&status=not.eq.done&order=created_at.desc&limit=1&select=id,status"),
      { querySummary: "id=in.?&status=not.eq.?&order=created_at.desc&limit=1&select=id,status", filterFields: ["id", "status"], filterOperators: ["in", "not.eq"] });
    assert.deepEqual(Supabase.describeQuery("or=(a.eq.1,b.eq.2)&email=ilike.*%40x.org"),
      { querySummary: "or=?&email=ilike.?", filterFields: ["or", "email"], filterOperators: ["or", "ilike"] });
    assert.deepEqual(Supabase.describeQuery(""), { querySummary: "", filterFields: [], filterOperators: [] });
    assert.equal(sink.one("db.patch").attributes["http.request.method"], "PATCH");
    assert.equal(sink.one("db.upsert").attributes["db.collection.name"], "engelbart_onboarding_turns");
    assert.equal(sink.one("db.rpc").attributes["engelbart.db.rpc"], "engelbart_save_pending_setup");
    assert.equal(sink.one("analysis.check-superseded").attributes["db.operation.name"], "select");
    const patchRequest = sink.snapshots.find((s) => s.operation_id === sink.one("db.patch").operation_id && s.kind === "database_request");
    assert.deepEqual(patchRequest.content, { method: "PATCH", path: "/rest/v1/engelbart_onboardings", query: "id=eq.row-1", body: { step: 3 } });
    const all = everything(sink);
    assert.doesNotMatch(all, new RegExp(SERVICE_KEY));
    assert.doesNotMatch(all, /Authorization|apikey|Bearer/);
    // A 500 is a failed database operation with the status on it, and the error unchanged.
    await inWorkflow(() => assert.rejects(Supabase.selectRows("t", "", { ...db.options, fetchImpl: async () => ({ ok: false, status: 500, async text() { return '{"message":"boom"}'; } }) }),
      (e) => e.statusCode === 500 && e.name === "ServiceError"));
    const failed = sink.operations.find((o) => o.status === "failed");
    assert.equal(failed.attributes["http.response.status_code"], 500);
    // Untraced requests leave no trace at all, even under a workflow.
    const before = sink.operations.length;
    await inWorkflow(() => Supabase.selectRows("engelbart_onboardings", "id=eq.row-1", { ...db.options, trace: false }));
    assert.equal(sink.operations.length, before + 1);   // the wrapper only
    // The describer alone.
    assert.equal(Supabase.describe("/rest/v1/rpc/f", "POST", {}).name, "db.rpc");
    assert.equal(Supabase.describe("/rest/v1/t?x=1", "DELETE", {}).name, "db.delete");
    assert.equal(Supabase.describe("/auth/v1/user", "GET", {}).name, "auth.request");
  } finally { done(); }
});

test("storage operations reference the PDF by path, size and digest and copy neither bytes nor signed tokens", async () => {
  const { sink, done } = observe();
  try {
    const db = fake();
    const bytes = await inWorkflow(() => Storage.downloadObject(Storage.paperObjectPath(PAPER), { ...db.options, maxBytes: 20 * 1024 * 1024 }));
    assert.equal(bytes.length, PDF.length);
    const download = sink.one("paper.download");
    assert.equal(download.type, "storage");
    assert.equal(download.attributes["engelbart.storage.object"], `papers/${PAPER}.pdf`);
    assert.equal(download.attributes["engelbart.storage.bucket"], "berkeley-papers");
    assert.equal(download.attributes["engelbart.storage.bytes"], PDF.length);
    assert.equal(download.attributes["engelbart.storage.declared_bytes"], PDF.length);
    assert.equal(download.attributes["engelbart.storage.content_type"], "application/pdf");
    assert.equal(download.attributes["engelbart.storage.sha256"], crypto.createHash("sha256").update(PDF).digest("hex"));
    assert.equal(download.attributes["http.response.status_code"], 200);
    assert.deepEqual(download.snapshots, {});
    const signed = await inWorkflow(() => Storage.signedUploadUrl("papers/x.pdf", db.options));
    assert.match(signed.uploadUrl, /token=/);                       // the app still gets the real URL
    assert.equal(sink.one("storage.sign-upload").attributes["engelbart.storage.signed"], true);
    assert.equal(sink.byName("db.request").length + sink.byName("storage.request").length, 0);   // no generic child under it
    const all = everything(sink);
    assert.equal(all.includes(PDF.toString("base64").slice(0, 64)), false);
    assert.equal(all.includes("%PDF"), false);
    assert.doesNotMatch(all, /token=|eyJhbGci/);
    assert.doesNotMatch(all, new RegExp(SERVICE_KEY));
    assert.ok(Buffer.byteLength(all) < 20000);                        // a 2 KB PDF did not become a 2 KB record
    // Too large by its declared length: a failed storage op, the same 413 the page sees.
    await inWorkflow(() => assert.rejects(Storage.downloadObject("papers/big.pdf", { ...db.options, maxBytes: 100 }), (e) => e.statusCode === 413));
    assert.equal(sink.byName("paper.download")[1].status, "failed");
  } finally { done(); }
});

test("a page fetch is an http operation with the URL stripped of its query, and its text extraction a processing child", async () => {
  const { sink, done } = observe();
  try {
    const db = fake();
    const text = await inWorkflow(() => PageFetch.fetchPageText("https://x.org/p?utm=1", { ...db.options, traceName: "project-page.fetch" }));
    assert.equal(text, "project & page");
    const fetch = sink.one("project-page.fetch");
    assert.equal(fetch.type, "http");
    assert.equal(fetch.attributes["url.full"], "https://x.org/p");
    assert.equal(fetch.attributes["server.address"], "x.org");
    assert.equal(fetch.attributes["http.response.status_code"], 200);
    assert.equal(typeof fetch.attributes["http.response.body.size"], "number");
    const extract = sink.one("page.extract-text");
    assert.equal(extract.type, "processing");
    assert.equal(extract.parent_span_id, fetch.span_id);
    assert.equal(extract.attributes["engelbart.page.output_chars"], text.length);
    assert.equal(sink.snapshots.find((s) => s.kind === "page_text").content, text);
    assert.equal(everything(sink).includes("<script>"), false);       // the HTML is never recorded
    await inWorkflow(() => assert.rejects(PageFetch.fetchPageText("https://x.org/p", { env: ENV, fetchImpl: async () => ({ ok: false, status: 503 }) }), (e) => e.statusCode === 502));
    assert.equal(sink.byName("page.fetch")[0].status, "failed");
    assert.equal(sink.byName("page.fetch")[0].attributes["http.response.status_code"], 503);
  } finally { done(); }
});

// The dispatcher, with an injected record module as engelbart-onboarding.test.js does.
function deps(overrides = {}) {
  const { OB: ob, ...rest } = overrides;
  return {
    credentialsFor: async () => CREDS,
    ...rest,
    OB: {
      open: async () => ({ onboarding: { id: "row-7", user_id: USER.id, status: "open", step: 0, analysis_status: "running" }, calibrations: [] }),
      analysis: async (u, r, b) => telemetry.runOperation({ name: b.run || b.retry ? "analysis.mark-running" : "db.select", type: "database" }, async () => ({ analysis_status: b.run || b.retry ? "done" : "running" })),
      step: async (u, r, b) => ({ onboarding: { ...r, step: b.step } }),
      ...(ob || {}),
    },
  };
}

test("routine polls produce no operations; run and retry are one workflow each; polls can be traced as their own marked roots", async () => {
  const { sink, done } = observe({ captureContent: false });
  try {
    for (let i = 0; i < 15; i += 1) await handler.dispatch(USER, { action: "analysis" }, deps());
    await handler.dispatch(USER, { action: "leveled" }, deps({ OB: { leveled: async () => ({ leveled_status: "running" }) } }));
    assert.equal(sink.operations.length, 0);
    assert.equal(sink.events.length, 0);
    await handler.dispatch(USER, { action: "analysis", run: true, test_run_id: "harness-1" }, deps());
    await handler.dispatch(USER, { action: "analysis", retry: true }, deps());
    const roots = sink.byName("onboarding.analysis");
    assert.equal(roots.length, 2);
    assert.equal(roots[0].attributes["engelbart.poll"], false);
    assert.equal(roots[0].attributes["engelbart.run_flag"], true);
    assert.equal(roots[0].test_run_id, "harness-1");
    assert.equal(roots[0].attributes["engelbart.mode"], "test");     // a named test run
    assert.equal(roots[1].attributes["engelbart.mode"], "live");     // a plain request
    assert.equal(roots[0].run_id, "row-7");
    assert.equal(roots[0].onboarding_id, "row-7");
    assert.equal(roots[0].action, "analysis");
    assert.match(roots[0].attributes["engelbart.user_hash"], /^[0-9a-f]{16}$/);
    assert.equal(roots[1].attributes["engelbart.retry"], true);
    assert.deepEqual(sink.byName("analysis.mark-running").map((o) => o.parent_span_id), roots.map((o) => o.span_id));
    // Two distinct traces for two requests.
    assert.notEqual(roots[0].trace_id, roots[1].trace_id);
    // Asked for, a poll is its own root and says so.
    telemetry.configure({ tracePolls: true });
    await handler.dispatch(USER, { action: "analysis" }, deps());
    const poll = sink.one("onboarding.analysis.poll");
    assert.equal(poll.attributes["engelbart.poll"], true);
    assert.equal(poll.parent_span_id, null);
    assert.equal(sink.one("db.select").parent_span_id, poll.span_id);
    // The header form of a test run id.
    await handler.dispatch(USER, { action: "step", step: 1, fields: {} }, deps({ testRunId: "from-header", mode: "fixture" }));
    assert.equal(sink.one("onboarding.step").test_run_id, "from-header");
    assert.equal(sink.one("onboarding.step").attributes["engelbart.mode"], "fixture");   // the harness said so
  } finally { done(); }
});

test("concurrent onboarding requests keep their own trace context", async () => {
  const { sink, done } = observe({ captureContent: false });
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const OBfor = (rowId) => ({
      open: async () => ({ onboarding: { id: rowId, status: "open", step: 0 }, calibrations: [] }),
      brainstorm: async () => {
        await gate;
        return telemetry.runOperation({ name: "model.brainstorm", type: "model" }, async (op) => {
          seen.push({ rowId, trace: op.trace_id, run: telemetry.run().onboarding_id });
          return { say: rowId, card: "none" };
        });
      },
    });
    const a = handler.dispatch(USER, { action: "brainstorm", text: "a" }, { credentialsFor: async () => CREDS, OB: OBfor("row-a") });
    const b = handler.dispatch({ id: "22222222-2222-2222-2222-222222222222" }, { action: "brainstorm", text: "b" }, { credentialsFor: async () => CREDS, OB: OBfor("row-b") });
    setTimeout(release, 5);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.say, "row-a"); assert.equal(rb.say, "row-b");
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].trace, seen[1].trace);
    for (const s of seen) assert.equal(s.run, s.rowId);
    for (const model of sink.byName("model.brainstorm")) {
      const root = sink.operations.find((o) => o.span_id === model.parent_span_id);
      assert.equal(root.name, "onboarding.brainstorm");
      assert.equal(root.onboarding_id, model.onboarding_id);
      assert.equal(root.trace_id, model.trace_id);
    }
  } finally { done(); }
});

test("the real paper-analysis path is one trace with the expected operations, and behaves as before", async () => {
  const { sink, done } = observe();
  try {
    const db = fake();
    const d = { credentialsFor: async () => CREDS, options: db.options };
    await handler.dispatch(USER, { action: "open" }, d);
    await handler.dispatch(USER, { action: "sources", paper_id: PAPER, paper_token: setupHandler.ownPaperToken(PAPER, USER.id, ENV),
      project_url: "https://x.org/p", repo_url: "", paper_familiarity: 2 }, d);
    const polled = await handler.dispatch(USER, { action: "analysis" }, d);
    assert.equal(polled.analysis_status, "none");
    const out = await handler.dispatch(USER, { action: "analysis", run: true }, d);
    assert.equal(out.analysis_status, "done");
    assert.equal(db.tables.engelbart_onboardings[0].paper_title, "Zebra Tuning");

    const rowId = db.tables.engelbart_onboardings[0].id;
    const root = sink.one("onboarding.analysis");
    assert.equal(root.status, "completed");
    assert.equal(root.onboarding_id, rowId);
    assert.equal(root.attributes["engelbart.outcome"], "done");
    const inTrace = sink.operations.filter((o) => o.trace_id === root.trace_id);
    const children = inTrace.filter((o) => o.parent_span_id === root.span_id).map((o) => o.name);
    assert.deepEqual(children, ["row.load", "calibrations.load", "turns.load", "analysis.mark-running", "paper.download", "analysis.context",
      "analysis.construct-request", "model.analysis", "analysis.normalize", "analysis.check-superseded", "analysis.persist"]);
    // The reader's levels: the root, the stages worth seeing, the details they are made of.
    const levels = Object.fromEntries(inTrace.map((o) => [o.name, o.level]));
    assert.equal(levels["onboarding.analysis"], "workflow");
    for (const name of ["row.load", "calibrations.load", "turns.load", "project-page.fetch", "page.extract-text"]) assert.equal(levels[name], "detail", name);
    for (const name of ["analysis.mark-running", "paper.download", "analysis.context", "analysis.construct-request", "model.analysis",
      "analysis.normalize", "analysis.check-superseded", "analysis.persist"]) assert.equal(levels[name], "stage", name);
    assert.ok(sink.events.filter((e) => e.trace_id === root.trace_id).every((e) => e.level === levels[e.name]));
    assert.equal(root.attributes["engelbart.mode"], "live");
    const [branch] = tree(inTrace);
    assert.equal(branch.name, "onboarding.analysis");
    const context = branch.children.find((c) => c.name === "analysis.context");
    assert.deepEqual(context.children.map((c) => c.name), ["project-page.fetch"]);
    assert.deepEqual(context.children[0].children.map((c) => c.name), ["page.extract-text"]);
    assert.ok(inTrace.every((o) => o.run_id === rowId && o.status === "completed"), "every operation belongs to the run and completed");
    assert.equal(sink.one("analysis.persist").type, "database");
    assert.equal(sink.one("analysis.persist").attributes["db.operation.name"], "patch");
    const persisted = sink.snapshots.find((s) => s.operation_id === sink.one("analysis.persist").operation_id && s.kind === "database_request");
    assert.equal(persisted.content.body.analysis_status, "done");
    assert.equal(persisted.content.body.paper_title, "Zebra Tuning");
    // Three traces in the run: open, sources, analysis. The poll left none.
    const roots = sink.operations.filter((o) => !o.parent_span_id).map((o) => o.name);
    assert.deepEqual(roots, ["onboarding.open", "onboarding.sources", "onboarding.analysis"]);
    assert.equal(new Set(sink.operations.map((o) => o.trace_id)).size, 3);
    const all = everything(sink);
    assert.doesNotMatch(all, new RegExp(`${SERVICE_KEY}|${MEMBER_KEY}`));
    assert.equal(all.includes(PDF.toString("base64").slice(0, 64)), false);
  } finally { done(); }
});
