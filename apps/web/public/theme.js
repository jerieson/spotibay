// Runs before first paint so a saved light theme doesn't flash dark. Served as a file so the CSP can stay free of inline scripts.
try {
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.remove('dark');
  }
} catch {
  // Storage blocked: keep the default dark theme.
}
