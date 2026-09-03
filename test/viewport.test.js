/* =========================================================================
 * Tests for lib/viewport.js
 *
 * The properties that matter are all round-trips and invariants, so they can be
 * asserted exactly rather than approximately: a screen point converted to image
 * space and back must be unchanged, and zooming about a cursor must leave the
 * image point under that cursor exactly where it was.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/viewport.js');

const IMG = { imageWidth: 2000, imageHeight: 1500 };
const VIEW = { viewWidth: 800, viewHeight: 600 };

function vp(extra) {
  return V.createViewport(Object.assign({}, IMG, VIEW, extra));
}

/* =====================================================================
 * FIT AND INITIAL STATE
 * =================================================================== */

test('a new viewport fits the whole image and centres it', () => {
  const v = vp({ padding: 0 });
  // 800/2000 = 0.4, 600/1500 = 0.4 — both axes agree here.
  assert.ok(Math.abs(v.scale - 0.4) < 1e-12, `scale ${v.scale}`);
  assert.deepStrictEqual(v.centre, [1000, 750]);
  // The image corners must land on the view corners.
  const tl = v.toScreen(0, 0);
  const br = v.toScreen(2000, 1500);
  assert.ok(Math.abs(tl[0]) < 1e-9 && Math.abs(tl[1]) < 1e-9, `top-left ${tl}`);
  assert.ok(Math.abs(br[0] - 800) < 1e-9 && Math.abs(br[1] - 600) < 1e-9, `bottom-right ${br}`);
});

test('fit uses the more constrained axis, so nothing is cropped', () => {
  // A wide image in a tall view must be limited by width.
  const wide = V.createViewport({ imageWidth: 4000, imageHeight: 500, viewWidth: 800, viewHeight: 600, padding: 0 });
  assert.ok(Math.abs(wide.scale - 0.2) < 1e-12, `scale ${wide.scale}`);
  const br = wide.toScreen(4000, 500);
  assert.ok(br[0] <= 800 + 1e-9 && br[1] <= 600 + 1e-9, 'image must fit inside the view');

  const tall = V.createViewport({ imageWidth: 500, imageHeight: 4000, viewWidth: 800, viewHeight: 600, padding: 0 });
  assert.ok(Math.abs(tall.scale - 0.15) < 1e-12, `scale ${tall.scale}`);
});

test('zoom is expressed in halving/doubling steps, like a slippy map', () => {
  const v = vp();
  v.setScale(1);
  assert.ok(Math.abs(v.getZoom()) < 1e-12, 'scale 1 is zoom 0');
  v.setScale(4);
  assert.ok(Math.abs(v.getZoom() - 2) < 1e-12, 'scale 4 is zoom 2');
  v.setZoom(3);
  assert.ok(Math.abs(v.scale - 8) < 1e-12, 'zoom 3 is scale 8');
  // Round-trip across the usable range.
  for (const z of [-3, -1, 0, 1.5, 4]) {
    v.setZoom(z);
    assert.ok(Math.abs(v.getZoom() - z) < 1e-12, `zoom ${z} round-trip gave ${v.getZoom()}`);
  }
});

/* =====================================================================
 * COORDINATE ROUND-TRIPS
 * =================================================================== */

test('screen <-> image round-trips exactly at every zoom', () => {
  const v = vp();
  for (const z of [-2, -1, 0, 1, 3, 5]) {
    v.setZoom(z);
    for (const [sx, sy] of [[0, 0], [123, 456], [400, 300], [799, 599]]) {
      const img = v.toImage(sx, sy);
      const back = v.toScreen(img[0], img[1]);
      assert.ok(Math.abs(back[0] - sx) < 1e-9, `zoom ${z}: x ${sx} -> ${back[0]}`);
      assert.ok(Math.abs(back[1] - sy) < 1e-9, `zoom ${z}: y ${sy} -> ${back[1]}`);
    }
  }
});

test('the view centre always maps to the image centre coordinate', () => {
  const v = vp();
  v.setZoom(2).setCentre([600, 400]);
  const mid = v.toImage(400, 300);
  assert.ok(Math.abs(mid[0] - 600) < 1e-9, `x ${mid[0]}`);
  assert.ok(Math.abs(mid[1] - 400) < 1e-9, `y ${mid[1]}`);
});

test('image y increases downward, as rasters do', () => {
  const v = vp({ padding: 0 });
  const top = v.toScreen(1000, 0);
  const bottom = v.toScreen(1000, 1500);
  assert.ok(bottom[1] > top[1],
    'a larger image y must appear lower on screen, not higher');
});

/* =====================================================================
 * ZOOM ABOUT A POINT — the property that makes wheel-zoom feel right
 * =================================================================== */

test('zooming about a cursor pins the image point under it', () => {
  const v = vp();
  for (const [sx, sy] of [[0, 0], [200, 150], [400, 300], [800, 600]]) {
    v.setZoom(0).setCentre([1000, 750]);
    const before = v.toImage(sx, sy);
    v.zoomAt(sx, sy, 2);
    const after = v.toImage(sx, sy);
    assert.ok(Math.abs(after[0] - before[0]) < 1e-9,
      `zoom in at ${sx},${sy}: image x moved ${after[0] - before[0]}`);
    assert.ok(Math.abs(after[1] - before[1]) < 1e-9,
      `zoom in at ${sx},${sy}: image y moved ${after[1] - before[1]}`);
  }
});

test('zooming out about a cursor also pins it', () => {
  const v = vp();
  v.setZoom(3).setCentre([1000, 750]);
  const before = v.toImage(650, 120);
  v.zoomAt(650, 120, 0.5);
  const after = v.toImage(650, 120);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-9, `x moved ${after[0] - before[0]}`);
  assert.ok(Math.abs(after[1] - before[1]) < 1e-9, `y moved ${after[1] - before[1]}`);
});

test('zoom is bounded, and hitting a bound does not corrupt the centre', () => {
  const v = vp();
  for (let i = 0; i < 40; i++) v.zoomAt(400, 300, 2);
  assert.ok(v.scale <= V.MAX_SCALE + 1e-9, `scale ${v.scale} exceeded the maximum`);
  assert.ok(isFinite(v.centre[0]) && isFinite(v.centre[1]), 'centre must stay finite');
  for (let i = 0; i < 80; i++) v.zoomAt(400, 300, 0.5);
  assert.ok(v.scale >= V.MIN_SCALE - 1e-12, `scale ${v.scale} below the minimum`);
  assert.ok(isFinite(v.centre[0]) && isFinite(v.centre[1]));
});

/* =====================================================================
 * PANNING
 * =================================================================== */

test('panning moves the image with the drag, at any zoom', () => {
  const v = vp();
  v.setZoom(1).setCentre([1000, 750]);
  const before = v.toScreen(1000, 750);
  v.panByScreen(50, -30);
  const after = v.toScreen(1000, 750);
  assert.ok(Math.abs(after[0] - (before[0] + 50)) < 1e-9,
    'dragging right must move the image right');
  assert.ok(Math.abs(after[1] - (before[1] - 30)) < 1e-9,
    'dragging up must move the image up');
});

test('a pan of one screen pixel moves less image space the further you zoom in', () => {
  const v = vp();
  v.setZoom(0);
  const c0 = v.centre;
  v.panByScreen(10, 0);
  const shallow = Math.abs(v.centre[0] - c0[0]);
  v.setZoom(4);
  const c1 = v.centre;
  v.panByScreen(10, 0);
  const deep = Math.abs(v.centre[0] - c1[0]);
  assert.ok(deep < shallow, `zoomed in, the same drag should move less image space: ${deep} vs ${shallow}`);
});

/* =====================================================================
 * CLAMPING — the sheet must never be lost off screen
 * =================================================================== */

test('an image smaller than the view stays pinned centred', () => {
  const v = V.createViewport({ imageWidth: 100, imageHeight: 80, viewWidth: 800, viewHeight: 600 });
  v.setScale(1);
  v.panByScreen(5000, 5000);
  assert.deepStrictEqual(v.centre, [50, 40], 'a small image cannot be panned away');
});

test('a large image cannot be panned entirely out of view', () => {
  const v = vp();
  v.setZoom(3);
  v.panByScreen(100000, 100000);
  assert.ok(v.isVisible(0, 0) || v.isVisible(2000, 1500) ||
            v.visibleImageRect().maxX > v.visibleImageRect().minX,
    'some part of the image must remain reachable');
  const r = v.visibleImageRect();
  assert.ok(r.maxX > r.minX && r.maxY > r.minY, `visible rect collapsed: ${JSON.stringify(r)}`);
});

test('resizing the view keeps the centre valid', () => {
  const v = vp();
  v.setZoom(2).setCentre([1500, 1200]);
  v.setViewSize(200, 150);
  assert.ok(isFinite(v.centre[0]) && isFinite(v.centre[1]));
  const r = v.visibleImageRect();
  assert.ok(r.maxX > r.minX && r.maxY > r.minY);
});

/* =====================================================================
 * VISIBLE REGION — used to decide what to rasterise for tracing
 * =================================================================== */

test('the visible rectangle is clipped to the image bounds', () => {
  const v = vp({ padding: 0 });
  const r = v.visibleImageRect();
  assert.strictEqual(r.minX, 0);
  assert.strictEqual(r.minY, 0);
  assert.strictEqual(r.maxX, 2000);
  assert.strictEqual(r.maxY, 1500);
});

test('the visible rectangle shrinks as you zoom in', () => {
  const v = vp();
  v.setZoom(0);
  const wide = v.visibleImageRect();
  v.setZoom(3);
  const tight = v.visibleImageRect();
  const areaOf = (r) => (r.maxX - r.minX) * (r.maxY - r.minY);
  assert.ok(areaOf(tight) < areaOf(wide),
    `zoomed in should see less: ${areaOf(tight)} vs ${areaOf(wide)}`);
});

test('isVisible agrees with the screen transform', () => {
  const v = vp({ padding: 0 });
  assert.strictEqual(v.isVisible(1000, 750), true, 'the centre is visible');
  v.setZoom(4).setCentre([100, 100]);
  assert.strictEqual(v.isVisible(1900, 1400), false, 'a far corner is not');
});

test('pixel accuracy is reported honestly', () => {
  const v = vp();
  v.setScale(4);
  assert.ok(Math.abs(v.imagePixelsPerScreenPixel() - 0.25) < 1e-12,
    'magnifying: each screen pixel covers a quarter of an image pixel');
  v.setScale(0.25);
  assert.ok(Math.abs(v.imagePixelsPerScreenPixel() - 4) < 1e-12,
    'decimating: each screen pixel covers four image pixels, so clicks are not pixel-accurate');
});

/* =====================================================================
 * DEGENERATE INPUT
 * =================================================================== */

test('degenerate sizes do not produce NaN', () => {
  for (const o of [
    { imageWidth: 0, imageHeight: 0, viewWidth: 0, viewHeight: 0 },
    { imageWidth: 1, imageHeight: 1, viewWidth: 800, viewHeight: 600 },
    {},
  ]) {
    const v = V.createViewport(o);
    assert.ok(isFinite(v.scale) && v.scale > 0, `scale ${v.scale} for ${JSON.stringify(o)}`);
    assert.ok(isFinite(v.centre[0]) && isFinite(v.centre[1]));
    const img = v.toImage(10, 10);
    assert.ok(isFinite(img[0]) && isFinite(img[1]));
  }
});
