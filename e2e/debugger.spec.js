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
