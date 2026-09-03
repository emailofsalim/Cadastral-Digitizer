/* =========================================================================
 * Service worker — activation and badge.
 * -------------------------------------------------------------------------
 * WHY THIS CHANGED IN v15
 *
 * v13/v14 declared a static content script matched to one hostname:
 *
 *     "content_scripts": [{ "matches": ["https://jharbhunaksha.jharkhand.gov.in/*"] ... }]
 *
 * That hard-codes the extension to a single state's portal. The obvious
 * "fix" — matching <all_urls> — is worse: it demands read-and-change access to
 * every site you visit, forever, to run on the handful you actually use.
 *
 * Instead, activation is on demand via `activeTab`. Clicking the toolbar
 * button or pressing the shortcut grants access to that one tab, for that one
 * visit, and the scripts are injected then. No standing host permissions, no
 * host list to maintain, and it works on any portal in any country.
 *
 * Injection order matters: the libraries define the globals page_inject.js
 * reads at evaluation time. chrome.scripting.executeScript guarantees `files`
 * are injected in array order, so the ordering below is the contract.
 *
 * The libraries and the main script go into the MAIN world because they need
 * the page's own map object (window.map, the Leaflet instance, and so on),
 * which is invisible from an isolated content script. content.js stays in the
 * ISOLATED world because it is the only part that needs chrome.* APIs, and it
 * bridges the two with DOM events.
 * ========================================================================= */

const MAIN_WORLD_FILES = [
  'lib/crs.js',
  'lib/gcp_math.js',
  'lib/tracer.js',
  'lib/topology.js',
  'lib/exporters.js',
  'lib/viewport.js',
  'lib/raster_workspace.js',
  'lib/site_adapters.js',
  'lib/history.js',
  'lib/importers.js',
  'lib/geom_edit.js',
  'page_inject.js',
];

async function activate(tabId, action) {
  // The bridge first, so it is listening before the page script starts talking.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
    world: 'ISOLATED',
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: MAIN_WORLD_FILES,
    world: 'MAIN',
  });
  // page_inject.js guards against double-injection and simply re-shows itself,
  // so re-activating an already-active tab is safe and does what you'd expect.
  if (action) {
    await chrome.tabs.sendMessage(tabId, { type: action }).catch(() => {});
  }
}

function isInjectable(url) {
  return /^https?:\/\//i.test(url || '');
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-digitizer') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !isInjectable(tab.url)) return;
  try {
    await activate(tab.id, 'BND15_TOGGLE_WIDGET');
  } catch (e) {
    console.error('[Digitizer] activation failed:', e && e.message);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'BND15_ACTIVATE') {
    const tabId = message.tabId;
    if (!tabId) { sendResponse({ ok: false, error: 'No tab id supplied.' }); return true; }
    activate(tabId, 'BND15_SHOW_WIDGET')
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({
        ok: false,
        // The common causes are worth naming, because the raw error is opaque.
        error: (e && e.message) || 'Injection failed. Chrome blocks extensions on its own pages (chrome://, the Web Store) and on PDF viewers.',
      }));
    return true; // async response
  }

  /* ---------------------------------------------------------------------
   * TAB CAPTURE — how PDFs and unreadable canvases are supported.
   *
   * Chrome renders PDFs in an internal PDFium viewer that extensions cannot
   * read pixels from: there is no canvas to sample and no DOM to inspect.
   * Bundling a PDF renderer would mean shipping roughly a megabyte of
   * third-party code that could not be tested here. Capturing the rendered tab
   * sidesteps both problems, because the browser has already done the
   * rasterising — and the same mechanism rescues any cross-origin-tainted map
   * canvas that colour tracing could not otherwise read.
   *
   * captureVisibleTab needs host access for the tab, which activeTab has
   * already granted for this gesture. The honest limitation is that a capture
   * is at screen resolution, not source resolution.
   * ------------------------------------------------------------------- */
  if (message.type === 'BND15_CAPTURE_TAB') {
    const windowId = (sender && sender.tab && sender.tab.windowId);
    const opts = { format: 'png' };
    const doCapture = (id) => chrome.tabs.captureVisibleTab(id, opts);
    (windowId ? doCapture(windowId) : doCapture())
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({
        ok: false,
        error: (e && e.message) ||
          'Capture failed. Chrome refuses to capture its own pages (chrome://, the Web Store). ' +
          'Reopen the extension from the toolbar button on this tab and try again.',
      }));
    return true; // async response
  }

  if (message.type === 'BND15_SHAPE_COUNT') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) return;
    const count = Number(message.count) || 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId });
  }
});
