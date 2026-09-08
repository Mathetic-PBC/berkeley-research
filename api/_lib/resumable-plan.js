"use strict";
const crypto = require("node:crypto");
const OM = require("./onboarding-model");
const Grounding = require("./paper-grounding");
const Resources = require("./project-resources");
const Storage = require("./storage");
const Budget = require("./request-budget");
const { rpc } = require("./supabase");
const LABELS = { resources: "Checking the selected resource", grounding: "Reading the paper", draft: "Drafting the proposal", review: "Checking the proposal", correction: "Revising the proposal", ready: "Ready" };
const fields = ["paper_id", "analysis", "asset_chosen", "assets", "leveled", "interest", "assessment", "name", "year", "major", "depth", "project_url", "repo_url", "direction", "subgoals", "todos"];
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
function contextOf(row, kind) {
  return Object.fromEntries(fields.map(k => [k, row[k] ?? null]));
}
function reply(job, status = job.status) {
  return { status, stage: job.stage, message: LABELS[job.stage], error: job.error || undefined,
    retryable: job.error?.type !== "rejected", ...(status === "complete" ? job.result : {}) };
}
async function advance(user, row, body, input, credentials, options = {}) {
  options = Budget.start(options);
  const kind = body.kind;
  if (!['direction', 'subgoals', 'todos'].includes(kind)) throw fail("Unknown planning step", 400);
  const context = contextOf(row, kind);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ prompts: options.promptOverrides || {}, reader: input.reader, turns: input.turns })).digest("hex");
  const old = row.planning?.[kind];
  const matches = old && require("node:util").isDeepStrictEqual(old.context, context) && old.fingerprint === fingerprint;
  const revising = Boolean(body.revise || body.regenerate);
  if (!revising && (!old || (matches && old.status === "complete")) && row[kind] && (kind !== "todos" || row.todos.length)) {
    return { status: "complete", [kind]: row[kind], name: row.project_name, asset_chosen: row.asset_chosen, leveled: row.leveled };
  }
  if (revising && !/^[a-zA-Z0-9_-]{8,100}$/.test(body.request_id || "")) throw fail("A revision needs a request ID", 400);
  const initial = { status: "pending", stage: kind === 'direction' ? 'resources' : 'grounding', attempt: 0,
    fingerprint, request_id: body.request_id || "", input, assets: structuredClone(row.leveled?.assets || row.assets?.assets || []) };
  const token = crypto.randomUUID();
  const args = { p_user: user.id, p_id: row.id, p_kind: kind, p_context: context, p_initial: initial, p_token: token, p_retry: body.retry === true };
  const claimed = await rpc("engelbart_plan_transition", args, options);
  if (claimed.status === "superseded") throw fail("The paper or planning inputs changed. Continue with the current selection.");
  if (claimed.status !== "claimed") return reply(claimed.job, claimed.status);
  const job = claimed.job;
  const prior = structuredClone(job); // A failed stage must not consume its correction attempt.
  let updates = {};
  try {
    if (job.stage === "resources") {
      job.input.asset = await Resources.resolveChosen(job.input.asset, job.assets, { ...options, paper: job.input.paper, propagateDiscoveryErrors: true,
        discoverFallback: value => OM.resourceFallback(value, credentials, { ...options, singleModelCall: true, withoutSearch: job.withoutSearch }) });
      job.stage = "grounding";
    } else if (job.stage === "grounding") {
      if (!Grounding.normalize(job.input.paper.grounding)) {
        const pdf = await Storage.downloadObject(Storage.paperObjectPath(row.paper_id), { ...options, maxBytes: 20 * 1024 * 1024 });
        job.input.paper.grounding = await OM.paperGrounding({ pdfBase64: pdf.toString('base64') }, credentials, options);
      }
      job.stage = "draft";
    } else {
      const result = await OM.planStage(kind, job.stage === "review" ? "review" : "draft", job.input, job.draft,
        job.correction || "", credentials, options);
      if (job.stage === "review" && result.passed) {
        job.status = "complete"; job.stage = "ready";
        const made = job.draft;
        updates.analysis = { ...row.analysis, grounding: job.input.paper.grounding };
        if (kind === "direction") {
          updates = { ...updates, direction: made, subgoals: null, todos: null, asset_chosen: job.input.asset,
            ...(row.leveled ? { leveled: { ...row.leveled, assets: job.assets } } : {}), step: 9 };
          job.result = { direction: made, asset_chosen: job.input.asset, leveled: updates.leveled || row.leveled };
        } else if (kind === "subgoals") {
          updates = { ...updates, subgoals: made.subgoals, todos: null, step: 10 };
          job.result = { subgoals: made.subgoals };
        } else {
          updates = { ...updates, todos: made.todos, goal_chosen: row.direction.title, project_name: row.project_name || made.name, step: 11 };
          job.result = { todos: made.todos, name: updates.project_name };
        }
      } else {
        if (job.stage !== "review") { job.draft = result.draft; job.attempt += 1; }
        if (result.reason || job.stage === "review") {
          job.correction = "Revise the proposal to resolve this validation failure: " + result.reason;
          if (job.attempt >= 2) {
            job.status = "error";
            job.error = { type: "rejected", message: "The proposal did not pass its evidence check: " + result.reason };
          } else job.stage = "correction";
        } else job.stage = "review";
      }
    }
    if (job.status === "running") job.status = "pending";
  } catch (error) {
    Object.assign(job, prior, { status: "error", error: { type: Budget.isTimeout(error) ? "timeout" : "request",
      message: Budget.isTimeout(error) ? Budget.expired().message : String(error.message || "This step failed").slice(0,600) } });
    if (error.retryWithoutSearch) Object.assign(job, { status: "pending", withoutSearch: true, error: null });
  }
  const saved = await rpc("engelbart_plan_transition", { ...args, p_save: job, p_updates: updates }, options);
  if (saved.status === "superseded") throw fail("The paper or planning inputs changed. The old result was discarded.");
  return reply(saved.job, saved.status);
}
module.exports = { advance, contextOf, LABELS };
