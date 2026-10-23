// Applies the stored or system dark theme before the first paint. A file, not
// an inline script: the portal Content-Security-Policy allows no inline script.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('portal_theme') || localStorage.getItem('theme');
  } catch (e) {
    // Storage can be blocked (private mode): fall back to the system theme.
    theme = null;
  }
  if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
})();
