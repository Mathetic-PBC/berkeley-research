"use strict";
const { test, expect } = require("@playwright/test");
const { SimulationStack, installBrowserSession } = require("./fixtures/simulation-stack");

test("mock-up desktop previews fit and stay mounted across analysis completion and resize", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  Object.assign(stack.row, { step: 6, analysis_status: "running", planning: { paper_grounding: { status: "running" } } });
  let htmlLoads = 0, polls = 0, complete = false;
  const savedChoices = [];
  const violations = [];
  await installBrowserSession(page);
  await page.exposeFunction("reportCsp", v => violations.push(v));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.reportCsp(e.violatedDirective)));
  // Exercise the preview under the production page's strict stylesheet policy.
  await page.route("**/engelbart/setup/?test=true", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "style-src 'self' https://fonts.googleapis.com" } });
  });
  await page.route("**/api/engelbart-mockups*", route => {
    if (new URL(route.request().url()).searchParams.has("html")) {
      htmlLoads++;
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><style>body{margin:0}main{display:grid;grid-template-columns:320px 1fr;height:820px}aside{background:#eee}h1{font:60px sans-serif}</style><main><aside>Sidebar</aside><section><h1>Create an interface to import the dataset</h1>Desktop preview</section></main>' });
    }
    if (route.request().method() === "POST") {
      const selection = route.request().postDataJSON(); savedChoices.push(selection);
      return route.fulfill({json:{saved:{top:selection.top.map((entry,i)=>({...entry,rank:i+1,name:`Design ${entry.id}`}))}}});
    }
    return route.fulfill({ json: { mockups: [1, 2, 3, 4].map(id => ({ id: String(id), name: `Design ${id}` })) } });
  });
  await page.route("**/api/engelbart-onboarding", route => {
    const b = route.request().postDataJSON();
    if (b.action === "analysis") { polls++; return route.fulfill({ json: { analysis_status: complete ? "done" : "running", analysis: stack.row.analysis } }); }
    if (b.action === "paper_grounding") return route.fulfill({ json: { grounding_status: "running" } });
    return route.continue();
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(stack.url + "/engelbart/setup/?test=true");
    await expect(page.locator(".ob-mk-frame")).toHaveCount(4);
    await expect.poll(() => htmlLoads).toBe(4);
    const original = await page.locator(".ob-mk-frame").first().elementHandle();
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => page.locator('.ob-mk-pane:not([data-preview="warm"]) .ob-mk-fit').evaluateAll(boxes => boxes.every(box => {
        const f = box.firstElementChild, r = f.getBoundingClientRect(), b = box.getBoundingClientRect();
        const main = document.querySelector(".ob-main").getBoundingClientRect();
        return b.left >= main.left && b.right <= main.right + 1 && f.clientWidth === 1280 && f.clientHeight === 820 && r.width <= b.width + 1 && r.height <= b.height + 1 && r.left >= b.left - 1 && r.right <= b.right + 1;
      }))).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => polls).toBeGreaterThan(0);
    complete = true;
    await expect.poll(() => polls).toBeGreaterThan(1);
    expect(await original.evaluate(el => el.isConnected)).toBe(true);
    expect(htmlLoads).toBe(4);
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await expect(page.locator(".ob-rail")).toHaveCSS("width", "64px");
    await expect.poll(async () => page.locator(".ob-mk-fit").first().evaluate(box => Math.abs(box.firstElementChild.getBoundingClientRect().width - box.clientWidth) < 2)).toBe(true);
    await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
    expect(await original.evaluate(el => el.isConnected)).toBe(true);
    expect(htmlLoads).toBe(4);
    expect(violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("mockup-previews.png") });
    const warmed = await page.locator('[data-preview="warm"] iframe').elementHandles();
    expect(warmed).toHaveLength(2);
    await expect(page.locator(".ob-mk-head,.ob-mk-open,.ob-mk-bar")).toHaveCount(0);
    await expect(page.getByRole("button",{name:/This one/})).toHaveCount(0);
    const initialChoice = page.locator('[data-preview="left"] .ob-mk-pick');
    await expect(initialChoice).toHaveAccessibleName(/Choose Design/);
    const previewBounds = await initialChoice.boundingBox();
    // A click inside the pictured design itself selects it; the iframe never consumes it.
    await page.mouse.click(previewBounds.x+previewBounds.width/2,previewBounds.y+previewBounds.height/2);
    for (const frame of warmed) {
      expect(await frame.evaluate(el => el.isConnected && el.closest(".ob-mk-pane").getAttribute("data-preview") !== "warm")).toBe(true);
    }
    expect(htmlLoads).toBe(4);
    expect(await original.evaluate(el => el.isConnected)).toBe(true);
    await expect(page.locator('.ob-mk-pane:not([data-preview="warm"])')).toHaveCount(2);
    for (let pick = 0; pick < 3; pick++) {
      await page.locator('[data-preview="left"] .ob-mk-pick').focus();
      await page.keyboard.press(pick % 2 ? "Space" : "Enter");
    }
    await expect(page.getByText("Your preferred interfaces", { exact: true })).toBeVisible();
    expect(htmlLoads).toBe(4); // Every comparison reuses the initial documents.
    expect(savedChoices).toHaveLength(1);
    expect(savedChoices[0].picks).toHaveLength(4);
    expect(new Set(savedChoices[0].top.map(entry=>entry.id)).size).toBe(4);
    await expect(page.locator(".ob-mk-frame")).toHaveCount(0);
    await page.getByRole("button", { name: "Choose again", exact: true }).click();
    for (let pick = 0; pick < 4; pick++) await page.locator('[data-preview="right"] .ob-mk-pick').click();
    await expect(page.getByText("Your preferred interfaces", { exact: true })).toBeVisible();
    await page.locator("#content .ob-cta").click();
    await page.getByRole("button", { name: "Interface", exact: true }).click();
    await expect(page.getByText("Your preferred interfaces", { exact: true })).toBeVisible();
    await page.locator("#content .ob-cta").click();
    await expect(page.getByText("What do you want to build?", { exact: true })).toBeVisible();
  } finally { await stack.stop(); }
});
