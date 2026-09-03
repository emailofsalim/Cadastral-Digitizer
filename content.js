/* =========================================================================
 * Isolated-world bridge.
 *
 * The digitizer itself runs in the MAIN world so it can reach the page's map
 * object, which means it has no access to chrome.* APIs. This script is the
 * only piece that does, and it exists solely to relay in both directions using
 * DOM events, which cross the world boundary even though JS scopes do not.
 *
 * Injected repeatedly by design (every activation), so it must be idempotent.
 * ========================================================================= */
(() => {
  if (window.__BND15_BRIDGE__) return;
  window.__BND15_BRIDGE__ = true;

  // background/popup -> page
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    window.dispatchEvent(new CustomEvent('BND15_MSG', { detail: message }));
  });

  // page -> background (toolbar badge)
  window.addEventListener('BND15_COUNT_EVT', (e) => {
    const count = (e && e.detail && e.detail.count) || 0;
    chrome.runtime.sendMessage({ type: 'BND15_SHAPE_COUNT', count }).catch(() => {});
  });

  // page -> background -> page: tab capture, for PDFs and unreadable canvases.
  // The page world cannot call chrome.tabs itself, so the request is relayed
  // here and the resulting data URL handed back as a DOM event.
  // page -> background -> page: load the PDF renderer into this tab on demand.
  // Same relay shape as the capture request below; the page world cannot call
  // chrome.scripting itself.
  window.addEventListener('BND15_PDFJS_REQ', (e) => {
    const token = (e && e.detail && e.detail.token) || '';
    chrome.runtime.sendMessage({ type: 'BND15_LOAD_PDFJS' })
      .then((res) => {
        window.dispatchEvent(new CustomEvent('BND15_PDFJS_RES', {
          detail: Object.assign({ token }, res || { ok: false, error: 'No response from the extension worker.' }),
        }));
      })
      .catch((err) => {
        window.dispatchEvent(new CustomEvent('BND15_PDFJS_RES', {
          detail: { token, ok: false, error: (err && err.message) || 'Could not load the PDF renderer.' },
        }));
      });
  });

  window.addEventListener('BND15_CAPTURE_REQ', (e) => {
    const token = (e && e.detail && e.detail.token) || '';
    chrome.runtime.sendMessage({ type: 'BND15_CAPTURE_TAB' })
      .then((res) => {
        window.dispatchEvent(new CustomEvent('BND15_CAPTURE_RES', {
          detail: Object.assign({ token }, res || { ok: false, error: 'No response from the extension worker.' }),
        }));
      })
      .catch((err) => {
        window.dispatchEvent(new CustomEvent('BND15_CAPTURE_RES', {
          detail: { token, ok: false, error: (err && err.message) || 'Capture request failed.' },
        }));
      });
  });
})();
