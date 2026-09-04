const statusEl = document.getElementById('status');
const btn = document.getElementById('showBtn');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  setStatus('Starting…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab.');
    if (!/^https?:\/\//i.test(tab.url || '')) {
      // Worth stating plainly rather than failing mysteriously: Chrome forbids
      // extension scripts on its own pages and on the Web Store.
      throw new Error('This page cannot be scripted. Open the map portal in a normal http(s) tab.');
    }
    const res = await chrome.runtime.sendMessage({ type: 'BND15_ACTIVATE', tabId: tab.id });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Activation failed.');
    setStatus('Digitizer opened.', 'ok');
    setTimeout(() => window.close(), 500);
  } catch (e) {
    setStatus(e.message || String(e), 'err');
    btn.disabled = false;
  }
});

/* Hard Reset from the toolbar.
 *
 * The panel's own Hard Reset is the usual way in, but the case this exists for
 * is the panel being unresponsive — so a route that does not depend on it is
 * worth having. Activation runs first for the same reason: if the page world
 * is not running at all, there is nothing to send a message to, and injecting
 * first makes the button work whether the extension is wedged or absent.
 */
const hardBtn = document.getElementById('hardResetBtn');

hardBtn.addEventListener('click', async () => {
  hardBtn.disabled = true;
  setStatus('Restarting the extension…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab.');
    if (!/^https?:\/\//i.test(tab.url || '')) {
      throw new Error('This page cannot be scripted. Open the map portal in a normal http(s) tab.');
    }
    const res = await chrome.runtime.sendMessage({ type: 'BND15_ACTIVATE', tabId: tab.id });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not reach this tab.');
    await chrome.tabs.sendMessage(tab.id, { type: 'BND15_HARD_RESET' });
    setStatus('Extension restarted. The page was not reloaded.', 'ok');
    setTimeout(() => window.close(), 900);
  } catch (e) {
    setStatus(e.message || String(e), 'err');
    hardBtn.disabled = false;
  }
});
