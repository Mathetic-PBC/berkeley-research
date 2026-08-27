(function runEngelbartLanding() {
  "use strict";

  // All that survives of the simulated demo: the install line is the one thing
  // on this page a visitor is meant to take away with them.
  var button = document.getElementById("copy-cmd");
  var icon = document.getElementById("copy-cmd-icon");
  if (!button) return;

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:0;left:-9999px";
    document.body.appendChild(field);
    field.select();
    try { document.execCommand("copy"); } catch (_error) { /* clipboard unavailable */ }
    document.body.removeChild(field);
  }

  var timer = null;
  button.addEventListener("click", function () {
    copyText("npx engelbart-cli");
    if (!icon) return;
    clearTimeout(timer);
    icon.classList.add("copied");
    timer = setTimeout(function () { icon.classList.remove("copied"); }, 1600);
  });

  // A visitor who asked their system not to animate should get a still frame
  // they can start themselves, not a loop that ignores the request.
  var reel = document.querySelector(".dm-reel video");
  if (reel && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    reel.removeAttribute("autoplay");
    reel.setAttribute("controls", "");
    reel.pause();
  }
})();
