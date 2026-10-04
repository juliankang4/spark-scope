// The mini window as its own page at /mini/ (opened directly, for example from a bookmark). The web page draws the
// same view with mountMini() in its picture-in-picture window or in the page itself.
import { mountMini } from './mini-view.js';

// Back opens the dashboard in this tab, in its full view even on a phone, which would otherwise start in the mini view.
mountMini(document, window, { onBack: () => { try { localStorage.setItem('spark-scope-view', 'full'); } catch {} location.assign('/'); } });
