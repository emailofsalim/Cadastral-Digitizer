/* =========================================================================
 * END-TO-END IN REAL CHROME, with the extension actually installed.
 *
 * This covers what the jsdom suite structurally cannot:
 *
 *   - chrome.scripting.executeScript with world:'MAIN' really injecting the
 *     libraries and page script into the page's own JS world
 *   - the ISOLATED-world content.js bridge relaying across worlds
 *   - chrome.tabs.captureVisibleTab returning a real PNG, which is the whole
 *     basis of PDF support
 *   - colour tracing against GENUINELY rasterised canvas pixels rather than a
 *     stubbed getImageData
 *
 * SCOPE, stated plainly: the extension is loaded with host access granted up
 * front, because `activeTab` is granted only by a real click on the toolbar
 * button and headless Chrome cannot produce one. So this verifies the injection
 * mechanism and everything downstream of it; the activeTab grant itself is the
 * one step still resting on a manual check.
 *
 * Skips cleanly when playwright-core or a Chrome binary is absent, so the
 * default `npm test` is unaffected. Enable with:
 *   npm install --no-save playwright-core
 * ========================================================================= */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* optional */ }

/* WHICH BROWSER, AND WHY NOT THE INSTALLED GOOGLE CHROME
 *
 * These tests need a browser that can load an UNPACKED extension. From Chrome
 * 137 the stable channel refuses `--load-extension` in headless mode, so an
 * installed google-chrome silently loads nothing: chrome://extensions lists
 * zero items, no service worker ever registers, and every test here times out
 * waiting for one. Measured on Chrome 152, with
 * --disable-features=DisableLoadExtensionCommandLineSwitch and
 * --headless=new both tried and neither helping.
 *
 * Playwright's own Chromium build has no such restriction, and is the same
 * engine — real rasterisation, real MV3 service workers, real tab capture —
 * so nothing about the coverage is weakened by preferring it. It is therefore
 * looked for FIRST, and an installed Chrome is kept only as a last resort for
 * an older build that can still do the job.
 *
 * Get one with:  npx playwright install chromium
 */
const CHROME = (() => {
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (e) { return false; } };
  const candidates = [];
  // Playwright's own build, wherever this installation keeps it.
  try { candidates.push(chromium && chromium.executablePath()); } catch (e) { /* not installed */ }
  // Some images stage it under a stable symlink rather than a versioned path.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    candidates.push(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'));
  }
  candidates.push('/opt/pw-browsers/chromium', '/usr/bin/chromium',
    // Last: an installed Chrome. Fine if it predates the headless restriction,
    // and it fails with an explicit message in launch() if it does not.
    '/usr/local/bin/chrome', '/usr/bin/google-chrome');
  return candidates.find(exists);
})();

const enabled = !!(chromium && CHROME);
const t = enabled ? test : test.skip;

/* ---------------------------------------------------------------------
 * A copy of the extension with host access pre-granted, so injection can be
 * driven without a toolbar click. Nothing else about it is altered.
 * ------------------------------------------------------------------- */
let tmpRoot = null, ctx = null, sharedSw = null, launching = null;
const openPages = [];

function stageExtension() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-e2e-'));
  const extDir = path.join(tmpRoot, 'ext');
  fs.mkdirSync(extDir, { recursive: true });
  const copy = (rel) => {
    const src = path.join(ROOT, rel), dst = path.join(extDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  for (const f of ['manifest.json', 'background.js', 'content.js', 'page_inject.js',
    'popup.html', 'popup.js', 'icon16.png', 'icon48.png', 'icon128.png']) copy(f);
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) copy(path.join('lib', f));
  // vendor/ carries PDF.js, which the service worker injects on demand. Staged
  // only when present, so a checkout without it still runs everything else here
  // and the PDF test says plainly what is missing rather than failing obscurely.
  const vendorDir = path.join(ROOT, 'vendor');
  if (fs.existsSync(vendorDir)) {
    for (const f of fs.readdirSync(vendorDir)) {
      if (/\.js$/i.test(f)) copy(path.join('vendor', f));
    }
  }

  const m = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  m.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(m, null, 2));
  return extDir;
}

/* One browser for the whole file, with a fresh tab per test.
 *
 * Launching per test both wasted ~2s each and leaked: the module-level handle
 * was reassigned every time, so only the last browser was ever closed and the
 * rest stayed alive holding temp profiles.
 */
function launch() {
  if (launching) return launching;
  launching = (async () => {
    const ext = stageExtension();
    ctx = await chromium.launchPersistentContext(path.join(tmpRoot, 'profile'), {
      executablePath: CHROME,
      headless: true,
      args: [
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      viewport: { width: 1100, height: 800 },
    });
    // Registered for cleanup IMMEDIATELY, before anything that can throw.
    //
    // This line used to sit below the waitForEvent, and that was the whole of
    // the CI hang: when the service worker never arrived, the timeout threw
    // past the push, the browser was never closed by `after`, and the runner
    // sat with a live Chrome holding its event loop open until the job was
    // killed. --test-force-exit was removed in 16.3.0, so an unclosed handle
    // is not a slow suite, it is an infinite one. A launch that fails must
    // still leave a closable browser behind.
    allContexts.push(ctx);
    let [sw] = ctx.serviceWorkers();
    if (!sw) {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
    }
    if (!sw) {
      throw new Error(
        `The extension's service worker never registered in ${CHROME}. `
        + 'That browser could not load the unpacked extension — Chrome refuses '
        + '--load-extension in headless mode from version 137, so the suite needs '
        + "Playwright's own Chromium rather than an installed Google Chrome. "
        + 'Run: npx playwright install chromium');
    }
    sharedSw = sw;
    return { ctx, sw, extId: new URL(sw.url()).host };
  })();
  return launching;
}

/* Every launched context is tracked, because more than one is created — the
 * permission test deliberately runs a second, differently-configured browser.
 * Missing one leaves an orphaned Chrome holding a temp profile.
 *
 * Nothing here may outlive the last test. --test-force-exit was removed in
 * 16.3.0 because it truncated the TAP output, so the runner now waits for the
 * event loop to drain: a browser context or a listening socket left open does
 * not slow the suite down, it hangs it forever. `after` therefore has to close
 * everything, and the fixture server is unref'd as a second line of defence.
 */
const allContexts = [];

after(async () => {
  await Promise.all(allContexts.map(async (c) => {
    try { await c.close(); } catch (e) { /* already gone */ }
  }));
  if (fixtureServer) {
    await new Promise((resolve) => fixtureServer.close(resolve));
    fixtureServer = null;
    fixtureOrigin = null;
  }
  // The second origin used by the tainted-canvas test. A listening socket left
  // open does not slow the runner down, it hangs it forever.
  if (taintServer) {
    await new Promise((resolve) => taintServer.close(resolve));
    taintServer = null;
    taintOrigin = null;
  }
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

/* ---------------------------------------------------------------------
 * The fixtures are served over HTTP, not opened as file:// URLs.
 *
 * This is not a detail. An extension's host permissions — even <all_urls> —
 * do NOT grant access to file:// pages; Chrome gates that behind a separate
 * per-extension "Allow access to file URLs" setting that cannot be set from a
 * manifest or a command-line flag. Playwright's bundled Chromium happens to be
 * permissive about it, so this suite passed locally for a long time; real
 * Google Chrome is not, and on a CI runner every test stalled on its
 * waitForSelector until the job was killed.
 *
 * Serving over http://127.0.0.1 is also the more honest test, because http(s)
 * is the only surface the extension claims: background.js's isInjectable()
 * accepts nothing else, so a file:// page was never something a user could
 * digitize anyway.
 *
 * The server holds no state beyond the bytes it serves, listens on an
 * ephemeral port so parallel runs cannot collide, and is unref'd as well as
 * closed — a listening handle would keep the test runner alive after the last
 * test, which is exactly the hang this file has to avoid now that
 * --test-force-exit is gone.
 * ------------------------------------------------------------------- */
const http = require('node:http');

let fixtureServer = null;
let fixtureOrigin = null;
const served = new Map();

async function fixtureBase() {
  if (fixtureOrigin) return fixtureOrigin;
  served.set('/stub-map.html', {
    body: fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'stub-map.html')),
    type: 'text/html; charset=utf-8',
  });
  fixtureServer = http.createServer((req, res) => {
    const hit = served.get(String(req.url || '').split('?')[0]);
    if (!hit) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', hit.type);
    res.end(hit.body);
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixtureServer.unref();
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  return fixtureOrigin;
}

const fixtureUrl = async () => `${await fixtureBase()}/stub-map.html`;

// Injection is driven through the worker's own activate(), so the real ordering
// and world assignment in background.js are what gets exercised.
async function activateOn(sw, tabId) {
  return sw.evaluate(async (id) => {
    await activate(id, 'BND15_SHOW_WIDGET');
    return true;
  }, tabId);
}

async function tabIdFor(sw, urlPart) {
  return sw.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((x) => (x.url || '').includes(part));
    return hit ? hit.id : null;
  }, urlPart);
}

async function openFixtureWithExtension() {
  const { sw } = await launch();
  const page = await ctx.newPage();
  openPages.push(page);
  await page.goto(await fixtureUrl());
  await page.waitForFunction(() => !!window.map, null, { timeout: 10000 });

  // Identify this page's own tab by its unique query string, so concurrently
  // open fixture tabs from other tests are never confused with it.
  const marker = 'e2e' + openPages.length;
  await page.evaluate((m) => { document.title = m; }, marker);
  const tabId = await sw.evaluate(async (m) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((x) => x.title === m);
    return hit ? hit.id : null;
  }, marker);
  assert.ok(tabId, 'the fixture tab must be visible to chrome.tabs');

  await activateOn(sw, tabId);
  await page.waitForSelector('#bnd15-widget', { timeout: 15000 });
  return { sw, page, tabId };
}

/* =====================================================================
 * INJECTION
 * =================================================================== */

t('chrome.scripting injects the libraries into the page world, in order', async () => {
  const { page } = await openFixtureWithExtension();

  // MAIN-world injection means the page's own JS can see these. If they had
  // landed in the isolated world, page.evaluate would find nothing.
  const globals = await page.evaluate(() => ({
    crs: typeof window.BND_Crs,
    gcp: typeof window.BND_GcpMath,
    tracer: typeof window.BND_Tracer,
    topo: typeof window.BND_Topology,
    exp: typeof window.BND_Export,
    viewport: typeof window.BND_Viewport,
    raster: typeof window.BND_Raster,
    adapters: typeof window.BND_Adapters,
    active: !!window.__BND15_ACTIVE__,
  }));
  for (const [k, v] of Object.entries(globals)) {
    if (k === 'active') continue;
    assert.strictEqual(v, 'object', `${k} must be present in the page world`);
  }
  assert.strictEqual(globals.active, true, 'page_inject must have run');
});

t('the widget renders and reports the detected map and CRS', async () => {
  const { page } = await openFixtureWithExtension();
  const text = await page.textContent('#bnd15-widget');
  assert.match(text, /Cadastral Digitizer/);
  assert.match(text, /UTM 45N/, `the declared EPSG should resolve: ${text.slice(0, 300)}`);
  assert.match(text, /Md Salim Ansari/, 'authorship must be visible');
  const pe = await page.$eval('#bnd15-overlay', (el) => el.style.pointerEvents);
  assert.strictEqual(pe, 'none', 'the overlay must never intercept input');
});

t('re-activating an already-active tab re-shows rather than double-injecting', async () => {
  const { sw, page, tabId } = await openFixtureWithExtension();
  await activateOn(sw, tabId);
  await page.waitForTimeout(400);
  const widgets = await page.$$eval('[id="bnd15-widget"]', (els) => els.length);
  assert.strictEqual(widgets, 1, 'exactly one widget, not two');
});

/* =====================================================================
 * REAL CANVAS TRACING — the part jsdom could not do
 * =================================================================== */

t('colour tracing works on genuinely rasterised canvas pixels', async () => {
  const { page } = await openFixtureWithExtension();
  await page.click('#bnd15-widget #mTrace');
  await page.waitForTimeout(200);

  // Tap the centre of the large parcel. Real Chrome, real canvas, real pixels.
  const box = await page.evaluate(() => window.__PARCELS__[0]);
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const cx = rect.left + box.x + box.w / 2;
  const cy = rect.top + box.y + box.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(
    () => /Shape 1/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 15000 });

  const text = await page.textContent('#bnd15-widget');
  const m = text.match(/Shape 1 · (\d+)v · (\d+) m²/);
  assert.ok(m, `expected a shape summary: ${text.slice(0, 400)}`);
  assert.ok(Number(m[1]) >= 4 && Number(m[1]) <= 8, `expected ~4 vertices, got ${m[1]}`);
  // 300 x 200 px at 0.5 m/px = 150 x 100 m = 15000 m².
  const area = Number(m[2]);
  assert.ok(Math.abs(area - 15000) / 15000 < 0.05,
    `expected about 15000 m² from the painted parcel, got ${area}`);
});

t('batch vectorisation finds every painted parcel in the view', async () => {
  const { page } = await openFixtureWithExtension();
  // The fixture paints four parcels, all fully inside the view.
  page.on('dialog', (d) => d.accept());
  await page.click('#bnd15-widget #mAuto');
  await page.waitForFunction(
    () => /Shape 4/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 25000 });
  const text = await page.textContent('#bnd15-widget');
  assert.match(text, /Shape 4/, 'all four parcels should be traced');
  assert.ok(!/Shape 5/.test(text),
    'the page background must not be returned as a parcel');
});

/* =====================================================================
 * GESTURES, against a real portal that counts its own clicks
 * =================================================================== */

t('a drag pans and does not digitize', async () => {
  const { page } = await openFixtureWithExtension();
  await page.click('#bnd15-widget #mTrace');
  await page.waitForTimeout(200);
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.mouse.move(rect.left + 300, rect.top + 200);
  await page.mouse.down();
  await page.mouse.move(rect.left + 380, rect.top + 250, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const text = await page.textContent('#bnd15-widget');
  assert.ok(!/Shape 1/.test(text), 'a drag belongs to the map, not the tool');
});

t('a consumed tap does not reach the portal, and an idle tap does', async () => {
  const { page } = await openFixtureWithExtension();
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });

  // Idle: the site must keep working normally.
  await page.mouse.click(rect.left + 560, rect.top + 380);
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => window.__SITE_CLICKS__), 1,
    'with no tool armed the portal must receive the click');

  // Armed: the tap belongs to the digitizer.
  await page.click('#bnd15-widget #mTrace');
  await page.waitForTimeout(200);
  const box = await page.evaluate(() => window.__PARCELS__[0]);
  await page.mouse.click(rect.left + box.x + box.w / 2, rect.top + box.y + box.h / 2);
  await page.waitForTimeout(1500);
  assert.strictEqual(await page.evaluate(() => window.__SITE_CLICKS__), 1,
    'the portal must NOT receive a tap the digitizer consumed');
});

/* =====================================================================
 * TAB CAPTURE — the basis of PDF support
 * =================================================================== */

t('captureVisibleTab returns a real PNG through the content-script bridge', async () => {
  const { page } = await openFixtureWithExtension();

  // Exactly the round trip page_inject uses: a DOM event to the isolated world,
  // relayed to the worker, and back again.
  const res = await page.evaluate(() => new Promise((resolve) => {
    const token = 'e2e-' + Date.now();
    const onRes = (e) => {
      if (!e.detail || e.detail.token !== token) return;
      window.removeEventListener('BND15_CAPTURE_RES', onRes);
      resolve({ ok: !!e.detail.ok, error: e.detail.error || null,
        len: e.detail.dataUrl ? e.detail.dataUrl.length : 0,
        prefix: e.detail.dataUrl ? e.detail.dataUrl.slice(0, 22) : null });
    };
    window.addEventListener('BND15_CAPTURE_RES', onRes);
    window.dispatchEvent(new CustomEvent('BND15_CAPTURE_REQ', { detail: { token } }));
    setTimeout(() => resolve({ ok: false, error: 'timed out in page' }), 15000);
  }));

  assert.strictEqual(res.ok, true, `capture failed: ${res.error}`);
  assert.match(res.prefix, /^data:image\/png;base64,/, `unexpected payload: ${res.prefix}`);
  assert.ok(res.len > 5000, `the PNG looks too small to be a real screenshot: ${res.len} bytes`);
});

t('a captured image can be opened as a workspace and traced', async () => {
  const { page } = await openFixtureWithExtension();

  // Capture, mount it as a raster workspace, and confirm the adapter reports a
  // real decoded bitmap. This is the PDF path minus the PDF itself.
  const info = await page.evaluate(() => new Promise((resolve) => {
    const token = 'ws-' + Date.now();
    const onRes = async (e) => {
      if (!e.detail || e.detail.token !== token) return;
      window.removeEventListener('BND15_CAPTURE_RES', onRes);
      if (!e.detail.ok) return resolve({ ok: false, error: e.detail.error });
      const loaded = await window.BND_Raster.loadImageSource(document, e.detail.dataUrl);
      if (!loaded.ok) return resolve({ ok: false, error: loaded.error });
      const made = window.BND_Raster.createRasterWorkspace({
        doc: document, win: window, Viewport: window.BND_Viewport,
        image: loaded.image, sourceName: 'captured view', sourceKind: 'capture',
      });
      if (!made.ok) return resolve({ ok: false, error: made.error });
      const a = made.adapter;
      const canvas = a.getCanvas();
      const px = canvas.getContext('2d').getImageData(5, 5, 1, 1).data;
      const out = {
        ok: true, w: a.imageWidth, h: a.imageHeight,
        canvasW: canvas.width, isRaster: a.isRaster,
        lonlat: a.coordsAreLonLat, proj: a.getProjectionCode(),
        samplePixelOpaque: px[3] === 255,
        mounted: !!document.getElementById('bnd15-raster-workspace'),
      };
      a.destroy();
      out.detached = !document.getElementById('bnd15-raster-workspace');
      resolve(out);
    };
    window.addEventListener('BND15_CAPTURE_RES', onRes);
    window.dispatchEvent(new CustomEvent('BND15_CAPTURE_REQ', { detail: { token } }));
    setTimeout(() => resolve({ ok: false, error: 'timed out' }), 20000);
  }));

  assert.strictEqual(info.ok, true, `workspace from capture failed: ${info.error}`);
  assert.ok(info.w > 400 && info.h > 300, `decoded ${info.w}x${info.h}, expected the viewport`);
  assert.strictEqual(info.canvasW, info.w, 'tracing reads the image at native resolution');
  assert.strictEqual(info.isRaster, true);
  assert.strictEqual(info.lonlat, false, 'pixels are not lon/lat');
  assert.strictEqual(info.proj, null, 'and no projection is claimed');
  assert.strictEqual(info.samplePixelOpaque, true, 'the bitmap must really be decoded');
  assert.strictEqual(info.mounted, true);
  assert.strictEqual(info.detached, true, 'destroy must clean up');
});

/* =====================================================================
 * AN ACTUAL PDF, in Chrome's own viewer
 *
 * The tests above prove captureVisibleTab returns real pixels. This proves the
 * specific case the feature exists for: a PDF, rendered by the internal PDFium
 * viewer whose pixels an extension cannot read, captured and turned into a
 * digitizable raster.
 *
 * A minimal single-page PDF is generated here rather than committed as a binary
 * fixture, so its contents are visible and adjustable: a coloured rectangle on
 * a page, standing in for a parcel on a cadastral sheet.
 * =================================================================== */

/* A PDF of `pageCount` pages, each carrying one filled rectangle in a colour
 * this suite can look for afterwards. Generated rather than committed as a
 * binary so its contents are visible and adjustable, and so the multi-page case
 * costs nothing to produce.
 *
 * Page colours are deliberately far apart in RGB: turning a page is verified by
 * counting pixels of the NEW page's colour and confirming the old page's colour
 * has gone, which only works if the two cannot be confused. */
const PDF_PAGE_COLOURS = [
  { pdf: '0.94 0.86 0.71', rgb: [240, 219, 181] },  // parcel buff
  { pdf: '0.20 0.40 0.85', rgb: [51, 102, 217] },   // blue
  { pdf: '0.15 0.65 0.30', rgb: [38, 166, 77] },    // green
];

function minimalPdf(pageCount) {
  const pages = Math.max(1, Math.min(Number(pageCount) || 1, PDF_PAGE_COLOURS.length));
  // Object numbering: 1 = catalog, 2 = pages tree, then a page + its content
  // stream per page, in pairs.
  const kids = [];
  const objs = ['', ''];   // filled in below, once the kid ids are known
  for (let i = 0; i < pages; i++) {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const colour = PDF_PAGE_COLOURS[i].pdf;
    const content = `${colour} rg\n60 50 280 200 re f\n0 0 0 RG 2 w\n60 50 280 200 re S\n`;
    objs[pageId - 1] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents ${contentId} 0 R/Resources<<>>>>`;
    objs[contentId - 1] = `<</Length ${content.length}>>\nstream\n${content}endstream`;
  }
  objs[0] = '<</Type/Catalog/Pages 2 0 R>>';
  objs[1] = `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

t('a real PDF in Chrome\'s viewer can be captured and digitized', async () => {
  const { sw } = await launch();
  // Served over HTTP for the same reason as the stub map: captureVisibleTab
  // needs a host permission that matches the tab, and <all_urls> does not
  // match file://. Chrome's PDFium viewer renders an http-served PDF exactly
  // as it renders a local one, which is the thing under test here.
  const base = await fixtureBase();
  served.set('/sheet.pdf', { body: Buffer.from(minimalPdf(), 'latin1'), type: 'application/pdf' });

  const page = await ctx.newPage();
  openPages.push(page);
  await page.goto(`${base}/sheet.pdf`);
  // PDFium needs a moment to lay out and paint the page.
  await page.waitForTimeout(3500);

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((x) => (x.url || '').endsWith('sheet.pdf'));
    return hit ? hit.id : null;
  });
  assert.ok(tabId, 'the PDF tab must be listable');

  // Capture straight from the worker, exactly as the relay does. The page world
  // is not used here because Chrome's PDF viewer is not a page we can inject
  // into — which is the entire reason this path exists.
  const shot = await sw.evaluate(async () => {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
      return { ok: true, len: dataUrl.length, prefix: dataUrl.slice(0, 22), dataUrl };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
  assert.strictEqual(shot.ok, true, `capturing a PDF failed: ${shot.error}`);
  assert.match(shot.prefix, /^data:image\/png;base64,/);
  assert.ok(shot.len > 5000, `capture looks too small: ${shot.len}`);

  // Now do what the extension does with it: decode, mount as a workspace, and
  // confirm the PDF's rectangle is actually present in the pixels.
  //
  // The helper page goes through openFixtureWithExtension rather than a hand
  // written lookup: by this point several fixture tabs are open, and matching on
  // URL activated the wrong one.
  const { page: helper } = await openFixtureWithExtension();

  const analysis = await helper.evaluate(async (dataUrl) => {
    const loaded = await window.BND_Raster.loadImageSource(document, dataUrl);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const made = window.BND_Raster.createRasterWorkspace({
      doc: document, win: window, Viewport: window.BND_Viewport,
      image: loaded.image, sourceName: 'sheet.pdf', sourceKind: 'capture',
    });
    if (!made.ok) return { ok: false, error: made.error };
    const a = made.adapter;
    const canvas = a.getCanvas();
    const ctx2 = canvas.getContext('2d');
    const img = ctx2.getImageData(0, 0, canvas.width, canvas.height);
    // Count pixels close to the rectangle's fill colour (240, 219, 181).
    let hits = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const dr = img.data[i] - 240, dg = img.data[i + 1] - 219, db = img.data[i + 2] - 181;
      if (dr * dr + dg * dg + db * db < 900) hits++;
    }
    const out = { ok: true, w: canvas.width, h: canvas.height, hits };
    a.destroy();
    return out;
  }, shot.dataUrl);

  assert.strictEqual(analysis.ok, true, `workspace from the PDF capture failed: ${analysis.error}`);
  assert.ok(analysis.w > 400 && analysis.h > 300, `decoded ${analysis.w}x${analysis.h}`);
  assert.ok(analysis.hits > 2000,
    `the PDF's rectangle should be present in the captured pixels; found only ${analysis.hits} ` +
    'matching pixels, which suggests the viewer had not painted yet');
});

/* =====================================================================
 * PDF IMPORT, THROUGH THE UI, RENDERED BY THE EXTENSION ITSELF
 *
 * The test above proves the capture fallback. This proves the primary path,
 * which is a different mechanism end to end: the operator picks the PDF file,
 * the service worker injects the vendored PDF.js into the page's own world, the
 * page renders one page to a canvas at tracing resolution, and that canvas is
 * handed to the SAME raster workspace an image import uses.
 *
 * Nothing here is stubbed. A real file chooser answers with a real PDF on disk,
 * PDF.js really parses it, and the assertions are made against the pixels that
 * came out the other end. Being able to select a file proves nothing on its own,
 * so the check that matters is the last one: the sheet's rectangle is present in
 * the workspace's pixels.
 * =================================================================== */

/* Count pixels close to an RGB triple in the workspace's display canvas.
 * Works because the render target is a canvas the extension drew into itself —
 * no cross-origin taint, so getImageData is readable. */
const COUNT_IN_WORKSPACE = (rgb) => {
  const c = document.querySelector('#bnd15-raster-workspace canvas');
  if (!c) return { ok: false, error: 'no workspace canvas' };
  const ctx2 = c.getContext('2d');
  const img = ctx2.getImageData(0, 0, c.width, c.height);
  let hits = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const dr = img.data[i] - rgb[0], dg = img.data[i + 1] - rgb[1], db = img.data[i + 2] - rgb[2];
    if (dr * dr + dg * dg + db * db < 1200) hits++;
  }
  return { ok: true, hits, w: c.width, h: c.height };
};

/* Pick a PDF through the extension's own Import menu, exactly as an operator
 * does. page_inject builds a real <input type="file"> and clicks it, so Chrome
 * raises a real chooser and Playwright answers it. */
async function importPdfThroughUi(page, pdfPath) {
  const chooser = page.waitForEvent('filechooser', { timeout: 20000 });
  await page.click('#bnd15-widget #btnImport');
  await page.click('#bnd15-widget #iPdf');
  (await chooser).setFiles(pdfPath);
  // Generous: this is where 1.4 MB of PDF.js is injected into the page world,
  // parsed, and asked to rasterise a page at 2400 px on its long edge.
  await page.waitForSelector('#bnd15-raster-workspace', { timeout: 45000 });
  // Waits for THIS file by name, not merely for a workspace to exist. A second
  // import lands on a page that already has one, so every generic condition is
  // already true and waiting on one would race the render it is meant to await.
  await page.waitForFunction(
    (n) => document.querySelector('#bnd15-widget').textContent.includes(n),
    path.basename(pdfPath), { timeout: 45000 });
}

/* Open the drawing section, where the page selector lives — but only if it is
 * closed. Whether it already is depends on which tests ran before this one:
 * the open/closed state is a persisted setting, and every test in this file
 * shares one browser profile. Toggling blindly would close it half the time. */
async function openDrawingSection(page) {
  const sel = '#bnd15-widget details[data-sect="drawing"]';
  await page.waitForSelector(sel, { timeout: 10000 });
  const isOpen = await page.$eval(sel, (el) => el.open);
  if (!isOpen) await page.click(`${sel} > summary`);
  await page.waitForSelector('#bnd15-widget #pdfNext', { state: 'visible', timeout: 10000 });
}

t('a picked PDF is rendered by the extension itself and reaches the raster workspace', async () => {
  if (!fs.existsSync(path.join(ROOT, 'vendor', 'pdf.min.js'))) {
    assert.fail('vendor/pdf.min.js is missing — the PDF renderer is not vendored in this checkout');
  }
  const { page } = await openFixtureWithExtension();
  const pdfPath = path.join(tmpRoot, 'parcel-sheet.pdf');
  fs.writeFileSync(pdfPath, Buffer.from(minimalPdf(1), 'latin1'));

  // Watched from here on, because "no CDN, works offline" is a claim the Chrome
  // Web Store submission makes in writing. PDF.js will fetch character maps and
  // standard font data if it is configured with URLs for them; it is not, and
  // this is how that stays true.
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));

  await importPdfThroughUi(page, pdfPath);

  assert.deepStrictEqual(requests, [],
    `importing a PDF must touch the network zero times; it made: ${requests.join(', ')}`);

  // The renderer really was injected into the PAGE's world by the worker. If it
  // had landed in the isolated world, page.evaluate would not see it — and the
  // import could not have worked at all.
  const hasPdfJs = await page.evaluate(() => typeof window.pdfjsLib);
  assert.strictEqual(hasPdfJs, 'object',
    'the service worker must inject vendor/pdf.min.js into the MAIN world');

  // Rendered at tracing resolution, not screen resolution: a 400x300 pt page
  // with a 2400 px target long edge is 2400x1800. This is the difference
  // between the real import and the capture fallback, so it is asserted exactly.
  const text = await page.textContent('#bnd15-widget');
  assert.match(text, /parcel-sheet\.pdf/, `the sheet name should be shown: ${text.slice(0, 400)}`);
  assert.match(text, /2400×1800 px/,
    `the page should be rendered at the target long edge, not at screen size: ${text.slice(0, 400)}`);

  // THE CHECK THAT MATTERS. Selecting a file proves nothing; these are the
  // PDF's own pixels, in the workspace, ready to trace.
  const buff = await page.evaluate(COUNT_IN_WORKSPACE, PDF_PAGE_COLOURS[0].rgb);
  assert.strictEqual(buff.ok, true, buff.error);
  assert.ok(buff.hits > 20000,
    `the PDF's parcel rectangle must be present in the workspace pixels; found ${buff.hits}`);

  // And the workspace is a workspace: coordinates are image pixels, and the
  // digitizing tools are live on it.
  assert.match(text, /image pixels/, 'the session must say its coordinates are pixels, not metres');
  const traceEnabled = await page.$eval('#bnd15-widget #mTrace', (el) => !el.disabled);
  assert.strictEqual(traceEnabled, true, 'the sheet must be digitizable once it is open');
});

/* A page carrying a plot number in Helvetica, which the file NAMES but does not
 * EMBED — one of the standard 14 fonts every PDF reader is expected to supply.
 * `withText: false` produces the identical page without the number, as a
 * control: the workspace letterboxes the sheet against a dark background, so a
 * raw count of dark pixels is mostly furniture. The difference between the two
 * is the glyphs and nothing else. */
function pdfWithPlotNumber(withText) {
  const content = '1 1 1 rg\n0 0 400 300 re f\n0 0 0 rg\n'
    + (withText ? 'BT /F1 48 Tf 40 130 Td (123/4) Tj ET\n' : '');
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

const COUNT_DARK_IN_WORKSPACE = () => {
  const c = document.querySelector('#bnd15-raster-workspace canvas');
  if (!c) return -1;
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let dark = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] > 200 && img.data[i] < 90 && img.data[i + 1] < 90 && img.data[i + 2] < 90) dark++;
  }
  return dark;
};

t('a plot number in a font the PDF names but does not embed still renders', async () => {
  // PDF.js can fetch character maps and standard font data from a URL, and this
  // extension configures neither — deliberately, since that would be a network
  // request. The question that leaves open is whether a sheet whose plot numbers
  // use one of the standard 14 fonts comes out blank, which for a cadastral
  // drawing would matter: the numbers are half of what is being read off it.
  //
  // It does not. Measured, rather than assumed, because the answer was not
  // obvious from the configuration.
  const { page } = await openFixtureWithExtension();
  const blank = path.join(tmpRoot, 'no-number.pdf');
  const numbered = path.join(tmpRoot, 'with-number.pdf');
  fs.writeFileSync(blank, Buffer.from(pdfWithPlotNumber(false), 'latin1'));
  fs.writeFileSync(numbered, Buffer.from(pdfWithPlotNumber(true), 'latin1'));

  await importPdfThroughUi(page, blank);
  const control = await page.evaluate(COUNT_DARK_IN_WORKSPACE);
  await importPdfThroughUi(page, numbered);
  const withText = await page.evaluate(COUNT_DARK_IN_WORKSPACE);

  assert.ok(control > 0 && withText > 0, 'both sheets must reach the workspace');
  assert.ok(withText - control > 2000,
    'a plot number set in a non-embedded standard font must be visible on the sheet; '
    + `only ${withText - control} pixels of ink appeared where the number should be, `
    + 'which means the text rendered blank and the number cannot be read');
});

t('turning a page of a multi-page PDF replaces the sheet and keeps the digitised parcels', async () => {
  const { page } = await openFixtureWithExtension();
  const pdfPath = path.join(tmpRoot, 'three-page-sheet.pdf');
  fs.writeFileSync(pdfPath, Buffer.from(minimalPdf(3), 'latin1'));

  await importPdfThroughUi(page, pdfPath);

  const text = await page.textContent('#bnd15-widget');
  assert.match(text, /PDF page 1 of 3/, `the page selector should appear for a multi-page PDF: ${text.slice(0, 400)}`);

  // Digitize a parcel on page 1. Drawn rather than colour-traced so the shape is
  // deterministic: what is under test here is that it SURVIVES, not how it was
  // made. The clicks stay in the left half of the viewport, clear of the widget
  // panel, which sits bottom-right.
  await page.click('#bnd15-widget #mDraw');
  for (const [x, y] of [[200, 200], [500, 200], [500, 500], [200, 500]]) {
    await page.mouse.click(x, y);
  }
  await page.click('#bnd15-widget #dFinish');
  await page.waitForFunction(
    () => /Shape 1/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 15000 });

  const before = await page.evaluate(() => {
    const m = document.querySelector('#bnd15-widget').textContent.match(/Shape 1 · (\d+)v/);
    return m ? m[1] : null;
  });
  assert.strictEqual(before, '4', 'the drawn parcel should have four corners');

  // The page selector lives inside the drawing section, which is collapsed
  // until asked for. Real Chrome will not click through a closed <details>.
  await openDrawingSection(page);

  // Turn the page.
  await page.click('#bnd15-widget #pdfNext');
  await page.waitForFunction(
    () => /PDF page 2 of 3/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 30000 });

  // The sheet underneath really changed: page 2's blue rectangle is there and
  // page 1's buff one has gone.
  // Exactly one workspace, not two stacked on top of each other. A replaced
  // sheet is destroyed rather than left behind the new one — id collisions are
  // invisible until something reads the wrong canvas.
  const containers = await page.$$eval('[id="bnd15-raster-workspace"]', (els) => els.length);
  assert.strictEqual(containers, 1, 'turning a page must replace the sheet, not stack another on it');

  const blue = await page.evaluate(COUNT_IN_WORKSPACE, PDF_PAGE_COLOURS[1].rgb);
  const oldBuff = await page.evaluate(COUNT_IN_WORKSPACE, PDF_PAGE_COLOURS[0].rgb);
  assert.ok(blue.hits > 20000, `page 2's rectangle should now be on screen; found ${blue.hits}`);
  assert.ok(oldBuff.hits < 500, `page 1's rectangle should be gone; ${oldBuff.hits} pixels remain`);

  // And what the operator drew is untouched. This is the whole point of
  // preserveSession: the picture is the sheet, the parcels are their work.
  const after = await page.textContent('#bnd15-widget');
  assert.match(after, /Shape 1 · 4v/,
    `the digitised parcel must survive a page turn: ${after.slice(0, 400)}`);
  assert.match(after, /three-page-sheet\.pdf — page 2 of 3/,
    'the sheet label should name the page being digitised');
});

t('a PDF import that fails leaves the sheet already open exactly as it was', async () => {
  const { page } = await openFixtureWithExtension();
  const good = path.join(tmpRoot, 'good-sheet.pdf');
  fs.writeFileSync(good, Buffer.from(minimalPdf(3), 'latin1'));
  await importPdfThroughUi(page, good);
  await openDrawingSection(page);
  assert.match(await page.textContent('#bnd15-widget'), /PDF page 1 of 3/);

  // A portal answering a download with its login page, saved as .pdf. The
  // realistic version of "that file is not what it says it is".
  const bad = path.join(tmpRoot, 'not-really.pdf');
  fs.writeFileSync(bad, '<!DOCTYPE html><html><body>Session expired</body></html>');

  const chooser = page.waitForEvent('filechooser', { timeout: 20000 });
  await page.click('#bnd15-widget #btnImport');
  await page.click('#bnd15-widget #iPdf');
  (await chooser).setFiles(bad);

  await page.waitForFunction(
    () => /is not a PDF/.test((document.getElementById('bnd15-toasts') || {}).textContent || ''),
    null, { timeout: 20000 });

  // The refusal must cost the operator nothing. A failed import that quietly
  // destroyed the document already open would leave the sheet on screen with
  // its page selector gone — the picture still there, the navigation not.
  await openDrawingSection(page);
  const text = await page.textContent('#bnd15-widget');
  assert.match(text, /PDF page 1 of 3/,
    `the open document must survive a failed import: ${text.slice(0, 400)}`);
  assert.match(text, /good-sheet\.pdf/, 'the sheet on screen is still the good one');

  // And it is still a live document, not just a stale label: it can be paged.
  await page.click('#bnd15-widget #pdfNext');
  await page.waitForFunction(
    () => /PDF page 2 of 3/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 30000 });
  const blue = await page.evaluate(COUNT_IN_WORKSPACE, PDF_PAGE_COLOURS[1].rgb);
  assert.ok(blue.hits > 20000,
    `page 2 must still render after the failed import; found ${blue.hits} pixels`);
});

t('importing repeatedly replaces the sheet each time and leaves nothing behind', async () => {
  const { page } = await openFixtureWithExtension();

  const three = path.join(tmpRoot, 'repeat-three.pdf');
  const one = path.join(tmpRoot, 'repeat-one.pdf');
  fs.writeFileSync(three, Buffer.from(minimalPdf(3), 'latin1'));
  fs.writeFileSync(one, Buffer.from(minimalPdf(1), 'latin1'));

  await importPdfThroughUi(page, three);
  assert.match(await page.textContent('#bnd15-widget'), /PDF page 1 of 3/);

  // A second PDF over the first. The page selector must describe the document
  // that is actually open, not the one that was.
  await importPdfThroughUi(page, one);
  const afterSecond = await page.textContent('#bnd15-widget');
  assert.match(afterSecond, /repeat-one\.pdf/, 'the second file is the one on screen');
  assert.ok(!/PDF page 1 of 3/.test(afterSecond),
    `a single-page PDF must not inherit the previous document's page selector: ${afterSecond.slice(0, 400)}`);

  // Then an image over the PDF. The selector must go entirely — there is no
  // document to page through any more.
  const png = path.join(tmpRoot, 'sheet.png');
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAV0lEQVR4nO3BAQ0AAADCoPdPbQ8H'
    + 'FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    + 'AAAAAAAAAAAA8G1gAAABmmDvyAAAAABJRU5ErkJggg==', 'base64'));

  const chooser = page.waitForEvent('filechooser', { timeout: 20000 });
  await page.click('#bnd15-widget #btnImport');
  await page.click('#bnd15-widget #iImage');
  (await chooser).setFiles(png);
  await page.waitForFunction(
    () => /sheet\.png/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 30000 });

  const afterImage = await page.textContent('#bnd15-widget');
  assert.ok(!/PDF page/.test(afterImage),
    `an image replacing a PDF must retire the page selector: ${afterImage.slice(0, 400)}`);

  // Three imports, one workspace. Each mount destroys its predecessor rather
  // than stacking another element with the same id on top of it.
  const containers = await page.$$eval('[id="bnd15-raster-workspace"]', (els) => els.length);
  assert.strictEqual(containers, 1, `three imports left ${containers} workspaces behind`);
});

/* =====================================================================
 * A PROTECTED (CROSS-ORIGIN TAINTED) MAP CANVAS
 *
 * Reported from the field on a state cadastral portal: the basemap is served
 * from another origin, which taints the map canvas, so getImageData throws and
 * colour tracing had nothing to read. The extension used to stop there and tell
 * the operator to draw two hundred plots by hand.
 *
 * The taint here is REAL, not simulated: a second HTTP server on a different
 * port serves an image, the fixture draws it onto its canvas, and Chrome marks
 * the canvas origin-unclean exactly as a portal's basemap does. Nothing about
 * browser security is weakened to get past it — the extension captures a raster
 * it owns and traces that instead.
 * =================================================================== */

let taintServer = null, taintOrigin = null;

/* A different ORIGIN, which on the same host means a different port. */
async function taintedOrigin() {
  if (taintOrigin) return taintOrigin;
  // A 2x2 PNG. Its content does not matter; drawing it is what taints.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8//8/AzJgYkAD'
    + 'IxcAAP//AwwBBQAA//8DDAEFAAAAAElFTkSuQmCC', 'base64');
  taintServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });
  await new Promise((resolve) => taintServer.listen(0, '127.0.0.1', resolve));
  taintServer.unref();
  taintOrigin = `http://127.0.0.1:${taintServer.address().port}`;
  return taintOrigin;
}

t('a cross-origin protected map is traced through a captured raster, not refused', async () => {
  const { page } = await openFixtureWithExtension();
  const other = await taintedOrigin();

  // Taint the fixture's canvas for real, and confirm it: a test that silently
  // failed to taint would pass while proving nothing.
  const tainted = await page.evaluate(async (origin) => {
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = reject;
      img.src = `${origin}/pixel.png?${Date.now()}`;
    });
    // Stretched over one corner so the parcels underneath stay traceable.
    ctx.drawImage(img, 0, 0, 20, 20);
    try { ctx.getImageData(0, 0, 2, 2); return false; } catch (e) { return true; }
  }, other);
  assert.strictEqual(tainted, true, 'the fixture canvas must actually be origin-unclean for this test to mean anything');

  // Now trace, exactly as an operator does.
  await page.click('#bnd15-widget #mTrace');
  const box = await page.evaluate(() => window.__PARCELS__[0]);
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.mouse.click(rect.left + box.x + box.w / 2, rect.top + box.y + box.h / 2);

  await page.waitForFunction(
    () => /Shape 1/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 30000 });

  const text = await page.textContent('#bnd15-widget');
  assert.ok(!/use Draw instead/.test(text),
    `a protected canvas must no longer end in a refusal: ${text.slice(0, 300)}`);

  // The geometry must be RIGHT, not merely present. The captured raster is at
  // device pixels over the whole viewport; if that mapping back to map
  // coordinates were wrong, the parcel would still appear but in the wrong
  // place and the wrong size. The fixture paints a 300x200 px parcel whose
  // ground area is known, so the area is the check.
  const m = text.match(/Shape 1 · (\d+)v · (\d+) m²/);
  assert.ok(m, `the traced shape should report vertices and an area: ${text.slice(0, 300)}`);
  const area = Number(m[2]);
  assert.ok(area > 15000 * 0.9 && area < 15000 * 1.1,
    `traced through the capture the parcel should still measure ~15,000 m²; got ${area}`);
});

/* =====================================================================
 * BADGE BRIDGE
 * =================================================================== */

t('the shape count reaches the toolbar badge across worlds', async () => {
  const { sw, page, tabId } = await openFixtureWithExtension();
  await page.click('#bnd15-widget #mTrace');
  await page.waitForTimeout(200);
  const box = await page.evaluate(() => window.__PARCELS__[0]);
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.mouse.click(rect.left + box.x + box.w / 2, rect.top + box.y + box.h / 2);
  await page.waitForFunction(
    () => /Shape 1/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const badge = await sw.evaluate(async (id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  assert.strictEqual(badge, '1',
    'the page world reports the count as a DOM event, content.js relays it, the worker sets the badge');
});

/* =====================================================================
 * EXPORT, in a real browser
 * =================================================================== */

t('an export produces a real download in Chrome', async () => {
  const { page } = await openFixtureWithExtension();
  await page.click('#bnd15-widget #mTrace');
  await page.waitForTimeout(200);
  const box = await page.evaluate(() => window.__PARCELS__[0]);
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.mouse.click(rect.left + box.x + box.w / 2, rect.top + box.y + box.h / 2);
  await page.waitForFunction(
    () => /Shape 1/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 15000 });

  // Export lives behind the Export ▾ menu since 17.0, so a real browser has to
  // open it first — this is the one suite that enforces genuine visibility,
  // because jsdom has no layout and will happily click a hidden button.
  await page.click('#bnd15-widget #btnExport');
  await page.waitForSelector('#bnd15-widget #menuExport.open', { timeout: 5000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#bnd15-widget #xGeo'),
  ]);
  assert.match(download.suggestedFilename(), /\.geojson$/);

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const gj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.strictEqual(gj.type, 'FeatureCollection');
  assert.strictEqual(gj.features.length, 1);
  const ring = gj.features[0].geometry.coordinates[0];
  // Real coordinates, in Jharkhand, from a real trace.
  for (const p of ring) {
    assert.ok(p[0] > 84 && p[0] < 90, `lon ${p[0]} should be in Jharkhand`);
    assert.ok(p[1] > 21 && p[1] < 26, `lat ${p[1]} should be in Jharkhand`);
  }
});

/* =====================================================================
 * THE PERMISSION MODEL, verified negatively
 *
 * Every test above grants host access up front so injection can be driven
 * without a toolbar click. That leaves an obvious question: does the shipped
 * extension actually depend on the activeTab grant, or does it quietly hold
 * broader access?
 *
 * This loads the extension EXACTLY as shipped — no host_permissions — and
 * confirms injection is refused. That is the permission model working: nothing
 * happens until the user invokes the extension on a tab. Producing the grant
 * itself needs a real click on the toolbar button, which headless Chrome cannot
 * do, so that final step remains a manual check.
 * =================================================================== */

t('as shipped, injection is refused until the user invokes the extension', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-perm-'));
  const ext = path.join(dir, 'ext');
  fs.mkdirSync(ext, { recursive: true });
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(ext, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(ext, rel));
  };
  // Verbatim copy — the manifest is NOT modified this time.
  for (const f of ['manifest.json', 'background.js', 'content.js', 'page_inject.js',
    'popup.html', 'popup.js', 'icon16.png', 'icon48.png', 'icon128.png']) copy(f);
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) copy(path.join('lib', f));

  const shipped = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  assert.strictEqual(shipped.host_permissions, undefined,
    'the shipped manifest must not request standing host access');

  let localCtx = null;
  try {
    localCtx = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
      executablePath: CHROME,
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
        '--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 900, height: 700 },
    });
    allContexts.push(localCtx);
    let [sw] = localCtx.serviceWorkers();
    if (!sw) sw = await localCtx.waitForEvent('serviceworker', { timeout: 20000 });

    const page = await localCtx.newPage();
    await page.goto(await fixtureUrl());
    await page.waitForFunction(() => !!window.map, null, { timeout: 10000 });

    // A stronger confirmation than expected: with no host access the extension
    // cannot even read tab URLs. Chrome withholds them, so the tab has to be
    // identified by id alone.
    const survey = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return {
        count: tabs.length,
        anyUrlVisible: tabs.some((x) => !!x.url),
        activeId: (tabs.find((x) => x.active) || tabs[tabs.length - 1] || {}).id || null,
      };
    });
    assert.strictEqual(survey.anyUrlVisible, false,
      'without host access the extension must not be able to read any tab URL');
    const tabId = survey.activeId;
    assert.ok(tabId, 'a tab id should still be enumerable');

    const attempt = await sw.evaluate(async (id) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'], world: 'ISOLATED' });
        return { injected: true };
      } catch (e) {
        return { injected: false, error: String(e && e.message) };
      }
    }, tabId);

    assert.strictEqual(attempt.injected, false,
      'without a user gesture the extension must have no access to the page');
    assert.match(attempt.error || '', /Cannot access|permission|host/i,
      `expected a permission error, got: ${attempt.error}`);
    // And nothing should have been injected into the page.
    assert.strictEqual(await page.evaluate(() => typeof window.BND_Crs), 'undefined',
      'no libraries should have reached the page');
  } finally {
    if (localCtx) { try { await localCtx.close(); } catch (e) { /* ignore */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

/* =====================================================================
 * NO CONSOLE ERRORS
 * =================================================================== */

t('a full session raises no page or worker errors', async () => {
  const { page } = await openFixtureWithExtension();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.click('#bnd15-widget #mTrace');
  await page.waitForTimeout(150);
  const box = await page.evaluate(() => window.__PARCELS__[0]);
  const rect = await page.$eval('#map', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.mouse.click(rect.left + box.x + box.w / 2, rect.top + box.y + box.h / 2);
  await page.waitForFunction(
    () => /Shape 1/.test(document.querySelector('#bnd15-widget').textContent),
    null, { timeout: 15000 });

  // Control points: nominate a vertex, then capture its true position.
  await page.click('#bnd15-widget #mGcp');
  await page.waitForTimeout(150);
  await page.mouse.click(rect.left + box.x, rect.top + box.y);
  await page.waitForTimeout(400);
  await page.mouse.click(rect.left + box.x + 30, rect.top + box.y);
  await page.waitForTimeout(400);

  const text = await page.textContent('#bnd15-widget');
  assert.match(text, /1 active/, `a control point should exist: ${text.slice(0, 300)}`);

  // Clean-up and report. The section collapses since 17.0, so it is expanded
  // the way an operator would — by its summary — rather than by reaching past
  // the UI to the buttons inside it.
  await page.click('#bnd15-widget details.sect[data-sect="cleanup"] > summary');
  await page.waitForSelector('#bnd15-widget details.sect[data-sect="cleanup"][open]', { timeout: 5000 });
  await page.click('#bnd15-widget #regAll');
  await page.waitForTimeout(500);
  await page.click('#bnd15-widget #qual');
  await page.waitForTimeout(500);

  const real = errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/i.test(e));
  assert.deepStrictEqual(real, [], `unexpected errors: ${real.join(' | ')}`);
});
