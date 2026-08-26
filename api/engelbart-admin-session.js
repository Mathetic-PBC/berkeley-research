"use strict";

const Admin = require("./_lib/admin-auth");
const { allowMethods, publicError, readJson, sendJson } = require("./_lib/http");

async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST", "DELETE"])) return;
  try {
    if (req.method === "DELETE") {
      res.setHeader("Set-Cookie", Admin.clearCookie());
      return sendJson(res, 200, { authenticated: false });
    }
    if (req.method === "GET") {
      try {
        const { config } = await Admin.requireAdmin(req);
        return sendJson(res, 200, {
          authenticated: true,
          mfaEnabled: Boolean(config.totp_enabled),
          recoveryCodesRemaining: Array.isArray(config.recovery_code_hashes)
            ? config.recovery_code_hashes.length
            : 0,
        });
      } catch (error) {
        if (error.statusCode === 401) return sendJson(res, 200, { authenticated: false });
        throw error;
      }
    }

    const body = await readJson(req);
    const result = await Admin.login(body.password, body.totpCode);
    if (result.mfaRequired) return sendJson(res, 202, { authenticated: false, mfaRequired: true });
    res.setHeader("Set-Cookie", Admin.sessionCookie(result.token));
    return sendJson(res, 200, {
      authenticated: true,
      mfaEnabled: result.mfaEnabled,
      recoveryCodeUsed: result.recoveryCodeUsed,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    });
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
