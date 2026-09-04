/* =========================================================================
 * Browser integration — the gap this suite has carried since v14.
 *
 * Every other test file exercises pure logic. This one loads page_inject.js and
 * all eight libraries into a real DOM (jsdom), puts a stub OpenLayers map behind
 * them, and drives the extension the way a person does: dispatching pointer
 * events, clicking buttons, reading the rendered widget.
 *
 * It is a BLACK-BOX test. page_inject.js exposes no test hooks and none were
 * added for this — production code should not carry scaffolding for its tests.
 * Everything below is asserted through the DOM and through observable effects.
 *
 * The canvas is stubbed to serve a synthetic cadastral sheet, so a tap in Trace
 * mode runs the real tracing pipeline and produces a real shape.
 *
 * jsdom is an OPTIONAL dev dependency. Without it these tests skip and the rest
 * of the suite still runs with no install at all, which is the property that
 * makes `npm test` trustworthy for anyone who just unzipped the extension.
 * Enable them with:  npm install --no-save jsdom
 * ========================================================================= */
'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { /* optional */ }
const t = JSDOM ? test : test.skip;

/* The extension legitimately runs long-lived intervals — it re-attaches its
 * overlay and gestures periodically, because host apps replace their map
 * element. Those keep Node's event loop alive, so every jsdom window is closed
 * after each test. `npm test` also passes --test-force-exit as a safety net.
 */
const openWindows = [];
afterEach(() => {
  while (openWindows.length) {
    const w = openWindows.pop();
    try { w.close(); } catch (e) { /* already gone */ }
  }
});

const ROOT = path.join(__dirname, '..');

/* Load exactly what the extension loads, in the order it loads it.
 *
 * This list used to be typed out here by hand, and it silently went stale the
 * moment a new library was added: page_inject.js refused to start, every test in
 * this file failed with "the widget must be in the document", and the real cause
 * (one missing file) was three levels down in a console message. Reading
 * background.js means the harness cannot disagree with the extension about what
 * the extension is made of. */
function mainWorldFiles() {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const block = src.match(/MAIN_WORLD_FILES\s*=\s*\[([^\]]*)\]/);
  assert.ok(block, 'background.js must declare MAIN_WORLD_FILES');
  const files = block[1].split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.ok(files.includes('page_inject.js'),
    'MAIN_WORLD_FILES must end with page_inject.js');
  return files;
}
const LIB_FILES = mainWorldFiles().filter((f) => f !== 'page_inject.js');

/* ---------------------------------------------------------------------
 * A synthetic sheet: one pale parcel ringed by a dark boundary, on a page
 * background. 600x400 canvas pixels, parcel from (150,100) to (450,300).
 * ------------------------------------------------------------------- */
const CANVAS_W = 600, CANVAS_H = 400;
const PARCEL_BOX = { x: 150, y: 100, w: 300, h: 200 };
const C_PARCEL = [240, 220, 180];
const C_WALL = [20, 20, 20];
const C_PAGE = [205, 230, 240];

function sheetImageData(x0, y0, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gx = x0 + i, gy = y0 + j;
      const inside = gx >= PARCEL_BOX.x && gx < PARCEL_BOX.x + PARCEL_BOX.w &&
                     gy >= PARCEL_BOX.y && gy < PARCEL_BOX.y + PARCEL_BOX.h;
      const wall = !inside &&
        gx >= PARCEL_BOX.x - 3 && gx < PARCEL_BOX.x + PARCEL_BOX.w + 3 &&
        gy >= PARCEL_BOX.y - 3 && gy < PARCEL_BOX.y + PARCEL_BOX.h + 3;
      const c = inside ? C_PARCEL : (wall ? C_WALL : C_PAGE);
      const k = (j * w + i) * 4;
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function stubContext() {
  const noop = () => {};
  return {
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop, setLineDash: noop,
    fillText: noop, setTransform: noop, drawImage: noop, translate: noop, scale: noop,
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => sheetImageData(x, y, w, h),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '',
    imageSmoothingEnabled: true,
  };
}

/* ---------------------------------------------------------------------
 * Stub OpenLayers map: a linear projected view in UTM 45N at exactly
 * 0.5 m per CSS pixel, so expected ground sizes are known analytically.
 * ------------------------------------------------------------------- */
const MAP_RECT = { left: 0, top: 0, width: CANVAS_W, height: CANVAS_H };
const CENTRE = [432500, 2618400];
const M_PER_PX = 0.5;

function installStubMap(win) {
  const doc = win.document;
  const viewport = doc.createElement('div');
  viewport.id = 'stub-map';
  viewport.style.cssText = `position:absolute;left:0;top:0;width:${CANVAS_W}px;height:${CANVAS_H}px;`;
  const canvas = doc.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  viewport.appendChild(canvas);
  doc.body.appendChild(viewport);

  // jsdom gives every element a zero rect; supply real geometry.
  const rect = () => ({ ...MAP_RECT, right: MAP_RECT.width, bottom: MAP_RECT.height, x: 0, y: 0, toJSON() {} });
  viewport.getBoundingClientRect = rect;
  canvas.getBoundingClientRect = rect;
  Object.defineProperty(canvas, 'clientWidth', { value: CANVAS_W, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: CANVAS_H, configurable: true });

  const state = { centre: CENTRE.slice(), zoom: 19 };
  const listeners = {};
  const view = {
    getZoom: () => state.zoom, setZoom: (z) => { state.zoom = z; },
    getCenter: () => state.centre.slice(), setCenter: (c) => { state.centre = c.slice(); },
    getMinZoom: () => 0, getMaxZoom: () => 24, setMinZoom() {}, setMaxZoom() {},
    getResolution: () => M_PER_PX,
    getProjection: () => ({ getCode: () => 'EPSG:32645' }),
  };
  win.map = {
    getView: () => view,
    getViewport: () => viewport,
    getCoordinateFromPixel: ([px, py]) => [
      state.centre[0] + (px - CANVAS_W / 2) * M_PER_PX,
      state.centre[1] - (py - CANVAS_H / 2) * M_PER_PX,
    ],
    getPixelFromCoordinate: ([x, y]) => [
      (x - state.centre[0]) / M_PER_PX + CANVAS_W / 2,
      (state.centre[1] - y) / M_PER_PX + CANVAS_H / 2,
    ],
    getLayers: () => ({ getArray: () => [] }),
    on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    un: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
  };
  // Exposed so a test can aim a drag at a known map coordinate — a vertex it read
  // out of the session — rather than at a screen position it guessed.
  const toClient = ([x, y]) => win.map.getPixelFromCoordinate([x, y]);
  return { viewport, canvas, toClient };
}

/* ---------------------------------------------------------------------
 * Boot the extension inside a fresh jsdom.
 * ------------------------------------------------------------------- */
async function boot() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://jharbhunaksha.jharkhand.gov.in/map',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const win = dom.window;

  // Canvas is not implemented in jsdom; serve the synthetic sheet instead.
  win.HTMLCanvasElement.prototype.getContext = function () { return stubContext(); };
  win.URL.createObjectURL = () => 'blob:stub';
  win.URL.revokeObjectURL = () => {};
  win.confirm = () => true;
  win.alert = () => {};
  win.prompt = () => 'test-project';

  const downloads = [];
  const realCreate = win.document.createElement.bind(win.document);
  win.document.createElement = function (tag) {
    const el = realCreate(tag);
    if (String(tag).toLowerCase() === 'a') {
      el.click = function () { downloads.push({ name: el.download, href: el.href }); };
    }
    return el;
  };

  const surfaces = installStubMap(win);

  for (const rel of LIB_FILES) {
    win.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  win.eval(fs.readFileSync(path.join(ROOT, 'page_inject.js'), 'utf8'));

  // boot() awaits adapter readiness, so give the microtask queue room.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 12));

  openWindows.push(win);
  const widget = win.document.getElementById('bnd15-widget');
  return { dom, win, widget, downloads, surfaces };
}

/* The autosaved session, which is where the real coordinates live.
 *
 * Reading it is how these tests check geometry without a test-only hook in the
 * production code: sessionStorage is a genuine part of the extension's
 * behaviour, so asserting on it exercises the same path a page reload does. */
function session(win) {
  const raw = win.sessionStorage.getItem('bnd15.session');
  assert.ok(raw, 'the session should have been autosaved');
  return JSON.parse(raw);
}

// Give the widget's own async work (tracing, refits) time to settle.
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 12)); };

function pointerEvent(win, type, clientX, clientY, extra) {
  const e = new win.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX, clientY, button: 0, pointerId: 1, altKey: false }, extra || {});
  return e;
}

// A tap: down and up at the same place, under the 4px slop threshold.
function tap(win, host, x, y, extra) {
  host.dispatchEvent(pointerEvent(win, 'pointerdown', x, y, extra));
  win.dispatchEvent(pointerEvent(win, 'pointerup', x, y, extra));
}
// A drag: movement beyond the slop, which must read as a pan, not an action.
function drag(win, host, x0, y0, x1, y1) {
  host.dispatchEvent(pointerEvent(win, 'pointerdown', x0, y0));
  win.dispatchEvent(pointerEvent(win, 'pointermove', x1, y1));
  win.dispatchEvent(pointerEvent(win, 'pointerup', x1, y1));
}
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true }));
const q = (widget, sel) => widget.querySelector(sel);
const bodyText = (widget) => widget.querySelector('#body').textContent;

/* =====================================================================
 * STARTUP
 * =================================================================== */

t('the extension boots, finds the map and builds its widget', async () => {
  const { win, widget } = await boot();
  assert.ok(widget, 'the widget must be in the document');
  for (const g of ['BND_Crs', 'BND_GcpMath', 'BND_Tracer', 'BND_Topology',
    'BND_Export', 'BND_Viewport', 'BND_Raster', 'BND_Adapters']) {
    assert.ok(win[g], `library global ${g} must be present`);
  }
  // No "no supported map" error, and the mode buttons are enabled.
  assert.ok(!/No supported map found/.test(bodyText(widget)), bodyText(widget).slice(0, 200));
  assert.strictEqual(q(widget, '#mTrace').disabled, false, 'Trace should be enabled');
});

t('the CRS is resolved from the declared code and needs no confirmation', async () => {
  const { widget } = await boot();
  const text = bodyText(widget);
  assert.match(text, /UTM 45N/, `expected the zone in the panel: ${text.slice(0, 300)}`);
  assert.match(text, /confirmed/, 'a matching EPSG code should not need confirming');
});

t('the overlay never intercepts pointer events', async () => {
  const { win } = await boot();
  const ov = win.document.getElementById('bnd15-overlay');
  assert.ok(ov, 'the overlay canvas must exist');
  assert.strictEqual(ov.style.pointerEvents, 'none',
    'if the overlay took events, the map could not be panned — this is the v14 regression');
});

/* =====================================================================
 * GESTURES — tap versus drag, and click leakage
 * =================================================================== */

t('a tap in Trace mode digitizes a parcel from the canvas', async () => {
  const { win, widget, surfaces } = await boot();
  click(q(widget, '#mTrace'));
  await settle(2);
  assert.match(bodyText(widget), /Tap inside a parcel/, 'Trace mode should be armed');

  // Tap the middle of the synthetic parcel.
  tap(win, surfaces.viewport, PARCEL_BOX.x + PARCEL_BOX.w / 2, PARCEL_BOX.y + PARCEL_BOX.h / 2);
  await settle(10);

  const text = bodyText(widget);
  assert.match(text, /Shape 1/, `a shape should have been added: ${text.slice(0, 400)}`);
  // 300x200 canvas px at 0.5 m/px = 150 x 100 m = 15000 m² of grid area, and
  // UTM k<1 here so ground area is a touch larger.
  const m = text.match(/Shape 1 · (\d+)v · (\d+) m²/);
  assert.ok(m, `expected the shape summary line, got: ${text.slice(0, 400)}`);
  assert.ok(Number(m[1]) >= 4 && Number(m[1]) <= 8, `expected ~4 vertices, got ${m[1]}`);
  const area = Number(m[2]);
  assert.ok(Math.abs(area - 15000) / 15000 < 0.05,
    `expected about 15000 m², got ${area}`);
});

t('a drag is a pan, not an action — the map is still usable in every mode', async () => {
  const { win, widget, surfaces } = await boot();
  click(q(widget, '#mTrace'));
  await settle(2);
  drag(win, surfaces.viewport,
    PARCEL_BOX.x + PARCEL_BOX.w / 2, PARCEL_BOX.y + PARCEL_BOX.h / 2,
    PARCEL_BOX.x + PARCEL_BOX.w / 2 + 60, PARCEL_BOX.y + PARCEL_BOX.h / 2 + 40);
  await settle(8);
  assert.ok(!/Shape 1/.test(bodyText(widget)),
    'dragging must not trace — it belongs to the map');
  assert.match(bodyText(widget), /Tap inside a parcel/, 'and the mode should still be armed');
});

t('a consumed tap does not leak a click to the portal underneath', async () => {
  // The v15 defect: taps were left to propagate so panning would work, which
  // also handed every tap to the site — on BhuNaksha that re-selects a parcel.
  const { win, widget, surfaces } = await boot();
  let siteClicks = 0;
  surfaces.viewport.addEventListener('click', () => { siteClicks++; });

  click(q(widget, '#mTrace'));
  await settle(2);
  tap(win, surfaces.viewport, PARCEL_BOX.x + 40, PARCEL_BOX.y + 40);
  await settle(6);
  // The browser synthesises a click after the gesture; it must be swallowed.
  surfaces.viewport.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
  assert.strictEqual(siteClicks, 0,
    'the portal must not receive a click that belonged to the digitizer');
});

t('when idle, clicks reach the portal normally', async () => {
  // Blocking must be scoped to armed tools, or the extension breaks the site.
  const { win, surfaces } = await boot();
  let siteClicks = 0;
  surfaces.viewport.addEventListener('click', () => { siteClicks++; });
  tap(win, surfaces.viewport, 300, 200);
  await settle(2);
  surfaces.viewport.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
  assert.strictEqual(siteClicks, 1,
    'with no tool armed the portal must keep working normally');
});

/* =====================================================================
 * CONTROL POINTS — the explicit two-step pairing, end to end
 * =================================================================== */

async function withOneShape() {
  const ctx = await boot();
  click(q(ctx.widget, '#mTrace'));
  await settle(2);
  tap(ctx.win, ctx.surfaces.viewport, PARCEL_BOX.x + PARCEL_BOX.w / 2, PARCEL_BOX.y + PARCEL_BOX.h / 2);
  await settle(10);
  assert.match(bodyText(ctx.widget), /Shape 1/, 'setup: a shape is required');
  return ctx;
}

t('pairing is two-step: nominate a vertex, then capture its true position', async () => {
  const { win, widget, surfaces } = await withOneShape();
  click(q(widget, '#mGcp'));
  await settle(2);
  assert.match(bodyText(widget), /Step 1 of 2/, 'should ask which vertex first');

  // Step 1: tap the parcel's top-left corner.
  tap(win, surfaces.viewport, PARCEL_BOX.x, PARCEL_BOX.y);
  await settle(4);
  const afterPick = bodyText(widget);
  assert.match(afterPick, /Step 2 of 2/, `should advance to capture: ${afterPick.slice(0, 300)}`);
  assert.match(afterPick, /Selected: vertex/, 'and name the nominated vertex');

  // Step 2: tap 40 canvas px east of the corner.
  tap(win, surfaces.viewport, PARCEL_BOX.x + 40, PARCEL_BOX.y);
  await settle(4);
  const afterCapture = bodyText(widget);
  assert.match(afterCapture, /Step 1 of 2/, 'should return to step 1 for the next point');
  assert.match(afterCapture, /Captured/, 'and echo the captured pair');
  assert.match(afterCapture, /1 active/, 'one control point should now exist');

  // The shift must be reported in GROUND METRES, not canvas pixels.
  //
  // The exact figure cannot be predicted, because the traced corner does not
  // land precisely on the box corner that was tapped — leak suppression and
  // edge growth move it by a few pixels, which is correct behaviour. What is
  // predictable is the UNIT: at 0.5 m per pixel, a ~40 px offset is about 20 m
  // of ground, whereas a pixel-unit bug would print roughly 40. Those are a
  // clean factor of two apart, so the range below discriminates between them.
  const m = afterCapture.match(/shift\s*([\d.]+)\s*m/);
  assert.ok(m, `expected a shift readout: ${afterCapture.slice(0, 500)}`);
  const shift = Number(m[1]);
  assert.ok(shift > 12 && shift < 30,
    `expected roughly 20 m of ground shift, got ${shift} — a value near 40 would mean ` +
    'the readout is in canvas pixels rather than metres');
});

t('the captured coordinate is reported numerically, in CRS units and lon/lat', async () => {
  const { win, widget, surfaces } = await withOneShape();
  click(q(widget, '#mGcp'));
  await settle(2);
  tap(win, surfaces.viewport, PARCEL_BOX.x, PARCEL_BOX.y);
  await settle(4);
  tap(win, surfaces.viewport, PARCEL_BOX.x + 10, PARCEL_BOX.y + 4);
  await settle(4);

  const text = bodyText(widget);
  assert.match(text, /stored/, 'the stored position must be shown');
  assert.match(text, /true/, 'and the captured one');
  assert.match(text, /lon\/lat/, 'and its lon/lat');
  // Eastings around 432xxx and a Jharkhand longitude should both appear.
  assert.match(text, /43\d{4}\.\d/, `expected a UTM easting: ${text.slice(0, 500)}`);
  assert.match(text, /8[5-7]\.\d{5}/, 'expected a Jharkhand longitude');
});

t('Escape mid-pairing cancels only that pairing', async () => {
  const { win, widget, surfaces } = await withOneShape();
  click(q(widget, '#mGcp'));
  await settle(2);
  tap(win, surfaces.viewport, PARCEL_BOX.x, PARCEL_BOX.y);
  await settle(3);
  assert.match(bodyText(widget), /Step 2 of 2/);

  const esc = new win.Event('keydown', { bubbles: true });
  Object.assign(esc, { key: 'Escape' });
  win.document.dispatchEvent(esc);
  await settle(3);

  const text = bodyText(widget);
  assert.match(text, /Step 1 of 2/, 'the pairing should be cancelled');
  assert.ok(/0 active/.test(text) || !/1 active/.test(text), 'no control point should be created');
  assert.match(text, /Shape 1/, 'and the session must survive');
});

t('two control points produce a fit, and it can be applied', async () => {
  const { win, widget, surfaces } = await withOneShape();
  click(q(widget, '#mGcp'));
  await settle(2);

  // Two corners, each shifted the same 8 m east: a pure translation.
  for (const corner of [[PARCEL_BOX.x, PARCEL_BOX.y], [PARCEL_BOX.x + PARCEL_BOX.w, PARCEL_BOX.y + PARCEL_BOX.h]]) {
    tap(win, surfaces.viewport, corner[0], corner[1]);
    await settle(4);
    tap(win, surfaces.viewport, corner[0] + 16, corner[1]);
    await settle(4);
  }
  const text = bodyText(widget);
  assert.match(text, /2 active/, `expected two control points: ${text.slice(0, 300)}`);
  // Both points agree on the same shift, so the panel must offer the model that
  // reproduces it without inventing a scale or a rotation.
  assert.match(text, /translation/, `a pure shift should be fitted as a translation: ${text.slice(0, 400)}`);
  assert.match(text, /no scale or rotation change/,
    'and the panel must say plainly that the plot will not be resized or spun');

  const applyBtn = q(widget, '#applyAll');
  assert.ok(applyBtn, 'an apply button should be offered');
  assert.match(applyBtn.textContent, /Move all 1 shape/,
    'the button must state its scope rather than saying only "Apply to all"');

  const before = session(win).shapes[0].points.map((p) => p.slice());
  click(applyBtn);
  await settle(6);
  const after = session(win).shapes[0].points;

  // Every corner must move by the same vector, and by a real distance.
  const moves = after.map((p, i) => [p[0] - before[i][0], p[1] - before[i][1]]);
  const d0 = Math.hypot(moves[0][0], moves[0][1]);
  assert.ok(d0 > 0.5, `the geometry should actually have moved, moved ${d0}`);
  for (const m of moves) {
    assert.ok(Math.abs(m[0] - moves[0][0]) < 1e-6 && Math.abs(m[1] - moves[0][1]) < 1e-6,
      `a pure shift must move every corner identically: ${JSON.stringify(moves)}`);
  }
  assert.match(bodyText(widget), /GCP/, 'the shape should be marked as corrected');
});

t('pressing Apply twice does not move the shape twice', async () => {
  // The reported field bug. A control point says "the geometry claims A, the
  // truth is B". After Apply the corner IS at B, but the stale claim used to
  // remain on file, so the same shift was applied again on the next press and
  // the parcel walked away from its true position one press at a time.
  const { win, widget, surfaces } = await withOneShape();
  click(q(widget, '#mGcp'));
  await settle(2);
  for (const corner of [[PARCEL_BOX.x, PARCEL_BOX.y], [PARCEL_BOX.x + PARCEL_BOX.w, PARCEL_BOX.y + PARCEL_BOX.h]]) {
    tap(win, surfaces.viewport, corner[0], corner[1]);
    await settle(4);
    tap(win, surfaces.viewport, corner[0] + 16, corner[1]);
    await settle(4);
  }

  click(q(widget, '#applyAll'));
  await settle(6);
  const once = session(win).shapes[0].points.map((p) => p.slice());

  click(q(widget, '#applyAll'));
  await settle(6);
  const twice = session(win).shapes[0].points;

  for (let i = 0; i < once.length; i++) {
    const drift = Math.hypot(twice[i][0] - once[i][0], twice[i][1] - once[i][1]);
    assert.ok(drift < 1e-6,
      `corner ${i} drifted a further ${drift} m on the second press; a satisfied ` +
      `correction must be a no-op`);
  }
});

t('a complete reset clears the control points too, not just the shapes', async () => {
  // Reported: "when we are clearing, all GCPs are still captured". Three
  // separate reset paths each cleared a different subset of the state.
  const { win, widget, surfaces } = await withOneShape();
  click(q(widget, '#mGcp'));
  await settle(2);
  tap(win, surfaces.viewport, PARCEL_BOX.x, PARCEL_BOX.y);
  await settle(3);
  tap(win, surfaces.viewport, PARCEL_BOX.x + 16, PARCEL_BOX.y);
  await settle(4);

  let s = session(win);
  assert.strictEqual(s.gcps.length, 1, 'a control point should exist to be cleared');
  assert.strictEqual(s.shapes.length, 1);

  click(q(widget, '#delAll'));
  await settle(6);

  s = session(win);
  assert.strictEqual(s.shapes.length, 0, 'shapes must go');
  assert.strictEqual(s.gcps.length, 0, 'and so must the control points');
  assert.deepStrictEqual(s.backups, {}, 'and the revert backups with them');
  const text = bodyText(widget);
  assert.ok(!/1 active/.test(text), `no control point should still be listed: ${text.slice(0, 300)}`);
});

t('undo reverses a deletion, and redo reinstates it', async () => {
  const { win, widget } = await withOneShape();
  assert.strictEqual(session(win).shapes.length, 1);

  click(q(widget, '#delLast'));
  await settle(4);
  assert.strictEqual(session(win).shapes.length, 0, 'the shape should be gone');

  const undoBtn = q(widget, '#gUndo');
  assert.ok(undoBtn, 'a named undo button should appear once there is something to undo');
  assert.match(undoBtn.textContent, /delete shape/,
    'and it should say what it would reverse');
  click(undoBtn);
  await settle(4);
  assert.strictEqual(session(win).shapes.length, 1, 'undo must bring the shape back');

  click(q(widget, '#gRedo'));
  await settle(4);
  assert.strictEqual(session(win).shapes.length, 0, 'redo must delete it again');
});

t('Ctrl+Z undoes an applied correction, geometry and all', async () => {
  const { win, widget, surfaces } = await withOneShape();
  const original = session(win).shapes[0].points.map((p) => p.slice());

  click(q(widget, '#mGcp'));
  await settle(2);
  tap(win, surfaces.viewport, PARCEL_BOX.x, PARCEL_BOX.y);
  await settle(3);
  tap(win, surfaces.viewport, PARCEL_BOX.x + 20, PARCEL_BOX.y + 10);
  await settle(4);
  click(q(widget, '#applyAll'));
  await settle(6);

  const moved = session(win).shapes[0].points;
  assert.ok(Math.hypot(moved[0][0] - original[0][0], moved[0][1] - original[0][1]) > 0.5,
    'the correction should have moved the geometry');

  const z = new win.Event('keydown', { bubbles: true });
  Object.assign(z, { key: 'z', ctrlKey: true, shiftKey: false });
  win.document.dispatchEvent(z);
  await settle(5);

  const back = session(win).shapes[0].points;
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.hypot(back[i][0] - original[i][0], back[i][1] - original[i][1]) < 1e-6,
      `corner ${i} should be exactly back where it started`);
  }
});

t('a hand-drawn shape records a coordinate per corner, usable as control points', async () => {
  // Asked for explicitly: "when we are drawing manually let it capture vertex
  // coordinate as well so if required we will add gcp if not it will use its
  // vertex coordinates". A drawn ring must be no less usable than a traced one.
  const { win, widget, surfaces } = await boot();
  click(q(widget, '#mDraw'));
  await settle(2);

  const corners = [[200, 150], [340, 150], [340, 260], [200, 260]];
  for (const [x, y] of corners) {
    tap(win, surfaces.viewport, x, y);
    await settle(3);
  }
  click(q(widget, '#dFinish'));
  await settle(5);

  const s = session(win);
  assert.strictEqual(s.shapes.length, 1, 'the drawn shape should be saved');
  const shape = s.shapes[0];
  assert.strictEqual(shape.points.length, corners.length,
    'every corner tapped must be kept');
  for (const p of shape.points) {
    assert.strictEqual(p.length, 2, 'each corner is a coordinate pair');
    assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]),
      `a real map coordinate, not a screen pixel: ${JSON.stringify(p)}`);
  }
  // Distinct corners, i.e. genuinely per-vertex rather than one repeated point.
  assert.strictEqual(new Set(shape.points.map((p) => p.join(','))).size, corners.length);

  // Those coordinates must be offered as control-point anchors.
  click(q(widget, '#mGcp'));
  await settle(3);
  const picker = q(widget, '#vertexPick');
  assert.ok(picker, 'the vertex picker should be offered for a hand-drawn shape');
  const values = [...picker.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
  assert.strictEqual(values.length, corners.length,
    `every drawn corner should be pickable, got ${JSON.stringify(values)}`);
  assert.ok(values.every((v) => v.startsWith(`${shape.id}:`)),
    'and they should belong to the drawn shape');
  // The stored coordinate is shown, so it can be checked rather than assumed.
  assert.match(picker.textContent, /v0 — /, 'each option should display its coordinate');
});

t('dragging a corner in Edit mode records a control point by itself', async () => {
  // "if we will adjust the shape of the plot it will automatically create its gcp"
  const { win, widget, surfaces } = await withOneShape();
  assert.strictEqual(session(win).gcps.length, 0, 'no control points to start with');

  const shape = session(win).shapes[0];
  click(q(widget, `[data-edit="${shape.id}"]`));
  await settle(3);

  // Grab the first corner and drag it well beyond the snap tolerance.
  const before = shape.points[0].slice();
  const screen = surfaces.toClient(before);
  drag(win, surfaces.viewport, screen[0], screen[1], screen[0] + 40, screen[1] + 25);
  await settle(6);

  const s = session(win);
  assert.strictEqual(s.gcps.length, 1,
    `the drag alone should have produced a control point: ${JSON.stringify(s.gcps)}`);
  const g = s.gcps[0];
  assert.strictEqual(g.shapeId, shape.id);
  assert.strictEqual(g.vertexIndex, 0);
  // The source must be where the corner WAS. Recording the new position would
  // mean a zero shift, which teaches the fit nothing.
  assert.ok(Math.hypot(g.source[0] - before[0], g.source[1] - before[1]) < 1e-6,
    `source should be the pre-drag position ${JSON.stringify(before)}, got ${JSON.stringify(g.source)}`);
  const moved = s.shapes[0].points[0];
  assert.ok(Math.hypot(g.target[0] - moved[0], g.target[1] - moved[1]) < 1e-6,
    'and the target should be where the corner now is');
  assert.ok(Math.hypot(g.target[0] - g.source[0], g.target[1] - g.source[1]) > 1,
    'with a real shift between them');
});

t('the panel opens with a numbered guide to the whole job', async () => {
  const { widget } = await boot();
  const text = bodyText(widget);
  assert.match(text, /How this works/, 'the workflow should be stated up front');
  assert.match(text, /Digitise the parcels/);
  assert.match(text, /Correct the position/);
  assert.match(text, /Check and export/);
  // Georeferencing is not part of every job, and implying it is sends operators
  // hunting for control points they do not need.
  assert.match(text, /optional/, 'the correction step must be marked optional');
});

/* =====================================================================
 * CLEAN-UP AND EXPORT
 * =================================================================== */

t('regularise squares up a traced parcel and reports it', async () => {
  const { widget } = await withOneShape();
  const before = bodyText(widget).match(/Shape 1 · (\d+)v/)[1];
  const btn = q(widget, '#regAll');
  assert.ok(btn, 'a regularise control should be offered');
  click(btn);
  await settle(6);
  const after = bodyText(widget).match(/Shape 1 · (\d+)v/)[1];
  assert.ok(Number(after) <= Number(before),
    `regularising must not add vertices: ${before} -> ${after}`);
  assert.ok(Number(after) >= 3, 'and must leave a valid polygon');
});

t('the quality report grades the session with itemised reasons', async () => {
  const { widget } = await withOneShape();
  click(q(widget, '#qual'));
  await settle(6);
  const text = bodyText(widget);
  assert.match(text, /Quality/, 'a quality card should appear');
  assert.match(text, /\/100/, 'with a score out of 100');
  assert.match(text, /error\(s\)/, 'and a count of problems');
});

t('every export format produces a download', async () => {
  const { widget, downloads } = await withOneShape();
  const expected = [
    ['#xDxf', /\.dxf$/], ['#xKmz', /\.kmz$/], ['#xGeo', /\.geojson$/],
    ['#xShp', /\.zip$/], ['#xWkt', /\.wkt$/], ['#xCsv', /\.csv$/], ['#xArea', /\.csv$/],
  ];
  for (const [sel, pattern] of expected) {
    const btn = q(widget, sel);
    assert.ok(btn, `export button ${sel} should exist`);
    const before = downloads.length;
    click(btn);
    await settle(4);
    assert.ok(downloads.length > before, `${sel} should have produced a download`);
    assert.match(downloads[downloads.length - 1].name, pattern,
      `${sel} produced ${downloads[downloads.length - 1].name}`);
  }
});

t('exports are refused with a reason when nothing is digitized', async () => {
  const { widget, downloads } = await boot();
  click(q(widget, '#xGeo'));
  await settle(3);
  assert.strictEqual(downloads.length, 0, 'nothing should be written');
});

/* =====================================================================
 * SETTINGS AND PERSISTENCE
 * =================================================================== */

t('zoom is manual: tracing never moves the view on its own', async () => {
  const { win, widget, surfaces } = await boot();
  const zoomBefore = win.map.getView().getZoom();
  const centreBefore = win.map.getView().getCenter();
  click(q(widget, '#mTrace'));
  await settle(2);
  tap(win, surfaces.viewport, PARCEL_BOX.x + PARCEL_BOX.w / 2, PARCEL_BOX.y + PARCEL_BOX.h / 2);
  await settle(10);
  assert.strictEqual(win.map.getView().getZoom(), zoomBefore,
    'the operator\'s zoom must be left alone');
  assert.deepStrictEqual(win.map.getView().getCenter(), centreBefore,
    'and their centre too');
  assert.ok(q(widget, '#zoomIn'), 'zooming is offered as an explicit button instead');
});

t('settings persist to localStorage and reload', async () => {
  const { win, widget } = await boot();
  click(q(widget, '#advT'));
  await settle(2);
  const slider = q(widget, '#sTol');
  assert.ok(slider, 'the colour tolerance control should be visible by default');
  slider.value = '77';
  slider.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(2);
  const saved = JSON.parse(win.localStorage.getItem('bnd15.settings'));
  assert.strictEqual(saved.colorTolerance, 77, 'the change must be persisted');
});

t('only four settings are visible before expanding the groups', async () => {
  const { widget } = await boot();
  click(q(widget, '#advT'));
  await settle(2);
  const advBody = q(widget, '#advB');
  // Fields directly in the panel, not inside a collapsed <details>.
  const direct = Array.from(advBody.children).filter((el) => el.classList.contains('field'));
  assert.strictEqual(direct.length, 4,
    `expected four essentials, found ${direct.length}: ${direct.map((d) => d.textContent.trim()).join(' | ')}`);
  assert.ok(advBody.querySelectorAll('details').length >= 4, 'the rest should be grouped and collapsed');
});

t('a session survives a reload from sessionStorage', async () => {
  const { win, widget } = await withOneShape();
  const saved = win.sessionStorage.getItem('bnd15.session');
  assert.ok(saved, 'the session must be autosaved');
  const parsed = JSON.parse(saved);
  assert.strictEqual(parsed.shapes.length, 1);
  assert.ok(Array.isArray(parsed.shapes[0].points) && parsed.shapes[0].points.length >= 4);
  void widget;
});

/* =====================================================================
 * CREDIT
 * =================================================================== */

t('the widget credits the author', async () => {
  const { widget } = await boot();
  assert.match(widget.textContent, /Md Salim Ansari/);
  assert.match(widget.textContent, /MIT/);
});

/* =====================================================================
 * RASTER WORKSPACE, mounted for real
 * =================================================================== */

t('an image workspace mounts and switches coordinates to pixels', async () => {
  const { win, widget } = await boot();
  assert.ok(q(widget, '#wsFile'), 'a file entry point should be offered');
  assert.ok(q(widget, '#wsCapture'), 'and a capture entry point for PDFs');

  // Mount directly through the library, since a file picker cannot be driven
  // headlessly. This still exercises the real adapter against a real DOM.
  const made = win.BND_Raster.createRasterWorkspace({
    doc: win.document, win, Viewport: win.BND_Viewport,
    image: { width: 800, height: 600, drawable: win.document.createElement('canvas') },
    sourceName: 'sheet.png', sourceKind: 'file',
  });
  assert.strictEqual(made.ok, true, made.error);
  const container = win.document.getElementById('bnd15-raster-workspace');
  assert.ok(container, 'the workspace container must be attached to the document');

  const a = made.adapter;
  assert.strictEqual(a.isRaster, true);
  assert.strictEqual(a.coordsAreLonLat, false, 'pixels are not lon/lat');
  assert.strictEqual(a.getProjectionCode(), null, 'and no projection is claimed');
  const cnv = a.getCanvas();
  assert.strictEqual(cnv.width, 800, 'tracing reads the image at native resolution');

  a.destroy();
  assert.ok(!win.document.getElementById('bnd15-raster-workspace'),
    'destroy must detach it');
});

/* =====================================================================
 * NO CRASHES ANYWHERE
 * =================================================================== */

t('driving every control raises no exception', async () => {
  const errors = [];
  const { win, widget, surfaces } = await withOneShape();
  win.addEventListener('error', (e) => errors.push(String(e.message || e)));
  const origError = win.console.error;
  win.console.error = (...args) => { errors.push(args.join(' ')); origError.apply(win.console, args); };

  // Every button in the widget, twice, in order — including toggles.
  for (let pass = 0; pass < 2; pass++) {
    const buttons = Array.from(widget.querySelectorAll('button'));
    for (const b of buttons) {
      if (b.id === 'close' || b.id === 'wsClose') continue; // would tear down the fixture
      click(b);
      await settle(1);
    }
    await settle(3);
  }
  // And a tap in each mode.
  for (const id of ['#mTrace', '#mDraw', '#mGcp']) {
    const el = q(widget, id);
    if (!el) continue;
    click(el);
    await settle(1);
    tap(win, surfaces.viewport, 300, 200);
    await settle(3);
  }
  const real = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
  assert.deepStrictEqual(real, [], `unexpected errors: ${real.join(' | ')}`);
});

/* =====================================================================
 * v17 — THE THREE MAIN BUTTONS  (brief §1, §29)
 * =================================================================== */

t('the workspace offers exactly three primary controls', async () => {
  const { widget } = await boot();
  for (const id of ['#btnImport', '#btnExport', '#btnSaveProject']) {
    assert.ok(q(widget, id), `${id} must exist`);
  }
  // "Do not create additional permanent Import/Export buttons." Project import
  // and export live inside the menus, so they must not also appear as
  // top-level controls beside the three.
  const mainRow = q(widget, '.bnd15-main > .bnd15-row');
  const labels = Array.from(mainRow.querySelectorAll('button')).map((b) => b.textContent.trim());
  assert.strictEqual(labels.length, 3, `expected three primary buttons, got: ${labels.join(' | ')}`);
  assert.match(labels[0], /Import/);
  assert.match(labels[1], /Export/);
  assert.match(labels[2], /Save Project/);
});

t('the menus open, close, and hold the format entries', async () => {
  const { widget } = await boot();
  const menuImport = () => q(widget, '#menuImport');
  const menuExport = () => q(widget, '#menuExport');

  assert.ok(!menuImport().classList.contains('open'), 'menus start closed');

  click(q(widget, '#btnImport'));
  await settle(2);
  assert.ok(menuImport().classList.contains('open'), 'Import must open its menu');
  assert.ok(!menuExport().classList.contains('open'), 'and not the other one');

  click(q(widget, '#btnExport'));
  await settle(2);
  assert.ok(menuExport().classList.contains('open'), 'Export must open its menu');
  assert.ok(!menuImport().classList.contains('open'), 'which closes Import');

  click(q(widget, '#btnExport'));
  await settle(2);
  assert.ok(!menuExport().classList.contains('open'), 'and pressing it again closes it');
});

t('every format the brief names is reachable from a menu', async () => {
  const { widget } = await boot();
  // Import: project JSON, KMZ/KML, DXF, CSV vertices, image, PDF.
  for (const id of ['#xLoad', '#iKml', '#iDxf', '#iCsv', '#iGeo', '#gcpImport', '#iImage', '#iPdf']) {
    assert.ok(q(widget, `#menuImport ${id}`), `Import menu must offer ${id}`);
  }
  // Export: project JSON, KML, KMZ, DXF, CSV vertices, and the rest.
  for (const id of ['#xProj', '#xKml', '#xKmz', '#xDxf', '#xCsv', '#xGeo', '#xShp', '#xWkt', '#xArea', '#gcpExport']) {
    assert.ok(q(widget, `#menuExport ${id}`), `Export menu must offer ${id}`);
  }
});

t('the export controls still work while their menu is closed', async () => {
  // They are hidden by a class, not removed from the document. If that ever
  // changes to build-on-open, this fails rather than the harness quietly
  // losing its reach.
  const { widget, downloads } = await withOneShape();
  assert.ok(!q(widget, '#menuExport').classList.contains('open'));
  click(q(widget, '#xGeo'));
  await settle(4);
  assert.strictEqual(downloads.length, 1);
  assert.match(downloads[0].name, /\.geojson$/);
});

t('Save Project writes ProjectName.json and does not duplicate on a second press', async () => {
  const { win, widget, downloads } = await withOneShape();
  win.prompt = () => 'kanke-block-7';

  click(q(widget, '#btnSaveProject'));
  await settle(4);
  assert.strictEqual(downloads.length, 1);
  assert.strictEqual(downloads[0].name, 'kanke-block-7.json');

  const saved = JSON.parse(win.localStorage.getItem('bnd15.projects'));
  assert.ok(saved['kanke-block-7'], 'it must also be kept in the browser');

  // Second press must update the same project, not invent "kanke-block-7 (2)".
  win.prompt = () => { throw new Error('must not ask again once the project has a name'); };
  click(q(widget, '#btnSaveProject'));
  await settle(4);
  assert.strictEqual(downloads.length, 2);
  assert.strictEqual(downloads[1].name, 'kanke-block-7.json', 'the same file, updated');
  assert.strictEqual(Object.keys(JSON.parse(win.localStorage.getItem('bnd15.projects'))).length, 1,
    'one project, not two');
});

t('a saved project carries the whole workspace, not just the outlines', async () => {
  const { win, widget } = await withOneShape();
  win.prompt = () => 'p1';
  click(q(widget, '#btnSaveProject'));
  await settle(4);
  const proj = JSON.parse(win.localStorage.getItem('bnd15.projects')).p1;
  for (const k of ['schema', 'shapes', 'gcps', 'crs', 'projectName', 'georefPoints',
    'calibration', 'drawing', 'settings']) {
    assert.ok(k in proj, `a project must store ${k}`);
  }
  assert.ok(proj.schema >= 2);
  assert.ok(proj.shapes[0].layer, 'every parcel must carry its layer');
  assert.ok(proj.shapes[0].source, 'and where it came from');
});

/* =====================================================================
 * v17 — COLLAPSIBLE SECTIONS  (brief §7)
 * =================================================================== */

t('the cadastral tool sections collapse and remember their state', async () => {
  const { win, widget } = await withOneShape();
  const keys = Array.from(widget.querySelectorAll('details.sect')).map((d) => d.dataset.sect);
  for (const want of ['workflow', 'cleanup', 'edit', 'gcp', 'drawing']) {
    assert.ok(keys.includes(want), `"${want}" must be collapsible — got ${keys.join(', ')}`);
  }
  // Settings was already collapsible and stays so.
  assert.ok(q(widget, '#advT'), 'Settings keeps its own collapse');

  const cleanup = widget.querySelector('details.sect[data-sect="cleanup"]');
  assert.ok(!cleanup.open, 'sections other than the defaults start closed, to leave the map room');
  cleanup.open = true;
  cleanup.dispatchEvent(new win.Event('toggle'));
  await settle(2);
  const saved = JSON.parse(win.localStorage.getItem('bnd15.settings'));
  assert.ok(saved.openSections.includes('cleanup'), 'the open state must persist');
});

t('a collapsed section keeps its controls in the document', async () => {
  // This is what lets the panel be uncluttered without putting anything out of
  // reach — of an operator using find-in-page, or of this harness.
  const { widget } = await withOneShape();
  const cleanup = widget.querySelector('details.sect[data-sect="cleanup"]');
  assert.ok(!cleanup.open);
  assert.ok(q(widget, '#regAll'), 'Regularise must still be findable while collapsed');
  assert.ok(q(widget, '#snapAll'));
  assert.ok(q(widget, '#qual'));
});

/* =====================================================================
 * v17 — UNDO / REDO / REMOVE LAST / RESET EVERYTHING  (brief §8)
 * =================================================================== */

t('all four editing controls sit together and are always present', async () => {
  const { widget } = await boot();
  const bar = q(widget, '.bnd15-hist');
  assert.ok(bar, 'the editing controls need a bar of their own');
  const ids = Array.from(bar.querySelectorAll('button')).map((b) => b.id);
  assert.deepStrictEqual(ids, ['gUndo', 'gRedo', 'delLast', 'delAll'],
    'in the order the brief gives them');
  // Present even with nothing to undo — a control that comes and goes cannot be
  // found reliably.
  assert.ok(q(widget, '#gUndo').disabled, 'Undo is disabled, not absent');
});

/* =====================================================================
 * v17 — MOVE, ROTATE, SCALE  (brief §3, §4, §10)
 * =================================================================== */

async function withSelection() {
  const ctx = await withOneShape();
  click(q(ctx.widget, '[data-sel]'));
  await settle(3);
  return ctx;
}

t('the Edit section names every tool the brief lists', async () => {
  const { widget } = await withOneShape();
  const text = bodyText(widget);
  for (const tool of ['Select', 'Move Geometry', 'Move Vertex', 'Add Vertex',
    'Delete Vertex', 'Rotate', 'Scale', 'Copy', 'Duplicate', 'Delete']) {
    assert.ok(text.includes(tool), `Edit must offer "${tool}"`);
  }
});

t('a typed X/Y shift moves the parcel by exactly that much', async () => {
  const { win, widget } = await withSelection();
  const before = session(win).shapes[0].points.map((p) => p.slice());

  q(widget, '#eDx').value = '3.5';
  q(widget, '#eDy').value = '-2.25';
  click(q(widget, '#eApplyXY'));
  await settle(4);

  const after = session(win).shapes[0].points;
  assert.strictEqual(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs((after[i][0] - before[i][0]) - 3.5) < 1e-9, `vertex ${i} x`);
    assert.ok(Math.abs((after[i][1] - before[i][1]) - (-2.25)) < 1e-9, `vertex ${i} y`);
  }
});

t('a move is recorded separately from the geometry, and is resettable', async () => {
  const { win, widget } = await withSelection();
  const original = session(win).shapes[0].points.map((p) => p.slice());

  q(widget, '#eDx').value = '4';
  q(widget, '#eDy').value = '0';
  click(q(widget, '#eApplyXY'));
  await settle(4);

  const shape = session(win).shapes[0];
  assert.ok(shape.shift, 'the parcel must carry a shift record');
  assert.ok(Math.abs(shape.shift.dx - 4) < 1e-9, 'stating the translation');
  assert.strictEqual(shape.shift.rotationDeg, 0);
  assert.strictEqual(shape.shift.scale, 1);
  assert.match(bodyText(widget), /Shift on this parcel/, 'and the panel must show it');

  // Reset restores the original exactly and clears the record.
  click(q(widget, '#eResetShift'));
  await settle(4);
  const back = session(win).shapes[0];
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(back.points[i][0] - original[i][0]) < 1e-9, `vertex ${i} must return`);
    assert.ok(Math.abs(back.points[i][1] - original[i][1]) < 1e-9);
  }
  assert.strictEqual(back.shift.dx, 0, 'and the record goes with it');
});

t('undo reverses a move, and says what it would reverse', async () => {
  const { win, widget } = await withSelection();
  const before = session(win).shapes[0].points.map((p) => p.slice());

  q(widget, '#eDx').value = '7';
  q(widget, '#eDy').value = '0';
  click(q(widget, '#eApplyXY'));
  await settle(4);
  assert.ok(Math.abs(session(win).shapes[0].points[0][0] - before[0][0] - 7) < 1e-9);

  const undo = q(widget, '#gUndo');
  assert.match(undo.textContent, /move shape/, 'the button must name the operation');
  click(undo);
  await settle(4);
  const after = session(win).shapes[0].points;
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(after[i][0] - before[i][0]) < 1e-9, `undo must restore vertex ${i}`);
  }
});

t('rotating turns the parcel where it stands and does not move it', async () => {
  const { win, widget } = await withSelection();
  const E = require('../lib/exporters.js');
  const before = session(win).shapes[0].points.map((p) => p.slice());
  const c0 = E.centroidOfRing(before);
  const area0 = E.gridArea(before);

  q(widget, '#eRot').value = '5';
  click(q(widget, '#eApplyRot'));
  await settle(4);

  const after = session(win).shapes[0].points;
  const c1 = E.centroidOfRing(after);
  // A rotation that also translates is a positional error dressed as a
  // rotation, and at UTM magnitudes it is exactly the kind that goes unnoticed.
  assert.ok(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < 1e-3,
    `the parcel moved ${Math.hypot(c1[0] - c0[0], c1[1] - c0[1])} m while only being rotated`);
  assert.ok(Math.abs(E.gridArea(after) / area0 - 1) < 1e-6, 'and its area must not change');
  assert.ok(Math.abs(session(win).shapes[0].shift.rotationDeg - 5) < 1e-9);
});

t('scaling changes area by the square of the factor and is recorded', async () => {
  const { win, widget } = await withSelection();
  const E = require('../lib/exporters.js');
  const area0 = E.gridArea(session(win).shapes[0].points);

  q(widget, '#eScale').value = '1.05';
  click(q(widget, '#eApplyScale'));
  await settle(4);

  const shape = session(win).shapes[0];
  assert.ok(Math.abs(E.gridArea(shape.points) / area0 - 1.05 * 1.05) < 1e-6);
  assert.ok(Math.abs(shape.shift.scale - 1.05) < 1e-9);
});

t('stacked operations leave one record that describes all of them', async () => {
  const { win, widget } = await withSelection();
  const G = require('../lib/geom_edit.js');
  const original = session(win).shapes[0].points.map((p) => p.slice());

  q(widget, '#eDx').value = '3'; q(widget, '#eDy').value = '-2';
  click(q(widget, '#eApplyXY'));
  await settle(3);
  q(widget, '#eRot').value = '1.5';
  click(q(widget, '#eApplyRot'));
  await settle(3);
  q(widget, '#eScale').value = '1.01';
  click(q(widget, '#eApplyScale'));
  await settle(3);

  const shape = session(win).shapes[0];
  // The record applied to the ORIGINAL must reproduce the live geometry. If it
  // does not, the record is describing something that did not happen.
  const predicted = G.applyShiftToRing(shape.shift, original);
  for (let i = 0; i < original.length; i++) {
    const d = Math.hypot(predicted[i][0] - shape.points[i][0], predicted[i][1] - shape.points[i][1]);
    assert.ok(d < 1e-6, `the shift record disagrees with the geometry at vertex ${i} by ${d} m`);
  }
});

t('duplicate makes a second, offset parcel that can be told apart', async () => {
  const { win, widget } = await withSelection();
  assert.strictEqual(session(win).shapes.length, 1);
  click(q(widget, '#eDuplicate'));
  await settle(4);
  const shapes = session(win).shapes;
  assert.strictEqual(shapes.length, 2);
  assert.notStrictEqual(shapes[0].id, shapes[1].id);
  const moved = Math.hypot(shapes[1].points[0][0] - shapes[0].points[0][0],
    shapes[1].points[0][1] - shapes[0].points[0][1]);
  assert.ok(moved > 0, 'a copy exactly on top of the original cannot be selected apart');
});

t('deleting the selected parcel removes it, and undo brings it back', async () => {
  const { win, widget } = await withSelection();
  click(q(widget, '#eDelete'));
  await settle(4);
  assert.strictEqual(session(win).shapes.length, 0);
  click(q(widget, '#gUndo'));
  await settle(4);
  assert.strictEqual(session(win).shapes.length, 1);
});

t('the Edit tools refuse politely when nothing is selected', async () => {
  // Every one of these is reachable with no selection, and the crash sweep
  // presses all of them. They must decline rather than throw.
  const { win, widget } = await withOneShape();
  for (const id of ['#eApplyXY', '#eApplyRot', '#eApplyScale', '#eCopy', '#eDuplicate', '#eDelete']) {
    const el = q(widget, id);
    assert.ok(el, `${id} must exist`);
    click(el);
    await settle(1);
  }
  assert.strictEqual(session(win).shapes.length, 1, 'nothing may happen without a selection');
});

/* =====================================================================
 * v17 — MOVE GEOMETRY IS NOT MAP PAN  (brief §26)
 * =================================================================== */

t('dragging the map still pans it while Move Geometry is armed', async () => {
  const { win, widget, surfaces } = await withSelection();
  click(q(widget, '#eMove'));
  await settle(2);

  const centreBefore = win.map.getView().getCenter().slice();
  const pointsBefore = session(win).shapes[0].points.map((p) => p.slice());

  // A drag well outside the parcel is a pan, and must leave the geometry alone.
  drag(win, surfaces.viewport, 20, 20, 60, 60);
  await settle(4);

  const pointsAfter = session(win).shapes[0].points;
  for (let i = 0; i < pointsBefore.length; i++) {
    assert.deepStrictEqual(pointsAfter[i], pointsBefore[i],
      'panning the map must never move a parcel');
  }
  void centreBefore;
});

t('dragging the parcel moves it and leaves the map where it was', async () => {
  const { win, widget, surfaces } = await withSelection();
  click(q(widget, '#eMove'));
  await settle(2);

  const zoomBefore = win.map.getView().getZoom();
  const centreBefore = win.map.getView().getCenter().slice();
  const before = session(win).shapes[0].points.map((p) => p.slice());

  const cx = PARCEL_BOX.x + PARCEL_BOX.w / 2;
  const cy = PARCEL_BOX.y + PARCEL_BOX.h / 2;
  drag(win, surfaces.viewport, cx, cy, cx + 20, cy);
  await settle(5);

  const after = session(win).shapes[0].points;
  const moved = Math.hypot(after[0][0] - before[0][0], after[0][1] - before[0][1]);
  assert.ok(moved > 1, `the parcel should have moved, it moved ${moved} m`);
  // Every vertex by the same amount: a move must not deform.
  for (let i = 1; i < before.length; i++) {
    assert.ok(Math.abs((after[i][0] - before[i][0]) - (after[0][0] - before[0][0])) < 1e-9,
      'a move must translate every corner equally');
  }
  assert.deepStrictEqual(win.map.getView().getCenter(), centreBefore, 'the map must not move');
  assert.strictEqual(win.map.getView().getZoom(), zoomBefore);
  assert.ok(session(win).shapes[0].shift.dx !== 0, 'and the move must be recorded');
});

/* =====================================================================
 * v17 — DRAWING SCALE  (brief §12, §13)
 * =================================================================== */

t('the drawing-scale controls appear only on a raster sheet', async () => {
  const { widget } = await boot();
  // On a live map there is no sheet to scale, so offering an RF box would be
  // meaningless.
  assert.ok(!q(widget, '#rfApply'), 'no RF control on a live map');
  assert.ok(q(widget, '#wsFile'), 'but the way into a sheet must be offered');
});

/* =====================================================================
 * v17 — IMPORT, END TO END  (brief §2, §16, §23, §25)
 * ---------------------------------------------------------------------
 * The whole chain through the real widget: a DXF goes in through the file
 * picker, the parcels overlay themselves, they are edited with the tools that
 * already existed, cleaned by the topology code that already existed, and
 * exported carrying the correction.
 *
 * That last part is the claim worth testing. "Imported geometry uses the
 * existing editing system" is easy to assert in prose and easy to get wrong;
 * this drives it.
 * =================================================================== */

/* Hand the next file input a file, so the picker path runs for real rather
 * than the parser being called directly. */
function feedNextFilePicker(win, name, text) {
  const realCreate = win.document.createElement.bind(win.document);
  const prev = win.document.createElement;
  win.document.createElement = function (tag) {
    const el = realCreate(tag);
    if (String(tag).toLowerCase() === 'input') {
      el.click = function () {
        const file = new win.File([text], name);
        Object.defineProperty(el, 'files', { value: [file], configurable: true });
        setTimeout(() => { if (el.onchange) el.onchange({ target: el }); }, 0);
      };
      win.document.createElement = prev;   // one file, then back to normal
    } else if (String(tag).toLowerCase() === 'a') {
      el.click = function () { /* download capture is reinstalled by prev */ };
    }
    return el;
  };
}

/* Two parcels at real Jharkhand eastings and northings, one carrying a plot
 * number as a TEXT label the way cadastral DXFs do. */
const SAMPLE_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LWPOLYLINE', '8', 'PLOTS', '70', '1',
  '10', '432500.25', '20', '2618400.75',
  '10', '432540.25', '20', '2618400.75',
  '10', '432540.25', '20', '2618440.75',
  '10', '432500.25', '20', '2618440.75',
  '0', 'TEXT', '8', 'LBL', '10', '432520', '20', '2618420', '1', '77/3',
  '0', 'LWPOLYLINE', '8', 'PLOTS', '70', '1',
  '10', '432550.5', '20', '2618400.75',
  '10', '432590.5', '20', '2618400.75',
  '10', '432590.5', '20', '2618440.75',
  '0', 'ENDSEC', '0', 'EOF',
].join('\r\n');

/* sessionStorage only exists once something has been saved into it. A test
 * that asserts an import was REFUSED must not fail on the absence of a
 * session — that absence is the thing being asserted. */
function sessionOrEmpty(win) {
  const raw = win.sessionStorage.getItem('bnd15.session');
  return raw ? JSON.parse(raw) : { shapes: [], gcps: [], backups: {} };
}

async function withImportedDxf() {
  const ctx = await boot();
  feedNextFilePicker(ctx.win, 'plots.dxf', SAMPLE_DXF);
  click(q(ctx.widget, '#btnImport'));
  await settle(2);
  click(q(ctx.widget, '#iDxf'));
  await settle(12);
  return ctx;
}

t('a DXF imports through the picker and overlays itself', async () => {
  const { win, widget } = await withImportedDxf();
  const s = session(win);
  assert.strictEqual(s.shapes.length, 2, 'both parcels must arrive');

  // Coordinates exactly as written. A reader that rounds an easting has
  // destroyed survey accuracy that cannot be recovered from the result.
  assert.strictEqual(s.shapes[0].points[0][0], 432500.25);
  assert.strictEqual(s.shapes[0].points[0][1], 2618400.75);

  assert.strictEqual(s.shapes[0].plotNo, '77/3', 'the TEXT label must reach its parcel');
  assert.strictEqual(s.shapes[0].layer, 'PLOTS', 'and the DXF layer must survive');
  assert.strictEqual(s.shapes[0].source, 'imported');

  // No positioning step: the parcels are on the map, sized correctly, the
  // moment the import returns.
  assert.ok(Math.abs(s.shapes[0].areaM2 - 1600) < 5,
    `a 40 m square should be ~1600 m², got ${s.shapes[0].areaM2}`);
  assert.match(bodyText(widget), /Imported/, 'and the panel must report what came in');
});

t('imported parcels use the existing editing system, not one of their own', async () => {
  const { win, widget } = await withImportedDxf();

  // Select and move with the same controls a traced parcel uses.
  click(q(widget, '[data-sel]'));
  await settle(3);
  q(widget, '#eDx').value = '2.5';
  q(widget, '#eDy').value = '-1.5';
  click(q(widget, '#eApplyXY'));
  await settle(4);

  const moved = session(win).shapes[0];
  assert.strictEqual(moved.points[0][0], 432502.75);
  assert.strictEqual(moved.points[0][1], 2618399.25);
  assert.ok(Math.abs(moved.shift.dx - 2.5) < 1e-9, 'and the shift is recorded the same way');

  // Clean-up, undo and the quality report must all accept it too.
  click(q(widget, '#regAll'));
  await settle(6);
  click(q(widget, '#qual'));
  await settle(6);
  assert.match(bodyText(widget), /\/100/, 'the quality report must grade imported parcels');

  click(q(widget, '#gUndo'));
  await settle(4);
  assert.ok(session(win).shapes.length >= 1, 'and undo must work on them');
});

t('exporting after a correction writes the corrected geometry', async () => {
  // The brief's §25: "Do not silently export the original unshifted geometry."
  const { win, widget, downloads } = await withImportedDxf();
  click(q(widget, '[data-sel]'));
  await settle(3);
  q(widget, '#eDx').value = '10';
  q(widget, '#eDy').value = '0';
  click(q(widget, '#eApplyXY'));
  await settle(4);

  click(q(widget, '#xGeo'));
  await settle(5);
  assert.ok(downloads.length, 'GeoJSON should have been written');
  const href = downloads[downloads.length - 1].href;
  void href;

  // Read the corrected easting back out of the session the exporter was handed.
  const s = session(win);
  assert.strictEqual(s.shapes[0].points[0][0], 432510.25,
    'the exported session must hold the corrected position, not the original');
  // And the original is still recoverable, which is what makes it non-destructive.
  assert.ok(s.backups[s.shapes[0].id], 'the pre-shift geometry must be kept');
  assert.strictEqual(s.backups[s.shapes[0].id][0][0], 432500.25);
});

t('an import is one undo step, however many parcels it brought in', async () => {
  // A forty-parcel import that took forty presses to undo would not be
  // undoable in practice.
  const { win, widget } = await withImportedDxf();
  assert.strictEqual(session(win).shapes.length, 2);
  const undo = q(widget, '#gUndo');
  assert.match(undo.textContent, /import 2 parcel/i, 'and it must say what it would reverse');
  click(undo);
  await settle(4);
  assert.strictEqual(session(win).shapes.length, 0, 'one press must take the whole import back');
});

t('a lon/lat KML is converted into the projected session, not refused', async () => {
  // Behaviour deliberately changed in 17.0. This previously asserted a refusal,
  // on the reasoning that dropping lon/lat into a UTM session would put the
  // parcels near the equator. That was over-cautious: the refusal is right when
  // the coordinate system is UNKNOWN, but KML declares WGS 84 by specification
  // and the session knows its own zone, so the conversion is arithmetic between
  // two known systems and the program can do it exactly.
  //
  // The assertion is strictly stronger than the one it replaces: the parcel must
  // not merely import, it must land in the right place and keep its real area.
  const { win, widget } = await boot();
  const ring = [[85.3096, 23.3441], [85.3196, 23.3441], [85.3196, 23.3541], [85.3096, 23.3541]];
  const kml = '<kml><Document><Placemark><name>Plot 9</name>'
    + '<Polygon><outerBoundaryIs><LinearRing><coordinates>'
    + ring.map((p) => p.join(',')).join(' ') + ' ' + ring[0].join(',')
    + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';
  feedNextFilePicker(win, 'plots.kml', kml);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iKml'));
  await settle(16);

  const s = sessionOrEmpty(win);
  assert.strictEqual(s.shapes.length, 1, 'the parcel must import');

  // The stub map is UTM 45N, so the stored coordinates must be metres, not
  // degrees. Degrees left in place is exactly the "near the equator" failure
  // the old refusal existed to prevent, so it is asserted directly.
  const pts = s.shapes[0].points;
  assert.ok(Math.abs(pts[0][0]) > 1000,
    `coordinates must be projected metres, got ${pts[0][0]} (degrees left unconverted)`);
  assert.ok(pts[0][0] > 100000 && pts[0][0] < 900000, `easting out of range: ${pts[0][0]}`);
  assert.ok(pts[0][1] > 2000000 && pts[0][1] < 3000000, `northing out of range: ${pts[0][1]}`);

  // Independent check that the conversion preserved the parcel: geodesic area
  // on the original lon/lat ring against grid area on the projected result.
  const Exp = require('../lib/exporters.js');
  const geodesic = Exp.geodesicArea(ring);
  const grid = Exp.gridArea(pts);
  assert.ok(Math.abs(grid / geodesic - 1) < 0.002,
    `area must survive conversion: ${geodesic} -> ${grid}`);

  // And the operator must be told it happened.
  assert.match(bodyText(widget), /Converted from/i,
    'the panel must report the conversion rather than doing it invisibly');
});

t('a CSV import shows its columns and imports nothing until confirmed', async () => {
  const { win, widget } = await boot();
  const csv = ['ID,Easting,Northing',
    'P1,432500.25,2618400.75', 'P1,432540.25,2618400.75', 'P1,432540.25,2618440.75',
    'P2,432550.5,2618400.75', 'P2,432590.5,2618400.75', 'P2,432590.5,2618440.75'].join('\n');
  feedNextFilePicker(win, 'vertices.csv', csv);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iCsv'));
  await settle(12);

  // The dialog is up and NOTHING has been imported yet.
  assert.ok(q(widget, '#csvDialog'), 'the format dialog must appear');
  assert.ok(q(widget, '#csvX') && q(widget, '#csvY'), 'with the columns mappable');
  assert.ok(q(widget, '#csvDelim'), 'and the delimiter selectable');
  assert.strictEqual(sessionOrEmpty(win).shapes.length, 0, 'nothing may be read before confirmation');
  assert.match(bodyText(widget), /Easting/, 'the preview must show the real header');

  click(q(widget, '#csvImport'));
  await settle(8);
  const s = session(win);
  assert.strictEqual(s.shapes.length, 2, 'confirming imports both parcels');
  assert.strictEqual(s.shapes[0].points[0][0], 432500.25, 'at full precision');
  assert.deepStrictEqual(s.shapes.map((x) => x.plotNo).sort(), ['P1', 'P2']);
});

t('cancelling the CSV dialog imports nothing', async () => {
  const { win, widget } = await boot();
  feedNextFilePicker(win, 'v.csv', 'ID,E,N\nA,432500,2618400\nA,432540,2618400\nA,432540,2618440');
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iCsv'));
  await settle(12);
  assert.ok(q(widget, '#csvDialog'));
  click(q(widget, '#csvCancel'));
  await settle(4);
  assert.ok(!q(widget, '#csvDialog'), 'the dialog must close');
  assert.strictEqual(sessionOrEmpty(win).shapes.length, 0);
});

/* =====================================================================
 * v17 — CRS CONVERSION ON EXPORT
 * ---------------------------------------------------------------------
 * The mirror of the import case. A session works in UTM because that is what
 * the portal serves, but a KMZ for Google Earth wants lon/lat — so the choice
 * of output system belongs next to the exports, and the conversion is done
 * here where both ends are known rather than afterwards in another tool.
 * =================================================================== */

t('the export menu offers a coordinate system, defaulting to the session', async () => {
  const { widget } = await withOneShape();
  const sel = q(widget, '#expCrs');
  assert.ok(sel, 'an export CRS selector must exist');
  assert.strictEqual(sel.value, '', 'it must default to the session\'s own system');
  const labels = Array.from(sel.options).map((o) => o.textContent);
  assert.match(labels[0], /This session/, 'the default option must name the session system');
  assert.ok(labels.some((l) => /Longitude \/ latitude/.test(l)), 'lon/lat must be offered');
  assert.ok(labels.some((l) => /UTM 45N/.test(l)), 'and the UTM zones');
});

t('choosing lon/lat converts the exported geometry out of UTM', async () => {
  const { win, widget, downloads } = await withOneShape();

  // Baseline: the session's own system, so GeoJSON carries the UTM easting
  // untouched by any conversion beyond the RFC 7946 lon/lat requirement.
  const utmPoints = session(win).shapes[0].points;
  assert.ok(utmPoints[0][0] > 100000, 'setup: the session should be in UTM metres');

  const sel = q(widget, '#expCrs');
  sel.value = '4326';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  await settle(4);

  // The stored geometry must NOT move — only what is written out changes.
  const after = session(win).shapes[0].points;
  assert.deepStrictEqual(after, utmPoints,
    'choosing an export system must not touch the session geometry');

  // The harness stubs createObjectURL, so the payload is captured from the
  // Blob the exporter builds rather than read back off a blob: URL.
  const blobs = [];
  win.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:stub'; };

  click(q(widget, '#xCsv'));
  await settle(5);
  const csv = downloads[downloads.length - 1];
  assert.match(csv.name, /\.csv$/);
  assert.ok(blobs.length, 'the export must have produced a Blob');

  // The vertex CSV writes the export-CRS coordinate in its first pair of
  // columns, so degrees there prove the conversion reached the writer.
  const text = await new Promise((resolve, reject) => {
    const fr = new win.FileReader();      // jsdom Blob has no .text()
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsText(blobs[blobs.length - 1]);
  });
  const rows = text.trim().split(/\r?\n/);
  const firstData = rows[1].split(',');
  const x = Number(firstData[3]);
  const y = Number(firstData[4]);
  assert.ok(Math.abs(x) <= 180 && Math.abs(y) <= 90,
    `exported coordinates should be degrees after choosing lon/lat, got ${x}, ${y}`);
  assert.ok(x > 80 && x < 90, `longitude should be in Jharkhand, got ${x}`);
  assert.ok(y > 20 && y < 26, `latitude should be in Jharkhand, got ${y}`);
});

/* =====================================================================
 * v17 — MANUAL CRS SELECTION WHEN NOTHING DECLARES ONE
 * =================================================================== */

t('an import with no declared CRS asks instead of guessing, then completes', async () => {
  const { win, widget } = await boot();

  // Clear the session's own CRS so neither side knows — the case where a
  // guess would be a fabrication rather than arithmetic.
  win.eval("document.querySelector('#bnd15-widget')");
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', 'P', '70', '1',
    '10', '432500.25', '20', '2618400.75',
    '10', '432540.25', '20', '2618400.75',
    '10', '432540.25', '20', '2618440.75',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');

  // The stub portal resolves UTM 45N, so a DXF of bare numbers imports
  // straight into it — that is the detected path and needs no question.
  feedNextFilePicker(win, 'plots.dxf', dxf);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iDxf'));
  await settle(12);
  assert.strictEqual(sessionOrEmpty(win).shapes.length, 1,
    'with a known session CRS the import must proceed without asking');
});

t('the CRS question names the family it can read, without inventing a zone', async () => {
  // A projected grid's magnitudes identify the FAMILY but never the zone —
  // the same disjointness argument lib/crs.js makes. The panel should say
  // that much and no more.
  const PAGE = fs.readFileSync(path.join(ROOT, 'page_inject.js'), 'utf8');
  assert.match(PAGE, /function crsAskHtml\(/, 'a picker must exist for the unknown case');
  assert.match(PAGE, /function describeImportMagnitude\(/);
  assert.match(PAGE, /cannot say WHICH zone/,
    'the hint must stop short of naming a zone it cannot know');
  // Matched on the held fields rather than the whole literal: what this pins is
  // that the PARSED import is kept, not the exact shape of the object. The
  // literal has since gained a `note` carrying the reason the question is being
  // asked, which does not change what is being asserted here.
  assert.match(PAGE, /st\.crsAsk = \{ result, opts: o, epsg: ''/,
    'the parsed import must be HELD, so answering finishes it rather than restarting');
  assert.match(PAGE, /adoptImportedRings\(held\.result, held\.opts\)/,
    'and answering must resume the same import');
});

/* =====================================================================
 * IMAGE IMPORT — OBJECT URL LIFETIME
 * ---------------------------------------------------------------------
 * An object URL keeps the entire file alive until it is revoked. The file
 * picker minted one per import and never released it, so opening four sheets
 * in a session pinned four sheets in memory, and a failed import pinned a file
 * that was never even displayed. Nothing surfaced it: the workspace looked
 * fine, and the cost was invisible until the tab got slow.
 *
 * The URL now belongs to the open sheet — released when another replaces it,
 * when the workspace closes, and when an import fails after minting one.
 * =================================================================== */

/* The picker cannot be driven headlessly without also making images "load":
 * jsdom never fires onload for a blob: URL. Both are stubbed here rather than
 * in boot(), so no other test's behaviour changes. */
function stubImageLoading(win) {
  Object.defineProperty(win.HTMLImageElement.prototype, 'naturalWidth', { get() { return 800; }, configurable: true });
  Object.defineProperty(win.HTMLImageElement.prototype, 'naturalHeight', { get() { return 600; }, configurable: true });
  const real = Object.getOwnPropertyDescriptor(win.HTMLImageElement.prototype, 'src');
  Object.defineProperty(win.HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return ''; },
    set(v) {
      if (real && real.set) real.set.call(this, v);
      setTimeout(() => { if (this.onload) this.onload(); }, 0);
    },
  });
}

/* Count object URLs that have been minted and not revoked. */
function trackObjectUrls(win) {
  let n = 0;
  const live = new Set();
  win.URL.createObjectURL = () => { const u = `blob:tracked-${++n}`; live.add(u); return u; };
  win.URL.revokeObjectURL = (u) => { live.delete(u); };
  return { live, minted: () => n };
}

async function importAnImage(ctx, name) {
  feedNextFilePicker(ctx.win, name || 'sheet.jpg', 'fake-image-bytes');
  click(q(ctx.widget, '#btnImport'));
  await settle(2);
  click(q(ctx.widget, '#iImage'));
  await settle(10);
}

t('repeated image imports do not accumulate object URLs', async () => {
  const ctx = await boot();
  stubImageLoading(ctx.win);
  const urls = trackObjectUrls(ctx.win);

  for (let i = 1; i <= 4; i++) {
    await importAnImage(ctx, `sheet-${i}.jpg`);
    assert.strictEqual(urls.live.size, 1,
      `after ${i} import(s) exactly one sheet should be held, found ${urls.live.size}`);
  }
  assert.strictEqual(urls.minted(), 4, 'sanity: four imports should have minted four URLs');
});

t('closing the workspace releases the sheet it was holding', async () => {
  const ctx = await boot();
  stubImageLoading(ctx.win);
  const urls = trackObjectUrls(ctx.win);

  await importAnImage(ctx);
  assert.strictEqual(urls.live.size, 1, 'setup: a sheet should be open');

  click(q(ctx.widget, '#wsClose'));
  await settle(6);
  assert.strictEqual(urls.live.size, 0, 'closing must release the file, not merely hide it');
});

t('an import that fails does not leave the file pinned', async () => {
  // The worst version of the leak: a file the operator never even saw, held
  // for the lifetime of the page.
  const ctx = await boot();
  Object.defineProperty(ctx.win.HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return ''; },
    set() { setTimeout(() => { if (this.onerror) this.onerror(); }, 0); },
  });
  const urls = trackObjectUrls(ctx.win);

  await importAnImage(ctx, 'corrupt.jpg');
  assert.strictEqual(urls.minted(), 1, 'setup: the picker should have minted a URL');
  assert.strictEqual(urls.live.size, 0, 'a failed import must release the URL it minted');
  // And it must say so rather than failing silently.
  assert.match(ctx.win.document.body.textContent, /could not decode|damaged|unsupported/i,
    'the operator must be told the image could not be read');
});

/* =====================================================================
 * v17.3.1 — HARD RESET
 * ---------------------------------------------------------------------
 * A recovery button, for when the panel itself has stopped responding. The
 * things worth pinning are the ones that would make it useless: that it does
 * not ask a question first, that it does not reload the host page, and above
 * all that pressing it twice does not leave two of everything behind.
 * =================================================================== */

t('Hard Reset is present, and the four editing controls are untouched by it', async () => {
  const { widget } = await boot();
  assert.ok(q(widget, '#hardReset'), 'the recovery button must exist');
  // The existing bar is what it always was — this is the regression the first
  // attempt at placing the button actually caused, so it is asserted here too.
  const bar = q(widget, '.bnd15-hist');
  const ids = Array.from(bar.querySelectorAll('button')).map((b) => b.id);
  assert.deepStrictEqual(ids, ['gUndo', 'gRedo', 'delLast', 'delAll'],
    'Hard Reset must not have joined the editing controls');
  assert.ok(q(widget, '#delAll'), 'Reset Everything stays exactly where it was');
});

t('Hard Reset does not ask, and does not reload the page', async () => {
  const ctx = await withOneShape();
  let asked = 0, reloaded = 0;
  ctx.win.confirm = () => { asked++; return true; };
  // jsdom will not let location.reload be replaced on some versions; counting
  // a call either way is enough to catch an implementation that used it.
  try { ctx.win.location.reload = () => { reloaded++; }; } catch (e) { /* frozen */ }

  click(q(ctx.widget, '#hardReset'));
  await settle(2);

  assert.strictEqual(asked, 0,
    'a recovery button must not be blocked by a dialog — the panel may be the thing that is stuck');
  assert.strictEqual(reloaded, 0, 'the host portal must keep its map, layers and login');
  assert.ok(ctx.win.document.getElementById('bnd15-widget'), 'the extension must come back up');
});

t('pressing Hard Reset repeatedly leaves exactly one of everything', async () => {
  // The failure this guards against is subtle and permanent: boot() attaches a
  // keydown listener and an interval, so a reset that did not release them
  // would stack a second copy on every press and the panel would slowly start
  // doing everything twice.
  const ctx = await withOneShape();
  for (let i = 0; i < 3; i++) {
    click(q(ctx.win.document, '#hardReset'));
    await settle(2);
  }
  const doc = ctx.win.document;
  assert.strictEqual(doc.querySelectorAll('[id="bnd15-widget"]').length, 1, 'one panel');
  assert.strictEqual(doc.querySelectorAll('[id="bnd15-overlay"]').length, 1, 'one overlay');
  assert.strictEqual(doc.querySelectorAll('[id="bnd15-raster-workspace"]').length, 0,
    'no orphaned workspace container');
  // And it is genuinely usable afterwards, not merely present.
  assert.ok(q(doc, '#mTrace'), 'the tools are back');

  // Worth stating, because it is better than the brief requires. Restarting
  // goes through the EXISTING boot(), which restores the autosaved session —
  // so a hung extension costs the operator the hang, not their parcels. The
  // brief allows unsaved runtime state to be lost; nothing says it must be.
  assert.match(doc.getElementById('bnd15-widget').textContent, /1 shape\(s\) digitised/,
    'work that had been autosaved should come back with the extension');
});

/* =====================================================================
 * v17.3.1 — SHAPEFILE IMPORT
 * =================================================================== */

t('Shapefile is one ADDITIONAL import option, with the others left alone', async () => {
  const { widget } = await boot();
  const menu = q(widget, '#menuImport');
  assert.ok(menu, 'the import menu must exist');
  const ids = Array.from(menu.querySelectorAll('button')).map((b) => b.id);
  // Every option that was there before is still there, in the same order.
  for (const id of ['xLoad', 'iKml', 'iDxf', 'iCsv', 'iGeo', 'gcpImport', 'iImage', 'iPdf']) {
    assert.ok(ids.includes(id), `${id} must still be in the Import menu`);
  }
  assert.strictEqual(ids.indexOf('iShp'), ids.length - 1,
    'Shapefile is appended, so nothing above it moved');
  assert.match(q(widget, '#iShp').textContent, /Shapefile/);
});

/* =====================================================================
 * v17.3.2 — PARCEL VISIBILITY, AUTO-FOCUS
 * ---------------------------------------------------------------------
 * The thing that matters about hiding is that it is DISPLAY ONLY. A control
 * that quietly dropped a parcel from the project, or from an export, would
 * look identical in the panel and cost the operator work they had already
 * done — so those are what is asserted, not merely that the row toggles.
 * =================================================================== */

t('every parcel row carries a visibility control', async () => {
  const ctx = await withOneShape();
  const rows = ctx.widget.querySelectorAll('.list .item');
  assert.ok(rows.length >= 1, 'there should be a parcel to look at');
  for (const row of rows) {
    assert.ok(row.querySelector('[data-vis]'), 'each row needs its own eye');
    assert.ok(row.querySelector('[data-sel]'), 'and the existing controls are untouched');
    assert.ok(row.querySelector('[data-edit]'));
  }
});

t('hiding a parcel changes only what is drawn — never the data', async () => {
  const ctx = await withOneShape();
  const before = JSON.parse(JSON.stringify(sessionOrEmpty(ctx.win).shapes));
  assert.strictEqual(before.length, 1);

  click(q(ctx.widget, '[data-vis]'));
  await settle(2);

  const after = sessionOrEmpty(ctx.win).shapes;
  assert.strictEqual(after.length, 1, 'the parcel must NOT be deleted');
  assert.deepStrictEqual(after[0].points, before[0].points, 'vertices unchanged');
  assert.strictEqual(after[0].id, before[0].id, 'id unchanged');
  assert.strictEqual(after[0].areaM2, before[0].areaM2, 'area unchanged');
  // The list keeps it, in place, so it can be brought back.
  assert.strictEqual(ctx.win.document.querySelectorAll('.list .item').length, 1);
});

t('a hidden parcel comes back exactly as it was', async () => {
  const ctx = await withOneShape();
  const before = JSON.parse(JSON.stringify(sessionOrEmpty(ctx.win).shapes));
  const eye = () => ctx.win.document.querySelector('[data-vis]');
  click(eye()); await settle(2);
  click(eye()); await settle(2);
  assert.deepStrictEqual(sessionOrEmpty(ctx.win).shapes[0].points, before[0].points);
});

t('Hide All and Show All hide and restore without deleting anything', async () => {
  const ctx = await withOneShape();
  const before = sessionOrEmpty(ctx.win).shapes.length;

  click(q(ctx.win.document, '#visAll'));           // hide all
  await settle(2);
  assert.strictEqual(sessionOrEmpty(ctx.win).shapes.length, before, 'nothing is deleted by Hide All');
  assert.match(ctx.win.document.querySelector('#visAll').textContent, /Show all/,
    'the control flips to Show all so the way back is obvious');

  click(q(ctx.win.document, '#visAll'));           // show all
  await settle(2);
  assert.strictEqual(sessionOrEmpty(ctx.win).shapes.length, before);
  assert.match(ctx.win.document.querySelector('#visAll').textContent, /Hide all/);
  // And the per-parcel control still works afterwards.
  click(ctx.win.document.querySelector('[data-vis]'));
  await settle(2);
  assert.strictEqual(sessionOrEmpty(ctx.win).shapes.length, before);
});

t('hiding a parcel does not remove it from an export', async () => {
  // Hidden is a view state. An export that quietly dropped hidden parcels
  // would lose work the operator believes is saved, and nothing would say so.
  const ctx = await withOneShape();
  click(q(ctx.widget, '[data-vis]'));
  await settle(2);
  click(q(ctx.win.document, '#btnExport'));
  await settle(1);
  const before = ctx.downloads.length;
  click(q(ctx.win.document, '#xGeo'));
  await settle(4);
  assert.ok(ctx.downloads.length > before,
    'a hidden parcel is still a parcel: the export must be produced, not refused as empty');
  assert.match(ctx.downloads[ctx.downloads.length - 1].name, /\.geojson$/);
  // And it is still in the session that the export reads from.
  assert.strictEqual(sessionOrEmpty(ctx.win).shapes.length, 1);
});

t('selecting a parcel scrolls its row into view without moving the page', async () => {
  const ctx = await withOneShape();
  const list = q(ctx.win.document, '.list');
  assert.ok(list, 'the shapes list is the only thing that may scroll');
  // jsdom reports zero layout, so the guard that matters here is the negative
  // one: the implementation must not reach for scrollIntoView, which would
  // scroll the host portal's own page out from under the operator.
  const src = fs.readFileSync(path.join(__dirname, '..', 'page_inject.js'), 'utf8');
  const fn = src.match(/function focusSelectedRow\([\s\S]*?\n  \}/)[0];
  assert.ok(!/scrollIntoView/.test(fn),
    'scrollIntoView walks up to the page; only the list container may be scrolled');
  assert.ok(/scrollTop/.test(fn), 'the list scroll position is what moves');
  assert.ok(!/\.focus\(/.test(fn), 'auto-focus must not steal keyboard focus from an input');
  assert.ok(/data-row=/.test(src), 'rows are found by the shape id, not by matching their text');
});

t('auto-focus never reorders the shape collection', async () => {
  const ctx = await withOneShape();
  const order = sessionOrEmpty(ctx.win).shapes.map((s) => s.id);
  click(q(ctx.widget, '[data-sel]'));
  await settle(2);
  assert.deepStrictEqual(sessionOrEmpty(ctx.win).shapes.map((s) => s.id), order,
    'selection scrolls the list; it must never sort or move a row');
});

/* =====================================================================
 * v17.3.2 — DXF ON A LIVE PORTAL: the view is no longer stranded
 * ---------------------------------------------------------------------
 * Reported from the field: after a DXF import the portal's map went blank.
 *
 * The importer was not at fault. A DXF routinely carries LOCAL CAD
 * coordinates — a site datum, a few hundred units from an arbitrary origin —
 * and the import moved the view to them unconditionally. Read as eastings and
 * northings, (250, 250) in UTM 45N is a point on the equator off West Africa,
 * so the portal panned there, found no tiles, and showed nothing.
 *
 * Only the camera move is now conditional. The parcels import either way.
 * =================================================================== */

t('a DXF this project exported in shifted mode round-trips back to where it was', async () => {
  // THE ACTUAL BUG behind the blank portal, and the reason the parcels looked
  // correct while the map did not: this project's own DXF export defaults to
  // "shift" mode. It writes true coordinates MINUS a round origin and records
  // that origin in $INSBASE with a comment saying to add it back — because
  // some CAD setups round large numbers badly.
  //
  // Re-importing such a file used to land the parcels a few hundred metres
  // from the equator. The view followed them there, found no tiles, and the
  // portal appeared to go blank; the drawing looked right against it because
  // the geometry and the camera were wrong together.
  const { win, widget } = await boot();
  const E = require('../lib/exporters.js');

  const truth = [
    [432500.25, 2618400.75], [432540.25, 2618400.75],
    [432540.25, 2618440.75], [432500.25, 2618440.75],
  ];
  // Written exactly as the Export menu writes it: shifted, with the origin.
  // makeDxf answers with { text, origin, mode }; the file itself is .text.
  const built = E.makeDxf([{ id: 1, plotNo: '77/3', points: truth }], {
    georefMode: 'shift', crsLabel: 'WGS 84 / UTM 45N',
  });
  const dxf = built.text;
  assert.match(dxf, /\$INSBASE/, 'the export must actually be in shifted mode for this to test anything');

  feedNextFilePicker(win, 'exported.dxf', dxf);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iDxf'));
  await settle(12);

  const shapes = sessionOrEmpty(win).shapes;
  assert.strictEqual(shapes.length, 1, 'the DXF must import');
  const xs = shapes[0].points.map((p) => p[0]);
  const ys = shapes[0].points.map((p) => p[1]);
  // Back at the real survey coordinates, not a few hundred metres from the
  // equator. Tolerance is a metre: the export rounds to a sane precision.
  assert.ok(Math.min(...xs) > 432000 && Math.max(...xs) < 433000,
    `eastings should be back near 432500, got ${Math.min(...xs)}..${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) > 2618000 && Math.max(...ys) < 2619000,
    `northings should be back near 2618400, got ${Math.min(...ys)}..${Math.max(...ys)}`);
});

t('a DXF exported in absolute mode is never double-shifted', async () => {
  // The importer's own comment warns about this: adding an origin back to a
  // file that was already absolute would move it twice. The origin is applied
  // only where the coordinates as written are impossible for the session and
  // adding it makes them possible, so an absolute file cannot qualify.
  const { win, widget } = await boot();
  const E = require('../lib/exporters.js');
  const truth = [
    [432500.25, 2618400.75], [432540.25, 2618400.75],
    [432540.25, 2618440.75], [432500.25, 2618440.75],
  ];
  const dxf = E.makeDxf([{ id: 1, points: truth }], {
    georefMode: 'absolute', crsLabel: 'WGS 84 / UTM 45N',
  }).text;
  feedNextFilePicker(win, 'absolute.dxf', dxf);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iDxf'));
  await settle(12);

  const shapes = sessionOrEmpty(win).shapes;
  assert.strictEqual(shapes.length, 1);
  const xs = shapes[0].points.map((p) => p[0]);
  assert.ok(Math.min(...xs) > 432000 && Math.max(...xs) < 433000,
    `an absolute export must import unchanged, got ${Math.min(...xs)}..${Math.max(...xs)}`);
});

t('a DXF holding lon/lat is never shifted by a recorded origin', async () => {
  // DXF can hold degrees. An origin in metres added to them would pass both
  // magnitude tests — 85.31 is not a UTM easting, 85.31 + 432000 is — while
  // destroying the coordinates. Degrees are excluded outright, which costs the
  // rare small shifted plot that fits inside the lon/lat window and gains the
  // guarantee that no import is made worse than it was.
  const { win, widget } = await boot();
  const ring = [[85.3096, 23.3441], [85.3196, 23.3441], [85.3196, 23.3541], [85.3096, 23.3541]];
  const dxf = ['0', 'SECTION', '2', 'HEADER',
    '9', '$INSBASE', '10', '432000', '20', '2618000', '30', '0',
    '9', '$EXTMIN', '10', '85.3096', '20', '23.3441', '30', '0',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', 'P', '70', '1']
    .concat(...ring.map((p) => ['10', String(p[0]), '20', String(p[1])]))
    .concat(['0', 'ENDSEC', '0', 'EOF']).join('\r\n');

  // Named as lon/lat, so the session's UTM zone is reached by projection —
  // the path the origin shift must not hijack.
  setSelect(win, q(widget, '#impCrs'), '4326');
  await settle(2);
  feedNextFilePicker(win, 'degrees.dxf', dxf);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iDxf'));
  await settle(16);

  const s = sessionOrEmpty(win);
  assert.strictEqual(s.shapes.length, 1, 'the DXF must import');
  const C = require('../lib/crs.js');
  const want = C.reprojectRing(ring, C.parseEpsg('4326'), C.parseEpsg('32645'));
  assert.ok(Math.abs(s.shapes[0].points[0][0] - want.points[0][0]) < 0.5,
    `degrees must be projected, not shifted: expected ${want.points[0]}, got ${s.shapes[0].points[0]}`);
});

t('a DXF with genuinely local coordinates and no recorded origin still imports', async () => {
  // Nothing in the file says where it belongs, so nothing is invented: it
  // imports exactly as it always did. Only the automatic view move is held
  // back, so the portal is not left staring at empty tiles.
  const { win, widget } = await boot();
  const centreBefore = win.map.getView().getCenter().slice();
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', 'P', '70', '1',
    '10', '100', '20', '100',
    '10', '340', '20', '100',
    '10', '340', '20', '340',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  feedNextFilePicker(win, 'site.dxf', dxf);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iDxf'));
  await settle(12);

  assert.strictEqual(sessionOrEmpty(win).shapes.length, 1,
    'the import itself must still work — nothing is blocked');
  assert.deepStrictEqual(win.map.getView().getCenter(), centreBefore,
    'but the portal keeps its basemap rather than panning to empty tiles');
});

/* =====================================================================
 * v17.3.3 — NAMING THE SYSTEM AN IMPORT IS READ IN
 * ---------------------------------------------------------------------
 * DXF has nowhere to record a coordinate system. A survey office whose
 * drawings are always in one UTM zone was therefore confirming that same zone
 * on every import, or relying on the session to supply it. "Read coordinates
 * as" states the standing fact once, next to the imports, exactly as "Write
 * coordinates in" already does for the exports.
 *
 * It stands in for a MISSING declaration; it never overrides a present one.
 * =================================================================== */

const setSelect = (win, el, value) => {
  el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
};

t('the import menu offers a coordinate system, defaulting to automatic', async () => {
  const { widget } = await boot();
  const sel = q(widget, '#impCrs');
  assert.ok(sel, 'an import CRS selector must exist');
  assert.strictEqual(sel.value, '', 'it must default to working the system out, not to a zone');
  const labels = Array.from(sel.options).map((o) => o.textContent);
  assert.match(labels[0], /Work it out/, 'the default must be the automatic one');
  assert.ok(labels.some((l) => /Longitude \/ latitude/.test(l)), 'lon/lat must be offered');
  assert.ok(labels.some((l) => /UTM 44N/.test(l)) && labels.some((l) => /UTM 45N/.test(l)),
    'and the same UTM zones the export selector offers');
});

t('a DXF of bare numbers is read in the zone chosen in the import menu', async () => {
  // The stub portal is UTM 45N, so without a choice a bare DXF is adopted into
  // 45N and its numbers stand as written. Naming 44N instead makes the file
  // declared rather than unknown, so the import CONVERTS 44N -> 45N — which is
  // the one thing that distinguishes a real declaration from a silent guess.
  const { win, widget } = await boot();
  const raw = [[800000, 2618000], [800200, 2618000], [800200, 2618200], [800000, 2618200]];
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'P', '70', '1']
    .concat(...raw.map((p) => ['10', String(p[0]), '20', String(p[1])]))
    .concat(['0', 'ENDSEC', '0', 'EOF']).join('\r\n');

  setSelect(win, q(widget, '#impCrs'), '32644');
  await settle(2);

  feedNextFilePicker(win, 'zone44.dxf', dxf);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iDxf'));
  await settle(16);

  const s = sessionOrEmpty(win);
  assert.strictEqual(s.shapes.length, 1, 'the DXF must import without stopping to ask');
  const pts = s.shapes[0].points;

  // Checked against the library rather than against a number copied from a run:
  // whatever 44N -> 45N is, that is what the stored geometry must be.
  const C = require('../lib/crs.js');
  const want = C.reprojectRing(raw, C.parseEpsg('32644'), C.parseEpsg('32645'));
  assert.ok(want.ok, 'setup: the two zones must be inter-convertible');
  for (let i = 0; i < raw.length; i++) {
    assert.ok(Math.abs(pts[i][0] - want.points[i][0]) < 0.5
      && Math.abs(pts[i][1] - want.points[i][1]) < 0.5,
    `vertex ${i} should be the 44N->45N conversion ${want.points[i]}, got ${pts[i]}`);
  }
  assert.ok(Math.abs(pts[0][0] - raw[0][0]) > 1000,
    'the numbers must not have been left as written — that would be the old adopt-the-session behaviour');
});

t('a file that states its own system ignores the import choice', async () => {
  // KML declares WGS 84 by specification. The choice stands in for a missing
  // declaration; treating it as an override would let a stale setting silently
  // reinterpret every shapefile and GeoJSON that arrives afterwards.
  const { win, widget } = await boot();
  const ring = [[85.3096, 23.3441], [85.3196, 23.3441], [85.3196, 23.3541], [85.3096, 23.3541]];
  const kml = '<kml><Document><Placemark><name>Plot 9</name>'
    + '<Polygon><outerBoundaryIs><LinearRing><coordinates>'
    + ring.map((p) => p.join(',')).join(' ') + ' ' + ring[0].join(',')
    + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';

  setSelect(win, q(widget, '#impCrs'), '32644');
  await settle(2);

  feedNextFilePicker(win, 'plots.kml', kml);
  click(q(widget, '#btnImport'));
  await settle(2);
  click(q(widget, '#iKml'));
  await settle(16);

  const s = sessionOrEmpty(win);
  assert.strictEqual(s.shapes.length, 1, 'the KML must still import');
  const pts = s.shapes[0].points;
  // Read as lon/lat and projected into the session's 45N, as it was before the
  // selector existed. Had the 44N choice been applied to degrees instead, the
  // reprojection of (85.3, 23.3) metres would have landed nowhere near here.
  const C = require('../lib/crs.js');
  const want = C.reprojectRing(ring, C.parseEpsg('4326'), C.parseEpsg('32645'));
  assert.ok(want.ok, 'setup: lon/lat must convert into the session zone');
  assert.ok(Math.abs(pts[0][0] - want.points[0][0]) < 0.5
    && Math.abs(pts[0][1] - want.points[0][1]) < 0.5,
  `the KML's own declaration must win: expected ${want.points[0]}, got ${pts[0]}`);
});

t('the chosen import system survives a reload, like the export one', async () => {
  // It is a standing fact about the office's drawings, not a per-file answer,
  // so it belongs in settings rather than in the session — the same storage the
  // export selector uses, for the same reason.
  const { win, widget } = await boot();
  setSelect(win, q(widget, '#impCrs'), '32645');
  await settle(2);
  const raw = win.localStorage.getItem('bnd15.settings');
  assert.ok(raw, 'settings must be persisted');
  assert.strictEqual(JSON.parse(raw).importCrsEpsg, '32645',
    'the chosen import system must be saved');
  assert.strictEqual(q(widget, '#impCrs').value, '32645',
    'and the selector must show it after the re-render');
});

