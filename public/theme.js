// Runs before the page is drawn (loaded in <head>), so a saved dark theme never flashes light first. A separate file
// rather than an inline script, so the Content-Security-Policy can allow only this server's own scripts.
try {
  const saved = localStorage.getItem('spark-scope-theme');
  document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
