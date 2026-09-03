/* =========================================================================
 * Tests for lib/gcp_math.js — run with:  node --test test/
 *
 * THE POINT OF THIS SUITE: v13 shipped a broken affine fit whose own
 * verification passed, because that verification used synthetic coordinates
 * in the 0-100 range. The extension never sees such coordinates. It sees
 * UTM Zone 45N: easting ~4.3e5, northing ~2.6e6, with plots spanning tens
 * of metres.
 *
 * So every accuracy assertion below is stated at REAL coordinate magnitudes.
 * The small-coordinate cases are kept only as explicit contrast, marked as
 * such, so nobody "fixes" a future regression by shrinking the test data
 * again.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/gcp_math.js');

/* ---------------------------------------------------------------------
 * Fixtures at real Jharkhand coordinates.
 * Ranchi sits around easting 432500, northing 2618400 in UTM 45N.
 * ------------------------------------------------------------------- */
const JH_E = 432500;
const JH_N = 2618400;

// A ring of n points around a plot of the given radius in metres.
function plotRing(originE, originN, radiusM, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n;
    pts.push([originE + radiusM * Math.cos(ang), originN + radiusM * Math.sin(ang)]);
  }
  return pts;
}

function pairsFrom(src, tgt) {
  return src.map((p, i) => ({ vertexIndex: i, rawPoint: p, confirmedPoint: tgt[i] }));
}

// A deterministic pseudo-random generator so noise tests are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gaussian(rng) {
  // Box-Muller
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Truth transforms. Deliberately small distortions, like real georeferencing
// drift: sub-permille scale error, a fraction of a degree of rotation, and a
// shift of a few metres.
const TRUE_AFFINE = { a: 1.0002, b: 0.0007, c: 12.5, d: -0.0005, e: 0.9998, f: -8.25 };
const applyTrueAffine = ([x, y]) => [
  TRUE_AFFINE.a * x + TRUE_AFFINE.b * y + TRUE_AFFINE.c,
  TRUE_AFFINE.d * x + TRUE_AFFINE.e * y + TRUE_AFFINE.f,
];

function makeTrueSimilarity(scale, rotDeg, tx, ty) {
  const th = (rotDeg * Math.PI) / 180;
  const a = scale * Math.cos(th), b = scale * Math.sin(th);
  return ([x, y]) => [a * x - b * y + tx, b * x + a * y + ty];
}

/* =====================================================================
 * AFFINE — the v13 regression, asserted at real magnitudes.
 * =================================================================== */

test('affine recovers a known transform at REAL UTM 45N magnitudes (v13 regression)', () => {
  // v13 produced 1187 m RMS on exactly this input while reporting success.
  const src = plotRing(JH_E, JH_N, 40, 6);
  const tgt = src.map(applyTrueAffine);
  const fit = M.fitAffine(src, tgt);
  assert.ok(fit, 'affine fit should be solvable for a well-spread 6-point ring');

  const rms = M.rmsOf(M.residuals(src, tgt, fit));
  assert.ok(rms < 1e-6, `RMS on the GCPs should be sub-micrometre, got ${rms}`);

  // The property that actually matters to a user: vertices they did NOT tag
  // must also land correctly, since Apply rewrites the whole shape.
  const untagged = [JH_E + 3, JH_N - 4];
  const want = applyTrueAffine(untagged);
  const got = fit.apply(untagged);
  const err = Math.hypot(got[0] - want[0], got[1] - want[1]);
  assert.ok(err < 1e-6, `error on an untagged vertex should be sub-micrometre, got ${err} m`);
});

test('affine stays accurate across plot sizes from 5 m to 2 km', () => {
  for (const radius of [5, 20, 40, 150, 300, 1000, 2000]) {
    const src = plotRing(JH_E, JH_N, radius, 8);
    const tgt = src.map(applyTrueAffine);
    const fit = M.fitAffine(src, tgt);
    assert.ok(fit, `should solve for a ${radius} m plot`);
    const rms = M.rmsOf(M.residuals(src, tgt, fit));
    // Millimetre tolerance is far tighter than any survey requirement and
    // still ~6 orders of magnitude better than v13 managed.
    assert.ok(rms < 1e-3, `${radius} m plot: RMS ${rms} m exceeds 1 mm`);
  }
});

test('affine works far from the UTM zone origin, where conditioning is worst', () => {
  // Northing grows toward the pole; the v13 formulation degraded as it did.
  for (const [e, n] of [[210000, 1200000], [432500, 2618400], [790000, 3400000]]) {
    const src = plotRing(e, n, 30, 6);
    const tgt = src.map(applyTrueAffine);
    const fit = M.fitAffine(src, tgt);
    assert.ok(fit, `should solve at easting ${e}, northing ${n}`);
    const rms = M.rmsOf(M.residuals(src, tgt, fit));
    assert.ok(rms < 1e-3, `at ${e},${n}: RMS ${rms} m exceeds 1 mm`);
  }
});

test('affine recovers shear specifically, not just position', () => {
  const src = plotRing(JH_E, JH_N, 60, 8);
  const tgt = src.map(applyTrueAffine);
  const fit = M.fitAffine(src, tgt);
  // Compare the recovered linear part against truth directly.
  assert.ok(Math.abs(fit.a - TRUE_AFFINE.a) < 1e-9, `a: got ${fit.a}`);
  assert.ok(Math.abs(fit.b - TRUE_AFFINE.b) < 1e-9, `b: got ${fit.b}`);
  assert.ok(Math.abs(fit.d - TRUE_AFFINE.d) < 1e-9, `d: got ${fit.d}`);
  assert.ok(Math.abs(fit.e - TRUE_AFFINE.e) < 1e-9, `e: got ${fit.e}`);
  // And the derived global-form translation.
  assert.ok(Math.abs(fit.c - TRUE_AFFINE.c) < 1e-3, `c: got ${fit.c}`);
  assert.ok(Math.abs(fit.f - TRUE_AFFINE.f) < 1e-3, `f: got ${fit.f}`);
});

test('small synthetic coordinates still work (contrast case — NOT sufficient alone)', () => {
  // This is the shape of test v13 had. It passes both before and after the
  // fix, which is exactly why it must never be the only accuracy test here.
  const src = plotRing(50, 50, 40, 6);
  const tgt = src.map(applyTrueAffine);
  const fit = M.fitAffine(src, tgt);
  assert.ok(M.rmsOf(M.residuals(src, tgt, fit)) < 1e-9);
});

/* =====================================================================
 * DEGENERACY — v13's |det| < 1e-9 guard never fired at real magnitudes.
 * =================================================================== */

test('collinear GCPs are rejected at REAL magnitudes (v13 guard never fired)', () => {
  const collinear = [
    [JH_E, JH_N],
    [JH_E + 40, JH_N + 40],
    [JH_E + 80, JH_N + 80],
    [JH_E + 120, JH_N + 120],
  ];
  const tgt = collinear.map(applyTrueAffine);
  assert.strictEqual(M.fitAffine(collinear, tgt), null,
    'perfectly collinear input must not yield an affine transform');

  // And through the orchestrator the user actually hits.
  const r = M.fitGcpTransform(pairsFrom(collinear, tgt), 'affine');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /collinear/i);
});

test('collinear rejection is magnitude-independent', () => {
  for (const [e, n] of [[0, 0], [100, 100], [432500, 2618400], [790000, 3400000]]) {
    const pts = [[e, n], [e + 10, n + 10], [e + 20, n + 20]];
    assert.strictEqual(M.fitAffine(pts, pts.map(applyTrueAffine)), null,
      `collinear input at ${e},${n} must be rejected`);
  }
});

test('near-collinear GCPs solve but carry an explicit amplification warning', () => {
  // A long thin sliver: 200 m along, 1 m across.
  const src = [
    [JH_E, JH_N], [JH_E + 100, JH_N + 1], [JH_E + 200, JH_N - 0.5], [JH_E + 150, JH_N + 0.8],
  ];
  const tgt = src.map(applyTrueAffine);
  const r = M.fitGcpTransform(pairsFrom(src, tgt), 'affine');
  assert.strictEqual(r.ok, true, 'a sliver is solvable, just ill-conditioned');
  assert.ok(r.warning, 'an ill-conditioned affine fit must warn');
  assert.match(r.warning, /collinear|amplif/i);
});

test('spreadRatio is scale-invariant', () => {
  const shape = plotRing(0, 0, 1, 6);
  const base = M.spreadRatio(shape);
  // Translating far from the origin must not change the measure.
  const moved = M.spreadRatio(shape.map(([x, y]) => [x + JH_E, y + JH_N]));
  assert.ok(Math.abs(base - moved) < 1e-9, `${base} vs ${moved}`);
  // Nor must uniformly scaling it up.
  const scaled = M.spreadRatio(shape.map(([x, y]) => [x * 5000, y * 5000]));
  assert.ok(Math.abs(base - scaled) < 1e-9, `${base} vs ${scaled}`);
});

/* =====================================================================
 * SIMILARITY
 * =================================================================== */

test('similarity recovers scale, rotation and shift at real magnitudes', () => {
  const truth = makeTrueSimilarity(1.0003, 0.35, 9.5, -4.25);
  const src = plotRing(JH_E, JH_N, 45, 6);
  const tgt = src.map(truth);
  const fit = M.fitSimilarity(src, tgt);
  assert.ok(fit);
  assert.ok(Math.abs(fit.scale - 1.0003) < 1e-9, `scale ${fit.scale}`);
  assert.ok(Math.abs((fit.rotationRad * 180) / Math.PI - 0.35) < 1e-7, `rot ${fit.rotationRad}`);
  const rms = M.rmsOf(M.residuals(src, tgt, fit));
  assert.ok(rms < 1e-6, `RMS ${rms}`);
});

test('similarity never introduces distortion, even fed sheared targets', () => {
  // Feeding an affine truth to a similarity fit must leave a residual rather
  // than silently absorbing the shear — that non-absorption is the whole
  // reason similarity is the safe default.
  const src = plotRing(JH_E, JH_N, 500, 8);
  const tgt = src.map(applyTrueAffine);
  const fit = M.fitSimilarity(src, tgt);
  assert.ok(M.rmsOf(M.residuals(src, tgt, fit)) > 1e-3,
    'shear must show up as residual, not be absorbed');
  // The linear part must remain a scaled rotation: [[a,-b],[b,a]].
  assert.ok(Math.abs(fit.a - fit.e) < 1e-12, 'diagonal must be equal');
  assert.ok(Math.abs(fit.b + fit.d) < 1e-12, 'off-diagonal must be antisymmetric');
});

test('similarity solves with the documented minimum of 2 GCPs', () => {
  const truth = makeTrueSimilarity(1.001, 1.5, 20, -30);
  const src = [[JH_E, JH_N], [JH_E + 50, JH_N + 35]];
  const tgt = src.map(truth);
  const fit = M.fitSimilarity(src, tgt);
  assert.ok(fit);
  assert.ok(M.rmsOf(M.residuals(src, tgt, fit)) < 1e-6);
});

test('coincident GCPs are rejected rather than dividing by zero', () => {
  const src = [[JH_E, JH_N], [JH_E, JH_N], [JH_E, JH_N]];
  assert.strictEqual(M.fitSimilarity(src, src.map(applyTrueAffine)), null);
  const r = M.fitGcpTransform(pairsFrom(src, src.map(applyTrueAffine)), 'similarity');
  assert.strictEqual(r.ok, false);
});

/* =====================================================================
 * "MORE GCPs = MORE ACCURATE" — the README's headline claim, re-verified
 * at real magnitudes with reproducible noise.
 * =================================================================== */

test('accuracy improves monotonically with GCP count, at real magnitudes', () => {
  const sigma = 0.5; // metres of click error per tagged point
  const trials = 400;
  const counts = [3, 4, 6, 10, 20];
  const avgErr = [];

  for (const count of counts) {
    const rng = makeRng(20260822 + count);
    let total = 0;
    for (let t = 0; t < trials; t++) {
      const src = plotRing(JH_E, JH_N, 60, count);
      const tgt = src.map(p => {
        const clean = applyTrueAffine(p);
        return [clean[0] + sigma * gaussian(rng), clean[1] + sigma * gaussian(rng)];
      });
      const fit = M.fitAffine(src, tgt);
      if (!fit) continue;
      // Error measured against the TRUE transform at an independent point,
      // not against the noisy tags themselves.
      const probe = [JH_E + 25, JH_N + 18];
      const want = applyTrueAffine(probe);
      const got = fit.apply(probe);
      total += Math.hypot(got[0] - want[0], got[1] - want[1]);
    }
    avgErr.push(total / trials);
  }

  // Each step up in GCP count must reduce average error against truth.
  for (let i = 1; i < avgErr.length; i++) {
    assert.ok(avgErr[i] < avgErr[i - 1],
      `error should fall as GCPs rise: ${counts[i - 1]} GCPs -> ${avgErr[i - 1].toFixed(4)} m, ` +
      `${counts[i]} GCPs -> ${avgErr[i].toFixed(4)} m`);
  }
  // And the improvement should be substantial, not marginal.
  assert.ok(avgErr[avgErr.length - 1] < avgErr[0] / 2,
    `20 GCPs should at least halve the error of 3: ${avgErr[0].toFixed(4)} -> ${avgErr[avgErr.length - 1].toFixed(4)}`);
});

/* =====================================================================
 * PER-POINT RESIDUALS — how a mis-clicked GCP becomes visible.
 * =================================================================== */

test('a single mis-clicked GCP is identifiable by per-point residual', () => {
  const src = plotRing(JH_E, JH_N, 50, 6);
  const tgt = src.map(applyTrueAffine);
  // Fat-finger one tag by ~8.5 m.
  tgt[3] = [tgt[3][0] + 8, tgt[3][1] - 3];

  for (const type of ['affine', 'similarity']) {
    const r = M.fitGcpTransform(pairsFrom(src, tgt), type);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.residuals.length, 6);
    assert.strictEqual(r.worstIndex, 3, `${type}: the bad tag must be flagged as worst`);

    // Compare the suspect against the OTHER tags, not against the overall
    // RMS. Least squares deliberately spreads an outlier's error across every
    // point, so the outlier inflates the very RMS you would compare it to —
    // measured here, the bad tag is only 1.7x the total RMS under affine,
    // which would slip past a naive "> 2x RMS" screen.
    const others = r.residuals.filter((_, i) => i !== 3);
    assert.ok(r.residuals[3] > 2 * M.rmsOf(others),
      `${type}: bad tag ${r.residuals[3].toFixed(3)} m should exceed 2x the other tags' ` +
      `RMS ${M.rmsOf(others).toFixed(3)} m`);
  }
});

test('affine masks a bad GCP more than similarity does', () => {
  // Worth pinning down explicitly: the extra freedom of an affine fit lets it
  // bend toward a mis-clicked tag, flattening the residual that would have
  // exposed it. Similarity, being shape-preserving, cannot do this and so
  // separates the outlier more sharply. This is a real argument for keeping
  // similarity the default, and for reviewing residuals before Apply.
  const src = plotRing(JH_E, JH_N, 50, 6);
  const tgt = src.map(applyTrueAffine);
  tgt[3] = [tgt[3][0] + 8, tgt[3][1] - 3];
  const pairs = pairsFrom(src, tgt);

  const contrast = (type) => {
    const r = M.fitGcpTransform(pairs, type);
    const others = r.residuals.filter((_, i) => i !== 3);
    return r.residuals[3] / Math.max(...others);
  };

  assert.ok(contrast('similarity') > contrast('affine'),
    `similarity should expose the outlier more sharply: ` +
    `similarity ${contrast('similarity').toFixed(2)}x vs affine ${contrast('affine').toFixed(2)}x`);
});

test('exactly-determined fits are flagged so a 0.000 m RMS cannot mislead', () => {
  // 3 GCPs + affine = 6 equations, 6 unknowns: residual is zero by
  // construction and proves nothing. The UI needs to know that.
  const src = plotRing(JH_E, JH_N, 40, 3);
  const tgt = src.map(applyTrueAffine);
  const r3 = M.fitGcpTransform(pairsFrom(src, tgt), 'affine');
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.exactlyDetermined, true);
  assert.ok(r3.rms < 1e-9, 'residual is zero by construction here');

  // 2 GCPs + similarity is likewise exactly determined.
  const src2 = [[JH_E, JH_N], [JH_E + 40, JH_N + 25]];
  const r2 = M.fitGcpTransform(pairsFrom(src2, src2.map(applyTrueAffine)), 'similarity');
  assert.strictEqual(r2.exactlyDetermined, true);

  // 4 GCPs + affine is genuinely overdetermined, so RMS carries information.
  const src4 = plotRing(JH_E, JH_N, 40, 4);
  const r4 = M.fitGcpTransform(pairsFrom(src4, src4.map(applyTrueAffine)), 'affine');
  assert.strictEqual(r4.exactlyDetermined, false);
});

/* =====================================================================
 * ORCHESTRATOR GUARDS
 * =================================================================== */

test('fitGcpTransform enforces documented minimum GCP counts', () => {
  const one = [{ vertexIndex: 0, rawPoint: [JH_E, JH_N], confirmedPoint: [JH_E + 1, JH_N + 1] }];
  assert.strictEqual(M.fitGcpTransform(one, 'similarity').ok, false);

  const src2 = [[JH_E, JH_N], [JH_E + 30, JH_N + 20]];
  const two = pairsFrom(src2, src2.map(applyTrueAffine));
  assert.strictEqual(M.fitGcpTransform(two, 'similarity').ok, true);
  const affTwo = M.fitGcpTransform(two, 'affine');
  assert.strictEqual(affTwo.ok, false);
  assert.match(affTwo.error, /at least 3/i);
});

test('apply() is stable for points far outside the GCP cluster', () => {
  // Extrapolation must degrade gracefully, not explode from cancellation.
  const src = plotRing(JH_E, JH_N, 30, 5);
  const tgt = src.map(applyTrueAffine);
  const fit = M.fitAffine(src, tgt);
  const far = [JH_E + 5000, JH_N - 7000];
  const want = applyTrueAffine(far);
  const got = fit.apply(far);
  const err = Math.hypot(got[0] - want[0], got[1] - want[1]);
  assert.ok(err < 1e-3, `extrapolated 7 km away, error ${err} m`);
});
