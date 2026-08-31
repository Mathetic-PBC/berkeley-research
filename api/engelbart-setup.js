"use strict";

const CliAuth = require("./_lib/cli-auth");
const Credits = require("./_lib/credits");
const Curated = require("./_lib/curated");
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
      // Prefer a participant's hand-curated landscape when one exists: it is
      // returned verbatim, in the curator's order, with no model call or credit
      // spend. Only when there is no curated bundle do we fall back to the
      // model-clustered interest retrieval that everyone else gets.
      const user = await verifyUser(bearerToken(req));
      const curated = await Curated.loadForUser(user);
      if (curated) {
        return sendJson(res, 200, { areas: Curated.toAreas(curated.bundle), curated: true });
      }
      const credentials = await Credits.credentialsFor(user);
      if (credentials.status === "exhausted" || credentials.status === "blocked") {
        const error = new Error("Your Engelbart Claude credit is used up, so setup"
          + " cannot run right now. Reach out to us to top it up.");
        error.statusCode = 409;
        throw error;
      }
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

    // The final "Generate project". The browser sends its (edited) name +
    // idea + four rough lanes; the lab is refetched for authoritative canonical
    // data (papers, people, projects), and a single structured model call turns
    // it into the workspace's real shape -- phase-tagged GOALS, each with its
    // own description/purpose/todos and a goal-level resource (a Brainstorm
    // document, or an Understand goal bound to a REAL canonical paper) -- plus
    // structured provenance. It rides the same pending-setup carrier and import
    // code as any project. If the model call fails (spent credit, a gateway
    // hiccup) it degrades to the classic flat-lane payload, so Generate never
    // hard-fails on the last step.
    if (action === "save_path") {
      const user = await verifyUser(bearerToken(req));
      const lab = body.piId ? await Research.lab(body.piId) : null;
      const idea = body.idea && typeof body.idea === "object" ? body.idea : {};
      const interest = String(body.interest || "");
      const pi = lab && lab.pi ? lab.pi : null;

      // Structured provenance -- stable canonical ids, kept as data. The papers
      // are filled in from whichever canonical papers the generator selected.
      const provenance = {
        interest,
        lab: pi ? { pi_id: body.piId, lab_name: pi.lab_name } : undefined,
        pi: pi ? { id: body.piId, name: pi.name } : undefined,
        students: (lab && Array.isArray(lab.members) ? lab.members : [])
          .map((m) => ({ id: m.id, name: m.name })),
        projects: (lab && Array.isArray(lab.projects) ? lab.projects : [])
          .map((p) => ({ id: p.id, title: p.title })),
        idea: { title: idea.title || idea.name || "", inspired: idea.inspired || "" },
      };
      const provenanceProse = [
        pi && pi.lab_name
          ? `Based on ${pi.lab_name}${pi.name ? `, led by ${pi.name}` : ""}.` : "",
        idea.inspired ? `Inspired by ${idea.inspired}.` : "",
      ].filter(Boolean).join(" ");

      let payload;
      try {
        // The structured generator is grounded in the refetched lab and billed
        // to the member's key; a lab of null still generates (empty Understand).
        const credentials = await Credits.credentialsFor(user);
        const project = await ResearchModel.generateProject(
          { interest, idea, lab: lab || {}, lanes: body.lanes }, credentials);
        provenance.papers = project.understand.map(
          (u) => ({ paper_id: u.paper.paper_id, title: u.paper.title }));
        payload = SetupChat.normalizePayload(ResearchModel.structuredToPayload(project, {
          name: body.name || idea.title || idea.name,
          objective: body.objective || idea.description,
          provenance, provenanceProse,
        }));
      } catch (modelError) {
        // Degrade to the classic flat-lane payload, keeping the structured
        // provenance so the fallback project is still related to the research.
        payload = SetupChat.normalizePayload(ResearchModel.explorationToPayload({
          name: body.name,
          objective: body.objective,
          idea,
          lanes: body.lanes,
          lab: pi ? { lab_name: pi.lab_name, pi_name: pi.name, department: pi.department } : {},
        }));
        const prov = SetupChat.normalizeProvenance(provenance);
        if (prov) payload.provenance = prov;
      }
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
