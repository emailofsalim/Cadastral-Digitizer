/* =========================================================================
 * Tests for lib/exporters.js
 *
 * The binary writers are verified by PARSING THEM BACK, not by eyeballing
 * lengths — shapefile mixes big- and little-endian in the same file and a
 * wrong-endian field produces a file that looks fine and reads as garbage.
 * The ZIP output is additionally checked with the system `unzip`, so the
 * verdict comes from a real implementation rather than from this code
 * agreeing with itself.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const E = require('../lib/exporters.js');
const CRS = require('../lib/crs.js');

const JH_E = 432500, JH_N = 2618400;

// A simple square, given counter-clockwise, plus a shape list around it.
const SQUARE_CCW = [[JH_E, JH_N], [JH_E + 40, JH_N], [JH_E + 40, JH_N + 30], [JH_E, JH_N + 30]];
function shapeList() {
  return [
    { id: 1, points: SQUARE_CCW.slice(), plotNo: '123/4', areaText: '0 एकड़ 29.65 डिसमिल', mode: 'trace-fill' },
    {
      id: 2,
      points: [[JH_E + 100, JH_N], [JH_E + 160, JH_N], [JH_E + 160, JH_N + 50], [JH_E + 100, JH_N + 50]],
      plotNo: '125', areaText: null, mode: 'manual',
      lastGcpCorrection: { type: 'similarity', rmsMeters: 0.12, gcpCount: 5 },
    },
  ];
}

/* =====================================================================
 * ESCAPING — the v13 injection bugs.
 * =================================================================== */

test('XML escaping neutralises every dangerous character', () => {
  assert.strictEqual(E.escapeXml('a & b'), 'a &amp; b');
  assert.strictEqual(E.escapeXml('<tag>'), '&lt;tag&gt;');
  assert.strictEqual(E.escapeXml('say "hi"'), 'say &quot;hi&quot;');
  assert.strictEqual(E.escapeXml("it's"), 'it&apos;s');
  assert.strictEqual(E.escapeXml(null), '');
  assert.strictEqual(E.escapeXml(42), '42');
});

test('CSV escaping defuses spreadsheet formula injection', () => {
  // A parcel identifier starting with = becomes a live formula in Excel.
  assert.strictEqual(E.escapeCsv('=1+1'), "'=1+1");
  assert.strictEqual(E.escapeCsv('=cmd|"/c calc"!A1'), '"\'=cmd|""/c calc""!A1"');
  assert.strictEqual(E.escapeCsv('+44'), "'+44");
  assert.strictEqual(E.escapeCsv('-5'), "'-5");
  assert.strictEqual(E.escapeCsv('@SUM'), "'@SUM");
  // Quoting only where needed.
  assert.strictEqual(E.escapeCsv('plain'), 'plain');
  assert.strictEqual(E.escapeCsv('a,b'), '"a,b"');
  assert.strictEqual(E.escapeCsv('say "hi"'), '"say ""hi"""');
});

test('DXF text sanitisation strips newlines that would corrupt structure', () => {
  assert.strictEqual(E.sanitizeDxfText('Plot\n123'), 'Plot 123');
  assert.strictEqual(E.sanitizeDxfText('a\r\n\r\nb'), 'a b');
  assert.ok(E.sanitizeDxfText('x'.repeat(500)).length <= 250);
});

/* =====================================================================
 * RING GEOMETRY
 * =================================================================== */

test('signed area encodes winding; absolute area is orientation-free', () => {
  assert.ok(E.signedArea(SQUARE_CCW) > 0, 'the fixture is counter-clockwise');
  assert.ok(E.signedArea(SQUARE_CCW.slice().reverse()) < 0);
  assert.strictEqual(E.gridArea(SQUARE_CCW), 1200);
  assert.strictEqual(E.gridArea(SQUARE_CCW.slice().reverse()), 1200);
});

test('area is unaffected by whether the ring is explicitly closed', () => {
  assert.strictEqual(E.gridArea(E.closeRing(SQUARE_CCW)), 1200);
  assert.strictEqual(E.openRing(E.closeRing(SQUARE_CCW)).length, 4);
  assert.ok(E.isClosed(E.closeRing(SQUARE_CCW)));
  assert.ok(!E.isClosed(SQUARE_CCW));
});

test('ensureWinding forces the requested orientation without altering shape', () => {
  const ccw = E.ensureWinding(SQUARE_CCW, true);
  const cw = E.ensureWinding(SQUARE_CCW, false);
  assert.ok(E.isCounterClockwise(ccw));
  assert.ok(!E.isCounterClockwise(cw));
  assert.strictEqual(E.gridArea(ccw), E.gridArea(cw), 'reversal must not change area');
  assert.strictEqual(ccw.length, cw.length);
});

test('perimeter measures the closed loop', () => {
  assert.ok(Math.abs(E.perimeter(SQUARE_CCW) - 140) < 1e-9, `got ${E.perimeter(SQUARE_CCW)}`);
});

test('centroid is area-weighted, not the mean of vertices', () => {
  // Vertex density is deliberately lopsided: extra points crowd one edge, the
  // way a flood-fill boundary crowds a wiggly side. The area centroid must
  // ignore that; a vertex mean cannot.
  const lopsided = [
    [0, 0], [10, 0], [10, 10], [0, 10],
    [0, 7.5], [0, 5], [0, 2.5],
  ];
  const c = E.centroidOfRing(lopsided);
  assert.ok(Math.abs(c[0] - 5) < 1e-9, `x should be 5, got ${c[0]}`);
  assert.ok(Math.abs(c[1] - 5) < 1e-9, `y should be 5, got ${c[1]}`);
  const vertexMean = [
    lopsided.reduce((s, p) => s + p[0], 0) / lopsided.length,
    lopsided.reduce((s, p) => s + p[1], 0) / lopsided.length,
  ];
  assert.ok(Math.abs(vertexMean[0] - 5) > 1,
    'the fixture must actually distinguish the two definitions');
});

/* =====================================================================
 * VALIDITY
 * =================================================================== */

test('a clean convex ring reports no problems', () => {
  const v = E.validateRing(SQUARE_CCW);
  assert.strictEqual(v.valid, true, JSON.stringify(v.problems));
});

test('a bowtie self-intersection is detected', () => {
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const v = E.validateRing(bowtie);
  assert.strictEqual(v.valid, false);
  const p = v.problems.find((x) => x.code === 'self-intersection');
  assert.ok(p, `expected self-intersection, got ${JSON.stringify(v.problems)}`);
  assert.match(p.message, /crosses itself/i);
  assert.match(p.message, /vertex editor/i, 'the message should tell the user what to do');
});

test('a pinched ring — the realistic flood-fill artefact — is detected', () => {
  // Two lobes joined through a crossing, like a trace that leaked through a
  // narrow track and came back.
  const pinched = [
    [0, 0], [10, 0], [10, 5], [5, 5],
    [5, 4], [15, 4], [15, 10], [0, 10],
  ];
  assert.ok(E.findSelfIntersections(pinched).length > 0, 'should find the pinch');
  assert.strictEqual(E.validateRing(pinched).valid, false);
});

test('adjacent edges sharing a vertex are not reported as intersections', () => {
  // Every simple polygon has touching consecutive edges; flagging those would
  // make the check useless.
  for (const ring of [SQUARE_CCW, [[0, 0], [5, 0], [5, 5], [2, 3], [0, 5]]]) {
    assert.deepStrictEqual(E.findSelfIntersections(ring), [], JSON.stringify(ring));
  }
});

test('degenerate rings are reported with specific codes', () => {
  const collinear = [[0, 0], [5, 5], [10, 10]];
  const codes = E.validateRing(collinear).problems.map((p) => p.code);
  assert.ok(codes.includes('zero-area'), codes.join(','));

  const dup = [[0, 0], [0, 0], [10, 0], [10, 10]];
  assert.ok(E.validateRing(dup).problems.some((p) => p.code === 'duplicate-points'));

  const tiny = [[0, 0], [1, 1]];
  assert.ok(E.validateRing(tiny).problems.some((p) => p.code === 'too-few-points'));
});

/* =====================================================================
 * AREA
 * =================================================================== */

test('geodesic area agrees with an independently projected planar area', () => {
  // Two entirely separate routes to the same number: spherical excess on
  // lon/lat, versus UTM grid area corrected by the point scale factor.
  const crs = { kind: 'utm', zone: 45, north: true, datum: 'WGS84' };
  const cornersUtm = [
    [JH_E, JH_N], [JH_E + 200, JH_N], [JH_E + 200, JH_N + 150], [JH_E, JH_N + 150],
  ];
  const lonLat = cornersUtm.map((p) => CRS.toWgs84(p[0], p[1], crs));
  const geo = E.geodesicArea(lonLat);

  const k = CRS.pointScaleFactor(JH_E + 100, JH_N + 75, crs);
  const ground = E.groundAreaFromGrid(cornersUtm, k);

  const relDiff = Math.abs(geo - ground) / ground;
  // Tolerance is deliberately tight. An earlier implementation used the global
  // authalic radius and sat at 0.23% here — a systematic ~9 m² over-estimate on
  // a 4000 m² plot, which is not acceptable when the figure gets compared with
  // a recorded area. Using the local Gaussian radius brings it to ~2e-5, so
  // anything above 1e-4 means that regression has returned.
  assert.ok(relDiff < 1e-4,
    `geodesic ${geo.toFixed(2)} m² vs scale-corrected grid ${ground.toFixed(2)} m², ` +
    `differ by ${(relDiff * 100).toFixed(4)}%`);
});

test('geodesic area uses local curvature, not a global mean radius', () => {
  // Pins the fix. The local Gaussian radius must differ measurably from the
  // authalic mean at Indian latitudes, and area must track the local value.
  const rLocal = E.gaussianRadiusAt(23.67 * Math.PI / 180);
  assert.ok(Math.abs(rLocal - E.AUTHALIC_R) > 5000,
    `local radius ${rLocal.toFixed(0)} should differ from authalic ${E.AUTHALIC_R} by kilometres`);

  // Same polygon shape at two latitudes must yield different areas, because
  // curvature differs — a single fixed radius could not produce that.
  const box = (lat) => [[86, lat], [86.002, lat], [86.002, lat + 0.002], [86, lat + 0.002]];
  const nearEquator = E.geodesicArea(box(1));
  const midLat = E.geodesicArea(box(45));
  assert.ok(nearEquator > 0 && midLat > 0);
  assert.ok(Math.abs(nearEquator - midLat) / midLat > 1e-3,
    'curvature-aware area must vary with latitude');
});

test('the grid/ground scale correction is applied in the right direction', () => {
  // UTM k is below 1 near the central meridian, so true ground area exceeds
  // grid area there. Getting the direction backwards doubles the error.
  const grid = E.gridArea(SQUARE_CCW);
  const ground = E.groundAreaFromGrid(SQUARE_CCW, 0.9996);
  assert.ok(ground > grid, `ground ${ground} should exceed grid ${grid} when k<1`);
  assert.ok(Math.abs(ground - grid / (0.9996 * 0.9996)) < 1e-9);
  // And it must be a no-op for an unspecified or nonsense factor.
  assert.strictEqual(E.groundAreaFromGrid(SQUARE_CCW, 1), grid);
  assert.strictEqual(E.groundAreaFromGrid(SQUARE_CCW, 0), grid);
  assert.strictEqual(E.groundAreaFromGrid(SQUARE_CCW, NaN), grid);
});

test('Indian area units parse and round-trip', () => {
  const oneAcre = E.parseIndianAreaToM2('1 एकड़ 0 डिसमिल');
  assert.ok(Math.abs(oneAcre - E.M2_PER_ACRE) < 1e-6, `got ${oneAcre}`);
  const mixed = E.parseIndianAreaToM2('2 एकड़ 50 डिसमिल');
  assert.ok(Math.abs(mixed - (2 * E.M2_PER_ACRE + 50 * E.M2_PER_DECIMAL)) < 1e-6);
  // English and metric variants that appear on other states' portals.
  assert.ok(Math.abs(E.parseIndianAreaToM2('1.5 hectare') - 15000) < 1e-6);
  assert.ok(Math.abs(E.parseIndianAreaToM2('250 sq.m') - 250) < 1e-6);
  assert.strictEqual(E.parseIndianAreaToM2('no area here'), null);
  assert.strictEqual(E.parseIndianAreaToM2(null), null);

  const f = E.formatAreaIndian(E.M2_PER_ACRE * 2.5);
  assert.ok(Math.abs(f.acres - 2.5) < 1e-9);
  assert.ok(Math.abs(f.hectares - E.M2_PER_ACRE * 2.5 / 10000) < 1e-9);
  assert.match(f.text, /2 एकड़ 50\.00 डिसमिल/);
});

/* =====================================================================
 * DXF
 * =================================================================== */

test('DXF absolute mode writes true CRS coordinates', () => {
  const r = E.makeDxf(shapeList(), { georefMode: 'absolute', crsLabel: 'UTM 45N' });
  assert.strictEqual(r.plotsWritten, 2);
  assert.deepStrictEqual(r.origin, [0, 0]);
  assert.ok(r.text.includes(String(JH_E) + '.0000') || r.text.includes('432500.0000'),
    'absolute eastings should appear verbatim');
});

test('DXF shift mode records the origin so georeferencing is recoverable', () => {
  const r = E.makeDxf(shapeList(), { georefMode: 'shift', crsLabel: 'UTM 45N' });
  assert.deepStrictEqual(r.origin, [432000, 2618000]);
  // The origin must be in the file, both as a comment and as $INSBASE.
  assert.ok(r.text.includes('432000 2618000'), 'origin must be documented in a 999 comment');
  assert.ok(r.text.includes('$INSBASE'), '$INSBASE must carry the origin');
  // Adding the origin back must recover the true coordinate.
  const lines = r.text.split('\r\n');
  const i = lines.indexOf('VERTEX');
  assert.ok(i > 0, 'at least one VERTEX expected');
  // find the first 10/20 pair after that vertex
  let x = null;
  for (let j = i; j < lines.length - 1; j++) {
    if (lines[j] === '10') { x = parseFloat(lines[j + 1]); break; }
  }
  assert.ok(x != null);
  assert.ok(Math.abs((x + r.origin[0]) - JH_E) < 1e-6,
    `recovered ${x + r.origin[0]} should equal ${JH_E}`);
});

test('DXF local mode reproduces v13 behaviour and loses absolute position', () => {
  const r = E.makeDxf(shapeList(), { georefMode: 'local' });
  const c = E.centroidOfRing(SQUARE_CCW);
  assert.ok(Math.abs(r.origin[0] - c[0]) < 1e-6, 'origin is the first shape centroid');
  assert.strictEqual(r.mode, 'local');
});

test('DXF applies the scale factor and marks closed polylines', () => {
  const r = E.makeDxf(shapeList(), { georefMode: 'shift', scaleFactor: 2 });
  const lines = r.text.split('\r\n');
  // group 70 = 1 on POLYLINE means closed.
  const pi = lines.indexOf('POLYLINE');
  assert.ok(pi >= 0);
  let closedFlag = null;
  for (let j = pi; j < Math.min(pi + 12, lines.length - 1); j++) {
    if (lines[j] === '70') { closedFlag = lines[j + 1]; break; }
  }
  assert.strictEqual(closedFlag, '1', 'polyline must be flagged closed');
  assert.ok(r.text.includes('Scale factor applied: 2'));
});

test('DXF handles an empty shape list without producing a broken file', () => {
  const r = E.makeDxf([], {});
  assert.strictEqual(r.plotsWritten, 0);
  assert.strictEqual(r.text, '');
});

/* =====================================================================
 * KML — the v13 ampersand bug.
 * =================================================================== */

test('KML escapes plot numbers, so an ampersand no longer breaks the file', () => {
  const shapes = [{ id: 1, points: SQUARE_CCW, plotNo: '12 & 13/A <x>', areaText: 'a & b' }];
  const kml = E.makeKml(shapes, { crsLabel: 'UTM 45N' });
  assert.ok(kml.includes('Plot 12 &amp; 13/A &lt;x&gt;'), 'name must be escaped');
  assert.ok(!/<name>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/.test(kml), 'no raw ampersands');
  // A well-formed document has balanced Placemark tags.
  assert.strictEqual((kml.match(/<Placemark>/g) || []).length, 1);
  assert.strictEqual((kml.match(/<\/Placemark>/g) || []).length, 1);
});

test('KML closes its rings and reports GCP provenance', () => {
  const kml = E.makeKml(shapeList(), {});
  const m = kml.match(/<coordinates>([^<]+)<\/coordinates>/);
  assert.ok(m);
  const pts = m[1].trim().split(' ');
  assert.strictEqual(pts[0], pts[pts.length - 1], 'ring must be closed');
  assert.match(kml, /GCP-corrected \(similarity, 5 control points\)/);
});

/* =====================================================================
 * GeoJSON — RFC 7946 conformance.
 * =================================================================== */

test('GeoJSON forces counter-clockwise exteriors per RFC 7946', () => {
  // Feed a clockwise ring; the writer must flip it.
  const cw = SQUARE_CCW.slice().reverse();
  const gj = E.makeGeoJson([{ id: 1, points: cw, plotNo: 'x' }], {});
  const ring = gj.features[0].geometry.coordinates[0];
  assert.ok(E.isCounterClockwise(ring), 'exterior ring must be CCW');
  assert.deepStrictEqual(ring[0], ring[ring.length - 1], 'ring must be closed');
});

test('GeoJSON preserves the untransformed source coordinates', () => {
  // Downstream tools must be able to re-georeference from scratch rather than
  // inheriting this extension's CRS assumption.
  const gj = E.makeGeoJson(shapeList(), { crsLabel: 'WGS 84 / UTM 45N' });
  const props = gj.features[0].properties;
  assert.ok(Array.isArray(props.sourceCoords));
  assert.deepStrictEqual(props.sourceCoords[0], [JH_E, JH_N]);
  assert.strictEqual(props.sourceCrs, 'WGS 84 / UTM 45N');
  assert.strictEqual(gj.metadata.sourceCrs, 'WGS 84 / UTM 45N');
});

test('GeoJSON records measurements and optional validity', () => {
  const gj = E.makeGeoJson(shapeList(), { includeValidity: true });
  const p = gj.features[0].properties;
  assert.strictEqual(p.vertexCount, 4);
  assert.ok(Math.abs(p.perimeterM - 140) < 1e-6);
  assert.strictEqual(p.validity.valid, true);
  assert.strictEqual(p.plotNo, '123/4');
});

test('GeoJSON is serialisable and reparses identically', () => {
  const gj = E.makeGeoJson(shapeList(), {});
  const round = JSON.parse(JSON.stringify(gj));
  assert.deepStrictEqual(round, JSON.parse(JSON.stringify(gj)));
  assert.strictEqual(round.type, 'FeatureCollection');
  assert.strictEqual(round.features.length, 2);
});

/* =====================================================================
 * WKT + CSV
 * =================================================================== */

test('WKT emits POLYGON for one shape and MULTIPOLYGON for several', () => {
  const one = E.makeWkt([shapeList()[0]], {});
  assert.match(one, /^POLYGON\(\(/);
  const many = E.makeWkt(shapeList(), {});
  assert.match(many, /^MULTIPOLYGON\(/);
  assert.strictEqual(E.makeWkt([], {}), '');
});

test('vertex CSV includes lon/lat when a projector is supplied', () => {
  const crs = { kind: 'utm', zone: 45, north: true, datum: 'WGS84' };
  const csv = E.makeVertexCsv(shapeList(), { toLonLat: (p) => CRS.toWgs84(p[0], p[1], crs) });
  const lines = csv.split('\r\n');
  assert.match(lines[0], /^plot_no,shape_id,vertex_index/);
  assert.strictEqual(lines.length, 1 + 8, 'header plus 4 vertices per shape');
  const first = lines[1].split(',');
  const lon = parseFloat(first[5]), lat = parseFloat(first[6]);
  assert.ok(lon > 84 && lon < 90, `lon ${lon} should be in Jharkhand's band`);
  assert.ok(lat > 20 && lat < 26, `lat ${lat} should be in Jharkhand's band`);
});

test('area report CSV compares digitised against recorded area', () => {
  const shapes = shapeList();
  shapes[0].computedAreaM2 = 1200;
  const csv = E.makeAreaReportCsv(shapes, {});
  const rows = csv.split('\r\n');
  assert.match(rows[0], /difference_pct/);
  const r1 = rows[1].split(',');
  // 29.65 decimals = 1199.9 m², so the difference should be tiny.
  const diff = parseFloat(r1[7]);
  assert.ok(Math.abs(diff) < 1, `difference ${diff}% should be near zero for this fixture`);
  assert.strictEqual(r1[9], 'yes', 'validity column');
});

/* =====================================================================
 * GCP EXCHANGE
 * =================================================================== */

test('GCP points file round-trips through write and parse', () => {
  const pairs = [
    { vertexIndex: 0, rawPoint: [JH_E, JH_N], confirmedPoint: [JH_E + 1.5, JH_N - 2.25] },
    { vertexIndex: 3, rawPoint: [JH_E + 40, JH_N + 30], confirmedPoint: [JH_E + 41.1, JH_N + 28.4] },
  ];
  const text = E.makeGcpPointsFile(pairs, { crsLabel: 'WGS 84 / UTM 45N' });
  assert.match(text, /^#CRS: WGS 84 \/ UTM 45N/);
  assert.match(text, /mapX,mapY,pixelX,pixelY/);

  const back = E.parseGcpPointsFile(text);
  assert.strictEqual(back.errors.length, 0);
  assert.strictEqual(back.pairs.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(back.pairs[i].rawPoint[0] - pairs[i].rawPoint[0]) < 1e-3);
    assert.ok(Math.abs(back.pairs[i].confirmedPoint[1] - pairs[i].confirmedPoint[1]) < 1e-3);
  }
});

test('GCP parser reports bad lines rather than silently dropping them', () => {
  const r = E.parseGcpPointsFile('#CRS: x\nmapX,mapY,pixelX,pixelY\n1,2,3,4\ngarbage\n5,6\n');
  assert.strictEqual(r.pairs.length, 1);
  assert.strictEqual(r.errors.length, 2, JSON.stringify(r.errors));
});

test('disabled GCPs survive the round-trip', () => {
  const text = E.makeGcpPointsFile([
    { rawPoint: [1, 2], confirmedPoint: [3, 4], enabled: false },
    { rawPoint: [5, 6], confirmedPoint: [7, 8], enabled: true },
  ], {});
  const back = E.parseGcpPointsFile(text);
  assert.strictEqual(back.pairs[0].enabled, false);
  assert.strictEqual(back.pairs[1].enabled, true);
});

/* =====================================================================
 * SHAPEFILE — verified by parsing the bytes back.
 * =================================================================== */

function parseShp(shp) {
  const dv = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  const header = {
    fileCode: dv.getInt32(0, false),
    lengthWords: dv.getInt32(24, false),
    version: dv.getInt32(28, true),
    shapeType: dv.getInt32(32, true),
    xmin: dv.getFloat64(36, true), ymin: dv.getFloat64(44, true),
    xmax: dv.getFloat64(52, true), ymax: dv.getFloat64(60, true),
  };
  const records = [];
  let off = 100;
  while (off < shp.byteLength) {
    const recNum = dv.getInt32(off, false);
    const contentWords = dv.getInt32(off + 4, false);
    let p = off + 8;
    const shapeType = dv.getInt32(p, true); p += 4;
    p += 32; // per-record box
    const numParts = dv.getInt32(p, true); p += 4;
    const numPoints = dv.getInt32(p, true); p += 4;
    p += 4 * numParts;
    const pts = [];
    for (let i = 0; i < numPoints; i++) {
      pts.push([dv.getFloat64(p, true), dv.getFloat64(p + 8, true)]);
      p += 16;
    }
    records.push({ recNum, contentWords, shapeType, numParts, numPoints, points: pts });
    off += 8 + contentWords * 2;
  }
  return { header, records };
}

test('shapefile header uses the correct mixed endianness and declared length', () => {
  const sf = E.shapefileFrom(shapeList(), {});
  const { header } = parseShp(sf.shp);
  assert.strictEqual(header.fileCode, 9994, 'file code is big-endian 9994');
  assert.strictEqual(header.version, 1000, 'version is little-endian 1000');
  assert.strictEqual(header.shapeType, 5, 'polygon');
  // Declared length is in 16-bit words and must match the real byte length.
  assert.strictEqual(header.lengthWords * 2, sf.shp.byteLength);
});

test('shapefile bounding box spans every shape', () => {
  const sf = E.shapefileFrom(shapeList(), {});
  const { header } = parseShp(sf.shp);
  assert.ok(Math.abs(header.xmin - JH_E) < 1e-9, `xmin ${header.xmin}`);
  assert.ok(Math.abs(header.xmax - (JH_E + 160)) < 1e-9, `xmax ${header.xmax}`);
  assert.ok(Math.abs(header.ymin - JH_N) < 1e-9);
  assert.ok(Math.abs(header.ymax - (JH_N + 50)) < 1e-9);
});

test('shapefile rings are CLOCKWISE — the opposite of GeoJSON', () => {
  // A counter-clockwise outer ring in a shapefile means "hole", so this is not
  // cosmetic: getting it backwards makes every parcel an empty void.
  const sf = E.shapefileFrom(shapeList(), {});
  const { records } = parseShp(sf.shp);
  assert.strictEqual(records.length, 2);
  for (const rec of records) {
    assert.strictEqual(rec.shapeType, 5);
    assert.strictEqual(rec.numParts, 1);
    assert.ok(!E.isCounterClockwise(rec.points),
      'shapefile outer rings must be clockwise');
    assert.deepStrictEqual(rec.points[0], rec.points[rec.points.length - 1],
      'ring must be explicitly closed');
  }
  // Same input, opposite convention, in GeoJSON.
  const gj = E.makeGeoJson(shapeList(), {});
  assert.ok(E.isCounterClockwise(gj.features[0].geometry.coordinates[0]),
    'GeoJSON must be CCW while the shapefile is CW');
});

test('shapefile record numbering is 1-based and geometry survives intact', () => {
  const sf = E.shapefileFrom(shapeList(), {});
  const { records } = parseShp(sf.shp);
  assert.strictEqual(records[0].recNum, 1);
  assert.strictEqual(records[1].recNum, 2);
  assert.strictEqual(records[0].numPoints, 5, '4 corners plus the closing point');
  // Every original corner must be present.
  for (const corner of SQUARE_CCW) {
    assert.ok(records[0].points.some((p) => Math.abs(p[0] - corner[0]) < 1e-9 && Math.abs(p[1] - corner[1]) < 1e-9),
      `corner ${corner} should survive the round-trip`);
  }
});

test('shapefile index (.shx) offsets point at the real records', () => {
  const sf = E.shapefileFrom(shapeList(), {});
  const sv = new DataView(sf.shx.buffer, sf.shx.byteOffset, sf.shx.byteLength);
  const dv = new DataView(sf.shp.buffer, sf.shp.byteOffset, sf.shp.byteLength);
  assert.strictEqual(sf.shx.byteLength, 100 + 2 * 8);
  for (let i = 0; i < 2; i++) {
    const offsetWords = sv.getInt32(100 + i * 8, false);
    const lenWords = sv.getInt32(100 + i * 8 + 4, false);
    const byteOffset = offsetWords * 2;
    // The record number at that offset must be i+1.
    assert.strictEqual(dv.getInt32(byteOffset, false), i + 1,
      `shx entry ${i} must point at record ${i + 1}`);
    assert.strictEqual(dv.getInt32(byteOffset + 4, false), lenWords,
      'shx content length must match the record header');
  }
});

test('DBF header and records are structurally correct', () => {
  const shapes = shapeList();
  shapes[0].computedAreaM2 = 1200;
  const sf = E.shapefileFrom(shapes, {});
  const dbf = sf.dbf;
  const dv = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  assert.strictEqual(dbf[0], 0x03, 'dBASE III marker');
  assert.strictEqual(dv.getInt32(4, true), 2, 'record count');
  const headerSize = dv.getInt16(8, true);
  const recordSize = dv.getInt16(10, true);
  const fieldCount = (headerSize - 32 - 1) / 32;
  assert.strictEqual(fieldCount, 9, 'nine attribute fields');
  assert.strictEqual(dbf[headerSize - 1], 0x0d, 'field descriptors terminated by 0x0D');
  assert.strictEqual(dbf.byteLength, headerSize + 2 * recordSize + 1);
  assert.strictEqual(dbf[dbf.byteLength - 1], 0x1a, 'EOF marker');

  // First record: PLOT_NO is the first 40-char field after the deletion flag.
  const decoder = new TextDecoder('ascii');
  assert.strictEqual(dbf[headerSize], 0x20, 'record not marked deleted');
  const plotNo = decoder.decode(dbf.slice(headerSize + 1, headerSize + 1 + 40)).trim();
  assert.strictEqual(plotNo, '123/4');
});

test('the .prj sidecar carries a usable CRS definition', () => {
  const utm = E.prjWktFor({ kind: 'utm', zone: 45, north: true });
  assert.match(utm, /PROJCS\["WGS 84 \/ UTM zone 45N"/);
  assert.match(utm, /PARAMETER\["central_meridian",87\]/);
  assert.match(utm, /PARAMETER\["false_northing",0\]/);

  const south = E.prjWktFor({ kind: 'utm', zone: 33, north: false });
  assert.match(south, /UTM zone 33S/);
  assert.match(south, /false_northing",10000000/);

  assert.match(E.prjWktFor({ kind: 'geographic' }), /^GEOGCS/);
  assert.match(E.prjWktFor({ kind: 'webmercator' }), /Pseudo-Mercator/);
  assert.strictEqual(E.prjWktFor(null), '');
});

test('an empty shape list yields a valid, empty shapefile', () => {
  const sf = E.shapefileFrom([], {});
  assert.strictEqual(sf.recordCount, 0);
  const { header, records } = parseShp(sf.shp);
  assert.strictEqual(header.fileCode, 9994);
  assert.strictEqual(records.length, 0);
  assert.strictEqual(header.lengthWords * 2, sf.shp.byteLength);
});

/* =====================================================================
 * ZIP — validated by the system unzip, not by our own reader.
 * =================================================================== */

test('CRC32 matches known reference values', () => {
  assert.strictEqual(E.crc32(E.utf8Encode('')), 0);
  assert.strictEqual(E.crc32(E.utf8Encode('a')), 0xe8b7be43);
  assert.strictEqual(E.crc32(E.utf8Encode('abc')), 0x352441c2);
  assert.strictEqual(E.crc32(E.utf8Encode('123456789')), 0xcbf43926);
});

test('shapefile ZIP passes the system unzip integrity check and contains every sidecar', () => {
  const { bytes, recordCount } = E.shapefileZipBytes(shapeList(), {
    baseName: 'plots',
    prjWkt: E.prjWktFor({ kind: 'utm', zone: 45, north: true }),
  });
  assert.strictEqual(recordCount, 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-zip-'));
  const zipPath = path.join(dir, 'plots.zip');
  fs.writeFileSync(zipPath, Buffer.from(bytes));
  try {
    // An independent implementation's verdict on our writer.
    execFileSync('unzip', ['-tq', zipPath], { stdio: 'pipe' });
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      .trim().split('\n').sort();
    assert.deepStrictEqual(listing, ['plots.cpg', 'plots.dbf', 'plots.prj', 'plots.shp', 'plots.shx']);

    // Extract and confirm the .shp survived the ZIP byte-for-byte.
    execFileSync('unzip', ['-qo', zipPath, '-d', dir], { stdio: 'pipe' });
    const extracted = new Uint8Array(fs.readFileSync(path.join(dir, 'plots.shp')));
    const direct = E.shapefileFrom(shapeList(), {}).shp;
    assert.strictEqual(extracted.byteLength, direct.byteLength);
    const { records } = parseShp(extracted);
    assert.strictEqual(records.length, 2, 'extracted shapefile must still parse');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KMZ ZIP is readable by the system unzip', () => {
  const kml = E.makeKml(shapeList(), { crsLabel: 'UTM 45N' });
  const bytes = E.makeZipBytes([{ name: 'doc.kml', data: kml }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-kmz-'));
  const p = path.join(dir, 'plots.kmz');
  fs.writeFileSync(p, Buffer.from(bytes));
  try {
    execFileSync('unzip', ['-tq', p], { stdio: 'pipe' });
    const out = execFileSync('unzip', ['-p', p, 'doc.kml'], { encoding: 'utf8' });
    assert.strictEqual(out, kml, 'KML must survive the ZIP unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ZIP handles UTF-8 filenames and non-ASCII content', () => {
  const bytes = E.makeZipBytes([{ name: 'क्षेत्रफल.txt', data: '0 एकड़ 29.65 डिसमिल' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnd-utf8-'));
  const p = path.join(dir, 'u.zip');
  fs.writeFileSync(p, Buffer.from(bytes));
  try {
    execFileSync('unzip', ['-tq', p], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
