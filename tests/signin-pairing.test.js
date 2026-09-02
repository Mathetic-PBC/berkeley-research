"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const shared = require("../engelbart/shared.js");

function classList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) {
      if (force === undefined ? !values.has(value) : force) values.add(value);
      else values.delete(value);
    },
  };
}

function node() {
  return {
    classList: classList(),
    dataset: {},
    disabled: false,
    listeners: {},
    style: {},
    textContent: "",
    value: "",
    addEventListener(name, listener) { this.listeners[name] = listener; },
    querySelector() { return node(); },
    querySelectorAll() { return []; },
  };
}

async function flush() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function pairingPage(options = {}) {
  const elements = new Map();
  const requests = [];
  const document = {
    body: { classList: classList() },
    documentElement: {
      removeAttribute() {},
      setAttribute() {},
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
  };
  const session = options.signedIn === false ? null : {
    access_token: "browser-jwt",
    user: { id: "member-id", email: "member@example.com" },
  };
  const window = {
    EngelbartShared: shared,
    history: { replaceState() {} },
    location: { hash: "", pathname: "/engelbart/signin", search: options.search || "?code=ABCD-EFGH" },
    supabase: {
      createClient() {
        return {
          auth: {
            async getSession() { return { data: { session }, error: null }; },
            onAuthStateChange() {},
            async signOut() {},
          },
        };
      },
    },
  };
  async function fetch(url, init = {}) {
    requests.push({ url, init });
    if (url === "/api/engelbart-config") {
      return { ok: true, async json() { return { creditsEnabled: true }; } };
    }
    if (url === "/api/engelbart-credentials" && init.method === "POST") {
      return { ok: true, async json() { return { ready: true }; } };
    }
    if (url === "/api/engelbart-credentials") {
      return {
        ok: true,
        async json() {
          return { apiKey: "sk-example-long-enough", baseUrl: "https://proxy.example", budgetUsd: 25, spendUsd: 0 };
        },
      };
    }
    if (url === "/api/engelbart-device") {
      return { ok: true, async json() { return { approved: true }; } };
    }
    throw new Error(`Unexpected request: ${url}`);
  }

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../engelbart/app.js"), "utf8"),
    { document, fetch, setTimeout, URLSearchParams, window },
  );
  return { elements, requests };
}

test("the server, not a second browser regex, decides whether a credit invite is valid", async () => {
  const page = pairingPage();
  page.elements.get("pairing-use-credits").checked = true;
  page.elements.get("pairing-invite-code").value = "EGB-NOTHEX";
  await flush();

  page.elements.get("pairing-approve").listeners.click();
  await flush();

  const creditRequest = page.requests.find((request) =>
    request.url === "/api/engelbart-credentials" && request.init.method === "POST");
  assert.ok(creditRequest, "the invite must reach the authoritative server check");
  assert.deepEqual(JSON.parse(creditRequest.init.body), { inviteCode: "EGB-NOTH-EX" });
  assert.ok(page.requests.some((request) => request.url === "/api/engelbart-device"));
});

test("a pairing reroute lands a signed-out visitor on the signup view", async () => {
  const page = pairingPage({ signedIn: false });
  await flush();

  assert.equal(
    page.elements.get("page-def").textContent,
    "Your invite code reserves one account, and one Claude credit.",
  );
});

test("an explicit mode=login beats the pairing code's signup default", async () => {
  const page = pairingPage({ signedIn: false, search: "?code=ABCD-EFGH&mode=login" });
  await flush();

  assert.equal(
    page.elements.get("page-def").textContent,
    "Sign in to connect Engelbart.",
  );
});
