/* =========================================================================
 * Tests for lib/raster_workspace.js
 *
 * The whole justification for the adapter layer is that a completely different
 * kind of source can be added without touching anything downstream. So the
 * central test here is a CONTRACT test: the raster adapter must expose the same
 * surface, with the same semantics, as the live-map adapters — and a traced
 * boundary must come back in image coordinates that match what was painted.
 *
 * The DOM is stubbed. That is enough to exercise every coordinate path, which is
 * where the bugs live; it does not exercise real rendering.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/raster_workspace.js');
const V = require('../lib/viewport.js');
const A = require('../lib/site_adapters.js');
const Tracer = require('../lib/tracer.js');

/* ---------------------------------------------------------------------
 * Minimal DOM stub. The workspace container sits at a non-zero page offset so
 * that any forgotten bounding-rect correction shows up.
 * ------------------------------------------------------------------- */
const RECT = { left: 40, top: 25, width: 800, height: 600 };

function makeCtx(store) {
  return {
    setTransform() {}, clearRect() {}, fillRect() {},
    drawImage(...args) { store.draws.push(args); },
    getImageData(x, y, w, h) {
      // Serve from the synthetic image the test installed.
      return { data: store.pixels(x, y, w, h), width: w, height: h };
    },
    set imageSmoothingEnabled(v) { store.smoothing = v; },
    get imageSmoothingEnabled() { return store.smoothing; },
    set fillStyle(v) { store.fillStyle = v; },
    get fillStyle() { return store.fillStyle; },
  };
}

function makeDoc(store) {
  const body = { children: [], appendChild(el) { this.children.push(el); el.parentNode = body; }, removeChild(el) { const i = this.children.indexOf(el); if (i >= 0) this.children.splice(i, 1); } };
  return {
    body,
    images: [],
    contentType: 'image/png',
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        style: {}, children: [],
        width: 0, height: 0, clientWidth: 0, clientHeight: 0,
        _listeners: {},
        setAttribute(k, v) { if (k === 'style') el.style.cssText = v; else el[k] = v; },
        appendChild(c) { el.children.push(c); c.parentNode = el; },
        removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
        addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
        removeEventListener(t, fn) { el._listeners[t] = (el._listeners[t] || []).filter((f) => f !== fn); },
        getBoundingClientRect: () => ({ ...RECT, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height }),
        getContext: () => makeCtx(store),
        querySelector: () => null,
        emit(t, e) { (el._listeners[t] || []).forEach((f) => f(e)); },
      };
      if (el.tagName === 'DIV') { el.clientWidth = RECT.width; el.clientHeight = RECT.height; }
      return el;
    },
    querySelector: () => null,
  };
}

function makeWin() {
  const listeners = {};
  return {
    devicePixelRatio: 1,
    innerWidth: RECT.width, innerHeight: RECT.height,
    location: { href: 'https://example.gov.in/sheet.png', origin: 'https://example.gov.in' },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    emit(t, e) { (listeners[t] || []).forEach((f) => f(e)); },
  };
}

/* A synthetic "scanned sheet": pale parcel inside a dark boundary. */
const IMG_W = 400, IMG_H = 300;
const PARCEL_PX = { x: 80, y: 60, w: 160, h: 120 };
const PARCEL = { r: 240, g: 220, b: 180 };
const WALL = { r: 20, g: 20, b: 20 };
const PAGE = { r: 250, g: 250, b: 250 };

function sheetPixels(x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gx = x0 + i, gy = y0 + j;
      const inParcel = gx >= PARCEL_PX.x && gx < PARCEL_PX.x + PARCEL_PX.w &&
                       gy >= PARCEL_PX.y && gy < PARCEL_PX.y + PARCEL_PX.h;
      const onWall = !inParcel &&
        gx >= PARCEL_PX.x - 2 && gx < PARCEL_PX.x + PARCEL_PX.w + 2 &&
        gy >= PARCEL_PX.y - 2 && gy < PARCEL_PX.y + PARCEL_PX.h + 2;
      const c = inParcel ? PARCEL : (onWall ? WALL : PAGE);
      const k = (j * w + i) * 4;
      out[k] = c.r; out[k + 1] = c.g; out[k + 2] = c.b; out[k + 3] = 255;
    }
  }
  return out;
}

function makeWorkspace(extra) {
  const store = { draws: [], pixels: sheetPixels, smoothing: null };
  const doc = makeDoc(store);
  const win = makeWin();
  const res = R.createRasterWorkspace(Object.assign({
    doc, win, Viewport: V,
    image: { width: IMG_W, height: IMG_H, drawable: { __image: true } },
    sourceName: 'sheet.png', sourceKind: 'file',
  }, extra));
  return { res, doc, win, store };
}

/* =====================================================================
 * CONSTRUCTION
 * =================================================================== */

test('the workspace mounts and reports its source', () => {
  const { res, doc } = makeWorkspace();
  assert.strictEqual(res.ok, true, res.error);
  const a = res.adapter;
  assert.strictEqual(a.id, 'raster');
  assert.strictEqual(a.isRaster, true);
  assert.strictEqual(a.imageWidth, IMG_W);
  assert.strictEqual(a.imageHeight, IMG_H);
  assert.match(a.label, /Image workspace/);
  assert.strictEqual(doc.body.children.length, 1, 'the container should be attached');
  a.destroy();
  assert.strictEqual(doc.body.children.length, 0, 'destroy must detach it');
});

test('construction refuses an unusable image instead of half-working', () => {
  const doc = makeDoc({ draws: [], pixels: sheetPixels });
  const win = makeWin();
  for (const img of [null, { width: 0, height: 10 }, { width: 10, height: 0 }, {}]) {
    const r = R.createRasterWorkspace({ doc, win, Viewport: V, image: img });
    assert.strictEqual(r.ok, false, `image ${JSON.stringify(img)} should be refused`);
    assert.match(r.error, /dimensions/);
  }
  const noVp = R.createRasterWorkspace({ doc, win, Viewport: null, image: { width: 10, height: 10 } });
  assert.strictEqual(noVp.ok, false);
  assert.match(noVp.error, /viewport/);
});

/* =====================================================================
 * THE ADAPTER CONTRACT
 * =================================================================== */

test('the raster adapter exposes the same surface as a live-map adapter', () => {
  // Build a real OpenLayers adapter and compare surfaces, so this test tracks
  // the contract automatically rather than restating a hand-written list.
  const olMap = {
    getCoordinateFromPixel: ([px, py]) => [px, py],
    getPixelFromCoordinate: ([x, y]) => [x, y],
    getView: () => ({
      getZoom: () => 18, setZoom() {}, getCenter: () => [0, 0], setCenter() {},
      getMinZoom: () => 0, getMaxZoom: () => 24, setMinZoom() {}, setMaxZoom() {},
      getResolution: () => 1, getProjection: () => ({ getCode: () => 'EPSG:3857' }),
    }),
    getViewport: () => ({
      getBoundingClientRect: () => ({ ...RECT }),
      querySelector: () => ({ width: 800, height: 600, clientWidth: 800 }),
    }),
    getLayers: () => ({ getArray: () => [] }),
    on() {}, un() {},
  };
  const win = makeWin();
  const olRes = A.createAdapter({ map: olMap, location: win.location, document: { body: { innerText: '' } }, performance: { getEntriesByType: () => [] } }, {});
  assert.strictEqual(olRes.ok, true, olRes.error);

  const { res } = makeWorkspace();
  const raster = res.adapter;

  const required = Object.keys(olRes.adapter).filter((k) => typeof olRes.adapter[k] === 'function');
  const missing = required.filter((k) => typeof raster[k] !== 'function');
  assert.deepStrictEqual(missing, [],
    `the raster adapter must implement every method a map adapter does; missing: ${missing.join(', ')}`);

  for (const k of ['coordsAreLonLat', 'label', 'portal']) {
    assert.ok(k in raster, `missing property ${k}`);
  }
  res.adapter.destroy();
});

test('raster coordinates are declared as pixels, not lon/lat', () => {
  const { res } = makeWorkspace();
  // Claiming otherwise would let the CRS layer conclude something false.
  assert.strictEqual(res.adapter.coordsAreLonLat, false);
  assert.strictEqual(res.adapter.getProjectionCode(), null);
  res.adapter.destroy();
});

/* =====================================================================
 * COORDINATES — including the container offset
 * =================================================================== */

test('client coordinates convert through the container offset', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  a.fitToView();
  // Tapping the exact middle of the container must give the image centre.
  const mid = a.clientToMapCoord(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);
  assert.ok(Math.abs(mid[0] - IMG_W / 2) < 1e-6, `x ${mid[0]}`);
  assert.ok(Math.abs(mid[1] - IMG_H / 2) < 1e-6, `y ${mid[1]}`);
  // A version that ignored the offset would be displaced by (40, 25) screen px.
  const naive = a.viewport.toImage(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);
  assert.ok(Math.hypot(naive[0] - mid[0], naive[1] - mid[1]) > 1,
    'the offset must actually matter in this fixture, or the test proves nothing');
  a.destroy();
});

test('client <-> image round-trips at several zooms', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  for (const z of [-1, 0, 1, 2]) {
    a.setZoom(z);
    for (const [cx, cy] of [[100, 100], [400, 300], [700, 500]]) {
      const img = a.clientToMapCoord(cx, cy);
      const back = a.mapCoordToClient(img[0], img[1]);
      assert.ok(Math.abs(back[0] - cx) < 1e-6, `zoom ${z}: x ${cx} -> ${back[0]}`);
      assert.ok(Math.abs(back[1] - cy) < 1e-6, `zoom ${z}: y ${cy} -> ${back[1]}`);
    }
  }
  a.destroy();
});

test('canvas pixels are image pixels, since the canvas is the image', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  a.setZoom(0);
  const client = [RECT.left + 321, RECT.top + 234];
  assert.deepStrictEqual(
    a.clientToCanvasPixel(client[0], client[1]),
    a.clientToMapCoord(client[0], client[1]),
    'no density ratio applies here — the offscreen canvas is at native resolution');
  a.destroy();
});

test('the full-resolution canvas is the image size, whatever the display zoom', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  a.setZoom(-2);
  const c1 = a.getCanvas();
  assert.strictEqual(c1.width, IMG_W);
  assert.strictEqual(c1.height, IMG_H);
  a.setZoom(3);
  const c2 = a.getCanvas();
  assert.strictEqual(c2, c1, 'it should be built once and reused');
  assert.strictEqual(c2.width, IMG_W, 'tracing always sees native resolution');
  a.destroy();
});

test('zoom and centre behave like a map adapter', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  // Zoom 2 puts the image (400x300 at scale 4 = 1600x1200) larger than the
  // 800x600 view, so it is pannable. At zoom 1 it exactly fills the view and is
  // deliberately pinned — see the next test.
  a.setZoom(2);
  assert.ok(Math.abs(a.getZoom() - 2) < 1e-9);
  a.setCenter([100, 90]);
  const c = a.getCenter();
  assert.ok(Math.abs(c[0] - 100) < 1e-6 && Math.abs(c[1] - 90) < 1e-6, `centre ${c}`);
  assert.ok(a.getMaxZoom() > a.getMinZoom());
  a.destroy();
});

test('an image smaller than the view is pinned centred, and cannot drift', () => {
  // This is intentional, and it is why zoom-about-cursor does not apply while
  // the whole sheet fits on screen: letting a small image wander off-centre as
  // you zoom feels broken, so clamping deliberately wins over cursor pinning.
  const { res } = makeWorkspace();
  const a = res.adapter;
  a.setZoom(0);                       // scale 1: 400x300 inside 800x600
  a.setCenter([10, 10]);
  const c = a.getCenter();
  assert.ok(Math.abs(c[0] - IMG_W / 2) < 1e-6 && Math.abs(c[1] - IMG_H / 2) < 1e-6,
    `a smaller-than-view image must stay centred, got ${c}`);
  a.destroy();
});

/* =====================================================================
 * RENDERING AND EVENTS
 * =================================================================== */

test('render subscription fires and unsubscribes cleanly', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  let n = 0;
  const off = a.onRender(() => { n++; });
  a.redraw();
  a.redraw();
  assert.strictEqual(n, 2);
  off();
  a.redraw();
  assert.strictEqual(n, 2, 'no callbacks after unsubscribe');
  a.destroy();
});

test('waitForRender resolves immediately — nothing to load', async () => {
  const { res } = makeWorkspace();
  await res.adapter.waitForRender(5000);
  res.adapter.destroy();
});

test('wheel zooms about the cursor and does not scroll the page', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  // Zoomed in far enough that the image exceeds the view, so cursor pinning is
  // the active behaviour rather than centre clamping.
  a.setZoom(3);
  const container = a.getContainer();
  const before = a.clientToMapCoord(RECT.left + 200, RECT.top + 150);
  let prevented = false;
  container.emit('wheel', { deltaY: -100, clientX: RECT.left + 200, clientY: RECT.top + 150, preventDefault() { prevented = true; } });
  assert.ok(prevented, 'the page must not scroll behind the workspace');
  assert.ok(a.getZoom() > 0, 'wheel up should zoom in');
  const after = a.clientToMapCoord(RECT.left + 200, RECT.top + 150);
  assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1e-6,
    'the image point under the cursor must stay put');
  a.destroy();
});

test('dragging pans, and pointer listeners are removed on destroy', () => {
  const { res, win } = makeWorkspace();
  const a = res.adapter;
  a.setZoom(3);   // larger than the view, so panning is meaningful
  const c0 = a.getCenter();
  a.getContainer().emit('pointerdown', { button: 0, clientX: 300, clientY: 300 });
  win.emit('pointermove', { clientX: 340, clientY: 300 });
  win.emit('pointerup', {});
  const c1 = a.getCenter();
  assert.ok(Math.abs(c1[0] - c0[0]) > 1e-6, 'dragging should have panned');

  a.destroy();
  const cBefore = a.getCenter();
  win.emit('pointermove', { clientX: 900, clientY: 900 });
  assert.deepStrictEqual(a.getCenter(), cBefore, 'destroyed workspace must not still react');
});

test('magnified display disables smoothing so pixels stay honest', () => {
  const { res, store } = makeWorkspace();
  const a = res.adapter;
  a.setZoom(2);          // scale 4, magnifying
  assert.strictEqual(store.smoothing, false,
    'interpolated colour would invite clicking on pixels that do not exist');
  a.setZoom(-2);         // scale 0.25, decimating
  assert.strictEqual(store.smoothing, true);
  a.destroy();
});

/* =====================================================================
 * END TO END: trace the sheet through the adapter
 * =================================================================== */

test('a parcel painted in the image traces back to the right image coordinates', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  const canvas = a.getCanvas();
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const raster = { data: img.data, width: img.width, height: img.height };

  const out = Tracer.traceRegion(raster,
    PARCEL_PX.x + PARCEL_PX.w / 2, PARCEL_PX.y + PARCEL_PX.h / 2,
    { submode: 'fill', colorTolerance: 30, leakProtectionRadius: 0, edgeGrowthRadius: 0, simplifyPx: 1.5 });
  assert.strictEqual(out.ok, true, out.reason);
  assert.ok(out.points.length >= 4 && out.points.length <= 8, `got ${out.points.length} corners`);

  const xs = out.points.map((p) => p[0]);
  const ys = out.points.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= PARCEL_PX.x - 2 && Math.min(...xs) <= PARCEL_PX.x + 2, `xmin ${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) >= PARCEL_PX.x + PARCEL_PX.w - 3 && Math.max(...xs) <= PARCEL_PX.x + PARCEL_PX.w + 1, `xmax ${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) >= PARCEL_PX.y - 2 && Math.min(...ys) <= PARCEL_PX.y + 2, `ymin ${Math.min(...ys)}`);
  a.destroy();
});

test('traced image pixels convert to screen and back through the adapter', () => {
  const { res } = makeWorkspace();
  const a = res.adapter;
  // Setters mirror the map adapters and return nothing, so they are called
  // separately rather than chained.
  a.setZoom(1);
  a.setCenter([200, 150]);
  const corners = [[PARCEL_PX.x, PARCEL_PX.y], [PARCEL_PX.x + PARCEL_PX.w, PARCEL_PX.y + PARCEL_PX.h]];
  for (const c of corners) {
    const client = a.mapCoordToClient(c[0], c[1]);
    const back = a.clientToMapCoord(client[0], client[1]);
    assert.ok(Math.abs(back[0] - c[0]) < 1e-6 && Math.abs(back[1] - c[1]) < 1e-6,
      `corner ${c} round-tripped to ${back}`);
  }
  a.destroy();
});

/* =====================================================================
 * PAGE IMAGE / PDF DISCOVERY
 * =================================================================== */

test('page images are found, largest first, with tiny ones ignored', () => {
  const win = makeWin();
  const doc = makeDoc({ draws: [], pixels: sheetPixels });
  doc.images = [
    { naturalWidth: 16, naturalHeight: 16, src: 'https://example.gov.in/icon.png' },
    { naturalWidth: 1200, naturalHeight: 900, src: 'https://example.gov.in/sheet.png' },
    { naturalWidth: 400, naturalHeight: 300, src: 'https://example.gov.in/small.png' },
  ];
  const found = R.findPageImages(doc, win);
  assert.strictEqual(found.length, 2, 'the 16px icon should be skipped');
  assert.strictEqual(found[0].width, 1200, 'largest first');
  assert.strictEqual(found[0].sameOrigin, true);
});

test('a cross-origin image is flagged as unreadable, with the workaround named', () => {
  const win = makeWin();
  const doc = makeDoc({ draws: [], pixels: sheetPixels });
  doc.images = [{ naturalWidth: 800, naturalHeight: 600, src: 'https://other-host.example/sheet.png' }];
  const found = R.findPageImages(doc, win);
  assert.strictEqual(found[0].sameOrigin, false);
  assert.match(found[0].note, /another origin/i);
  assert.match(found[0].note, /Capture tab/i, 'should say what to do instead');
});

test('a standalone image document is recognised', () => {
  const store = { draws: [], pixels: sheetPixels };
  const doc = makeDoc(store);
  doc.contentType = 'image/jpeg';
  assert.strictEqual(R.isStandaloneImageDocument(doc), true);
  doc.contentType = 'text/html';
  doc.images = [{}];
  doc.body.children = [{}];
  assert.strictEqual(R.isStandaloneImageDocument(doc), true, 'a lone img in the body also counts');
  doc.images = [{}, {}];
  assert.strictEqual(R.isStandaloneImageDocument(doc), false);
});

test('a PDF is recognised by url, content type or embed', () => {
  const store = { draws: [], pixels: sheetPixels };
  const byUrl = makeWin();
  byUrl.location.href = 'https://example.gov.in/plan.pdf';
  assert.strictEqual(R.looksLikePdf(makeDoc(store), byUrl), true);

  const byUrlQuery = makeWin();
  byUrlQuery.location.href = 'https://example.gov.in/plan.pdf?page=2';
  assert.strictEqual(R.looksLikePdf(makeDoc(store), byUrlQuery), true);

  const d = makeDoc(store);
  d.contentType = 'application/pdf';
  assert.strictEqual(R.looksLikePdf(d, makeWin()), true);

  const d2 = makeDoc(store);
  d2.querySelector = (sel) => (/pdf/.test(sel) ? {} : null);
  assert.strictEqual(R.looksLikePdf(d2, makeWin()), true);

  assert.strictEqual(R.looksLikePdf(makeDoc(store), makeWin()), false);
});

/* =====================================================================
 * PICKING AN IMAGE FILE
 * ---------------------------------------------------------------------
 * The bug these exist to prevent, reported from the field: an ordinary PNG
 * picked through Import → Image was refused with "The browser could not decode
 * that image." The file was fine. The import pointed an <img> in the PAGE's
 * document at a blob: URL, so the PAGE's Content-Security-Policy decided
 * whether it could load — and a portal serving a restrictive img-src simply
 * refused. Reading the File's bytes instead has no URL for a policy to filter.
 * =================================================================== */

function fakeFile(name, type, bytes) {
  return { name, type, size: (bytes || 8), __bytes: bytes };
}

/* A window that can decode bytes, as every current browser can. */
function winWithBitmap(store) {
  return {
    createImageBitmap: async (blob) => {
      store.decoded.push(blob);
      if (blob && blob.__fail) throw new Error('decode failed');
      // `in`, not a truthiness check: a zero-sized bitmap is the case under test.
      const w = blob && '__w' in blob ? blob.__w : 1200;
      const h = blob && '__h' in blob ? blob.__h : 900;
      return { width: w, height: h, close() { store.closed++; } };
    },
    URL: {
      createObjectURL: (b) => { store.minted++; store.live.add('blob:' + store.minted); return 'blob:' + store.minted; },
      revokeObjectURL: (u) => { store.live.delete(u); },
    },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
}

/* And one that cannot, so the object-URL path is still exercised. */
function winWithoutBitmap(store) {
  const w = winWithBitmap(store);
  delete w.createImageBitmap;
  return w;
}

function newStore() { return { decoded: [], minted: 0, closed: 0, live: new Set() }; }

/* A document whose <img> resolves or fails as the test dictates. */
function docWithImg(outcome, dims) {
  return {
    createElement() {
      const el = {};
      Object.defineProperty(el, 'src', {
        set() {
          setImmediate(() => {
            if (outcome === 'ok') {
              el.naturalWidth = dims ? dims[0] : 640;
              el.naturalHeight = dims ? dims[1] : 480;
              el.onload();
            } else el.onerror();
          });
        },
      });
      return el;
    },
  };
}

test('a picked image is decoded from its BYTES, with no URL for a page policy to block', async () => {
  const store = newStore();
  const r = await R.loadImageFile(docWithImg('ok'), fakeFile('sheet.png', 'image/png'), winWithBitmap(store));
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.image.width, 1200);
  assert.strictEqual(r.image.height, 900);
  assert.strictEqual(store.decoded.length, 1, 'the File itself must be handed to the decoder');
  // The point of the fix: nothing was minted, so no page CSP could refuse it.
  assert.strictEqual(store.minted, 0, 'the byte path must not create an object URL at all');
  assert.strictEqual(r.objectUrl, null, 'and there is none for the caller to own');
});

test('where bytes cannot be decoded directly, the object-URL path still works', async () => {
  // Older engines, and the jsdom the DOM suite runs in, have no
  // createImageBitmap. That path is a fallback, not a casualty.
  const store = newStore();
  const r = await R.loadImageFile(docWithImg('ok', [800, 600]), fakeFile('sheet.jpg', 'image/jpeg'), winWithoutBitmap(store));
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.image.width, 800);
  assert.strictEqual(store.minted, 1);
  assert.strictEqual(r.objectUrl, 'blob:1', 'the caller owns the URL, exactly as before');
  assert.strictEqual(store.live.has('blob:1'), true, 'and it is NOT revoked while the image is still in use');
});

test('a decode that genuinely fails releases what it minted and says something useful', async () => {
  const store = newStore();
  const r = await R.loadImageFile(docWithImg('error'), fakeFile('broken.png', 'image/png'), winWithoutBitmap(store));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /broken\.png/, 'the message should name the file');
  assert.match(r.error, /damaged|does not read/i);
  assert.strictEqual(store.live.size, 0, 'a failed import must not pin the file in memory');
  assert.strictEqual(r.objectUrl, null);
});

test('a file that is not an image is refused before any decoding is attempted', async () => {
  const store = newStore();
  const r = await R.loadImageFile(docWithImg('ok'), fakeFile('parcels.dxf', 'application/dxf'), winWithBitmap(store));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not an image/);
  assert.strictEqual(store.decoded.length, 0);
});

test('a wrong MIME type does not veto a file the name says is an image', async () => {
  // Files arriving by email or a messaging app routinely carry the wrong type,
  // and refusing them would be this tool's bug rather than the file's.
  const store = newStore();
  const r = await R.loadImageFile(docWithImg('ok'), fakeFile('scan.JPG', 'application/octet-stream'), winWithBitmap(store));
  assert.strictEqual(r.ok, true, r.error);
});

test('a decoder that returns nothing usable falls through rather than mounting an empty sheet', async () => {
  const store = newStore();
  const blob = fakeFile('zero.png', 'image/png');
  blob.__w = 0; blob.__h = 0;
  const r = await R.loadImageFile(docWithImg('ok', [500, 400]), blob, winWithBitmap(store));
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.image.width, 500, 'the object-URL path should have rescued it');
});

test('a data URL becomes bytes without going back through the page', async () => {
  // The capture arrives as a data: URL. Decoding it via an <img> would put it
  // under the same Content-Security-Policy the byte path exists to avoid.
  const store = newStore();
  const png = Buffer.from('hello world').toString('base64');
  const blob = R.dataUrlToBlob(`data:image/png;base64,${png}`, winWithBitmap(store));
  assert.ok(blob, 'a base64 data URL must convert');
  assert.strictEqual(blob.type, 'image/png');
  assert.strictEqual(blob.size, 'hello world'.length);

  assert.strictEqual(R.dataUrlToBlob('', winWithBitmap(store)), null);
  assert.strictEqual(R.dataUrlToBlob('data:image/png,notbase64', winWithBitmap(store)), null);
  assert.strictEqual(R.dataUrlToBlob('nonsense', winWithBitmap(store)), null);
});
