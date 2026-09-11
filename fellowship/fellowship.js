"use strict";

(() => {
  const video = document.getElementById("hero-video");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const portrait = window.matchMedia("(max-aspect-ratio: 1/1)");
  const play = () => video.play().catch(() => {});
  video.muted = true;
  const applyMotionPreference = () => {
    video.autoplay = !reducedMotion.matches;
    if (reducedMotion.matches) video.pause();
    else play();
  };
  reducedMotion.addEventListener("change", applyMotionPreference);
  const setPoster = () => {
    video.poster = portrait.matches
      ? "/fellowship/media/poster-mobile.jpg"
      : "/fellowship/media/poster-1080.jpg";
  };
  portrait.addEventListener("change", () => {
    setPoster();
    video.load();
    applyMotionPreference();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !reducedMotion.matches) play();
  });
  setPoster();
  applyMotionPreference();
})();
