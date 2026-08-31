"use strict";

const CliAuth = require("./_lib/cli-auth");
const Credits = require("./_lib/credits");
const SetupChat = require("./_lib/setup-chat");
const Research = require("./_lib/research");
const ResearchModel = require("./_lib/research-model");
const { allowMethods, bearerToken, publicError, readJson, sendJson } = require("./_lib/http");
const { rpc, verifyUser } = require("./_lib/supabase");

// The onboarding exploration's model calls bill the member's own credit key,
// exactly like `turn`. One guard so ideas / refine / path fail the same
// friendly way when the credit is gone, instead of surfacing a gateway error.
async function memberCredentials(req) {
  const user = await verifyUser(bearerToken(req));
  const credentials = await Credits.credentialsFor(user);
  if (credentials.status === "exhausted" || credentials.status === "blocked") {
    const error = new Error("Your Engelbart Claude credit is used up, so setup"
      + " cannot run right now. Reach out to us to top it up.");
    error.statusCode = 409;
    throw error;
  }
  return { user, credentials };
}

// One retrieved lab row, mapped to the shape the browser renders in a research
// area. The PI's own interests are real and stay; students are not touched here
// (they only appear in the lab-detail view, by verified fields).
function publicLab(row) {
  return {
    piId: row.pi_id,
    piName: row.pi_name,
    title: row.title,
    labName: row.lab_name,
    department: row.department,
    bio: row.bio,
    interests: Array.isArray(row.interests) ? row.interests : [],
    nMembers: row.n_members,
    nProjects: row.n_projects,
  };
}

// A lab refetched from the database for grounding a model call, or a 404 that
// the browser turns into "that lab is no longer available".
async function groundingLab(piId) {
  const lab = await Research.lab(piId);
  if (!lab) {
    const error = new Error("Lab not found");
    error.statusCode = 404;
    throw error;
  }
  return lab;
}

// The web setup conversation. `turn` and `save` are the browser's, behind the
// member's own session; `pending` is the installer's, behind its machine
// token. Model calls bill the member's own credit key -- the same key their
// installed CLI will spend -- so the per-key limits are the throttle and the
// spend lands on the meter they can see.
async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const action = String(body.action || "");

    if (action === "turn") {
      const user = await verifyUser(bearerToken(req));
      const credentials = await Credits.credentialsFor(user);
      if (credentials.status === "exhausted" || credentials.status === "blocked") {
        const error = new Error("Your Engelbart Claude credit is used up, so setup"
          + " cannot run right now. Reach out to us to top it up.");
        error.statusCode = 409;
        throw error;
      }
      return sendJson(res, 200, await SetupChat.turn({
        transcript: body.transcript,
        shown: body.shown,
        credentials,
      }));
    }

    if (action === "save") {
      const user = await verifyUser(bearerToken(req));
      const payload = SetupChat.normalizePayload(body.payload);
      if (!payload.name) {
        const error = new Error("Name this project first");
        error.statusCode = 400;
        throw error;
      }
      if (!payload.plan.description && !payload.goals.length) {
        const error = new Error("There is nothing to save yet");
        error.statusCode = 400;
        throw error;
      }
      await rpc("engelbart_save_pending_setup", {
        p_user_id: user.id,
        p_payload: payload,
      });
      return sendJson(res, 200, { saved: true });
    }

    // The installer's half: claim-once, so the payload is materialized by
    // exactly one install. A JWT is also accepted, harmlessly -- the page
    // never calls this, but verifyPrincipal keeps one dispatch rule.
    if (action === "pending") {
      const user = await CliAuth.verifyPrincipal(bearerToken(req));
      const result = await rpc("engelbart_claim_pending_setup", { p_user_id: user.id });
      const value = Array.isArray(result) ? result[0] : result;
      return sendJson(res, 200, {
        payload: value && value.found ? value.payload : null,
      });
    }

    // The exploration's opening step: an interest to a few research areas. The
    // areas are semantic clusters the model draws over the REAL labs retrieved
    // for the interest -- not departments -- and each area carries the actual
    // labs beneath it, rehydrated here from the retrieval set so the model can
    // never surface a lab that isn't real. Member-billed like every model call.
    if (action === "areas") {
      const { credentials } = await memberCredentials(req);
      const labs = await Research.labMatches(body.interest);
      if (!labs.length) return sendJson(res, 200, { areas: [] });
      const byId = new Map(labs.map((row) => [row.pi_id, row]));
      const clustered = await ResearchModel.clusterAreas(
        { interest: body.interest, labs }, credentials);
      const areas = clustered
        .map((area) => ({
          label: area.label,
          summary: area.summary,
          labs: area.pi_ids.map((id) => byId.get(id)).filter(Boolean).map(publicLab),
        }))
        .filter((area) => area.labs.length);
      return sendJson(res, 200, { areas });
    }

    // The exploration, model-backed and member-billed. Each grounds generation
    // in a lab refetched here (authoritative real data), never in context the
    // browser supplies.
    if (action === "ideas") {
      const { credentials } = await memberCredentials(req);
      const lab = await groundingLab(body.piId);
      return sendJson(res, 200, {
        ideas: await ResearchModel.generateIdeas({ lab, interest: body.interest }, credentials),
      });
    }

    if (action === "refine") {
      const { credentials } = await memberCredentials(req);
      const lab = await groundingLab(body.piId);
      return sendJson(res, 200, await ResearchModel.refineIdea(
        { lab, idea: body.idea, note: body.note }, credentials));
    }

    if (action === "path") {
      const { credentials } = await memberCredentials(req);
      const lab = await groundingLab(body.piId);
      return sendJson(res, 200, await ResearchModel.generatePath(
        { lab, idea: body.idea, interest: body.interest }, credentials));
    }

    // The exploration's commit. The browser sends its (edited) name + idea +
    // four-lane path; the lab is refetched for authoritative provenance; the
    // whole thing is mapped into the classic setup payload and bounded, so it
    // rides the same pending-setup carrier and install code as a conversation
    // project, with no change on the hc import side.
    if (action === "save_path") {
      const user = await verifyUser(bearerToken(req));
      const lab = body.piId ? await Research.lab(body.piId) : null;
      const provenance = lab && lab.pi
        ? { lab_name: lab.pi.lab_name, pi_name: lab.pi.name, department: lab.pi.department }
        : {};
      const payload = SetupChat.normalizePayload(ResearchModel.explorationToPayload({
        name: body.name,
        objective: body.objective,
        idea: body.idea,
        lanes: body.lanes,
        lab: provenance,
      }));
      if (!payload.name) {
        const error = new Error("Name this project first");
        error.statusCode = 400;
        throw error;
      }
      if (!payload.subgoals.length && !payload.plan.description) {
        const error = new Error("There is nothing to save yet");
        error.statusCode = 400;
        throw error;
      }
      await rpc("engelbart_save_pending_setup", { p_user_id: user.id, p_payload: payload });
      return sendJson(res, 200, { saved: true });
    }

    const error = new Error("Unknown Engelbart setup action");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
