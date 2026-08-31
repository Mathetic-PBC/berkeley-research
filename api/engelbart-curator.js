"use strict";

// Internal, admin-only curator for participant-specific research landscapes.
// Every action is gated by the existing admin session (password + optional
// TOTP) via Admin.requireAdmin -- no new auth. It reuses the read RPCs in
// api/_lib/research.js to browse the canonical Berkeley graph, the canonical
// write RPCs to correct facts in that shared graph, Storage for paper PDFs, and
// api/_lib/curated.js for the thin per-participant bundle.

const Admin = require("./_lib/admin-auth");
const Curated = require("./_lib/curated");
const Research = require("./_lib/research");
const Storage = require("./_lib/storage");
const { supabaseConfig } = require("./_lib/config");
const { allowMethods, publicError, readJson, sendJson } = require("./_lib/http");
const { rpc } = require("./_lib/supabase");

function requireUuid(value, label) {
  return Research.requireUuid(value, label);
}
function patch(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

async function handler(req, res) {
  if (!allowMethods(req, res, ["GET", "POST"])) return;
  try {
    await Admin.requireAdmin(req);

    if (req.method === "GET") {
      return sendJson(res, 200, await Curated.adminState());
    }

    const body = await readJson(req);
    const action = String(body.action || "");

    // --- participant bundles ---------------------------------------------
    if (action === "load") return sendJson(res, 200, await Curated.load(body.participantKey));
    if (action === "save") return sendJson(res, 200, await Curated.save(body));
    if (action === "delete") return sendJson(res, 200, await Curated.remove(body.participantKey));
    if (action === "preview") return sendJson(res, 200, await Curated.preview(body.participantKey));

    // --- browse the canonical graph (reuse the onboarding read RPCs) ------
    if (action === "search_labs") {
      return sendJson(res, 200, { labs: await Research.labMatches(body.interest) });
    }
    if (action === "lab_detail") {
      const detail = await Research.lab(body.piId);
      if (!detail) throw notFound("Lab not found");
      return sendJson(res, 200, detail);
    }
    if (action === "person_works") {
      const value = await rpc("engelbart_research_person_works", {
        p_person_id: requireUuid(body.personId, "person id"),
      });
      return sendJson(res, 200, value || { projects: [], papers: [] });
    }

    // --- canonical fact writes (update the shared graph) -----------------
    if (action === "update_person") {
      const value = await rpc("engelbart_curator_update_person", {
        p_id: requireUuid(body.id, "person id"),
        p_patch: patch(body.patch),
      });
      if (!value) throw notFound("Person not found");
      return sendJson(res, 200, value);
    }
    if (action === "upsert_project") {
      const value = await rpc("engelbart_curator_upsert_project", {
        p_id: Curated.optUuid(body.id) || null,
        p_person_id: Curated.optUuid(body.personId) || null,
        p_patch: patch(body.patch),
      });
      if (!value) throw notFound("Project not found");
      return sendJson(res, 200, value);
    }
    if (action === "upsert_paper") {
      const value = await rpc("engelbart_curator_upsert_paper", {
        p_id: Curated.optUuid(body.id) || null,
        p_patch: patch(body.patch),
      });
      if (!value) throw notFound("Paper not found");
      return sendJson(res, 200, value);
    }
    if (action === "set_paper_authors") {
      const value = await rpc("engelbart_curator_set_paper_authors", {
        p_id: requireUuid(body.id, "paper id"),
        p_person_ids: Curated.uuidList(body.personIds),
      });
      return sendJson(res, 200, value);
    }

    // --- paper PDF: upload straight to Storage, record path, view, clear --
    if (action === "paper_upload_url") {
      // A signed upload URL the browser PUTs the PDF to directly. The service
      // key stays here; the browser gets only the one-shot URL (plus the public
      // anon key, in case the Storage gateway asks for an apikey header).
      const id = requireUuid(body.id, "paper id");
      const up = await Storage.signedUploadUrl(Storage.paperObjectPath(id));
      return sendJson(res, 200, { ...up, anonKey: supabaseConfig().anonKey });
    }
    if (action === "paper_pdf_saved") {
      // The browser reports the upload landed; record the stable path.
      const id = requireUuid(body.id, "paper id");
      const value = await rpc("engelbart_curator_set_paper_pdf", {
        p_id: id, p_pdf_path: Storage.paperObjectPath(id),
      });
      if (!value) throw notFound("Paper not found");
      return sendJson(res, 200, value);
    }
    if (action === "paper_pdf_url") {
      // Curator preview: a fresh signed URL, exactly like the Paper tab gets.
      return sendJson(res, 200, await Curated.paperPdfUrl(body.id));
    }
    if (action === "paper_pdf_clear") {
      const id = requireUuid(body.id, "paper id");
      await Storage.removeObject(Storage.paperObjectPath(id)).catch(() => {});
      const value = await rpc("engelbart_curator_set_paper_pdf", { p_id: id, p_pdf_path: "" });
      if (!value) throw notFound("Paper not found");
      return sendJson(res, 200, value);
    }

    return sendJson(res, 400, { error: "Unknown curator action" });
  } catch (error) {
    const failure = publicError(error);
    return sendJson(res, failure.status, { error: failure.message });
  }
}

module.exports = handler;
