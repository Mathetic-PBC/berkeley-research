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

    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});

// Real runs mode: the member's recorded telemetry, read through
// /api/engelbart-telemetry and shown in the same panel. The endpoint is
// answered here from the documented example envelope, the session from a
// stand-in for supabase-js, so the test is the page's own behaviour: the
// list, opening a run, the inspector showing the recorded snapshots, going
// back, and the simulator coming back untouched. Every request the page makes
// in that mode is recorded, so a write or a model call would fail the test.
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "observability", "example-onboarding-analysis-run.json"), "utf8"));
const telemetryHandler = require("../api/engelbart-telemetry");

test("Real runs mode lists the member's runs, opens one in the debugger read-only, and hands back to the simulator", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  const pageErrors = [];
  const apiRequests = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) apiRequests.push({ method: r.method(), path: u.pathname + u.search, auth: r.headers().authorization || "" }); });
  const onboardingId = FIXTURE.run.onboarding_id;
  const listBody = { runs: [{ run_id: onboardingId, onboarding_id: onboardingId, onboarding_status: "open", step: 4, project_name: "Speculative decoding", paper_title: "Fast Inference from Transformers",
    created_at: "2026-09-06T02:40:00.000Z", updated_at: "2026-09-06T02:49:01.600Z", telemetry: telemetryHandler.summarize(FIXTURE.operations) },
  { run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", onboarding_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", onboarding_status: "created", step: 9, project_name: null, paper_title: null, created_at: "2026-08-01T10:00:00.000Z", updated_at: "2026-08-01T11:00:00.000Z", telemetry: null }] };
  const runBody = { ...FIXTURE, snapshots_inline: true, onboarding: listBody.runs[0] };
  try {
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
    // supabase-js is stood in for: the page sees a session for a member, without a network.
    await page.route("https://cdn.jsdelivr.net/npm/@supabase/**", (route) => route.abort());
    await page.addInitScript(() => {
      window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "member-token", user: { email: "member@example.com" } } } }) } }) };
    });
    await page.route((url) => url.origin === stack.url && url.pathname === "/api/engelbart-telemetry", async (route) => {
      const request = route.request();
      if (request.method() !== "GET" || request.headers().authorization !== "Bearer member-token") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Sign in to Engelbart first" }) });
      const params = new URL(request.url()).searchParams;
      if (params.get("run") === onboardingId) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runBody) });
      if (params.get("run")) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "No such run" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listBody) });
    });
    await page.route((url) => url.origin === stack.url && url.pathname.startsWith("/engelbart/"), async (route) => {
      const response = await route.fetch();
      const headers = Object.assign({}, response.headers(), deployedHeaders(new URL(route.request().url()).pathname));
      await route.fulfill({ response, headers });
    });

    await page.goto(`${stack.url}/engelbart/setup/test`);
    const frame = page.frameLocator('iframe[title^="Engelbart setup"]');
    await expect(frame.locator(".ob-title", { hasText: "What is your name?" })).toBeVisible();

    // The run list: the member's runs, the one with telemetry openable, the one without marked so.
    await page.getByRole("button", { name: "Real runs" }).click();
    await expect(page.getByText("Recent onboarding runs")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset test environment" })).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    const run = page.locator(`[data-run="${onboardingId}"]`);
    await expect(run).toBeVisible();
    await expect(run).toContainText("Speculative decoding");
    await expect(run).toContainText("open · step · sources · analysis");
    const old = page.locator('[data-run="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]');
    await expect(old).toContainText("onboarding aaaaaaaa");
    await expect(old).toBeDisabled();

    // The mode is remembered: a reload comes back to the list, not the simulator.
    await page.reload();
    await expect(page.getByText("Recent onboarding runs")).toBeVisible();
    await expect(run).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);

    // Opening the run: every action is a request row, the model call's recorded request and reply are in the inspector.
    await run.click();
    await expect(page.getByRole("button", { name: "‹ Back to runs" })).toBeVisible();
    await expect(page.getByText("ACTION onboarding.analysis")).toBeVisible();
    await page.getByText("model.analysis", { exact: true }).click();
    const inspector = page.locator('[data-screen-label="Inspector"]');
    await expect(inspector).toContainText("claude-sonnet-4-5-20250929");
    await expect(inspector).toContainText("1,843");
    await expect(inspector.locator("pre")).toContainText('"max_tokens": 8192');
    await inspector.getByRole("button", { name: "Output" }).click();
    const parsed = FIXTURE.snapshots.find((s) => s.kind === "model_parsed_response");
    await expect(inspector.locator("pre")).toContainText(Object.keys(parsed.content)[0]);
    await inspector.getByRole("button", { name: "Raw reply" }).click();
    await expect(inspector.locator("pre")).toContainText("end_turn");
    await expect(inspector).not.toContainText("est. cost");

    // The database write: its recorded PATCH and the row that came back.
    await page.getByText("analysis.persist", { exact: true }).click();
    await expect(inspector).toContainText("PATCH /rest/v1/engelbart_onboardings?id=eq.?");
    await inspector.getByRole("button", { name: "Input" }).click();
    const dbRequest = FIXTURE.snapshots.find((s) => s.kind === "database_request");
    await expect(inspector.locator("pre")).toContainText(Object.keys(dbRequest.content)[0]);
    await inspector.getByRole("button", { name: "Output" }).click();
    await expect(inspector.locator("pre")).toContainText("analysis_status");

    // No lineage is guessed for a real run.
    await page.getByRole("button", { name: "Data flow" }).click();
    await expect(page.getByText("Lineage is not recorded for real runs")).toBeVisible();
    await expect(page.locator("[data-node]")).toHaveCount(0);

    // Back to the list, then back to the simulator, which boots again exactly as before.
    await page.getByRole("button", { name: "‹ Back to runs" }).click();
    await expect(run).toBeVisible();
    await page.getByRole("button", { name: "Simulated" }).click();
    await expect(page.getByRole("button", { name: "Reset test environment" })).toBeVisible();
    await expect(frame.locator(".ob-title", { hasText: "What is your name?" })).toBeVisible();

    // Everything Real runs mode asked the server for was a read of the telemetry endpoint with the member's token.
    const real = apiRequests.filter((r) => r.path.startsWith("/api/engelbart-telemetry"));
    expect(real.length).toBeGreaterThanOrEqual(2);
    for (const r of real) { expect(r.method).toBe("GET"); expect(r.auth).toBe("Bearer member-token"); }
    expect(apiRequests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
