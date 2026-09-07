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

test("Claude lifecycle: a completed update is verified and a reinstall does not update again", async () => {
  test.setTimeout(240_000);
  // Model the failure mode where `claude update` has already replaced the
  // executable but exits nonzero during a final cleanup step. Exit status is
  // not the state of the machine: the post-update version probe is.
  const machine = new SimulatedMachine("http://127.0.0.1:9", {
    claude: { version: "2.1.174", updateVersion: "2.1.175", updateExit: 1 },
  });
  try {
    await machine.installLocal();
    await machine.installLocal();
    const calls = machine.claudeInvocations();
    expect(calls.filter((call) => call === "update")).toHaveLength(1);
    expect(calls.filter((call) => call === "--version").length).toBeGreaterThanOrEqual(4);
  } finally {
    await machine.stop();
  }
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
    // Installation/authentication and the claimed workspace below are the
    // contract. Decorative banners and progress wording may change.
    expect(installed.stdout).toContain("sim@example.com");
    expect(installed.stderr).toBe("");
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
    // This is the production renderer served by the installed wheel, not
    // /test or a source-tree server. Resource preparation crosses the same
    // claim boundary as the plan and remains durable after a reload.
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByLabel("Plan").getByText("Resources", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab").nth(0)).toHaveText("Bart");
    await expect(page.getByRole("tab").nth(1)).toHaveText("Live preview");
    await expect(page.getByRole("tab").nth(2)).toHaveText("Terminal");
    await expect(page.getByRole("tab", { name: "Dataset", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Dataset", exact: true }).click();
    await expect(page.locator(".resource-detail")).toContainText("event (text)");
    await expect(page.locator(".resource-detail")).toContainText("Private protocol traces");
    const dataset = await page.evaluate(() => window.engelbart.store.get().project.resources.find(r => r.kind === "dataset"));
    expect(dataset.status).toBe("ready");
    expect(dataset.access.primaryFiles[0].split(/[\\/]/)[0]).toBe(".engelbart-resources");
    await page.reload();
    await expect(page.getByRole("tab", { name: "Dataset", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Bart", exact: true }).click();
    await page.getByText("Pair an isolated machine", { exact: true }).first().click();
    await expect(page.getByRole("textbox", { name: "Todo", exact: true }).first()).toHaveValue("Redeem the setup code with the checked-out CLI");

    // The installed artifact carries the production TODO/layout/completion controls.
    const todo = page.getByRole("textbox", { name: "Todo", exact: true }).first();
    expect(await todo.evaluate(el => el.tagName)).toBe("TEXTAREA");
    await expect(page.getByRole("button", { name: "Build todo: Redeem the setup code with the checked-out CLI", exact: true })).toBeVisible();
    const planDivider = page.getByRole("separator", { name: "Plan width", exact: true });
    const plan = page.getByLabel("Plan", { exact: true });
    const width = (await plan.boundingBox()).width;
    await planDivider.focus();
    await planDivider.press("ArrowRight");
    expect((await plan.boundingBox()).width).toBeGreaterThan(width);
    await expect(page.getByRole("separator", { name: "Conversation and Todos width", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Complete subgoal: Pair an isolated machine", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen subgoal: Pair an isolated machine", exact: true })).toBeVisible();
    const completed = page.getByRole("button", { name: "Reopen subgoal: Pair an isolated machine", exact: true });
    await expect(completed).toHaveText("✓");
    expect(await completed.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
    await page.reload();
    expect((await plan.boundingBox()).width).toBeGreaterThan(width);
    await page.getByRole("button", { name: "Reopen subgoal: Pair an isolated machine", exact: true }).click();
    await expect(page.getByRole("button", { name: "Complete subgoal: Pair an isolated machine", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete goal", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reopen goal", exact: true })).toHaveCount(0);

    const browserGoal = "Browser edit reaches Claude context";
    await page.getByRole("button", { name: "+ Add subgoal", exact: true }).click();
    await page.getByRole("textbox", { name: "New subgoal", exact: true }).fill(browserGoal);
    await page.getByRole("textbox", { name: "New subgoal", exact: true }).press("Enter");
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
