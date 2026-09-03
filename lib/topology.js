/* =========================================================================
 * Topology, regularisation and quality scoring.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Topology) or a CommonJS module. Pure.
 *
 * WHY THIS EXISTS
 *
 * Up to v15 the digitizer produced geometrically valid but practically poor
 * polygons, for two reasons that no amount of GCP correction fixes:
 *
 *  1. A flood-fill boundary is a raster staircase. Simplification collapses the
 *     long runs, but the corners land on pixel centres and the edges wobble a
 *     fraction of a degree off true. Cadastral parcels are overwhelmingly
 *     straight-edged with near-right-angle corners, so that wobble is noise,
 *     not signal — and it survives into DXF and Shapefile output where a
 *     surveyor has to clean it by hand.
 *
 *  2. Adjacent parcels traced separately do not share edges. Each is traced
 *     from its own flood fill, so a common boundary comes out twice, a few
 *     centimetres apart, producing overlaps and slivers. Every GIS consumer
 *     treats that as a topology error, and it is invisible on screen.
 *
 * Both are addressed here, conservatively: nothing is altered unless the
 * evidence is clear, and every adjustment is reported so it can be reviewed
 * rather than silently trusted.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Topology = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  /* =====================================================================
   * PRIMITIVES
   * =================================================================== */
  function openRing(ring) {
    const r = ring.slice();
    while (r.length > 1 &&
           r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    return r;
  }

  function signedArea(ring) {
    const r = openRing(ring);
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function distPointToSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return { dist: Math.hypot(p[0] - a[0], p[1] - a[1]), t: 0, point: a.slice() };
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + t * dx, a[1] + t * dy];
    return { dist: Math.hypot(p[0] - q[0], p[1] - q[1]), t, point: q };
  }

  // Ray casting. Points exactly on the boundary are unstable by nature, so
  // callers that care use pointOnBoundary() as well.
  function pointInRing(p, ring) {
    const r = openRing(ring);
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > p[1]) !== (yj > p[1])) &&
          (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function pointOnBoundary(p, ring, tol) {
    const r = openRing(ring);
    for (let i = 0; i < r.length; i++) {
      if (distPointToSegment(p, r[i], r[(i + 1) % r.length]).dist <= (tol || 1e-9)) return true;
    }
    return false;
  }

  function segmentsProperlyIntersect(p1, p2, p3, p4) {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function boundsOf(ring) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const p of ring) {
      if (p[0] < xmin) xmin = p[0];
      if (p[1] < ymin) ymin = p[1];
      if (p[0] > xmax) xmax = p[0];
      if (p[1] > ymax) ymax = p[1];
    }
    return { xmin, ymin, xmax, ymax };
  }

  function boundsOverlap(a, b, pad) {
    const p = pad || 0;
    return !(a.xmax + p < b.xmin || b.xmax + p < a.xmin ||
             a.ymax + p < b.ymin || b.ymax + p < a.ymin);
  }

  /* =====================================================================
   * SNAPPING
   *
   * The point of snapping is that a shared cadastral boundary should be
   * EXACTLY shared, not merely close. Vertices snap to existing vertices
   * first (an exact coincidence is what topology cleanliness means), then to
   * edges, which handles the case where a neighbour has a vertex partway
   * along the edge being drawn.
   * =================================================================== */
  /* Every vertex, on every other shape, that sits within `tolerance` of `pt`.
   *
   * WHY ALL OF THEM, not just the nearest: a cadastral corner is routinely
   * shared by three or four parcels. `snapPoint` deliberately returns only the
   * best candidate, which is right for snapping but wrong for editing — moving a
   * shared corner has to move EVERY parcel that meets there, or the ones left
   * behind end up crossing the one that moved. That was the reported bug.
   */
  function findCoincidentVertices(shapes, pt, tolerance, excludeShapeId) {
    const tol = tolerance != null ? tolerance : 0.5;
    const hits = [];
    for (const s of shapes || []) {
      if (!s || !s.points || s.id === excludeShapeId) continue;
      for (let i = 0; i < s.points.length; i++) {
        const d = Math.hypot(s.points[i][0] - pt[0], s.points[i][1] - pt[1]);
        if (d <= tol) hits.push({ shapeId: s.id, vertexIndex: i, dist: d });
      }
    }
    return hits.sort((a, b) => a.dist - b.dist);
  }

  /* Which pairs of shapes overlap or cross, as a set of stable "a|b" keys.
   *
   * Comparing this before and after an operation is what lets the app say "this
   * apply CREATED two new crossings" rather than "your session has crossings",
   * which is the difference between a useful warning and noise the operator
   * learns to click through.
   */
  function crossingPairs(shapes) {
    const list = (shapes || []).filter((s) => s && s.points && s.points.length >= 3);
    const keys = new Set();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (ringsOverlap(list[i].points, list[j].points)) {
          const a = list[i].id, b = list[j].id;
          keys.add(a < b ? `${a}|${b}` : `${b}|${a}`);
        }
      }
    }
    return keys;
  }

  /* The pairs present in `after` that were not present in `before`. */
  function newCrossings(before, after) {
    const out = [];
    for (const k of after) if (!before.has(k)) out.push(k);
    return out;
  }

  function snapPoint(pt, shapes, tolerance, excludeShapeId) {
    let best = null;
    // Pass 1: existing vertices win outright, because vertex-to-vertex is the
    // only form of sharing that survives every downstream tool.
    for (const s of shapes) {
      if (!s.points || s.id === excludeShapeId) continue;
      for (let i = 0; i < s.points.length; i++) {
        const d = Math.hypot(s.points[i][0] - pt[0], s.points[i][1] - pt[1]);
        if (d <= tolerance && (!best || d < best.dist)) {
          best = { dist: d, point: s.points[i].slice(), kind: 'vertex', shapeId: s.id, index: i };
        }
      }
    }
    if (best) return best;
    // Pass 2: nearest edge.
    for (const s of shapes) {
      if (!s.points || s.id === excludeShapeId) continue;
      const r = openRing(s.points);
      for (let i = 0; i < r.length; i++) {
        const res = distPointToSegment(pt, r[i], r[(i + 1) % r.length]);
        if (res.dist <= tolerance && (!best || res.dist < best.dist)) {
          best = { dist: res.dist, point: res.point, kind: 'edge', shapeId: s.id, index: i };
        }
      }
    }
    return best;
  }

  // Snap a whole ring onto its neighbours. Returns a report rather than just
  // the geometry, because a snap that moves a vertex a long way is worth
  // seeing rather than absorbing.
  function snapRing(ring, shapes, tolerance, excludeShapeId) {
    const out = [];
    const snaps = [];
    for (let i = 0; i < ring.length; i++) {
      const s = snapPoint(ring[i], shapes, tolerance, excludeShapeId);
      if (s) {
        out.push(s.point);
        snaps.push({ index: i, movedBy: s.dist, kind: s.kind, toShapeId: s.shapeId });
      } else {
        out.push(ring[i].slice());
      }
    }
    return { ring: out, snaps, snappedCount: snaps.length };
  }

  /* =====================================================================
   * REGULARISATION
   *
   * Two independent steps, both optional and both reported:
   *
   *   removeCollinear  drops vertices that add no shape, judged by the
   *                    perpendicular offset they introduce rather than by
   *                    angle, since angle is meaningless for short edges.
   *
   *   squareUp         finds the parcel's dominant edge direction, and snaps
   *                    edges that are already within a few degrees of that
   *                    grid onto it exactly. This is what turns a raster
   *                    staircase back into the straight-sided, right-angled
   *                    polygon the original survey almost certainly was.
   * =================================================================== */
  function removeCollinear(ring, offsetTolerance) {
    const tol = offsetTolerance == null ? 0.05 : offsetTolerance;
    let r = openRing(ring);
    if (r.length <= 3) return { ring: r.slice(), removed: 0 };
    let removed = 0;
    let changed = true;
    while (changed && r.length > 3) {
      changed = false;
      for (let i = 0; i < r.length; i++) {
        const prev = r[(i - 1 + r.length) % r.length];
        const cur = r[i];
        const next = r[(i + 1) % r.length];
        if (distPointToSegment(cur, prev, next).dist <= tol) {
          r = r.slice(0, i).concat(r.slice(i + 1));
          removed++;
          changed = true;
          break;
        }
      }
    }
    return { ring: r, removed };
  }

  // Dominant orientation of the ring's edges, in [0, 90). Edges are weighted by
  // length, so a few short jagged segments cannot outvote the real boundary,
  // and directions are folded modulo 90° because a rectangle's two edge
  // families describe the same grid.
  function dominantOrientation(ring) {
    const r = openRing(ring);
    if (r.length < 2) return 0;
    // Circular mean over doubled angles: averaging angles directly is wrong
    // near the 0/90 wrap, and doubling maps the modulo-90 space onto a circle.
    let sx = 0, sy = 0, total = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      let ang = Math.atan2(dy, dx) * RAD;
      ang = ((ang % 90) + 90) % 90;      // fold into [0,90)
      const doubled = ang * 4 * DEG;      // 90 -> full circle
      sx += len * Math.cos(doubled);
      sy += len * Math.sin(doubled);
      total += len;
    }
    if (!total || (sx === 0 && sy === 0)) return 0;
    let mean = Math.atan2(sy, sx) * RAD / 4;
    mean = ((mean % 90) + 90) % 90;
    return mean;
  }

  // Fraction of perimeter that already lies within `tolDeg` of the dominant
  // grid. This is the evidence for whether squaring up is appropriate at all —
  // a genuinely curved or irregular parcel scores low and should be left alone.
  function gridAlignment(ring, tolDeg) {
    const r = openRing(ring);
    const theta = dominantOrientation(r);
    const tol = tolDeg == null ? 8 : tolDeg;
    let aligned = 0, total = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      let ang = Math.atan2(dy, dx) * RAD;
      ang = ((ang % 90) + 90) % 90;
      let diff = Math.abs(ang - theta);
      diff = Math.min(diff, 90 - diff);   // wrap
      if (diff <= tol) aligned += len;
      total += len;
    }
    return { orientation: theta, alignedFraction: total ? aligned / total : 0 };
  }

  /* Snap near-axis edges onto the dominant grid.
   *
   * Works in a frame rotated by -theta so the grid becomes axis-aligned. An
   * edge within tolDeg of horizontal has its two endpoints' y averaged; within
   * tolDeg of vertical, their x. Applied iteratively so a chain of staircase
   * steps collapses onto one line. Edges that are genuinely diagonal are left
   * untouched, which is what keeps this safe on irregular parcels.
   */
  function squareUp(ring, options) {
    const o = options || {};
    const tolDeg = o.angleToleranceDeg == null ? 8 : o.angleToleranceDeg;
    const maxShift = o.maxShift == null ? Infinity : o.maxShift;
    const iterations = o.iterations == null ? 3 : o.iterations;
    const minAlignment = o.minAlignedFraction == null ? 0.6 : o.minAlignedFraction;

    const r0 = openRing(ring);
    if (r0.length < 4) return { ring: r0.slice(), applied: false, reason: 'too few vertices to square up' };

    const align = gridAlignment(r0, tolDeg);
    if (align.alignedFraction < minAlignment) {
      return {
        ring: r0.slice(), applied: false, orientation: align.orientation,
        alignedFraction: align.alignedFraction,
        reason: `only ${(align.alignedFraction * 100).toFixed(0)}% of the perimeter lies near a single grid direction, so this parcel does not look rectilinear — left unchanged`,
      };
    }

    const theta = align.orientation * DEG;
    const cos = Math.cos(-theta), sin = Math.sin(-theta);
    const fwd = ([x, y]) => [x * cos - y * sin, x * sin + y * cos];
    const inv = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];

    let pts = r0.map(fwd);
    const original = pts.map((p) => p.slice());

    for (let iter = 0; iter < iterations; iter++) {
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) continue;
        const angDeg = Math.abs(Math.atan2(dy, dx) * RAD);
        const nearHorizontal = Math.min(angDeg, 180 - angDeg) <= tolDeg;
        const nearVertical = Math.abs(angDeg - 90) <= tolDeg;
        if (nearHorizontal && !nearVertical) {
          const y = (a[1] + b[1]) / 2;
          a[1] = y; b[1] = y;
        } else if (nearVertical && !nearHorizontal) {
          const x = (a[0] + b[0]) / 2;
          a[0] = x; b[0] = x;
        }
      }
    }

    // Refuse any vertex that has been dragged further than the caller allows.
    let maxMoved = 0;
    for (let i = 0; i < pts.length; i++) {
      maxMoved = Math.max(maxMoved, Math.hypot(pts[i][0] - original[i][0], pts[i][1] - original[i][1]));
    }
    if (maxMoved > maxShift) {
      return {
        ring: r0.slice(), applied: false, orientation: align.orientation,
        alignedFraction: align.alignedFraction, maxShift: maxMoved,
        reason: `squaring up would move a vertex by ${maxMoved.toFixed(2)} m, beyond the ${maxShift} m limit — left unchanged`,
      };
    }

    const out = pts.map(inv);
    const before = Math.abs(signedArea(r0));
    const after = Math.abs(signedArea(out));
    return {
      ring: out,
      applied: true,
      orientation: align.orientation,
      alignedFraction: align.alignedFraction,
      maxShift: maxMoved,
      areaBefore: before,
      areaAfter: after,
      areaChangePct: before ? ((after - before) / before) * 100 : 0,
    };
  }

  // The full clean-up, in the order that makes sense: square the edges first,
  // then drop the vertices that squaring made redundant.
  function regularise(ring, options) {
    const o = options || {};
    const sq = squareUp(ring, o);
    const co = removeCollinear(sq.ring, o.collinearTolerance == null ? 0.05 : o.collinearTolerance);
    return {
      ring: co.ring,
      squared: sq.applied,
      squareUpReason: sq.reason || null,
      orientation: sq.orientation,
      alignedFraction: sq.alignedFraction,
      verticesRemoved: co.removed,
      verticesBefore: openRing(ring).length,
      verticesAfter: co.ring.length,
      areaChangePct: sq.areaChangePct == null ? 0 : sq.areaChangePct,
      maxShift: sq.maxShift == null ? 0 : sq.maxShift,
    };
  }

  /* =====================================================================
   * TOPOLOGY BETWEEN PARCELS
   *
   * Exact polygon clipping is deliberately not implemented — a correct
   * Greiner-Hormann is a lot of subtle code, and for reviewing a digitising
   * session the questions that matter are answerable without it:
   *
   *   do these two parcels overlap at all?
   *   is this vertex nearly-but-not-quite on that neighbour's edge?
   *
   * Overlap AREA, where reported, is a clearly-labelled grid estimate.
   * =================================================================== */
  function ringsOverlap(a, b) {
    const ra = openRing(a), rb = openRing(b);
    if (!boundsOverlap(boundsOf(ra), boundsOf(rb))) return false;
    for (let i = 0; i < ra.length; i++) {
      const a1 = ra[i], a2 = ra[(i + 1) % ra.length];
      for (let j = 0; j < rb.length; j++) {
        if (segmentsProperlyIntersect(a1, a2, rb[j], rb[(j + 1) % rb.length])) return true;
      }
    }
    // No properly-crossing edges. Test whether either ring has a point strictly
    // inside the other, which covers containment.
    //
    // Vertices alone are NOT enough, and the gap is not academic. Two
    // axis-aligned parcels overlapping in a band — say 0..10 and 8..18, both
    // spanning the same height — have every vertex of each lying exactly ON the
    // other's boundary, and their edges only touch or run collinear, never
    // properly cross. Cadastral parcels are axis-aligned far more often than
    // chance, so this was precisely the overlap most likely to occur and the one
    // being missed. Edge midpoints land in the interior of the overlap band and
    // catch it.
    const probes = (ring) => {
      const out = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        out.push(p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      }
      return out;
    };
    const strictlyInside = (pt, ring) => pointInRing(pt, ring) && !pointOnBoundary(pt, ring, 1e-9);
    for (const p of probes(ra)) if (strictlyInside(p, rb)) return true;
    for (const p of probes(rb)) if (strictlyInside(p, ra)) return true;
    return false;
  }

  /* How much of a traced ring falls OUTSIDE the bounding box the portal declared
   * for the parcel that was selected.
   *
   * WHY THIS MATTERS
   *
   * A colour flood fill can escape through a one-pixel gap in a drawn boundary
   * and swallow the neighbouring parcels. The result still looks like a plausible
   * parcel — a closed ring with a sensible area — so nothing downstream notices,
   * and the operator exports a boundary for the wrong piece of land.
   *
   * Cadastral portals hand us the answer for free: they report the bounding box
   * of the parcel you clicked. A trace that reaches well beyond it has leaked,
   * and that is checkable rather than guessable. `leakProtectionRadius` reduces
   * how often this happens; this detects when it happened anyway.
   *
   * Returns the leaked fraction as a percentage of the ring's own area, plus the
   * areas it was derived from so the figure can be argued with. Area outside is
   * estimated on the same deterministic grid as `estimateOverlapArea`, and
   * `exact: false` says so.
   */
  function bboxLeakage(ring, bbox, gridSteps) {
    const r = openRing(ring);
    if (r.length < 3 || !bbox) return null;
    const { xmin, ymin, xmax, ymax } = bbox;
    if (![xmin, ymin, xmax, ymax].every((v) => typeof v === 'number' && isFinite(v))) return null;
    if (xmax <= xmin || ymax <= ymin) return null;

    const rect = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]];
    const total = Math.abs(signedArea(r));
    if (!(total > 0)) return null;

    const inside = estimateOverlapArea(r, rect, gridSteps || 160);
    const outside = Math.max(0, total - inside.area);
    return {
      leakedPct: (outside / total) * 100,
      ringArea: total,
      insideArea: inside.area,
      outsideArea: outside,
      exact: false,
      cellArea: inside.cellArea,
    };
  }

  // Monte-Carlo-free grid estimate of intersection area. Deterministic, and its
  // resolution is reported so the number is never mistaken for exact.
  function estimateOverlapArea(a, b, gridSteps) {
    const ra = openRing(a), rb = openRing(b);
    const ba = boundsOf(ra), bb = boundsOf(rb);
    const xmin = Math.max(ba.xmin, bb.xmin), xmax = Math.min(ba.xmax, bb.xmax);
    const ymin = Math.max(ba.ymin, bb.ymin), ymax = Math.min(ba.ymax, bb.ymax);
    if (xmax <= xmin || ymax <= ymin) return { area: 0, exact: false, cellArea: 0 };
    const n = gridSteps || 120;
    const dx = (xmax - xmin) / n, dy = (ymax - ymin) / n;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const p = [xmin + (i + 0.5) * dx, ymin + (j + 0.5) * dy];
        if (pointInRing(p, ra) && pointInRing(p, rb)) hits++;
      }
    }
    return { area: hits * dx * dy, exact: false, cellArea: dx * dy, gridSteps: n };
  }

  /* Find the vertices that are nearly on a neighbour's boundary but not
   * snapped to it. These are the actionable defects: each one is a sliver or a
   * gap waiting to be rejected by a GIS import, and each has an obvious fix.
   */
  function findUnsnapped(shapes, tolerance) {
    const tol = tolerance == null ? 0.5 : tolerance;
    const issues = [];
    for (let i = 0; i < shapes.length; i++) {
      const A = shapes[i];
      if (!A.points) continue;
      const ra = openRing(A.points);
      const ba = boundsOf(ra);
      for (let j = 0; j < shapes.length; j++) {
        if (i === j) continue;
        const B = shapes[j];
        if (!B.points) continue;
        const rb = openRing(B.points);
        if (!boundsOverlap(ba, boundsOf(rb), tol)) continue;
        for (let k = 0; k < ra.length; k++) {
          const p = ra[k];
          // Already coincident with one of B's vertices: nothing to fix.
          let exact = false;
          for (const q of rb) {
            if (Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) { exact = true; break; }
          }
          if (exact) continue;
          let bestDist = Infinity, bestEdge = -1;
          for (let m = 0; m < rb.length; m++) {
            const d = distPointToSegment(p, rb[m], rb[(m + 1) % rb.length]).dist;
            if (d < bestDist) { bestDist = d; bestEdge = m; }
          }
          if (bestDist > 1e-9 && bestDist <= tol) {
            issues.push({
              shapeId: A.id, vertexIndex: k,
              neighbourId: B.id, neighbourEdge: bestEdge,
              distance: bestDist,
            });
          }
        }
      }
    }
    return issues;
  }

  function analyseTopology(shapes, options) {
    const o = options || {};
    const tol = o.tolerance == null ? 0.5 : o.tolerance;
    const overlaps = [];
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const A = shapes[i], B = shapes[j];
        if (!A.points || !B.points) continue;
        if (!ringsOverlap(A.points, B.points)) continue;
        const est = o.estimateAreas === false ? null : estimateOverlapArea(A.points, B.points, o.gridSteps);
        overlaps.push({
          aId: A.id, bId: B.id,
          estimatedAreaM2: est ? est.area : null,
          areaIsEstimate: true,
          gridSteps: est ? est.gridSteps : null,
        });
      }
    }
    const unsnapped = findUnsnapped(shapes, tol);
    return {
      shapeCount: shapes.length,
      overlaps,
      unsnapped,
      clean: overlaps.length === 0 && unsnapped.length === 0,
      summary: overlaps.length || unsnapped.length
        ? `${overlaps.length} overlapping pair(s), ${unsnapped.length} vertex/vertices close to a neighbour's edge without being snapped to it.`
        : 'No overlaps, and every shared vertex is exactly coincident.',
    };
  }

  // Apply the fix for every unsnapped vertex found. Conservative by
  // construction: vertices only move onto a neighbour, never away.
  function snapAllToNeighbours(shapes, tolerance) {
    const tol = tolerance == null ? 0.5 : tolerance;
    let moved = 0;
    const out = shapes.map((s) => Object.assign({}, s, { points: openRing(s.points || []) }));
    for (const shape of out) {
      const others = out.filter((s) => s !== shape);
      for (let k = 0; k < shape.points.length; k++) {
        const snap = snapPoint(shape.points[k], others, tol, shape.id);
        if (snap && snap.dist > 1e-9) { shape.points[k] = snap.point; moved++; }
      }
    }
    return { shapes: out, moved };
  }

  /* =====================================================================
   * QUALITY SCORE
   *
   * A single reviewable verdict per parcel, from evidence already available.
   * Deliberately not a black box: every deduction is itemised with what it
   * was based on, so the grade can be argued with rather than believed.
   * =================================================================== */
  function scoreShape(shape, context) {
    const ctx = context || {};
    const findings = [];
    let score = 100;

    const ring = openRing(shape.points || []);
    if (ring.length < 3) {
      return { score: 0, grade: 'unusable', findings: [{ severity: 'error', points: 100, message: 'Fewer than 3 vertices — this is not a polygon.' }] };
    }

    // Geometry validity
    if (shape.validity && !shape.validity.valid) {
      for (const p of shape.validity.problems) {
        const cost = p.code === 'self-intersection' ? 40 : (p.code === 'zero-area' ? 60 : 10);
        score -= cost;
        findings.push({ severity: 'error', points: cost, code: p.code, message: p.message });
      }
    }

    // Area agreement with the record, when there is one.
    if (shape.areaDiffPct != null) {
      const d = Math.abs(shape.areaDiffPct);
      if (d > 25) { score -= 30; findings.push({ severity: 'error', points: 30, code: 'area-mismatch', message: `Digitised area differs from the recorded area by ${d.toFixed(1)}%. That is far beyond survey tolerance — check for a leak into a neighbouring parcel, or a wrong scale factor.` }); }
      else if (d > 10) { score -= 15; findings.push({ severity: 'warn', points: 15, code: 'area-mismatch', message: `Digitised area differs from the recorded area by ${d.toFixed(1)}%.` }); }
      else if (d > 5) { score -= 5; findings.push({ severity: 'info', points: 5, code: 'area-mismatch', message: `Digitised area differs from the recorded area by ${d.toFixed(1)}%, which is plausible but worth a glance.` }); }
      else { findings.push({ severity: 'good', points: 0, code: 'area-agrees', message: `Digitised area is within ${d.toFixed(1)}% of the recorded area.` }); }
    } else {
      findings.push({ severity: 'info', points: 0, code: 'no-record', message: 'No recorded area available to compare against.' });
    }

    // Georeferencing provenance
    if (shape.lastGcpCorrection) {
      const g = shape.lastGcpCorrection;
      if (g.looMeters != null) {
        if (g.looMeters > 2) { score -= 20; findings.push({ severity: 'warn', points: 20, code: 'gcp-weak', message: `The georeferencing correction predicts an unseen corner only to ${g.looMeters.toFixed(2)} m. Add more control points.` }); }
        else findings.push({ severity: 'good', points: 0, code: 'gcp-good', message: `Georeferenced with ${g.gcpCount || '?'} control points, cross-validated to ${g.looMeters.toFixed(2)} m.` });
      } else if (g.gcpCount != null && g.gcpCount <= 3) {
        score -= 10;
        findings.push({ severity: 'warn', points: 10, code: 'gcp-unvalidated', message: `Corrected using only ${g.gcpCount} control points, too few to cross-check. The residual shown for such a fit is zero by construction.` });
      }
    } else {
      score -= 5;
      findings.push({ severity: 'info', points: 5, code: 'no-gcp', message: 'No georeferencing correction applied — the trace is trusted as-is.' });
    }

    // Did the fill escape the parcel that was actually selected?
    //
    // This is the most serious defect a trace can have: not an inaccurate
    // boundary but a boundary for the WRONG LAND. It was previously reported only
    // as a toast at trace time, which disappears; the quality report is the
    // durable record and the thing reviewed before export, so it belongs here.
    // The deduction is the largest in the list for that reason.
    if (shape.leak && shape.leak.leakedPct > 0) {
      const pct = shape.leak.leakedPct;
      if (pct > 25) {
        score -= 40;
        findings.push({ severity: 'error', points: 40, code: 'bbox-leak', message: `About ${pct.toFixed(0)}% of this boundary lies outside the bounding box the portal reported for the selected parcel. The fill has almost certainly escaped through a gap and taken in a neighbour — this may be the wrong parcel entirely. Retrace with more leak protection or a tighter colour tolerance.` });
      } else if (pct > 5) {
        score -= 15;
        findings.push({ severity: 'warn', points: 15, code: 'bbox-leak', message: `About ${pct.toFixed(0)}% of this boundary falls outside the portal's reported bounding box for the parcel. Worth checking the trace did not spill past a boundary line.` });
      }
    }

    // Vertex plausibility. A raster trace that survives with hundreds of
    // vertices has not been cleaned up and will be painful downstream.
    if (ring.length > 200) {
      score -= 10;
      findings.push({ severity: 'warn', points: 10, code: 'too-many-vertices', message: `${ring.length} vertices for one parcel. Run Regularise, or raise the simplification tolerance.` });
    }

    // Rectilinearity: informational, since irregular parcels are legitimate.
    const align = gridAlignment(ring, 8);
    if (align.alignedFraction >= 0.9) {
      findings.push({ severity: 'good', points: 0, code: 'rectilinear', message: `${(align.alignedFraction * 100).toFixed(0)}% of the boundary follows one grid direction — Regularise would clean this up well.` });
    }

    // Topology, if the caller supplied session-level analysis.
    if (ctx.topology) {
      const ov = ctx.topology.overlaps.filter((o) => o.aId === shape.id || o.bId === shape.id);
      if (ov.length) {
        score -= 25;
        findings.push({ severity: 'error', points: 25, code: 'overlap', message: `Overlaps ${ov.length} other parcel(s). Most GIS imports reject this.` });
      }
      const un = ctx.topology.unsnapped.filter((u) => u.shapeId === shape.id);
      if (un.length) {
        score -= 10;
        findings.push({ severity: 'warn', points: 10, code: 'unsnapped', message: `${un.length} vertex/vertices sit within snapping distance of a neighbour's edge without being snapped to it, which leaves slivers.` });
      }
    }

    score = Math.max(0, Math.min(100, score));
    const grade = score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 55 ? 'fair' : score >= 30 ? 'poor' : 'unusable';
    return { score, grade, findings };
  }

  function scoreSession(shapes, options) {
    const o = options || {};
    const topology = o.topology || analyseTopology(shapes, o);
    const perShape = shapes.map((s) => ({ id: s.id, plotNo: s.plotNo, ...scoreShape(s, { topology }) }));
    const avg = perShape.length ? perShape.reduce((a, s) => a + s.score, 0) / perShape.length : 0;
    const worst = perShape.reduce((a, s) => (a && a.score <= s.score ? a : s), null);
    return {
      averageScore: avg,
      grade: avg >= 90 ? 'excellent' : avg >= 75 ? 'good' : avg >= 55 ? 'fair' : avg >= 30 ? 'poor' : 'unusable',
      shapes: perShape,
      worst,
      topology,
      errorCount: perShape.reduce((a, s) => a + s.findings.filter((f) => f.severity === 'error').length, 0),
      warningCount: perShape.reduce((a, s) => a + s.findings.filter((f) => f.severity === 'warn').length, 0),
    };
  }

  return {
    openRing, signedArea, distPointToSegment, pointInRing, pointOnBoundary,
    segmentsProperlyIntersect, boundsOf, boundsOverlap,
    snapPoint, snapRing, snapAllToNeighbours,
    findCoincidentVertices, crossingPairs, newCrossings,
    removeCollinear, dominantOrientation, gridAlignment, squareUp, regularise,
    ringsOverlap, estimateOverlapArea, bboxLeakage, findUnsnapped, analyseTopology,
    scoreShape, scoreSession,
  };
});
