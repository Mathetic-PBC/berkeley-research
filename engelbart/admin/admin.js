(function runEngelbartAdmin() {
  "use strict";

  var state = null;
  var generatedCode = "";

  function byId(id) { return document.getElementById(id); }
  function setStatus(id, message, kind) {
    var node = byId(id);
    node.textContent = message || "";
    node.dataset.kind = kind || "";
  }
  function setBusy(form, busy) {
    Array.prototype.forEach.call(form.querySelectorAll("button, input"), function (control) {
      control.disabled = busy;
    });
  }
  async function api(path, options) {
    var response = await fetch(path, Object.assign({
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }, options || {}));
    var value = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(value.error || "Request failed");
      error.status = response.status;
      throw error;
    }
    return { status: response.status, value: value };
  }
  function body(value) { return JSON.stringify(value); }
  function selectedModels(container) {
    return Array.prototype.filter.call(container.querySelectorAll("input[type=checkbox]"), function (input) {
      return input.checked;
    }).map(function (input) { return input.value; });
  }
  function modelChecks(container, selected, prefix) {
    container.replaceChildren();
    state.availableModels.forEach(function (model) {
      var label = document.createElement("label");
      label.className = "check-option";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.name = prefix + "Models";
      input.value = model;
      input.checked = selected.indexOf(model) >= 0;
      label.append(input, document.createTextNode(model));
      container.appendChild(label);
    });
  }
  function money(value) { return "$" + Number(value || 0).toFixed(2); }

  function renderPolicy() {
    var settings = state.settings;
    byId("pool-budget").value = settings.poolBudgetUsd;
    byId("default-budget").value = settings.defaultBudgetUsd;
    byId("default-rpm").value = settings.defaultRpmLimit || "";
    byId("default-tpm").value = settings.defaultTpmLimit || "";
    modelChecks(byId("default-models"), settings.defaultModels, "default");
    byId("pool-summary").textContent = money(settings.allocatedBudgetUsd)
      + " allocated of " + money(settings.poolBudgetUsd)
      + "; " + money(settings.poolBudgetUsd - settings.allocatedBudgetUsd) + " unallocated.";
  }

  function accountForm(account) {
    var article = document.createElement("article");
    article.className = "member-card";
    var heading = document.createElement("div");
    heading.className = "member-heading";
    var identity = document.createElement("div");
    var email = document.createElement("strong");
    email.textContent = account.email || account.userId;
    var metadata = document.createElement("span");
    metadata.className = "meta";
    metadata.textContent = account.status + " · spent " + money(account.spendUsd)
      + " of " + money(account.budgetUsd);
    identity.append(email, metadata);
    var badge = document.createElement("span");
    badge.className = "badge" + (account.blocked ? " danger" : "");
    badge.textContent = account.blocked ? "Paused" : account.status;
    heading.append(identity, badge);
    article.appendChild(heading);

    if (account.error) {
      var error = document.createElement("p");
      error.className = "status";
      error.dataset.kind = "error";
      error.textContent = account.error;
      article.appendChild(error);
    }
    if (account.status !== "ready") return article;

    var form = document.createElement("form");
    form.className = "stack";
    var fields = document.createElement("div");
    fields.className = "field-grid compact";
    [["Budget (USD)", "budget", account.budgetUsd], ["RPM", "rpm", account.rpmLimit || ""], ["TPM", "tpm", account.tpmLimit || ""]]
      .forEach(function (spec) {
        var field = document.createElement("div");
        field.className = "field";
        var label = document.createElement("label");
        label.textContent = spec[0];
        var input = document.createElement("input");
        input.name = spec[1];
        input.type = "number";
        input.min = "0.01";
        input.step = spec[1] === "budget" ? "0.01" : "1";
        input.value = spec[2];
        field.append(label, input);
        fields.appendChild(field);
      });
    var checks = document.createElement("div");
    checks.className = "check-grid";
    modelChecks(checks, account.models, "member");
    var actions = document.createElement("div");
    actions.className = "button-row";
    var save = document.createElement("button");
    save.className = "button secondary";
    save.type = "submit";
    save.textContent = "Update limits";
    var pause = document.createElement("button");
    pause.className = "button secondary";
    pause.type = "button";
    pause.textContent = account.blocked ? "Resume key" : "Pause key";
    var sync = document.createElement("button");
    sync.className = "button secondary";
    sync.type = "button";
    sync.textContent = "Refresh spend";
    actions.append(save, pause, sync);
    form.append(fields, checks, actions);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      setBusy(form, true);
      try {
        var data = new FormData(form);
        await mutate({
          action: "updateAccount", userId: account.userId,
          budgetUsd: data.get("budget"), rpmLimit: data.get("rpm"), tpmLimit: data.get("tpm"),
          models: selectedModels(checks),
        });
        setStatus("members-status", "Member limits updated.", "success");
      } catch (error) { setStatus("members-status", error.message, "error"); }
      setBusy(form, false);
    });
    pause.addEventListener("click", async function () {
      setBusy(form, true);
      try {
        await mutate({ action: "setBlocked", userId: account.userId, blocked: !account.blocked });
        setStatus("members-status", account.blocked ? "Key resumed." : "Key paused.", "success");
      } catch (error) { setStatus("members-status", error.message, "error"); }
      setBusy(form, false);
    });
    sync.addEventListener("click", async function () {
      setBusy(form, true);
      try {
        await mutate({ action: "syncAccount", userId: account.userId });
        setStatus("members-status", "Spend refreshed.", "success");
      } catch (error) { setStatus("members-status", error.message, "error"); }
      setBusy(form, false);
    });
    article.appendChild(form);
    return article;
  }

  function renderMembers() {
    var list = byId("member-list");
    list.replaceChildren();
    if (!state.accounts.length) {
      var empty = document.createElement("p");
      empty.className = "fine-print";
      empty.textContent = "No member has provisioned a key yet.";
      list.appendChild(empty);
      return;
    }
    state.accounts.forEach(function (account) { list.appendChild(accountForm(account)); });
  }

  function render() { renderPolicy(); renderMembers(); }
  async function refresh() {
    state = (await api("/api/engelbart-admin")).value;
    render();
  }
  async function mutate(value) {
    state = (await api("/api/engelbart-admin", { method: "POST", body: body(value) })).value;
    render();
  }
  async function showDashboard(session) {
    var enabled = Boolean(session.mfaEnabled);
    byId("admin-loading").classList.add("hidden");
    byId("admin-login-panel").classList.add("hidden");
    byId("admin-dashboard").classList.remove("hidden");
    byId("admin-logout").classList.remove("hidden");
    byId("mfa-begin").classList.toggle("hidden", enabled);
    byId("mfa-disable-form").classList.toggle("hidden", !enabled);
    byId("mfa-description").textContent = enabled
      ? "Two-factor authentication is required for every new admin session."
      : "Enable TOTP after resetting the bootstrap password.";
    await refresh();
  }

  byId("admin-login-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    setBusy(form, true);
    setStatus("admin-login-status", "Checking…");
    try {
      var data = new FormData(form);
      var result = await api("/api/engelbart-admin-session", {
        method: "POST",
        body: body({ password: data.get("password"), totpCode: data.get("totp") }),
      });
      if (result.status === 202 || result.value.mfaRequired) {
        byId("admin-totp-field").classList.remove("hidden");
        byId("admin-totp").required = true;
        byId("admin-totp").focus();
        setStatus("admin-login-status", "Enter the code from your authenticator app.");
      } else {
        await showDashboard({ mfaEnabled: Boolean(result.value.mfaEnabled) });
      }
    } catch (error) { setStatus("admin-login-status", error.message, "error"); }
    setBusy(form, false);
  });

  byId("admin-logout").addEventListener("click", async function () {
    await api("/api/engelbart-admin-session", { method: "DELETE" });
    window.location.reload();
  });

  byId("defaults-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    setBusy(form, true);
    try {
      var data = new FormData(form);
      await mutate({
        action: "updateDefaults",
        poolBudgetUsd: data.get("poolBudget"), defaultBudgetUsd: data.get("defaultBudget"),
        defaultRpmLimit: data.get("defaultRpm"), defaultTpmLimit: data.get("defaultTpm"),
        defaultModels: selectedModels(byId("default-models")),
      });
      setStatus("defaults-status", "Global policy saved for future users.", "success");
    } catch (error) { setStatus("defaults-status", error.message, "error"); }
    setBusy(form, false);
  });

  byId("generate-invite").addEventListener("click", async function () {
    var button = byId("generate-invite");
    button.disabled = true;
    setStatus("invite-status", "Generating…");
    try {
      var result = await api("/api/engelbart-admin", {
        method: "POST", body: body({ action: "generateInvite" }),
      });
      generatedCode = result.value.invite.code;
      byId("generated-code").textContent = generatedCode;
      byId("invite-expiry").textContent = "Expires "
        + new Date(result.value.invite.expires_at).toLocaleString();
      byId("invite-result").classList.remove("hidden");
      setStatus("invite-status", "Invite created.", "success");
    } catch (error) { setStatus("invite-status", error.message, "error"); }
    button.disabled = false;
  });
  byId("copy-code").addEventListener("click", async function () {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      byId("copy-code").textContent = "Copied";
      window.setTimeout(function () { byId("copy-code").textContent = "Copy code"; }, 1600);
    } catch (_error) { setStatus("invite-status", "Copy failed; select the code manually.", "error"); }
  });

  byId("password-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var data = new FormData(form);
    if (data.get("newPassword") !== data.get("confirmPassword")) {
      setStatus("password-status", "Passwords do not match.", "error");
      return;
    }
    setBusy(form, true);
    try {
      await api("/api/engelbart-admin-password", {
        method: "POST", body: body({ newPassword: data.get("newPassword") }),
      });
      form.reset();
      setStatus("password-status", "Admin password reset; other sessions were revoked.", "success");
    } catch (error) { setStatus("password-status", error.message, "error"); }
    setBusy(form, false);
  });

  byId("mfa-begin").addEventListener("click", async function () {
    try {
      var result = await api("/api/engelbart-admin-mfa", {
        method: "POST", body: body({ action: "begin" }),
      });
      byId("mfa-secret").textContent = result.value.secret;
      byId("mfa-uri").href = result.value.uri;
      byId("mfa-enrollment").classList.remove("hidden");
      setStatus("mfa-status", "Enrollment expires in ten minutes.");
    } catch (error) { setStatus("mfa-status", error.message, "error"); }
  });
  byId("mfa-verify-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    setBusy(form, true);
    try {
      await api("/api/engelbart-admin-mfa", {
        method: "POST", body: body({ action: "verify", code: new FormData(form).get("code") }),
      });
      byId("mfa-enrollment").classList.add("hidden");
      byId("mfa-begin").classList.add("hidden");
      byId("mfa-disable-form").classList.remove("hidden");
      byId("mfa-description").textContent = "Two-factor authentication is required for every new admin session.";
      setStatus("mfa-status", "Two-factor authentication enabled.", "success");
    } catch (error) { setStatus("mfa-status", error.message, "error"); }
    setBusy(form, false);
  });
  byId("mfa-disable-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    setBusy(form, true);
    try {
      var data = new FormData(form);
      await api("/api/engelbart-admin-mfa", {
        method: "POST",
        body: body({ action: "disable", password: data.get("password"), code: data.get("code") }),
      });
      form.reset();
      byId("mfa-disable-form").classList.add("hidden");
      byId("mfa-begin").classList.remove("hidden");
      byId("mfa-description").textContent = "Enable TOTP after resetting the bootstrap password.";
      setStatus("mfa-status", "Two-factor authentication disabled.", "success");
    } catch (error) { setStatus("mfa-status", error.message, "error"); }
    setBusy(form, false);
  });

  (async function boot() {
    try {
      var session = (await api("/api/engelbart-admin-session")).value;
      if (session.authenticated) await showDashboard(session);
      else {
        byId("admin-loading").classList.add("hidden");
        byId("admin-login-panel").classList.remove("hidden");
      }
    } catch (error) {
      byId("admin-loading").querySelector(".status").textContent = error.message;
      byId("admin-loading").querySelector(".status").dataset.kind = "error";
    }
  })();
})();
