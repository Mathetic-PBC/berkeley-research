(function runEngelbartOnboarding() {
  "use strict";

  var shared = window.EngelbartShared;
  var client = null;
  var config = null;
  var approvedEmail = "";

  var el = {
    loading: document.getElementById("loading-panel"),
    auth: document.getElementById("auth-panel"),
    download: document.getElementById("download-panel"),
    loginTab: document.getElementById("login-tab"),
    signupTab: document.getElementById("signup-tab"),
    loginView: document.getElementById("login-view"),
    signupView: document.getElementById("signup-view"),
    loginForm: document.getElementById("login-form"),
    loginGoogle: document.getElementById("login-google"),
    loginStatus: document.getElementById("login-status"),
    inviteForm: document.getElementById("invite-form"),
    inviteCode: document.getElementById("invite-code"),
    signupEmail: document.getElementById("signup-email"),
    inviteStatus: document.getElementById("invite-status"),
    signupOptions: document.getElementById("signup-options"),
    approvedEmail: document.getElementById("approved-email"),
    passwordSignupForm: document.getElementById("password-signup-form"),
    signupGoogle: document.getElementById("signup-google"),
    changeInvite: document.getElementById("change-invite"),
    signupStatus: document.getElementById("signup-status"),
    sessionEmail: document.getElementById("session-email"),
    signOut: document.getElementById("sign-out"),
  };

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
    el.loading.classList.add("hidden");
    el.auth.classList.toggle("hidden", signedIn);
    el.download.classList.toggle("hidden", !signedIn);
    if (signedIn) el.sessionEmail.textContent = session.user.email || "Signed in";
  }

  function setGoogleAvailability() {
    var enabled = Boolean(config.googleEnabled);
    el.loginGoogle.disabled = !enabled;
    el.signupGoogle.disabled = !enabled;
    if (!enabled) {
      el.loginGoogle.textContent = "Google sign-in is not configured yet";
      el.signupGoogle.textContent = "Google signup is not configured yet";
    }
  }

  async function beginGoogle() {
    var result = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/engelbart" },
    });
    if (result.error) throw result.error;
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

  el.loginGoogle.addEventListener("click", async function () {
    if (!config.googleEnabled) return;
    setStatus(el.loginStatus, "Opening Google…");
    try {
      await beginGoogle();
    } catch (error) {
      setStatus(el.loginStatus, shared.safeMessage(error, "Could not start Google sign-in."), "error");
    }
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

  el.signupGoogle.addEventListener("click", async function () {
    if (!config.googleEnabled) return;
    setStatus(el.signupStatus, "Opening Google…");
    try {
      await beginGoogle();
    } catch (error) {
      setStatus(el.signupStatus, shared.safeMessage(error, "Could not start Google signup."), "error");
    }
  });

  el.changeInvite.addEventListener("click", function () {
    approvedEmail = "";
    el.inviteForm.classList.remove("hidden");
    el.signupOptions.classList.add("hidden");
    setStatus(el.signupStatus, "");
  });

  el.signOut.addEventListener("click", async function () {
    await client.auth.signOut();
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
      setGoogleAvailability();
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
