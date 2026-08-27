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
    def: document.getElementById("page-def"),
    navAuth: document.getElementById("nav-auth"),
    navSession: document.getElementById("nav-session"),
    sessionEmail: document.getElementById("session-email"),
    creditStatus: document.getElementById("credit-status"),
    creditMeter: document.getElementById("credit-meter"),
    creditFill: document.getElementById("credit-fill"),
    keyBlock: document.getElementById("key-block"),
    apiKey: document.getElementById("api-key"),
    revealKey: document.getElementById("reveal-key"),
    copyKey: document.getElementById("copy-key"),
    setupCmd: document.getElementById("setup-cmd"),
    copySetup: document.getElementById("copy-setup"),
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
    pairingRequest: document.getElementById("pairing-request"),
    pairingDone: document.getElementById("pairing-done"),
    pairingMark: document.getElementById("pairing-mark"),
    defConnected: document.getElementById("def-connected"),
    pairingDoneBody: document.getElementById("pairing-done-body"),
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

  var DEF = {
    login: "Sign in to pick up your Claude credit.",
    signup: "Your invite code reserves one account, and one Claude credit.",
    session: "Your key works with Claude Code on any laptop you sign in from.",
  };

  var signedIn = false;
  var mode = "login";

  function replayFlight() {
    if (window.EngelbartFlight) window.EngelbartFlight.fly();
  }

  function selectMode(next) {
    var was = mode;
    mode = next === "signup" ? "signup" : "login";
    var login = mode === "login";
    el.loginView.classList.toggle("hidden", !login);
    el.signupView.classList.toggle("hidden", login);
    el.def.textContent = login ? DEF.login : DEF.signup;
    el.loginTab.classList.toggle("on", login);
    el.signupTab.classList.toggle("on", !login);
    if (was !== mode) replayFlight();
  }

  function showSession(session) {
    // boot.js guessed the first paint from the URL and localStorage. The real
    // session is known now, so those guesses stop applying - and not a moment
    // earlier, or a stored session flashes the signed-out form on its way in.
    document.documentElement.removeAttribute("data-auth-mode");
    document.documentElement.removeAttribute("data-session");
    var was = signedIn;
    signedIn = Boolean(session && session.user);
    var pairing = signedIn && Boolean(pendingCode);
    currentSession = signedIn ? session : null;
    el.loading.classList.add("hidden");
    el.auth.classList.toggle("hidden", signedIn);
    el.pairingNote.classList.toggle("hidden", signedIn || !pendingCode);
    var connecting = pairing || pairingResolved;
    el.pairing.classList.toggle("hidden", !connecting);
    // Answering the terminal is the only thing on screen while a code is live,
    // and the answer is still the only thing on screen once it has been given:
    // whatever the CLI needs next, it says in the terminal the member is
    // already looking at.
    // The masthead stays: on this page the plane and the name are the frame,
    // and its italic line is where the page says what it wants. Connecting a
    // terminal is one more thing it can want, so it speaks there.
    document.body.classList.toggle("connecting", connecting);
    if (connecting) {
      document.documentElement.setAttribute(
        "data-auth-mode", pairingResolved ? "connected" : "pairing");
    }
    el.download.classList.toggle("hidden", !signedIn || connecting);
    el.navAuth.classList.toggle("hidden", signedIn);
    el.navSession.classList.toggle("hidden", !signedIn);
    if (signedIn) {
      el.def.textContent = DEF.session;
      el.sessionEmail.textContent = session.user.email || "Signed in";
      el.pairingEmail.textContent = session.user.email || "Signed in";
      if (pairing) el.pairingCode.textContent = pendingCode;
      provisionCredits(session);
    }
    if (was !== signedIn) replayFlight();
  }

  var credentials = null;
  var keyVisible = false;

  function maskKey(key) {
    return key.length > 10 ? key.slice(0, 3) + "\u2022".repeat(18) + key.slice(-4) : key;
  }

  function setupCommand(value) {
    return 'export ANTHROPIC_BASE_URL="' + value.baseUrl + '"\n'
      + 'export ANTHROPIC_AUTH_TOKEN="' + value.apiKey + '"';
  }

  function renderCredentials() {
    if (!credentials) return;
    var budget = Number(credentials.budgetUsd);
    var spent = Number(credentials.spendUsd || 0);
    var left = Math.max(0, budget - spent);
    setStatus(
      el.creditStatus,
      "$" + left.toFixed(2) + " of $" + budget.toFixed(2) + " Claude credit left.",
      left > 0 ? "success" : "error"
    );
    el.creditMeter.classList.remove("hidden");
    el.creditFill.style.width = (budget > 0 ? Math.max(0, Math.min(100, (left / budget) * 100)) : 0) + "%";

    el.apiKey.textContent = keyVisible ? credentials.apiKey : maskKey(credentials.apiKey);
    el.revealKey.textContent = keyVisible ? "Hide" : "Show";
    el.setupCmd.textContent = keyVisible
      ? setupCommand(credentials)
      : setupCommand({ baseUrl: credentials.baseUrl, apiKey: maskKey(credentials.apiKey) });
    el.keyBlock.classList.remove("hidden");
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
      // The card becomes its own answer rather than growing a second half: the
      // code is spent, so showing it again only invites a member to read it as
      // something still to be done.
      el.pairingRequest.classList.add("hidden");
      el.pairingMark.classList.toggle("hidden", !approve);
      // The masthead's italic line says what happened, the way it says what
      // the page wants everywhere else on it.
      el.defConnected.textContent = approve
        ? "That terminal is connected."
        : "Nothing was connected.";
      el.pairingDoneBody.textContent = approve
        ? "You can return to your terminal. Engelbart will finish automatically."
        : "That code was rejected. You can close this tab.";
      el.pairingDone.classList.remove("hidden");
      setStatus(el.pairingStatus, "");
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
    setStatus(el.creditStatus, "Minting your Claude Code key\u2026");
    try {
      var auth = { Accept: "application/json", Authorization: "Bearer " + session.access_token };
      // POST is idempotent: it creates the LiteLLM user and key only once.
      var created = await fetch("/api/engelbart-credentials", { method: "POST", headers: auth });
      var createdValue = await created.json();
      if (!created.ok) throw new Error(createdValue.error || "Credit allocation failed");

      var read = await fetch("/api/engelbart-credentials", { headers: auth });
      var value = await read.json();
      if (!read.ok) throw new Error(value.error || "Could not read your key");
      credentials = value;
      renderCredentials();
    } catch (error) {
      provisionedUser = "";
      credentials = null;
      el.keyBlock.classList.add("hidden");
      el.creditMeter.classList.add("hidden");
      setStatus(el.creditStatus, error.message || "Claude credit allocation is unavailable.", "error");
    }
  }

  el.revealKey.addEventListener("click", function () {
    keyVisible = !keyVisible;
    renderCredentials();
  });

  function copyToClipboard(text, button, done) {
    var label = button.textContent;
    function flash() {
      button.textContent = done;
      setTimeout(function () { button.textContent = label; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () {});
      return;
    }
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:0;left:-9999px";
    document.body.appendChild(field);
    field.select();
    try { document.execCommand("copy"); flash(); } catch (_error) { /* clipboard unavailable */ }
    document.body.removeChild(field);
  }

  el.copyKey.addEventListener("click", function () {
    if (credentials) copyToClipboard(credentials.apiKey, el.copyKey, "Copied");
  });

  el.copySetup.addEventListener("click", function () {
    if (credentials) copyToClipboard(setupCommand(credentials), el.copySetup, "Copied");
  });

  el.loginTab.addEventListener("click", function () { selectMode("login"); });
  el.signupTab.addEventListener("click", function () { selectMode("signup"); });

  el.loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    setStatus(el.loginStatus, "Signing in…");
    // Read the fields before disabling them. A disabled control is omitted
    // from FormData, so reversing these two lines submits an empty email and
    // the sign-in fails as "missing email or phone".
    var form = new FormData(el.loginForm);
    var email = shared.normalizeEmail(form.get("email"));
    var password = String(form.get("password") || "");
    setBusy(el.loginForm, true);
    var result = await client.auth.signInWithPassword({ email: email, password: password });
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
    // Same ordering trap as the sign-in form above.
    var password = new FormData(el.passwordSignupForm).get("password");
    setBusy(el.passwordSignupForm, true);
    var result = await client.auth.signUp({
      email: approvedEmail,
      password: String(password || ""),
      options: { emailRedirectTo: window.location.origin + "/engelbart/signin" },
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
    credentials = null;
    keyVisible = false;
    provisionedUser = "";
    el.keyBlock.classList.add("hidden");
    el.creditMeter.classList.add("hidden");
    showSession(null);
    selectMode("login");
  });

  // "Create account" on the landing page, and `bart auth --signup`, deep-link here.
  function initialMode() {
    var params = new URLSearchParams(window.location.search);
    var asked = params.get("mode") || window.location.hash.replace("#", "");
    return asked === "signup" ? "signup" : "login";
  }

  async function boot() {
    selectMode(initialMode());
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
      document.documentElement.removeAttribute("data-auth-mode");
      document.documentElement.removeAttribute("data-session");
      el.auth.classList.add("hidden");
      el.loading.classList.remove("hidden");
      el.loading.querySelector(".status").textContent = "Engelbart sign-in is not set up on this deployment yet.";
      el.loading.querySelector(".status").dataset.kind = "error";
    }
  }

  boot();
})();
