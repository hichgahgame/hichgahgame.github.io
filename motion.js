// Gameplay videos play on their own, muted and looping, unless the visitor asked for less motion:
// then they stay paused on their poster with controls to play them by hand.
if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (const video of document.querySelectorAll("video[autoplay]")) {
    video.removeAttribute("autoplay");
    video.pause();
    video.controls = true;
  }
}
