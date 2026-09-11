"use strict";

(() => {
  const video = document.getElementById("hero-video");
  const toggle = document.querySelector(".motion-toggle");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let userPaused = reducedMotion.matches;

  const syncControl = () => {
    toggle.textContent = video.paused ? "Play video" : "Pause video";
    toggle.setAttribute("aria-label", video.paused ? "Play background video" : "Pause background video");
  };
  const play = () => video.play().catch(syncControl);
  video.muted = true;
  video.addEventListener("play", syncControl);
  video.addEventListener("pause", syncControl);
  toggle.hidden = false;

  toggle.addEventListener("click", () => {
    userPaused = !video.paused;
    if (userPaused) video.pause();
    else play();
  });
  const applyMotionPreference = () => {
    userPaused = reducedMotion.matches;
    video.autoplay = !userPaused;
    if (userPaused) video.pause();
    else play();
    syncControl();
  };
  reducedMotion.addEventListener("change", applyMotionPreference);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !userPaused) play();
  });
  applyMotionPreference();
})();
