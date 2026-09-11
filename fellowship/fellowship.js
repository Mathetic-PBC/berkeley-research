"use strict";

(() => {
  const video = document.getElementById("hero-video");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const portrait = window.matchMedia("(max-aspect-ratio: 1/1)");
  const play = () => {
    if (reducedMotion.matches || document.hidden || !video.paused) return;
    // A phone may reject autoplay until a user gesture; keep the poster and
    // retry synchronously from the gesture handlers below.
    video.play().catch(() => {});
  };
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
  document.addEventListener("visibilitychange", play);
  window.addEventListener("pageshow", play);
  // A direct gesture can authorize playback when mobile power-saving or
  // autoplay settings block the initial attempt. No playback controls needed.
  for (const event of ["touchend", "pointerup", "keydown"]) {
    document.addEventListener(event, play, { passive: true });
  }
  setPoster();
  applyMotionPreference();
})();
