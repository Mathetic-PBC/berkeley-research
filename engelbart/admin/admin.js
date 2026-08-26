(function runInviteAdmin() {
  "use strict";

  var client = null;
  var generatedCode = "";
  var generateButton = document.getElementById("generate-invite");
  var copyButton = document.getElementById("copy-code");
  var status = document.getElementById("admin-status");
  var resultPanel = document.getElementById("invite-result");
  var codeNode = document.getElementById("generated-code");
  var expiryNode = document.getElementById("invite-expiry");

  function setStatus(message, kind) {
    status.textContent = message || "";
    status.dataset.kind = kind || "";
  }

  generateButton.addEventListener("click", async function () {
    if (!client) return;
    generateButton.disabled = true;
    setStatus("Generating…");
    var response = await client.rpc("engelbart_generate_invite");
    generateButton.disabled = false;

    var invite = Array.isArray(response.data) ? response.data[0] : response.data;
    if (response.error || !invite || !invite.code) {
      setStatus("Invite generation is unavailable until the Supabase migration is active.", "error");
      return;
    }

    generatedCode = invite.code;
    codeNode.textContent = generatedCode;
    expiryNode.textContent = "Expires " + new Date(invite.expires_at).toLocaleString();
    resultPanel.classList.remove("hidden");
    setStatus("Invite created.", "success");
  });

  copyButton.addEventListener("click", async function () {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      copyButton.textContent = "Copied";
      window.setTimeout(function () { copyButton.textContent = "Copy code"; }, 1600);
    } catch (_error) {
      setStatus("Copy failed. Select the code manually.", "error");
    }
  });

  async function boot() {
    try {
      var response = await fetch("/api/engelbart-config", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Configuration unavailable");
      var config = await response.json();
      client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    } catch (_error) {
      generateButton.disabled = true;
      setStatus("Engelbart authentication is not configured on this deployment.", "error");
    }
  }

  boot();
})();
