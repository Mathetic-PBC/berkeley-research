"use strict";

const Admin = require("./_lib/admin-auth");
const { allowMethods, publicError, readJson, sendJson } = require("./_lib/http");

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    await Admin.requireAdmin(req);
    const body = await readJson(req);
    const token = await Admin.resetPassword(body.newPassword);
    res.setHeader("Set-Cookie", Admin.sessionCookie(token));
    return sendJson(res, 200, { updated: true });
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
