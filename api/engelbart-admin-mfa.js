"use strict";

const Admin = require("./_lib/admin-auth");
const { allowMethods, publicError, readJson, sendJson } = require("./_lib/http");

async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST"])) return;
  try {
    const { config } = await Admin.requireAdmin(req);
    if (req.method === "GET") {
      return sendJson(res, 200, { enabled: Boolean(config.totp_enabled) });
    }
    const body = await readJson(req);
    if (body.action === "begin") {
      const enrollment = await Admin.beginMfa();
      return sendJson(res, 200, enrollment);
    }
    if (body.action === "verify") {
      const token = await Admin.verifyMfa(body.code);
      res.setHeader("Set-Cookie", Admin.sessionCookie(token));
      return sendJson(res, 200, { enabled: true });
    }
    if (body.action === "disable") {
      const token = await Admin.disableMfa(body.password, body.code);
      res.setHeader("Set-Cookie", Admin.sessionCookie(token));
      return sendJson(res, 200, { enabled: false });
    }
    return sendJson(res, 400, { error: "Unknown MFA action" });
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
