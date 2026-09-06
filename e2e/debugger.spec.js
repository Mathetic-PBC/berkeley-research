"use strict";

// The debugger at /engelbart/setup/test: the real setup page in a frame, run
// against the in-browser simulated backend, with every request drawn beside
// it. Served here by the simulation stack's static server under the exact
// headers vercel.json deploys, so a Content-Security-Policy violation in the
// flattened page fails the test.

const fs = require("node:fs");
const path = require("node:path");

const { expect, test } = require("@playwright/test");

const { SimulationStack } = require("./fixtures/simulation-stack");

const VERCEL = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));

// Vercel applies header rules in order, the later rule winning per header.
function deployedHeaders(pathname) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = {};
  for (const rule of VERCEL.headers) {
    const re = new RegExp("^" + rule.source.split("(.*)").map(escape).join("(.*)") + "$");
    if (!re.test(pathname)) continue;
    for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

test("the debugger runs the real setup page against the simulated backend under the deployed headers", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  const cspViolations = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) cspViolations.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  try {
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
    await page.route((url) => url.origin === stack.url && url.pathname.startsWith("/engelbart/"), async (route) => {
      const response = await route.fetch();
      const headers = Object.assign({}, response.headers(), deployedHeaders(new URL(route.request().url()).pathname));
      await route.fulfill({ response, headers });
    });

    await page.goto(`${stack.url}/engelbart/setup/test`);
    await expect(page.getByText("Engelbart", { exact: true })).toBeVisible();

    // The debugger lands on the environments dashboard; nothing runs until an environment is opened.
    await expect(page.getByText("Test environments")).toBeVisible();
    await expect(page.getByText("No environments yet. Create one to open the product against a fresh simulated account.")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset test environment" })).toHaveCount(0);
    await page.getByRole("button", { name: "New environment" }).click();
    await page.getByRole("button", { name: "Create environment" }).click();
    await expect(page.getByRole("button", { name: "Reset test environment" })).toBeVisible();

    // The product boots inside the frame, answered by the simulator: the Name step is on screen.
    const frame = page.frameLocator('iframe[title^="Engelbart setup"]');
    await expect(frame.locator(".ob-title", { hasText: "What is your name?" })).toBeVisible();

    // What the page did on load landed in the Start step; the request list shows the config read.
    await page.getByRole("button", { name: /^Requests/ }).click();
    await expect(page.getByText("GET /api/engelbart-config")).toBeVisible();

    // Acting in the product opens that step's tab and records what the press did.
    await frame.locator("input").first().fill("Ada");
    await frame.getByRole("button", { name: "Continue" }).click();
    await expect(frame.locator(".ob-title", { hasText: "What year are you?" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Requests · [1-9]/ })).toBeVisible();
    await expect(page.getByText("POST /api/engelbart-onboarding").first()).toBeVisible();

    // The data-flow graph drew the value the press wrote.
    await page.getByRole("button", { name: "Data flow" }).click();
    await expect(page.locator("[data-node]").first()).toBeVisible();

    // All environments… returns to the dashboard: the frame is unmounted, the card says what was recorded.
    await page.locator('select[title="switch environment"]').selectOption("__all");
    await expect(page.getByText("Test environments")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.getByText("Environment 1", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Last opened /)).toBeVisible();
    await expect(page.getByText("Fresh participant · opens at the Start step")).toBeVisible();
    await expect(page.getByRole("button", { name: "Configure" })).toBeVisible();

    // Opening the card brings the environment back where it was: the product resumes on the Year step.
    await page.getByText("Environment 1", { exact: true }).click();
    await expect(frame.locator(".ob-title", { hasText: "What year are you?" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Requests · [1-9]/ })).toBeVisible();

    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});

// Real mode: the same setup page in the same frame, now talking to the real
// endpoints as the signed-in member, with each request's recorded trace read
// through /api/engelbart-telemetry and placed under it. The backend is stood
// in for here: the onboarding endpoint answers from a row and names the trace
// it "produced" in x-engelbart-trace-id, the telemetry endpoint answers from
// the documented example envelope, supabase-js from a stand-in session. So the
// test is the page's own behaviour end to end: the product acts, the request
// row appears, the trace lands under it, the inspector shows the recorded
// payloads, an earlier run opens from the picker, and the simulator comes
// back untouched. Every request the page makes is recorded, so a write the
// product did not make, or a telemetry call that is not a read, fails it.
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "observability", "example-onboarding-analysis-run.json"), "utf8"));
const telemetryHandler = require("../api/engelbart-telemetry");
// The fixture is regenerated from the real code, so its ids are read from it, never copied.
const TRACE = {}; FIXTURE.operations.filter((o) => o.type === "workflow").forEach((o) => { TRACE[o.action] = o.trace_id; });
const OLDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBER_TOKEN = "member-token";

function json(route, status, body, headers) {
  return route.fulfill({ status, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, headers || {}), body: JSON.stringify(body) });
}

test("Real mode runs the setup page against the backend as the member and puts each request's recorded trace under it in the same debugger", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  const pageErrors = [], cspViolations = [], apiRequests = [], onboardingCalls = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) cspViolations.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) apiRequests.push({ method: r.method(), path: u.pathname + u.search, auth: r.headers().authorization || "", frame: r.frame() === page.mainFrame() ? "page" : "frame" }); });
  const onboardingId = FIXTURE.run.onboarding_id;
  // The member's onboarding row, as the real endpoint would keep it: fresh, at the first step.
  const row = { id: onboardingId, user_id: "11111111-1111-1111-1111-111111111111", status: "open", step: 0, name: "", year: "", major: "", depth: "", paper_id: null, paper_title: "",
    project_url: "", repo_url: "", analysis_status: "", assets_status: "", leveled_status: "", todos: [], project_name: "", created_at: "2026-09-06T02:40:00.000Z", updated_at: "2026-09-06T02:40:00.000Z" };
  const publicRow = (id, extra) => Object.assign({ onboarding_id: id, onboarding_status: "open", step: 4, project_name: "Speculative decoding", paper_title: "Fast Inference from Transformers", created_at: "2026-09-06T02:40:00.000Z", updated_at: "2026-09-06T02:49:01.600Z" }, extra || {});
  const subset = (filter, onboarding, map = (op) => op) => ({ contract_version: FIXTURE.contract_version, run: FIXTURE.run, onboarding, operations: FIXTURE.operations.filter(filter).map(map), snapshots: FIXTURE.snapshots, events: FIXTURE.events.filter(filter), snapshots_inline: true });
  // The older run was recorded by a build before lineage: the same operations without their reads and writes.
  const preLineage = (op) => { const attributes = { ...op.attributes }; delete attributes["engelbart.lineage.reads"]; delete attributes["engelbart.lineage.writes"]; return { ...op, attributes }; };
  const analysisOps = FIXTURE.operations.filter((o) => o.trace_id === TRACE.analysis);
  const listBody = { runs: [
    { run_id: onboardingId, ...publicRow(onboardingId), telemetry: telemetryHandler.summarize(FIXTURE.operations) },
    { run_id: OLDER, ...publicRow(OLDER, { project_name: "Older project", created_at: "2026-09-01T10:00:00.000Z", updated_at: "2026-09-01T10:05:00.000Z" }), telemetry: telemetryHandler.summarize(analysisOps) },
    { run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...publicRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { onboarding_status: "created", project_name: null, paper_title: null }), telemetry: null }] };
  try {
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
    // supabase-js is stood in for, in the page and in the frame: a session for a member, without a network.
    await page.route("https://cdn.jsdelivr.net/npm/@supabase/**", (route) => route.abort());
    await page.addInitScript(() => {
      window.supabase = { createClient: () => ({ auth: {
        getSession: async () => ({ data: { session: { access_token: "member-token", user: { id: "11111111-1111-1111-1111-111111111111", email: "member@example.com" } } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } }) };
    });
    // The onboarding endpoint, as the product's real one: a row, and the trace each action produced named in the reply.
    await page.route((url) => url.origin === stack.url && url.pathname === "/api/engelbart-onboarding", async (route) => {
      const request = route.request(), body = request.postDataJSON() || {};
      onboardingCalls.push({ action: body.action, auth: request.headers().authorization || "" });
      if (request.method() !== "POST" || request.headers().authorization !== "Bearer " + MEMBER_TOKEN) return json(route, 401, { error: "sign in first" });
      if (body.action === "open") return json(route, 200, { onboarding: row, calibrations: [], turns: [], profile_reused: false, credit: { status: "active", budgetUsd: 25, spendUsd: 0 }, own_key: { set: false } }, { "x-engelbart-trace-id": TRACE.open });
      if (body.action === "step") { Object.assign(row, body.fields || {}); row.step = Math.max(Number(row.step) || 0, Number(body.step) || 0); row.updated_at = new Date().toISOString(); return json(route, 200, { onboarding: row }, { "x-engelbart-trace-id": TRACE.step }); }
      return json(route, 400, { error: "the test backend does not answer " + body.action });
    });
    await page.route((url) => url.origin === stack.url && url.pathname === "/api/engelbart-telemetry", async (route) => {
      const request = route.request();
      if (request.method() !== "GET" || request.headers().authorization !== "Bearer " + MEMBER_TOKEN) return json(route, 401, { error: "Sign in to Engelbart first" });
      const params = new URL(request.url()).searchParams;
      if (params.has("trace")) { const t = params.get("trace"); return FIXTURE.run.trace_ids.includes(t) ? json(route, 200, { ...subset((o) => o.trace_id === t, publicRow(onboardingId)), trace_id: t }) : json(route, 404, { error: "No trace by that id was recorded for you" }); }
      if (params.get("run") === onboardingId) return json(route, 200, subset(() => true, publicRow(onboardingId)));
      if (params.get("run") === OLDER) return json(route, 200, subset((o) => o.trace_id === TRACE.analysis, publicRow(OLDER, { project_name: "Older project" }), preLineage));
      if (params.has("run")) return json(route, 404, { error: "No run by that id" });
      return json(route, 200, listBody);
    });
    await page.route((url) => url.origin === stack.url && url.pathname.startsWith("/engelbart/"), async (route) => {
      const response = await route.fetch();
      const headers = Object.assign({}, response.headers(), deployedHeaders(new URL(route.request().url()).pathname));
      await route.fulfill({ response, headers });
    });

    await page.goto(`${stack.url}/engelbart/setup/test`);
    // Simulated mode lands on the environments dashboard; open one so there is a simulator to come back to.
    await page.getByRole("button", { name: "New environment" }).click();
    await page.getByRole("button", { name: "Create environment" }).click();
    const simFrame = page.frameLocator('iframe[title="Engelbart setup, running against the simulated backend"]');
    await expect(simFrame.locator(".ob-title", { hasText: "What is your name?" })).toBeVisible();
    const before = onboardingCalls.length;

    // Real mode is the URL's, not a switch in the page. It keeps the composition: the product stays on the left,
    // in the real frame; the simulator's controls go, and nothing in the bar offers a mode.
    await expect(page.getByRole("button", { name: "Real", exact: true })).toHaveCount(0);
    await page.goto(`${stack.url}/engelbart/setup/test?mode=real`);
    const realFrame = page.frameLocator('iframe[title="Engelbart setup, running against the real backend"]');
    await expect(page.locator('iframe[title="Engelbart setup, running against the real backend"]')).toHaveAttribute("src", /\/engelbart\/setup\/test\/frame\?mode=real$/);
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Reset test environment" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Simulated" })).toHaveCount(0);
    await expect(page.getByText("real actions")).toHaveCount(0);
    await expect(page.getByText(/Model calls spend real credit/)).toHaveCount(0);
    await expect(page.locator("[data-run-picker]")).toBeVisible();
    await expect(page.locator("[data-prompt-picker]")).toHaveValue("", { timeout: 5000 });
    await expect(page.getByText("member@example.com")).toBeVisible();

    // The real product boots as the member: the open request carried the member's token, not the simulator's.
    await expect(realFrame.locator(".ob-title", { hasText: "What is your name?" })).toBeVisible();
    await expect.poll(() => onboardingCalls.length).toBeGreaterThan(before);
    expect(onboardingCalls.slice(before).map((c) => c.action)).toEqual(["open"]);
    expect(onboardingCalls.slice(before).every((c) => c.auth === "Bearer " + MEMBER_TOKEN)).toBe(true);

    // Its request is a row at once, labelled as the simulator would label it, and the trace the reply named lands under it.
    await expect(page.getByText("This session")).toBeVisible();
    const openRow = page.locator("[id^=stage-]", { hasText: "onboarding · open" });
    await expect(openRow).toBeVisible();
    await expect(openRow).toContainText("POST /api/engelbart-onboarding");
    await expect(openRow).toContainText("4 ops");
    await expect(openRow.getByText("row.load", { exact: true })).toBeVisible();
    await expect(openRow.getByText("db.insert", { exact: true })).toBeVisible();
    await expect(page.locator("[id^=stage-]", { hasText: "config · engelbart-config" })).toContainText("untraced");

    // Acting in the product: Continue writes the name; the step request appears with the operations the server recorded for it.
    await realFrame.locator("input").first().fill("Ada");
    await realFrame.getByRole("button", { name: "Continue" }).click();
    await expect(realFrame.locator(".ob-title", { hasText: "What year are you?" })).toBeVisible();
    expect(onboardingCalls[onboardingCalls.length - 1].action).toBe("step");
    expect(row.name).toBe("Ada");
    const stepRow = page.locator("[id^=stage-]", { hasText: "onboarding · step" }).last();
    await expect(stepRow).toBeVisible();
    await expect(stepRow).toContainText("4 ops");
    await expect(stepRow.getByText("db.patch", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Requests · [1-9]/ })).toBeVisible();

    // The inspector: what the browser sent, and what the server recorded doing about it.
    const inspector = page.locator('[data-screen-label="Inspector"]');
    await stepRow.getByRole("button", { name: "request · response" }).click();
    await expect(inspector).toContainText("onboarding · step");
    await expect(inspector.locator("pre")).toContainText('"action": "step"');
    await expect(inspector.locator("pre")).toContainText('"name": "Ada"');
    await expect(inspector).toContainText("round trip");
    await inspector.getByRole("button", { name: "Response" }).click();
    await expect(inspector.locator("pre")).toContainText('"name": "Ada"');
    await stepRow.getByText("db.patch", { exact: true }).click();
    await expect(inspector).toContainText("PATCH /rest/v1/engelbart_onboardings?id=eq.?");
    await expect(inspector).toContainText("redacted");
    await expect(inspector).not.toContainText("est. cost");

    // Requests that land in one turn. One click at the Paper step fires the step, then the analysis and assets
    // runs; an upload's reply can arrive with the next request. React applies a turn's updates together, so
    // each has to build on the state as it stands then: every row must show, and the upload must keep its reply.
    // The frame posts exactly these shapes as it observes the product; here it posts them directly.
    await realFrame.locator("body").evaluate(() => {
      const at = Date.now(), post = (m) => window.parent.postMessage(m, location.origin);
      const req = (id, action, over) => post(Object.assign({ egb: "request", id, at, method: "POST", path: "/api/engelbart-onboarding", where: "api", action, body: { action }, step: "Paper", bg: false, poll: false }, over || {}));
      req("burst-1", "analysis", { body: { action: "analysis", run: true }, bg: true });
      req("burst-2", "assets", { body: { action: "assets", run: true }, bg: true });
      req("burst-3", "upload", { method: "PUT", path: "/storage/v1/object/berkeley-papers/papers/p.pdf", where: "storage", body: { bytes: 2059, type: "application/pdf" } });
      post({ egb: "response", id: "burst-3", at: at + 310, ms: 310, status: 200, ok: true, trace_id: null, body: { ok: true, status: 200 } });
      req("burst-4", "own_paper_saved", { body: { action: "own_paper_saved", id: "p" } });
    });
    // (The onboarding's history already holds one analysis run, drawn ahead; this turn's is the second.)
    await expect(page.locator("[id^=stage-]", { hasText: "onboarding · analysis (run)" })).toHaveCount(2);
    await expect(page.locator("[id^=stage-]", { hasText: "onboarding · assets (run)" })).toBeVisible();
    await expect(page.locator("[id^=stage-]", { hasText: "onboarding · own_paper_saved" })).toBeVisible();
    const uploadRow = page.locator("[id^=stage-]", { hasText: "storage · upload" });
    await expect(uploadRow).toBeVisible();
    await expect(uploadRow).toContainText("310 ms");
    await expect(uploadRow).toContainText("browser → storage");

    // The Prompts view: the run's model calls under the prompt each sent, the message and the reply from the
    // recorded snapshots; a call opens in the Requests view.
    await page.getByRole("button", { name: /^Prompts · [1-9]/ }).click();
    await expect(page.locator("[data-prompt-tab='analyzePrompt']")).toContainText("Read the paper");
    const call = page.locator("[data-prompt-call]").first();
    await expect(call).toContainText("onboarding · analysis (run)");
    await expect(call).toContainText("The PhD student's paper follows as an attached document.");
    await expect(call).toContainText("[the paper, as a PDF document block");
    await expect(call).toContainText('"title": "Speculative Decoding for Fast LLM Inference"');
    await call.getByRole("button", { name: /open in session/i }).click();
    await expect(inspector).toContainText("model.analysis");
    await page.getByRole("button", { name: /^Requests/ }).click();

    // An earlier run, from the picker, in the same panel: the model call's recorded request and replies are inspectable.
    await page.locator("[data-run-picker]").selectOption(OLDER);
    await expect(page.getByText(/^Earlier run · Older project/)).toBeVisible();
    const analysisRow = page.locator("[id^=stage-]", { hasText: "onboarding · analysis (run)" });
    await expect(analysisRow).toBeVisible();
    await expect(analysisRow.getByText("model", { exact: true })).toBeVisible();
    await analysisRow.getByText("model.analysis", { exact: true }).click();
    await expect(inspector).toContainText("claude-sonnet-4-5-20250929");
    await expect(inspector).toContainText("1,843");
    // The inspector keeps the tab as the selection moves, as it does in the simulator; Input is the recorded model request.
    await inspector.getByRole("button", { name: "Input" }).click();
    await expect(inspector.locator("pre")).toContainText('"max_tokens": 8192');
    await expect(inspector.locator("pre")).not.toContainText(/sk-[A-Za-z0-9]/);
    await inspector.getByRole("button", { name: "Output" }).click();
    const parsed = FIXTURE.snapshots.find((s) => s.kind === "model_parsed_response");
    await expect(inspector.locator("pre")).toContainText(Object.keys(parsed.content)[0]);
    await inspector.getByRole("button", { name: "Raw reply" }).click();
    await expect(inspector.locator("pre")).toContainText("end_turn");

    // A run recorded before the server kept lineage says so; no edge is guessed for it.
    await page.getByRole("button", { name: "Data flow" }).click();
    await expect(page.getByText("Lineage was not recorded for this run")).toBeVisible();
    await expect(page.locator("[data-node]")).toHaveCount(0);
    await page.getByRole("button", { name: /^Requests/ }).click();

    // Back to this session: both requests are still there, the product on the left never moved.
    await page.locator("[data-run-picker]").selectOption("__current");
    await expect(page.getByText("This session")).toBeVisible();
    await expect(page.locator("[id^=stage-]", { hasText: "onboarding · step" }).last()).toBeVisible();
    await expect(realFrame.locator(".ob-title", { hasText: "What year are you?" })).toBeVisible();
    // This session's runs recorded what they read and wrote, so the graph draws them: the row load read the session, the step wrote the profile.
    await page.getByRole("button", { name: "Data flow" }).click();
    await expect(page.locator("[data-node]").first()).toBeVisible();
    await expect(page.getByText("Lineage was not recorded for this run")).toHaveCount(0);
    await page.getByRole("button", { name: /^Requests/ }).click();

    // The URL keeps the mode across a reload; the product boots again against the real backend.
    const calls = onboardingCalls.length;
    await page.reload();
    await expect(page.locator('iframe[title="Engelbart setup, running against the real backend"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset test environment" })).toHaveCount(0);
    await expect(realFrame.locator(".ob-title", { hasText: "What year are you?" })).toBeVisible();
    await expect.poll(() => onboardingCalls.length).toBeGreaterThan(calls);
    await expect(page.locator("[id^=stage-]", { hasText: "onboarding · open" }).last()).toContainText("4 ops");

    // And back at the plain URL: nothing is open, so the dashboard shows the environment, and opening it boots
    // the product exactly as before.
    await page.goto(`${stack.url}/engelbart/setup/test`);
    await expect(page.getByText("Test environments")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset test environment" })).toHaveCount(0);
    await page.getByText("Environment 1", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Reset test environment" })).toBeVisible();
    await expect(simFrame.locator(".ob-title", { hasText: "What is your name?" })).toBeVisible();

    // Everything the debugger itself asked for was a read of the telemetry endpoint as the member; the only
    // writes were the product's own, and it never asked for a reset.
    const telemetry = apiRequests.filter((r) => r.path.startsWith("/api/engelbart-telemetry"));
    expect(telemetry.length).toBeGreaterThanOrEqual(4);
    for (const r of telemetry) { expect(r.method).toBe("GET"); expect(r.auth).toBe("Bearer " + MEMBER_TOKEN); expect(r.frame).toBe("page"); }
    expect(telemetry.some((r) => r.path === "/api/engelbart-telemetry?trace=" + TRACE.open)).toBe(true);
    expect(telemetry.some((r) => r.path === "/api/engelbart-telemetry?trace=" + TRACE.step)).toBe(true);
    expect(telemetry.some((r) => r.path === "/api/engelbart-telemetry?run=" + OLDER)).toBe(true);
    const writes = apiRequests.filter((r) => r.method !== "GET");
    expect(writes.every((r) => r.path === "/api/engelbart-onboarding" && r.frame === "frame")).toBe(true);
    expect(new Set(onboardingCalls.map((c) => c.action))).toEqual(new Set(["open", "step"]));
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
