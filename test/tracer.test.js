/* =========================================================================
 * Tests for lib/tracer.js — the part that actually produces the geometry, and
 * which shipped completely untested in v13/v14.
 *
 * Rasters are built synthetically so the correct answer is known exactly: a
 * 40x30 rectangle of known colour has a known pixel count, a known boundary
 * length and, after simplification, exactly four corners.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/tracer.js');

/* ---------------------------------------------------------------------
 * Raster helpers
 * ------------------------------------------------------------------- */
function makeRaster(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  const c = fill || { r: 255, g: 255, b: 255 };
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = c.r; data[i * 4 + 1] = c.g; data[i * 4 + 2] = c.b; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}
function paintRect(raster, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
      const i = (y * raster.width + x) * 4;
      raster.data[i] = c.r; raster.data[i + 1] = c.g; raster.data[i + 2] = c.b; raster.data[i + 3] = 255;
    }
  }
}
function maskToStrings(mask, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += mask[y * w + x] ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

const PARCEL = { r: 240, g: 220, b: 180 };   // pale fill, like a cadastral wash
const OTHER  = { r: 200, g: 230, b: 240 };   // a different pale wash
const WALL   = { r: 20, g: 20, b: 20 };      // boundary line

/* =====================================================================
 * FLOOD FILL
 * =================================================================== */

test('flood fill covers exactly a bounded rectangle and no more', () => {
  const r = makeRaster(60, 50, WALL);
  paintRect(r, 10, 8, 40, 30, PARCEL);
  const tolSq = T.toleranceToSq(30);
  const res = T.floodFill(r, 20, 20, (rr, gg, bb) =>
    T.colorDistanceSq(rr, gg, bb, PARCEL.r, PARCEL.g, PARCEL.b) > tolSq);
  assert.strictEqual(res.count, 40 * 30, `expected 1200 pixels, got ${res.count}`);
  assert.strictEqual(res.touchedEdge, false, 'the parcel does not reach the raster edge');
  // Spot-check the corners are inside and the surround is not.
  assert.strictEqual(res.mask[8 * 60 + 10], 1);
  assert.strictEqual(res.mask[37 * 60 + 49], 1);
  assert.strictEqual(res.mask[7 * 60 + 10], 0);
  assert.strictEqual(res.mask[8 * 60 + 9], 0);
});

test('flood fill reports when it reaches the raster edge', () => {
  // An unbounded fill must be detectable, because that is how the caller knows
  // to widen the window rather than trust a clipped region.
  const r = makeRaster(40, 40, PARCEL);
  const tolSq = T.toleranceToSq(30);
  const res = T.floodFill(r, 20, 20, (rr, gg, bb) =>
    T.colorDistanceSq(rr, gg, bb, PARCEL.r, PARCEL.g, PARCEL.b) > tolSq);
  assert.strictEqual(res.count, 1600);
  assert.strictEqual(res.touchedEdge, true);
});

test('flood fill handles concave and U-shaped regions', () => {
  // A scanline fill that mishandles spans leaves the inside of a U unfilled.
  const r = makeRaster(30, 20, WALL);
  paintRect(r, 2, 2, 6, 16, PARCEL);   // left arm
  paintRect(r, 22, 2, 6, 16, PARCEL);  // right arm
  paintRect(r, 2, 14, 26, 4, PARCEL);  // base joining them
  const tolSq = T.toleranceToSq(30);
  const res = T.floodFill(r, 4, 4, (rr, gg, bb) =>
    T.colorDistanceSq(rr, gg, bb, PARCEL.r, PARCEL.g, PARCEL.b) > tolSq);
  // Reaching the far arm requires travelling down, across and back up.
  assert.strictEqual(res.mask[4 * 30 + 24], 1, 'the far arm must be reached through the base');
  assert.strictEqual(res.mask[4 * 30 + 15], 0, 'the gap between the arms must stay empty');
});

test('flood fill refuses a seed that is already on a wall', () => {
  const r = makeRaster(20, 20, WALL);
  paintRect(r, 5, 5, 5, 5, PARCEL);
  const tolSq = T.toleranceToSq(30);
  const res = T.floodFill(r, 0, 0, (rr, gg, bb) =>
    T.colorDistanceSq(rr, gg, bb, PARCEL.r, PARCEL.g, PARCEL.b) > tolSq);
  assert.strictEqual(res.count, 0, 'seeding on a wall must fill nothing');
});

test('flood fill rejects an out-of-bounds seed', () => {
  const r = makeRaster(10, 10, PARCEL);
  for (const [x, y] of [[-1, 5], [5, -1], [10, 5], [5, 10]]) {
    const res = T.floodFill(r, x, y, () => false);
    assert.strictEqual(res.mask, null, `seed ${x},${y} should be rejected`);
    assert.strictEqual(res.touchedEdge, true);
  }
});

test('flood fill is bounded in memory and time on a large raster', () => {
  // The v13 implementation allocated four [x,y] arrays per visited pixel. At
  // this size that is ~16 M short-lived arrays; the scanline version allocates
  // one Int32Array. Assert it simply completes promptly.
  const w = 1200, h = 1000;
  const r = makeRaster(w, h, PARCEL);
  const t0 = Date.now();
  const res = T.floodFill(r, w >> 1, h >> 1, () => false);
  const ms = Date.now() - t0;
  assert.strictEqual(res.count, w * h);
  assert.ok(ms < 3000, `filling ${w}x${h} took ${ms} ms, which suggests the allocation regression is back`);
});

test('perceptual colour distance separates washes that RGB distance confuses', () => {
  // Two pale cadastral fills that are close in plain RGB but visibly different.
  const plainRgb = (a, b) => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
  const weighted = (a, b) => T.colorDistanceSq(a.r, a.g, a.b, b.r, b.g, b.b);
  // A pure-blue shift and a pure-green shift of equal RGB magnitude...
  const base = { r: 200, g: 200, b: 200 };
  const blueShift = { r: 200, g: 200, b: 220 };
  const greenShift = { r: 200, g: 220, b: 200 };
  assert.strictEqual(plainRgb(base, blueShift), plainRgb(base, greenShift),
    'plain RGB cannot tell these apart');
  // ...must not be treated as equally different, because the eye does not.
  assert.ok(weighted(base, greenShift) > weighted(base, blueShift),
    'a green shift must register as more different than an equal blue shift');
});

/* =====================================================================
 * MORPHOLOGY AND LEAK SUPPRESSION
 * =================================================================== */

test('erode and dilate are inverse-ish and respect the border', () => {
  const w = 9, h = 9;
  const mask = new Uint8Array(w * h);
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) mask[y * w + x] = 1;
  const eroded = T.erode(mask, w, h);
  assert.strictEqual(T.countMask(eroded), 9, 'a 5x5 block erodes to 3x3');
  const back = T.dilate(eroded, w, h);
  assert.strictEqual(T.countMask(back), 21, 'dilating a 3x3 block gives a plus-shaped 21');
});

test('leak suppression removes a thin bridge into a neighbouring parcel', () => {
  // The canonical failure: the trace escapes through a one-pixel gap in the
  // boundary and swallows the parcel next door.
  const w = 40, h = 20;
  const mask = new Uint8Array(w * h);
  const set = (x, y) => { mask[y * w + x] = 1; };
  for (let y = 4; y < 16; y++) for (let x = 2; x < 14; x++) set(x, y);   // real parcel
  for (let y = 4; y < 16; y++) for (let x = 26; x < 38; x++) set(x, y);  // neighbour
  for (let x = 14; x < 26; x++) { set(x, 9); set(x, 10); }               // 2px leak

  const before = T.countMask(mask);
  const after = T.suppressLeaks(mask, w, h, 6, 9, 2);
  const cleaned = T.countMask(after);
  assert.ok(cleaned < before / 1.7,
    `leak suppression should discard the neighbour: ${before} -> ${cleaned}`);
  // The seeded parcel must survive...
  assert.strictEqual(after[9 * w + 6], 1, 'the seeded parcel must remain');
  // ...and the neighbour must be gone.
  assert.strictEqual(after[9 * w + 32], 0, 'the neighbouring parcel must be removed');
});

test('leak suppression never grows beyond the original fill', () => {
  const w = 20, h = 20;
  const mask = new Uint8Array(w * h);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) mask[y * w + x] = 1;
  const out = T.suppressLeaks(mask, w, h, 10, 10, 2);
  for (let i = 0; i < mask.length; i++) {
    if (out[i]) assert.strictEqual(mask[i], 1, 'output must be a subset of the input');
  }
});

test('leak suppression with radius 0 is a no-op', () => {
  const w = 10, h = 10;
  const mask = new Uint8Array(w * h);
  mask[55] = 1;
  assert.strictEqual(T.suppressLeaks(mask, w, h, 5, 5, 0), mask);
});

test('connected component falls back to the nearest set pixel', () => {
  // After erosion the original seed can fall outside the surviving core; the
  // component search must still find the intended blob.
  const w = 20, h = 20;
  const mask = new Uint8Array(w * h);
  for (let y = 10; y < 15; y++) for (let x = 10; x < 15; x++) mask[y * w + x] = 1;
  const comp = T.connectedComponentAt(mask, w, h, 2, 2); // seed far away
  assert.strictEqual(T.countMask(comp), 25, 'should still select the only blob');
});

/* =====================================================================
 * BOUNDARY WALK
 * =================================================================== */

test('boundary walk encloses a rectangle with the right perimeter', () => {
  const w = 20, h = 16;
  const mask = new Uint8Array(w * h);
  for (let y = 3; y <= 12; y++) for (let x = 4; x <= 15; x++) mask[y * w + x] = 1;
  const b = T.traceBoundary(mask, w, h);
  assert.ok(b, 'a boundary must be found');
  // A 12x10 block has 2*(12+10) - 4 = 40 perimeter pixels.
  assert.strictEqual(b.length, 40, `expected 40 boundary pixels, got ${b.length}`);
  // Every boundary pixel must be inside the mask.
  for (const [x, y] of b) assert.strictEqual(mask[y * w + x], 1, `(${x},${y}) must be set`);
  // The extremes must be present.
  assert.ok(b.some(([x, y]) => x === 4 && y === 3), 'top-left corner');
  assert.ok(b.some(([x, y]) => x === 15 && y === 12), 'bottom-right corner');
});

test('boundary walk does not truncate a shape that revisits its start pixel', () => {
  // This is the v13 defect. The shape is a narrow-waisted form whose start
  // pixel is reachable from two directions; stopping on "same pixel" alone
  // ends the walk after only part of the outline.
  const w = 15, h = 15;
  const mask = new Uint8Array(w * h);
  const set = (x, y) => { mask[y * w + x] = 1; };
  // Top lobe
  for (let y = 2; y <= 5; y++) for (let x = 4; x <= 10; x++) set(x, y);
  // One-pixel waist
  set(7, 6);
  // Bottom lobe
  for (let y = 7; y <= 10; y++) for (let x = 4; x <= 10; x++) set(x, y);

  const b = T.traceBoundary(mask, w, h);
  assert.ok(b, 'a boundary must be found');
  // The walk has to get past the waist and around the lower lobe.
  assert.ok(b.some(([, y]) => y >= 10),
    `the walk must reach the bottom lobe; deepest row reached was ${Math.max(...b.map((p) => p[1]))}`);
  assert.ok(b.length > 25,
    `expected a full outline, got only ${b.length} pixels — the early-stop bug is back`);
});

test('boundary walk handles a single pixel and an empty mask', () => {
  const w = 8, h = 8;
  const empty = new Uint8Array(w * h);
  assert.strictEqual(T.traceBoundary(empty, w, h), null);
  const one = new Uint8Array(w * h);
  one[3 * w + 3] = 1;
  const b = T.traceBoundary(one, w, h);
  assert.ok(b && b.length >= 1);
  assert.deepStrictEqual(b[0], [3, 3]);
});

/* =====================================================================
 * SIMPLIFICATION
 * =================================================================== */

test('RDP on an open chain keeps endpoints and drops collinear interior', () => {
  const line = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
  const s = T.simplifyChain(line, 0.5);
  assert.deepStrictEqual(s, [[0, 0], [5, 0]], 'a straight run collapses to its ends');

  const kinked = [[0, 0], [1, 0], [2, 5], [3, 0], [4, 0]];
  const sk = T.simplifyChain(kinked, 0.5);
  assert.ok(sk.some(([x, y]) => x === 2 && y === 5), 'the spike must be preserved');
});

test('RDP is iterative and survives a very long degenerate chain', () => {
  // A recursive implementation can blow the stack here.
  const pts = [];
  for (let i = 0; i < 20000; i++) pts.push([i, (i % 2) * 1e-9]);
  const s = T.simplifyChain(pts, 0.5);
  assert.ok(s.length >= 2 && s.length < 50, `expected heavy simplification, got ${s.length}`);
});

test('ring simplification reduces a traced rectangle to four corners', () => {
  const w = 40, h = 30;
  const mask = new Uint8Array(w * h);
  for (let y = 5; y <= 24; y++) for (let x = 6; x <= 33; x++) mask[y * w + x] = 1;
  const boundary = T.traceBoundary(mask, w, h);
  const simplified = T.simplifyRing(boundary, 1.5);
  assert.ok(simplified.length >= 4 && simplified.length <= 6,
    `a rectangle should simplify to about 4 points, got ${simplified.length}: ${JSON.stringify(simplified)}`);
});

test('ring simplification does not leave a spur at the seam', () => {
  // The v13 bug: treating a closed ring as an open polyline pins both
  // boundary[0] and boundary[last], which are adjacent, so the seam keeps a
  // redundant vertex. Check no three consecutive output points are collinear
  // and closely spaced, which is what that artefact looks like.
  const w = 44, h = 34;
  const mask = new Uint8Array(w * h);
  for (let y = 6; y <= 27; y++) for (let x = 7; x <= 36; x++) mask[y * w + x] = 1;
  const ring = T.simplifyRing(T.traceBoundary(mask, w, h), 1.5);
  const n = ring.length;
  let nearDuplicates = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.01) nearDuplicates++;
  }
  assert.strictEqual(nearDuplicates, 0,
    `found ${nearDuplicates} adjacent near-duplicate vertices in ${JSON.stringify(ring)}`);
});

test('ring simplification is a no-op for tiny rings', () => {
  const tri = [[0, 0], [5, 0], [0, 5]];
  assert.strictEqual(T.simplifyRing(tri, 2).length, 3);
});

/* =====================================================================
 * FULL PIPELINE
 * =================================================================== */

test('traceRegion extracts a clean rectangle from a realistic raster', () => {
  const r = makeRaster(80, 60, OTHER);
  // A walled parcel sitting in a differently-coloured surround.
  paintRect(r, 15, 12, 44, 32, WALL);
  paintRect(r, 16, 13, 42, 30, PARCEL);
  const res = T.traceRegion(r, 30, 25, { submode: 'fill', colorTolerance: 30, leakProtectionRadius: 1, edgeGrowthRadius: 0, simplifyPx: 1.5 });
  assert.strictEqual(res.ok, true, res.reason);
  assert.ok(res.points.length >= 4 && res.points.length <= 8,
    `expected roughly 4 corners, got ${res.points.length}`);
  // The recovered extent must match the painted parcel to within a pixel or two.
  const xs = res.points.map((p) => p[0]), ys = res.points.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= 14 && Math.min(...xs) <= 18, `xmin ${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) >= 55 && Math.max(...xs) <= 59, `xmax ${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) >= 11 && Math.min(...ys) <= 15, `ymin ${Math.min(...ys)}`);
  assert.ok(Math.max(...ys) >= 40 && Math.max(...ys) <= 44, `ymax ${Math.max(...ys)}`);
});

test('traceRegion border mode walls on dark lines regardless of fill colour', () => {
  const r = makeRaster(60, 50, PARCEL);
  // Draw a dark box outline only; the interior stays the same colour as outside.
  for (let x = 10; x <= 45; x++) { paintRect(r, x, 8, 1, 1, WALL); paintRect(r, x, 38, 1, 1, WALL); }
  for (let y = 8; y <= 38; y++) { paintRect(r, 10, y, 1, 1, WALL); paintRect(r, 45, y, 1, 1, WALL); }
  const res = T.traceRegion(r, 28, 23, { submode: 'border', wallLuminanceThreshold: 100, leakProtectionRadius: 0, edgeGrowthRadius: 0, simplifyPx: 1.5 });
  assert.strictEqual(res.ok, true, res.reason);
  const xs = res.points.map((p) => p[0]);
  assert.ok(Math.min(...xs) >= 10 && Math.max(...xs) <= 45,
    `border-mode trace should stay inside the drawn box, got ${Math.min(...xs)}..${Math.max(...xs)}`);
});

test('traceRegion explains itself when the seed yields almost nothing', () => {
  const r = makeRaster(40, 40, WALL);
  paintRect(r, 20, 20, 2, 2, PARCEL);
  const res = T.traceRegion(r, 20, 20, { submode: 'fill', colorTolerance: 5, minPixels: 20 });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /matching pixels/i);
  assert.match(res.reason, /tolerance/i, 'the message should suggest an action');
});

test('traceRegion reports edge contact so the caller can widen the window', () => {
  const r = makeRaster(50, 50, PARCEL);
  const res = T.traceRegion(r, 25, 25, { submode: 'fill', colorTolerance: 30, leakProtectionRadius: 0, edgeGrowthRadius: 0 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.touchedEdge, true,
    'an unbounded region must be flagged, or the caller will trust a clipped parcel');
});

test('traceRegion respects an externally supplied target colour', () => {
  const r = makeRaster(60, 40, OTHER);
  paintRect(r, 10, 8, 30, 20, PARCEL);
  // Seed inside the OTHER area but ask for PARCEL: nothing should match there.
  const res = T.traceRegion(r, 50, 35, {
    submode: 'fill', colorTolerance: 20, targetColor: PARCEL, minPixels: 8,
  });
  assert.strictEqual(res.ok, false, 'the seed does not match the requested colour');
});

test('mask rendering helper agrees with the fill, as a readable sanity check', () => {
  const r = makeRaster(12, 8, WALL);
  paintRect(r, 3, 2, 5, 4, PARCEL);
  const tolSq = T.toleranceToSq(30);
  const res = T.floodFill(r, 5, 3, (rr, gg, bb) =>
    T.colorDistanceSq(rr, gg, bb, PARCEL.r, PARCEL.g, PARCEL.b) > tolSq);
  assert.deepStrictEqual(maskToStrings(res.mask, 12, 8), [
    '............',
    '............',
    '...#####....',
    '...#####....',
    '...#####....',
    '...#####....',
    '............',
    '............',
  ]);
});


/* =====================================================================
 * BATCH VECTORISATION
 *
 * A synthetic "cadastral sheet": several parcels of differing pale washes,
 * separated by dark boundary lines, on a background. The correct answer is
 * known exactly — parcel count, each one's pixel area, and the fact that the
 * background must NOT come back as a parcel.
 * =================================================================== */

function makeSheet() {
  const w = 200, h = 140;
  const r = makeRaster(w, h, { r: 250, g: 250, b: 250 }); // page background
  // Four parcels with distinct washes, each ringed by a dark line.
  const parcels = [
    { x: 10, y: 10, w: 60, h: 40, c: { r: 240, g: 220, b: 180 } },
    { x: 90, y: 10, w: 50, h: 40, c: { r: 200, g: 230, b: 240 } },
    { x: 10, y: 70, w: 60, h: 50, c: { r: 215, g: 240, b: 205 } },
    { x: 90, y: 70, w: 50, h: 50, c: { r: 245, g: 205, b: 215 } },
  ];
  for (const p of parcels) {
    paintRect(r, p.x - 1, p.y - 1, p.w + 2, p.h + 2, WALL);
    paintRect(r, p.x, p.y, p.w, p.h, p.c);
  }
  return { raster: r, parcels };
}

test('batch labelling finds every parcel plus the background', () => {
  const { raster, parcels } = makeSheet();
  const res = T.labelRegions(raster, { submode: 'fill', colorTolerance: 30 });
  // Each parcel is one region; the page background is another.
  assert.ok(res.count >= parcels.length + 1,
    `expected at least ${parcels.length + 1} regions, got ${res.count}`);
  // Every parcel's exact pixel area must appear among the labelled regions.
  for (const p of parcels) {
    const expected = p.w * p.h;
    assert.ok(res.info.some((r) => r.count === expected),
      `no region with the expected area ${expected} for parcel at ${p.x},${p.y}`);
  }
});

test('batch vectorisation returns exactly the parcels, not the background', () => {
  const { raster, parcels } = makeSheet();
  const res = T.findAllRegions(raster, {
    submode: 'fill', colorTolerance: 30, minPixels: 200,
    leakProtectionRadius: 0, simplifyPx: 1.5,
  });
  assert.strictEqual(res.regions.length, parcels.length,
    `expected ${parcels.length} parcels, got ${res.regions.length}: ${res.summary}`);

  // Assert the OUTCOME rather than which filter caught it. The page background
  // is both oversized and edge-touching, and the accounting reports whichever
  // reason matched first, so checking the label would be testing bookkeeping
  // instead of behaviour.
  const totalSkipped = res.skipped.tooSmall + res.skipped.tooLarge +
    res.skipped.touchedEdge + res.skipped.untraceable;
  assert.ok(totalSkipped >= 1, 'the background must have been rejected somehow');
  for (const r of res.regions) {
    const spansSheet = r.bbox.minX <= 1 && r.bbox.minY <= 1 &&
      r.bbox.maxX >= raster.width - 2 && r.bbox.maxY >= raster.height - 2;
    assert.ok(!spansSheet, 'no returned region may span the whole sheet');
    assert.ok(r.points.length >= 4 && r.points.length <= 8,
      `a rectangular parcel should give ~4 corners, got ${r.points.length}`);
  }
});

test('a parcel clipped by the view edge is skipped, and says so', () => {
  // Isolates the edge filter from the size filter: this parcel is well within
  // the size limits but runs off the left edge, so its boundary is not the real
  // one and exporting it would be exporting a lie.
  const w = 200, h = 140;
  const r = makeRaster(w, h, WALL);              // dark surround, not a region
  paintRect(r, 0, 20, 40, 40, PARCEL);           // clipped at x = 0
  paintRect(r, 99, 19, 42, 42, WALL);
  paintRect(r, 100, 20, 40, 40, PARCEL);         // fully enclosed

  const res = T.findAllRegions(r, {
    submode: 'fill', colorTolerance: 30, minPixels: 200,
    leakProtectionRadius: 0, simplifyPx: 1.5,
  });
  assert.strictEqual(res.regions.length, 1,
    `only the enclosed parcel should be returned, got ${res.regions.length}`);
  assert.strictEqual(res.skipped.touchedEdge, 1,
    `the clipped parcel should be counted as edge-touching: ${res.summary}`);
  assert.ok(res.regions[0].bbox.minX >= 99, 'the surviving parcel is the enclosed one');
});

test('batch vectorisation recovers each parcel area to within a pixel of edge', () => {
  const { raster, parcels } = makeSheet();
  const res = T.findAllRegions(raster, {
    submode: 'fill', colorTolerance: 30, minPixels: 200,
    leakProtectionRadius: 0, simplifyPx: 1.5,
  });
  const shoelace = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
  };
  const expectedAreas = parcels.map((p) => p.w * p.h).sort((a, b) => a - b);
  const gotAreas = res.regions.map((r) => shoelace(r.points)).sort((a, b) => a - b);
  for (let i = 0; i < expectedAreas.length; i++) {
    const rel = Math.abs(gotAreas[i] - expectedAreas[i]) / expectedAreas[i];
    assert.ok(rel < 0.06,
      `parcel area ${gotAreas[i].toFixed(0)} px² vs expected ${expectedAreas[i]} px² (${(rel * 100).toFixed(1)}% off)`);
  }
});

test('batch vectorisation keeps differently-washed parcels separate', () => {
  // The whole point of growing each region against its own seed colour: a
  // single global tolerance would merge neighbouring washes into one blob.
  const { raster } = makeSheet();
  const res = T.findAllRegions(raster, {
    submode: 'fill', colorTolerance: 25, minPixels: 200,
    leakProtectionRadius: 0, simplifyPx: 1.5,
  });
  assert.strictEqual(res.regions.length, 4);
  // No traced parcel may span more than half the sheet width.
  for (const r of res.regions) {
    const xs = r.points.map((p) => p[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 120,
      'a single parcel must not have swallowed its neighbour');
  }
});

test('batch vectorisation respects the size filters', () => {
  const { raster } = makeSheet();
  // Demanding a huge minimum must yield nothing rather than throwing.
  const none = T.findAllRegions(raster, { submode: 'fill', colorTolerance: 30, minPixels: 1e9 });
  assert.strictEqual(none.regions.length, 0);
  assert.ok(none.skipped.tooSmall > 0);
  assert.match(none.summary, /0 parcel\(s\) traced/);

  // A cap on region count must be honoured.
  const capped = T.findAllRegions(raster, {
    submode: 'fill', colorTolerance: 30, minPixels: 200, maxRegions: 2, leakProtectionRadius: 0,
  });
  assert.strictEqual(capped.regions.length, 2);
});

test('batch vectorisation can be asked to include edge-clipped regions', () => {
  const { raster } = makeSheet();
  const withEdge = T.findAllRegions(raster, {
    submode: 'fill', colorTolerance: 30, minPixels: 200,
    includeEdgeTouching: true, maxFraction: 0.95, leakProtectionRadius: 0,
  });
  assert.ok(withEdge.regions.length > 4,
    'opting in should also return the background region');
});

test('batch vectorisation reports what it skipped and why', () => {
  const { raster } = makeSheet();
  const res = T.findAllRegions(raster, { submode: 'fill', colorTolerance: 30, minPixels: 200 });
  assert.ok(typeof res.labelled === 'number' && res.labelled > 0);
  for (const k of ['tooSmall', 'tooLarge', 'touchedEdge', 'untraceable']) {
    assert.ok(typeof res.skipped[k] === 'number', `skipped.${k} must be reported`);
  }
  assert.match(res.summary, /labelled region/);
});

test('batch vectorisation completes promptly on a viewport-sized sheet', () => {
  // Labelling allocates one Int32Array and one reusable mask regardless of how
  // many parcels there are; this guards against that regressing.
  const w = 900, h = 700;
  const r = makeRaster(w, h, { r: 250, g: 250, b: 250 });
  let n = 0;
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      const x = 10 + gx * 98, y = 10 + gy * 98;
      paintRect(r, x - 1, y - 1, 82, 82, WALL);
      paintRect(r, x, y, 80, 80, { r: 200 + (gx * 5) % 50, g: 210, b: 180 });
      n++;
    }
  }
  const t0 = Date.now();
  const res = T.findAllRegions(r, {
    submode: 'fill', colorTolerance: 30, minPixels: 400, leakProtectionRadius: 0, simplifyPx: 1.5,
  });
  const ms = Date.now() - t0;
  assert.strictEqual(res.regions.length, n, `expected ${n} parcels, got ${res.regions.length}`);
  assert.ok(ms < 8000, `batch vectorising ${n} parcels on ${w}x${h} took ${ms} ms`);
});

test('border mode batch vectorisation splits on dark lines alone', () => {
  // Same wash everywhere, separated only by drawn boundaries — the case where
  // colour segmentation cannot help and only the walls define parcels.
  const w = 160, h = 100;
  const r = makeRaster(w, h, PARCEL);
  for (let y = 0; y < h; y++) { paintRect(r, 80, y, 2, 1, WALL); }
  for (let x = 0; x < w; x++) { paintRect(r, x, 50, 1, 2, WALL); }
  const res = T.findAllRegions(r, {
    submode: 'border', wallLuminanceThreshold: 100, minPixels: 500,
    includeEdgeTouching: true, maxFraction: 0.4, leakProtectionRadius: 0, simplifyPx: 1.5,
  });
  assert.strictEqual(res.regions.length, 4,
    `the cross should divide the sheet into 4 quadrants, got ${res.regions.length}`);
});

/* =====================================================================
 * LOCAL EDGE REFINEMENT  (17.5)
 * ---------------------------------------------------------------------
 * The value of this function is in what it REFUSES. A cadastral view is full
 * of things that look like a boundary and are not — labels, roads, the
 * neighbouring parcel's own edge, an anti-aliased fringe — so most of these
 * tests assert that no refinement is offered at all.
 * =================================================================== */

// A vertical boundary at x = edgeX: parcel colour to its left, other to its right.
function halfPlane(w, h, edgeX, left, right) {
  const r = makeRaster(w, h, right);
  paintRect(r, 0, 0, edgeX, h, left);
  return r;
}

const REF = { target: PARCEL, tolerance: 30, searchPx: 12, minRunPx: 3, settlePx: 1.5 };

test('a vertex short of the boundary is offered exactly the offset to it', () => {
  const r = halfPlane(60, 40, 30, PARCEL, OTHER);
  // The vertex sits at x=24, six pixels inside the parcel. The boundary is the
  // gap between x=29 (parcel) and x=30 (other), so its midpoint is x=29.5.
  const res = T.refineEdgeAlongNormal(r, 24, 20, 1, 0, REF);
  assert.strictEqual(res.ok, true, `should refine: ${res.reason}`);
  assert.ok(Math.abs(res.offset - 5.5) < 1e-9, `expected +5.5, got ${res.offset}`);
  assert.ok(Math.abs((24 + res.dx) - 29.5) < 1e-9, `should land on 29.5, got ${24 + res.dx}`);
});

test('the sign of the normal does not change the answer', () => {
  // The scan runs both ways and requires one crossing, so an inward normal and
  // an outward one describe the same boundary. That is why the caller does not
  // have to know the ring's winding.
  const r = halfPlane(60, 40, 30, PARCEL, OTHER);
  const fwd = T.refineEdgeAlongNormal(r, 24, 20, 1, 0, REF);
  const rev = T.refineEdgeAlongNormal(r, 24, 20, -1, 0, REF);
  assert.strictEqual(fwd.ok, true);
  assert.strictEqual(rev.ok, true);
  assert.ok(Math.abs((24 + fwd.dx) - (24 + rev.dx)) < 1e-9,
    `both normals must land on the same pixel: ${24 + fwd.dx} vs ${24 + rev.dx}`);
});

test('a vertex already on the boundary is left alone', () => {
  // THE ANTI-OSCILLATION RULE. Without it, the same view analysed twice would
  // move the vertex back and forth by half a pixel forever.
  const r = halfPlane(60, 40, 30, PARCEL, OTHER);
  const res = T.refineEdgeAlongNormal(r, 30, 20, 1, 0, REF);
  assert.strictEqual(res.ok, false, 'a settled vertex must not be moved');
  assert.strictEqual(res.settled, true);
  assert.match(res.reason, /already on the boundary/);
});

test('refining twice is idempotent — the second pass finds nothing to do', () => {
  // The property the loop guard actually depends on, asserted end to end.
  const r = halfPlane(60, 40, 30, PARCEL, OTHER);
  const first = T.refineEdgeAlongNormal(r, 24, 20, 1, 0, REF);
  assert.strictEqual(first.ok, true);
  const landed = 24 + first.dx;
  const second = T.refineEdgeAlongNormal(r, landed, 20, 1, 0, REF);
  assert.strictEqual(second.ok, false, 'the second pass must offer no further change');
  assert.strictEqual(second.settled, true);
});

test('two colour changes along the scan are ambiguous, so nothing is offered', () => {
  // A sliver of another parcel, or a road: which of the two edges is "the"
  // boundary is a guess, and this function does not guess.
  const r = makeRaster(60, 40, OTHER);
  paintRect(r, 0, 0, 22, 40, PARCEL);
  paintRect(r, 34, 0, 26, 40, PARCEL);   // parcel colour again on the far side
  const res = T.refineEdgeAlongNormal(r, 28, 20, 1, 0, REF);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /ambiguous/);
});

test('a one-pixel speck is not an edge', () => {
  // minRunPx is what separates a boundary from noise and anti-aliasing.
  const r = makeRaster(60, 40, PARCEL);
  paintRect(r, 33, 0, 1, 40, OTHER);     // a single stray column near the end
  const res = T.refineEdgeAlongNormal(r, 24, 20, 1, 0, { ...REF, searchPx: 10 });
  assert.strictEqual(res.ok, false, 'a 1px run must not pass as a boundary');
});

test('no matching colour anywhere in range means no refinement', () => {
  const r = makeRaster(60, 40, OTHER);
  const res = T.refineEdgeAlongNormal(r, 30, 20, 1, 0, REF);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /no matching colour/);
});

test('a scan that runs off the readable area is abandoned, not extrapolated', () => {
  // Half the evidence is off screen; guessing from the visible half is exactly
  // the kind of confident wrong answer this feature must never give.
  const r = halfPlane(60, 40, 30, PARCEL, OTHER);
  const res = T.refineEdgeAlongNormal(r, 3, 20, 1, 0, REF);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /leaves the readable area/);
});

test('a correction can never exceed the search radius', () => {
  // The search radius is the safety limit as well as the scan length: a vertex
  // cannot be thrown across the parcel by one pass, whatever the pixels say.
  for (const searchPx of [4, 8, 12, 25]) {
    const r = halfPlane(200, 40, 100, PARCEL, OTHER);
    for (let vx = 60; vx < 140; vx++) {
      const res = T.refineEdgeAlongNormal(r, vx, 20, 1, 0, { ...REF, searchPx });
      if (res.ok) {
        assert.ok(Math.abs(res.offset) <= searchPx,
          `offset ${res.offset} exceeded the ${searchPx}px search radius`);
      }
    }
  }
});

test('no reference colour means no refinement', () => {
  // The picked colour IS the evidence. Without it there is nothing to compare.
  const r = halfPlane(60, 40, 30, PARCEL, OTHER);
  const res = T.refineEdgeAlongNormal(r, 24, 20, 1, 0, { ...REF, target: null });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /no reference colour/);
});

test('the vertex normal is perpendicular to the local boundary', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  // At vertex 1 the neighbours are (0,0) and (10,10); the chord runs diagonally,
  // so the normal is the other diagonal.
  const n = T.ringVertexNormal(square, 1);
  assert.ok(Math.abs(Math.hypot(n[0], n[1]) - 1) < 1e-9, 'must be a unit vector');
  const chord = [10 - 0, 10 - 0];
  assert.ok(Math.abs(n[0] * chord[0] + n[1] * chord[1]) < 1e-9, 'must be perpendicular');
});

test('a degenerate ring yields no normal rather than a NaN direction', () => {
  assert.strictEqual(T.ringVertexNormal([[0, 0], [1, 1]], 0), null, 'fewer than 3 vertices');
  // Neighbours coincident: there is no local direction to be perpendicular to.
  assert.strictEqual(T.ringVertexNormal([[5, 5], [1, 1], [5, 5]], 1), null);
});
