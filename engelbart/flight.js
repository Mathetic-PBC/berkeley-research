// The homepage plane flies when you scroll. There is nothing to scroll on the
// sign-in page, so it flies once on arrival and then rests at the end of its
// trail.
(function flyThePlane() {
  "use strict";

  var trail = document.getElementById("flight-trail");
  var plane = document.getElementById("flight-plane");
  if (!trail || !plane || !trail.getTotalLength) return;

  var length = trail.getTotalLength();
  trail.style.strokeDasharray = String(length);

  function draw(progress) {
    trail.style.strokeDashoffset = String(length * (1 - progress));
    var at = trail.getPointAtLength(length * progress);
    var behind = trail.getPointAtLength(Math.max(0, length * progress - 2));
    var angle = Math.atan2(at.y - behind.y, at.x - behind.x) * 180 / Math.PI;
    plane.setAttribute(
      "transform",
      "translate(" + at.x.toFixed(1) + " " + at.y.toFixed(1) + ") rotate(" + (angle + 43).toFixed(1) + ")"
    );
  }

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    draw(1);
    return;
  }

  // Re-fly whenever the card swaps between sign in, create account, and signed
  // in, so the page always has one small piece of motion in it.
  var running = null;
  function fly() {
    if (running) cancelAnimationFrame(running);
    var duration = 1400;
    var start = null;
    draw(0.06);
    running = requestAnimationFrame(function step(now) {
      if (start === null) start = now;
      var k = Math.min(1, (now - start) / duration);
      draw(0.06 + 0.94 * (1 - Math.pow(1 - k, 3)));
      running = k < 1 ? requestAnimationFrame(step) : null;
    });
  }

  window.EngelbartFlight = { fly: fly };
  fly();
})();
