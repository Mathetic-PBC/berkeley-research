"use strict";

const { expect, test } = require("@playwright/test");

const { SETUP_CODE, SimulationStack, installBrowserSession } = require("./fixtures/simulation-stack");

const CASES = [
  { os: "macOS", arch: "Apple Silicon", fragment: "install.sh | sh -s -- --code" },
  { os: "Windows", arch: "x64", fragment: "scriptblock]::Create" },
  { os: "Linux", arch: "x64", fragment: "install.sh | sh -s -- --code" },
];

test("the install handoff is operable for every supported desktop OS", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  try {
    await installBrowserSession(page);
    for (const item of CASES) {
      await page.goto(`${stack.url}/engelbart/setup/?test=true`);
      await page.evaluate(() => localStorage.removeItem("engelbart.install"));
      await page.reload();
      await page.locator(".ob-row").filter({ hasText: "Install" }).click();
      await page.getByText(item.os, { exact: true }).click();
      await page.getByText(item.arch, { exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      const command = await page.locator(".ob-cmd-text").textContent();
      expect(command).toContain(item.fragment);
      expect(command).toContain(SETUP_CODE);
      expect(command).toContain("--no-open");
    }
  } finally {
    await stack.stop();
  }
});


test("navigation collapses, remembers its width, and expands with the keyboard", async ({ page }) => {
  const stack = new SimulationStack();
  await stack.start();
  try {
    await installBrowserSession(page);
    await page.goto(`${stack.url}/engelbart/setup/?test=true`);
    const rail = page.locator(".ob-rail");
    const before = await rail.boundingBox();
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await expect(rail).toHaveCSS("width", "64px");
    expect((await rail.boundingBox()).width).toBeLessThan(before.width / 2);
    await page.reload();
    await expect(rail).toHaveCSS("width", "64px");
    // Step names remain accessible while their labels are visually hidden.
    await page.getByRole("button", { name: "Paper", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Which paper are you building on?", { exact: true })).toBeVisible();
    const expand = page.getByRole("button", { name: "Expand navigation", exact: true });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Collapse navigation", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect((await rail.boundingBox()).width).toBe(before.width);
    await page.reload();
    await expect(page.getByRole("button", { name: "Collapse navigation", exact: true })).toBeVisible();
  } finally { await stack.stop(); }
});
