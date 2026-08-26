"use strict";

const Admin = require("./_lib/admin-auth");
const Credits = require("./_lib/credits");
const { allowMethods, publicError, readJson, sendJson } = require("./_lib/http");
const { rpc } = require("./_lib/supabase");

async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST"])) return;
  try {
    await Admin.requireAdmin(req);
    if (req.method === "GET") return sendJson(res, 200, await Credits.adminState());

    const body = await readJson(req);
    if (body.action === "generateInvite") {
      const value = await rpc("engelbart_generate_invite", {});
      const invite = Array.isArray(value) ? value[0] : value;
      if (!invite || !invite.code) throw new Error("Supabase generated no invite");
      return sendJson(res, 200, { invite });
    }
    if (body.action === "updateDefaults") {
      await Credits.updateDefaults(body);
      return sendJson(res, 200, await Credits.adminState());
    }
    if (body.action === "updateAccount") {
      await Credits.updateAccount(String(body.userId || ""), body);
      return sendJson(res, 200, await Credits.adminState());
    }
    if (body.action === "setBlocked") {
      await Credits.blockAccount(String(body.userId || ""), Boolean(body.blocked));
      return sendJson(res, 200, await Credits.adminState());
    }
    if (body.action === "syncAccount") {
      await Credits.syncAccount(String(body.userId || ""));
      return sendJson(res, 200, await Credits.adminState());
    }
    return sendJson(res, 400, { error: "Unknown admin action" });
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
