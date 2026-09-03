/* =========================================================================
 * Geometry editing, non-destructive shift bookkeeping, and drawing scale.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_GeomEdit) or a CommonJS module. Pure:
 * no DOM, no map, so all of it is testable headlessly.
 *
 * THREE THINGS LIVE HERE
 *
 *  1. MOVE / ROTATE / SCALE of a parcel (brief §3, §10). Rotation and scaling
 *     are about the parcel's OWN centroid by default, so a rotation does not
 *     also translate it — which is what makes "rotate 2°" mean what a surveyor
 *     expects rather than swinging the parcel across the sheet.
 *
 *  2. THE SHIFT RECORD (brief §4). Every move, rotation and scale applied to a
 *     parcel is accumulated into one similarity transform stored ALONGSIDE the
 *     geometry:
 *
 *         p → scale · R(rotation) · p + (dx, dy)
 *
 *     Similarities compose to similarities, so this is exact rather than an
 *     approximation: the record always states precisely what was done to the
 *     original, however many operations were stacked. That gives all four
 *     things §4 asks for — undo it, reset it, compare original against
 *     corrected, and export the corrected geometry — without making displayed
 *     geometry a derived value, which would have meant rewriting every
 *     consumer of shape.points in the program.
 *
 *     Note this is a RECORD, not the source of truth for drawing. shape.points
 *     stays the live geometry. The record is what makes the correction
 *     reviewable and reversible.
 *
 *  3. DRAWING SCALE (brief §12, §13) — RF and scale-bar calibration, kept
 *     rigorously separate from screen zoom.
 *
 * WHY AN RF ALONE IS NOT A SCALE
 *
 * An RF of 1:2000 says one unit ON THE PAPER is 2000 units on the ground. It
 * says nothing about how many pixels a paper unit became when the sheet was
 * scanned, and a scanned image is measured in pixels. So converting an RF to
 * ground metres per pixel needs the scan resolution too:
 *
 *     ground metres per pixel = RF denominator / (DPI / 0.0254)
 *
 * The 0.0254 is metres per inch. Assuming a DPI silently would be exactly the
 * kind of invented certainty lib/crs.js refuses to produce for a UTM zone, so
 * the caller must supply it and the panel must show it.
 *
 * The scale-bar route needs no DPI at all — two points on the drawing and the
 * ground distance between them give metres per pixel directly — which makes it
 * the more reliable of the two, and it is offered alongside rather than
 * beneath.
 *
 * NEITHER IS AFFECTED BY SCREEN ZOOM. Calibration is a property of the image;
 * the viewport's scale is a property of the display. Nothing here reads the
 * viewport (brief §12, §26).
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_GeomEdit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const METRES_PER_INCH = 0.0254;
  const DEG = Math.PI / 180;
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  /* =====================================================================
   * RING BASICS
   * =================================================================== */
  /* Area centroid, computed in a LOCAL FRAME.
   *
   * The shoelace centroid is a ratio of two sums that both grow with the square
   * of the coordinate magnitude, while the answer depends on their difference.
   * At Jharkhand UTM coordinates the cross products run to ~1.1e12 for a plot
   * whose area is ~1600 m² — nine orders of magnitude of cancellation — and a
   * 40 m square comes out with its centroid 13 cm adrift. Subtracting the first
   * vertex first makes every term the size of the plot instead of the size of
   * the grid, and the centroid is translation-equivariant so adding it back is
   * exact.
   *
   * This is the same failure mode v13's affine fit had: correct on small test
   * coordinates, wrong at the magnitudes the program actually runs at. It
   * matters here because this centroid is the pivot Rotate and Scale turn
   * about, and a pivot 13 cm from the true centre translates the parcel while
   * claiming only to have rotated it.
   */
  function ringCentroid(ring) {
    if (!ring || !ring.length) return null;
    const ox = ring[0][0]; const oy = ring[0][1];
    let a = 0; let cx = 0; let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const jx = ring[j][0] - ox; const jy = ring[j][1] - oy;
      const ix = ring[i][0] - ox; const iy = ring[i][1] - oy;
      const cross = jx * iy - ix * jy;
      a += cross;
      cx += (jx + ix) * cross;
      cy += (jy + iy) * cross;
    }
    a *= 0.5;
    // A degenerate ring bounds no area, so the area centroid is undefined and
    // the vertex mean is the only answer available.
    if (Math.abs(a) < 1e-12) {
      let sx = 0; let sy = 0;
      for (const p of ring) { sx += p[0]; sy += p[1]; }
      return [sx / ring.length, sy / ring.length];
    }
    return [cx / (6 * a) + ox, cy / (6 * a) + oy];
  }

  function boundsOfRing(ring) {
    if (!ring || !ring.length) return null;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of ring) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  const cloneRing = (ring) => ring.map((p) => [p[0], p[1]]);

  /* =====================================================================
   * PRIMITIVE OPERATIONS
   * =================================================================== */
  function translateRing(ring, dx, dy) {
    if (!isNum(dx) || !isNum(dy)) return cloneRing(ring);
    return ring.map((p) => [p[0] + dx, p[1] + dy]);
  }

  function rotateRing(ring, degrees, origin) {
    if (!isNum(degrees) || degrees === 0) return cloneRing(ring);
    const o = origin || ringCentroid(ring) || [0, 0];
    const t = degrees * DEG;
    const c = Math.cos(t); const s = Math.sin(t);
    return ring.map((p) => {
      const x = p[0] - o[0]; const y = p[1] - o[1];
      return [o[0] + x * c - y * s, o[1] + x * s + y * c];
    });
  }

  function scaleRing(ring, factor, origin) {
    if (!isNum(factor) || factor === 1) return cloneRing(ring);
    const o = origin || ringCentroid(ring) || [0, 0];
    return ring.map((p) => [o[0] + (p[0] - o[0]) * factor, o[1] + (p[1] - o[1]) * factor]);
  }

  /* =====================================================================
   * THE SHIFT RECORD
   * ---------------------------------------------------------------------
   * A similarity: p -> scale * R(rotationDeg) * p + (dx, dy).
   * =================================================================== */
  function identityShift() {
    return { dx: 0, dy: 0, rotationDeg: 0, scale: 1 };
  }

  function isIdentityShift(s) {
    if (!s) return true;
    return Math.abs(s.dx || 0) < 1e-9 && Math.abs(s.dy || 0) < 1e-9
      && Math.abs(s.rotationDeg || 0) < 1e-12 && Math.abs((s.scale == null ? 1 : s.scale) - 1) < 1e-12;
  }

  function applyShift(shift, point) {
    if (!shift) return [point[0], point[1]];
    const s = shift.scale == null ? 1 : shift.scale;
    const t = (shift.rotationDeg || 0) * DEG;
    const c = Math.cos(t); const sn = Math.sin(t);
    const x = point[0]; const y = point[1];
    return [
      s * (x * c - y * sn) + (shift.dx || 0),
      s * (x * sn + y * c) + (shift.dy || 0),
    ];
  }

  function applyShiftToRing(shift, ring) {
    if (!shift || isIdentityShift(shift)) return cloneRing(ring);
    return ring.map((p) => applyShift(shift, p));
  }

  /* Compose two similarities: `next` applied after `first`.
   *
   *   T2(T1(p)) = s2·R2·(s1·R1·p + t1) + t2
   *             = (s2·s1)·R(θ1+θ2)·p + (s2·R2·t1 + t2)
   *
   * Exact, which is why the record can be trusted after any number of
   * operations rather than drifting from the geometry it describes.
   */
  function composeShift(first, next) {
    const a = first || identityShift();
    const b = next || identityShift();
    const s1 = a.scale == null ? 1 : a.scale;
    const s2 = b.scale == null ? 1 : b.scale;
    const t2 = (b.rotationDeg || 0) * DEG;
    const c = Math.cos(t2); const sn = Math.sin(t2);
    const tx = a.dx || 0; const ty = a.dy || 0;
    return {
      scale: s2 * s1,
      rotationDeg: (a.rotationDeg || 0) + (b.rotationDeg || 0),
      dx: s2 * (tx * c - ty * sn) + (b.dx || 0),
      dy: s2 * (tx * sn + ty * c) + (b.dy || 0),
    };
  }

  /* The shift equivalent to rotating about a point: translate the origin to
   * that point, rotate, translate back. Expressed as a similarity so it
   * composes with everything else. */
  function shiftForRotationAbout(degrees, origin) {
    const o = origin || [0, 0];
    const t = (degrees || 0) * DEG;
    const c = Math.cos(t); const s = Math.sin(t);
    return {
      scale: 1,
      rotationDeg: degrees || 0,
      dx: o[0] - (o[0] * c - o[1] * s),
      dy: o[1] - (o[0] * s + o[1] * c),
    };
  }

  function shiftForScaleAbout(factor, origin) {
    const o = origin || [0, 0];
    const f = factor == null ? 1 : factor;
    return { scale: f, rotationDeg: 0, dx: o[0] * (1 - f), dy: o[1] * (1 - f) };
  }

  function shiftForTranslation(dx, dy) {
    return { scale: 1, rotationDeg: 0, dx: dx || 0, dy: dy || 0 };
  }

  /* Invert a similarity, which is what "reset this shift" needs. */
  function invertShift(shift) {
    const s = shift && shift.scale != null ? shift.scale : 1;
    if (!isNum(s) || s === 0) return identityShift();
    const t = -((shift && shift.rotationDeg) || 0) * DEG;
    const c = Math.cos(t); const sn = Math.sin(t);
    const inv = 1 / s;
    const dx = (shift && shift.dx) || 0;
    const dy = (shift && shift.dy) || 0;
    return {
      scale: inv,
      rotationDeg: -((shift && shift.rotationDeg) || 0),
      dx: -inv * (dx * c - dy * sn),
      dy: -inv * (dx * sn + dy * c),
    };
  }

  /* How far a shift actually moves a parcel, and whether it deforms it. Quoted
   * at the geometry rather than as raw parameters, because "dx = 3.2" does not
   * tell an operator what happened to a plot that was also rotated. */
  function describeShift(shift, ring) {
    const s = shift || identityShift();
    const scale = s.scale == null ? 1 : s.scale;
    const rot = s.rotationDeg || 0;
    const out = {
      identity: isIdentityShift(s),
      scale, rotationDeg: rot,
      deforms: Math.abs(scale - 1) > 1e-9 || Math.abs(rot) > 1e-9,
      translationMetres: Math.hypot(s.dx || 0, s.dy || 0),
      maxVertexMove: null,
      centroidMove: null,
      parts: [],
    };
    if (ring && ring.length) {
      let worst = 0;
      for (const p of ring) {
        const q = applyShift(s, p);
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d > worst) worst = d;
      }
      out.maxVertexMove = worst;
      const c = ringCentroid(ring);
      if (c) {
        const cc = applyShift(s, c);
        out.centroidMove = Math.hypot(cc[0] - c[0], cc[1] - c[1]);
      }
    }
    if (!out.identity) {
      if (out.centroidMove != null && out.centroidMove > 1e-9) out.parts.push(`moved ${out.centroidMove.toFixed(3)} m`);
      else if (out.translationMetres > 1e-9) out.parts.push(`shifted ${out.translationMetres.toFixed(3)} m`);
      if (Math.abs(rot) > 1e-9) out.parts.push(`rotated ${rot.toFixed(4)}°`);
      if (Math.abs(scale - 1) > 1e-9) out.parts.push(`scaled ×${scale.toFixed(6)}`);
    }
    out.summary = out.identity ? 'unshifted' : out.parts.join(', ');
    return out;
  }

  /* =====================================================================
   * DRAWING SCALE — RF AND SCALE BAR  (brief §12, §13)
   * =================================================================== */
  const COMMON_RF = [500, 1000, 2000, 2500, 4000, 5000, 10000];
  const COMMON_DPI = [72, 96, 150, 200, 300, 400, 600, 1200];

  /* RF 1:D scanned at `dpi` gives this many ground metres per image pixel. */
  function groundMetresPerPixelFromRf(rfDenominator, dpi) {
    const d = Number(rfDenominator);
    const p = Number(dpi);
    if (!isNum(d) || d <= 0) return { ok: false, error: 'The RF denominator must be a positive number — the 2000 in 1:2000.' };
    if (!isNum(p) || p <= 0) return { ok: false, error: 'The scan resolution (DPI) is needed too: an RF relates paper distance to ground distance, and a pixel is not a paper unit until the DPI says how many of them fit in an inch.' };
    const pixelsPerMetreOfPaper = p / METRES_PER_INCH;
    return { ok: true, metresPerPixel: d / pixelsPerMetreOfPaper };
  }

  /* Two points on the drawing plus the real distance between them. No DPI
   * needed, and therefore no assumption to get wrong. */
  function metresPerPixelFromScaleBar(pixelA, pixelB, groundDistanceMetres) {
    if (!pixelA || !pixelB || pixelA.length < 2 || pixelB.length < 2) {
      return { ok: false, error: 'Pick two points on the drawing first.' };
    }
    const px = Math.hypot(pixelB[0] - pixelA[0], pixelB[1] - pixelA[1]);
    const g = Number(groundDistanceMetres);
    if (!(px > 0)) return { ok: false, error: 'Those two points are the same pixel — pick two ends of a known distance.' };
    if (!isNum(g) || g <= 0) return { ok: false, error: 'Enter the real ground distance between those two points, in metres.' };
    return { ok: true, metresPerPixel: g / px, pixelDistance: px, groundDistance: g };
  }

  /* One calibration record, whichever route produced it, stored in the project
   * (brief §13) and never touched by zooming (brief §12, §26). */
  function makeCalibration(opts) {
    const o = opts || {};
    if (o.method === 'rf') {
      const r = groundMetresPerPixelFromRf(o.rfDenominator, o.dpi);
      if (!r.ok) return r;
      return {
        ok: true,
        calibration: {
          method: 'rf',
          rfDenominator: Number(o.rfDenominator),
          dpi: Number(o.dpi),
          metresPerPixel: r.metresPerPixel,
          note: `RF 1:${Number(o.rfDenominator)} at ${Number(o.dpi)} dpi`,
          setAt: o.now || null,
        },
      };
    }
    if (o.method === 'scalebar') {
      const r = metresPerPixelFromScaleBar(o.pixelA, o.pixelB, o.groundDistanceMetres);
      if (!r.ok) return r;
      return {
        ok: true,
        calibration: {
          method: 'scalebar',
          pixelA: [o.pixelA[0], o.pixelA[1]],
          pixelB: [o.pixelB[0], o.pixelB[1]],
          groundDistanceMetres: r.groundDistance,
          pixelDistance: r.pixelDistance,
          metresPerPixel: r.metresPerPixel,
          note: `${r.groundDistance} m measured over ${r.pixelDistance.toFixed(1)} px`,
          setAt: o.now || null,
        },
      };
    }
    return { ok: false, error: 'Choose RF or scale-bar calibration.' };
  }

  /* What an existing calibration implies as an RF, so the two routes can be
   * cross-checked against each other. A scale bar that implies 1:1970 on a
   * sheet labelled 1:2000 is agreement; one that implies 1:600 is not, and the
   * operator should see that rather than trust whichever was entered last. */
  function impliedRf(calibration, dpi) {
    if (!calibration || !isNum(calibration.metresPerPixel)) return null;
    const p = Number(dpi);
    if (!isNum(p) || p <= 0) return null;
    return calibration.metresPerPixel * (p / METRES_PER_INCH);
  }

  function pixelLengthToGround(lengthPx, calibration) {
    if (!calibration || !isNum(calibration.metresPerPixel)) return null;
    return lengthPx * calibration.metresPerPixel;
  }

  function pixelAreaToGround(areaPx2, calibration) {
    if (!calibration || !isNum(calibration.metresPerPixel)) return null;
    return areaPx2 * calibration.metresPerPixel * calibration.metresPerPixel;
  }

  /* Compare an RF the operator typed against a scale bar they measured. */
  function compareCalibrations(rfCal, barCal) {
    if (!rfCal || !barCal || !isNum(rfCal.metresPerPixel) || !isNum(barCal.metresPerPixel)) return null;
    const ratio = barCal.metresPerPixel / rfCal.metresPerPixel;
    const pct = (ratio - 1) * 100;
    return {
      ratio, differencePct: pct,
      agree: Math.abs(pct) <= 2,
      message: Math.abs(pct) <= 2
        ? `The scale bar and the RF agree to ${Math.abs(pct).toFixed(2)}%.`
        : `The scale bar disagrees with the RF by ${pct.toFixed(1)}%. One of them is wrong — most often the assumed scan DPI, or a sheet that was reproduced at a different size from its printed RF. The scale bar is the more direct measurement.`,
    };
  }

  /* =====================================================================
   * COPY / DUPLICATE  (brief §10)
   * ---------------------------------------------------------------------
   * A duplicate is offset by default. Placing it exactly on top of the
   * original makes two coincident parcels that the topology checker correctly
   * reports as a total overlap, and that the operator cannot select apart.
   * =================================================================== */
  function duplicateRing(ring, offset) {
    const b = boundsOfRing(ring);
    const d = offset != null ? offset : (b ? Math.max(b.width, b.height) * 0.08 : 0);
    return translateRing(ring, d, -d);
  }

  return {
    METRES_PER_INCH, COMMON_RF, COMMON_DPI,
    // rings
    ringCentroid, boundsOfRing, cloneRing,
    translateRing, rotateRing, scaleRing, duplicateRing,
    // shift record
    identityShift, isIdentityShift, applyShift, applyShiftToRing,
    composeShift, invertShift, describeShift,
    shiftForTranslation, shiftForRotationAbout, shiftForScaleAbout,
    // drawing scale
    groundMetresPerPixelFromRf, metresPerPixelFromScaleBar, makeCalibration,
    impliedRf, pixelLengthToGround, pixelAreaToGround, compareCalibrations,
  };
});
