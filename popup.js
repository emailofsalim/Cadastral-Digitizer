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
