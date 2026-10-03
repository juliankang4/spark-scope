// The mini window opened as a small browser window (browsers without document picture-in-picture, or /mini/ opened
// directly). The web page's picture-in-picture window draws the same view with mountMini().
import { mountMini } from './mini-view.js';

mountMini(document, window, { onOpenDashboard: () => (window.opener && !window.opener.closed ? window.opener.focus() : window.open('/', '_blank')) });
