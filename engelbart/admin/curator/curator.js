(function curator() {
  "use strict";

  // ---- tiny DOM + API helpers ---------------------------------------------
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "value") node.value = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] === true) node.setAttribute(k, "");
        else if (attrs[k] != null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
      });
    }
    (Array.isArray(children) ? children : children != null ? [children] : [])
      .forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }

  async function api(path, options) {
    const response = await fetch(path, Object.assign({
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }, options || {}));
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(value.error || "Request failed");
      error.status = response.status;
      throw error;
    }
    return { status: response.status, value };
  }
  function act(action, extra) {
    return api("/api/engelbart-curator", { method: "POST", body: JSON.stringify(Object.assign({ action }, extra || {})) })
      .then((r) => r.value);
  }
  function setStatus(id, message, kind) {
    const node = $(id);
    node.textContent = message || "";
    node.dataset.kind = kind || "";
  }
  function flash(message, kind) { setStatus("editor-status", message, kind || "success"); }

  // ---- state --------------------------------------------------------------
  let dir = { participants: [], members: [] };
  let state = null;              // { participantKey, label, authUserId, bundle }
  const labCache = {};           // pi_id -> { pi, members[], projects[], papers[] }

  const uid = () => "a" + Math.random().toString(36).slice(2, 8);
  function memberName(id) {
    const m = dir.members.find((x) => x.user_id === id);
    return m ? m.email : id;
  }

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    try {
      const session = (await api("/api/engelbart-admin-session")).value;
      if (!session.authenticated) {
        $("curator-loading").classList.add("hidden");
        $("signin-needed").classList.remove("hidden");
        return;
      }
      dir = (await api("/api/engelbart-curator")).value || dir;  // { participants, members }
      $("curator-loading").classList.add("hidden");
      $("app").classList.remove("hidden");
      renderParticipantPickers();
    } catch (error) {
      $("curator-loading").querySelector(".status").textContent = error.message;
      $("curator-loading").querySelector(".status").dataset.kind = "error";
    }
  }

  function renderParticipantPickers() {
    const existing = $("participant-existing");
    existing.replaceChildren(el("option", { value: "" }, "— select —"));
    dir.participants.forEach((p) => {
      const tag = p.label ? p.participantKey + " — " + p.label : p.participantKey;
      existing.appendChild(el("option", { value: p.participantKey }, tag));
    });
    fillAuthSelect($("cur-auth"));
  }
  function fillAuthSelect(select) {
    select.replaceChildren(el("option", { value: "" }, "— not bound —"));
    dir.members.forEach((m) => select.appendChild(el("option", { value: m.user_id }, m.email)));
  }

  // ---- open / create ------------------------------------------------------
  async function openParticipant(key) {
    setStatus("participant-status", "Loading…");
    const { participant } = await act("load", { participantKey: key });
    if (!participant) throw new Error("No such participant");
    state = {
      participantKey: participant.participantKey,
      label: participant.label || "",
      authUserId: participant.authUserId || "",
      bundle: participant.bundle || { version: 1, areas: [] },
    };
    await prefetchLabs();
    enterEditor();
    setStatus("participant-status", "");
  }
  function createParticipant() {
    const key = $("new-key").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._+@-]{0,127}$/.test(key)) {
      setStatus("participant-status", "Key: a handle like 'ashley' or the person's email.", "error");
      return;
    }
    if (dir.participants.some((p) => p.participantKey === key)) {
      setStatus("participant-status", "That key already exists — open it instead.", "error");
      return;
    }
    state = { participantKey: key, label: $("new-label").value.trim(), authUserId: "", bundle: { version: 1, areas: [] } };
    enterEditor();
    setStatus("participant-status", "New participant — not saved until you press Save.", "");
  }

  async function prefetchLabs() {
    const ids = new Set();
    state.bundle.areas.forEach((a) => (a.labs || []).forEach((l) => ids.add(l.pi_id)));
    for (const id of ids) {
      if (labCache[id]) continue;
      try { labCache[id] = await act("lab_detail", { piId: id }); }
      catch (error) { labCache[id] = null; }
    }
  }

  function enterEditor() {
    $("cur-label").value = state.label;
    fillAuthSelect($("cur-auth"));
    $("cur-auth").value = state.authUserId || "";
    $("cur-key-note").textContent = "Key: " + state.participantKey
      + "  ·  curate before the login exists, then bind it above when the account is ready.";
    $("editor").classList.remove("hidden");
    $("preview-panel").classList.add("hidden");
    renderAreas();
  }

  // ---- save / reload / preview -------------------------------------------
  function syncSnapshots() {
    state.bundle.areas.forEach((area) => {
      (area.labs || []).forEach((lab) => {
        const detail = labCache[lab.pi_id];
        if (!detail || !detail.pi) return;
        lab.snapshot = {
          piName: detail.pi.name || "",
          title: detail.pi.title || "",
          labName: detail.pi.lab_name || "",
          department: detail.pi.department || "",
          bio: detail.pi.bio || "",
          interests: Array.isArray(detail.pi.interests) ? detail.pi.interests : [],
          nMembers: (lab.student_ids || []).length,
          nProjects: (lab.project_ids || []).length,
        };
      });
    });
  }
  async function save() {
    try {
      syncSnapshots();
      state.label = $("cur-label").value.trim();
      state.authUserId = $("cur-auth").value || "";
      await act("save", {
        participantKey: state.participantKey,
        label: state.label,
        authUserId: state.authUserId,
        bundle: state.bundle,
      });
      dir = (await api("/api/engelbart-curator")).value || dir;
      renderParticipantPickers();
      flash("Saved.", "success");
    } catch (error) { flash(error.message, "error"); }
  }
  async function reload() {
    try {
      await openParticipant(state.participantKey);
      flash("Reloaded from the database.", "success");
    } catch (error) { flash(error.message, "error"); }
  }
  async function preview() {
    try {
      await save();
      const value = await act("preview", { participantKey: state.participantKey });
      $("preview-json").textContent = JSON.stringify(value, null, 2);
      $("preview-panel").classList.remove("hidden");
      $("preview-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { flash(error.message, "error"); }
  }

  // ---- canonical writes ---------------------------------------------------
  async function patchPerson(id, patch) {
    const row = await act("update_person", { id, patch });
    // if a PI, refresh its own pi block; students live inside their PI's detail
    Object.keys(labCache).forEach((piId) => {
      const d = labCache[piId];
      if (!d) return;
      if (piId === id && d.pi) Object.assign(d.pi, row);
      (d.members || []).forEach((m) => { if (m.id === id) Object.assign(m, row); });
    });
    return row;
  }

  // ---- rendering ----------------------------------------------------------
  function renderAreas() {
    const host = $("areas");
    host.replaceChildren();
    const areas = state.bundle.areas;
    if (!areas.length) {
      host.appendChild(el("p", { class: "muted" }, "No research areas yet. Add one to begin."));
    }
    areas.forEach((area, ai) => host.appendChild(renderArea(area, ai)));
  }

  function moveInArray(arr, i, delta) {
    const j = i + delta;
    if (j < 0 || j >= arr.length) return false;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    return true;
  }

  function reorderButtons(arr, i, onChange) {
    const up = el("button", { class: "mini", type: "button", title: "Move up",
      onclick: () => { if (moveInArray(arr, i, -1)) onChange(); } }, "↑");
    const down = el("button", { class: "mini", type: "button", title: "Move down",
      onclick: () => { if (moveInArray(arr, i, 1)) onChange(); } }, "↓");
    if (i === 0) up.disabled = true;
    if (i === arr.length - 1) down.disabled = true;
    return el("span", { class: "reorder" }, [up, down]);
  }

  function renderArea(area, ai) {
    const areas = state.bundle.areas;
    const card = el("section", { class: "area-card" });

    const label = el("input", { class: "area-label", type: "text", value: area.label || "",
      placeholder: "Research area name", onchange: (e) => { area.label = e.target.value; } });
    const remove = el("button", { class: "mini danger", type: "button",
      onclick: () => { areas.splice(ai, 1); renderAreas(); } }, "Remove area");
    card.appendChild(el("div", { class: "area-head" },
      [reorderButtons(areas, ai, renderAreas), label, remove]));

    card.appendChild(el("div", { class: "field" },
      [el("label", {}, "Summary (why this area matters for the participant)"),
        el("textarea", { onchange: (e) => { area.summary = e.target.value; } }, area.summary || "")]));

    (area.labs || []).forEach((lab, li) => card.appendChild(renderLab(area, ai, lab, li)));

    card.appendChild(renderLabSearch(area));
    return card;
  }

  function renderLabSearch(area) {
    const panel = el("div", { class: "editor-panel" });
    const input = el("input", { type: "text", placeholder: "Search labs by interest (e.g. reinforcement learning)" });
    const results = el("div", { class: "search-results" });
    const run = async () => {
      results.replaceChildren(el("p", { class: "muted" }, "Searching…"));
      try {
        const { labs } = await act("search_labs", { interest: input.value });
        results.replaceChildren();
        if (!labs.length) { results.appendChild(el("p", { class: "muted" }, "No labs matched.")); return; }
        labs.forEach((row) => results.appendChild(renderHit(area, row)));
      } catch (error) { results.replaceChildren(el("p", { class: "status", "data-kind": "error" }, error.message)); }
    };
    const btn = el("button", { class: "button secondary", type: "button", onclick: run }, "Search labs");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
    panel.appendChild(el("div", { class: "curator-bar" }, [el("div", { class: "field grow" }, input), btn]));
    panel.appendChild(results);
    panel.appendChild(renderLabCreate(area));
    return panel;
  }

  // Create a lab that isn't in Berkeley's graph yet (a PI record), then attach it
  // to this area exactly like a searched hit. It joins the shared graph, so the
  // canonical PI editor, projects, and papers below all work on it immediately.
  function renderLabCreate(area) {
    const wrap = el("div", { class: "editor-panel" });
    const toggle = el("button", { class: "mini", type: "button" }, "+ Create a new lab");
    const form = el("div", { class: "hidden create-lab" });

    // one input per canonical field; the create RPC whitelists exactly these.
    const f = {};
    const mk = (key, ph, textarea) => {
      f[key] = textarea ? el("textarea", { placeholder: ph || "" }, "")
                        : el("input", { type: "text", placeholder: ph || "" });
      return f[key];
    };
    const field = (label, node, cls) =>
      el("div", { class: "field " + (cls || "") }, [el("label", {}, label), node]);
    const status = el("p", { class: "status" }, "");
    const create = el("button", { class: "button", type: "button" }, "Create & add");

    create.addEventListener("click", async () => {
      const name = f.name.value.trim();
      const lab_name = f.lab_name.value.trim();
      if (!name || !lab_name) {
        status.textContent = "A PI name and a lab name are both required.";
        status.dataset.kind = "error";
        return;
      }
      status.textContent = "Creating…"; status.dataset.kind = ""; create.disabled = true;
      try {
        await createLab(area, {
          name, lab_name,
          title: f.title.value.trim(),
          lab_url: f.lab_url.value.trim(),
          lab_description: f.lab_description.value.trim(),
          lab_image_url: f.lab_image_url.value.trim(),
          url: f.url.value.trim(),
          bio: f.bio.value.trim(),
          image_url: f.image_url.value.trim(),
          interests: f.interests.value.split(",").map((s) => s.trim()).filter(Boolean),
        });
        // createLab -> addLab -> renderAreas() rebuilds this subtree collapsed.
      } catch (error) {
        status.textContent = error.message; status.dataset.kind = "error";
        create.disabled = false;
      }
    });
    toggle.addEventListener("click", () => form.classList.toggle("hidden"));

    form.appendChild(el("p", { class: "muted" },
      "Not in Berkeley’s graph yet? Create the lab (a PI record) and add it to this area. "
      + "It joins the shared graph and becomes searchable; add its projects and papers below. "
      + "Only a PI name and lab name are required — the rest can be filled here or later."));
    form.appendChild(el("div", { class: "grid2" }, [
      field("PI name", mk("name", "e.g. Jane Doe")),
      field("Lab name", mk("lab_name", "e.g. Doe Lab")),
      field("PI title (optional)", mk("title", "e.g. Associate Professor")),
      field("Lab website", mk("lab_url", "https://…")),
      field("PI website", mk("url", "https://…")),
      field("Research areas (comma separated)", mk("interests", "robotics, control, soft robotics"), "full"),
      field("PI photo URL", mk("image_url", "https://…")),
      field("Lab image URL", mk("lab_image_url", "https://…")),
      field("PI bio / description", mk("bio", "", true), "full"),
      field("Lab description", mk("lab_description", "", true), "full")]));
    form.appendChild(el("div", { class: "curator-bar" }, [create, status]));
    wrap.append(toggle, form);
    return wrap;
  }

  function renderHit(area, row) {
    const already = (area.labs || []).some((l) => l.pi_id === row.pi_id);
    const meta = [row.title, row.department, (row.n_members || 0) + " members", (row.n_projects || 0) + " projects"]
      .filter(Boolean).join(" · ");
    const add = el("button", { class: "mini", type: "button", disabled: already || false,
      onclick: () => addLab(area, row) }, already ? "Added" : "Add");
    return el("div", { class: "search-hit" }, [
      el("div", { class: "hit-main" }, [
        el("div", {}, (row.pi_name || "Unknown") + (row.lab_name ? " — " + row.lab_name : "")),
        el("div", { class: "muted" }, meta)]),
      add]);
  }

  async function addLab(area, row) {
    try {
      let detail = labCache[row.pi_id];
      if (!detail) { detail = await act("lab_detail", { piId: row.pi_id }); labCache[row.pi_id] = detail; }
      area.labs = area.labs || [];
      area.labs.push({
        pi_id: row.pi_id,
        student_ids: (detail.members || []).map((m) => m.id),
        project_ids: (detail.projects || []).map((p) => p.id),
        paper_ids: (detail.papers || []).map((p) => p.id),
        snapshot: {
          piName: row.pi_name || "", title: row.title || "", labName: row.lab_name || "",
          department: row.department || "", bio: row.bio || "",
          interests: Array.isArray(row.interests) ? row.interests : [],
          nMembers: row.n_members || 0, nProjects: row.n_projects || 0,
        },
      });
      renderAreas();
    } catch (error) { flash(error.message, "error"); }
  }

  async function createLab(area, fields) {
    const row = await act("create_person", { patch: fields });
    labCache[row.id] = await act("lab_detail", { piId: row.id });
    await addLab(area, {
      pi_id: row.id, pi_name: row.name, title: row.title, lab_name: row.lab_name,
      department: "", bio: row.bio, interests: fields.interests || [],
      n_members: 0, n_projects: 0,
    });
    flash("Lab created and added.", "success");
  }

  // ---- a single lab -------------------------------------------------------
  function renderLab(area, ai, lab, li) {
    const detail = labCache[lab.pi_id];
    const card = el("div", { class: "lab-card" });
    const pi = detail && detail.pi ? detail.pi : { name: (lab.snapshot && lab.snapshot.piName) || "(unavailable)", lab_name: "" };

    const title = el("span", { class: "lab-title" }, (pi.name || "") + (pi.lab_name ? " — " + pi.lab_name : ""));
    const editToggle = el("button", { class: "mini", type: "button" }, "Edit lab");
    const remove = el("button", { class: "mini danger", type: "button",
      onclick: () => { area.labs.splice(li, 1); renderAreas(); } }, "Remove");
    card.appendChild(el("div", { class: "lab-head" },
      [reorderButtons(area.labs, li, renderAreas), title, editToggle, remove]));

    if (!detail || !detail.pi) {
      card.appendChild(el("p", { class: "muted" }, "Canonical lab data unavailable (snapshot will be used)."));
      return card;
    }

    // collapsible canonical PI / lab editor
    const editor = el("div", { class: "editor-panel hidden" });
    buildPiEditor(editor, pi);
    editToggle.addEventListener("click", () => editor.classList.toggle("hidden"));
    card.appendChild(editor);

    card.appendChild(el("div", { class: "section-title" }, "PhD students — tick to include, drag order with ↑↓"));
    card.appendChild(renderMembers(lab, detail));

    card.appendChild(el("div", { class: "section-title" }, "Projects (PI)"));
    card.appendChild(renderProjects(lab, detail));

    card.appendChild(el("div", { class: "section-title" }, "Papers (PI)"));
    card.appendChild(renderPapers(lab, detail));

    card.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Participant note (optional)"),
      el("textarea", { onchange: (e) => { lab.note = e.target.value; } }, lab.note || "")]));
    card.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Override area summary for this lab (optional)"),
      el("textarea", { onchange: (e) => {
        lab.overrides = e.target.value.trim() ? { summary: e.target.value } : undefined;
      } }, (lab.overrides && lab.overrides.summary) || "")]));

    return card;
  }

  function pfield(label, value, cls, onchange, textarea) {
    const input = textarea
      ? el("textarea", { onchange }, value || "")
      : el("input", { type: "text", value: value || "", onchange });
    return el("div", { class: "field " + (cls || "") }, [el("label", {}, label), input]);
  }

  function buildPiEditor(host, pi) {
    const commit = (field) => (e) => {
      const patch = {}; patch[field] = e.target.value;
      patchPerson(pi.id, patch).catch((error) => flash(error.message, "error"));
    };
    const grid = el("div", { class: "grid2" }, [
      pfield("PI name", pi.name, "", commit("name")),
      pfield("Title", pi.title, "", commit("title")),
      pfield("Lab name", pi.lab_name, "", commit("lab_name")),
      pfield("Lab website", pi.lab_url, "", commit("lab_url")),
      pfield("PI website", pi.url, "", commit("url")),
      pfield("PI photo URL", pi.image_url, "", commit("image_url")),
      pfield("Lab image URL", pi.lab_image_url, "", commit("lab_image_url")),
      pfield("Bio", pi.bio, "full", commit("bio"), true),
      pfield("Lab description", pi.lab_description, "full", commit("lab_description"), true),
    ]);
    host.appendChild(grid);
    const thumbs = el("div", { class: "chip-row" });
    if (pi.image_url) thumbs.appendChild(el("img", { class: "thumb", src: pi.image_url, alt: "PI photo" }));
    if (pi.lab_image_url) thumbs.appendChild(el("img", { class: "thumb", src: pi.lab_image_url, alt: "Lab image" }));
    if (thumbs.childNodes.length) host.appendChild(thumbs);
  }

  // members: selected (in student_ids order) first with reorder, then the rest
  function renderMembers(lab, detail) {
    const wrap = el("div", {});
    lab.student_ids = (lab.student_ids || []).filter((id) => (detail.members || []).some((m) => m.id === id));
    const byId = new Map((detail.members || []).map((m) => [m.id, m]));
    const selected = lab.student_ids.map((id) => byId.get(id)).filter(Boolean);
    const rest = (detail.members || []).filter((m) => lab.student_ids.indexOf(m.id) < 0);

    selected.forEach((m, i) => wrap.appendChild(memberRow(lab, m, true, i)));
    rest.forEach((m) => wrap.appendChild(memberRow(lab, m, false, -1)));
    if (!detail.members || !detail.members.length) wrap.appendChild(el("p", { class: "muted" }, "No students on record."));
    wrap.appendChild(el("button", { class: "mini", type: "button",
      onclick: () => addStudent(lab, detail) }, "+ Add PhD student"));
    return wrap;
  }

  // Create a PhD student under this PI: a phd_student person advised by the PI,
  // joined to the shared graph and selected for the participant. Rename/retitle
  // it inline afterwards (the row's Edit patches name/title like any person).
  async function addStudent(lab, detail) {
    try {
      const row = await act("create_person", {
        patch: { name: "New student", kind: "phd_student", advisor_id: detail.pi.id },
      });
      detail.members.push({
        id: row.id, name: row.name, title: row.title || "", image_url: row.image_url || "",
      });
      lab.student_ids.push(row.id);
      renderAreas();
    } catch (error) { flash(error.message, "error"); }
  }

  function memberRow(lab, m, on, i) {
    const check = el("input", { type: "checkbox", onchange: () => {
      if (check.checked) lab.student_ids.push(m.id);
      else lab.student_ids = lab.student_ids.filter((x) => x !== m.id);
      renderAreas();
    } });
    check.checked = on;
    const editBtn = el("button", { class: "mini", type: "button" }, "Edit");
    const editor = el("div", { class: "editor-panel hidden" });
    const commit = (field) => (e) => {
      const patch = {}; patch[field] = e.target.value;
      patchPerson(m.id, patch).then(() => { title.textContent = (m.name || "") + (m.title ? " · " + m.title : ""); })
        .catch((error) => flash(error.message, "error"));
    };
    editor.appendChild(el("div", { class: "grid2" }, [
      pfield("Name", m.name, "", commit("name")),
      pfield("Title", m.title, "", commit("title")),
      pfield("Photo URL", m.image_url, "full", commit("image_url")),
    ]));
    editBtn.addEventListener("click", () => editor.classList.toggle("hidden"));

    const thumb = m.image_url
      ? el("img", { class: "thumb", src: m.image_url, alt: "" })
      : el("span", { class: "thumb" });
    const title = el("div", { class: "t" }, (m.name || "") + (m.title ? " · " + m.title : ""));
    const head = el("div", { class: "work-row" + (on ? "" : " off") }, [
      check, thumb,
      el("div", { class: "work-main" }, [title]),
      on && i >= 0 ? reorderButtons(lab.student_ids, i, renderAreas) : el("span"),
      editBtn]);
    return el("div", {}, [head, editor]);
  }

  // projects: same select/order model over the PI's canonical projects
  function renderProjects(lab, detail) {
    const wrap = el("div", {});
    lab.project_ids = (lab.project_ids || []).filter((id) => (detail.projects || []).some((p) => p.id === id));
    const byId = new Map((detail.projects || []).map((p) => [p.id, p]));
    const selected = lab.project_ids.map((id) => byId.get(id)).filter(Boolean);
    const rest = (detail.projects || []).filter((p) => lab.project_ids.indexOf(p.id) < 0);
    selected.forEach((p, i) => wrap.appendChild(projectRow(lab, detail, p, true, i)));
    rest.forEach((p) => wrap.appendChild(projectRow(lab, detail, p, false, -1)));
    wrap.appendChild(el("button", { class: "mini", type: "button",
      onclick: () => addProject(lab, detail) }, "+ Project"));
    return wrap;
  }

  async function addProject(lab, detail) {
    try {
      const row = await act("upsert_project", { personId: detail.pi.id, patch: { title: "New project", status: "active" } });
      detail.projects.push(row);
      lab.project_ids.push(row.id);
      renderAreas();
    } catch (error) { flash(error.message, "error"); }
  }

  function projectRow(lab, detail, p, on, i) {
    const check = el("input", { type: "checkbox", onchange: () => {
      if (check.checked) lab.project_ids.push(p.id);
      else lab.project_ids = lab.project_ids.filter((x) => x !== p.id);
      renderAreas();
    } });
    check.checked = on;
    const editBtn = el("button", { class: "mini", type: "button" }, "Edit");
    const editor = el("div", { class: "editor-panel hidden" });
    const commit = (field) => (e) => {
      const patch = {}; patch[field] = e.target.value;
      act("upsert_project", { id: p.id, patch }).then((row) => {
        Object.assign(p, row); title.textContent = p.title || "(untitled)";
      }).catch((error) => flash(error.message, "error"));
    };
    editor.appendChild(el("div", { class: "grid2" }, [
      pfield("Title", p.title, "", commit("title")),
      pfield("Status", p.status, "", commit("status")),
      pfield("URL", p.url, "", commit("url")),
      pfield("Description", p.description, "full", commit("description"), true),
    ]));
    editBtn.addEventListener("click", () => editor.classList.toggle("hidden"));
    const title = el("div", { class: "t" }, p.title || "(untitled)");
    const head = el("div", { class: "work-row" + (on ? "" : " off") }, [
      check,
      el("div", { class: "work-main" }, [title, el("div", { class: "muted" }, p.status || "")]),
      on && i >= 0 ? reorderButtons(lab.project_ids, i, renderAreas) : el("span"),
      editBtn]);
    return el("div", {}, [head, editor]);
  }

  // papers: select/order over the PI's papers; edit metadata, authors, PDF
  function renderPapers(lab, detail) {
    const wrap = el("div", {});
    lab.paper_ids = (lab.paper_ids || []).filter((id) => (detail.papers || []).some((p) => p.id === id));
    const byId = new Map((detail.papers || []).map((p) => [p.id, p]));
    const selected = lab.paper_ids.map((id) => byId.get(id)).filter(Boolean);
    const rest = (detail.papers || []).filter((p) => lab.paper_ids.indexOf(p.id) < 0);
    selected.forEach((p, i) => wrap.appendChild(paperRow(lab, detail, p, true, i)));
    rest.forEach((p) => wrap.appendChild(paperRow(lab, detail, p, false, -1)));
    wrap.appendChild(el("button", { class: "mini", type: "button",
      onclick: () => addPaper(lab, detail) }, "+ Paper"));
    return wrap;
  }

  async function addPaper(lab, detail) {
    try {
      const row = await act("upsert_paper", { patch: { title: "New paper" } });
      await act("set_paper_authors", { id: row.id, personIds: [detail.pi.id] });
      row.author_ids = [detail.pi.id];
      detail.papers.push(row);
      lab.paper_ids.push(row.id);
      renderAreas();
    } catch (error) { flash(error.message, "error"); }
  }

  function paperRow(lab, detail, p, on, i) {
    const check = el("input", { type: "checkbox", onchange: () => {
      if (check.checked) lab.paper_ids.push(p.id);
      else lab.paper_ids = lab.paper_ids.filter((x) => x !== p.id);
      renderAreas();
    } });
    check.checked = on;
    const editBtn = el("button", { class: "mini", type: "button" }, "Edit");
    const editor = el("div", { class: "editor-panel hidden" });

    const commit = (field, transform) => (e) => {
      const patch = {}; patch[field] = transform ? transform(e.target.value) : e.target.value;
      act("upsert_paper", { id: p.id, patch }).then((row) => {
        Object.assign(p, row); title.textContent = p.title || "(untitled)";
      }).catch((error) => flash(error.message, "error"));
    };
    editor.appendChild(el("div", { class: "grid2" }, [
      pfield("Title", p.title, "full", commit("title")),
      pfield("Authors (comma separated)", (p.authors || []).join(", "), "full",
        commit("authors", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))),
      pfield("Year", p.year != null ? String(p.year) : "", "", commit("year", (v) => v.trim())),
      pfield("Venue", p.venue, "", commit("venue")),
      pfield("DOI / source URL", p.doi_url, "", commit("doi_url")),
      pfield("Landing URL", p.url, "", commit("url")),
    ]));

    // author attachment (PI + this lab's students), so a paper can attach at the
    // PI or student level without clobbering the others
    editor.appendChild(el("div", { class: "section-title" }, "Attached to"));
    editor.appendChild(paperAuthorChips(detail, p));

    // PDF controls
    editor.appendChild(el("div", { class: "section-title" }, "PDF"));
    editor.appendChild(paperPdfControls(p));

    editBtn.addEventListener("click", () => editor.classList.toggle("hidden"));
    const title = el("div", { class: "t" }, p.title || "(untitled)");
    const pdfBadge = el("span", { class: "pdf-state " + (p.has_pdf ? "has" : "none") },
      p.has_pdf ? "PDF ✓" : "no PDF");
    const head = el("div", { class: "work-row" + (on ? "" : " off") }, [
      check,
      el("div", { class: "work-main" }, [title,
        el("div", { class: "muted" }, [p.year ? p.year + " · " : "", p.venue || "", "  ", pdfBadge])]),
      on && i >= 0 ? reorderButtons(lab.paper_ids, i, renderAreas) : el("span"),
      editBtn]);
    return el("div", {}, [head, editor]);
  }

  function paperAuthorChips(detail, p) {
    const row = el("div", { class: "chip-row" });
    const people = [detail.pi].concat(detail.members || []);
    const current = new Set((p.author_ids || []).map(String));
    people.forEach((person) => {
      const on = current.has(String(person.id));
      const chip = el("span", { class: "chip" + (on ? " on" : "") },
        person.name || memberName(person.id));
      chip.addEventListener("click", async () => {
        if (current.has(String(person.id))) current.delete(String(person.id));
        else current.add(String(person.id));
        try {
          const ids = Array.from(current);
          await act("set_paper_authors", { id: p.id, personIds: ids });
          p.author_ids = ids;
          chip.classList.toggle("on");
        } catch (error) { flash(error.message, "error"); }
      });
      row.appendChild(chip);
    });
    return row;
  }

  function paperPdfControls(p) {
    const box = el("div", { class: "chip-row" });
    const file = el("input", { type: "file", accept: "application/pdf", class: "hidden" });
    const status = el("span", { class: "muted" }, "");
    const upload = el("button", { class: "mini", type: "button" },
      p.has_pdf ? "Replace PDF" : "Upload PDF");
    const open = el("button", { class: "mini", type: "button" }, "Open");
    const clear = el("button", { class: "mini danger", type: "button" }, "Clear");

    upload.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      status.textContent = "Uploading…";
      try {
        const { uploadUrl, anonKey } = await act("paper_upload_url", { id: p.id });
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/pdf", "x-upsert": "true",
            apikey: anonKey, Authorization: "Bearer " + anonKey },
          body: f,
        });
        if (!put.ok) throw new Error("Storage upload failed (" + put.status + ")");
        await act("paper_pdf_saved", { id: p.id });
        p.has_pdf = true;
        status.textContent = "PDF stored.";
        upload.textContent = "Replace PDF";
      } catch (error) { status.textContent = error.message; }
      file.value = "";
    });
    open.addEventListener("click", async () => {
      status.textContent = "Fetching link…";
      try {
        const value = await act("paper_pdf_url", { id: p.id });
        const url = value.available ? value.signedUrl : value.sourceUrl;
        if (!url) { status.textContent = "No PDF or source URL."; return; }
        status.textContent = "";
        window.open(url, "_blank", "noopener");
      } catch (error) { status.textContent = error.message; }
    });
    clear.addEventListener("click", async () => {
      status.textContent = "Clearing…";
      try {
        await act("paper_pdf_clear", { id: p.id });
        p.has_pdf = false;
        status.textContent = "PDF cleared.";
        upload.textContent = "Upload PDF";
      } catch (error) { status.textContent = error.message; }
    });

    box.append(upload, open, clear, file, status);
    return box;
  }

  // ---- wire the static controls -------------------------------------------
  $("participant-open").addEventListener("click", async () => {
    const key = $("participant-existing").value;
    if (!key) { setStatus("participant-status", "Pick a participant first.", "error"); return; }
    try { await openParticipant(key); } catch (error) { setStatus("participant-status", error.message, "error"); }
  });
  $("participant-new").addEventListener("click", createParticipant);
  $("add-area").addEventListener("click", () => {
    state.bundle.areas.push({ id: uid(), label: "", summary: "", labs: [] });
    renderAreas();
  });
  $("btn-save").addEventListener("click", save);
  $("btn-reload").addEventListener("click", reload);
  $("btn-preview").addEventListener("click", preview);
  $("preview-close").addEventListener("click", () => $("preview-panel").classList.add("hidden"));

  boot();
})();
