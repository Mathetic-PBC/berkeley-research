"use strict";

// The participant curation layer. A participant's landscape is a thin bundle of
// references to canonical ids + ordering + optional overrides/notes + an
// optional per-lab summary snapshot for a deterministic session. It never
// duplicates canonical facts and never holds a PDF or a signed URL.
//
// Two directions:
//   - the curator reads/writes bundles (adminState/load/save/remove) and asks
//     for a paper's fresh signed view URL (paperPdfUrl);
//   - onboarding asks whether a participant HAS a curated landscape
//     (loadForUser) and turns it into the shapes it already renders (toAreas,
//     toLabDetail), preserving the curator's ordering.
//
// Canonical facts are hydrated live from the graph (via api/_lib/research.js)
// or, where present, from the bundle's snapshot -- the source of truth for
// facts stays the canonical berkeley graph.

const { rpc, selectOne, selectRows, insertRows, patchRows, deleteRows } = require("./supabase");
const Research = require("./research");
const Storage = require("./storage");

const TABLE = "engelbart_curated_landscapes";
// A participant key is a short stable handle ("ashley") OR the person's email
// ("ashley@berkeley.edu") -- allowing the email lets a landscape curated before
// the account exists be matched at sign-in by email, without a manual bind.
const KEY_RE = /^[a-z0-9][a-z0-9._+@-]{0,127}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_AREAS = 40;
const MAX_LABS = 60;
const MAX_IDS = 300;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanKey(value) {
  const key = String(value == null ? "" : value).trim().toLowerCase();
  if (!KEY_RE.test(key)) throw badRequest("Participant key must be short and simple (letters, numbers, . _ -)");
  return key;
}

function optUuid(value) {
  const text = String(value == null ? "" : value).trim();
  return UUID_RE.test(text) ? text : "";
}

function uuidList(value) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_IDS) : []) {
    const id = optUuid(entry);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

function str(value, cap) {
  const text = String(value == null ? "" : value);
  return cap ? text.slice(0, cap) : text;
}

// A lab's canonical papers narrowed and ordered to a curated selection of ids
// (the curator's order). Ids no longer in the canonical set are dropped; an
// empty selection -- or one that resolves to nothing -- leaves the papers as
// they are. Returns canonical rows BY REFERENCE; the bundle never copies paper
// data, so this reads references only.
function selectPapers(papers, paperIds) {
  const list = Array.isArray(papers) ? papers : [];
  const ids = Array.isArray(paperIds) ? paperIds : [];
  if (!ids.length) return list;
  const byId = new Map(list.map((p) => [String(p.id), p]));
  const picked = ids.map((id) => byId.get(String(id))).filter(Boolean);
  return picked.length ? picked : list;
}

function labSnapshot(value) {
  if (!value || typeof value !== "object") return undefined;
  const snap = {
    piName: str(value.piName, 200),
    title: str(value.title, 200),
    labName: str(value.labName, 200),
    department: str(value.department, 200),
    bio: str(value.bio, 4000),
    interests: Array.isArray(value.interests)
      ? value.interests.slice(0, 40).map((i) => str(i, 120)) : [],
    nMembers: Number(value.nMembers) || 0,
    nProjects: Number(value.nProjects) || 0,
  };
  const any = snap.piName || snap.labName || snap.title || snap.bio || snap.interests.length;
  return any ? snap : undefined;
}

// Participant-specific per-student notes ("why this person is especially
// useful for you"), keyed by the student's canonical person id. Curation
// commentary, never a canonical fact, so it lives in the bundle.
function studentNoteMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const notes = {};
  for (const key of Object.keys(value).slice(0, MAX_IDS)) {
    const id = optUuid(key);
    if (!id) continue;
    const text = str(value[key], 2000);
    if (text.trim()) notes[id] = text;
  }
  return Object.keys(notes).length ? notes : undefined;
}

// Bound the bundle to a known, minimal shape. References + ordering + optional
// overrides/notes + optional snapshot; nothing else is persisted.
function normalizeBundle(value) {
  const input = value && typeof value === "object" ? value : {};
  const areas = [];
  for (const area of Array.isArray(input.areas) ? input.areas.slice(0, MAX_AREAS) : []) {
    if (!area || typeof area !== "object") continue;
    const labs = [];
    for (const lab of Array.isArray(area.labs) ? area.labs.slice(0, MAX_LABS) : []) {
      const piId = optUuid(lab && lab.pi_id);
      if (!piId) continue;
      const row = {
        pi_id: piId,
        student_ids: uuidList(lab.student_ids),
        project_ids: uuidList(lab.project_ids),
        paper_ids: uuidList(lab.paper_ids),
      };
      const note = str(lab.note, 2000);
      if (note.trim()) row.note = note;
      const studentNotes = studentNoteMap(lab.student_notes);
      if (studentNotes) row.student_notes = studentNotes;
      const overrideSummary = lab.overrides && typeof lab.overrides === "object"
        ? str(lab.overrides.summary, 2000) : "";
      if (overrideSummary.trim()) row.overrides = { summary: overrideSummary };
      const snap = labSnapshot(lab.snapshot);
      if (snap) row.snapshot = snap;
      labs.push(row);
    }
    areas.push({
      id: str(area.id, 64) || `a${areas.length + 1}`,
      label: str(area.label, 200),
      summary: str(area.summary, 2000),
      labs,
    });
  }
  return { version: 1, areas };
}

// --- curator side ---------------------------------------------------------

async function adminState() {
  const rows = await selectRows(
    TABLE,
    "select=participant_key,auth_user_id,label,updated_at&order=updated_at.desc",
  );
  const participants = rows.map((r) => ({
    participantKey: r.participant_key,
    authUserId: r.auth_user_id || null,
    label: r.label || "",
    updatedAt: r.updated_at,
  }));
  let members = [];
  try {
    const value = await rpc("engelbart_curator_members", {});
    members = Array.isArray(value) ? value : [];
  } catch { members = []; }
  return { participants, members };
}

async function load(key) {
  const k = cleanKey(key);
  const row = await selectOne(
    TABLE,
    `participant_key=eq.${encodeURIComponent(k)}&select=participant_key,auth_user_id,label,bundle,updated_at`,
  );
  if (!row) return { participant: null };
  return {
    participant: {
      participantKey: row.participant_key,
      authUserId: row.auth_user_id || null,
      label: row.label || "",
      bundle: normalizeBundle(row.bundle),
      updatedAt: row.updated_at,
    },
  };
}

async function save(body) {
  const k = cleanKey(body.participantKey);
  const bundle = normalizeBundle(body.bundle);
  const label = str(body.label, 120);
  const authUser = optUuid(body.authUserId) || null;
  const existing = await selectOne(TABLE, `participant_key=eq.${encodeURIComponent(k)}&select=id`);
  if (existing) {
    await patchRows(
      TABLE,
      `participant_key=eq.${encodeURIComponent(k)}`,
      { label, auth_user_id: authUser, bundle, updated_at: new Date().toISOString() },
      { prefer: "return=minimal" },
    );
  } else {
    await insertRows(
      TABLE,
      [{ participant_key: k, label, auth_user_id: authUser, bundle }],
      { prefer: "return=minimal" },
    );
  }
  return { saved: true, participantKey: k };
}

async function remove(key) {
  const k = cleanKey(key);
  await deleteRows(TABLE, `participant_key=eq.${encodeURIComponent(k)}`);
  return { removed: true, participantKey: k };
}

// A fresh short-lived signed URL for one canonical paper's stored PDF, or the
// source fallback when there is no stored PDF. The path never leaves the server.
async function paperPdfUrl(paperId) {
  const id = optUuid(paperId);
  if (!id) throw badRequest("Invalid paper id");
  const source = await rpc("engelbart_paper_source", { p_id: id });
  const paper = source && typeof source === "object" && !Array.isArray(source) ? source : null;
  if (!paper) {
    const error = new Error("Paper not found");
    error.statusCode = 404;
    throw error;
  }
  if (str(paper.pdf_path).trim()) {
    const view = await Storage.signedViewUrl(paper.pdf_path);
    if (view.url) {
      return { available: true, signedUrl: view.url, expiresIn: view.expiresIn, title: paper.title || "" };
    }
  }
  const sourceUrl = str(paper.doi_url).trim() || str(paper.url).trim();
  return { available: false, sourceUrl, title: paper.title || "" };
}

// --- onboarding side ------------------------------------------------------

// Does this signed-in user have a curated landscape? Match the bound auth id
// first, then the participant_key by email -- so a landscape can be curated
// before the account exists (keyed by email) and still be found.
async function loadForUser(user) {
  const id = optUuid(user && user.id);
  const email = String((user && user.email) || "").trim().toLowerCase();
  const clauses = [];
  if (id) clauses.push(`auth_user_id.eq.${id}`);
  if (email && KEY_RE.test(email)) clauses.push(`participant_key.eq.${encodeURIComponent(email)}`);
  if (!clauses.length) return null;
  const rows = await selectRows(
    TABLE,
    `or=(${clauses.join(",")})&select=participant_key,auth_user_id,bundle,updated_at&order=updated_at.desc&limit=1`,
  );
  const row = rows[0];
  if (!row) return null;
  const bundle = normalizeBundle(row.bundle);
  if (!bundle.areas.length) return null;
  return { participantKey: row.participant_key, bundle };
}

// The curator's selection for one lab in a signed-in user's bundle: the chosen
// (and ordered) student / project / paper ids, or null when the user has no
// curated landscape or that lab isn't in it. Generation uses paper_ids as the
// preferred/allowed paper pool for the lab; nothing here is a copy of canonical
// data -- only references + order.
async function labSelectionForUser(user, piId) {
  const id = optUuid(piId);
  if (!id) return null;
  const curated = await loadForUser(user);
  if (!curated) return null;
  const ref = findLabRef(curated.bundle, id);
  if (!ref) return null;
  return {
    paper_ids: Array.isArray(ref.paper_ids) ? ref.paper_ids : [],
    project_ids: Array.isArray(ref.project_ids) ? ref.project_ids : [],
    student_ids: Array.isArray(ref.student_ids) ? ref.student_ids : [],
  };
}

// The bundle as the onboarding "areas" shape, preserving the curator's order.
// Built from each lab's snapshot so it is one row read and deterministic; a lab
// with no snapshot still appears with its id so detail can hydrate it live.
function toAreas(bundle) {
  const norm = normalizeBundle(bundle);
  return norm.areas
    .map((area) => ({
      label: area.label,
      summary: area.summary,
      labs: area.labs.map((lab) => {
        const snap = lab.snapshot || {};
        return {
          piId: lab.pi_id,
          piName: snap.piName || "",
          title: snap.title || "",
          labName: snap.labName || "",
          department: snap.department || "",
          bio: snap.bio || "",
          interests: Array.isArray(snap.interests) ? snap.interests : [],
          nMembers: Number(snap.nMembers) || (lab.student_ids ? lab.student_ids.length : 0),
          nProjects: Number(snap.nProjects) || (lab.project_ids ? lab.project_ids.length : 0),
        };
      }),
    }))
    .filter((area) => area.labs.length);
}

function findLabRef(bundle, piId) {
  const norm = normalizeBundle(bundle);
  for (const area of norm.areas) {
    for (const lab of area.labs) {
      if (lab.pi_id === piId) return lab;
    }
  }
  return null;
}

// One curated lab's detail in the onboarding shape: canonical facts hydrated
// live, then filtered and ORDERED to the curator's selection. When the curator
// selected specific students / projects / papers, only those show, in that
// order; when they selected none, the lab's full canonical set shows. An
// override summary and a note ride along for the UI to use if it wishes.
async function toLabDetail(bundle, piId) {
  const id = optUuid(piId);
  if (!id) return null;
  const ref = findLabRef(bundle, id);
  if (!ref) return null;
  const detail = await Research.lab(id);
  if (!detail) {
    // Canonical is gone; fall back to the snapshot so a session still shows the
    // lab rather than an error.
    const snap = ref.snapshot || {};
    return {
      pi: {
        id, name: snap.piName || "", title: snap.title || "", bio: snap.bio || "",
        interests: snap.interests || [], lab_name: snap.labName || "",
        department: snap.department || "",
      },
      members: [], projects: [], papers: [], curated: true,
    };
  }
  const order = (items, ids) => {
    const list = Array.isArray(items) ? items : [];
    if (!ids || !ids.length) return list;
    const byId = new Map(list.map((it) => [String(it.id), it]));
    return ids.map((x) => byId.get(String(x))).filter(Boolean);
  };
  const studentNotes = ref.student_notes || {};
  return {
    pi: detail.pi,
    members: order(detail.members, ref.student_ids).map((m) =>
      studentNotes[m.id] ? Object.assign({}, m, { why: studentNotes[m.id] }) : m),
    projects: order(detail.projects, ref.project_ids),
    papers: order(detail.papers, ref.paper_ids),
    curated: true,
    note: ref.note || "",
    overrideSummary: ref.overrides ? ref.overrides.summary || "" : "",
  };
}

// The exact payload onboarding will consume for this participant: the areas and
// the detail for every lab in them. This is what the curator's "Preview" shows.
async function preview(key) {
  const loaded = await load(key);
  if (!loaded.participant) return { participant: null };
  const bundle = loaded.participant.bundle;
  const areas = toAreas(bundle);
  const labs = {};
  for (const area of bundle.areas) {
    for (const lab of area.labs) {
      if (labs[lab.pi_id]) continue;
      try { labs[lab.pi_id] = await toLabDetail(bundle, lab.pi_id); }
      catch { labs[lab.pi_id] = null; }
    }
  }
  return { participantKey: loaded.participant.participantKey, areas, labs };
}

module.exports = {
  normalizeBundle,
  adminState,
  load,
  save,
  remove,
  paperPdfUrl,
  loadForUser,
  labSelectionForUser,
  selectPapers,
  toAreas,
  toLabDetail,
  preview,
  optUuid,
  uuidList,
};
