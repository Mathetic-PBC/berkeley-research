"use strict";

// The onboarding page's one endpoint. Every action names the member by their
// Supabase session, loads their live onboarding row, and -- for anything that
// asks the model -- bills their own credit key, exactly as the setup
// conversation did. The record module does the work; this file only routes.

const Credits = require("./_lib/credits");
const OnboardingRecord = require("./_lib/onboarding");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");

const MODEL_ACTIONS = new Set(["sources", "analysis", "assets", "leveled", "answer", "brainstorm", "asset_ask",
  "direction", "subgoals", "details", "goals", "todos", "ask"]);
// The three background readers are polled for free; only starting or
// retrying one bills the key.
const POLLED = new Set(["analysis", "assets", "leveled"]);

function spent(credentials) {
  return credentials.status === "exhausted" || credentials.status === "blocked";
}

function creditGone() {
  const error = new Error("Your Engelbart Claude credit is used up, so setup cannot run right now. Reach out to us to top it up.");
  error.statusCode = 409;
  return error;
}

function creditsOf(user, d) {
  return (d.credentialsFor || Credits.credentialsFor)(user, d.options || {});
}

async function memberCredentials(user, d) {
  const credentials = await creditsOf(user, d);
  if (spent(credentials)) throw creditGone();
  return credentials;
}

// `open` is the one action a spent key must not be able to block outright. A
// finished setup holds the pairing code the member came back for; refusing to
// show it because the pool ran dry would strand them with no way to read the
// one thing they still need. So the row decides: unfinished, the credit rule
// stands, because every remaining step of the flow asks the model; finished,
// the page opens and the meter carries the verdict for it to display.
async function creditForOpen(user, d, created) {
  let credentials = null;
  try {
    credentials = await creditsOf(user, d);
  } catch (error) {
    // A key that will not resolve at all -- never provisioned, paused by an
    // admin -- is the same situation, and gets the same answer.
    if (!created) throw error;
    return { status: "unavailable" };
  }
  if (spent(credentials) && !created) throw creditGone();
  return credentials;
}

// d = {OB?, credentialsFor?, options?} -- injected by tests; production uses
// the real modules and process.env.
async function dispatch(user, body, d = {}) {
  const OB = d.OB || OnboardingRecord;
  const options = d.options || {};
  const action = String(body.action || "");

  if (action === "reset") {
    // Test mode clearing the record. No model, no credit: the row is gone and
    // the reply is the open that follows, so the page redraws from it.
    await OB.reset(user, body, options);
    // Fresh: a finished setup left behind by `project` must not be shown
    // again in place of the new one the button promised.
    return OB.open(user, { fresh: true }, options);
  }
  if (action === "open") {
    // The row first, because whether the credit rule applies depends on it.
    const out = await OB.open(user, body, options);
    const created = Boolean(out.onboarding && out.onboarding.status === "created");
    const credit = await creditForOpen(user, d, created);
    return { ...out, credit: { status: credit.status, budgetUsd: credit.budgetUsd, spendUsd: credit.spendUsd } };
  }
  // Reading the analysis status is a row read, not a model call, and is priced
  // like one: only the `run` that starts the reader, or the retry that runs it
  // again, bills the key. `sources` no longer reads the paper, but it is the
  // last step before the flow needs the model for everything, so the credit
  // rule still stops there rather than three screens later.
  const needsModel = MODEL_ACTIONS.has(action) && !(POLLED.has(action) && !(body.run || body.retry));
  const credentials = needsModel ? await memberCredentials(user, d) : null;
  const { onboarding: row, calibrations } = await OB.open(user, {}, options);
  if (action === "step") return OB.step(user, row, body, options);
  if (action === "sources") return OB.sources(user, row, body, credentials, options);
  if (action === "analysis") return OB.analysis(user, row, body, credentials, options);
  if (action === "assets") return OB.assets(user, row, body, credentials, options);
  if (action === "answer") return OB.answer(user, row, calibrations, body, credentials, options);
  if (action === "topics_done") return OB.topicsDone(user, row, calibrations, body, options);
  if (action === "leveled") return OB.leveled(user, row, calibrations, body, credentials, options);
  if (action === "brainstorm") return OB.brainstorm(user, row, calibrations, body, credentials, options);
  if (action === "asset_ask") return OB.assetAsk(user, row, calibrations, body, credentials, options);
  if (action === "choose_asset") return OB.chooseAsset(user, row, body, options);
  if (action === "direction") return OB.direction(user, row, calibrations, body, credentials, options);
  if (action === "subgoals") return OB.subgoals(user, row, calibrations, body, credentials, options);
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
