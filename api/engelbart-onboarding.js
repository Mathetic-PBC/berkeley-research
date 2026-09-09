"use strict";

// The onboarding page's one endpoint. Every action names the member by their
// Supabase session, loads their live onboarding row, and -- for anything that
// asks the model -- bills their own credit key, exactly as the setup
// conversation did. The record module does the work; this file only routes.
//
// It is also where each action becomes one trace: `onboarding.<action>` is
// the workflow operation every database, storage, http, model and processing
// operation beneath it hangs from. The row id, learned once the row is read,
// groups the traces of one setup into one run. The three background readers
// are polled for free every few seconds; a poll is not traced unless asked
// (ENGELBART_TRACE_POLLS), so the graph shows the work and not the waiting.

const Credits = require("./_lib/credits");
const MemberKeys = require("./_lib/member-keys");
const OnboardingRecord = require("./_lib/onboarding");
const Prompts = require("./_lib/onboarding-prompts");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { verifyUser } = require("./_lib/supabase");
const { telemetry, userHash } = require("./_lib/telemetry");

const Budget = require("./_lib/request-budget");
const MODEL_ACTIONS = new Set(["plan", "sources", "analysis", "assets", "leveled", "answer", "brainstorm", "asset_ask",
  "direction", "subgoals", "details", "goals", "todos", "ask", "rewrite"]);
// The three background readers are polled for free; only starting or
// retrying one bills the key.
const POLLED = new Set(["analysis", "assets", "leveled"]);
const TEST_RUN_HEADER = "x-engelbart-test-run";
// The reply names the trace it produced, so a page that made the request can
// ask /api/engelbart-telemetry?trace= for exactly what the server did to
// answer it. An untraced poll sends no header.
const TRACE_HEADER = "x-engelbart-trace-id";

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

function keysOf(d) {
  return d.memberKeys || MemberKeys;
}

// A member who brought their own Anthropic key spends that, and the pool is
// neither asked nor allowed to refuse them. Everyone else is on the pool.
async function memberCredentials(user, d) {
  const own = await keysOf(d).credentials(user, d.options || {});
  if (own) return own;
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

function isPoll(action, body) {
  return POLLED.has(action) && !(body && (body.run || body.retry));
}

// A test harness names its run in the body or the header; bounded, optional.
function testRunId(body, d) {
  const given = String((body && body.test_run_id) || d.testRunId || "").trim();
  return given ? given.slice(0, 80) : null;
}

// Edited prompts a request carries for this one run of the member's own
// onboarding (`prompt_overrides`, from the execution debugger's environment):
// the editable prompts only, bounded, or nothing. They reach the model layer
// through the options and are named in the record; they change no one else's
// run and are stored nowhere.
function overridesOf(body) {
  return Prompts.sanitizeOverrides(body && body.prompt_overrides);
}

// The row's id is the run: once the row is read, the workflow and every
// operation started after it carry it.
function named(row) {
  if (row && row.id) telemetry.setRun({ onboarding_id: String(row.id) });
  return row;
}

async function route(user, body, d, action) {
  const OB = d.OB || OnboardingRecord;
  const overrides = overridesOf(body);
  const options = Budget.start(overrides ? { ...(d.options || {}), promptOverrides: overrides } : (d.options || {}));

  if (action === "reset") {
    // Test mode clearing the record. No model, no credit: the row is gone and
    // the reply is the open that follows, so the page redraws from it.
    await OB.reset(user, body, options);
    // Fresh: a finished setup left behind by `project` must not be shown
    // again in place of the new one the button promised.
    const out = await OB.open(user, { fresh: true }, options);
    named(out.onboarding);
    return out;
  }
  if (action === "open") {
    // The row first, because whether the credit rule applies depends on it.
    const out = await OB.open(user, body, options);
    named(out.onboarding);
    const created = Boolean(out.onboarding && out.onboarding.status === "created");
    // Their own key, if they brought one, and the pool otherwise. The page
    // is told which; the key itself is not part of any answer.
    const ownKey = await keysOf(d).status(user, options);
    const credit = ownKey.set ? { status: "own" } : await creditForOpen(user, d, created);
    return { ...out, credit: { status: credit.status, budgetUsd: credit.budgetUsd, spendUsd: credit.spendUsd },
      own_key: ownKey.set ? { set: true, last4: ownKey.last4 } : { set: false } };
  }
  // Reading the analysis status is a row read, not a model call, and is priced
  // like one: only the `run` that starts the reader, or the retry that runs it
  // again, bills the key. `sources` no longer reads the paper, but it is the
  // last step before the flow needs the model for everything, so the credit
  // rule still stops there rather than three screens later.
  const needsModel = MODEL_ACTIONS.has(action) && !isPoll(action, body);
  const credentials = needsModel ? await memberCredentials(user, d) : null;
  const { onboarding: row, calibrations } = await OB.open(user, {}, options);
  named(row);
  if (action === "dataset") return require("./_lib/onboarding-dataset").handle(user, row, body, options);
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
  if (action === "plan") return OB.plan(user, row, calibrations, body, credentials, options);
  if (action === "direction") return OB.direction(user, row, calibrations, body, credentials, options);
  if (action === "subgoals") return OB.subgoals(user, row, calibrations, body, credentials, options);
  if (action === "details") return OB.details(user, row, calibrations, body, credentials, options);
  if (action === "goals") return OB.goals(user, row, calibrations, body, credentials, options);
  if (action === "todos") return OB.todos(user, row, calibrations, body, credentials, options);
  if (action === "ask") return OB.ask(user, row, calibrations, body, credentials, options);
  if (action === "rewrite") return OB.rewrite(user, row, calibrations, body, credentials, options);
  if (action === "create") return OB.create(user, row, calibrations, body, options);
  const error = new Error("Unknown Engelbart onboarding action");
  error.statusCode = 400;
  throw error;
}

// d = {OB?, credentialsFor?, memberKeys?, options?, testRunId?, mode?, onTrace?} -- injected
// by tests and harnesses; production uses the real modules and process.env.
// `onTrace(traceId)` is told the workflow's trace id as soon as it starts.
//
// One action, one trace. A routine poll runs untraced unless polls are
// switched on, in which case it is its own clearly-marked `.poll` workflow.
async function dispatch(user, body, d = {}) {
  const action = String((body && body.action) || "");
  d = { ...d, options: Budget.forAction(d.options, action) };
  const poll = isPoll(action, body);
  if (poll && !telemetry.settings.tracePolls) return telemetry.untraced(() => route(user, body, d, action));
  const testRun = testRunId(body, d);
  // A real member request is live; a harness that names its run is test; a
  // harness may say otherwise (the fixture generator says "fixture").
  const run = { action: action || "unknown", user_hash: userHash(user && user.id), test_run_id: testRun,
    mode: d.mode || (testRun ? "test" : "live") };
  return telemetry.withRun(run, () => telemetry.runOperation({
    name: `onboarding.${action || "unknown"}${poll ? ".poll" : ""}`,
    type: "workflow",
    attributes: {
      "engelbart.action": action || "unknown",
      "engelbart.poll": poll,
      "engelbart.run_flag": Boolean(body && body.run),
      "engelbart.retry": Boolean(body && body.retry),
      "engelbart.prompts.edited": (() => { const o = overridesOf(body); return o ? Object.keys(o) : undefined; })(),
    },
  }, (op) => {
    if (typeof d.onTrace === "function" && op && op.trace_id) d.onTrace(op.trace_id);
    return route(user, body, d, action);
  }));
}

async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  let status = 200;
  let payload;
  let traceId = "";
  const startedAt = Date.now();
  try {
    const body = await readJson(req, 2 * 1024 * 1024);
    const options = Budget.forAction({}, String(body.action || ""));
    options.deadlineAt -= Date.now() - startedAt;
    // Authentication is bookkeeping, not onboarding; it stays out of the graph.
    const user = await telemetry.untraced(() => verifyUser(bearerToken(req), options));
    payload = await dispatch(user, body, { options, testRunId: String(req.headers[TEST_RUN_HEADER] || ""), onTrace: (id) => { traceId = id; } });
  } catch (error) {
    const failure = Budget.isTimeout(error) || error.statusCode === 504
      ? { status: 504, message: Budget.expired().message } : publicError(error);
    status = failure.status;
    payload = { error: failure.message };
  }
  // Spans and buffered records leave before the response does: a Vercel
  // function is frozen once it has answered, and a batch still in memory
  // would never land. Bounded, so a slow collector cannot hold the reply.
  await telemetry.flush();
  // A failed action still names its trace: what went wrong is in it.
  if (traceId) res.setHeader(TRACE_HEADER, traceId);
  return sendJson(res, status, payload);
}

module.exports = handler;
module.exports.TRACE_HEADER = TRACE_HEADER;
module.exports.dispatch = dispatch;
