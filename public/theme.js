// Runs before the page is drawn (loaded in <head>), so a saved dark theme never flashes light first. A separate file
// rather than an inline script, so the Content-Security-Policy can allow only this server's own scripts.
// A settings link (?theme=dark) is applied here too, so the page opens in that theme; app.js then saves it.
try {
  const linked = new URLSearchParams(location.search).get('theme');
  const saved = linked === 'dark' || linked === 'light' ? linked : localStorage.getItem('spark-scope-theme');
  document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
// The design (Default, Console, Soft) is applied here as well, from a settings link or the saved settings.
try {
  const linked = new URLSearchParams(location.search).get('design');
  const saved = linked ?? JSON.parse(localStorage.getItem('spark-scope-settings') ?? '{}').design;
  if (saved === 'console' || saved === 'soft') document.documentElement.dataset.design = saved;
} catch {}
