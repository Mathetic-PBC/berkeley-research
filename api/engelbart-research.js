"use strict";

// Read-only Berkeley research browsing for the onboarding exploration. Every
// call is gated on Engelbart membership (the same posture as every other authed
// endpoint); a CLI token is not accepted, because browsing is a browser act.
// The data itself comes from the SECURITY DEFINER RPCs in api/_lib/research.js.

const Research = require("./_lib/research");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const action = String(body.action || "");

    await verifyUser(bearerToken(req));

    if (action === "areas") {
      return sendJson(res, 200, { areas: await Research.areas(body.interest) });
    }

    if (action === "labs") {
      return sendJson(res, 200, { labs: await Research.labs(body.departmentId, body.interest) });
    }

    if (action === "lab") {
      const detail = await Research.lab(body.piId);
      if (!detail) {
        const error = new Error("Lab not found");
        error.statusCode = 404;
        throw error;
      }
      return sendJson(res, 200, detail);
    }

    const error = new Error("Unknown Engelbart research action");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
