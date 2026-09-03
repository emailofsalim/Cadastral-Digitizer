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

const CHROME = ['/usr/local/bin/chrome', '/opt/playwright/chromium-1232/chrome-linux64/chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

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
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    sharedSw = sw;
    allContexts.push(ctx);
    return { ctx, sw, extId: new URL(sw.url()).host };
  })();
  return launching;
}

/* Every launched context is tracked, because more than one is created — the
 * permission test deliberately runs a second, differently-configured browser.
 * Missing one leaves an orphaned Chrome holding a temp profile.
 *
 * The runner needs --test-force-exit for this file: Playwright keeps handles
 * open that stop Node's loop draining, so the process would otherwise sit
 * forever after the last test passes. `after` therefore has to be prompt.
 */
const allContexts = [];

after(async () => {
  await Promise.all(allContexts.map(async (c) => {
    try { await c.close(); } catch (e) { /* already gone */ }
  }));
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

const FIXTURE = 'file://' + path.join(ROOT, 'test', 'fixtures', 'stub-map.html');

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
  await page.goto(FIXTURE);
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

function minimalPdf() {
  // A parcel-coloured rectangle (RGB 0.94, 0.86, 0.71) on a 400x300 page.
  const content = '0.94 0.86 0.71 rg\n60 50 280 200 re f\n0 0 0 RG 2 w\n60 50 280 200 re S\n';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents 4 0 R/Resources<<>>>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
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

t('a real PDF in Chrome\'s viewer can be captured and digitized', async () => {
  const { sw } = await launch();
  const pdfPath = path.join(tmpRoot, 'sheet.pdf');
  fs.writeFileSync(pdfPath, minimalPdf(), 'latin1');

  const page = await ctx.newPage();
  openPages.push(page);
  await page.goto('file://' + pdfPath);
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
    await page.goto(FIXTURE);
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

  // Clean-up and report.
  await page.click('#bnd15-widget #regAll');
  await page.waitForTimeout(500);
  await page.click('#bnd15-widget #qual');
  await page.waitForTimeout(500);

  const real = errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/i.test(e));
  assert.deepStrictEqual(real, [], `unexpected errors: ${real.join(' | ')}`);
});
