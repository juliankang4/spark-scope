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
// The dashboard opens in its mini view on a phone until the dashboard is picked there, and wherever the page itself
// last showed the mini view (browsers without document picture-in-picture). app.js draws the view and keeps the
// choice; the phone query is PHONE_QUERY in view-data.js. Hiding the dashboard here keeps it from flashing first. A
// link to the token ledger (#tokens) opens the ledger.
if ((location.pathname === '/' || location.pathname === '/index.html') && location.hash !== '#tokens') {
  const phone = matchMedia('(max-width: 640px) and (pointer: coarse)').matches;
  let saved = null;
  try { saved = localStorage.getItem('spark-scope-view'); } catch {}
  if ((phone || !('documentPictureInPicture' in window)) && (saved === 'mini' || (saved === null && phone))) document.documentElement.dataset.view = 'mini';
}
