// Explanations behind a small "?" button next to the item they explain (data-help names the text in i18n.js). The
// text shows while the pointer is over the button or it has keyboard focus; a click or tap keeps it open until the
// next click elsewhere, Escape or a scroll. One tip element is shared; inside the settings dialog it moves into the
// dialog, because a modal dialog sits above everything else on the page.
import { t } from './i18n.js';

let tip = null, owner = null, pinned = false;

// The button for pages that build their markup in script; index.html writes the same markup by hand.
export const helpButton = (key) => `<button type="button" class="help" data-help="${key}" aria-label="${t('help.label')}">?</button>`;

function place(button) {
  const host = button.closest('dialog') ?? document.body;
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'help-tip';
    tip.className = 'help-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
  }
  if (tip.parentElement !== host) host.append(tip);
  // data-help-note adds a live value to the fixed text (the TTFT and TPOT p95 since the engine started).
  tip.textContent = [t(button.dataset.help), button.dataset.helpNote].filter(Boolean).join(' ');
  // Measured at the window's corner first: a fixed box shrinks against the right edge, so its old place would give a
  // narrow, tall size.
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.hidden = false;
  // Below the button, kept inside the window; above it when there is no room below.
  const box = button.getBoundingClientRect(), size = tip.getBoundingClientRect(), margin = 8;
  const left = Math.min(Math.max(margin, box.left + box.width / 2 - size.width / 2), innerWidth - size.width - margin);
  const below = box.bottom + 6, above = box.top - 6 - size.height;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(below + size.height > innerHeight - margin && above > margin ? above : below)}px`;
}

function show(button, pin = false) {
  if (owner && owner !== button) hide();
  owner = button;
  pinned = pin;
  place(button);
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-describedby', 'help-tip');
}

export function hide() {
  if (tip) tip.hidden = true;
  owner?.setAttribute('aria-expanded', 'false');
  owner?.removeAttribute('aria-describedby');
  owner = null;
  pinned = false;
}

// Event delegation, so buttons in cards and tables that are rebuilt on every poll work without rebinding. Only in a
// browser: the tests import helpButton() through ledger.js.
if (typeof document !== 'undefined') {
  const helpTarget = (event) => event.target instanceof Element ? event.target.closest('button[data-help]') : null;
  document.addEventListener('mouseover', (event) => { const button = helpTarget(event); if (button && !pinned) show(button); });
  document.addEventListener('mouseout', (event) => { const button = helpTarget(event); if (button && button === owner && !pinned && !button.contains(event.relatedTarget)) hide(); });
  document.addEventListener('focusin', (event) => { const button = helpTarget(event); if (button && !pinned) show(button); });
  document.addEventListener('focusout', (event) => { const button = helpTarget(event); if (button && button === owner && !pinned) hide(); });
  document.addEventListener('click', (event) => {
    const button = helpTarget(event);
    if (button) {
      event.preventDefault();
      if (button === owner && pinned) hide(); else show(button, true);
    } else if (owner && !tip?.contains(event.target)) {
      hide();
    }
  });
  // Escape closes an open explanation first; inside the settings dialog it does not close the dialog as well.
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && owner) { event.preventDefault(); hide(); } });
  addEventListener('scroll', () => { if (owner) hide(); }, { capture: true, passive: true });
  addEventListener('resize', () => { if (owner) hide(); });
}
