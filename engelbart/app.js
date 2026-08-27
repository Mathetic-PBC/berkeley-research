(function runEngelbartOnboarding() {
  "use strict";

  var shared = window.EngelbartShared;
  var client = null;
  var config = null;
  var approvedEmail = "";
  var provisionedUser = "";
  var currentSession = null;
  // The installer sends the member here with ?code=; the browser half of the
  // pairing is nothing more than proving who is sitting in front of it.
  var pendingCode = readPendingCode();
  var pairingResolved = false;

  var el = {
    loading: document.getElementById("loading-panel"),
    auth: document.getElementById("auth-panel"),
    download: document.getElementById("download-panel"),
    loginTab: document.getElementById("login-tab"),
    signupTab: document.getElementById("signup-tab"),
    loginView: document.getElementById("login-view"),
    signupView: document.getElementById("signup-view"),
    loginForm: document.getElementById("login-form"),
    loginStatus: document.getElementById("login-status"),
    inviteForm: document.getElementById("invite-form"),
    inviteCode: document.getElementById("invite-code"),
    signupEmail: document.getElementById("signup-email"),
    inviteStatus: document.getElementById("invite-status"),
    signupOptions: document.getElementById("signup-options"),
    approvedEmail: document.getElementById("approved-email"),
    passwordSignupForm: document.getElementById("password-signup-form"),
    changeInvite: document.getElementById("change-invite"),
    signupStatus: document.getElementById("signup-status"),
    sessionEmail: document.getElementById("session-email"),
    creditStatus: document.getElementById("credit-status"),
    signOut: document.getElementById("sign-out"),
    pairingNote: document.getElementById("pairing-note"),
    pairing: document.getElementById("pairing-panel"),
    pairingEmail: document.getElementById("pairing-email"),
    pairingCode: document.getElementById("pairing-code"),
    pairingLabel: document.getElementById("pairing-label"),
    pairingActions: document.getElementById("pairing-actions"),
    pairingApprove: document.getElementById("pairing-approve"),
    pairingDeny: document.getElementById("pairing-deny"),
    pairingStatus: document.getElementById("pairing-status"),
  };

  function readPendingCode() {
    var raw = new URLSearchParams(window.location.search).get("code");
    var normalized = shared.normalizeUserCode(raw);
    return shared.isPlausibleUserCode(normalized) ? normalized : "";
  }

  // A code is single-use. Dropping it from the URL keeps a reload or a shared
  // link from replaying an approval the member has already answered.
  function forgetPendingCode() {
    pendingCode = "";
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  function setStatus(node, message, kind) {
    node.textContent = message || "";
    node.dataset.kind = kind || "";
  }

  function setBusy(form, busy) {
    Array.prototype.forEach.call(form.querySelectorAll("button, input"), function (control) {
      control.disabled = busy;
    });
  }

  function selectMode(mode) {
    var login = mode === "login";
    el.loginTab.setAttribute("aria-selected", String(login));
    el.signupTab.setAttribute("aria-selected", String(!login));
    el.loginView.classList.toggle("hidden", !login);
    el.signupView.classList.toggle("hidden", login);
  }

  function showSession(session) {
    var signedIn = Boolean(session && session.user);
    var pairing = signedIn && Boolean(pendingCode);
    currentSession = signedIn ? session : null;
    el.loading.classList.add("hidden");
    el.auth.classList.toggle("hidden", signedIn);
    el.pairingNote.classList.toggle("hidden", signedIn || !pendingCode);
    el.pairing.classList.toggle("hidden", !pairing && !pairingResolved);
    // While a code is waiting, the answer to it is the only thing on screen.
    el.download.classList.toggle("hidden", !signedIn || pairing);
    if (signedIn) {
      el.sessionEmail.textContent = session.user.email || "Signed in";
      el.pairingEmail.textContent = session.user.email || "Signed in";
      if (pairing) el.pairingCode.textContent = pendingCode;
      provisionCredits(session);
    }
  }

  async function resolvePairing(approve) {
    if (!currentSession || !pendingCode) return;
    var code = pendingCode;
    setBusy(el.pairing, true);
    setStatus(el.pairingStatus, approve ? "Connecting your terminal…" : "Rejecting that code…");
    try {
      var response = await fetch("/api/engelbart-device", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer " + currentSession.access_token,
        },
        body: JSON.stringify({ action: approve ? "approve" : "deny", userCode: code }),
      });
      var value = await response.json();
      if (!response.ok) throw new Error(value.error || "That pairing code could not be used.");
      pairingResolved = true;
      forgetPendingCode();
      el.pairingActions.classList.add("hidden");
      el.download.classList.remove("hidden");
      setStatus(
        el.pairingStatus,
        approve
          ? "This terminal is connected. Return to it — the installer is finishing."
          : "That code was rejected. Nothing was connected.",
        approve ? "success" : ""
      );
    } catch (error) {
      setBusy(el.pairing, false);
      forgetPendingCode();
      setStatus(el.pairingStatus, error.message || "That pairing code could not be used.", "error");
    }
  }

  async function provisionCredits(session) {
    if (!config || !config.creditsEnabled) {
      setStatus(el.creditStatus, "Claude credits are not connected on this deployment yet.");
      return;
    }
    if (!session || !session.user || provisionedUser === session.user.id) return;
    provisionedUser = session.user.id;
    setStatus(el.creditStatus, "Allocating your Claude credit key…");
    try {
      var response = await fetch("/api/engelbart-credentials", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + session.access_token,
        },
      });
      var value = await response.json();
      if (!response.ok) throw new Error(value.error || "Credit allocation failed");
      setStatus(
        el.creditStatus,
        "$" + Number(value.budgetUsd).toFixed(2) + " of Claude Code credit is ready for bart auth.",
        "success"
      );
    } catch (error) {
      provisionedUser = "";
      setStatus(el.creditStatus, error.message || "Claude credit allocation is unavailable.", "error");
    }
  }

  el.loginTab.addEventListener("click", function () { selectMode("login"); });
  el.signupTab.addEventListener("click", function () { selectMode("signup"); });

  el.loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus(el.loginStatus, "Signing in…");
    setBusy(el.loginForm, true);
    var form = new FormData(el.loginForm);
    var result = await client.auth.signInWithPassword({
      email: shared.normalizeEmail(form.get("email")),
      password: String(form.get("password") || ""),
    });
    setBusy(el.loginForm, false);
    if (result.error) {
      setStatus(el.loginStatus, shared.safeMessage(result.error, "Could not sign in."), "error");
      return;
    }
    setStatus(el.loginStatus, "");
    showSession(result.data.session);
  });

  el.inviteCode.addEventListener("input", function () {
    el.inviteCode.value = shared.normalizeInviteCode(el.inviteCode.value);
  });

  el.inviteForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    var inviteCode = shared.normalizeInviteCode(el.inviteCode.value);
    var email = shared.normalizeEmail(el.signupEmail.value);

    if (!shared.isPlausibleInviteCode(inviteCode) || !shared.isPlausibleEmail(email)) {
      setStatus(el.inviteStatus, "Enter a complete invite code and email.", "error");
      return;
    }

    setStatus(el.inviteStatus, "Checking invite…");
    setBusy(el.inviteForm, true);
    var result = await client.rpc("engelbart_redeem_invite", {
      invite_code: inviteCode,
      signup_email: email,
    });
    setBusy(el.inviteForm, false);

    if (result.error || result.data !== true) {
      setStatus(el.inviteStatus, "That invite is invalid, expired, or already reserved.", "error");
      return;
    }

    approvedEmail = email;
    el.approvedEmail.value = approvedEmail;
    el.inviteForm.classList.add("hidden");
    el.signupOptions.classList.remove("hidden");
    setStatus(el.inviteStatus, "");
  });

  el.passwordSignupForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus(el.signupStatus, "Creating account…");
    setBusy(el.passwordSignupForm, true);
    var password = new FormData(el.passwordSignupForm).get("password");
    var result = await client.auth.signUp({
      email: approvedEmail,
      password: String(password || ""),
      options: { emailRedirectTo: window.location.origin + "/engelbart" },
    });
    setBusy(el.passwordSignupForm, false);

    if (result.error) {
      setStatus(el.signupStatus, shared.safeMessage(result.error, "Could not create the account."), "error");
      return;
    }
    if (result.data.session) {
      showSession(result.data.session);
      return;
    }
    setStatus(el.signupStatus, "Check your email to confirm the account, then return here to sign in.", "success");
  });

  el.changeInvite.addEventListener("click", function () {
    approvedEmail = "";
    el.inviteForm.classList.remove("hidden");
    el.signupOptions.classList.add("hidden");
    setStatus(el.signupStatus, "");
  });

  el.pairingApprove.addEventListener("click", function () { resolvePairing(true); });
  el.pairingDeny.addEventListener("click", function () { resolvePairing(false); });

  el.signOut.addEventListener("click", async function () {
    await client.auth.signOut();
    pairingResolved = false;
    showSession(null);
    selectMode("login");
  });

  async function boot() {
    try {
      var response = await fetch("/api/engelbart-config", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Configuration unavailable");
      config = await response.json();
      client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      client.auth.onAuthStateChange(function (_event, session) { showSession(session); });
      var sessionResult = await client.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      showSession(sessionResult.data.session);
    } catch (_error) {
      el.loading.querySelector(".status").textContent = "Engelbart authentication is not configured on this deployment.";
      el.loading.querySelector(".status").dataset.kind = "error";
    }
  }

  boot();
})();
