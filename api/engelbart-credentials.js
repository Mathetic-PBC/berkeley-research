"use strict";

const Credits = require("./_lib/credits");
const { allowMethods, bearerToken, publicError, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST"])) return;
  try {
    const user = await verifyUser(bearerToken(req));
    if (req.method === "POST") {
      const row = await Credits.provision(user);
      return sendJson(res, 200, {
        ready: row.status === "ready",
        budgetUsd: Number(row.budget_usd),
        models: row.models,
      });
    }
    return sendJson(res, 200, await Credits.credentialsFor(user));
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
