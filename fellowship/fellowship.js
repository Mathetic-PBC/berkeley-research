"use strict";

(() => {
  const video = document.getElementById("hero-video");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const play = () => video.play().catch(() => {});
  video.muted = true;
  const applyMotionPreference = () => {
    video.autoplay = !reducedMotion.matches;
    if (reducedMotion.matches) video.pause();
    else play();
  };
  reducedMotion.addEventListener("change", applyMotionPreference);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !reducedMotion.matches) play();
  });
  applyMotionPreference();
})();
