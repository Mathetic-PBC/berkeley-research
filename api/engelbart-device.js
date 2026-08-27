"use strict";

const CliAuth = require("./_lib/cli-auth");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

function requestOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host || !/^[A-Za-z0-9.:-]+$/.test(host)) return "";
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const action = String(body.action || "");

    if (action === "start") {
      return sendJson(res, 200, await CliAuth.startSession(body, { origin: requestOrigin(req) }));
    }

    if (action === "poll") {
      return sendJson(res, 200, await CliAuth.pollSession(body.deviceCode));
    }

    // Approval is the one step that must come from the browser session. A CLI
    // token is deliberately not accepted here: an installed CLI cannot enroll
    // another machine without the member approving it on screen.
    if (action === "approve" || action === "deny") {
      const user = await verifyUser(bearerToken(req));
      const result = await CliAuth.resolveSession(body.userCode, user, action === "approve");
      return sendJson(res, 200, { ...result, email: user.email });
    }

    if (action === "whoami") {
      const user = await CliAuth.verifyPrincipal(bearerToken(req));
      return sendJson(res, 200, { email: user.email });
    }

    if (action === "revoke") {
      return sendJson(res, 200, await CliAuth.revokeToken(body.token));
    }

    const error = new Error("Unknown Engelbart device action");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
module.exports.requestOrigin = requestOrigin;
