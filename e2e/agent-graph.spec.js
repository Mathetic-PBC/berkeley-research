"use strict";

const { test, expect } = require("@playwright/test");
const { SimulationStack } = require("./fixtures/simulation-stack");

// Use the debugger's isolated simulated account. No production auth, telemetry,
// model requests, or user browser storage are involved in these interactions.
async function openGraph(page, { paper = false, denyFullscreen = false } = {}) {
  const stack = new SimulationStack();
  await stack.start();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdn.jsdelivr.net/npm/@supabase/**", route => route.abort());
  await page.addInitScript(({ denyFullscreen }) => {
    window.graphFullscreenProbe = { attempted: false, entered: false, denied: false };
    const request = Element.prototype.requestFullscreen;
    if (denyFullscreen || request) {
      Element.prototype.requestFullscreen = async function (...args) {
        window.graphFullscreenProbe.attempted = true;
        if (denyFullscreen) {
          window.graphFullscreenProbe.denied = true;
          throw new DOMException("Denied for the fallback regression", "NotAllowedError");
        }
        try {
          await request.apply(this, args);
          window.graphFullscreenProbe.entered = document.fullscreenElement === this;
        } catch (error) {
          window.graphFullscreenProbe.denied = true;
          throw error;
        }
      };
    }
  }, { denyFullscreen });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(`${stack.url}/engelbart/setup/test?mode=sim`);
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  if (paper) {
    const config = page.locator('[data-screen-label="Configure environment"]');
    await config.getByRole("button", { name: "Participant", exact: true }).click();
    await config.getByRole("button", { name: "Prefilled", exact: true }).click();
    await config.locator('input[type="file"]').setInputFiles({ name: "graph-fixture.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  }
  await page.getByRole("button", { name: /^Create environment/ }).click();
  const graph = page.getByRole("region", { name: "Agent map", exact: true });
  await expect(graph).toBeVisible(); // It is the default view, without clicking a tab.
  const frame = page.frameLocator('iframe[title="Engelbart setup, running against the simulated backend"]');
  await expect(frame.locator(".ob-title")).toHaveText(paper ? "What are you building on?" : "What is your name?");
  return { stack, graph, frame, errors, async close() { await page.close(); await stack.stop(); } };
}

async function searchNode(graph, query, id, click = false) {
  const search = graph.getByRole("searchbox", { name: "Find a node" });
  await search.fill(query);
  if (click) await graph.locator(`[data-agent-node="${id}"]`).click();
  else await search.press("Enter");
  await expect(graph.locator("[data-agent-detail]")).toHaveAttribute("data-agent-detail", id);
  await expect(graph.locator(`[data-agent-node="${id}"]`)).toHaveAttribute("aria-pressed", "true");
  return graph.getByRole("complementary", { name: "Agent details" });
}

async function transform(graph) {
  return graph.locator(".agent-map-plane").evaluate(node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { scale: matrix.a, x: matrix.e, y: matrix.f };
  });
}

test("agent map defaults to onboarding and exposes scoped purposes, prompts, sources and conditional connections", async ({ page }) => {
  const fixture = await openGraph(page);
  const { graph } = fixture;
  try {
    await expect(graph.getByRole("combobox", { name: "Scope" })).toHaveValue("onboarding");
    const details = await searchNode(graph, "analyzePrompt", "analysis");
    await expect(details.getByRole("heading", { name: "Read the sources", exact: true })).toBeVisible();
    await expect(details.locator(".agent-prompt pre")).toContainText("paper");
    expect((await details.locator(".agent-prompt pre").textContent()).length).toBeGreaterThan(100);
    await expect(details.getByRole("link").first()).toHaveAttribute("href", /^https:\/\/github\.com\/.*\/blob\/[a-f0-9]{40}\//);
    await expect(details).toContainText("Selected simulated recording");
    await expect(details).toContainText("No matching call recorded.");

    await searchNode(graph, "gradePrompt", "grade");
    const conditional = details.getByRole("button", { name: /To Ask a follow-up.*Grade\/self-rating disagreement.*conditional call/ });
    await expect(conditional).toBeVisible();
    await conditional.click();
    await expect(details).toHaveAttribute("data-agent-detail", "followup");
    await expect(details.locator(".agent-condition")).not.toBeEmpty();
    await expect(graph.locator('[data-connection="conditional"]').first()).toBeAttached();

    await graph.getByRole("combobox", { name: "Scope" }).selectOption({ label: "Installed workspace" });
    await expect(graph.locator('[data-agent-node="analysis"]')).toHaveCount(0);
    await searchNode(graph, "Overseer", "runtime-overseer", true);
    await expect(details).toContainText("Source architecture only");
    await expect(details.locator(".agent-recorded")).toHaveCount(0);
    await expect(details.getByRole("link").first()).toHaveAttribute("href", /claude-plugins\/blob\/[a-f0-9]{40}\//);
    await expect(details.locator(".agent-prompt").first()).toBeVisible();

    await graph.getByRole("combobox", { name: "Scope" }).selectOption({ label: "Other model APIs" });
    await searchNode(graph, "Generate research ideas", "research-generateIdeas");
    await expect(details.getByRole("link").first()).toHaveText(/api\/_lib\/research-model\.js/);
    await expect(details).toContainText("Source architecture only");
    await graph.getByRole("combobox", { name: "Scope" }).selectOption({ label: "Guided onboarding" });
    await expect(graph.getByRole("searchbox", { name: "Find a node" })).toHaveValue("");
    await expect(graph.getByRole("heading", { name: "Inspect a node" })).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

test("agent canvas pans, zooms and fits, and native fullscreen exits with focus restored", async ({ page }) => {
  const fixture = await openGraph(page);
  const { graph } = fixture;
  try {
    const canvas = graph.locator(".agent-canvas");
    await graph.getByRole("button", { name: "Fit", exact: true }).click();
    const fitted = await transform(graph);
    await graph.getByRole("button", { name: "Zoom graph in", exact: true }).click();
    await expect.poll(async () => (await transform(graph)).scale).toBeGreaterThan(fitted.scale);
    await graph.getByRole("button", { name: "Zoom graph out", exact: true }).click();
    await expect.poll(async () => Math.abs((await transform(graph)).scale - fitted.scale)).toBeLessThan(.005);
    await canvas.focus();
    await page.keyboard.press("+");
    await expect.poll(async () => (await transform(graph)).scale).toBeGreaterThan(fitted.scale);
    await page.keyboard.press("0");
    await expect.poll(async () => Math.abs((await transform(graph)).scale - fitted.scale)).toBeLessThan(.005);

    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 3, bounds.y + 3);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 63, bounds.y + 43, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await transform(graph)).x).toBeGreaterThan(40);
    await expect.poll(async () => (await transform(graph)).y).toBeGreaterThan(25);
    await graph.getByRole("button", { name: "Fit", exact: true }).click();
    await expect.poll(async () => (await transform(graph)).x).toBe(0);
    await expect.poll(async () => (await transform(graph)).y).toBe(0);

    await graph.getByRole("button", { name: "Fullscreen graph", exact: true }).click();
    await expect(graph.getByRole("button", { name: "Exit fullscreen graph", exact: true })).toBeVisible();
    await expect.poll(() => graph.evaluate(node => Math.abs(node.getBoundingClientRect().width - window.innerWidth))).toBeLessThan(1);
    await expect.poll(() => page.evaluate(() => {
      const probe = window.graphFullscreenProbe;
      return !probe.attempted || probe.entered || probe.denied;
    })).toBe(true);
    const probe = await page.evaluate(() => window.graphFullscreenProbe);
    if (probe.entered) expect(await page.evaluate(() => document.fullscreenElement?.matches("[data-agent-map]"))).toBe(true);
    else await expect(graph).toHaveClass(/agent-map-expanded/);
    await test.info().attach("fullscreen-result", { body: JSON.stringify(probe), contentType: "application/json" });
    await graph.getByRole("button", { name: "Exit fullscreen graph", exact: true }).click();
    await expect(graph).not.toHaveClass(/agent-map-expanded/);
    await expect(graph.getByRole("button", { name: "Fullscreen graph", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

test("denied fullscreen falls back to an expanded graph, Escape restores focus, and prompt editing remains reachable", async ({ page }) => {
  const fixture = await openGraph(page, { denyFullscreen: true });
  const { graph } = fixture;
  try {
    await graph.getByRole("button", { name: "Fullscreen graph", exact: true }).click();
    await expect(graph).toHaveClass(/agent-map-expanded/);
    await expect.poll(() => page.evaluate(() => window.graphFullscreenProbe.denied)).toBe(true);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect.poll(() => graph.evaluate(node => Math.abs(node.getBoundingClientRect().height - window.innerHeight))).toBeLessThan(1);
    await page.keyboard.press("Escape");
    await expect(graph).not.toHaveClass(/agent-map-expanded/);
    await expect(graph.getByRole("button", { name: "Fullscreen graph", exact: true })).toBeFocused();

    await graph.getByRole("button", { name: "Fullscreen graph", exact: true }).click();
    const details = await searchNode(graph, "analyzePrompt", "analysis");
    await details.getByRole("button", { name: "Edit environment prompt", exact: true }).click();
    await expect(graph).not.toHaveClass(/agent-map-expanded/);
    const editor = page.locator('[data-screen-label="Configure environment"]');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("analyzePrompt");
    expect((await editor.locator("textarea").inputValue()).length).toBeGreaterThan(100);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(graph).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

test("agent inspection preserves recorded model calls, Requests, Recorded data and sent Prompts", async ({ page }) => {
  const fixture = await openGraph(page, { paper: true });
  const { graph, frame } = fixture;
  try {
    // Ask the existing in-frame simulator to run analysis. Its own emitted
    // request/model events feed the debugger; the test does not inject rows.
    await page.locator('iframe[title="Engelbart setup, running against the simulated backend"]').evaluate(iframe => {
      iframe.contentWindow.postMessage({ egb: "cmd", cmd: "speed", value: .001 }, location.origin);
    });
    await frame.locator("body").evaluate(async () => {
      const response = await fetch("/api/engelbart-onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "analysis", run: true }) });
      if (!response.ok) throw new Error("Simulated analysis failed: " + response.status);
      await response.json();
    });
    const details = await searchNode(graph, "analyzePrompt", "analysis");
    await expect(details.locator(".agent-recorded")).toContainText("1 matching model call");
    await expect(details.locator(".agent-recorded .agent-connection")).toContainText("analysis");
    await details.locator(".agent-recorded .agent-connection").click();
    const inspector = page.locator('[data-screen-label="Inspector"]');
    await expect(inspector).toContainText("analyze the paper");
    await expect(inspector.locator("pre")).toContainText("messages");
    await page.getByRole("button", { name: /^Requests/ }).click();
    await expect(page.getByText("POST /api/engelbart-onboarding").first()).toBeVisible();
    await page.getByRole("button", { name: "Recorded data", exact: true }).click();
    await expect(page.locator("[data-node]").first()).toBeVisible();
    await page.getByRole("button", { name: /^Prompts/ }).click();
    await expect(page.locator('[data-prompt-tab="analyzePrompt"]')).toBeVisible();
    const call = page.locator("[data-prompt-call]").first();
    await expect(call).toContainText("[the paper, as a PDF document block");
    await expect(call).toContainText("Input · as the model received it");
    await expect(call).toContainText("Response · as parsed");
    await page.getByRole("button", { name: "Agent map", exact: true }).click();
    await expect(graph).toBeVisible();
    await expect(frame.locator(".ob-title")).toHaveText("What are you building on?");
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
