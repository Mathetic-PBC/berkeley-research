"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const Onboarding = require("../../api/_lib/onboarding");
const SetupChat = require("../../api/_lib/setup-chat");

const ROOT = path.resolve(__dirname, "../..");
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "sim@example.com" };
const ACCESS_TOKEN = "browser-simulation-token";
const MACHINE_TOKEN = "egb_simulation_machine_token";
const SETUP_CODE = "SIMU-LATE-0001";

const MIME = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".ps1": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
});

function initialOnboarding() {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    user_id: USER.id,
    status: "open",
    step: 11,
    name: "Sim Researcher",
    year: "Second year",
    major: "Computer Science",
    depth: "technical",
    paper_id: "33333333-3333-3333-3333-333333333333",
    paper_title: "Inspectable Intent in Agentic Programming",
    project_url: "https://example.test/paper",
    repo_url: "https://example.test/repository",
    paper_familiarity: 2,
    project_draft: "Test whether a browser-authored research plan survives the machine boundary.",
    analysis_status: "done",
    analysis_error: "",
    analysis: {
      title: "Inspectable Intent in Agentic Programming",
      date: "2026",
      one_liner: "A simulation fixture for an actual cross-process contract.",
      areas: [],
    },
    assets_status: "done",
    assets_error: "",
    assets: [],
    assets_brief: [],
    leveled_status: "done",
    leveled_error: "",
    leveled: { assets: [] },
    assessment: {
      areas: [{
        area: "End-to-end systems testing",
        parent_field: "Software engineering",
        level: 75,
        project_role: "Makes the browser and CLI one falsifiable system.",
      }],
      effective_depth: "technical",
    },
    interest: "Preserve a research plan across browser, CLI, and Claude Code.",
    asset_chosen: {
      key: "artifact",
      title: "The cross-process protocol",
      description: "The observable messages exchanged by the setup site and local plugin.",
      links: [{ label: "Protocol fixture", url: "https://example.test/protocol" }],
    },
    direction: {
      title: "Prove browser and Claude share one plan",
      what_you_would_make: "A native-OS simulation that starts on the Berkeley page, pairs the CLI, and opens the claimed plan in Engelbart.",
      first_visible_result: "The web-authored direction appears in the localhost goal tree.",
      why_it_fits: "The test fails at the exact boundary a user would experience.",
      uses: ["Playwright", "installed hook", "loopback server"],
    },
    subgoals: [
      {
        label: "Pair an isolated machine",
        description: "Redeem the browser's one-time code through the real CLI.",
        why: "Authentication is the first cross-process boundary.",
      },
      {
        label: "Claim the approved project",
        description: "Run the installed /bart hook and materialize the pending payload.",
        why: "This is where hosted setup becomes local state.",
      },
      {
        label: "Round-trip a browser edit",
        description: "Edit the localhost goal tree and observe it in the next Claude hook.",
        why: "A one-way import is not shared state.",
      },
    ],
    todos: [
      "Redeem the setup code with the checked-out CLI",
      "Open the claimed project through the installed /bart hook",
      "Read a browser-authored goal in the next Claude prompt",
    ],
    project_name: "Browser CLI Round Trip",
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) request.destroy(new Error("request too large"));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, value, contentType = "application/json; charset=utf-8") {
  const body = Buffer.isBuffer(value)
    ? value
    : contentType.startsWith("application/json")
      ? Buffer.from(JSON.stringify(value))
      : Buffer.from(String(value));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(body.length),
    "Content-Type": contentType,
  });
  response.end(body);
}

function browserAuthorized(request) {
  return request.headers.authorization === `Bearer ${ACCESS_TOKEN}`;
}

function machineAuthorized(request) {
  return request.headers.authorization === `Bearer ${MACHINE_TOKEN}`;
}

class SimulationStack {
  constructor() {
    this.server = null;
    this.url = "";
    this.row = initialOnboarding();
    this.pendingSetup = null;
    this.codeIssued = false;
    this.codeRedeemed = false;
    this.pendingClaims = 0;
    this.requests = [];
  }

  async start() {
    if (this.server) return this.url;
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        send(response, 500, { error: error.message || "simulation failure" });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    const held = this.server;
    this.server = null;
    await new Promise((resolve) => held.close(resolve));
  }

  async handle(request, response) {
    const target = new URL(request.url, this.url || "http://127.0.0.1");
    this.requests.push({ method: request.method, path: target.pathname });

    if (target.pathname === "/api/engelbart-config" && request.method === "GET") {
      return send(response, 200, {
        supabaseUrl: "https://simulation.supabase.invalid",
        supabaseAnonKey: "simulation-anon-key",
        creditsEnabled: true,
      });
    }

    if (target.pathname === "/api/engelbart-credentials") {
      if (!machineAuthorized(request)) return send(response, 401, { error: "invalid machine token" });
      return send(response, 200, request.method === "POST" ? { ready: true } : {
        status: "active",
        apiKey: "sk-simulation-credit",
        baseUrl: "https://simulation-proxy.invalid",
        budgetUsd: 25,
        spendUsd: 0,
      });
    }

    if (target.pathname === "/api/engelbart-device" && request.method === "POST") {
      const body = await readJson(request);
      if (body.action === "issue") {
        if (!browserAuthorized(request)) return send(response, 401, { error: "sign in first" });
        this.codeIssued = true;
        return send(response, 200, { code: SETUP_CODE, expiresInSeconds: 900 });
      }
      if (body.action === "redeem") {
        if (!this.codeIssued || body.code !== SETUP_CODE) {
          return send(response, 400, { error: "invalid or expired setup code" });
        }
        this.codeRedeemed = true;
        return send(response, 200, { token: MACHINE_TOKEN, email: USER.email });
      }
      if (body.action === "whoami") {
        if (!machineAuthorized(request)) return send(response, 401, { error: "invalid machine token" });
        return send(response, 200, { email: USER.email });
      }
      if (body.action === "revoke") return send(response, 200, { revoked: true });
      return send(response, 400, { error: "unknown device action" });
    }

    if (target.pathname === "/api/engelbart-onboarding" && request.method === "POST") {
      if (!browserAuthorized(request)) return send(response, 401, { error: "sign in first" });
      const body = await readJson(request);
      if (body.action === "open") {
        return send(response, 200, {
          onboarding: clone(this.row),
          calibrations: [],
          turns: [],
          profile_reused: false,
          credit: { status: "active", budgetUsd: 25, spendUsd: 0 },
        });
      }
      if (body.action === "step") {
        this.row = { ...this.row, ...(body.fields || {}) };
        this.row.step = Math.max(Number(this.row.step) || 0, Number(body.step) || 0);
        return send(response, 200, { onboarding: clone(this.row) });
      }
      if (body.action === "create") {
        this.row.project_name = String(body.project_name || this.row.project_name).trim();
        this.row.todos = Array.isArray(body.todos) ? body.todos.slice() : this.row.todos;
        this.row.goal_chosen = this.row.direction.title;
        this.row.status = "created";
        this.row.step = 12;
        this.row.pending_setup_id = "44444444-4444-4444-4444-444444444444";
        this.pendingSetup = SetupChat.normalizePayload(Onboarding.toPayload(this.row, []));
        return send(response, 200, {
          ok: true,
          pending_setup_id: this.row.pending_setup_id,
          profile_saved: true,
        });
      }
      return send(response, 400, { error: `unsupported simulation action: ${body.action}` });
    }

    if (target.pathname === "/api/engelbart-setup" && request.method === "POST") {
      const body = await readJson(request);
      if (body.action === "pending") {
        if (!machineAuthorized(request)) return send(response, 401, { error: "invalid machine token" });
        const payload = this.pendingSetup;
        this.pendingSetup = null;
        this.pendingClaims += 1;
        return send(response, 200, { payload });
      }
      return send(response, 400, { error: `unsupported setup action: ${body.action}` });
    }

    return this.serveStatic(target.pathname, response);
  }

  serveStatic(pathname, response) {
    let relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    if (!relative) relative = "index.html";
    if (relative.endsWith("/")) relative += "index.html";
    if (relative === "engelbart/setup") relative = "engelbart/setup/index.html";
    if (relative === "engelbart") relative = "engelbart/index.html";
    const file = path.resolve(ROOT, relative);
    if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
      return send(response, 403, { error: "outside simulation root" });
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      return send(response, 404, { error: "not found" });
    }
    if (!stat.isFile()) return send(response, 404, { error: "not found" });
    return send(response, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  }
}

async function installBrowserSession(page) {
  await page.addInitScript(({ accessToken, user }) => {
    window.supabase = {
      createClient() {
        return {
          auth: {
            async getSession() {
              return { data: { session: { access_token: accessToken, user } }, error: null };
            },
            onAuthStateChange() {
              return { data: { subscription: { unsubscribe() {} } } };
            },
          },
        };
      },
    };
  }, {
    accessToken: ACCESS_TOKEN,
    user: USER,
  });
  // The production script has SRI, so fulfilling this URL with a fake body
  // would correctly fail the browser's integrity check. The init script owns
  // the test double; the external request is simply kept offline.
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
}

module.exports = {
  ACCESS_TOKEN,
  MACHINE_TOKEN,
  SETUP_CODE,
  SimulationStack,
  installBrowserSession,
};
