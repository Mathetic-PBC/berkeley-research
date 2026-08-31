"use strict";

// The middle-pane Paper tab's source. Given a canonical paper id, it returns a
// fresh short-lived signed URL for the stored PDF, or -- when no PDF is stored
// -- the external source/DOI URL to fall back to. Gated on Engelbart membership
// like every other browser-facing read; the stable Storage path and the service
// role stay on the server, and the signed URL is minted per request so an
// expired one is simply re-fetched by re-calling this.

const Curated = require("./_lib/curated");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    await verifyUser(bearerToken(req));

    const action = String(body.action || "pdf_url");
    if (action === "pdf_url") {
      return sendJson(res, 200, await Curated.paperPdfUrl(body.paperId));
    }

    const error = new Error("Unknown Engelbart paper action");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
