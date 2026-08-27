// Runs in <head>, same-origin and tiny, so it lands before the Supabase bundle
// downloads from the CDN. app.js cannot decide what to paint until that bundle
// arrives — roughly half a second — which is long enough to watch the pills and
// the form pop in. This stamps the answer on <html> for CSS to act on during
// the first paint instead. app.js clears both attributes once it takes over.
(function stampFirstPaint() {
  "use strict";

  var root = document.documentElement;

  var params = new URLSearchParams(window.location.search);
  var asked = params.get("mode") || window.location.hash.replace("#", "");
  if (asked === "signup") root.setAttribute("data-auth-mode", "signup");

  // Supabase persists its session under sb-<project-ref>-auth-token. Its mere
  // presence is not proof the session is valid, so this only suppresses the
  // signed-out form; app.js still decides what is actually shown.
  try {
    for (var i = 0; i < window.localStorage.length; i++) {
      var key = window.localStorage.key(i);
      if (/^sb-.*-auth-token$/.test(key) && window.localStorage.getItem(key)) {
        root.setAttribute("data-session", "1");
        break;
      }
    }
  } catch (_error) {
    // Private mode or blocked storage: fall through to the signed-out paint.
  }
})();
