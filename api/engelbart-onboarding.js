"use strict";

// The onboarding page's one endpoint. Every action names the member by their
// Supabase session, loads their live onboarding row, and -- for anything that
// asks the model -- bills their own credit key, exactly as the setup
// conversation did. The record module does the work; this file only routes.

const Credits = require("./_lib/credits");
const OnboardingRecord = require("./_lib/onboarding");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

const MODEL_ACTIONS = new Set(["open", "sources", "analysis", "answer", "details", "goals", "todos", "ask"]);

function spent(credentials) {
  return credentials.status === "exhausted" || credentials.status === "blocked";
}

async function memberCredentials(user, d) {
  const credentials = await (d.credentialsFor || Credits.credentialsFor)(user, d.options || {});
  if (spent(credentials)) {
    const error = new Error("Your Engelbart Claude credit is used up, so setup cannot run right now. Reach out to us to top it up.");
    error.statusCode = 409;
    throw error;
  }
  return credentials;
}

// d = {OB?, credentialsFor?, options?} -- injected by tests; production uses
// the real modules and process.env.
async function dispatch(user, body, d = {}) {
  const OB = d.OB || OnboardingRecord;
  const options = d.options || {};
  const action = String(body.action || "");
  const credentials = MODEL_ACTIONS.has(action) ? await memberCredentials(user, d) : null;

  if (action === "open") {
    const out = await OB.open(user, body, options);
    return { ...out, credit: { status: credentials.status, budgetUsd: credentials.budgetUsd, spendUsd: credentials.spendUsd } };
  }
  const { onboarding: row, calibrations } = await OB.open(user, {}, options);
  if (action === "step") return OB.step(user, row, body, options);
  if (action === "sources") return OB.sources(user, row, body, credentials, options);
  if (action === "analysis") return OB.analysis(user, row, body, credentials, options);
  if (action === "answer") return OB.answer(user, row, calibrations, body, credentials, options);
  if (action === "details") return OB.details(user, row, calibrations, body, credentials, options);
  if (action === "goals") return OB.goals(user, row, calibrations, body, credentials, options);
  if (action === "todos") return OB.todos(user, row, calibrations, body, credentials, options);
  if (action === "ask") return OB.ask(user, row, calibrations, body, credentials, options);
  if (action === "create") return OB.create(user, row, calibrations, body, options);
  const error = new Error("Unknown Engelbart onboarding action");
  error.statusCode = 400;
  throw error;
}

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const user = await verifyUser(bearerToken(req));
    return sendJson(res, 200, await dispatch(user, body));
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
module.exports.dispatch = dispatch;
