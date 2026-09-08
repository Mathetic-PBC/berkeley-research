"use strict";

// The mock-up bracket at /engelbart/mockups. Three shapes:
//
//   GET  /api/engelbart-mockups             the mock-ups in the bucket (id, name) and the member's
//                                          saved placing, if any
//   GET  /api/engelbart-mockups?html=<id>   one mock-up's HTML, for the page's frames. No session:
//                                          the frame cannot carry one, and the bucket is public.
//                                          Served as HTML inside a CSP sandbox, so the mock-up's
//                                          scripts run on an opaque origin, never on ours
//   POST /api/engelbart-mockups             the member's placing -- { top: [{id}...], picks, entrants }
//                                          -- checked against the bucket and written to their row
//
// The member is named by their Supabase session, as every other page names
// them. Nothing here is part of an onboarding run, so nothing is traced.

const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");
const { telemetry } = require("./_lib/telemetry");
const Mockups = require("./_lib/mockups");

const HTML_TTL_SECONDS = 300;

function queryOf(req) {
  return new URL(String(req.url || "/"), "http://localhost").searchParams;
}

function sendHtml(res, page) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", `public, max-age=${HTML_TTL_SECONDS}, s-maxage=${HTML_TTL_SECONDS}`);
  return res.status(200).end(page.html);
}

async function run(req, res, options = {}) {
  if (!allowMethods(req, res, ["GET", "POST"])) return undefined;
  try {
    const params = queryOf(req);
    if (req.method === "GET" && params.get("html")) {
      const page = await telemetry.untraced(() => Mockups.readMockup(params.get("html"), options));
      return sendHtml(res, page);
    }
    const user = await telemetry.untraced(() => verifyUser(bearerToken(req), options));
    if (req.method === "POST") {
      const body = await readJson(req);
      const saved = await telemetry.untraced(() => Mockups.saveRanking(user, body, options));
      return sendJson(res, 200, { saved });
    }
    const [mockups, saved] = await telemetry.untraced(() => Promise.all([
      Mockups.listMockups(options),
      Mockups.loadRanking(user, options),
    ]));
    return sendJson(res, 200, { mockups: mockups.map((m) => ({ id: m.id, name: m.name })), saved });
  } catch (error) {
    const { status, message } = publicError(error);
    if (status >= 500) console.error("engelbart-mockups failed", error);
    return sendJson(res, status, { error: message });
  }
}

async function handler(req, res) {
  return run(req, res, {});
}

module.exports = handler;
module.exports.run = run;
module.exports.HTML_TTL_SECONDS = HTML_TTL_SECONDS;
