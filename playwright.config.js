"use strict";

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-e2e",
      testMatch: ["browser-cli-browser.spec.js", "browser-compatibility.spec.js"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox-compat",
      testMatch: "browser-compatibility.spec.js",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-compat",
      testMatch: "browser-compatibility.spec.js",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
