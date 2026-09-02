"use strict";

const crypto = require("node:crypto");

const CliAuth = require("./_lib/cli-auth");
const Credits = require("./_lib/credits");
const Curated = require("./_lib/curated");
const SetupChat = require("./_lib/setup-chat");
const Research = require("./_lib/research");
const ResearchModel = require("./_lib/research-model");
const Storage = require("./_lib/storage");
const PageFetch = require("./_lib/page-fetch");
const { encryptionKey, supabaseConfig } = require("./_lib/config");
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

// When the signed-in participant has a curated selection of papers for this lab,
// narrow (and order) the lab's paper pool to that selection: the curated papers
// become the highest-priority paper context for ideas AND the allowed pool for
// Understand. No selection -> the full canonical PI paper set, untouched. The
// bundle stores only references, so this reorders canonical rows, never copies.
async function applyCuratedPapers(lab, user, piId) {
  if (!lab || !user || !Array.isArray(lab.papers) || !lab.papers.length) return lab;
  try {
    const sel = await Curated.labSelectionForUser(user, piId);
    if (sel && sel.paper_ids.length) lab.papers = Curated.selectPapers(lab.papers, sel.paper_ids);
  } catch { /* a curated selection is best-effort; keep the full set on any miss */ }
  return lab;
}

// A lab refetched from the database for grounding a model call, or a 404 that
// the browser turns into "that lab is no longer available". Curated paper
// selection (when the participant has one) is applied to the paper pool.
async function groundingLab(piId, user) {
  const lab = await Research.lab(piId);
  if (!lab) {
    const error = new Error("Lab not found");
    error.statusCode = 404;
    throw error;
  }
  await applyCuratedPapers(lab, user, piId);
  return lab;
}

// The generic, interest-driven discovery step: retrieve real labs for an
// interest, drop any already in `exclude` (a curated set), and cluster the rest
// into areas. Each area is marked `discovered` so the UI can show it after a
// participant's curated pool. Returns [] when nothing new matches.
async function discoverAreas(interest, credentials, exclude) {
  const labs = (await Research.labMatches(interest)).filter((row) => !exclude.has(row.pi_id));
  if (!labs.length) return [];
  const byId = new Map(labs.map((row) => [row.pi_id, row]));
  const clustered = await ResearchModel.clusterAreas({ interest, labs }, credentials);
  return clustered
    .map((area) => ({
      label: area.label,
      summary: area.summary,
      labs: area.pi_ids.map((id) => byId.get(id)).filter(Boolean).map(publicLab),
      discovered: true,
    }))
    .filter((area) => area.labs.length);
}

// The participant's own project context ("bring your own project"): background
// in their words plus, when they attached one, the paper own_paper created.
// Bounded here; the paper id must be a real uuid or the paper is dropped.
function ownContext(value) {
  if (!value || typeof value !== "object") return null;
  const information = String(value.information || "").slice(0, 2000).trim();
  const p = value.paper && typeof value.paper === "object" ? value.paper : null;
  const id = p ? Curated.optUuid(p.id) : "";
  const paper = id ? {
    id,
    title: String(p.title || "").slice(0, 300).trim(),
    url: String(p.url || "").slice(0, 500).trim(),
  } : null;
  if (!information && !paper) return null;
  return { information, paper };
}

// Proof that THIS member created THIS paper through own_paper just now, so the
// pdf-recording step cannot be pointed at an arbitrary canonical paper. The
// curator endpoints stay curator-gated; this is the member-scoped equivalent.
function ownPaperToken(paperId, userId, env = process.env) {
  return crypto.createHmac("sha256", encryptionKey(env))
    .update(`own-paper:${paperId}:${userId}`).digest("base64url");
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
      // Curated-first, then contextual expansion. A participant's hand-curated
      // landscape leads -- returned verbatim, in the curator's order, always,
      // with no credit spend. The generic interest retrieval STILL runs on top
      // (best effort) and appends additional real labs the curator did not
      // preselect, de-duplicated against the curated set, so curation improves
      // reliability without disabling discovery. An uncurated participant gets
      // the generic interest retrieval alone, exactly as before.
      const user = await verifyUser(bearerToken(req));
      const interest = body.interest;
      const hasInterest = String(interest == null ? "" : interest).trim().length > 0;
      const curated = await Curated.loadForUser(user);

      if (curated) {
        const curatedAreas = Curated.toAreas(curated.bundle);
        const exclude = new Set();
        curatedAreas.forEach((area) => area.labs.forEach((lab) => exclude.add(lab.piId)));
        let discovered = [];
        if (hasInterest) {
          try {
            const credentials = await Credits.credentialsFor(user);
            if (credentials.status !== "exhausted" && credentials.status !== "blocked") {
              discovered = await discoverAreas(interest, credentials, exclude);
            }
          } catch { discovered = []; }   // curated labs are guaranteed; discovery is a bonus
        }
        return sendJson(res, 200, { areas: [...curatedAreas, ...discovered], curated: true });
      }

      const credentials = await Credits.credentialsFor(user);
      if (credentials.status === "exhausted" || credentials.status === "blocked") {
        const error = new Error("Your Engelbart Claude credit is used up, so setup"
          + " cannot run right now. Reach out to us to top it up.");
        error.statusCode = 409;
        throw error;
      }
      const areas = await discoverAreas(interest, credentials, new Set());
      return sendJson(res, 200, { areas });
    }

    // The exploration, model-backed and member-billed. Each grounds generation
    // in a lab refetched here (authoritative real data), never in context the
    // browser supplies.
    if (action === "ideas") {
      const { user, credentials } = await memberCredentials(req);
      const lab = await groundingLab(body.piId, user);
      return sendJson(res, 200, {
        ideas: await ResearchModel.generateIdeas({ lab, interest: body.interest }, credentials),
      });
    }

    if (action === "refine") {
      const { user, credentials } = await memberCredentials(req);
      const lab = await groundingLab(body.piId, user);
      return sendJson(res, 200, await ResearchModel.refineIdea(
        { lab, idea: body.idea, note: body.note, own: ownContext(body.own) }, credentials));
    }

    if (action === "path") {
      const { user, credentials } = await memberCredentials(req);
      const lab = await groundingLab(body.piId, user);
      return sendJson(res, 200, await ResearchModel.generatePath(
        { lab, idea: body.idea, interest: body.interest, own: ownContext(body.own) },
        credentials));
    }

    // "Add a lab by link": a lab the graph doesn't have yet. The participant
    // pastes the lab's public web page; the page's text is fetched HERE (never
    // trusted from the browser), the model extracts only what the page states,
    // and the extraction becomes real canonical rows through the same
    // service-role curator RPCs the admin uses -- a PI, their students, their
    // projects, and their papers (authored to the PI, so lab views carry them).
    // Model-billed to the member, like every generation step.
    if (action === "add_lab") {
      const { credentials } = await memberCredentials(req);
      const pageUrl = PageFetch.safeHttpUrl(body.url);
      const text = await PageFetch.fetchPageText(pageUrl);
      const found = await ResearchModel.extractLab(
        { url: pageUrl, text, hint: body.hint }, credentials);
      if (!found.pi.name) {
        const error = new Error("That page does not read as a lab -- try the"
          + " lab's main page, or its PI's page");
        error.statusCode = 422;
        throw error;
      }
      const pi = await rpc("engelbart_curator_create_person", {
        p_patch: {
          kind: "professor",
          name: found.pi.name,
          title: found.pi.title,
          bio: found.pi.bio,
          interests: found.pi.interests,
          url: pageUrl,
          lab_name: found.lab_name || `${found.pi.name} Lab`,
          lab_url: pageUrl,
          lab_description: found.lab_description,
        },
      });
      if (!pi || !pi.id) {
        const error = new Error("The lab could not be created");
        error.statusCode = 502;
        throw error;
      }
      // Students, projects, papers are each best-effort: one bad row must not
      // lose the lab that was already created.
      for (const s of found.students) {
        await rpc("engelbart_curator_create_person", {
          p_patch: { kind: "phd_student", name: s.name, title: s.title,
            advisor_id: pi.id },
        }).catch(() => {});
      }
      for (const p of found.projects) {
        await rpc("engelbart_curator_upsert_project", {
          p_id: null, p_person_id: pi.id,
          p_patch: { title: p.title, description: p.description, url: p.url },
        }).catch(() => {});
      }
      for (const p of found.papers) {
        const paper = await rpc("engelbart_curator_upsert_paper", {
          p_id: null,
          p_patch: { title: p.title, year: p.year, venue: p.venue, url: p.url },
        }).catch(() => null);
        if (paper && paper.id) {
          await rpc("engelbart_curator_set_paper_authors", {
            p_id: paper.id, p_person_ids: [pi.id],
          }).catch(() => {});
        }
      }
      return sendJson(res, 200, { piId: pi.id, labName: pi.lab_name });
    }

    // "Bring your own project": the participant attaches their own paper. The
    // row is CREATED here every time -- never an update by client-sent id -- so
    // a member can only ever touch a paper this action made for them. With no
    // linked authors it stays invisible to every lab view; it is reachable only
    // through the project that references it.
    if (action === "own_paper") {
      const user = await verifyUser(bearerToken(req));
      const title = String(body.title || "").slice(0, 300).trim() || "Attached paper";
      const url = String(body.url || "").slice(0, 500).trim();
      const value = await rpc("engelbart_curator_upsert_paper", {
        p_id: null,
        p_patch: { title, url },
      });
      if (!value || !value.id) {
        const error = new Error("Could not create the paper");
        error.statusCode = 502;
        throw error;
      }
      const out = { id: value.id, title: value.title, url: value.url || "" };
      if (body.wantsUpload) {
        // The PDF goes straight from the browser to Storage, exactly like the
        // curator's uploads; the token lets own_paper_saved trust the id.
        const up = await Storage.signedUploadUrl(Storage.paperObjectPath(value.id));
        out.upload = { ...up, anonKey: supabaseConfig().anonKey };
        out.token = ownPaperToken(value.id, user.id);
      }
      return sendJson(res, 200, out);
    }

    // The browser reports the PDF landed; record the stable path. The token
    // from own_paper is the guard: it only verifies for a paper that action
    // created for this same member.
    if (action === "own_paper_saved") {
      const user = await verifyUser(bearerToken(req));
      const id = Curated.optUuid(body.id);
      const token = String(body.token || "");
      const expected = id ? ownPaperToken(id, user.id) : "";
      const ok = expected && token.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
      if (!ok) {
        const error = new Error("That upload cannot be recorded");
        error.statusCode = 403;
        throw error;
      }
      await rpc("engelbart_curator_set_paper_pdf", {
        p_id: id, p_pdf_path: Storage.paperObjectPath(id),
      });
      return sendJson(res, 200, { saved: true });
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
      // The lab for grounding: canonical data, with the participant's curated
      // paper selection (when any) narrowing the pool the generator may cite --
      // the same preferred/allowed papers the earlier idea step saw.
      let lab = null;
      if (body.piId) {
        lab = await Research.lab(body.piId);
        await applyCuratedPapers(lab, user, body.piId);
      }
      const idea = body.idea && typeof body.idea === "object" ? body.idea : {};
      const interest = String(body.interest || "");
      const pi = lab && lab.pi ? lab.pi : null;

      // The participant's own attached paper joins the grounding pool FIRST,
      // marked `own`, so the generator's paper menu carries it and the forced
      // Understand goal can bind to its real canonical id.
      const own = ownContext(body.own);
      if (own && own.paper) {
        lab = lab || {};
        lab.papers = [
          { id: own.paper.id, title: own.paper.title || "Attached paper",
            url: own.paper.url, own: true },
          ...(Array.isArray(lab.papers) ? lab.papers : []),
        ];
      }

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
      let mode = "structured";
      try {
        // The structured generator is grounded in the refetched lab and billed
        // to the member's key; a lab of null still generates (empty Understand).
        const credentials = await Credits.credentialsFor(user);
        const project = await ResearchModel.generateProject(
          { interest, idea, lab: lab || {}, lanes: body.lanes, own }, credentials);
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
        // Loudly: a silent degrade looks exactly like a generator bug from the
        // workspace (four phase-named goals, every step flattened into todos).
        mode = "lanes";
        console.error("engelbart-setup: structured generate degraded to lanes:",
          (modelError && modelError.message) || modelError);
        payload = SetupChat.normalizePayload(ResearchModel.explorationToPayload({
          name: body.name,
          objective: body.objective,
          idea,
          lanes: body.lanes,
          lab: pi ? { lab_name: pi.lab_name, pi_name: pi.name, department: pi.department } : {},
          // The own attached paper survives the degrade through the legacy
          // single-paper field the importer already understands.
          paper: own && own.paper
            ? { paper_id: own.paper.id, title: own.paper.title, url: own.paper.url }
            : undefined,
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
      return sendJson(res, 200, { saved: true, mode });
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
module.exports.ownPaperToken = ownPaperToken;
