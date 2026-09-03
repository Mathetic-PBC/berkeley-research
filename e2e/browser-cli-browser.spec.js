"use strict";

const { expect, test } = require("@playwright/test");

const { SETUP_CODE, SimulationStack, installBrowserSession } = require("./fixtures/simulation-stack");
const { SimulatedMachine } = require("./fixtures/simulated-machine");

const OS_LABEL = Object.freeze({ darwin: "macOS", linux: "Linux", win32: "Windows" });
const ARCH_LABEL = Object.freeze({
  darwin: { arm64: "Apple Silicon", x64: "Intel" },
  linux: { arm64: "ARM64", x64: "x64" },
  win32: { arm64: "ARM", x64: "x64" },
});

test("browser → CLI → /bart browser → Claude context", async ({ page }) => {
  test.setTimeout(240_000);
  const stack = new SimulationStack();
  await stack.start();
  const machine = new SimulatedMachine(stack.url);
  const sessionId = "browser-cli-browser-simulation";

  try {
    await installBrowserSession(page);
    await page.goto(`${stack.url}/engelbart/setup/?test=true`);
    await expect(page.getByText("Test mode", { exact: true })).toBeVisible();

    await page.locator(".ob-row").filter({ hasText: "Install" }).click();
    await expect(page.getByText("Which computer are you on?", { exact: true })).toBeVisible();
    await page.getByText(OS_LABEL[process.platform], { exact: true }).click();
    await page.getByText(ARCH_LABEL[process.platform][process.arch] || ARCH_LABEL[process.platform].x64, { exact: true }).click();

    // Two steps since the installer brings Claude Code itself: the terminal,
    // then the one connect command.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Install Engelbart and connect this account", { exact: true })).toBeVisible();

    const shownCommand = await page.locator(".ob-cmd-text").textContent();
    expect(shownCommand).toContain(SETUP_CODE);
    expect(shownCommand).toContain("--no-open");

    const installed = await machine.install(SETUP_CODE);
    expect(installed.stdout).toContain("Connected as sim@example.com. Go back to your browser tab");
    expect(stack.codeRedeemed).toBe(true);

    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "I've run it" }).click();
    await page.locator(".ob-row").filter({ hasText: "Todos" }).click();
    await expect(page.getByPlaceholder("project name…")).toHaveValue("Browser CLI Round Trip");
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page.getByText("Browser CLI Round Trip is saved", { exact: true })).toBeVisible();
    expect(stack.pendingSetup).not.toBeNull();

    const opened = await machine.openBart(sessionId);
    expect(opened.answer.decision).toBe("block");
    // The installer probes before the browser has finished; /bart is the
    // second, state-changing claim after Create project has supplied it.
    expect(stack.pendingClaims, JSON.stringify(stack.requests)).toBe(2);
    expect(stack.pendingSetup).toBeNull();
    expect(opened.answer.reason).toContain('created "Browser CLI Round Trip" from your web setup');

    await page.goto(opened.url, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Prove browser and Claude share one plan", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText("Pair an isolated machine", { exact: true }).first().click();
    await expect(page.getByText("Redeem the setup code with the checked-out CLI", { exact: true }).first()).toBeVisible();

    const browserGoal = "Browser edit reaches Claude context";
    await page.getByText("Add goal", { exact: true }).last().click();
    await page.keyboard.type(browserGoal);
    await page.keyboard.press("Enter");
    await expect(page.getByText(browserGoal, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await machine.waitForGoalContext(browserGoal);

    const injected = await machine.nextPrompt(sessionId, "Continue from the plan I just edited.");
    expect(injected.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(injected.hookSpecificOutput.additionalContext).toContain(browserGoal);
  } finally {
    await machine.stop();
    await stack.stop();
  }
});
