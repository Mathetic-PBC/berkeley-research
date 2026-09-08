"use strict";
// A paper-scoped job, shared by background requests and every planning stage.
const crypto = require("node:crypto");
const Budget = require("./request-budget");
const Grounding = require("./paper-grounding");
const OM = require("./onboarding-model");
const Storage = require("./storage");
const { rpc } = require("./supabase");
const { telemetry } = require("./telemetry");
async function run(user, row, body = {}, credentials, options = {}) {
  options = { ...Budget.start(options), deadlineAt: Math.min(options.deadlineAt || Infinity, Date.now() + 95000) };
  const args = { p_user: user.id, p_id: row.id, p_paper: row.paper_id, p_token: crypto.randomUUID(),
    p_run: !!(body.run || body.retry), p_retry: body.retry === true };
  return telemetry.runOperation({ name: "paper-grounding.job", type: "processing",
    reads: ["paper", "analysis"], writes: ["analysis"],
    attributes: { "engelbart.grounding.caller": body.caller || "background",
      "engelbart.grounding.retry": args.p_retry, "engelbart.grounding.poll": !args.p_run } }, async op => {
    const transition = (p_save = null) => rpc("engelbart_grounding_transition", { ...args, p_save }, options);
    let result = await transition();
    op.setAttributes({ "engelbart.grounding.initial_status": result.status,
      "engelbart.grounding.stale_recovery": result.stale === true,
      "engelbart.grounding.reused": result.status === "done" });
    if (result.status === "claimed") {
      let saved;
      try {
        const pdf = await Storage.downloadObject(Storage.paperObjectPath(args.p_paper),
          { ...options, maxBytes: 20 * 1024 * 1024 });
        const grounding = await OM.paperGrounding({ pdfBase64: pdf.toString("base64") }, credentials, options);
        saved = { status: "done", grounding };
      } catch (error) {
        saved = { status: "error", error: {
          type: Budget.isTimeout(error) ? "timeout" : "request",
          message: Budget.isTimeout(error) ? "Reading the paper timed out. Retry to continue." : String(error.message || "Could not read the paper").slice(0,300) } };
      }
      result = await transition(saved);
    }
    const grounding = Grounding.normalize(result.grounding);
    if (result.status === "done" && !grounding) throw new Error("The saved paper grounding is invalid");
    if (grounding) row.analysis = { ...row.analysis, grounding };
    row.planning = { ...row.planning, paper_grounding: result.job || { status: result.status } };
    op.setAttributes({ "engelbart.grounding.status": result.status, "engelbart.grounding.error_type": result.error?.type });
    return { grounding_status: result.status, grounding_error: result.error || null,
      grounding_started_at: result.job?.started_at || null, ...(grounding ? { grounding } : {}) };
  });
}
module.exports = { run };
