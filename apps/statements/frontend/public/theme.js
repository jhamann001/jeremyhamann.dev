// Applies the visitor's theme before the page paints: localStorage "theme" ("light" or "dark", set by the theme
// button, or by the portfolio site's hand-off through the Worker), else the system setting. A plain script in
// <head>, not a module, so it runs before anything renders.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (e) {
    /* storage unavailable: follow the system setting */
  }
  var dark = saved === 'dark' ||
    (saved !== 'light' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();
