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
