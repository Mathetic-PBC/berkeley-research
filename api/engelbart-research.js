"use strict";

// Read-only Berkeley research browsing for the onboarding exploration: opening
// one lab to its people and work. Gated on Engelbart membership (the same
// posture as every other authed endpoint); a CLI token is not accepted, because
// browsing is a browser act. The data comes from the SECURITY DEFINER RPCs in
// api/_lib/research.js.
//
// The step before this -- interest to research areas -- is model-backed and
// lives in engelbart-setup.js (action "areas"), because the visible areas are
// semantic clusters the model draws over the real labs, not a plain DB read.

const Curated = require("./_lib/curated");
const Research = require("./_lib/research");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const action = String(body.action || "");

    const user = await verifyUser(bearerToken(req));

    if (action === "lab") {
      // If this participant has a curated landscape and it includes this lab,
      // serve the curated view -- the same canonical facts, but filtered and
      // ordered to the curator's selection, with any note/override. Otherwise
      // the plain canonical lab detail everyone else sees.
      const curated = await Curated.loadForUser(user);
      if (curated) {
        const curatedDetail = await Curated.toLabDetail(curated.bundle, body.piId);
        if (curatedDetail) return sendJson(res, 200, curatedDetail);
      }
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
