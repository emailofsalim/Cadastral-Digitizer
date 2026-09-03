/* =========================================================================
 * Tests for lib/topology.js
 *
 * Fixtures are built so the correct answer is known analytically: a rectangle
 * of known size is deliberately corrupted with raster-style staircase wobble
 * and a small rotation, and regularisation has to recover the rectangle —
 * right angles, four corners, the original orientation and the original area.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/topology.js');

const DEG = Math.PI / 180;

/* ---------------------------------------------------------------------
 * Fixture builders
 * ------------------------------------------------------------------- */
function rect(x0, y0, w, h) {
  return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
}

// Walk a rectangle's perimeter in `step` increments, jittering each point
// perpendicular to the edge by +/- `wobble` — the signature of a flood-fill
// boundary quantised to pixels.
function staircaseRect(x0, y0, w, h, step, wobble) {
  const pts = [];
  const push = (x, y) => pts.push([x, y]);
  let flip = 0;
  const j = () => (wobble ? ((flip++ % 2) ? wobble : 0) : 0);
  for (let x = x0; x < x0 + w; x += step) push(x, y0 + j());
  for (let y = y0; y < y0 + h; y += step) push(x0 + w + j(), y);
  for (let x = x0 + w; x > x0; x -= step) push(x, y0 + h - j());
  for (let y = y0 + h; y > y0; y -= step) push(x0 - j() + 0, y);
  return pts;
}

function rotateRing(ring, deg, about) {
  const c = about || [0, 0];
  const a = deg * DEG, cos = Math.cos(a), sin = Math.sin(a);
  return ring.map(([x, y]) => {
    const dx = x - c[0], dy = y - c[1];
    return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
  });
}

function interiorAngles(ring) {
  const r = T.openRing(ring);
  const out = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[(i - 1 + r.length) % r.length], c = r[i], n = r[(i + 1) % r.length];
    const a1 = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
    let d = Math.abs((a1 - a2) * 180 / Math.PI) % 360;
    if (d > 180) d = 360 - d;
    out.push(d);
  }
  return out;
}

/* =====================================================================
 * PRIMITIVES
 * =================================================================== */

test('point-in-ring handles inside, outside and a concave notch', () => {
  const sq = rect(0, 0, 10, 10);
  assert.strictEqual(T.pointInRing([5, 5], sq), true);
  assert.strictEqual(T.pointInRing([15, 5], sq), false);
  assert.strictEqual(T.pointInRing([-1, -1], sq), false);

  // An L shape: the notch must read as outside.
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.strictEqual(T.pointInRing([2, 2], L), true);
  assert.strictEqual(T.pointInRing([8, 8], L), false, 'the notch is outside the L');
  assert.strictEqual(T.pointInRing([8, 2], L), true);
});

test('distance to segment clamps to the endpoints', () => {
  const a = [0, 0], b = [10, 0];
  assert.ok(Math.abs(T.distPointToSegment([5, 3], a, b).dist - 3) < 1e-12);
  assert.ok(Math.abs(T.distPointToSegment([-4, 0], a, b).dist - 4) < 1e-12, 'clamps before the start');
  assert.ok(Math.abs(T.distPointToSegment([14, 0], a, b).dist - 4) < 1e-12, 'clamps past the end');
  // Degenerate segment must not divide by zero.
  assert.ok(Math.abs(T.distPointToSegment([3, 4], [0, 0], [0, 0]).dist - 5) < 1e-12);
});

/* =====================================================================
 * ORIENTATION — the 0/90 wrap is the trap here.
 * =================================================================== */

test('dominant orientation recovers a known rotation', () => {
  for (const deg of [0, 3, 12, 37, 44, 61, 88]) {
    const ring = rotateRing(rect(0, 0, 40, 25), deg, [20, 12.5]);
    const found = T.dominantOrientation(ring);
    const expected = ((deg % 90) + 90) % 90;
    // Compare modulo 90 with wrap, since 0 and 90 are the same grid.
    let diff = Math.abs(found - expected);
    diff = Math.min(diff, 90 - diff);
    assert.ok(diff < 0.5, `rotation ${deg}°: expected ~${expected}, got ${found.toFixed(3)}`);
  }
});

test('orientation averaging survives the 0/90 boundary', () => {
  // A rectangle rotated by half a degree has edges at 0.5° and 90.5°, which
  // fold to 0.5 and 0.5. Naive angle averaging across the wrap would land near
  // 45° — completely wrong — so this pins the circular-mean implementation.
  const ring = rotateRing(rect(0, 0, 30, 20), 0.5, [15, 10]);
  const found = T.dominantOrientation(ring);
  let diff = Math.min(Math.abs(found - 0.5), Math.abs(found - 89.5));
  assert.ok(diff < 0.3, `expected ~0.5 or ~89.5, got ${found.toFixed(3)}`);

  const ring2 = rotateRing(rect(0, 0, 30, 20), 89.5, [15, 10]);
  const found2 = T.dominantOrientation(ring2);
  let diff2 = Math.min(Math.abs(found2 - 89.5), Math.abs(found2 - 0.5));
  assert.ok(diff2 < 0.3, `expected ~89.5 or ~0.5, got ${found2.toFixed(3)}`);
});

test('long edges outvote short jagged ones', () => {
  // Two long horizontal edges plus many tiny diagonal steps: the dominant
  // direction must follow the long edges, not the numerous short ones.
  const ring = [[0, 0], [100, 0], [100, 1], [99, 2], [98, 1], [97, 2], [0, 2]];
  const found = T.dominantOrientation(ring);
  let diff = Math.min(found, 90 - found);
  assert.ok(diff < 5, `expected near-axis alignment, got ${found.toFixed(2)}`);
});

test('grid alignment reports how rectilinear a parcel actually is', () => {
  const clean = T.gridAlignment(rect(0, 0, 40, 25), 8);
  assert.ok(clean.alignedFraction > 0.99, `a rectangle is fully aligned, got ${clean.alignedFraction}`);

  // A near-circle should score low, which is what stops squaring up ruining it.
  const circle = [];
  for (let i = 0; i < 32; i++) {
    const a = (2 * Math.PI * i) / 32;
    circle.push([20 * Math.cos(a), 20 * Math.sin(a)]);
  }
  const round = T.gridAlignment(circle, 8);
  assert.ok(round.alignedFraction < 0.5, `a circle should score low, got ${round.alignedFraction}`);
});

/* =====================================================================
 * REGULARISATION
 * =================================================================== */

test('collinear vertices are removed by perpendicular offset, not angle', () => {
  const withMidpoints = [[0, 0], [5, 0], [10, 0], [10, 10], [5, 10], [0, 10]];
  const r = T.removeCollinear(withMidpoints, 0.01);
  assert.strictEqual(r.ring.length, 4, `expected 4 corners, got ${r.ring.length}`);
  assert.strictEqual(r.removed, 2);

  // A genuine corner must survive even though the edges are short.
  const realCorner = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.strictEqual(T.removeCollinear(realCorner, 0.01).ring.length, 4);
});

test('collinear removal never drops below a triangle', () => {
  const nearlyDegenerate = [[0, 0], [5, 0.0001], [10, 0], [5, 0.0002]];
  const r = T.removeCollinear(nearlyDegenerate, 1);
  assert.ok(r.ring.length >= 3, `must keep at least 3 points, got ${r.ring.length}`);
});

test('squaring up snaps near-axis edges onto the dominant grid', () => {
  const wobbly = staircaseRect(0, 0, 40, 25, 4, 0.3);
  const before = T.gridAlignment(wobbly, 1).alignedFraction;
  const sq = T.squareUp(wobbly, { angleToleranceDeg: 20 });
  assert.strictEqual(sq.applied, true, sq.reason);
  const after = T.gridAlignment(sq.ring, 1).alignedFraction;
  assert.ok(after > before, `alignment should improve: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
  assert.ok(after > 0.95, `edges should end up essentially axis-true, got ${after.toFixed(3)}`);
});

test('regularise recovers a clean rectangle from a raster staircase', () => {
  const wobbly = staircaseRect(0, 0, 40, 25, 2, 0.4);
  assert.ok(wobbly.length > 30, 'the fixture should be densely sampled');
  const r = T.regularise(wobbly, { angleToleranceDeg: 20, collinearTolerance: 0.6 });
  assert.strictEqual(r.squared, true, r.squareUpReason);
  assert.strictEqual(r.ring.length, 4, `expected 4 corners, got ${r.ring.length}: ${JSON.stringify(r.ring)}`);
  for (const ang of interiorAngles(r.ring)) {
    assert.ok(Math.abs(ang - 90) < 1.5, `corner should be square, got ${ang.toFixed(2)}°`);
  }
  // Area must be preserved to within the wobble amplitude.
  const area = Math.abs(T.signedArea(r.ring));
  assert.ok(Math.abs(area - 1000) / 1000 < 0.05, `area ${area.toFixed(1)} should be near 1000`);
});

test('regularise preserves a genuine rotation instead of forcing axis alignment', () => {
  const rotated = rotateRing(staircaseRect(0, 0, 40, 25, 2, 0.4), 12, [20, 12.5]);
  const r = T.regularise(rotated, { angleToleranceDeg: 20, collinearTolerance: 0.6 });
  assert.strictEqual(r.squared, true, r.squareUpReason);
  assert.strictEqual(r.ring.length, 4, `expected 4 corners, got ${r.ring.length}`);
  for (const ang of interiorAngles(r.ring)) {
    assert.ok(Math.abs(ang - 90) < 2, `corner should be square, got ${ang.toFixed(2)}°`);
  }
  // The recovered orientation must still be 12°, not snapped to 0°.
  let diff = Math.abs(r.orientation - 12);
  diff = Math.min(diff, 90 - diff);
  assert.ok(diff < 1.5, `orientation should stay ~12°, got ${r.orientation.toFixed(2)}`);
});

test('squaring up refuses on parcels that are not rectilinear', () => {
  // A rounded plot must be left alone: forcing it onto a grid would invent
  // corners that never existed.
  const circle = [];
  for (let i = 0; i < 24; i++) {
    const a = (2 * Math.PI * i) / 24;
    circle.push([20 * Math.cos(a), 20 * Math.sin(a)]);
  }
  const sq = T.squareUp(circle, { angleToleranceDeg: 8 });
  assert.strictEqual(sq.applied, false);
  assert.match(sq.reason, /does not look rectilinear/i);
  assert.deepStrictEqual(sq.ring, T.openRing(circle), 'geometry must be untouched');
});

test('squaring up refuses when it would move a vertex too far', () => {
  const wobbly = staircaseRect(0, 0, 40, 25, 4, 3.0); // 3 m of wobble
  const sq = T.squareUp(wobbly, { angleToleranceDeg: 25, maxShift: 0.5 });
  assert.strictEqual(sq.applied, false);
  assert.match(sq.reason, /beyond the 0\.5 m limit/);
  assert.deepStrictEqual(sq.ring, T.openRing(wobbly));
});

test('regularise reports what it did, for review', () => {
  const wobbly = staircaseRect(0, 0, 40, 25, 2, 0.4);
  const r = T.regularise(wobbly, { angleToleranceDeg: 20, collinearTolerance: 0.6 });
  assert.ok(r.verticesBefore > r.verticesAfter);
  assert.ok(r.verticesRemoved > 0);
  assert.ok(typeof r.orientation === 'number');
  assert.ok(typeof r.areaChangePct === 'number');
  assert.ok(Math.abs(r.areaChangePct) < 5, `area change ${r.areaChangePct}% should be small`);
  assert.ok(r.maxShift >= 0);
});

test('regularise is a no-op on an already-clean rectangle', () => {
  const clean = rect(0, 0, 40, 25);
  const r = T.regularise(clean, { angleToleranceDeg: 8, collinearTolerance: 0.05 });
  assert.strictEqual(r.ring.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(r.ring[i][0] - clean[i][0]) < 1e-9, 'x unchanged');
    assert.ok(Math.abs(r.ring[i][1] - clean[i][1]) < 1e-9, 'y unchanged');
  }
});

/* =====================================================================
 * SNAPPING
 * =================================================================== */

test('snapping prefers an existing vertex over a nearer edge point', () => {
  // Exact vertex coincidence is the only sharing that survives every consumer,
  // so a vertex within tolerance must win even if an edge is marginally closer.
  const shapes = [{ id: 1, points: rect(0, 0, 10, 10) }];
  const near = [10.2, 10.1];               // close to the corner (10,10)
  const snap = T.snapPoint(near, shapes, 0.5);
  assert.ok(snap);
  assert.strictEqual(snap.kind, 'vertex');
  assert.deepStrictEqual(snap.point, [10, 10]);
});

test('snapping falls back to an edge when no vertex is close', () => {
  const shapes = [{ id: 1, points: rect(0, 0, 10, 10) }];
  const snap = T.snapPoint([5, 0.2], shapes, 0.5);
  assert.ok(snap);
  assert.strictEqual(snap.kind, 'edge');
  assert.ok(Math.abs(snap.point[1]) < 1e-9, 'should land on the y=0 edge');
  assert.ok(Math.abs(snap.point[0] - 5) < 1e-9);
});

test('snapping returns nothing when everything is out of range', () => {
  const shapes = [{ id: 1, points: rect(0, 0, 10, 10) }];
  assert.strictEqual(T.snapPoint([50, 50], shapes, 0.5), null);
});

test('snapping can exclude the shape being edited', () => {
  const shapes = [{ id: 1, points: rect(0, 0, 10, 10) }];
  assert.strictEqual(T.snapPoint([10.1, 10.1], shapes, 0.5, 1), null,
    'the shape being edited must not snap to itself');
});

test('snapping a whole ring reports each move', () => {
  const shapes = [{ id: 1, points: rect(0, 0, 10, 10) }];
  const drawn = [[10.1, 0.1], [20, 0], [20, 10], [10.2, 9.9]];
  const r = T.snapRing(drawn, shapes, 0.5);
  assert.strictEqual(r.snappedCount, 2);
  assert.deepStrictEqual(r.ring[0], [10, 0]);
  assert.deepStrictEqual(r.ring[3], [10, 10]);
  assert.deepStrictEqual(r.ring[1], [20, 0], 'far vertices are untouched');
  for (const s of r.snaps) assert.ok(s.movedBy > 0 && s.movedBy <= 0.5);
});

/* =====================================================================
 * OVERLAP DETECTION
 * =================================================================== */

test('overlap detection distinguishes crossing, containment, touching and disjoint', () => {
  const a = rect(0, 0, 10, 10);
  assert.strictEqual(T.ringsOverlap(a, rect(5, 5, 10, 10)), true, 'partial overlap');
  assert.strictEqual(T.ringsOverlap(a, rect(2, 2, 4, 4)), true, 'fully contained');
  assert.strictEqual(T.ringsOverlap(a, rect(20, 20, 5, 5)), false, 'disjoint');
  // Sharing an edge exactly is correct topology, NOT an overlap. Reporting it
  // as one would make properly-snapped parcels look broken.
  assert.strictEqual(T.ringsOverlap(a, rect(10, 0, 10, 10)), false,
    'edge-adjacent parcels must not be flagged');
});

test('overlap area estimate is labelled as an estimate and is roughly right', () => {
  const est = T.estimateOverlapArea(rect(0, 0, 10, 10), rect(5, 0, 10, 10), 200);
  assert.strictEqual(est.exact, false, 'must never claim to be exact');
  assert.ok(Math.abs(est.area - 50) / 50 < 0.02, `expected ~50, got ${est.area.toFixed(2)}`);
  assert.ok(est.gridSteps > 0 && est.cellArea > 0, 'resolution must be reported');
  assert.strictEqual(T.estimateOverlapArea(rect(0, 0, 5, 5), rect(20, 20, 5, 5)).area, 0);
});

test('unsnapped vertices near a neighbour edge are found, exact ones are not', () => {
  const shapes = [
    { id: 1, points: rect(0, 0, 10, 10) },
    // Shares the x=10 boundary but is 8 cm off, the classic sliver.
    { id: 2, points: [[10.08, 0], [20, 0], [20, 10], [10.08, 10]] },
  ];
  const issues = T.findUnsnapped(shapes, 0.5);
  assert.ok(issues.length >= 2, `expected the offset vertices to be flagged, got ${issues.length}`);
  for (const i of issues) assert.ok(i.distance > 0 && i.distance <= 0.5);

  // Snap them and the complaint must disappear.
  const exact = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: [[10, 0], [20, 0], [20, 10], [10, 10]] },
  ];
  assert.deepStrictEqual(T.findUnsnapped(exact, 0.5), [],
    'exactly shared boundaries must not be reported');
});

test('session topology analysis summarises cleanly', () => {
  const dirty = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: rect(5, 5, 10, 10) },
  ];
  const a = T.analyseTopology(dirty, { tolerance: 0.5, gridSteps: 80 });
  assert.strictEqual(a.clean, false);
  assert.strictEqual(a.overlaps.length, 1);
  assert.strictEqual(a.overlaps[0].areaIsEstimate, true);
  assert.match(a.summary, /overlapping pair/);

  const clean = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: [[10, 0], [20, 0], [20, 10], [10, 10]] },
  ];
  const b = T.analyseTopology(clean, { tolerance: 0.5 });
  assert.strictEqual(b.clean, true);
  assert.match(b.summary, /No overlaps/);
});

test('snapAllToNeighbours makes a near-miss session exactly clean', () => {
  const shapes = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: [[10.08, 0.05], [20, 0], [20, 10], [10.07, 9.94]] },
  ];
  assert.ok(T.findUnsnapped(shapes, 0.5).length > 0, 'the fixture must start dirty');
  const r = T.snapAllToNeighbours(shapes, 0.5);
  assert.ok(r.moved > 0, 'vertices should have been moved');
  assert.deepStrictEqual(T.findUnsnapped(r.shapes, 0.5), [],
    'after snapping there must be nothing left to snap');
});

/* =====================================================================
 * QUALITY SCORING
 * =================================================================== */

test('a clean, well-georeferenced, area-matching parcel scores highly', () => {
  const shape = {
    id: 1, points: rect(0, 0, 40, 25), plotNo: '12',
    validity: { valid: true, problems: [] },
    areaDiffPct: 1.2,
    lastGcpCorrection: { type: 'similarity', gcpCount: 6, looMeters: 0.18 },
  };
  const s = T.scoreShape(shape, {});
  assert.ok(s.score >= 90, `expected an excellent score, got ${s.score}: ${JSON.stringify(s.findings)}`);
  assert.strictEqual(s.grade, 'excellent');
  assert.ok(s.findings.some((f) => f.code === 'area-agrees'));
  assert.ok(s.findings.some((f) => f.code === 'gcp-good'));
});

test('a self-intersecting parcel with a wild area is graded down hard', () => {
  const shape = {
    id: 2, points: [[0, 0], [10, 10], [10, 0], [0, 10]],
    validity: { valid: false, problems: [{ code: 'self-intersection', message: 'crosses itself' }] },
    areaDiffPct: 68,
  };
  const s = T.scoreShape(shape, {});
  assert.ok(s.score < 55, `expected a poor score, got ${s.score}`);
  assert.ok(['poor', 'unusable', 'fair'].includes(s.grade), s.grade);
  assert.ok(s.findings.some((f) => f.code === 'self-intersection' && f.severity === 'error'));
  assert.ok(s.findings.some((f) => f.code === 'area-mismatch' && f.severity === 'error'));
});

test('every deduction is itemised with its cost, so the grade can be argued with', () => {
  const shape = {
    id: 3, points: rect(0, 0, 10, 10),
    validity: { valid: true, problems: [] },
    areaDiffPct: 12,
  };
  const s = T.scoreShape(shape, {});
  const deductions = s.findings.filter((f) => f.points > 0);
  assert.ok(deductions.length > 0);
  for (const d of deductions) {
    assert.ok(typeof d.points === 'number' && d.points > 0, 'each finding states its cost');
    assert.ok(d.message && d.message.length > 10, 'each finding explains itself');
    assert.ok(d.severity, 'each finding has a severity');
  }
  const totalDeducted = deductions.reduce((a, d) => a + d.points, 0);
  assert.strictEqual(s.score, Math.max(0, 100 - totalDeducted),
    'the score must equal 100 minus the itemised deductions');
});

test('an unusable polygon is reported as such rather than scored', () => {
  const s = T.scoreShape({ id: 4, points: [[0, 0], [1, 1]] }, {});
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.grade, 'unusable');
});

test('topology problems feed into the per-shape score', () => {
  const shapes = [
    { id: 1, points: rect(0, 0, 10, 10), validity: { valid: true, problems: [] } },
    { id: 2, points: rect(5, 5, 10, 10), validity: { valid: true, problems: [] } },
  ];
  const topology = T.analyseTopology(shapes, { tolerance: 0.5, gridSteps: 60 });
  const withTopo = T.scoreShape(shapes[0], { topology });
  const withoutTopo = T.scoreShape(shapes[0], {});
  assert.ok(withTopo.score < withoutTopo.score, 'an overlap must cost something');
  assert.ok(withTopo.findings.some((f) => f.code === 'overlap'));
});

test('session scoring aggregates and identifies the worst parcel', () => {
  const shapes = [
    { id: 1, points: rect(0, 0, 40, 25), validity: { valid: true, problems: [] }, areaDiffPct: 1,
      lastGcpCorrection: { gcpCount: 6, looMeters: 0.2 } },
    { id: 2, points: [[100, 0], [110, 10], [110, 0], [100, 10]],
      validity: { valid: false, problems: [{ code: 'self-intersection', message: 'crosses itself' }] },
      areaDiffPct: 40 },
  ];
  const s = T.scoreSession(shapes, { tolerance: 0.5, gridSteps: 60 });
  assert.strictEqual(s.shapes.length, 2);
  assert.strictEqual(s.worst.id, 2, 'the broken parcel must be identified as worst');
  assert.ok(s.errorCount >= 2, `expected errors to be counted, got ${s.errorCount}`);
  assert.ok(s.averageScore > s.worst.score && s.averageScore < s.shapes[0].score);
  assert.ok(s.topology, 'topology analysis is included');
});

test('scoring flags a parcel that was never cleaned up', () => {
  const many = [];
  for (let i = 0; i < 260; i++) {
    const a = (2 * Math.PI * i) / 260;
    many.push([20 * Math.cos(a), 20 * Math.sin(a)]);
  }
  const s = T.scoreShape({ id: 5, points: many, validity: { valid: true, problems: [] } }, {});
  assert.ok(s.findings.some((f) => f.code === 'too-many-vertices'));
});

test('scoring notices when a fit was never cross-checked', () => {
  const s = T.scoreShape({
    id: 6, points: rect(0, 0, 10, 10), validity: { valid: true, problems: [] },
    lastGcpCorrection: { type: 'affine', gcpCount: 3 },  // exactly determined
  }, {});
  const f = s.findings.find((x) => x.code === 'gcp-unvalidated');
  assert.ok(f, JSON.stringify(s.findings));
  assert.match(f.message, /zero by construction/);
});


/* =====================================================================
 * SHARED CORNERS AND CROSSING DETECTION
 *
 * These back the reported bug that adjacent plot boundaries ended up crossing
 * each other. Two parcels that meet along a line share corner coordinates;
 * moving one copy and leaving the other behind turns a shared edge into a pair
 * of crossing edges. Finding every copy of a corner is what makes moving it
 * safe.
 * =================================================================== */

test('findCoincidentVertices reports every neighbour sharing a corner, not just the closest', () => {
  // Four parcels meeting at (10,10), the classic cadastral crossroads.
  const shapes = [
    { id: 1, points: rect(0, 0, 10, 10) },       // corner at (10,10)
    { id: 2, points: rect(10, 0, 10, 10) },      // corner at (10,10)
    { id: 3, points: rect(0, 10, 10, 10) },      // corner at (10,10)
    { id: 4, points: rect(10, 10, 10, 10) },     // corner at (10,10)
  ];
  const hits = T.findCoincidentVertices(shapes, [10, 10], 0.5, 1);
  const ids = [...new Set(hits.map((h) => h.shapeId))].sort();
  assert.deepStrictEqual(ids, [2, 3, 4],
    'all three neighbours must be found; snapPoint would have returned only one');
  for (const h of hits) {
    const p = shapes.find((s) => s.id === h.shapeId).points[h.vertexIndex];
    assert.ok(Math.hypot(p[0] - 10, p[1] - 10) <= 0.5,
      'every reported index must actually point at the shared corner');
  }
});

test('findCoincidentVertices excludes the shape being edited and respects the tolerance', () => {
  const shapes = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: rect(10.4, 0, 10, 10) },   // 0.4 m gap
  ];
  assert.strictEqual(T.findCoincidentVertices(shapes, [10, 10], 0.5, 1).length, 1,
    'a 0.4 m gap is within a 0.5 m tolerance');
  assert.strictEqual(T.findCoincidentVertices(shapes, [10, 10], 0.2, 1).length, 0,
    'and outside a 0.2 m one');
  assert.strictEqual(T.findCoincidentVertices(shapes, [10, 10], 0.5, 2).length, 1,
    'excluding shape 2 must leave shape 1 findable');
});

test('findCoincidentVertices returns nearest first and tolerates junk input', () => {
  const shapes = [
    { id: 1, points: [[0, 0]] },
    { id: 2, points: [[0.3, 0]] },
    { id: 3, points: null },
    null,
  ];
  const hits = T.findCoincidentVertices(shapes, [0.1, 0], 1);
  assert.deepStrictEqual(hits.map((h) => h.shapeId), [1, 2]);
  assert.strictEqual(T.findCoincidentVertices(null, [0, 0], 1).length, 0);
});

test('crossingPairs finds overlapping parcels and ignores ones that merely touch', () => {
  const tiled = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: rect(10, 0, 10, 10) },   // shares an edge exactly
  ];
  assert.strictEqual(T.crossingPairs(tiled).size, 0,
    'a properly shared boundary is not a crossing');

  const overlapping = [
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: rect(8, 0, 10, 10) },    // 2 m of overlap
  ];
  const keys = T.crossingPairs(overlapping);
  assert.strictEqual(keys.size, 1);
  assert.ok(keys.has('1|2'), [...keys].join(','));
});

test('crossingPairs keys are order-independent, so before and after can be compared', () => {
  const a = T.crossingPairs([
    { id: 7, points: rect(0, 0, 10, 10) },
    { id: 3, points: rect(8, 0, 10, 10) },
  ]);
  const b = T.crossingPairs([
    { id: 3, points: rect(8, 0, 10, 10) },
    { id: 7, points: rect(0, 0, 10, 10) },
  ]);
  assert.deepStrictEqual([...a], [...b], 'listing the shapes in either order must agree');
  assert.ok(a.has('3|7'), 'the lower id comes first');
});

test('crossingPairs skips shapes too small to be a ring', () => {
  const keys = T.crossingPairs([
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: [[1, 1], [2, 2]] },     // a line, not a parcel
    { id: 3, points: null },
  ]);
  assert.strictEqual(keys.size, 0);
});

test('newCrossings reports only what an operation introduced', () => {
  // The distinction that makes the warning worth reading: a session that already
  // had one overlap should not be blamed on the operation that made a second.
  const before = T.crossingPairs([
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: rect(8, 0, 10, 10) },
    { id: 3, points: rect(0, 40, 10, 10) },
  ]);
  const after = T.crossingPairs([
    { id: 1, points: rect(0, 0, 10, 10) },
    { id: 2, points: rect(8, 0, 10, 10) },   // still overlapping, as before
    // Newly dragged onto shape 1 only. Kept narrow (x 0..6) so it stays clear of
    // shape 2 at x 8..18, or this would introduce two new crossings and stop
    // testing the "only what changed" distinction.
    { id: 3, points: rect(0, 8, 6, 10) },
  ]);
  const added = T.newCrossings(before, after);
  assert.deepStrictEqual(added, ['1|3'],
    'the pre-existing 1|2 overlap must not be reported as new');
  assert.deepStrictEqual(T.newCrossings(after, before), [],
    'and fixing an overlap must report nothing');
});


test('ringsOverlap catches an axis-aligned band overlap, where every vertex sits on the other boundary', () => {
  // The case a vertex-only containment test misses, and the one most likely to
  // occur in practice: cadastral parcels are usually axis-aligned, so a parcel
  // digitised 2 m too wide overlaps its neighbour in a band whose corners all
  // land exactly on the neighbour's edges. No edge properly crosses, and no
  // vertex is strictly inside, yet the parcels plainly overlap.
  const a = rect(0, 0, 10, 10);
  assert.strictEqual(T.ringsOverlap(a, rect(8, 0, 10, 10)), true,
    'a 2 m band of overlap must be detected');
  assert.strictEqual(T.ringsOverlap(a, rect(0, 8, 10, 10)), true,
    'and in the other axis');
  // The neighbouring cases must stay unaffected: sharing an edge or a single
  // corner is correct cadastral topology, not an overlap.
  assert.strictEqual(T.ringsOverlap(a, rect(10, 0, 10, 10)), false, 'sharing an edge');
  assert.strictEqual(T.ringsOverlap(a, rect(10, 10, 10, 10)), false, 'sharing one corner');
  assert.strictEqual(T.ringsOverlap(a, rect(20, 20, 5, 5)), false, 'disjoint');
});


/* =====================================================================
 * LEAK DETECTION
 *
 * A colour flood fill can escape through a one-pixel gap in a drawn boundary and
 * swallow the neighbouring parcels. The result is still a closed ring with a
 * plausible area, so nothing downstream notices and the operator exports a
 * boundary for the wrong land. The portal reports the bounding box of the parcel
 * that was clicked, which makes this checkable rather than guessable.
 * =================================================================== */

test('bboxLeakage reports nothing leaked when the trace sits inside the declared box', () => {
  const ring = rect(2, 2, 6, 6);
  const leak = T.bboxLeakage(ring, { xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
  assert.ok(leak, 'a measurement should be returned');
  assert.ok(leak.leakedPct < 0.5, `expected ~0% leaked, got ${leak.leakedPct.toFixed(2)}%`);
  assert.ok(Math.abs(leak.ringArea - 36) < 1e-9, `ring area ${leak.ringArea}`);
  assert.strictEqual(leak.exact, false, 'a grid estimate must not claim to be exact');
});

test('bboxLeakage measures how much of an escaped fill lies outside', () => {
  // The fill escaped east: half the traced ring is beyond the declared parcel.
  const ring = rect(0, 0, 20, 10);
  const leak = T.bboxLeakage(ring, { xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
  assert.ok(Math.abs(leak.leakedPct - 50) < 2,
    `half the ring is outside, expected ~50%, got ${leak.leakedPct.toFixed(2)}%`);
  assert.ok(Math.abs(leak.insideArea + leak.outsideArea - leak.ringArea) < leak.ringArea * 0.02,
    'inside plus outside should account for the ring');
});

test('bboxLeakage flags a fill that took in a whole neighbour', () => {
  // A parcel 10 wide, traced 30 wide: two neighbours swallowed.
  const leak = T.bboxLeakage(rect(0, 0, 30, 10), { xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
  assert.ok(leak.leakedPct > 60,
    `two thirds should be outside, got ${leak.leakedPct.toFixed(2)}%`);
});

test('bboxLeakage refuses to guess rather than returning a misleading zero', () => {
  const ring = rect(0, 0, 10, 10);
  assert.strictEqual(T.bboxLeakage(ring, null), null, 'no box, no answer');
  assert.strictEqual(T.bboxLeakage(ring, { xmin: 0, ymin: 0, xmax: 0, ymax: 10 }), null,
    'a degenerate box is not a box');
  assert.strictEqual(T.bboxLeakage(ring, { xmin: NaN, ymin: 0, xmax: 10, ymax: 10 }), null,
    'NaN bounds must be rejected, not silently treated as zero');
  assert.strictEqual(T.bboxLeakage([[0, 0], [1, 1]], { xmin: 0, ymin: 0, xmax: 10, ymax: 10 }), null,
    'two points are not a ring');
  assert.strictEqual(T.bboxLeakage([[0, 0], [1, 0], [2, 0]], { xmin: 0, ymin: 0, xmax: 10, ymax: 10 }), null,
    'a zero-area ring has no fraction to report');
});

test('bboxLeakage is deterministic', () => {
  const ring = rect(3, 3, 14, 9);
  const box = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
  assert.deepStrictEqual(T.bboxLeakage(ring, box), T.bboxLeakage(ring, box),
    'the same inputs must always give the same figure');
});


test('the quality report records a leaked trace, not just a toast that vanishes', () => {
  // A leaked fill is the most serious defect a trace can have: not an inaccurate
  // boundary but a boundary for the wrong land. The toast at trace time is gone by
  // the time anyone reviews the session, so the durable record has to carry it.
  const base = { id: 1, points: rect(0, 0, 10, 10), validity: { valid: true, problems: [] } };

  const clean = T.scoreShape(base, {});
  assert.ok(!clean.findings.some((f) => f.code === 'bbox-leak'),
    'a trace with no leak measurement must not be blamed for one');

  const bad = T.scoreShape(Object.assign({}, base, { leak: { leakedPct: 62 } }), {});
  const f = bad.findings.find((x) => x.code === 'bbox-leak');
  assert.ok(f, JSON.stringify(bad.findings.map((x) => x.code)));
  assert.strictEqual(f.severity, 'error', 'a badly leaked trace is an error, not a note');
  assert.match(f.message, /wrong parcel/i, 'and it must say what is actually at stake');
  assert.ok(bad.score < clean.score - 30, `the deduction should be severe: ${bad.score} vs ${clean.score}`);

  // A small overshoot is worth mentioning without condemning the trace.
  const slight = T.scoreShape(Object.assign({}, base, { leak: { leakedPct: 9 } }), {});
  const sf = slight.findings.find((x) => x.code === 'bbox-leak');
  assert.strictEqual(sf.severity, 'warn');
  assert.ok(slight.score > bad.score, 'and it must cost less than a full leak');

  // Below the noise floor, say nothing. A grid estimate always has some error, and
  // condemning a 2% figure would train the operator to ignore the finding.
  const trivial = T.scoreShape(Object.assign({}, base, { leak: { leakedPct: 2 } }), {});
  assert.ok(!trivial.findings.some((x) => x.code === 'bbox-leak'),
    'a couple of percent is within the estimator\'s own error');
  assert.strictEqual(trivial.score, clean.score);
});

test('scored deductions still add up once a leak is included', () => {
  const s = T.scoreShape({
    id: 1, points: rect(0, 0, 10, 10), validity: { valid: true, problems: [] },
    areaDiffPct: 12, leak: { leakedPct: 62 },
  }, {});
  const total = s.findings.filter((f) => f.points > 0).reduce((a, f) => a + f.points, 0);
  assert.strictEqual(s.score, Math.max(0, 100 - total),
    'the score must remain exactly 100 minus the itemised deductions');
});
