/* =========================================================================
 * Tests for the v15 transform models: projective homography, thin-plate
 * spline, robust (RANSAC + IRLS) fitting, leave-one-out cross-validation and
 * automatic model recommendation.
 *
 * As with the rest of this suite, every accuracy assertion is stated at REAL
 * UTM 45N magnitudes, because that is the only regime the extension operates
 * in and the regime where v13's affine fit silently collapsed.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/gcp_math.js');

const JH_E = 432500;
const JH_N = 2618400;

function ring(originE, originN, radiusM, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([originE + radiusM * Math.cos(a), originN + radiusM * Math.sin(a)]);
  }
  return pts;
}
function grid(originE, originN, stepM, nx, ny) {
  const pts = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    pts.push([originE + i * stepM, originN + j * stepM]);
  }
  return pts;
}
function pairsFrom(src, tgt) {
  return src.map((p, i) => ({ vertexIndex: i, rawPoint: p, confirmedPoint: tgt[i] }));
}
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gaussian(rng) {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
function maxErr(src, truthFn, fit) {
  let worst = 0;
  for (const p of src) {
    const want = truthFn(p), got = fit.apply(p);
    worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1]));
  }
  return worst;
}

/* =====================================================================
 * LINEAR ALGEBRA PRIMITIVES
 * =================================================================== */

test('solveLinearSystem solves, and reports singularity instead of guessing', () => {
  const x = M.solveLinearSystem([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]);
  assert.ok(x);
  assert.ok(Math.abs(x[0] - 2) < 1e-12, `x=${x[0]}`);
  assert.ok(Math.abs(x[1] - 3) < 1e-12, `y=${x[1]}`);
  assert.ok(Math.abs(x[2] + 1) < 1e-12, `z=${x[2]}`);

  // Row 3 = row 1 + row 2 exactly: rank deficient.
  assert.strictEqual(M.solveLinearSystem([[1, 2], [2, 4]], [3, 6]), null);
  assert.strictEqual(M.solveLinearSystem([[0, 0], [0, 0]], [0, 0]), null);
});

test('singularity detection is scale-invariant, not an absolute threshold', () => {
  // The v13 bug in miniature: an absolute pivot tolerance is meaningless when
  // coordinates are ~1e6. A singular system must be caught at any magnitude,
  // and a well-conditioned one must never be mistaken for singular.
  for (const k of [1e-6, 1, 1e3, 1e6, 1e9]) {
    assert.strictEqual(M.solveLinearSystem([[k, 2 * k], [2 * k, 4 * k]], [3 * k, 6 * k]), null,
      `singular system at scale ${k} must be rejected`);
    const good = M.solveLinearSystem([[k, 0], [0, k]], [k, 2 * k]);
    assert.ok(good, `well-conditioned system at scale ${k} must solve`);
    assert.ok(Math.abs(good[0] - 1) < 1e-9 && Math.abs(good[1] - 2) < 1e-9);
  }
});

test('Jacobi eigen-decomposition reproduces a known symmetric spectrum', () => {
  // Diagonal case: eigenvalues are the diagonal itself.
  const d = M.jacobiEigenSymmetric([[3, 0, 0], [0, 1, 0], [0, 0, 2]]);
  assert.deepStrictEqual(d.values.slice().sort((a, b) => a - b), [1, 2, 3]);

  // A * v = lambda * v must hold for every returned pair.
  const A = [[4, 1, -2], [1, 2, 0], [-2, 0, 3]];
  const { values, vectors } = M.jacobiEigenSymmetric(A);
  for (let j = 0; j < 3; j++) {
    const v = [vectors[0][j], vectors[1][j], vectors[2][j]];
    for (let i = 0; i < 3; i++) {
      const Av = A[i][0] * v[0] + A[i][1] * v[1] + A[i][2] * v[2];
      assert.ok(Math.abs(Av - values[j] * v[i]) < 1e-9,
        `eigenpair ${j} row ${i}: ${Av} vs ${values[j] * v[i]}`);
    }
    const norm = Math.hypot(v[0], v[1], v[2]);
    assert.ok(Math.abs(norm - 1) < 1e-9, `eigenvector ${j} should be unit, got ${norm}`);
  }
});

/* =====================================================================
 * PROJECTIVE / HOMOGRAPHY
 * =================================================================== */

const TRUE_H = [
  [1.00021, 0.00068, 14.2],
  [-0.00051, 0.99977, -9.4],
  [1.7e-9, -1.1e-9, 1],
];
const applyTrueH = ([x, y]) => {
  const w = TRUE_H[2][0] * x + TRUE_H[2][1] * y + TRUE_H[2][2];
  return [
    (TRUE_H[0][0] * x + TRUE_H[0][1] * y + TRUE_H[0][2]) / w,
    (TRUE_H[1][0] * x + TRUE_H[1][1] * y + TRUE_H[1][2]) / w,
  ];
};

test('projective recovers a known homography at REAL UTM magnitudes', () => {
  const src = grid(JH_E, JH_N, 40, 3, 3);
  const tgt = src.map(applyTrueH);
  const fit = M.fitProjective(src, tgt);
  assert.ok(fit, 'should solve for a 3x3 grid');
  const rms = M.rmsOf(M.residuals(src, tgt, fit));
  assert.ok(rms < 1e-4, `RMS ${rms} m should be sub-millimetre`);
  // Untagged points matter most, since Apply rewrites the whole shape.
  assert.ok(maxErr(grid(JH_E + 7, JH_N - 11, 33, 3, 3), applyTrueH, fit) < 1e-3,
    'untagged points should also land correctly');
});

test('projective captures perspective that affine provably cannot', () => {
  // A strong perspective warp, of the kind a photographed cadastral sheet has.
  const H = [[1.0, 0.02, 0], [0.0, 1.0, 0], [1.5e-4, 0.75e-4, 1]];
  const applyH = ([x, y]) => {
    const dx = x - JH_E, dy = y - JH_N;
    const w = H[2][0] * dx + H[2][1] * dy + 1;
    return [JH_E + (H[0][0] * dx + H[0][1] * dy) / w, JH_N + (H[1][0] * dx + H[1][1] * dy) / w];
  };
  const src = grid(JH_E, JH_N, 50, 3, 3);
  const tgt = src.map(applyH);

  const proj = M.fitProjective(src, tgt);
  const aff = M.fitAffine(src, tgt);
  const projRms = M.rmsOf(M.residuals(src, tgt, proj));
  const affRms = M.rmsOf(M.residuals(src, tgt, aff));
  assert.ok(projRms < 1e-3, `projective should fit closely, got ${projRms}`);
  // ~33 cm of systematic misfit: unmissable at cadastral scale.
  assert.ok(affRms > 0.2, `affine should visibly fail, got ${affRms}`);
  assert.ok(projRms < affRms / 100, 'projective must be dramatically better here');
});

test('projective needs 4 points and rejects degenerate configurations', () => {
  const three = grid(JH_E, JH_N, 40, 3, 1);
  assert.strictEqual(M.fitProjective(three, three.map(applyTrueH)), null, '3 points is not enough');

  // Four collinear points cannot determine a homography.
  const collinear = [
    [JH_E, JH_N], [JH_E + 30, JH_N + 30], [JH_E + 60, JH_N + 60], [JH_E + 90, JH_N + 90],
  ];
  assert.strictEqual(M.fitProjective(collinear, collinear.map(applyTrueH)), null,
    'collinear points must be rejected');
});

test('projective reduces to affine behaviour when the data is affine', () => {
  const applyAff = ([x, y]) => [1.0002 * x + 0.0007 * y + 12.5, -0.0005 * x + 0.9998 * y - 8.25];
  const src = grid(JH_E, JH_N, 45, 3, 3);
  const tgt = src.map(applyAff);
  const fit = M.fitProjective(src, tgt);
  assert.ok(fit);
  assert.ok(M.rmsOf(M.residuals(src, tgt, fit)) < 1e-3);
  // The perspective row should come out essentially zero.
  assert.ok(Math.abs(fit.H[2][0]) < 1e-9, `H[2][0]=${fit.H[2][0]}`);
  assert.ok(Math.abs(fit.H[2][1]) < 1e-9, `H[2][1]=${fit.H[2][1]}`);
});

/* =====================================================================
 * THIN-PLATE SPLINE
 * =================================================================== */

test('TPS interpolates every control point exactly', () => {
  const src = grid(JH_E, JH_N, 40, 3, 3);
  const rng = makeRng(7);
  // Deliberately non-global, per-point displacement: no affine or projective
  // model can reproduce this, but an exact interpolator must.
  const tgt = src.map(([x, y]) => [x + 2 * gaussian(rng), y + 2 * gaussian(rng)]);
  const fit = M.fitTps(src, tgt, 0);
  assert.ok(fit);
  const res = M.residuals(src, tgt, fit);
  assert.ok(Math.max(...res) < 1e-6,
    `TPS must pass through every control point, worst residual ${Math.max(...res)}`);
});

test('TPS models local warping that global models cannot', () => {
  // A smooth but genuinely local bulge in the middle of the sheet.
  const src = grid(JH_E, JH_N, 30, 5, 5);
  const warp = ([x, y]) => {
    const dx = x - (JH_E + 60), dy = y - (JH_N + 60);
    const r2 = dx * dx + dy * dy;
    const bump = 3 * Math.exp(-r2 / (2 * 45 * 45));
    return [x + bump, y + bump * 0.6];
  };
  const tgt = src.map(warp);

  const tps = M.fitTps(src, tgt, 0);
  const aff = M.fitAffine(src, tgt);
  const proj = M.fitProjective(src, tgt);

  // Judge on held-out points, since TPS fits control points by construction.
  const probe = grid(JH_E + 15, JH_N + 15, 30, 4, 4);
  const tpsErr = maxErr(probe, warp, tps);
  const affErr = maxErr(probe, warp, aff);
  const projErr = maxErr(probe, warp, proj);
  assert.ok(tpsErr < affErr / 3,
    `TPS (${tpsErr.toFixed(3)} m) should beat affine (${affErr.toFixed(3)} m) substantially`);
  assert.ok(tpsErr < projErr / 3,
    `TPS (${tpsErr.toFixed(3)} m) should beat projective (${projErr.toFixed(3)} m) substantially`);
});

test('TPS regularisation trades exactness for smoothness', () => {
  const src = grid(JH_E, JH_N, 40, 3, 3);
  const rng = makeRng(11);
  const tgt = src.map(([x, y]) => [x + 1.5 * gaussian(rng), y + 1.5 * gaussian(rng)]);
  const exact = M.fitTps(src, tgt, 0);
  const smooth = M.fitTps(src, tgt, 5);
  assert.ok(exact && smooth);
  const exactRms = M.rmsOf(M.residuals(src, tgt, exact));
  const smoothRms = M.rmsOf(M.residuals(src, tgt, smooth));
  assert.ok(exactRms < 1e-6, 'unregularised TPS interpolates exactly');
  assert.ok(smoothRms > exactRms, 'regularised TPS deliberately does not interpolate');
});

test('TPS rejects collinear and coincident control points', () => {
  const collinear = [[JH_E, JH_N], [JH_E + 20, JH_N + 20], [JH_E + 40, JH_N + 40]];
  assert.strictEqual(M.fitTps(collinear, collinear.map(p => [p[0] + 1, p[1] + 1]), 0), null);
  const same = [[JH_E, JH_N], [JH_E, JH_N], [JH_E, JH_N]];
  assert.strictEqual(M.fitTps(same, same, 0), null);
});

test('TPS stays finite far outside the control hull', () => {
  // Extrapolation is not meaningful for a spline, but it must not produce
  // NaN/Infinity that would silently corrupt exported geometry.
  const src = grid(JH_E, JH_N, 30, 3, 3);
  const tgt = src.map(([x, y]) => [x + 1, y - 1]);
  const fit = M.fitTps(src, tgt, 0);
  const far = fit.apply([JH_E + 5000, JH_N - 8000]);
  assert.ok(isFinite(far[0]) && isFinite(far[1]), `got ${far}`);
});

/* =====================================================================
 * WEIGHTED FITS
 * =================================================================== */

test('uniform weights reproduce the unweighted fit exactly', () => {
  const src = ring(JH_E, JH_N, 50, 6);
  const applyAff = ([x, y]) => [1.0002 * x + 0.0007 * y + 12.5, -0.0005 * x + 0.9998 * y - 8.25];
  const tgt = src.map(applyAff);
  const w = new Array(6).fill(1);

  const simA = M.fitSimilarity(src, tgt), simB = M.fitSimilarityWeighted(src, tgt, w);
  assert.ok(Math.abs(simA.scale - simB.scale) < 1e-12, 'weighted similarity must match');
  const affA = M.fitAffine(src, tgt), affB = M.fitAffineWeighted(src, tgt, w);
  for (const k of ['a', 'b', 'd', 'e']) {
    assert.ok(Math.abs(affA[k] - affB[k]) < 1e-9, `weighted affine ${k} must match`);
  }
});

test('zero weight genuinely removes a point from the fit', () => {
  const src = ring(JH_E, JH_N, 50, 6);
  const applyAff = ([x, y]) => [1.0002 * x + 0.0007 * y + 12.5, -0.0005 * x + 0.9998 * y - 8.25];
  const tgt = src.map(applyAff);
  tgt[2] = [tgt[2][0] + 40, tgt[2][1] - 30]; // a wild outlier

  const w = new Array(6).fill(1);
  w[2] = 0;
  const fit = M.fitAffineWeighted(src, tgt, w);
  assert.ok(fit);
  // The remaining five points must be fitted essentially perfectly.
  for (let i = 0; i < 6; i++) {
    if (i === 2) continue;
    const got = fit.apply(src[i]);
    assert.ok(Math.hypot(got[0] - tgt[i][0], got[1] - tgt[i][1]) < 1e-6,
      `point ${i} should be unaffected by the excluded outlier`);
  }
});

/* =====================================================================
 * ROBUST FITTING
 * =================================================================== */

test('robust fitting identifies a single badly mis-clicked GCP', () => {
  const src = ring(JH_E, JH_N, 60, 8);
  const applySim = ([x, y]) => [x + 3.2, y - 2.1];
  const tgt = src.map(applySim);
  tgt[5] = [tgt[5][0] + 25, tgt[5][1] + 18]; // ~31 m blunder

  const r = M.fitRobust(pairsFrom(src, tgt), 'similarity', { seed: 1 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.outliers.includes(5), `outliers ${JSON.stringify(r.outliers)} should include 5`);
  assert.strictEqual(r.outliers.length, 1, 'exactly one outlier expected');
  // And the surviving fit should recover the true shift despite the blunder.
  const got = r.fit.apply([JH_E, JH_N]);
  assert.ok(Math.hypot(got[0] - (JH_E + 3.2), got[1] - (JH_N - 2.1)) < 0.2,
    'the recovered shift should be close to truth');
});

test('robust fitting survives multiple outliers that would wreck least squares', () => {
  const src = ring(JH_E, JH_N, 80, 12);
  const applySim = ([x, y]) => [x + 5, y - 4];
  const tgt = src.map(applySim);
  tgt[2] = [tgt[2][0] + 30, tgt[2][1]];
  tgt[7] = [tgt[7][0] - 28, tgt[7][1] + 22];

  const plain = M.fitSimilarity(src, tgt);
  const plainErr = Math.hypot(...(() => {
    const g = plain.apply([JH_E, JH_N]);
    return [g[0] - (JH_E + 5), g[1] - (JH_N - 4)];
  })());

  const r = M.fitRobust(pairsFrom(src, tgt), 'similarity', { seed: 42 });
  const robustGot = r.fit.apply([JH_E, JH_N]);
  const robustErr = Math.hypot(robustGot[0] - (JH_E + 5), robustGot[1] - (JH_N - 4));

  assert.ok(r.outliers.includes(2) && r.outliers.includes(7),
    `both blunders should be flagged, got ${JSON.stringify(r.outliers)}`);
  assert.ok(robustErr < plainErr / 3,
    `robust (${robustErr.toFixed(3)} m) should beat plain least squares (${plainErr.toFixed(3)} m)`);
});

test('robust fitting flags nothing when every GCP is good', () => {
  const src = ring(JH_E, JH_N, 60, 8);
  const rng = makeRng(3);
  const tgt = src.map(([x, y]) => [x + 4 + 0.02 * gaussian(rng), y - 3 + 0.02 * gaussian(rng)]);
  const r = M.fitRobust(pairsFrom(src, tgt), 'similarity', { seed: 5 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.outliers, [], 'clean data must not be accused of having outliers');
});

test('robust fitting is deterministic — same tags, same answer', () => {
  const src = ring(JH_E, JH_N, 55, 9);
  const tgt = src.map(([x, y]) => [x + 2, y + 2]);
  tgt[4] = [tgt[4][0] + 20, tgt[4][1]];
  const a = M.fitRobust(pairsFrom(src, tgt), 'similarity', {});
  const b = M.fitRobust(pairsFrom(src, tgt), 'similarity', {});
  assert.deepStrictEqual(a.outliers, b.outliers);
  assert.strictEqual(a.fit.scale, b.fit.scale);
});

test('robust fitting says plainly when there is no redundancy to judge', () => {
  // 2 GCPs with similarity is an exact fit; calling either one an outlier
  // would be meaningless.
  const src = [[JH_E, JH_N], [JH_E + 40, JH_N + 30]];
  const r = M.fitRobust(pairsFrom(src, src.map(p => [p[0] + 1, p[1] + 1])), 'similarity', {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.outliers, []);
  assert.match(r.method, /no redundancy/i);
});

/* =====================================================================
 * LEAVE-ONE-OUT CROSS-VALIDATION
 * =================================================================== */

test('LOO needs one point beyond the model minimum', () => {
  const src3 = ring(JH_E, JH_N, 40, 3);
  const p3 = pairsFrom(src3, src3.map(p => [p[0] + 1, p[1] + 1]));
  assert.ok(M.crossValidateLoo(p3, 'similarity'), 'similarity(min 2) can be validated with 3');
  assert.strictEqual(M.crossValidateLoo(p3, 'affine'), null, 'affine(min 3) cannot with only 3');

  const src4 = ring(JH_E, JH_N, 40, 4);
  const p4 = pairsFrom(src4, src4.map(p => [p[0] + 1, p[1] + 1]));
  assert.ok(M.crossValidateLoo(p4, 'affine'), 'affine can be validated with 4');
  assert.strictEqual(M.crossValidateLoo(p4, 'projective'), null, 'projective(min 4) cannot with only 4');
});

test('LOO error is near zero when the model matches the data generator', () => {
  const src = ring(JH_E, JH_N, 60, 8);
  const applyAff = ([x, y]) => [1.0002 * x + 0.0007 * y + 12.5, -0.0005 * x + 0.9998 * y - 8.25];
  const cv = M.crossValidateLoo(pairsFrom(src, src.map(applyAff)), 'affine');
  assert.ok(cv.looRms < 1e-6, `affine LOO on affine data should vanish, got ${cv.looRms}`);
});

test('in-sample residual is provably worthless for TPS; LOO is not', () => {
  // Deterministic and stark: TPS fits its control points to machine zero while
  // its held-out prediction error is ~0.3 m. Any UI that shows in-sample RMS
  // for a TPS fit is showing the user a number that cannot be anything else.
  const src = ring(JH_E, JH_N, 60, 10);
  const rng = makeRng(99);
  const tgt = src.map(([x, y]) => [x + 3 + 0.3 * gaussian(rng), y - 2 + 0.3 * gaussian(rng)]);
  const pairs = pairsFrom(src, tgt);

  const inSample = M.rmsOf(M.residuals(src, tgt, M.fitTps(src, tgt, 0)));
  const loo = M.crossValidateLoo(pairs, 'tps').looRms;
  assert.ok(inSample < 1e-9, `TPS in-sample RMS should be ~0, got ${inSample}`);
  assert.ok(loo > 0.1, `TPS LOO should reveal the real error, got ${loo}`);
  assert.ok(loo > inSample * 1e6, 'the gap between in-sample and LOO is the overfitting signal');
});

test('LOO prefers the correct model on average, over many noise realisations', () => {
  // A single dataset is too noisy to rank models reliably — LOO error is
  // dominated by the held-out point's own measurement noise, and on one
  // unlucky seed TPS can beat similarity even on pure-similarity data. The
  // ordering is only meaningful in expectation, so assert it that way.
  const trials = 200;
  const sigma = 0.3;
  let simSum = 0, tpsSum = 0, counted = 0;
  for (let t = 0; t < trials; t++) {
    const rng = makeRng(1000 + t * 7);
    const src = ring(JH_E, JH_N, 60, 10);
    const tgt = src.map(([x, y]) => [x + 3 + sigma * gaussian(rng), y - 2 + sigma * gaussian(rng)]);
    const pairs = pairsFrom(src, tgt);
    const sim = M.crossValidateLoo(pairs, 'similarity');
    const tps = M.crossValidateLoo(pairs, 'tps');
    if (!sim || !tps) continue;
    simSum += sim.looRms; tpsSum += tps.looRms; counted++;
  }
  assert.ok(counted > 150, `expected most trials to be evaluable, got ${counted}`);
  const simMean = simSum / counted, tpsMean = tpsSum / counted;
  // Measured at ~27% worse; assert a clear margin without over-fitting the
  // assertion to one exact figure.
  assert.ok(tpsMean > simMean * 1.15,
    `on similarity-generated data, mean TPS LOO (${tpsMean.toFixed(4)}) should exceed ` +
    `mean similarity LOO (${simMean.toFixed(4)}) by a clear margin`);
});

/* =====================================================================
 * MODEL RECOMMENDATION
 * =================================================================== */

test('recommends the shift-only model for data that is genuinely just a shift', () => {
  // This test previously expected similarity, because it was the simplest model
  // that existed. Translation is simpler still and cannot distort, so for data
  // that really is a pure shift it is the honest answer — and being preferred
  // here is the whole point of adding it.
  const src = ring(JH_E, JH_N, 60, 10);
  const rng = makeRng(21);
  const tgt = src.map(([x, y]) => [x + 3.5 + 0.05 * gaussian(rng), y - 2.5 + 0.05 * gaussian(rng)]);
  const r = M.recommendTransform(pairsFrom(src, tgt));
  assert.strictEqual(r.validated, true);
  assert.strictEqual(r.recommended, 'translation', r.reason);
});

test('recommends affine when there is real shear to capture', () => {
  const src = grid(JH_E, JH_N, 40, 3, 3);
  // Shear large enough to matter at plot scale: ~40 cm of systematic
  // displacement across an 80 m sheet, far beyond any survey tolerance.
  const applyAff = ([x, y]) => {
    const dx = x - JH_E, dy = y - JH_N;
    return [JH_E + dx + 0.005 * dy + 3, JH_N - 0.004 * dx + dy - 2];
  };
  const rng = makeRng(33);
  const tgt = src.map(p => {
    const c = applyAff(p);
    return [c[0] + 0.01 * gaussian(rng), c[1] + 0.01 * gaussian(rng)];
  });
  const r = M.recommendTransform(pairsFrom(src, tgt));
  assert.strictEqual(r.validated, true);
  assert.ok(r.recommended === 'affine' || r.recommended === 'projective',
    `expected affine-or-better, got ${r.recommended}: ${r.reason}`);
  assert.notStrictEqual(r.recommended, 'similarity', 'similarity cannot express this shear');
});

test('recommends TPS only when the distortion is genuinely local', () => {
  const src = grid(JH_E, JH_N, 25, 5, 5);
  const warp = ([x, y]) => {
    const dx = x - (JH_E + 50), dy = y - (JH_N + 50);
    const bump = 2.5 * Math.exp(-(dx * dx + dy * dy) / (2 * 35 * 35));
    return [x + bump, y + bump * 0.5];
  };
  const r = M.recommendTransform(pairsFrom(src, src.map(warp)));
  assert.strictEqual(r.validated, true);
  assert.strictEqual(r.recommended, 'tps', r.reason);
});

test('the parsimony floor suppresses sub-millimetre gains but not real distortion', () => {
  // Pins the tuning decision. Weak shear (8 cm across the sheet) buys affine
  // almost nothing in held-out accuracy, so similarity should be kept; strong
  // shear (40 cm) must not be dismissed the same way. An earlier 1 cm floor
  // failed the second case, which is why it is now 3 mm.
  const src = grid(JH_E, JH_N, 40, 3, 3);
  const withShear = (sh) => {
    const rng = makeRng(33);
    return src.map(([x, y]) => {
      const dx = x - JH_E, dy = y - JH_N;
      return [
        JH_E + dx + sh * dy + 3 + 0.01 * gaussian(rng),
        JH_N - sh * 0.8 * dx + dy - 2 + 0.01 * gaussian(rng),
      ];
    });
  };
  const weak = M.recommendTransform(pairsFrom(src, withShear(0.001)));
  assert.strictEqual(weak.recommended, 'similarity',
    `weak shear should not justify distortion: ${weak.reason}`);

  const strong = M.recommendTransform(pairsFrom(src, withShear(0.008)));
  assert.notStrictEqual(strong.recommended, 'similarity',
    `strong shear must be captured, not absorbed by the floor: ${strong.reason}`);
});

test('parsimony prevents a marginally better complex model from winning', () => {
  // Pure-shift data: every model fits it perfectly, so the least capable of
  // distortion must be chosen rather than whichever scores 1e-9 lower.
  const src = grid(JH_E, JH_N, 40, 3, 3);
  const tgt = src.map(([x, y]) => [x + 2, y - 3]);
  const r = M.recommendTransform(pairsFrom(src, tgt));
  assert.strictEqual(r.recommended, 'translation',
    `all models fit perfectly here, so the simplest must win: ${r.reason}`);
});

test('recommendation reports honestly when there is too little data to validate', () => {
  // Two points used to be un-validatable, because the simplest model then
  // available needed two. Translation needs one, so two points now DO validate
  // something — which is exactly why the reported field failure is fixed. The
  // genuinely unvalidatable case is a single point.
  const one = [{ vertexIndex: 0, rawPoint: [JH_E, JH_N], confirmedPoint: [JH_E + 1, JH_N + 1] }];
  const r1 = M.recommendTransform(one);
  assert.strictEqual(r1.validated, false);
  assert.strictEqual(r1.recommended, 'translation');
  assert.match(r1.reason, /not enough to cross-check/i);

  const two = pairsFrom([[JH_E, JH_N], [JH_E + 40, JH_N + 30]],
    [[JH_E + 1, JH_N + 1], [JH_E + 41, JH_N + 31]]);
  const r2 = M.recommendTransform(two);
  assert.strictEqual(r2.validated, true, 'two points can now be cross-checked');
  assert.strictEqual(r2.recommended, 'translation');
});

test('the recommendation table records feasibility per model', () => {
  const src = ring(JH_E, JH_N, 50, 4);
  const r = M.recommendTransform(pairsFrom(src, src.map(p => [p[0] + 1, p[1] + 1])));
  const byType = Object.fromEntries(r.table.map(t => [t.type, t]));
  assert.strictEqual(byType.similarity.feasible, true);
  assert.strictEqual(byType.affine.feasible, true);
  assert.strictEqual(byType.projective.feasible, true);   // exactly 4
  assert.strictEqual(byType.projective.validated, false); // but not validatable
  assert.strictEqual(byType.similarity.validated, true);
  for (const t of r.table) assert.ok(t.label && t.note, 'each row must be explainable to the user');
});

/* =====================================================================
 * ORCHESTRATOR
 * =================================================================== */

test('fitGcpTransform supports every model and reports LOO alongside RMS', () => {
  const src = grid(JH_E, JH_N, 35, 3, 3);
  const tgt = src.map(applyTrueH);
  const pairs = pairsFrom(src, tgt);
  for (const type of ['similarity', 'affine', 'projective', 'tps']) {
    const r = M.fitGcpTransform(pairs, type);
    assert.strictEqual(r.ok, true, `${type} should solve`);
    assert.strictEqual(r.type, type);
    assert.ok(typeof r.rms === 'number', `${type} must report RMS`);
    assert.ok(r.looRms != null, `${type} must report a cross-validated error with 9 GCPs`);
  }
});

test('fitGcpTransform marks TPS as uninformative-by-construction and warns', () => {
  const src = grid(JH_E, JH_N, 35, 3, 3);
  const r = M.fitGcpTransform(pairsFrom(src, src.map(applyTrueH)), 'tps');
  assert.strictEqual(r.exactlyDetermined, true);
  assert.match(r.warning, /residual is always zero/i);
  assert.match(r.warning, /mis-clicked/i);
});

test('fitGcpTransform enforces each model minimum with a usable message', () => {
  const src = ring(JH_E, JH_N, 40, 3);
  const pairs = pairsFrom(src, src.map(p => [p[0] + 1, p[1] + 1]));
  const r = M.fitGcpTransform(pairs, 'projective');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /at least 4/);
  assert.match(r.error, /you have 3/);
});

test('fitGcpTransform in robust mode returns the outlier list', () => {
  const src = ring(JH_E, JH_N, 60, 8);
  const tgt = src.map(([x, y]) => [x + 3, y - 2]);
  tgt[6] = [tgt[6][0] + 22, tgt[6][1] - 17];
  const r = M.fitGcpTransform(pairsFrom(src, tgt), 'similarity', { robust: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.outliers.includes(6), `expected 6 among ${JSON.stringify(r.outliers)}`);
  assert.ok(r.robust.method, 'the method used must be stated');
});

test('an unknown transform type falls back to similarity rather than throwing', () => {
  const src = ring(JH_E, JH_N, 40, 4);
  const r = M.fitGcpTransform(pairsFrom(src, src.map(p => [p[0] + 1, p[1] + 1])), 'nonsense');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'similarity');
});


/* =====================================================================
 * EXPLICIT VERTEX PAIRING, PREVIEW AND COVERAGE
 * =================================================================== */

test('a control point can be paired to a specific vertex, by index', () => {
  const shape = { id: 7, points: ring(JH_E, JH_N, 40, 6) };
  const r = M.makeGcpFromVertex(shape, 3, [JH_E + 5, JH_N - 2]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.gcp.shapeId, 7);
  assert.strictEqual(r.gcp.vertexIndex, 3);
  // Source must be the chosen vertex exactly, not the nearest one to the click.
  assert.deepStrictEqual(r.gcp.source, shape.points[3]);
  assert.deepStrictEqual(r.gcp.target, [JH_E + 5, JH_N - 2]);
  assert.ok(r.shift > 0);
});

test('vertex pairing rejects an index that does not exist, and says the range', () => {
  const shape = { id: 1, points: ring(JH_E, JH_N, 40, 5) };
  for (const bad of [-1, 5, 99, 1.5, null, undefined, '2']) {
    const r = M.makeGcpFromVertex(shape, bad, [JH_E, JH_N]);
    assert.strictEqual(r.ok, false, `index ${bad} should be rejected`);
  }
  assert.match(M.makeGcpFromVertex(shape, 9, [JH_E, JH_N]).error, /0 to 4/);
});

test('vertex pairing rejects an unusable captured coordinate', () => {
  const shape = { id: 1, points: ring(JH_E, JH_N, 40, 5) };
  for (const bad of [null, [NaN, 1], [1, Infinity], 'x', [1]]) {
    assert.strictEqual(M.makeGcpFromVertex(shape, 0, bad).ok, false, `target ${JSON.stringify(bad)} should be rejected`);
  }
  assert.strictEqual(M.makeGcpFromVertex(null, 0, [1, 2]).ok, false);
});

test('the source coordinate is a copy, so later edits cannot rewrite history', () => {
  const shape = { id: 1, points: ring(JH_E, JH_N, 40, 4) };
  const r = M.makeGcpFromVertex(shape, 1, [JH_E, JH_N]);
  const before = r.gcp.source.slice();
  shape.points[1][0] += 100;   // the user drags that vertex afterwards
  assert.deepStrictEqual(r.gcp.source, before,
    'the control point must remember where the vertex was when it was tagged');
});

test('preview applies a fit without mutating the originals', () => {
  const src = ring(JH_E, JH_N, 50, 6);
  const shapes = [{ id: 1, points: src.map((p) => p.slice()) }];
  const originals = shapes[0].points.map((p) => p.slice());
  const pairs = pairsFrom(src, src.map(([x, y]) => [x + 4, y - 3]));
  const fit = M.fitGcpTransform(pairs, 'similarity');

  const preview = M.previewCorrected(shapes, fit.fit);
  assert.strictEqual(preview.length, 1);
  assert.strictEqual(preview[0].id, 1);
  // Preview must show the shift...
  assert.ok(Math.abs(preview[0].points[0][0] - (originals[0][0] + 4)) < 1e-6);
  // ...while the source geometry is untouched.
  assert.deepStrictEqual(shapes[0].points, originals);
});

test('preview degrades safely without a usable transform', () => {
  const shapes = [{ id: 1, points: ring(JH_E, JH_N, 30, 4) }];
  assert.deepStrictEqual(M.previewCorrected(shapes, null), []);
  assert.deepStrictEqual(M.previewCorrected(shapes, {}), []);
});

test('spread assessment separates well-placed points from clustered ones', () => {
  const wellSpread = ring(JH_E, JH_N, 50, 5).map((p, i) => ({ vertexIndex: i, source: p }));
  const good = M.describeGcpSpread(wellSpread);
  assert.strictEqual(good.quality, 'good');
  assert.ok(good.ratio > 0.25);

  // Five points along one edge: a residual could look perfect while the
  // correction is unconstrained across that line.
  const clustered = [];
  for (let i = 0; i < 5; i++) clustered.push({ vertexIndex: i, source: [JH_E + i * 8, JH_N + i * 0.05] });
  const bad = M.describeGcpSpread(clustered);
  assert.strictEqual(bad.quality, 'collinear');
  assert.match(bad.message, /straight line/i);
  assert.match(bad.message, /off it/i, 'should say what to do about it');
});

test('spread assessment flags the two-point case as uncross-checkable', () => {
  const two = [
    { vertexIndex: 0, source: [JH_E, JH_N] },
    { vertexIndex: 1, source: [JH_E + 40, JH_N + 30] },
  ];
  const r = M.describeGcpSpread(two);
  assert.strictEqual(r.quality, 'minimal');
  assert.match(r.message, /nothing cross-checks/i);

  const one = M.describeGcpSpread([{ vertexIndex: 0, source: [JH_E, JH_N] }]);
  assert.strictEqual(one.quality, 'insufficient');
});

test('spread assessment accepts either source or rawPoint naming', () => {
  const asRaw = ring(JH_E, JH_N, 40, 4).map((p, i) => ({ vertexIndex: i, rawPoint: p }));
  assert.strictEqual(M.describeGcpSpread(asRaw).count, 4);
});

test('coverage reports which shapes have no control at all', () => {
  const shapes = [
    { id: 1, points: ring(JH_E, JH_N, 40, 4), plotNo: '10' },
    { id: 2, points: ring(JH_E + 200, JH_N, 40, 4), plotNo: '11' },
    { id: 3, points: ring(JH_E + 400, JH_N, 40, 4), plotNo: '12' },
  ];
  const gcps = [
    { shapeId: 1, vertexIndex: 0, source: shapes[0].points[0], target: [0, 0], enabled: true },
    { shapeId: 1, vertexIndex: 2, source: shapes[0].points[2], target: [0, 0], enabled: true },
    { shapeId: 1, vertexIndex: 3, source: shapes[0].points[3], target: [0, 0], enabled: true },
    { shapeId: null, vertexIndex: null, source: [JH_E, JH_N], target: [0, 0], enabled: true },
    { shapeId: 2, vertexIndex: 1, source: shapes[1].points[1], target: [0, 0], enabled: false },
  ];
  const c = M.assessCoverage(shapes, gcps);
  assert.strictEqual(c.shapesWithControl, 1);
  assert.deepStrictEqual(c.shapesWithoutControl, [2, 3],
    'a disabled point must not count as control');
  assert.strictEqual(c.looseCount, 1);
  assert.match(c.summary, /1 of 3/);
  assert.match(c.summary, /drift the same way/i,
    'should state the assumption that moving everything makes about the untagged shapes');
  // And it must name both choices, so the operator can act on the warning rather
  // than only be told there is one.
  assert.match(c.summary, /Move all/, 'should name the button that would move them');
  assert.match(c.summary, /Move tagged/, 'and the one that would not');

  const s1 = c.perShape.find((p) => p.shapeId === 1);
  assert.strictEqual(s1.count, 3);
  assert.deepStrictEqual(s1.taggedVertices, [0, 2, 3]);
  assert.ok(s1.spread);
  assert.strictEqual(c.perShape.find((p) => p.shapeId === 3).spread, null);
});

test('coverage is content when every shape is controlled', () => {
  const shapes = [{ id: 1, points: ring(JH_E, JH_N, 40, 4) }];
  const gcps = [
    { shapeId: 1, vertexIndex: 0, source: shapes[0].points[0], target: [0, 0], enabled: true },
    { shapeId: 1, vertexIndex: 2, source: shapes[0].points[2], target: [0, 0], enabled: true },
  ];
  const c = M.assessCoverage(shapes, gcps);
  assert.deepStrictEqual(c.shapesWithoutControl, []);
  assert.match(c.summary, /All 1 shape/);
});


/* =====================================================================
 * TRANSLATION, and the field failure that motivated it
 *
 * An operator tagged two corners, applied a similarity fit, saw
 * "scale 0.957594, rotation 1.0691°, In-sample RMS 0.000 m" and watched the
 * plot move somewhere else entirely. These tests pin both halves of the
 * explanation: why similarity is untrustworthy at two points, and why
 * translation is selected instead.
 * =================================================================== */

test('translation works from a single point and only shifts', () => {
  const src = [[JH_E, JH_N]];
  const tgt = [[JH_E + 4.5, JH_N - 3.25]];
  const fit = M.fitTranslation(src, tgt);
  assert.ok(fit, 'one point must be enough to shift');
  assert.strictEqual(fit.type, 'translation');
  assert.ok(Math.abs(fit.dx - 4.5) < 1e-12);
  assert.ok(Math.abs(fit.dy + 3.25) < 1e-12);
  assert.strictEqual(fit.scale, 1, 'scale must be exactly 1');
  assert.strictEqual(fit.rotationRad, 0, 'rotation must be exactly 0');

  // A point far from the tagged one moves by the SAME amount, not more.
  const far = [JH_E + 500, JH_N - 700];
  const moved = fit.apply(far);
  assert.ok(Math.abs(moved[0] - (far[0] + 4.5)) < 1e-9);
  assert.ok(Math.abs(moved[1] - (far[1] - 3.25)) < 1e-9);
});

test('translation averages several points instead of chasing any one', () => {
  const src = ring(JH_E, JH_N, 40, 5);
  const rng = makeRng(4);
  const sd = 0.4;
  const tgt = src.map(([x, y]) => [x + 3 + sd * gaussian(rng), y - 2 + sd * gaussian(rng)]);
  const fit = M.fitTranslation(src, tgt);

  // The point of averaging: the fitted shift must beat what the typical single
  // pair would have claimed on its own.
  const errFrom = (dx, dy) => Math.hypot(dx - 3, dy + 2);
  const singles = src.map((s, i) => errFrom(tgt[i][0] - s[0], tgt[i][1] - s[1]));
  const meanSingle = singles.reduce((a, b) => a + b, 0) / singles.length;
  assert.ok(errFrom(fit.dx, fit.dy) < meanSingle,
    `averaged error ${errFrom(fit.dx, fit.dy).toFixed(3)} m should beat the ` +
    `mean single-pair error ${meanSingle.toFixed(3)} m`);

  // And it must land within three standard errors of the truth. The standard
  // error of a mean of n samples is sd/sqrt(n), so the tolerance is derived
  // rather than tuned until the suite went green.
  const tol = 3 * sd / Math.sqrt(src.length);
  assert.ok(Math.abs(fit.dx - 3) < tol, `dx ${fit.dx} (tolerance ${tol.toFixed(3)})`);
  assert.ok(Math.abs(fit.dy + 2) < tol, `dy ${fit.dy} (tolerance ${tol.toFixed(3)})`);
  assert.strictEqual(fit.scale, 1, 'noise must never become a scale change');
});

test('a similarity fit from two points is exactly determined and can lie badly', () => {
  // The field case, reconstructed: two corners 20 m apart, each tagged with a
  // sub-metre error.
  const src = [[JH_E, JH_N], [JH_E + 20, JH_N + 6]];
  const tgt = [[JH_E + 3.0, JH_N - 2.0], [JH_E + 22.2, JH_N + 3.4]];
  const pairs = pairsFrom(src, tgt);

  const sim = M.fitGcpTransform(pairs, 'similarity');
  assert.strictEqual(sim.ok, true);
  assert.ok(sim.rms < 1e-9, 'residual is zero by construction, and proves nothing');
  assert.strictEqual(sim.exactlyDetermined, true, 'and it must be flagged as such');
  // Small click errors have become a real scale and rotation change.
  assert.ok(Math.abs(sim.fit.scale - 1) > 0.02,
    `expected a spurious scale change, got ${sim.fit.scale}`);

  const mag = M.describeFitMagnitude(sim.fit, 100);
  assert.ok(mag.distortionAtRadius > 2,
    `a vertex 100 m out should be thrown metres by this fit, got ${mag.distortionAtRadius.toFixed(2)} m`);

  // Translation on the same evidence distorts nothing at all.
  const tr = M.fitGcpTransform(pairs, 'translation');
  assert.strictEqual(tr.ok, true);
  assert.strictEqual(M.describeFitMagnitude(tr.fit, 100).distortionAtRadius, 0);
});

test('with two points the recommendation is translation, not similarity', () => {
  // This is the fix for the reported failure, and it falls out of the existing
  // cross-validation rather than a special case: translation needs one point so
  // it can be validated with two, while similarity needs two and cannot.
  const src = [[JH_E, JH_N], [JH_E + 20, JH_N + 6]];
  const tgt = [[JH_E + 3.0, JH_N - 2.0], [JH_E + 22.2, JH_N + 3.4]];
  const rec = M.recommendTransform(pairsFrom(src, tgt));
  assert.strictEqual(rec.validated, true, 'two points must now be enough to validate something');
  assert.strictEqual(rec.recommended, 'translation', rec.reason);

  const byType = Object.fromEntries(rec.table.map((t) => [t.type, t]));
  assert.ok(byType.translation.looRms != null, 'translation is cross-validatable at two points');
  assert.strictEqual(byType.similarity.looRms, null, 'similarity is not');
});

test('a single point still yields a usable recommendation', () => {
  const rec = M.recommendTransform([
    { vertexIndex: 0, rawPoint: [JH_E, JH_N], confirmedPoint: [JH_E + 2, JH_N + 1] },
  ]);
  assert.strictEqual(rec.recommended, 'translation',
    'one point can only shift, and that is worth doing');
  assert.strictEqual(rec.validated, false, 'but nothing cross-checks it');
  assert.match(rec.reason, /not enough to cross-check/i);
});

test('genuine scale error is still recovered once there is evidence for it', () => {
  // Translation must not become a straitjacket: with enough well-spread points
  // showing a real scale change, similarity should win.
  const src = ring(JH_E, JH_N, 60, 8);
  const truth = ([x, y]) => [
    JH_E + (x - JH_E) * 1.02 + 3,
    JH_N + (y - JH_N) * 1.02 - 2,
  ];
  const rec = M.recommendTransform(pairsFrom(src, src.map(truth)));
  assert.strictEqual(rec.validated, true);
  assert.notStrictEqual(rec.recommended, 'translation',
    `a real 2% scale change should be captured: ${rec.reason}`);
});

test('translation is offered through the orchestrator and reports its shift', () => {
  const src = ring(JH_E, JH_N, 30, 4);
  const r = M.fitGcpTransform(pairsFrom(src, src.map(([x, y]) => [x + 5, y - 1])), 'translation');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'translation');
  assert.ok(Math.abs(r.fit.shiftMetres - Math.hypot(5, 1)) < 1e-9);
  assert.ok(r.rms < 1e-9, 'a pure shift is fitted exactly');
});

test('robust fitting works for translation too', () => {
  const src = ring(JH_E, JH_N, 50, 8);
  const tgt = src.map(([x, y]) => [x + 4, y - 3]);
  tgt[3] = [tgt[3][0] + 30, tgt[3][1] - 20];   // one wild blunder
  const r = M.fitRobust(pairsFrom(src, tgt), 'translation', { seed: 9 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.outliers.includes(3), `blunder should be flagged, got ${JSON.stringify(r.outliers)}`);
  assert.ok(Math.abs(r.fit.dx - 4) < 0.6, `dx ${r.fit.dx} should survive the blunder`);
  assert.ok(Math.abs(r.fit.dy + 3) < 0.6, `dy ${r.fit.dy}`);
});

test('fit magnitude describes distortion separately from bodily shift', () => {
  // An operator needs to know "will this warp my plot", which is a different
  // question from "will this move it".
  const src = ring(JH_E, JH_N, 40, 6);
  const shifted = M.fitTranslation(src, src.map(([x, y]) => [x + 50, y]));
  const mShift = M.describeFitMagnitude(shifted, 100);
  assert.strictEqual(mShift.distortionAtRadius, 0, 'a big shift is not a distortion');
  assert.ok(Math.abs(mShift.shiftMetres - 50) < 1e-9);

  const scaled = M.fitSimilarity(src, src.map(([x, y]) => [
    JH_E + (x - JH_E) * 1.05, JH_N + (y - JH_N) * 1.05]));
  const mScale = M.describeFitMagnitude(scaled, 100);
  assert.ok(mScale.distortionAtRadius > 4,
    `a 5% scale change is ~5 m at 100 m, got ${mScale.distortionAtRadius.toFixed(2)}`);
  assert.ok(Math.abs(mScale.scalePct - 5) < 0.1, `scalePct ${mScale.scalePct}`);
});


test('robust fitting never claims every control point is an outlier', () => {
  // Seen in the panel: a shift fitted from two disagreeing points reported that
  // BOTH of them looked inconsistent, which cannot be true — if every point is
  // an outlier there is no inlier set to be an outlier from.
  const src = [[JH_E, JH_N], [JH_E + 20, JH_N + 6]];
  const tgt = [[JH_E + 3.0, JH_N - 2.0], [JH_E + 6.0, JH_N + 1.0]];  // they disagree
  const r = M.fitRobust(pairsFrom(src, tgt), 'translation', { seed: 1 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.outliers, [],
    'with two points and a one-point model, neither can be blamed');
  assert.match(r.method, /cannot be attributed/,
    'and the reason must be stated rather than left as a silent pass');
});

test('an outlier is only named once removing it still over-determines the model', () => {
  // minPoints + 1 is not enough: drop either point and the rest fits exactly, so
  // both explanations are equally good. minPoints + 2 is the threshold.
  const src = ring(JH_E, JH_N, 40, 6);
  const tgt = src.map(([x, y]) => [x + 3, y - 2]);
  tgt[4] = [tgt[4][0] + 18, tgt[4][1] - 14];   // one clear blunder

  for (const n of [2, 3]) {
    const r = M.fitRobust(pairsFrom(src.slice(0, n), tgt.slice(0, n)), 'translation', { seed: 3 });
    assert.deepStrictEqual(r.outliers, [], `with ${n} points nothing should be flagged`);
  }
  // With the full six, the blunder is identifiable and must be found.
  const full = M.fitRobust(pairsFrom(src, tgt), 'translation', { seed: 3 });
  assert.ok(full.outliers.includes(4),
    `the blunder at index 4 should be flagged, got ${JSON.stringify(full.outliers)}`);

  // And a model needing three points needs five before anything is blamed.
  const four = M.fitRobust(pairsFrom(src.slice(0, 4), tgt.slice(0, 4)), 'affine', { seed: 3 });
  assert.deepStrictEqual(four.outliers, [],
    'affine needs 3, so 4 points cannot attribute a disagreement');
});
