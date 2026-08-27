(function attachEngelbartShared(root, factory) {
  var shared = factory();
  if (typeof module === "object" && module.exports) module.exports = shared;
  root.EngelbartShared = shared;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEngelbartShared() {
  "use strict";

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeInviteCode(value) {
    var compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!compact.startsWith("EGB")) return compact;
    var body = compact.slice(3);
    var groups = body.match(/.{1,4}/g) || [];
    return ["EGB"].concat(groups).join("-");
  }

  function isPlausibleEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
  }

  function isPlausibleInviteCode(value) {
    return /^EGB-[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/.test(normalizeInviteCode(value));
  }

  // The CLI pairing code the installer prints. Kept in step with
  // normalizeUserCode in api/_lib/cli-auth.js; a test pins the two together.
  function normalizeUserCode(value) {
    var compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (compact.length <= 4) return compact;
    return compact.slice(0, 4) + "-" + compact.slice(4, 8);
  }

  function isPlausibleUserCode(value) {
    return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeUserCode(value));
  }

  function safeMessage(error, fallback) {
    if (!error) return fallback;
    var message = typeof error === "string" ? error : error.message;
    if (!message) return fallback;
    if (/invalid login credentials/i.test(message)) return "Email or password is incorrect.";
    if (/email not confirmed/i.test(message)) return "Confirm your email before signing in.";
    if (/user already registered/i.test(message)) return "That email already has an account. Sign in instead.";
    if (/engelbart invite/i.test(message)) return message;
    return fallback;
  }

  return {
    normalizeEmail: normalizeEmail,
    normalizeInviteCode: normalizeInviteCode,
    isPlausibleEmail: isPlausibleEmail,
    isPlausibleInviteCode: isPlausibleInviteCode,
    isPlausibleUserCode: isPlausibleUserCode,
    normalizeUserCode: normalizeUserCode,
    safeMessage: safeMessage,
  };
});
