"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const BERKELEY_ROOT = path.resolve(__dirname, "../..");

function claudePluginsRoot() {
  const configured = String(process.env.CLAUDE_PLUGINS_DIR || "").trim();
  const root = path.resolve(configured || path.join(BERKELEY_ROOT, "..", "claude-plugins"));
  const cli = path.join(root, "engelbart", "bin", "engelbart.js");
  if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`claude-plugins checkout not found at ${root}; set CLAUDE_PLUGINS_DIR`);
  }
  return root;
}

function windowsLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function csharpLiteral(value) {
  return JSON.stringify(String(value)).replace(/\\u2028|\\u2029/g, "");
}

function shellLiteral(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function hostPathWithoutClaude() {
  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude.ps1"]
    : ["claude"];
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !names.some((name) => fs.existsSync(path.join(entry, name))))
    .join(path.delimiter);
}

// A stateful executable, not a one-answer stub. The cross-platform test can
// start with a stale Claude, run the real Engelbart update decision, and then
// prove a second install observes the repaired version instead of updating or
// reinstalling it again. Every invocation is kept inside the fake machine.
function writeFakeClaude(bin, options = {}) {
  fs.mkdirSync(bin, { recursive: true });
  const versionFile = path.join(bin, "claude-version.txt");
  const logFile = path.join(bin, "claude-invocations.log");
  const initialVersion = options.version || "2.1.175";
  const updateVersion = options.updateVersion || "";
  const updateExit = Number.isInteger(options.updateExit) ? options.updateExit : 0;
  fs.writeFileSync(versionFile, `${initialVersion}\n`);
  if (process.platform === "win32") {
    const source = path.join(bin, "FakeClaude.cs");
    const executable = path.join(bin, "claude.exe");
    fs.writeFileSync(source, [
      "using System;",
      "using System.IO;",
      "public static class FakeClaude {",
      "  public static int Main(string[] args) {",
      `    File.AppendAllText(${csharpLiteral(logFile)}, String.Join(" ", args) + Environment.NewLine);`,
      "    if (args.Length > 0 && args[0] == \"--version\") {",
      `      Console.WriteLine(File.ReadAllText(${csharpLiteral(versionFile)}).Trim() + " (Claude Code)");`,
      "      return 0;",
      "    }",
      "    if (args.Length > 0 && args[0] == \"update\") {",
      ...(updateVersion ? [`      File.WriteAllText(${csharpLiteral(versionFile)}, ${csharpLiteral(`${updateVersion}\n`)});`] : []),
      `      return ${updateExit};`,
      "    }",
      "    return 0;",
      "  }",
      "}",
      "",
    ].join("\r\n"));
    const command = `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath ${windowsLiteral(source)}) -OutputAssembly ${windowsLiteral(executable)} -OutputType ConsoleApplication`;
    const built = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      encoding: "utf8",
    });
    if (built.status !== 0 || !fs.existsSync(executable)) {
      throw new Error(`could not build the simulated Claude executable: ${built.stderr || built.stdout}`);
    }
    return { executable, logFile, versionFile };
  }
  const executable = path.join(bin, "claude");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${shellLiteral(logFile)}`,
    "if [ \"${1:-}\" = \"--version\" ]; then",
    `  printf '%s (Claude Code)\\n' "$(cat ${shellLiteral(versionFile)})"`,
    "  exit 0",
    "fi",
    "if [ \"${1:-}\" = \"update\" ]; then",
    ...(updateVersion ? [`  printf '%s\\n' ${shellLiteral(updateVersion)} > ${shellLiteral(versionFile)}`] : []),
    `  exit ${updateExit}`,
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return { executable, logFile, versionFile };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(options.input || "");
  });
}

function findServerRecords(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name === "server.json") {
        try {
          const value = JSON.parse(fs.readFileSync(child, "utf8"));
          if (value && Number.isInteger(Number(value.pid))) found.push(value);
        } catch (error) {
          // A partially-written diagnostic record is not a process to stop.
        }
      }
    }
  };
  visit(root);
  return found;
}

function filesNamed(root, name) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name === name) found.push(child);
    }
  };
  visit(root);
  return found;
}

async function portClosed(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(300) });
    } catch (error) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

class SimulatedMachine {
  constructor(apiBase, options = {}) {
    this.pluginsRoot = claudePluginsRoot();
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "engelbart-e2e-"));
    this.managed = path.join(this.root, "managed");
    this.hcHome = path.join(this.root, "home");
    this.userHome = path.join(this.root, "user-home");
    this.vault = path.join(this.root, "vault");
    this.claudeConfig = path.join(this.root, "claude-config");
    this.fakeBin = path.join(this.root, "fake-bin");
    this.workspace = path.join(this.root, "workspace");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.claudeConfig, { recursive: true });
    fs.mkdirSync(this.userHome, { recursive: true });
    this.fakeClaude = writeFakeClaude(this.fakeBin, options.claude || {});
    this.env = {
      ...process.env,
      // This fixture models a person's machine even when Playwright itself is
      // running in CI. Leaving CI=1 would bypass the Claude install/update
      // lifecycle and make the simulation green without exercising it.
      CI: "",
      CLAUDE_CONFIG_DIR: this.claudeConfig,
      CLAUDE_VAULT_DIR: this.vault,
      ENGELBART_API_BASE: apiBase,
      HC_CHAT_PROVIDER: "mock",
      HC_CHAT_UI_IDLE_SECONDS: "0",
      HC_HOME: this.hcHome,
      // os.homedir() is part of the installer's lookup for the native Claude
      // launcher. Both spellings must point inside the fake machine or a test
      // can discover and execute the developer's real ~/.local/bin/claude.
      HOME: this.userHome,
      HUMAN_COMPACT_HOME: this.managed,
      HUMAN_COMPACT_PYTHON: process.platform === "win32" ? "python" : (process.env.HUMAN_COMPACT_PYTHON || "python3"),
      // Keep system compilers and Python, but never leave a developer's real
      // Claude as a fallback behind the fake executable.
      PATH: [path.join(this.managed, "bin"), this.fakeBin, hostPathWithoutClaude()].join(path.delimiter),
      PYTHONUNBUFFERED: "1",
      USERPROFILE: this.userHome,
    };
  }

  async install(code) {
    return this.installWithArgs(["--code", code, "--no-open"]);
  }

  async installLocal() {
    return this.installWithArgs(["--local-only", "--non-interactive", "--no-open"]);
  }

  async installWithArgs(args) {
    const cli = path.join(this.pluginsRoot, "engelbart", "bin", "engelbart.js");
    const result = await run(process.execPath, [cli, "install", ...args], {
      cwd: this.workspace,
      env: this.env,
    });
    if (result.code !== 0) {
      throw new Error(`Engelbart install failed (${result.code})\n${result.stdout}\n${result.stderr}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(this.managed, "install.json"), "utf8"));
    this.env.HC_EXECUTABLE = process.platform === "win32"
      ? path.join(manifest.runtime, "Scripts", "hc.exe")
      : path.join(this.managed, "bin", "hc");
    return result;
  }

  claudeInvocations() {
    try {
      return fs.readFileSync(this.fakeClaude.logFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  hookPath() {
    return path.join(this.hcHome, ".claude", "skills", "vault", "scripts", "chat-hook.cjs");
  }

  async hook(payload) {
    const result = await run(process.execPath, [this.hookPath()], {
      cwd: this.workspace,
      env: this.env,
      input: `${JSON.stringify(payload)}\n`,
    });
    if (result.code !== 0) {
      throw new Error(`installed Claude hook failed (${result.code})\n${result.stdout}\n${result.stderr}`);
    }
    return result;
  }

  async openBart(sessionId) {
    await this.hook({
      session_id: sessionId,
      hook_event_name: "SessionStart",
      cwd: this.workspace,
    });
    const result = await this.hook({
      session_id: sessionId,
      hook_event_name: "UserPromptExpansion",
      command_args: "",
      cwd: this.workspace,
    });
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    let answer;
    try {
      answer = JSON.parse(line);
    } catch (error) {
      throw new Error(`installed /bart hook returned no JSON: ${result.stdout}`);
    }
    const match = String(answer.reason || "").match(/http:\/\/127\.0\.0\.1:\d+\/?/);
    if (!match) throw new Error(`installed /bart hook returned no loopback URL: ${result.stdout}`);
    return { answer, url: match[0], result };
  }

  async nextPrompt(sessionId, prompt) {
    const result = await this.hook({
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt,
      cwd: this.workspace,
    });
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    return line ? JSON.parse(line) : {};
  }

  async waitForGoalContext(text, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const file of filesNamed(this.vault, "goal_context.md")) {
        if (fs.readFileSync(file, "utf8").includes(text)) return file;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`browser edit did not reach a persisted goal_context.md: ${text}`);
  }

  async stop() {
    const records = findServerRecords(this.vault);
    for (const record of records) {
      try {
        process.kill(Number(record.pid));
      } catch (error) {
        // Already exited is the desired state.
      }
    }
    await Promise.all(records.filter((record) => record.url).map((record) => portClosed(record.url)));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.rmSync(this.root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
}

module.exports = { SimulatedMachine, claudePluginsRoot };
