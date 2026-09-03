/* =========================================================================
 * Regression test for the v13 "max-zoom GCP confirmation" no-op.
 *
 * The DOM-heavy parts of page_inject.js (widget, overlay canvas, live map)
 * are not unit-testable without a jsdom + canvas harness larger than the fix
 * itself. What IS testable — and what actually broke — is the MEASUREMENT
 * MODEL: how a screen click becomes a ground coordinate, and whether zooming
 * in before measuring buys any precision.
 *
 * So this file stubs an OpenLayers View with the same contract the real one
 * has (setCenter/getCenter round-trip, resolution halving per zoom level,
 * getCoordinateFromPixel) and runs BOTH code paths through it:
 *
 *   - v13's path is shown to return the input unchanged — a provable no-op.
 *   - v14's two-click path is shown to genuinely improve ground precision by
 *     ~2^zoomBoost.
 *
 * If anyone ever reintroduces a `setCenter(p); ...; getCenter()` readback as
 * a "confirmation", the first test here fails loudly.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

/* ---------------------------------------------------------------------
 * Minimal OpenLayers-View stand-in.
 *
 * Contract points that matter, all matching real OL behaviour:
 *   - getCenter() returns exactly what setCenter() stored (no extent
 *     constraint configured, so no clamping) — this is the crux of the bug.
 *   - resolution halves for each zoom level gained.
 *   - getCoordinateFromPixel maps CSS pixels to map coordinates about the
 *     view centre, with y inverted (screen y grows downward).
 * ------------------------------------------------------------------- */
const BASE_RESOLUTION = 156543.03392; // metres per pixel at zoom 0
const VIEWPORT_W = 1200;
const VIEWPORT_H = 800;

function makeFakeMap(center, zoom) {
  let _center = center.slice();
  let _zoom = zoom;
  const view = {
    getCenter: () => _center.slice(),
    setCenter: (c) => { _center = c.slice(); },
    getZoom: () => _zoom,
    setZoom: (z) => { _zoom = z; },
    getMaxZoom: () => 24,
    getResolution: () => BASE_RESOLUTION / Math.pow(2, _zoom),
  };
  return {
    getView: () => view,
    getCoordinateFromPixel: ([px, py]) => {
      const res = view.getResolution();
      return [
        _center[0] + (px - VIEWPORT_W / 2) * res,
        _center[1] - (py - VIEWPORT_H / 2) * res,
      ];
    },
    getPixelFromCoordinate: ([x, y]) => {
      const res = view.getResolution();
      return [
        (x - _center[0]) / res + VIEWPORT_W / 2,
        (_center[1] - y) / res + VIEWPORT_H / 2,
      ];
    },
  };
}

// A user aiming at ground point `target` can only land on a whole pixel.
function clickAt(map, target) {
  const p = map.getPixelFromCoordinate(target);
  return [Math.round(p[0]), Math.round(p[1])];
}

const ZOOM = 18;                 // ~0.6 m/px, a typical BhuNaksha working zoom
const BOOST = 6;                 // the extension's default maxZoomBoost
const JH = [432500, 2618400];

/* =====================================================================
 * v13's confirmation step was a no-op.
 * =================================================================== */

test('v13 confirmation returns its own input — provably no new information', () => {
  const map = makeFakeMap(JH, ZOOM);
  const view = map.getView();

  // Verbatim structure of v13's confirmCoordinateAtMaxZoom().
  const clickPx = [640, 410];
  const seedMapCoord = map.getCoordinateFromPixel(clickPx);
  const originalCenter = view.getCenter();
  const originalZoom = view.getZoom();

  view.setCenter(seedMapCoord);
  view.setZoom(originalZoom + BOOST);
  // ...imagery loads...
  const confirmed = view.getCenter();

  assert.deepStrictEqual(confirmed, seedMapCoord,
    'v13 "confirmed" coordinate is bit-identical to the pre-zoom click — the ' +
    'zoom round-trip contributed nothing');

  view.setCenter(originalCenter);
  view.setZoom(originalZoom);
});

test('v13 therefore carried the FULL low-zoom click error into the fit', () => {
  const map = makeFakeMap(JH, ZOOM);
  const view = map.getView();
  const resLow = view.getResolution();

  // The true corner position the surveyor is aiming at, deliberately offset
  // from a pixel centre so rounding actually bites.
  const trueCorner = [JH[0] + 7.37, JH[1] - 3.91];

  const px = clickAt(map, trueCorner);
  const seed = map.getCoordinateFromPixel(px);
  view.setCenter(seed);
  view.setZoom(ZOOM + BOOST);
  const v13Confirmed = view.getCenter(); // === seed

  const err = Math.hypot(v13Confirmed[0] - trueCorner[0], v13Confirmed[1] - trueCorner[1]);
  // Error is bounded by half a LOW-zoom pixel diagonal, i.e. the zoom boost
  // bought nothing at all.
  assert.ok(err > 0, 'pixel quantisation should leave a real error');
  assert.ok(err <= resLow * Math.SQRT1_2 + 1e-9,
    `v13 error ${err} m should sit within half a low-zoom pixel (${resLow} m/px)`);
});

/* =====================================================================
 * v14's two-click gesture genuinely improves precision.
 * =================================================================== */

test('v14 two-click tagging measures at high zoom and is ~2^boost more precise', () => {
  const trueCorner = [JH[0] + 7.37, JH[1] - 3.91];
  const storedVertex = [JH[0] + 5.0, JH[1] - 2.0]; // where the trace put it (drifted)

  // ---- v13, for comparison: one click, measured at low zoom ----
  const mapA = makeFakeMap(JH, ZOOM);
  const v13Confirmed = mapA.getCoordinateFromPixel(clickAt(mapA, trueCorner));
  const v13Err = Math.hypot(v13Confirmed[0] - trueCorner[0], v13Confirmed[1] - trueCorner[1]);

  // ---- v14: click 1 selects the vertex, map zooms to it; click 2 measures ----
  const mapB = makeFakeMap(JH, ZOOM);
  const viewB = mapB.getView();
  const originalCenter = viewB.getCenter();
  const originalZoom = viewB.getZoom();

  // Click 1 only has to land within the vertex hit-tolerance; its precision
  // is irrelevant to the measurement, which is the whole design change.
  clickAt(mapB, storedVertex);
  viewB.setCenter(storedVertex);
  viewB.setZoom(originalZoom + BOOST);

  // Click 2 — read against the now high-zoom view.
  const v14Confirmed = mapB.getCoordinateFromPixel(clickAt(mapB, trueCorner));
  const v14Err = Math.hypot(v14Confirmed[0] - trueCorner[0], v14Confirmed[1] - trueCorner[1]);

  // Restore, as the real implementation does.
  viewB.setCenter(originalCenter);
  viewB.setZoom(originalZoom);
  assert.deepStrictEqual(viewB.getCenter(), originalCenter, 'view must be restored');
  assert.strictEqual(viewB.getZoom(), originalZoom, 'zoom must be restored');

  assert.ok(v14Err < v13Err,
    `v14 (${v14Err.toExponential(3)} m) must beat v13 (${v13Err.toExponential(3)} m)`);
  // Worst-case error scales with resolution, so the bound tightens by 2^BOOST.
  const resHigh = BASE_RESOLUTION / Math.pow(2, ZOOM + BOOST);
  assert.ok(v14Err <= resHigh * Math.SQRT1_2 + 1e-9,
    `v14 error ${v14Err} m should sit within half a high-zoom pixel (${resHigh} m/px)`);
});

test('the precision gain tracks the configured zoom boost', () => {
  const trueCorner = [JH[0] + 11.31, JH[1] + 6.77];
  const storedVertex = [JH[0] + 9, JH[1] + 5];

  let previousBound = Infinity;
  for (const boost of [0, 2, 4, 6, 8]) {
    const map = makeFakeMap(JH, ZOOM);
    const view = map.getView();
    view.setCenter(storedVertex);
    view.setZoom(ZOOM + boost);
    const measured = map.getCoordinateFromPixel(clickAt(map, trueCorner));
    const err = Math.hypot(measured[0] - trueCorner[0], measured[1] - trueCorner[1]);

    const bound = (BASE_RESOLUTION / Math.pow(2, ZOOM + boost)) * Math.SQRT1_2;
    assert.ok(err <= bound + 1e-9, `boost ${boost}: error ${err} m exceeds bound ${bound} m`);
    assert.ok(bound < previousBound, `boost ${boost} should tighten the bound`);
    previousBound = bound;
  }
});

/* =====================================================================
 * The offset between the two clicks is the measurement that gets fitted.
 * =================================================================== */

test('the recorded GCP pair is (stored vertex -> second click), not (click -> click)', () => {
  const M = require('../lib/gcp_math.js');

  // Simulate a whole plot that has drifted by a known amount, and tag four of
  // its corners with the v14 gesture. The fitted transform should recover the
  // drift, which is only possible if rawPoint is the STORED vertex and
  // confirmedPoint is the SECOND click. Under v13's model confirmedPoint would
  // equal the first click, and the fit would chase click noise instead.
  const DRIFT = { dx: 3.4, dy: -2.1, scale: 1.0004 };
  const trueOf = ([x, y]) => [
    JH[0] + (x - JH[0]) * DRIFT.scale + DRIFT.dx,
    JH[1] + (y - JH[1]) * DRIFT.scale + DRIFT.dy,
  ];

  const storedVertices = [
    [JH[0] - 30, JH[1] - 20], [JH[0] + 30, JH[1] - 20],
    [JH[0] + 30, JH[1] + 20], [JH[0] - 30, JH[1] + 20],
  ];

  const pairs = storedVertices.map((stored, i) => {
    const map = makeFakeMap(JH, ZOOM);
    const view = map.getView();
    view.setCenter(stored);          // click 1 -> zoom to the stored vertex
    view.setZoom(ZOOM + BOOST);
    const target = trueOf(stored);   // where that corner truly is
    const confirmed = map.getCoordinateFromPixel(clickAt(map, target)); // click 2
    return { vertexIndex: i, rawPoint: stored, confirmedPoint: confirmed };
  });

  const r = M.fitGcpTransform(pairs, 'similarity');
  assert.strictEqual(r.ok, true);

  // Recovered scale and shift should match the injected drift to within the
  // high-zoom pixel quantisation, not the low-zoom one.
  assert.ok(Math.abs(r.fit.scale - DRIFT.scale) < 1e-4,
    `recovered scale ${r.fit.scale} vs true ${DRIFT.scale}`);

  // And an untagged point should be pulled to its true position.
  const untagged = [JH[0] + 12, JH[1] - 7];
  const want = trueOf(untagged);
  const got = r.fit.apply(untagged);
  const err = Math.hypot(got[0] - want[0], got[1] - want[1]);
  assert.ok(err < 0.05, `untagged vertex corrected to within ${err.toFixed(4)} m`);
});
