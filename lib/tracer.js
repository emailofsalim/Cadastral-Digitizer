/* =========================================================================
 * Raster tracing pipeline — flood fill, leak suppression, boundary walk,
 * simplification. Pure functions over plain {data, width, height} rasters, so
 * the whole thing is testable without a canvas.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Tracer) or a CommonJS module.
 *
 * This logic shipped untested in v13/v14 despite being the part that actually
 * produces the geometry. Extracting it revealed three real defects, all fixed
 * here and covered by test/tracer.test.js:
 *
 *  1. The flood fill pushed a fresh [x, y] array per neighbour onto a JS array
 *     stack — four allocations per pixel visited. At the largest configured
 *     region (2800x2800 = 7.8 M pixels) that is tens of millions of short-lived
 *     arrays. Replaced with a scanline fill over a preallocated Int32Array,
 *     which is both far faster and bounded in memory.
 *  2. Moore boundary tracing terminated on "returned to the start pixel",
 *     which fires early on shapes that touch their own start from a different
 *     direction, truncating the ring. Now uses Jacob's stopping criterion
 *     (same pixel AND same entry direction).
 *  3. Ramer-Douglas-Peucker was applied to a CLOSED ring as if it were an open
 *     polyline, so the seam between the first and last vertex was never
 *     simplified and could retain a spur. Now split at the two extreme points
 *     and simplified as two half-chains.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Tracer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================
   * COLOUR
   * =================================================================== */
  function colorAt(raster, x, y) {
    const i = (y * raster.width + x) * 4;
    return { r: raster.data[i], g: raster.data[i + 1], b: raster.data[i + 2], a: raster.data[i + 3] };
  }
  function luminance(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  // Perceptually weighted squared distance. Plain RGB Euclidean distance
  // treats a blue shift as equal to a green shift of the same magnitude, which
  // is wrong for the pale washes cadastral maps use for parcel fills — two
  // visibly different parcels can sit closer in RGB than one parcel's own
  // anti-aliased interior. Weighting by luminance sensitivity separates them.
  function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
  }
  // Tolerance is expressed on the same 0-255-per-channel scale as before, so
  // existing slider values keep their meaning.
  function toleranceToSq(tol) { return 9 * tol * tol; }

  /* =====================================================================
   * FLOOD FILL — scanline, over a preallocated stack.
   *
   * Returns { mask: Uint8Array, count, touchedEdge } where mask is 1 inside.
   * `isBlocked(r, g, b, i)` decides what counts as a wall.
   * =================================================================== */
  function floodFill(raster, seedX, seedY, isBlocked) {
    const w = raster.width, h = raster.height;
    if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) {
      return { mask: null, count: 0, touchedEdge: true };
    }
    const mask = new Uint8Array(w * h);
    const data = raster.data;
    let touchedEdge = false;
    let count = 0;

    const blockedAt = (idx) => {
      const i4 = idx * 4;
      return isBlocked(data[i4], data[i4 + 1], data[i4 + 2], idx);
    };
    if (blockedAt(seedY * w + seedX)) return { mask, count: 0, touchedEdge: false };

    // Stack holds (x, yLeftScanStart) pairs implicitly: we push spans.
    // Each entry is a packed y * w + x start position for a new scan.
    const stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = seedY * w + seedX;

    while (sp > 0) {
      const start = stack[--sp];
      const y = (start / w) | 0;
      let x = start - y * w;
      const rowBase = y * w;
      if (mask[rowBase + x] || blockedAt(rowBase + x)) continue;

      // Extend left and right along this scanline.
      let left = x;
      while (left > 0 && !mask[rowBase + left - 1] && !blockedAt(rowBase + left - 1)) left--;
      let right = x;
      while (right < w - 1 && !mask[rowBase + right + 1] && !blockedAt(rowBase + right + 1)) right++;

      for (let i = left; i <= right; i++) { mask[rowBase + i] = 1; count++; }
      if (y === 0 || y === h - 1) touchedEdge = true;
      if (left === 0 || right === w - 1) touchedEdge = true;

      // Seed the rows above and below, once per contiguous run.
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nBase = ny * w;
        let i = left;
        while (i <= right) {
          while (i <= right && (mask[nBase + i] || blockedAt(nBase + i))) i++;
          if (i > right) break;
          stack[sp++] = nBase + i;
          while (i <= right && !mask[nBase + i] && !blockedAt(nBase + i)) i++;
        }
      }
    }
    return { mask, count, touchedEdge };
  }

  /* =====================================================================
   * MORPHOLOGY
   * =================================================================== */
  function erode(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const base = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = base + x;
        if (!mask[i]) continue;
        if (mask[i - w] && mask[i + w] && mask[i - 1] && mask[i + 1]) out[i] = 1;
      }
    }
    return out;
  }
  function dilate(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        const i = base + x;
        if (mask[i] ||
            (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w]) ||
            (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1])) out[i] = 1;
      }
    }
    return out;
  }
  function erodeN(mask, w, h, n) { let m = mask; for (let i = 0; i < n; i++) m = erode(m, w, h); return m; }
  function dilateN(mask, w, h, n) { let m = mask; for (let i = 0; i < n; i++) m = dilate(m, w, h); return m; }

  function connectedComponentAt(mask, w, h, seedX, seedY) {
    const out = new Uint8Array(w * h);
    const idx = (x, y) => y * w + x;
    if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h || !mask[idx(seedX, seedY)]) {
      // Fall back to the nearest set pixel, so an eroded core that no longer
      // covers the seed still yields the intended component.
      let best = -1, bestD = Infinity;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!mask[idx(x, y)]) continue;
        const d = (x - seedX) * (x - seedX) + (y - seedY) * (y - seedY);
        if (d < bestD) { bestD = d; best = idx(x, y); }
      }
      if (best < 0) return out;
      seedY = (best / w) | 0;
      seedX = best - seedY * w;
    }
    const stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = idx(seedX, seedY);
    while (sp > 0) {
      const i = stack[--sp];
      if (out[i] || !mask[i]) continue;
      out[i] = 1;
      const y = (i / w) | 0, x = i - y * w;
      if (x > 0) stack[sp++] = i - 1;
      if (x < w - 1) stack[sp++] = i + 1;
      if (y > 0) stack[sp++] = i - w;
      if (y < h - 1) stack[sp++] = i + w;
    }
    return out;
  }

  function intersect(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] && b[i]) ? 1 : 0;
    return out;
  }

  // Open-then-reselect: erode away thin leaks, keep only the component still
  // containing the seed, dilate back, and intersect with the original so the
  // result never grows beyond what was actually filled.
  function suppressLeaks(mask, w, h, seedX, seedY, radius) {
    if (!radius || radius <= 0) return mask;
    const eroded = erodeN(mask, w, h, radius);
    const core = connectedComponentAt(eroded, w, h, seedX, seedY);
    const grown = dilateN(core, w, h, radius);
    return intersect(grown, mask);
  }

  function countMask(mask) {
    let c = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
    return c;
  }

  /* =====================================================================
   * BOUNDARY WALK — Moore neighbourhood with Jacob's stopping criterion.
   *
   * v13 stopped as soon as it revisited the start pixel. On a shape that
   * touches its own start pixel from a different direction — common where a
   * parcel narrows — that fires on the first pass and truncates the ring.
   * The correct criterion is: same pixel AND same entry direction.
   * =================================================================== */
  const MOORE_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  function traceBoundary(mask, w, h) {
    let start = -1;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
    if (start < 0) return null;
    const sy = (start / w) | 0, sx = start - sy * w;
    const isFg = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

    // TERMINATION: detect a repeated WALKER STATE, not a repeated pixel.
    //
    // v13 stopped on "back at the start pixel", which truncates any shape whose
    // start is reachable from two directions. The textbook repair (Jacob's
    // criterion: same pixel AND same entry direction) is closer, but comparing
    // against the direction of the FIRST RETURN rather than the initial
    // direction sends the walker around the outline a second time — measured
    // here as 80 boundary pixels for a 40-pixel perimeter, which then produced
    // eight "corners" for a rectangle instead of four.
    //
    // The walk is a deterministic function of (pixel, entryDir), so the first
    // repeated (pixel, entryDir) pair is exactly where the cycle closes. That
    // is correct by construction for every shape, with no special cases.
    const boundary = [];
    const seen = new Set();
    let cx = sx, cy = sy;
    let entryDir = 6; // scan order guarantees the pixel above the start is background
    const maxSteps = 8 * (w * h) + 64;

    for (let step = 0; step < maxSteps; step++) {
      const stateKey = (cy * w + cx) * 8 + entryDir;
      if (seen.has(stateKey)) break;
      seen.add(stateKey);
      boundary.push([cx, cy]);

      let moved = false;
      for (let k = 1; k <= 8; k++) {
        const d = (entryDir + k) % 8;
        const nx = cx + MOORE_DIRS[d][0];
        const ny = cy + MOORE_DIRS[d][1];
        if (!isFg(nx, ny)) continue;
        cx = nx; cy = ny;
        entryDir = (d + 4) % 8; // entered the new pixel from the opposite side
        moved = true;
        break;
      }
      if (!moved) break; // isolated pixel
    }

    // The start pixel can legitimately be re-entered on a different heading
    // before the cycle closes, leaving it duplicated at the tail.
    while (boundary.length > 2 &&
           boundary[boundary.length - 1][0] === boundary[0][0] &&
           boundary[boundary.length - 1][1] === boundary[0][1]) {
      boundary.pop();
    }
    return boundary;
  }

  /* =====================================================================
   * SIMPLIFICATION — RDP, ring-aware.
   * =================================================================== */
  function perpendicularDistance(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  // Iterative RDP over an OPEN chain. Iterative rather than recursive because a
  // long traced boundary can be thousands of points and deep recursion on a
  // degenerate chain risks a stack overflow inside a content script.
  function simplifyChain(points, epsilon) {
    const n = points.length;
    if (n < 3) return points.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      if (hi - lo < 2) continue;
      let maxD = -1, idx = -1;
      for (let i = lo + 1; i < hi; i++) {
        const d = perpendicularDistance(points[i], points[lo], points[hi]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > epsilon && idx > 0) {
        keep[idx] = 1;
        stack.push([lo, idx], [idx, hi]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  // Ring-aware RDP. A closed ring has no natural endpoints, so simplifying it
  // as an open chain from boundary[0] to boundary[last] leaves the seam between
  // those two adjacent points unsimplified. Splitting at the two mutually
  // farthest points and simplifying each half removes that artefact.
  function simplifyRing(ring, epsilon) {
    const n = ring.length;
    if (n < 4) return ring.slice();
    // Farthest point from ring[0], then farthest from that: a cheap diameter
    // approximation, good enough to place the split away from detail.
    let a = 0, bestD = -1;
    for (let i = 1; i < n; i++) {
      const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
      if (d > bestD) { bestD = d; a = i; }
    }
    let b = 0; bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = (ring[i][0] - ring[a][0]) ** 2 + (ring[i][1] - ring[a][1]) ** 2;
      if (d > bestD) { bestD = d; b = i; }
    }
    if (a === b) return simplifyChain(ring, epsilon);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const firstHalf = ring.slice(lo, hi + 1);
    const secondHalf = ring.slice(hi).concat(ring.slice(0, lo + 1));
    const s1 = simplifyChain(firstHalf, epsilon);
    const s2 = simplifyChain(secondHalf, epsilon);
    // Drop the shared endpoints to avoid duplicating them.
    return s1.concat(s2.slice(1, -1));
  }

  /* =====================================================================
   * ORCHESTRATION
   *
   * Runs the whole pipeline for one seed against one raster, growing the
   * examined window until the region stops touching its edge. Returns pixel
   * coordinates in the raster's own frame; the caller maps them to the map CRS.
   * =================================================================== */
  function traceRegion(raster, seedX, seedY, options) {
    const o = options || {};
    const submode = o.submode || 'fill';
    const tolerance = Math.max(1, Number(o.colorTolerance || 40));
    const wallThreshold = Math.max(1, Number(o.wallLuminanceThreshold || 100));
    const leakRadius = Math.max(0, Number(o.leakProtectionRadius == null ? 2 : o.leakProtectionRadius));
    const growRadius = Math.max(0, Number(o.edgeGrowthRadius == null ? 2 : o.edgeGrowthRadius));
    const epsilon = Math.max(0.5, Number(o.simplifyPx || 2));
    const minPixels = Number(o.minPixels || 8);

    let isBlocked;
    let target = null;
    if (submode === 'border') {
      isBlocked = (r, g, b) => luminance(r, g, b) < wallThreshold;
    } else {
      target = o.targetColor || colorAt(raster, seedX, seedY);
      const tolSq = toleranceToSq(tolerance);
      isBlocked = (r, g, b) => colorDistanceSq(r, g, b, target.r, target.g, target.b) > tolSq;
    }

    const filled = floodFill(raster, seedX, seedY, isBlocked);
    if (!filled.mask || filled.count < minPixels) {
      return {
        ok: false,
        reason: `Only ${filled.count || 0} matching pixels at that point. ` +
          (submode === 'border'
            ? 'Try a different wall threshold, or click further from a line.'
            : 'Try clicking nearer the middle of the parcel, or raising the colour tolerance.'),
        count: filled.count || 0,
      };
    }

    let mask = suppressLeaks(filled.mask, raster.width, raster.height, seedX, seedY, leakRadius);
    if (growRadius > 0) mask = dilateN(mask, raster.width, raster.height, growRadius);

    const boundary = traceBoundary(mask, raster.width, raster.height);
    if (!boundary || boundary.length < 4) {
      return { ok: false, reason: 'Could not walk a closed boundary around that region.', count: filled.count };
    }
    const simplified = simplifyRing(boundary, epsilon);
    if (simplified.length < 3) {
      return { ok: false, reason: 'The traced boundary simplified away to fewer than 3 points — try a smaller simplification tolerance.', count: filled.count };
    }
    return {
      ok: true,
      points: simplified,
      rawBoundaryLength: boundary.length,
      pixelCount: countMask(mask),
      touchedEdge: filled.touchedEdge,
      targetColor: target,
    };
  }

  /* =====================================================================
   * BATCH VECTORISATION — label every parcel in the view in one pass.
   *
   * Tracing parcels one click at a time is the bottleneck in real use: a
   * cadastral sheet holds dozens of them. This labels every enclosed region in
   * the raster, then traces each, so a whole sheet becomes geometry in one go.
   *
   * Regions are grown by colour similarity to their OWN seed pixel, not to a
   * single global target, which is what makes it segment parcels rather than
   * merging every pale wash into one blob.
   * =================================================================== */

  // Connected-component labelling by scanline flood, writing straight into one
  // preallocated Int32Array. Background/wall pixels get label -1.
  function labelRegions(raster, options) {
    const o = options || {};
    const w = raster.width, h = raster.height;
    const data = raster.data;
    const submode = o.submode || 'fill';
    const tolSq = toleranceToSq(Math.max(1, Number(o.colorTolerance || 40)));
    const wallThreshold = Math.max(1, Number(o.wallLuminanceThreshold || 100));

    const labels = new Int32Array(w * h).fill(0); // 0 = untouched
    const info = [];
    const stack = new Int32Array(w * h);
    let nextLabel = 0;

    const isWall = (idx) => {
      const i4 = idx * 4;
      return luminance(data[i4], data[i4 + 1], data[i4 + 2]) < wallThreshold;
    };
    const matchesSeed = (idx, seed) => {
      const i4 = idx * 4;
      return colorDistanceSq(data[i4], data[i4 + 1], data[i4 + 2], seed.r, seed.g, seed.b) <= tolSq;
    };

    for (let start = 0; start < w * h; start++) {
      if (labels[start] !== 0) continue;
      if (isWall(start)) { labels[start] = -1; continue; }

      const sy = (start / w) | 0, sx = start - sy * w;
      const seed = colorAt(raster, sx, sy);
      // In border mode a region is bounded only by dark lines, so membership is
      // "not a wall"; in fill mode it is "close to the seed colour".
      const belongs = submode === 'border'
        ? (idx) => !isWall(idx)
        : (idx) => !isWall(idx) && matchesSeed(idx, seed);

      const label = ++nextLabel;
      let sp = 0;
      stack[sp++] = start;
      let count = 0, touchesEdge = false;
      let minX = sx, maxX = sx, minY = sy, maxY = sy;

      while (sp > 0) {
        const p0 = stack[--sp];
        const y = (p0 / w) | 0;
        let x = p0 - y * w;
        const rowBase = y * w;
        if (labels[rowBase + x] !== 0 || !belongs(rowBase + x)) continue;

        let left = x;
        while (left > 0 && labels[rowBase + left - 1] === 0 && belongs(rowBase + left - 1)) left--;
        let right = x;
        while (right < w - 1 && labels[rowBase + right + 1] === 0 && belongs(rowBase + right + 1)) right++;

        for (let i = left; i <= right; i++) { labels[rowBase + i] = label; count++; }
        if (left < minX) minX = left;
        if (right > maxX) maxX = right;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (y === 0 || y === h - 1 || left === 0 || right === w - 1) touchesEdge = true;

        for (const ny of [y - 1, y + 1]) {
          if (ny < 0 || ny >= h) continue;
          const nBase = ny * w;
          let i = left;
          while (i <= right) {
            while (i <= right && (labels[nBase + i] !== 0 || !belongs(nBase + i))) i++;
            if (i > right) break;
            stack[sp++] = nBase + i;
            while (i <= right && labels[nBase + i] === 0 && belongs(nBase + i)) i++;
          }
        }
      }
      info.push({ label, count, seedX: sx, seedY: sy, minX, minY, maxX, maxY, touchesEdge, color: seed });
    }
    return { labels, count: nextLabel, info };
  }

  // Trace every labelled region that passes the size and edge filters.
  //
  // `touchesEdge` regions are skipped by default: a parcel clipped by the
  // viewport is not a parcel, and silently exporting a truncated boundary is
  // worse than not exporting it. The map background is also usually one huge
  // edge-touching region, so this removes it for free.
  function findAllRegions(raster, options) {
    const o = options || {};
    const minPixels = Number(o.minPixels || 120);
    const maxFraction = o.maxFraction == null ? 0.45 : o.maxFraction;
    const skipEdge = o.includeEdgeTouching !== true;
    const epsilon = Math.max(0.5, Number(o.simplifyPx || 2));
    const leakRadius = Math.max(0, Number(o.leakProtectionRadius == null ? 1 : o.leakProtectionRadius));
    const limit = Number(o.maxRegions || 400);

    const w = raster.width, h = raster.height;
    const total = w * h;
    const { labels, info } = labelRegions(raster, o);

    const candidates = info
      .filter((r) => r.count >= minPixels)
      .filter((r) => r.count <= total * maxFraction)
      .filter((r) => (skipEdge ? !r.touchesEdge : true))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    const regions = [];
    const skipped = { tooSmall: 0, tooLarge: 0, touchedEdge: 0, untraceable: 0 };
    for (const r of info) {
      if (r.count < minPixels) skipped.tooSmall++;
      else if (r.count > total * maxFraction) skipped.tooLarge++;
      else if (skipEdge && r.touchesEdge) skipped.touchedEdge++;
    }

    // One reusable mask, cleared over each region's bounding box only.
    const mask = new Uint8Array(total);
    for (const r of candidates) {
      for (let y = r.minY; y <= r.maxY; y++) {
        const base = y * w;
        for (let x = r.minX; x <= r.maxX; x++) mask[base + x] = labels[base + x] === r.label ? 1 : 0;
      }
      let m = mask;
      if (leakRadius > 0) m = suppressLeaks(mask, w, h, r.seedX, r.seedY, leakRadius);
      const boundary = traceBoundary(m, w, h);
      if (!boundary || boundary.length < 4) { skipped.untraceable++; continue; }
      const simplified = simplifyRing(boundary, epsilon);
      if (simplified.length < 3) { skipped.untraceable++; continue; }
      regions.push({
        points: simplified,
        pixelCount: r.count,
        seed: [r.seedX, r.seedY],
        color: r.color,
        bbox: { minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: r.maxY },
      });
      // Clear the mask again so the next region starts clean.
      for (let y = r.minY; y <= r.maxY; y++) {
        const base = y * w;
        for (let x = r.minX; x <= r.maxX; x++) mask[base + x] = 0;
      }
    }

    return {
      regions,
      labelled: info.length,
      skipped,
      summary: `${regions.length} parcel(s) traced from ${info.length} labelled region(s) ` +
        `(skipped ${skipped.tooSmall} too small, ${skipped.tooLarge} too large, ` +
        `${skipped.touchedEdge} clipped by the view edge, ${skipped.untraceable} untraceable).`,
    };
  }

  /* =====================================================================
   * LOCAL EDGE REFINEMENT  (17.5)
   *
   * A vertex sits near a boundary; where exactly is that boundary, in the
   * pixels currently on screen?
   *
   * The scan is a straight line through the vertex, along the normal to its
   * own boundary, classified with the SAME colour test the flood fill uses —
   * colorDistanceSq against the picked colour, with the tolerance from the
   * existing slider. There is no second colour detector here, and no second
   * notion of what "the same parcel" means.
   *
   * What makes it safe is what it REFUSES. A refinement is offered only when
   * the scan reads as one clean crossing:
   *
   *   - every sample must be inside the raster; a scan that runs off the edge
   *     of the readable area is abandoned, not extrapolated;
   *   - there must be exactly ONE inside/outside transition. Two or more means
   *     a sliver, a label, a road or a neighbouring parcel is in the way, and
   *     which crossing is "the" boundary is a guess;
   *   - both runs must be at least minRunPx long, so a speck of noise or one
   *     anti-aliased pixel cannot pass as an edge;
   *   - and if the vertex is ALREADY within settlePx of the crossing, the
   *     answer is "nothing to do".
   *
   * That last rule is what makes repeated analysis of the same view a no-op,
   * which is the whole defence against a detect-modify-render-detect loop.
   *
   * Returns { ok, offset, reason, ... }. `offset` is signed pixels along
   * (nx, ny); the caller adds it to the vertex. Nothing here mutates anything.
   * =================================================================== */
  function refineEdgeAlongNormal(raster, x, y, nx, ny, options) {
    const o = options || {};
    const target = o.target;
    if (!target) return { ok: false, reason: 'no reference colour' };
    const searchPx = Math.max(2, Math.round(Number(o.searchPx || 12)));
    const minRunPx = Math.max(1, Math.round(Number(o.minRunPx || 3)));
    const settlePx = Math.max(0, Number(o.settlePx == null ? 1 : o.settlePx));
    const tolSq = toleranceToSq(Math.max(1, Number(o.tolerance || 40)));

    const len = Math.hypot(nx, ny);
    if (!(len > 1e-9)) return { ok: false, reason: 'no boundary direction' };
    const ux = nx / len, uy = ny / len;

    // Classify every sample first, so the decision is made on the whole scan
    // rather than on the first thing that looks like an edge.
    const ts = [];
    const inside = [];
    for (let t = -searchPx; t <= searchPx; t++) {
      const px = Math.round(x + ux * t);
      const py = Math.round(y + uy * t);
      if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) {
        return { ok: false, reason: 'the scan leaves the readable area' };
      }
      const i4 = (py * raster.width + px) * 4;
      const d = colorDistanceSq(raster.data[i4], raster.data[i4 + 1], raster.data[i4 + 2],
        target.r, target.g, target.b);
      ts.push(t);
      inside.push(d <= tolSq ? 1 : 0);
    }

    // Exactly one crossing, or nothing is done.
    const cuts = [];
    for (let i = 1; i < inside.length; i++) if (inside[i] !== inside[i - 1]) cuts.push(i);
    if (!cuts.length) return { ok: false, reason: inside[0] ? 'all inside — no boundary in range' : 'no matching colour in range' };
    if (cuts.length > 1) return { ok: false, reason: `ambiguous — ${cuts.length} colour changes along the scan` };

    const cut = cuts[0];
    const runA = cut;                     // samples before the crossing
    const runB = inside.length - cut;     // samples after it
    if (runA < minRunPx || runB < minRunPx) {
      return { ok: false, reason: `edge too faint — runs of ${runA} and ${runB} px, ${minRunPx} needed` };
    }

    const offset = (ts[cut - 1] + ts[cut]) / 2;
    if (Math.abs(offset) <= settlePx) {
      return { ok: false, settled: true, offset, reason: 'already on the boundary' };
    }
    return {
      ok: true,
      offset,
      insideRun: inside[0] ? runA : runB,
      outsideRun: inside[0] ? runB : runA,
      dx: ux * offset,
      dy: uy * offset,
    };
  }

  /* The unit normal to a ring at vertex i: perpendicular to the chord between
   * its neighbours, which is the local boundary direction. The SIGN does not
   * matter — refineEdgeAlongNormal scans both ways and requires a single
   * crossing, so an inward normal and an outward one give the same answer. */
  function ringVertexNormal(ring, i) {
    const n = ring.length;
    if (n < 3) return null;
    const a = ring[(i - 1 + n) % n];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return null;
    return [-dy / len, dx / len];
  }

  return {
    colorAt, luminance, colorDistanceSq, toleranceToSq,
    refineEdgeAlongNormal, ringVertexNormal,
    floodFill, erode, dilate, erodeN, dilateN,
    connectedComponentAt, intersect, suppressLeaks, countMask,
    traceBoundary, MOORE_DIRS,
    perpendicularDistance, simplifyChain, simplifyRing,
    traceRegion, labelRegions, findAllRegions,
  };
});
