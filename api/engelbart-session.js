"use strict";

const { issueSession } = require("./_lib/cli-session");
const { allowMethods, bearerToken, publicError, sendJson } = require("./_lib/http");
const { verifyPrincipal } = require("./_lib/cli-auth");

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await verifyPrincipal(bearerToken(req));
    return sendJson(res, 200, await issueSession(user));
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
