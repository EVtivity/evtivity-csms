// Applies the stored mode (light or dark) and theme before the first paint, so
// a page never flashes the Default light look first. A file, not an inline
// script: the Content-Security-Policy allows no inline script. The bundle
// applies the same values again (lib/theme.ts) and, once signed in, the
// account's own values (users.theme_preference, users.ui_theme).
(function () {
  var mode = null;
  var theme = null;
  try {
    mode = localStorage.getItem('theme');
    theme = localStorage.getItem('ui_theme');
  } catch (e) {
    // Storage can be blocked (private mode): fall back to the system mode and Default.
    mode = null;
    theme = null;
  }
  var root = document.documentElement;
  if (
    mode === 'dark' ||
    (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  ) {
    root.classList.add('dark');
  }
  if (theme === 'soft' || theme === 'high-contrast') {
    root.setAttribute('data-theme', theme);
  }
})();
