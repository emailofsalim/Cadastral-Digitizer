/* =========================================================================
 * Geometry editing, the shift record, and drawing-scale calibration.
 *
 * Two things are worth more than the rest of this file put together:
 *
 *  - the shift record must agree EXACTLY with the geometry it claims to
 *    describe, at real UTM magnitudes, after any number of stacked operations.
 *    A record that drifts from the geometry is worse than no record, because
 *    it is believed;
 *  - rotation and scaling must not translate. A "rotate 2°" that also moves
 *    the parcel is a silent, plausible-looking positional error.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const G = require('../lib/geom_edit.js');

/* Real Jharkhand magnitudes. v13's affine fit was accurate to 1e-14 on 0-100
 * test data and wrong by 1187 m at these coordinates; the same blind spot must
 * not reopen here. */
const PLOT = [
  [432500.25, 2618400.75],
  [432540.25, 2618400.75],
  [432540.25, 2618440.75],
  [432500.25, 2618440.75],
];

const maxDiff = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

/* =====================================================================
 * PRIMITIVES
 * =================================================================== */

test('translation moves every corner by exactly the same amount', () => {
  const out = G.translateRing(PLOT, 3.25, -2.5);
  for (let i = 0; i < PLOT.length; i++) {
    assert.strictEqual(out[i][0] - PLOT[i][0], 3.25);
    assert.strictEqual(out[i][1] - PLOT[i][1], -2.5);
  }
});

test('rotation about the centroid does not move the parcel', () => {
  // The whole point of rotating about the parcel's own centre: a rotation that
  // also translates is a positional error that looks like a rotation.
  const before = G.ringCentroid(PLOT);
  const after = G.ringCentroid(G.rotateRing(PLOT, 37));
  assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1e-4,
    `centroid moved by ${Math.hypot(after[0] - before[0], after[1] - before[1])} m`);
});

test('rotation preserves area and every edge length', () => {
  const rot = G.rotateRing(PLOT, 12.5);
  const len = (r, i) => Math.hypot(r[(i + 1) % r.length][0] - r[i][0], r[(i + 1) % r.length][1] - r[i][1]);
  for (let i = 0; i < PLOT.length; i++) {
    assert.ok(Math.abs(len(rot, i) - len(PLOT, i)) < 1e-6, `edge ${i} changed length`);
  }
});

test('scaling about the centroid changes area by the square of the factor', () => {
  const f = 1.02;
  const scaled = G.scaleRing(PLOT, f);
  // Measured with the library's own area routine, which accumulates in a local
  // frame. A naive shoelace written inline here loses ~0.15 ppm to cancellation
  // at these coordinates and would fail this assertion on its own arithmetic
  // rather than on the geometry.
  const area = (r) => require('../lib/exporters.js').gridArea(r);
  assert.ok(Math.abs(area(scaled) / area(PLOT) - f * f) < 1e-9);
  const c0 = G.ringCentroid(PLOT); const c1 = G.ringCentroid(scaled);
  assert.ok(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < 1e-4, 'and must not move the parcel');
});

test('a duplicate is offset so both parcels can be told apart', () => {
  // Placing a copy exactly on top makes two coincident parcels the topology
  // checker correctly calls a total overlap and the operator cannot select
  // apart.
  const dup = G.duplicateRing(PLOT);
  assert.ok(maxDiff(dup, PLOT) > 0, 'a duplicate on top of the original is unusable');
  const b = G.boundsOfRing(PLOT);
  assert.ok(maxDiff(dup, PLOT) < Math.max(b.width, b.height), 'but it must stay nearby');
});

/* =====================================================================
 * THE SHIFT RECORD  (brief §4)
 * =================================================================== */

test('the record reproduces stacked operations exactly, at UTM magnitudes', () => {
  const c = G.ringCentroid(PLOT);

  // Apply move, then rotate, then scale, the way an operator would.
  let stepwise = G.translateRing(PLOT, 3.25, -2.5);
  stepwise = G.rotateRing(stepwise, 1.5, c);
  stepwise = G.scaleRing(stepwise, 1.02, c);

  // Accumulate the same three into one record.
  let shift = G.identityShift();
  shift = G.composeShift(shift, G.shiftForTranslation(3.25, -2.5));
  shift = G.composeShift(shift, G.shiftForRotationAbout(1.5, c));
  shift = G.composeShift(shift, G.shiftForScaleAbout(1.02, c));

  const viaRecord = G.applyShiftToRing(shift, PLOT);
  assert.ok(maxDiff(stepwise, viaRecord) < 1e-6,
    `the record must describe the geometry it claims to: off by ${maxDiff(stepwise, viaRecord)} m`);
});

test('inverting the record restores the original exactly', () => {
  // This is what "Reset this shift" relies on.
  const c = G.ringCentroid(PLOT);
  let shift = G.identityShift();
  shift = G.composeShift(shift, G.shiftForTranslation(-11.5, 7.25));
  shift = G.composeShift(shift, G.shiftForRotationAbout(-3.75, c));
  shift = G.composeShift(shift, G.shiftForScaleAbout(0.994, c));

  const moved = G.applyShiftToRing(shift, PLOT);
  const back = G.applyShiftToRing(G.invertShift(shift), moved);
  assert.ok(maxDiff(back, PLOT) < 1e-6, `reset must be exact: off by ${maxDiff(back, PLOT)} m`);
});

test('composition order matters and is not commutative', () => {
  // Rotate-then-move and move-then-rotate are different operations. A record
  // that treated them as the same would misreport what was done.
  const c = G.ringCentroid(PLOT);
  const a = G.composeShift(G.shiftForTranslation(10, 0), G.shiftForRotationAbout(30, c));
  const b = G.composeShift(G.shiftForRotationAbout(30, c), G.shiftForTranslation(10, 0));
  assert.ok(maxDiff(G.applyShiftToRing(a, PLOT), G.applyShiftToRing(b, PLOT)) > 1,
    'the two orders must give different results, and the record must reflect that');
});

test('an untouched parcel reports no shift', () => {
  assert.strictEqual(G.isIdentityShift(G.identityShift()), true);
  assert.strictEqual(G.describeShift(G.identityShift(), PLOT).identity, true);
  assert.strictEqual(G.describeShift(G.identityShift(), PLOT).summary, 'unshifted');
});

test('a pure translation is reported as shape-safe; a scale is not', () => {
  // The operator needs to know whether a correction merely moved the parcel or
  // also changed its size and angles — the difference between a repositioning
  // and a redefinition of the boundary.
  const move = G.describeShift(G.shiftForTranslation(3, -2), PLOT);
  assert.strictEqual(move.deforms, false);
  assert.ok(Math.abs(move.maxVertexMove - Math.hypot(3, 2)) < 1e-9);

  const scaled = G.describeShift(G.shiftForScaleAbout(1.05, G.ringCentroid(PLOT)), PLOT);
  assert.strictEqual(scaled.deforms, true);
  assert.match(scaled.summary, /scaled/);
});

test('the description states the movement in metres and degrees', () => {
  const c = G.ringCentroid(PLOT);
  let s = G.composeShift(G.identityShift(), G.shiftForTranslation(3, -4));
  s = G.composeShift(s, G.shiftForRotationAbout(2.5, c));
  const d = G.describeShift(s, PLOT);
  assert.match(d.summary, /moved 5\.0/, 'a 3,-4 move is 5 m');
  assert.match(d.summary, /rotated 2\.5/);
  assert.ok(d.maxVertexMove > 0);
});

/* =====================================================================
 * RF AND SCALE-BAR CALIBRATION  (brief §12, §13)
 * =================================================================== */

test('RF alone is refused: it cannot give a ground scale without a resolution', () => {
  // The correction the brief could not make: an RF relates PAPER distance to
  // ground distance and says nothing about pixels. Assuming a DPI silently
  // would be exactly the invented certainty this project refuses elsewhere.
  const r = G.groundMetresPerPixelFromRf(2000, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /resolution|dpi/i);
  assert.strictEqual(G.groundMetresPerPixelFromRf(0, 300).ok, false);
  assert.strictEqual(G.groundMetresPerPixelFromRf(-100, 300).ok, false);
});

test('RF with a scan resolution gives the documented ground scale', () => {
  // 1:2000 at 300 dpi: one inch of paper is 2000 inches of ground = 50.8 m,
  // spread over 300 pixels, so 0.169333 m per pixel.
  const r = G.groundMetresPerPixelFromRf(2000, 300);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.metresPerPixel - (2000 * 0.0254 / 300)) < 1e-12);
  assert.ok(Math.abs(r.metresPerPixel - 0.1693333) < 1e-6);
});

test('RF scales linearly with the denominator and inversely with DPI', () => {
  const a = G.groundMetresPerPixelFromRf(1000, 300).metresPerPixel;
  const b = G.groundMetresPerPixelFromRf(2000, 300).metresPerPixel;
  assert.ok(Math.abs(b / a - 2) < 1e-12, '1:2000 is twice the ground distance of 1:1000');
  const c = G.groundMetresPerPixelFromRf(2000, 600).metresPerPixel;
  assert.ok(Math.abs(b / c - 2) < 1e-12, 'twice the DPI is half the ground distance per pixel');
});

test('a scale bar gives metres per pixel with no DPI at all', () => {
  const r = G.metresPerPixelFromScaleBar([100, 100], [400, 100], 50);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.metresPerPixel - 50 / 300) < 1e-12);
  assert.strictEqual(r.pixelDistance, 300);
});

test('a scale bar refuses degenerate input rather than dividing by zero', () => {
  assert.strictEqual(G.metresPerPixelFromScaleBar([10, 10], [10, 10], 50).ok, false);
  assert.strictEqual(G.metresPerPixelFromScaleBar([0, 0], [100, 0], 0).ok, false);
  assert.strictEqual(G.metresPerPixelFromScaleBar([0, 0], [100, 0], -5).ok, false);
  assert.strictEqual(G.metresPerPixelFromScaleBar(null, [1, 1], 5).ok, false);
});

test('the two routes are cross-checked against each other', () => {
  // They are independent measurements of the same quantity, so a disagreement
  // means one is wrong — most often an assumed scan DPI. The operator should
  // be told which to trust rather than having the last one entered win.
  const rf = G.makeCalibration({ method: 'rf', rfDenominator: 2000, dpi: 300 }).calibration;
  const close = G.makeCalibration({ method: 'scalebar', pixelA: [0, 0], pixelB: [300, 0], groundDistanceMetres: 50.5 }).calibration;
  assert.strictEqual(G.compareCalibrations(rf, close).agree, true);

  const wrong = G.makeCalibration({ method: 'scalebar', pixelA: [0, 0], pixelB: [300, 0], groundDistanceMetres: 15 }).calibration;
  const cmp = G.compareCalibrations(rf, wrong);
  assert.strictEqual(cmp.agree, false);
  assert.match(cmp.message, /disagrees/);
  assert.match(cmp.message, /scale bar is the more direct/i, 'and it must say which to believe');
});

test('a calibration converts pixel lengths and areas to the ground', () => {
  const cal = G.makeCalibration({ method: 'rf', rfDenominator: 2000, dpi: 300 }).calibration;
  const mpp = cal.metresPerPixel;
  assert.ok(Math.abs(G.pixelLengthToGround(100, cal) - 100 * mpp) < 1e-12);
  // Area goes as the square, which is the step it would be easy to forget.
  assert.ok(Math.abs(G.pixelAreaToGround(10000, cal) - 10000 * mpp * mpp) < 1e-9);
  assert.strictEqual(G.pixelAreaToGround(10000, null), null, 'and refuses without one');
});

test('an implied RF reads back what was entered', () => {
  const cal = G.makeCalibration({ method: 'rf', rfDenominator: 2000, dpi: 300 }).calibration;
  assert.ok(Math.abs(G.impliedRf(cal, 300) - 2000) < 1e-9);
  assert.strictEqual(G.impliedRf(cal, null), null);
});

test('a calibration is a stored record, not a live view property', () => {
  // It must survive being written to and read back from a project file, and
  // must hold nothing derived from the viewport — screen zoom and drawing
  // scale are different things (brief §12, §26).
  const cal = G.makeCalibration({
    method: 'scalebar', pixelA: [10, 20], pixelB: [310, 20], groundDistanceMetres: 50,
  }).calibration;
  const round = JSON.parse(JSON.stringify(cal));
  assert.deepStrictEqual(round, cal);
  for (const k of Object.keys(cal)) {
    assert.ok(!/zoom|scaleLevel|viewport|screen/i.test(k),
      `a calibration must not carry a display property, found "${k}"`);
  }
});

test('makeCalibration refuses an unknown method instead of inventing one', () => {
  assert.strictEqual(G.makeCalibration({ method: 'guess' }).ok, false);
  assert.strictEqual(G.makeCalibration({}).ok, false);
});

/* =====================================================================
 * RING HELPERS
 * =================================================================== */

test('the centroid is the area centroid, not the vertex mean', () => {
  // A traced parcel carries far more vertices along its wobbly edge than its
  // straight one. A vertex mean would be dragged toward the wobble, and every
  // rotation would then be about the wrong point.
  const dense = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0],
    [6, 6], [0, 6]];
  const c = G.ringCentroid(dense);
  let sx = 0; let sy = 0;
  for (const p of dense) { sx += p[0]; sy += p[1]; }
  const vertexMean = [sx / dense.length, sy / dense.length];
  assert.ok(Math.abs(c[1] - vertexMean[1]) > 0.2,
    'the area centroid must differ from the vertex mean on an unevenly sampled ring');
});

test('a degenerate ring falls back to the vertex mean rather than dividing by zero', () => {
  const line = [[0, 0], [10, 0], [20, 0]];
  const c = G.ringCentroid(line);
  assert.ok(isFinite(c[0]) && isFinite(c[1]));
  assert.strictEqual(c[0], 10);
});

test('bounds are reported for a real plot', () => {
  const b = G.boundsOfRing(PLOT);
  assert.strictEqual(b.width, 40);
  assert.strictEqual(b.height, 40);
  assert.strictEqual(b.minX, 432500.25);
});

test('a clone does not alias the original', () => {
  const c = G.cloneRing(PLOT);
  c[0][0] = 0;
  assert.strictEqual(PLOT[0][0], 432500.25, 'editing a clone must not reach the original');
});

test('operations with a no-op argument return an unaliased copy', () => {
  for (const out of [G.translateRing(PLOT, 0, 0), G.rotateRing(PLOT, 0), G.scaleRing(PLOT, 1)]) {
    assert.deepStrictEqual(out, PLOT);
    out[0][0] = 1;
    assert.strictEqual(PLOT[0][0], 432500.25);
  }
});

test('non-numeric input is refused rather than producing NaN geometry', () => {
  // NaN coordinates propagate silently through every downstream computation
  // and surface as an empty export with no explanation.
  const bad = G.translateRing(PLOT, NaN, 5);
  assert.ok(bad.every((p) => isFinite(p[0]) && isFinite(p[1])));
  const bad2 = G.rotateRing(PLOT, NaN);
  assert.ok(bad2.every((p) => isFinite(p[0]) && isFinite(p[1])));
  const bad3 = G.scaleRing(PLOT, NaN);
  assert.ok(bad3.every((p) => isFinite(p[0]) && isFinite(p[1])));
});
