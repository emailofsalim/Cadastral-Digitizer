/* =========================================================================
 * BhuNaksha Digitizer — GCP transform math (pure, no DOM, no map).
 * -------------------------------------------------------------------------
 * Extracted from page_inject.js in v14 so that the code the extension runs
 * is EXACTLY the code the test suite verifies. Loads either as a plain
 * browser script (attaches window.BND_GcpMath) or as a CommonJS module.
 *
 * WHY THIS FILE EXISTS — the v13 bug it fixes:
 *
 * v13's affine fit solved the least-squares normal equations on RAW map
 * coordinates via Cramer's rule. BhuNaksha map coordinates are UTM-45N
 * magnitudes (easting ~4.3e5, northing ~2.6e6) while a plot spans only tens
 * of metres, so the normal-equations matrix had a condition number around
 * 1e17 — beyond what float64 can carry. Measured on a 40 m plot at real
 * Jharkhand coordinates, the v13 affine fit was wrong by 1187 m RMS while
 * reporting a plausible-looking result. Its collinearity guard
 * (|det| < 1e-9) never fired either, because at those magnitudes det is
 * ~1e30 even for perfectly collinear input.
 *
 * v13's unit tests passed because they used synthetic coordinates in the
 * 0-100 range, where the same code really is accurate to ~1e-14. The maths
 * was never wrong; the conditioning was.
 *
 * THE FIX, applied throughout this module:
 *   1. Every fit is solved in coordinates CENTERED on the point-set
 *      centroids, so the numbers entering the solver are metres-scale
 *      offsets rather than absolute UTM values. This removes the
 *      conditioning problem at its source rather than papering over it.
 *   2. Degeneracy is detected GEOMETRICALLY and scale-invariantly, via the
 *      ratio of perpendicular to principal spread of the source points,
 *      instead of an absolute determinant threshold that cannot work across
 *      coordinate magnitudes.
 *   3. `apply()` also evaluates in centered form, so no large-magnitude
 *      cancellation is reintroduced when the transform is used.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_GcpMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * Basic helpers
   * ------------------------------------------------------------------- */
  function centroidOf(pts) {
    let cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    return [cx / pts.length, cy / pts.length];
  }

  function centerOn(pts, c) {
    return pts.map(p => [p[0] - c[0], p[1] - c[1]]);
  }

  // Second-moment (scatter) matrix of already-centered points.
  function scatterOf(centered) {
    let Sxx = 0, Sxy = 0, Syy = 0;
    for (let i = 0; i < centered.length; i++) {
      const x = centered[i][0], y = centered[i][1];
      Sxx += x * x; Sxy += x * y; Syy += y * y;
    }
    return { Sxx, Sxy, Syy };
  }

  // Eigenvalues of the symmetric 2x2 scatter matrix (always real).
  function eigen2(S) {
    const half = (S.Sxx + S.Syy) / 2;
    const diff = (S.Sxx - S.Syy) / 2;
    const disc = Math.sqrt(diff * diff + S.Sxy * S.Sxy);
    return { max: half + disc, min: Math.max(0, half - disc) };
  }

  /* ---------------------------------------------------------------------
   * GEOMETRIC DEGENERACY MEASURE — replaces v13's absolute |det| < 1e-9.
   *
   * Returns the ratio of the RMS spread perpendicular to the point set's
   * principal axis, to the RMS spread along it:
   *    0   = perfectly collinear (an affine fit is unsolvable)
   *    1   = isotropic spread (ideal conditioning)
   * Because it is a ratio of two spreads it is completely independent of
   * coordinate magnitude, which is precisely the property v13's test lacked.
   *
   * The reciprocal is the factor by which a small perpendicular click error
   * gets amplified into shear error by an affine fit, so it doubles as an
   * honest "how much should you trust this" number for the UI.
   * ------------------------------------------------------------------- */
  function spreadRatio(pts) {
    if (pts.length < 2) return 0;
    const e = eigen2(scatterOf(centerOn(pts, centroidOf(pts))));
    if (e.max <= 0) return 0;
    return Math.sqrt(e.min / e.max);
  }

  // Below this, an affine fit is refused outright as collinear.
  const AFFINE_MIN_SPREAD_RATIO = 1e-3;
  // Between the hard limit and this, the fit is solvable but noise-amplifying,
  // so callers should warn.
  const AFFINE_WARN_SPREAD_RATIO = 0.05;

  /* ---------------------------------------------------------------------
   * Shared transform object construction.
   *
   * A transform is stored as a 2x2 linear part `A` plus the two centroids,
   * and evaluated as:  x' = A * (x - srcCentroid) + tgtCentroid
   * The equivalent global-form coefficients (a..f, or scale/rotation/tx/ty)
   * are also exposed for display, but are never used for evaluation.
   * ------------------------------------------------------------------- */
  function makeTransform(type, A, srcC, tgtC, extra) {
    const [a, b, d, e] = A; // row-major: [[a,b],[d,e]]
    const t = {
      type,
      // linear part, for inspection/tests
      a, b, d, e,
      srcCentroid: srcC.slice(),
      tgtCentroid: tgtC.slice(),
      // Global-form translation, i.e. the c/f of  x' = a*x + b*y + c.
      // Derived, for display and for interoperability with other tools.
      c: tgtC[0] - (a * srcC[0] + b * srcC[1]),
      f: tgtC[1] - (d * srcC[0] + e * srcC[1]),
      // Evaluated in CENTERED form to avoid reintroducing cancellation.
      apply: function (p) {
        const px = p[0] - srcC[0], py = p[1] - srcC[1];
        return [a * px + b * py + tgtC[0], d * px + e * py + tgtC[1]];
      },
    };
    if (extra) for (const k in extra) t[k] = extra[k];
    return t;
  }

  /* ---------------------------------------------------------------------
   * SIMILARITY (Helmert) FIT — uniform scale + rotation + translation.
   *
   * Closed-form least squares on centered coordinates. Shape-preserving, so
   * it cannot invent distortion, which makes it the safe default at low GCP
   * counts where an affine fit would happily absorb click noise as "shear".
   * Needs 2+ distinct points.
   * ------------------------------------------------------------------- */
  function fitSimilarity(sourcePts, targetPts) {
    const n = sourcePts.length;
    const srcC = centroidOf(sourcePts), tgtC = centroidOf(targetPts);
    const P = centerOn(sourcePts, srcC), Q = centerOn(targetPts, tgtC);
    let numA = 0, numB = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const px = P[i][0], py = P[i][1];
      const qx = Q[i][0], qy = Q[i][1];
      numA += px * qx + py * qy;
      numB += px * qy - py * qx;
      den += px * px + py * py;
    }
    if (den === 0) return null; // all source points coincide
    const a = numA / den, b = numB / den; // a = s*cos(theta), b = s*sin(theta)
    return makeTransform('similarity', [a, -b, b, a], srcC, tgtC, {
      scale: Math.hypot(a, b),
      rotationRad: Math.atan2(b, a),
      // v13 exposed tx/ty as the global-form translation; keep those names.
      tx: tgtC[0] - (a * srcC[0] - b * srcC[1]),
      ty: tgtC[1] - (b * srcC[0] + a * srcC[1]),
    });
  }

  /* ---------------------------------------------------------------------
   * AFFINE FIT — 6 parameters: independent scale per axis, shear, rotation,
   * translation. Needs 3+ non-collinear points.
   *
   * Solved as A = C * S^-1 on CENTERED coordinates, where
   *   S = sum p_i p_i^T   (2x2 source scatter)
   *   C = sum q_i p_i^T   (2x2 cross-covariance)
   * Centering removes the translation from the unknowns, shrinking the
   * system from 3x3 to a well-conditioned 2x2 and eliminating v13's
   * catastrophic cancellation entirely.
   * ------------------------------------------------------------------- */
  function fitAffine(sourcePts, targetPts) {
    const n = sourcePts.length;
    const srcC = centroidOf(sourcePts), tgtC = centroidOf(targetPts);
    const P = centerOn(sourcePts, srcC), Q = centerOn(targetPts, tgtC);
    const S = scatterOf(P);
    const det = S.Sxx * S.Syy - S.Sxy * S.Sxy;
    // Scale-invariant degeneracy check (see spreadRatio above). Note this is
    // evaluated on the CENTERED points, so it means what it says regardless
    // of whether coordinates are UTM metres or a synthetic 0-100 box.
    const e = eigen2(S);
    const ratio = e.max > 0 ? Math.sqrt(e.min / e.max) : 0;
    if (ratio < AFFINE_MIN_SPREAD_RATIO || det <= 0) return null;

    let Cxx = 0, Cxy = 0, Cyx = 0, Cyy = 0;
    for (let i = 0; i < n; i++) {
      const px = P[i][0], py = P[i][1];
      const qx = Q[i][0], qy = Q[i][1];
      Cxx += qx * px; Cxy += qx * py;
      Cyx += qy * px; Cyy += qy * py;
    }
    // A = C * S^-1, with S^-1 = (1/det) * [[Syy, -Sxy], [-Sxy, Sxx]]
    const a = (Cxx * S.Syy - Cxy * S.Sxy) / det;
    const b = (-Cxx * S.Sxy + Cxy * S.Sxx) / det;
    const d = (Cyx * S.Syy - Cyy * S.Sxy) / det;
    const eL = (-Cyx * S.Sxy + Cyy * S.Sxx) / det;

    // Human-readable decomposition A = R(theta) * [[sx, sh], [0, sy]]
    const sx = Math.hypot(a, d);
    const rotationRad = Math.atan2(d, a);
    const sy = (a * eL - b * d) / (sx || 1);
    const shear = (a * b + d * eL) / ((sx * sx) || 1);

    return makeTransform('affine', [a, b, d, eL], srcC, tgtC, {
      scaleX: sx, scaleY: sy, rotationRad, shear, spreadRatio: ratio,
    });
  }

  /* ---------------------------------------------------------------------
   * Residuals — per-point and aggregate.
   *
   * Per-point residuals are what make a mis-clicked GCP visible. A single
   * bad tag drags the whole fit; RMS alone hides which tag is at fault.
   * ------------------------------------------------------------------- */
  function residuals(sourcePts, targetPts, transform) {
    const out = [];
    for (let i = 0; i < sourcePts.length; i++) {
      const p = transform.apply(sourcePts[i]);
      out.push(Math.hypot(p[0] - targetPts[i][0], p[1] - targetPts[i][1]));
    }
    return out;
  }

  function rmsOf(list) {
    if (!list.length) return 0;
    let s = 0;
    for (let i = 0; i < list.length; i++) s += list[i] * list[i];
    return Math.sqrt(s / list.length);
  }

  /* =====================================================================
   * LINEAR ALGEBRA
   * =================================================================== */

  // Gaussian elimination with partial pivoting. Returns null on singularity.
  // The pivot tolerance is RELATIVE to the largest entry, not absolute — an
  // absolute threshold is meaningless across coordinate magnitudes, which is
  // the mistake that hid v13's collinearity bug.
  function solveLinearSystem(Ain, bin) {
    const n = Ain.length;
    let maxAbs = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = Math.abs(Ain[i][j]);
      if (v > maxAbs) maxAbs = v;
    }
    if (maxAbs === 0) return null;
    const tol = 1e-12 * maxAbs;

    const A = Ain.map((row, i) => row.slice().concat([bin[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      }
      if (Math.abs(A[piv][col]) <= tol) return null;
      if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
      const d = A[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r][col] / d;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = A[r][n];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
      x[r] = s / A[r][r];
    }
    for (let i = 0; i < n; i++) if (!isFinite(x[i])) return null;
    return x;
  }

  // Cyclic Jacobi eigen-decomposition for a real symmetric matrix. Used to
  // extract the smallest-eigenvalue eigenvector for the homography DLT, which
  // is a genuinely homogeneous problem — forcing h33 = 1 instead would break
  // on any transform where h33 happens to vanish.
  // Returns { values, vectors } where vectors[.][j] is the eigenvector for
  // values[j] (i.e. eigenvectors are COLUMNS).
  function jacobiEigenSymmetric(Ain, maxSweeps) {
    const n = Ain.length;
    const A = Ain.map(r => r.slice());
    const V = [];
    for (let i = 0; i < n; i++) {
      V.push(new Array(n).fill(0));
      V[i][i] = 1;
    }
    const sweeps = maxSweeps || 100;
    for (let sweep = 0; sweep < sweeps; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off <= 1e-30) break;
      for (let p = 0; p < n - 1; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(A[p][q]) <= 1e-300) continue;
          const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
          const sign = theta >= 0 ? 1 : -1;
          const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          // A <- J^T A J, with J[p][p]=c, J[p][q]=s, J[q][p]=-s, J[q][q]=c
          for (let k = 0; k < n; k++) {
            const akp = A[k][p], akq = A[k][q];
            A[k][p] = c * akp - s * akq;
            A[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[p][k], aqk = A[q][k];
            A[p][k] = c * apk - s * aqk;
            A[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const values = [];
    for (let i = 0; i < n; i++) values.push(A[i][i]);
    return { values, vectors: V };
  }

  function mat3mul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
    return C;
  }

  /* ---------------------------------------------------------------------
   * HARTLEY NORMALIZATION — translate to the centroid and scale so the mean
   * distance from it is sqrt(2). Without this the homography DLT is badly
   * conditioned at UTM magnitudes, exactly as v13's affine fit was.
   * ------------------------------------------------------------------- */
  function normalizingTransform(pts) {
    const c = centroidOf(pts);
    let meanDist = 0;
    for (const p of pts) meanDist += Math.hypot(p[0] - c[0], p[1] - c[1]);
    meanDist /= pts.length;
    if (!(meanDist > 0)) return null;
    const s = Math.SQRT2 / meanDist;
    return {
      T: [[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1]],
      Tinv: [[1 / s, 0, c[0]], [0, 1 / s, c[1]], [0, 0, 1]],
      apply: (p) => [s * (p[0] - c[0]), s * (p[1] - c[1])],
    };
  }

  /* =====================================================================
   * PROJECTIVE (HOMOGRAPHY) FIT — 8 parameters, needs 4+ points.
   *
   * Models perspective as well as affine distortion. Relevant when the source
   * imagery is a photographed or scanned cadastral sheet rather than an
   * orthorectified render: a plane viewed obliquely maps to another plane by a
   * homography, which affine cannot represent.
   *
   * Solved by normalized DLT: the smallest eigenvector of A^T A on Hartley-
   * normalized coordinates, then denormalized.
   * =================================================================== */
  function fitProjective(sourcePts, targetPts) {
    const n = sourcePts.length;
    if (n < 4) return null;
    const Ns = normalizingTransform(sourcePts);
    const Nt = normalizingTransform(targetPts);
    if (!Ns || !Nt) return null;

    const p = sourcePts.map(Ns.apply);
    const q = targetPts.map(Nt.apply);

    // Build the 2n x 9 design matrix, then form the 9x9 normal matrix.
    const M = [];
    for (let i = 0; i < 9; i++) M.push(new Array(9).fill(0));
    const addRow = (row) => {
      for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) M[i][j] += row[i] * row[j];
    };
    for (let i = 0; i < n; i++) {
      const [x, y] = p[i];
      const [u, v] = q[i];
      addRow([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
      addRow([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
    }

    const { values, vectors } = jacobiEigenSymmetric(M);
    let iMin = 0;
    for (let i = 1; i < 9; i++) if (values[i] < values[iMin]) iMin = i;
    const maxEig = Math.max(...values.map(Math.abs));
    if (!(maxEig > 0)) return null;
    // Rank check: a unique solution needs exactly one near-null direction. If
    // the second smallest eigenvalue is also negligible the configuration is
    // degenerate (e.g. three collinear points) and the homography is not
    // determined — refuse rather than return an arbitrary member of the family.
    const sorted = values.slice().sort((a, b) => a - b);
    if (sorted[1] <= 1e-12 * maxEig) return null;

    const h = [];
    for (let i = 0; i < 9; i++) h.push(vectors[i][iMin]);
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
    // H = Nt^-1 * Hn * Ns
    let H = mat3mul(Nt.Tinv, mat3mul(Hn, Ns.T));
    if (!H[2][2] || !isFinite(H[2][2])) return null;
    const k = 1 / H[2][2];
    H = H.map(r => r.map(v => v * k));

    const det =
      H[0][0] * (H[1][1] * H[2][2] - H[1][2] * H[2][1]) -
      H[0][1] * (H[1][0] * H[2][2] - H[1][2] * H[2][0]) +
      H[0][2] * (H[1][0] * H[2][1] - H[1][1] * H[2][0]);
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;

    return {
      type: 'projective',
      H,
      apply: function (pt) {
        const w = H[2][0] * pt[0] + H[2][1] * pt[1] + H[2][2];
        if (!w) return [NaN, NaN];
        return [
          (H[0][0] * pt[0] + H[0][1] * pt[1] + H[0][2]) / w,
          (H[1][0] * pt[0] + H[1][1] * pt[1] + H[1][2]) / w,
        ];
      },
    };
  }

  /* =====================================================================
   * THIN-PLATE SPLINE — local rubber-sheeting, needs 3+ points.
   *
   * Interpolates every control point EXACTLY and bends smoothly between them,
   * minimising bending energy. This is what you want when the distortion is
   * genuinely local — a paper sheet stretched unevenly, or a mosaic of tiles
   * digitised at different times — which no global polynomial can express.
   *
   * The flip side, and the reason it is never the default: exact interpolation
   * means the residual at every control point is zero BY CONSTRUCTION, so RMS
   * carries no information at all, and a single mis-clicked GCP is reproduced
   * faithfully instead of being averaged away. Only leave-one-out
   * cross-validation can tell you whether a TPS fit is actually good.
   *
   * Solved in centred, scaled coordinates: the radial basis entries are of
   * order r^2 log r^2 while the affine block carries raw coordinates, so
   * without normalisation the system is hopelessly conditioned at UTM
   * magnitudes.
   * =================================================================== */
  function tpsKernel(r2) {
    // U(r) = r^2 * log(r^2); the r->0 limit is 0.
    return r2 <= 0 ? 0 : r2 * Math.log(r2);
  }

  function fitTps(sourcePts, targetPts, lambda) {
    const n = sourcePts.length;
    if (n < 3) return null;
    const srcC = centroidOf(sourcePts);
    const tgtC = centroidOf(targetPts);
    const centered = centerOn(sourcePts, srcC);
    let meanDist = 0;
    for (const p of centered) meanDist += Math.hypot(p[0], p[1]);
    meanDist /= n;
    if (!(meanDist > 0)) return null;
    const s = 1 / meanDist;
    const p = centered.map(([x, y]) => [x * s, y * s]);
    const q = centerOn(targetPts, tgtC);

    const N = n + 3;
    const A = [];
    for (let i = 0; i < N; i++) A.push(new Array(N).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { A[i][j] = lambda || 0; continue; }
        const dx = p[i][0] - p[j][0], dy = p[i][1] - p[j][1];
        A[i][j] = tpsKernel(dx * dx + dy * dy);
      }
      A[i][n] = 1; A[i][n + 1] = p[i][0]; A[i][n + 2] = p[i][1];
      A[n][i] = 1; A[n + 1][i] = p[i][0]; A[n + 2][i] = p[i][1];
    }
    const bx = new Array(N).fill(0), by = new Array(N).fill(0);
    for (let i = 0; i < n; i++) { bx[i] = q[i][0]; by[i] = q[i][1]; }

    const wx = solveLinearSystem(A, bx);
    const wy = solveLinearSystem(A, by);
    if (!wx || !wy) return null; // singular: control points collinear/coincident

    return {
      type: 'tps',
      controlCount: n,
      lambda: lambda || 0,
      apply: function (pt) {
        const nx = (pt[0] - srcC[0]) * s;
        const ny = (pt[1] - srcC[1]) * s;
        let fx = wx[n] + wx[n + 1] * nx + wx[n + 2] * ny;
        let fy = wy[n] + wy[n + 1] * nx + wy[n + 2] * ny;
        for (let i = 0; i < n; i++) {
          const dx = nx - p[i][0], dy = ny - p[i][1];
          const u = tpsKernel(dx * dx + dy * dy);
          fx += wx[i] * u;
          fy += wy[i] * u;
        }
        return [tgtC[0] + fx, tgtC[1] + fy];
      },
    };
  }

  /* =====================================================================
   * WEIGHTED FITS — the refinement step of robust estimation.
   * =================================================================== */
  function weightedCentroid(pts, w) {
    let sx = 0, sy = 0, sw = 0;
    for (let i = 0; i < pts.length; i++) {
      sx += w[i] * pts[i][0]; sy += w[i] * pts[i][1]; sw += w[i];
    }
    if (!(sw > 0)) return null;
    return [sx / sw, sy / sw];
  }

  function fitSimilarityWeighted(sourcePts, targetPts, w) {
    const n = sourcePts.length;
    const srcC = weightedCentroid(sourcePts, w);
    const tgtC = weightedCentroid(targetPts, w);
    if (!srcC || !tgtC) return null;
    let numA = 0, numB = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const px = sourcePts[i][0] - srcC[0], py = sourcePts[i][1] - srcC[1];
      const qx = targetPts[i][0] - tgtC[0], qy = targetPts[i][1] - tgtC[1];
      numA += w[i] * (px * qx + py * qy);
      numB += w[i] * (px * qy - py * qx);
      den += w[i] * (px * px + py * py);
    }
    if (!(den > 0)) return null;
    const a = numA / den, b = numB / den;
    return makeTransform('similarity', [a, -b, b, a], srcC, tgtC, {
      scale: Math.hypot(a, b),
      rotationRad: Math.atan2(b, a),
      tx: tgtC[0] - (a * srcC[0] - b * srcC[1]),
      ty: tgtC[1] - (b * srcC[0] + a * srcC[1]),
      weighted: true,
    });
  }

  function fitAffineWeighted(sourcePts, targetPts, w) {
    const n = sourcePts.length;
    const srcC = weightedCentroid(sourcePts, w);
    const tgtC = weightedCentroid(targetPts, w);
    if (!srcC || !tgtC) return null;
    let Sxx = 0, Sxy = 0, Syy = 0, Cxx = 0, Cxy = 0, Cyx = 0, Cyy = 0;
    for (let i = 0; i < n; i++) {
      const px = sourcePts[i][0] - srcC[0], py = sourcePts[i][1] - srcC[1];
      const qx = targetPts[i][0] - tgtC[0], qy = targetPts[i][1] - tgtC[1];
      Sxx += w[i] * px * px; Sxy += w[i] * px * py; Syy += w[i] * py * py;
      Cxx += w[i] * qx * px; Cxy += w[i] * qx * py;
      Cyx += w[i] * qy * px; Cyy += w[i] * qy * py;
    }
    const det = Sxx * Syy - Sxy * Sxy;
    const half = (Sxx + Syy) / 2, diff = (Sxx - Syy) / 2;
    const disc = Math.sqrt(diff * diff + Sxy * Sxy);
    const eMax = half + disc, eMin = Math.max(0, half - disc);
    const ratio = eMax > 0 ? Math.sqrt(eMin / eMax) : 0;
    if (ratio < AFFINE_MIN_SPREAD_RATIO || det <= 0) return null;
    const a = (Cxx * Syy - Cxy * Sxy) / det;
    const b = (-Cxx * Sxy + Cxy * Sxx) / det;
    const d = (Cyx * Syy - Cyy * Sxy) / det;
    const eL = (-Cyx * Sxy + Cyy * Sxx) / det;
    const sx = Math.hypot(a, d);
    return makeTransform('affine', [a, b, d, eL], srcC, tgtC, {
      scaleX: sx,
      scaleY: (a * eL - b * d) / (sx || 1),
      rotationRad: Math.atan2(d, a),
      shear: (a * b + d * eL) / ((sx * sx) || 1),
      spreadRatio: ratio,
      weighted: true,
    });
  }

  /* =====================================================================
   * TRANSLATION — pure shift, 2 parameters, usable from a SINGLE point.
   *
   * This exists because of a real failure in the field. An operator tagged two
   * corners and applied a similarity fit; it reported scale 0.9576 and rotation
   * 1.069° with a residual of exactly zero, and threw the whole plot several
   * metres away.
   *
   * Nothing was wrong with the arithmetic. A similarity fit has four degrees of
   * freedom and two points supply exactly four equations, so it reproduces ANY
   * scale and rotation perfectly — residual zero, and meaningless. A 0.4 m
   * error on a 20 m baseline becomes a 2% scale error, which 100 m from the
   * centroid is 2 m of displacement.
   *
   * What that operator actually wanted was to move the plot, not resize it.
   * Translation does only that: it cannot change scale, rotation or shape, so
   * it cannot throw geometry anywhere. It is the honest model when you have
   * one or two points, and it becomes cross-validatable at two — which is why
   * the existing leave-one-out machinery now selects it automatically for the
   * exact case that failed, with no special-casing.
   * =================================================================== */
  function fitTranslation(sourcePts, targetPts) {
    const n = sourcePts.length;
    if (!n) return null;
    let dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      dx += targetPts[i][0] - sourcePts[i][0];
      dy += targetPts[i][1] - sourcePts[i][1];
    }
    dx /= n; dy /= n;
    return makeTransform('translation', [1, 0, 0, 1], [0, 0], [dx, dy], {
      dx, dy,
      scale: 1,
      rotationRad: 0,
      shiftMetres: Math.hypot(dx, dy),
    });
  }

  function fitTranslationWeighted(sourcePts, targetPts, w) {
    let dx = 0, dy = 0, sw = 0;
    for (let i = 0; i < sourcePts.length; i++) {
      dx += w[i] * (targetPts[i][0] - sourcePts[i][0]);
      dy += w[i] * (targetPts[i][1] - sourcePts[i][1]);
      sw += w[i];
    }
    if (!(sw > 0)) return null;
    dx /= sw; dy /= sw;
    return makeTransform('translation', [1, 0, 0, 1], [0, 0], [dx, dy], {
      dx, dy, scale: 1, rotationRad: 0, shiftMetres: Math.hypot(dx, dy), weighted: true,
    });
  }

  /* How violent is this transform? Used to warn before a correction is applied,
   * because "RMS 0.000" tells an operator nothing about whether their plot is
   * about to move twenty metres.
   */
  function describeFitMagnitude(fit, radiusMetres) {
    const r = radiusMetres && radiusMetres > 0 ? radiusMetres : 50;
    const scale = fit.scale != null ? fit.scale
      : (fit.scaleX != null ? (fit.scaleX + fit.scaleY) / 2 : 1);
    const rotDeg = fit.rotationRad != null ? Math.abs(fit.rotationRad * 180 / Math.PI) : 0;
    // Displacement a point `r` from the centroid picks up from scale and
    // rotation alone, ignoring the bodily shift everything shares.
    const fromScale = Math.abs(scale - 1) * r;
    const fromRotation = Math.abs(rotDeg * Math.PI / 180) * r;
    // A single "the shift" figure is only meaningful when every point moves by
    // the same amount, which is true of a translation and of nothing else. For
    // the other models the displacement depends on where you stand, so
    // reporting one number would be a lie; callers get null and should quote
    // `distortionAtRadius` instead.
    const shift = fit.type === 'translation'
      ? (fit.shiftMetres != null ? fit.shiftMetres : Math.hypot(fit.dx || 0, fit.dy || 0))
      : null;
    return {
      scale, scalePct: (scale - 1) * 100, rotationDeg: rotDeg,
      distortionAtRadius: Math.hypot(fromScale, fromRotation),
      radiusMetres: r,
      shiftMetres: shift,
    };
  }

  /* =====================================================================
   * MODEL REGISTRY
   * =================================================================== */
  const MODELS = {
    translation: {
      label: 'Shift only', minPoints: 1, freeParams: 2, complexity: 0,
      fit: (s, t) => fitTranslation(s, t),
      weightedFit: fitTranslationWeighted,
      note: 'Moves the plot without resizing or rotating it. Cannot distort the shape, so it cannot throw it anywhere. The safe choice with one or two points.',
    },
    similarity: {
      label: 'Similarity', minPoints: 2, freeParams: 4, complexity: 1,
      fit: (s, t) => fitSimilarity(s, t),
      weightedFit: fitSimilarityWeighted,
      note: 'Scale, rotation and shift. Cannot distort the shape at all.',
    },
    affine: {
      label: 'Affine', minPoints: 3, freeParams: 6, complexity: 2,
      fit: (s, t) => fitAffine(s, t),
      weightedFit: fitAffineWeighted,
      note: 'Adds shear and per-axis scale. Straight lines stay straight.',
    },
    projective: {
      label: 'Projective', minPoints: 4, freeParams: 8, complexity: 3,
      fit: (s, t) => fitProjective(s, t),
      weightedFit: null,
      note: 'Adds perspective. Use for obliquely photographed or scanned sheets.',
    },
    tps: {
      label: 'Thin-plate spline', minPoints: 3, freeParams: Infinity, complexity: 4,
      fit: (s, t) => fitTps(s, t, 0),
      weightedFit: null,
      note: 'Bends locally through every control point exactly. Powerful, and unforgiving of a bad tag.',
    },
  };

  function fitByType(sourcePts, targetPts, type) {
    const m = MODELS[type];
    if (!m) return null;
    if (sourcePts.length < m.minPoints) return null;
    return m.fit(sourcePts, targetPts);
  }

  /* =====================================================================
   * LEAVE-ONE-OUT CROSS-VALIDATION
   *
   * The only honest way to compare models of different flexibility. A fit's
   * residual at its own control points always improves as you add parameters
   * — TPS drives it to exactly zero — so choosing a model by residual would
   * always pick the most complex one. LOO instead asks the question the user
   * actually cares about: how well does this model predict a corner it has
   * never seen? That is precisely what Apply does to every untagged vertex.
   * =================================================================== */
  function crossValidateLoo(gcpPairs, type) {
    const m = MODELS[type];
    if (!m) return null;
    const n = gcpPairs.length;
    // Need one point to spare, otherwise the reduced fit is not solvable.
    if (n < m.minPoints + 1) return null;
    const errors = [];
    for (let i = 0; i < n; i++) {
      const src = [], tgt = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        src.push(gcpPairs[j].rawPoint);
        tgt.push(gcpPairs[j].confirmedPoint);
      }
      const fit = m.fit(src, tgt);
      if (!fit) return null;
      const pred = fit.apply(gcpPairs[i].rawPoint);
      if (!isFinite(pred[0]) || !isFinite(pred[1])) return null;
      const t = gcpPairs[i].confirmedPoint;
      errors.push(Math.hypot(pred[0] - t[0], pred[1] - t[1]));
    }
    return { looRms: rmsOf(errors), errors };
  }

  /* =====================================================================
   * MODEL RECOMMENDATION
   *
   * Ranks every feasible model by LOO error and then applies a parsimony
   * preference: the simplest model that predicts held-out corners about as
   * well as the best one wins. "About as well" is a relative tolerance plus an
   * absolute floor, because a 5 mm difference on a cadastral plot is noise and
   * should never justify a more distorting transform.
   * =================================================================== */
  const DEFAULT_PARSIMONY_RATIO = 1.15;   // within 15% of the best LOO error
  // ...or within 3 mm, whichever is looser. This floor was originally 1 cm,
  // which turned out to be far too generous: measured on synthetic data, a
  // real shear producing 0.32 m of systematic distortion across a plot was
  // still being dismissed in favour of similarity, because affine only bought
  // ~1 cm of held-out accuracy and 1 cm sat inside the floor. 3 mm is below
  // any cadastral tolerance, so it suppresses genuinely meaningless gains
  // without masking distortion a surveyor would care about.
  const DEFAULT_PARSIMONY_ABS_M = 0.003;

  function recommendTransform(gcpPairs, opts) {
    const o = opts || {};
    const ratioTol = o.parsimonyRatio != null ? o.parsimonyRatio : DEFAULT_PARSIMONY_RATIO;
    const absTol = o.parsimonyAbsM != null ? o.parsimonyAbsM : DEFAULT_PARSIMONY_ABS_M;
    const order = ['translation', 'similarity', 'affine', 'projective', 'tps'];
    const n = gcpPairs ? gcpPairs.length : 0;

    const table = order.map(type => {
      const m = MODELS[type];
      const feasible = n >= m.minPoints;
      let solvable = false;
      if (feasible) {
        solvable = !!fitByType(
          gcpPairs.map(g => g.rawPoint), gcpPairs.map(g => g.confirmedPoint), type);
      }
      const cv = solvable ? crossValidateLoo(gcpPairs, type) : null;
      return {
        type, label: m.label, note: m.note, minPoints: m.minPoints,
        feasible, solvable,
        looRms: cv ? cv.looRms : null,
        validated: !!cv,
      };
    });

    const scored = table.filter(t => t.validated && isFinite(t.looRms));
    if (!scored.length) {
      // Not enough GCPs to validate anything. Recommend the simplest solvable
      // model and say plainly that nothing has been checked.
      const fallback = table.find(t => t.solvable);
      return {
        recommended: fallback ? fallback.type : null,
        table,
        validated: false,
        reason: fallback
          ? `Only ${n} GCP(s): not enough to cross-check any model. Recommending ${MODELS[fallback.type].label} as the least distorting option that is solvable. Tag at least ${MODELS[fallback.type].minPoints + 1} to get a validated recommendation.`
          : `Only ${n} GCP(s): no transform is solvable yet.`,
      };
    }

    let best = scored[0];
    for (const t of scored) if (t.looRms < best.looRms) best = t;
    const threshold = best.looRms * ratioTol + absTol;

    let chosen = best;
    for (const type of order) {
      const cand = scored.find(t => t.type === type);
      if (cand && cand.looRms <= threshold) { chosen = cand; break; }
    }

    let reason;
    if (chosen.type === best.type) {
      reason = `${chosen.label} predicts held-out corners best (leave-one-out error ${chosen.looRms.toFixed(3)} m).`;
    } else {
      reason = `${chosen.label} predicts held-out corners nearly as well as ${best.label} ` +
        `(${chosen.looRms.toFixed(3)} m vs ${best.looRms.toFixed(3)} m), and distorts less, so it is preferred.`;
    }

    return { recommended: chosen.type, table, validated: true, best: best.type, threshold, reason };
  }

  /* =====================================================================
   * ROBUST FITTING — RANSAC consensus followed by Huber IRLS.
   *
   * A mis-clicked GCP does not merely add noise, it biases the whole fit, and
   * ordinary least squares spreads that bias across every point so the guilty
   * tag is not obviously guilty. RANSAC finds the largest self-consistent
   * subset; IRLS then downweights rather than hard-rejects borderline points,
   * so a tag that is merely mediocre still contributes.
   *
   * The RNG is seeded and deterministic: the same tags must always produce the
   * same answer, or the user cannot trust what they are looking at.
   * =================================================================== */
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function medianOf(list) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // Robust scale: 1.4826 * median absolute deviation, which matches the
  // standard deviation for clean Gaussian data but ignores outliers.
  function madScale(res) {
    if (!res.length) return 0;
    const med = medianOf(res);
    return 1.4826 * medianOf(res.map(r => Math.abs(r - med)));
  }

  function sampleIndices(rng, n, k) {
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (n - i));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    return idx.slice(0, k);
  }

  function fitRobust(gcpPairs, type, opts) {
    const o = opts || {};
    const m = MODELS[type];
    if (!m) return { ok: false, error: `Unknown transform type "${type}".` };
    const n = gcpPairs.length;
    if (n < m.minPoints) {
      return { ok: false, error: `${m.label} needs at least ${m.minPoints} GCPs — you have ${n}.` };
    }
    const src = gcpPairs.map(g => g.rawPoint);
    const tgt = gcpPairs.map(g => g.confirmedPoint);

    const base = m.fit(src, tgt);
    if (!base) return { ok: false, error: `Cannot solve a ${m.label.toLowerCase()} transform from these GCPs.` };

    const allIdx = [];
    for (let i = 0; i < n; i++) allIdx.push(i);

    // Naming an outlier requires enough redundancy to say WHICH point is wrong,
    // and that takes minPoints + 2.
    //
    // At exactly minPoints the fit is determined and every residual is zero, so
    // there is nothing to compare. At minPoints + 1 there is a disagreement but
    // no way to attribute it: drop either point and the remainder fits perfectly,
    // so both explanations are equally good and the choice is a coin flip. A
    // shift fitted from two points hit this — RANSAC could reach a consensus of
    // one, and the panel then told the operator that BOTH of their control points
    // looked inconsistent, which is not a statement that can be true.
    //
    // Only at minPoints + 2 does removing a point still leave the model
    // over-determined, which is what makes one candidate genuinely better than
    // another.
    if (n < m.minPoints + 2) {
      const why = n <= m.minPoints
        ? 'exact fit (no redundancy — outliers cannot be detected)'
        : `only ${n} points for a model needing ${m.minPoints} — a disagreement cannot be ` +
          `attributed to either point, so none is called an outlier. ` +
          `${m.minPoints + 2} points would allow it.`;
      return {
        ok: true, fit: base, inliers: allIdx, outliers: [],
        weights: new Array(n).fill(1), threshold: null, robustScale: 0,
        method: why,
      };
    }

    const baseRes = residuals(src, tgt, base);
    const scale = madScale(baseRes);
    const minThresh = o.minThreshold != null ? o.minThreshold : 0.05; // 5 cm floor
    const threshold = o.threshold != null ? o.threshold : Math.max(minThresh, 2.5 * scale);

    // ---- RANSAC consensus ----
    const rng = makeRng(o.seed != null ? o.seed : 20260822);
    const iterations = o.iterations != null ? o.iterations : 300;
    let bestInliers = null;
    for (let it = 0; it < iterations; it++) {
      const pick = sampleIndices(rng, n, m.minPoints);
      const f = m.fit(pick.map(i => src[i]), pick.map(i => tgt[i]));
      if (!f) continue;
      const res = residuals(src, tgt, f);
      const inl = [];
      for (let i = 0; i < n; i++) if (isFinite(res[i]) && res[i] <= threshold) inl.push(i);
      if (!bestInliers || inl.length > bestInliers.length) bestInliers = inl;
      if (bestInliers.length === n) break;
    }
    if (!bestInliers || bestInliers.length < m.minPoints) bestInliers = allIdx;

    // ---- IRLS refinement ----
    let weights = new Array(n).fill(0);
    for (const i of bestInliers) weights[i] = 1;
    let fit = null;

    if (m.weightedFit) {
      // Huber: full weight inside c, then decaying as c/r. Downweighting beats
      // hard rejection because it degrades gracefully near the boundary.
      for (let iter = 0; iter < (o.irlsIterations || 8); iter++) {
        const next = m.weightedFit(src, tgt, weights);
        if (!next) break;
        fit = next;
        const res = residuals(src, tgt, fit);
        const s = madScale(res) || threshold / 2.5;
        const c = 1.345 * (s || minThresh);
        let changed = 0;
        for (let i = 0; i < n; i++) {
          const w = res[i] <= c ? 1 : c / res[i];
          if (Math.abs(w - weights[i]) > 1e-6) changed++;
          weights[i] = w;
        }
        if (!changed) break;
      }
    }
    if (!fit) {
      // Models without a weighted form (projective, TPS) are refit on the
      // consensus set only.
      fit = m.fit(bestInliers.map(i => src[i]), bestInliers.map(i => tgt[i])) || base;
      weights = new Array(n).fill(0);
      for (const i of bestInliers) weights[i] = 1;
    }

    const finalRes = residuals(src, tgt, fit);
    const finalScale = madScale(finalRes);
    const cutoff = Math.max(minThresh, 2.5 * (finalScale || 0), threshold);
    const inliers = [], outliers = [];
    for (let i = 0; i < n; i++) (finalRes[i] <= cutoff ? inliers : outliers).push(i);

    return {
      ok: true, fit, inliers, outliers, weights,
      threshold: cutoff, robustScale: finalScale,
      residuals: finalRes,
      method: m.weightedFit
        ? `RANSAC consensus (${bestInliers.length}/${n}) then Huber IRLS`
        : `RANSAC consensus (${bestInliers.length}/${n}), refit on inliers`,
    };
  }

  /* ---------------------------------------------------------------------
   * Orchestrator used by the extension UI.
   *
   * gcpPairs: [{ vertexIndex, rawPoint:[x,y], confirmedPoint:[x,y] }]
   * options:  { robust: bool, seed }
   * ------------------------------------------------------------------- */
  function fitGcpTransform(gcpPairs, preferredType, options) {
    const o = options || {};
    const type = MODELS[preferredType] ? preferredType : 'similarity';
    const m = MODELS[type];

    if (!gcpPairs || gcpPairs.length < m.minPoints) {
      return {
        ok: false,
        error: `${m.label} needs at least ${m.minPoints} tagged GCPs — you have ${gcpPairs ? gcpPairs.length : 0}.`,
      };
    }
    const src = gcpPairs.map(g => g.rawPoint);
    const tgt = gcpPairs.map(g => g.confirmedPoint);

    let fit = null, warning = null, robust = null;
    if (o.robust) {
      robust = fitRobust(gcpPairs, type, o);
      if (!robust.ok) return { ok: false, error: robust.error };
      fit = robust.fit;
    } else {
      fit = m.fit(src, tgt);
    }

    if (!fit) {
      const why = {
        similarity: 'all tagged GCPs appear to be at the same spot.',
        affine: 'the tagged GCPs are collinear (all on a near-straight line). Tag a point well off that line, or switch to Similarity.',
        projective: 'the tagged GCPs are degenerate — a projective fit needs 4 points in a genuine quadrilateral, no three of them collinear.',
        tps: 'the control points are collinear or coincident, which makes the spline system unsolvable.',
      }[type];
      return { ok: false, error: `Cannot solve a ${m.label.toLowerCase()} transform — ${why}` };
    }

    if (type === 'affine' && fit.spreadRatio != null && fit.spreadRatio < AFFINE_WARN_SPREAD_RATIO) {
      const amp = Math.round(1 / fit.spreadRatio);
      warning = `Your tagged GCPs are nearly collinear, so this affine fit amplifies click error by roughly ${amp}x perpendicular to that line. Tag a point further off the line, or use Similarity, which cannot distort.`;
    }
    if (type === 'tps') {
      warning = (warning ? warning + ' ' : '') +
        'A thin-plate spline passes through every tagged corner exactly, so its residual is always zero and tells you nothing. Judge it by the leave-one-out figure instead, and be aware it will faithfully reproduce a mis-clicked tag.';
    }

    const res = residuals(src, tgt, fit);
    const rms = rmsOf(res);
    let worstIndex = 0;
    for (let i = 1; i < res.length; i++) if (res[i] > res[worstIndex]) worstIndex = i;

    // Zero residual by construction, so it must never read as validation.
    const exactlyDetermined =
      type === 'tps' ||
      (type === 'similarity' && gcpPairs.length === 2) ||
      (type === 'affine' && gcpPairs.length === 3) ||
      (type === 'projective' && gcpPairs.length === 4);

    const cv = crossValidateLoo(gcpPairs, type);

    return {
      ok: true, fit, rms, residuals: res, worstIndex, warning, exactlyDetermined,
      type,
      looRms: cv ? cv.looRms : null,
      robust,
      outliers: robust ? robust.outliers : null,
    };
  }

  /* =====================================================================
   * EXPLICIT VERTEX PAIRING
   *
   * Auto-snapping a control point to whichever vertex happened to be nearest
   * is convenient but takes the decision away from the user. On a dense
   * boundary, or where two parcels share a corner, "nearest" is a coin flip —
   * and the whole point of a control point is that the operator is asserting
   * *this* corner belongs *there*. So pairing is explicit: identify the vertex,
   * then capture its true position.
   * =================================================================== */
  function makeGcpFromVertex(shape, vertexIndex, targetPoint) {
    if (!shape || !Array.isArray(shape.points)) {
      return { ok: false, error: 'No shape supplied.' };
    }
    const n = shape.points.length;
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= n) {
      return { ok: false, error: `Vertex ${vertexIndex} does not exist — this shape has ${n} (0 to ${n - 1}).` };
    }
    if (!Array.isArray(targetPoint) || !isFinite(targetPoint[0]) || !isFinite(targetPoint[1])) {
      return { ok: false, error: 'The captured position is not a usable coordinate.' };
    }
    const source = shape.points[vertexIndex].slice();
    return {
      ok: true,
      gcp: {
        shapeId: shape.id,
        vertexIndex,
        source,
        target: [targetPoint[0], targetPoint[1]],
        enabled: true,
      },
      shift: Math.hypot(targetPoint[0] - source[0], targetPoint[1] - source[1]),
    };
  }

  /* Apply a fit WITHOUT mutating anything, so the corrected geometry can be
   * shown as a preview before the user commits. Seeing where a correction will
   * put the boundary is the difference between reviewing it and hoping.
   */
  function previewCorrected(shapes, transform) {
    if (!transform || typeof transform.apply !== 'function') return [];
    return shapes.map((s) => ({
      id: s.id,
      points: (s.points || []).map((p) => transform.apply(p)),
    }));
  }

  /* =====================================================================
   * COVERAGE ASSESSMENT
   *
   * How many control points a shape has matters less than how they are spread.
   * Four points clustered along one edge constrain that edge and extrapolate
   * wildly everywhere else, while three at well-separated corners constrain the
   * whole parcel. Residuals cannot reveal this — a clustered fit can have a
   * beautiful residual and still be worthless twenty metres away. So it is
   * reported separately, per shape.
   * =================================================================== */
  function describeGcpSpread(gcps) {
    const pts = gcps.map((g) => g.source || g.rawPoint).filter(Boolean);
    if (pts.length < 2) {
      return { count: pts.length, ratio: 0, quality: 'insufficient', message: `${pts.length} control point(s) — at least 2 are needed.` };
    }
    const ratio = spreadRatio(pts);
    let extent = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        extent = Math.max(extent, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
      }
    }
    let quality, message;
    // Two points are ALWAYS exactly collinear, so the collinearity test has to
    // come after this case or it fires spuriously. Collinearity is a problem
    // for affine and projective, which need spread in both directions; a
    // similarity fit from two points is perfectly well determined.
    if (pts.length === 2) {
      quality = 'minimal';
      message = `2 control points, ${extent.toFixed(1)} m apart. Enough for a similarity fit, but nothing cross-checks them — add a third.`;
    } else if (ratio < 0.05) {
      quality = 'collinear';
      message = `${pts.length} control points, but they lie almost in a straight line (spread ratio ${ratio.toFixed(3)}). ` +
        `The correction is well constrained along that line and barely constrained across it. Add a point well off it.`;
    } else if (ratio < 0.25) {
      quality = 'poor';
      message = `${pts.length} control points, but unevenly spread (ratio ${ratio.toFixed(2)}). Accuracy away from them will be worse than the residual suggests.`;
    } else {
      quality = 'good';
      message = `${pts.length} control points spread across roughly ${extent.toFixed(1)} m (ratio ${ratio.toFixed(2)}).`;
    }
    return { count: pts.length, ratio, extent, quality, message };
  }

  // Per-shape coverage, so a session with one well-controlled parcel and four
  // uncontrolled ones cannot masquerade as georeferenced.
  function assessCoverage(shapes, gcps) {
    const enabled = gcps.filter((g) => g.enabled !== false);
    const byShape = new Map();
    for (const g of enabled) {
      if (g.shapeId == null) continue;
      if (!byShape.has(g.shapeId)) byShape.set(g.shapeId, []);
      byShape.get(g.shapeId).push(g);
    }
    const loose = enabled.filter((g) => g.shapeId == null).length;
    const perShape = shapes.map((s) => {
      const list = byShape.get(s.id) || [];
      return {
        shapeId: s.id,
        plotNo: s.plotNo == null ? null : s.plotNo,
        count: list.length,
        spread: list.length ? describeGcpSpread(list) : null,
        vertexCount: (s.points || []).length,
        taggedVertices: list.map((g) => g.vertexIndex).filter((v) => v != null).sort((a, b) => a - b),
      };
    });
    const withNone = perShape.filter((p) => p.count === 0);
    return {
      perShape,
      looseCount: loose,
      shapesWithControl: perShape.length - withNone.length,
      shapesWithoutControl: withNone.map((p) => p.shapeId),
      summary: withNone.length
        ? `${perShape.length - withNone.length} of ${perShape.length} shape(s) have control points. ` +
          `"Move all" would also move the other ${withNone.length}, on the assumption they drift the same way — ` +
          `"Move tagged" would leave them where they are.`
        : `All ${perShape.length} shape(s) have control points.`,
    };
  }

  return {
    // primitives
    centroidOf, spreadRatio, residuals, rmsOf,
    // explicit pairing, preview and coverage
    makeGcpFromVertex, previewCorrected, describeGcpSpread, assessCoverage,
    solveLinearSystem, jacobiEigenSymmetric, normalizingTransform, mat3mul,
    medianOf, madScale, makeRng,
    // fits
    fitTranslation, fitTranslationWeighted, fitSimilarity, fitAffine, fitProjective, fitTps,
    describeFitMagnitude,
    fitSimilarityWeighted, fitAffineWeighted, fitByType,
    // evaluation + selection
    MODELS, crossValidateLoo, recommendTransform, fitRobust, fitGcpTransform,
    // constants
    AFFINE_MIN_SPREAD_RATIO, AFFINE_WARN_SPREAD_RATIO,
    DEFAULT_PARSIMONY_RATIO, DEFAULT_PARSIMONY_ABS_M,
  };
});
