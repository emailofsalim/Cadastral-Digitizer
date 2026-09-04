/* =========================================================================
 * Tests for lib/shapefile.js — the ESRI Shapefile READER.
 *
 * The strongest test available here is a round trip, because this project
 * already WRITES shapefiles: geometry is exported by lib/exporters.js and read
 * back by the new reader, and the coordinates must survive unchanged. A reader
 * checked only against fixtures it also generated proves far less — the writer
 * was tested independently, against the system `unzip` and against QGIS's
 * expectations, so agreeing with it is a real constraint.
 *
 * Cadastral magnitudes throughout, for the reason the other suites record: a
 * reader that loses precision looks perfectly correct on small numbers.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const S = require('../lib/shapefile.js');
const E = require('../lib/exporters.js');
const I = require('../lib/importers.js');
const C = require('../lib/crs.js');

const JH = [432500.25, 2618400.75];
const UTM45 = { kind: 'utm', zone: 45, north: true, datum: 'WGS84', epsg: 32645 };

/* A parcel at Jharkhand UTM magnitudes, in the shape the exporters expect. */
function parcel(id, dx, dy, plotNo) {
  const [x, y] = JH;
  return {
    id,
    plotNo: plotNo || null,
    points: [
      [x + dx, y + dy],
      [x + dx + 40, y + dy],
      [x + dx + 40, y + dy + 40],
      [x + dx, y + dy + 40],
    ],
  };
}

/* Export a real shapefile set, then read it back through the ZIP path the
 * import actually uses — including the project's own inflate. */
async function roundTrip(shapes, opts) {
  const built = E.shapefileZipBytes(shapes, Object.assign({ prjWkt: E.prjWktFor(UTM45), baseName: 'parcels' }, opts || {}));
  const zip = I.readZipEntries(new Uint8Array(built.bytes));
  assert.strictEqual(zip.ok, true, 'the exported archive must be readable');
  const entries = [];
  for (const e of zip.entries) {
    if (/\/$/.test(e.name)) continue;
    entries.push({ name: e.name, data: e.method === 8 ? await I.inflateRaw(e.data) : e.data });
  }
  const dataset = S.datasetFromEntries(entries);
  assert.strictEqual(dataset.ok, true, dataset.error);
  return { dataset, result: S.parseShapefile(dataset, { parseEpsg: C.parseEpsg }) };
}

/* =====================================================================
 * ROUND TRIP
 * =================================================================== */

test('a shapefile this project wrote reads back with its coordinates intact', async () => {
  const { result } = await roundTrip([parcel(1, 0, 0), parcel(2, 100, 0)]);
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.rings.length, 2, 'both parcels must come back');

  // Exactly, not approximately. A shapefile stores IEEE doubles, so anything
  // less than exact equality means the reader lost something.
  const got = result.rings[0].points;
  assert.strictEqual(got.length, 4, 'the closing duplicate vertex must not be counted as a corner');
  const xs = got.map((p) => p[0]).sort((a, b) => a - b);
  const ys = got.map((p) => p[1]).sort((a, b) => a - b);
  assert.strictEqual(xs[0], JH[0]);
  assert.strictEqual(ys[0], JH[1]);
  assert.strictEqual(xs[3], JH[0] + 40);
  assert.strictEqual(ys[3], JH[1] + 40);
});

test('the area of a round-tripped parcel is the area it went in with', async () => {
  const { result } = await roundTrip([parcel(1, 0, 0)]);
  const a = Math.abs(S.signedArea(result.rings[0].points));
  assert.ok(Math.abs(a - 1600) < 1e-6, `expected 1600 m², got ${a}`);
});

test('the .prj is read through the caller CRS engine, not a second one', async () => {
  const { result } = await roundTrip([parcel(1, 0, 0)]);
  assert.ok(result.crs, 'a .prj naming UTM 45N should resolve');
  assert.strictEqual(result.crs.epsg, 32645);
  assert.strictEqual(result.crs.zone, 45);
  assert.match(String(result.crsSource), /\.prj/);
});

test('DBF attributes come back, and a plot number is recognised among them', async () => {
  const { result } = await roundTrip([parcel(1, 0, 0, '77/3')]);
  assert.strictEqual(result.rings[0].plotNo, '77/3');
  assert.ok(result.rings[0].attributes, 'the DBF row should travel with the ring');
});

/* =====================================================================
 * THE ENVELOPE — so a shapefile takes the SAME path as every other import
 * =================================================================== */

test('the reader answers with the same envelope every other reader uses', async () => {
  const { result } = await roundTrip([parcel(1, 0, 0)]);
  for (const k of ['ok', 'rings', 'crs', 'skipped', 'warnings']) {
    assert.ok(k in result, `every result must carry ${k}`);
  }
  assert.ok(Array.isArray(result.rings) && Array.isArray(result.skipped) && Array.isArray(result.warnings));
  for (const k of ['points', 'layer', 'plotNo', 'name', 'attributes']) {
    assert.ok(k in result.rings[0], `every ring must carry ${k}`);
  }
});

/* =====================================================================
 * CRS IS NEVER GUESSED
 * =================================================================== */

test('with no .prj the CRS is left null and said so, never assumed', async () => {
  const { dataset } = await roundTrip([parcel(1, 0, 0)]);
  const noPrj = Object.assign({}, dataset, { prj: null });
  const r = S.parseShapefile(noPrj, { parseEpsg: C.parseEpsg });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.crs, null, 'a missing .prj must NOT become WGS 84 by default');
  assert.ok(r.warnings.some((w) => /CRS is undefined/i.test(w)),
    `the operator must be told the CRS is unknown: ${JSON.stringify(r.warnings)}`);
  // And the coordinates are untouched, so the existing "which system?" question
  // can be answered afterwards without anything having been altered.
  assert.strictEqual(r.rings[0].points.map((p) => p[0]).sort((a, b) => a - b)[0], JH[0]);
});

test('an unrecognised .prj is reported rather than quietly ignored', async () => {
  const { dataset } = await roundTrip([parcel(1, 0, 0)]);
  const odd = Object.assign({}, dataset, {
    prj: new TextEncoder().encode('PROJCS["Some_Local_Grid_Nobody_Has_Heard_Of",UNIT["metre",1]]'),
  });
  const r = S.parseShapefile(odd, { parseEpsg: C.parseEpsg });
  assert.strictEqual(r.crs, null);
  assert.ok(r.warnings.some((w) => /does not name a coordinate system/i.test(w)));
});

test('EPSG is taken from the outermost authority, not a nested one', () => {
  // A real .prj nests AUTHORITY on the datum, the spheroid and the unit. Taking
  // the first would resolve a UTM file to whatever its ellipsoid is numbered.
  const wkt = 'PROJCS["WGS_84_UTM_45N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    + 'SPHEROID["WGS_84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],'
    + 'AUTHORITY["EPSG","4326"]],UNIT["Meter",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32645"]]';
  assert.strictEqual(S.epsgFromPrj(wkt), 32645);

  // Where there is no authority at all, the one unambiguous name shape.
  assert.strictEqual(S.epsgFromPrj('PROJCS["WGS_1984_UTM_Zone_45N",UNIT["Meter",1]]'), 32645);
  assert.strictEqual(S.epsgFromPrj('PROJCS["WGS_1984_UTM_Zone_45S",UNIT["Meter",1]]'), 32745);
  assert.strictEqual(S.epsgFromPrj('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]'), 4326);

  // And where it is genuinely unclear, nothing.
  assert.strictEqual(S.epsgFromPrj('PROJCS["Everest_Something",UNIT["Meter",1]]'), null);
  assert.strictEqual(S.epsgFromPrj(''), null);
  assert.strictEqual(S.epsgFromPrj(null), null);
});

/* =====================================================================
 * GEOMETRY THE MODEL CANNOT HOLD IS NAMED, NOT DROPPED
 * =================================================================== */

/* Build a .shp by hand: one polygon record with an outer ring and a hole. */
function polygonWithHole() {
  const outer = [[0, 0], [0, 100], [100, 100], [100, 0], [0, 0]];          // clockwise
  const inner = [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]];        // counter-clockwise
  const pts = outer.concat(inner);
  const content = 44 + 4 * 2 + 16 * pts.length;
  const size = 100 + 8 + content;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setInt32(0, 9994, false);
  v.setInt32(24, size / 2, false);
  v.setInt32(28, 1000, true);
  v.setInt32(32, 5, true);
  v.setInt32(100, 1, false);            // record number
  v.setInt32(104, content / 2, false);  // content length in words
  let p = 108;
  v.setInt32(p, 5, true); p += 4;       // polygon
  for (const n of [0, 0, 100, 100]) { v.setFloat64(p, n, true); p += 8; }
  v.setInt32(p, 2, true); p += 4;       // two parts
  v.setInt32(p, pts.length, true); p += 4;
  v.setInt32(p, 0, true); p += 4;
  v.setInt32(p, outer.length, true); p += 4;
  for (const pt of pts) { v.setFloat64(p, pt[0], true); v.setFloat64(p + 8, pt[1], true); p += 16; }
  return b;
}

test('a hole is reported as skipped, not imported as a solid parcel', () => {
  // The geometry model here is one ring per shape with no holes. Importing the
  // inner ring as its own parcel would put a solid plot inside the plot it was
  // cut out of, and nothing downstream would flag it.
  const r = S.parseShapefile({ shp: polygonWithHole() }, { parseEpsg: C.parseEpsg });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.rings.length, 1, 'only the outer ring becomes a parcel');
  assert.strictEqual(r.rings[0].points.length, 4);
  assert.ok(r.skipped.some((s) => /inner ring/i.test(s.what)),
    `the hole must be named: ${JSON.stringify(r.skipped)}`);
});

test('multi-part polygons become separate parcels rather than one merged ring', () => {
  // Two disjoint clockwise parts in one record — two plots for one record in
  // the DBF. Joining them would draw a boundary across the gap between them.
  const a = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  const bPart = [[50, 0], [50, 10], [60, 10], [60, 0], [50, 0]];
  const pts = a.concat(bPart);
  const content = 44 + 4 * 2 + 16 * pts.length;
  const size = 100 + 8 + content;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setInt32(0, 9994, false); v.setInt32(24, size / 2, false);
  v.setInt32(28, 1000, true); v.setInt32(32, 5, true);
  v.setInt32(100, 1, false); v.setInt32(104, content / 2, false);
  let p = 108;
  v.setInt32(p, 5, true); p += 4;
  for (const n of [0, 0, 60, 10]) { v.setFloat64(p, n, true); p += 8; }
  v.setInt32(p, 2, true); p += 4;
  v.setInt32(p, pts.length, true); p += 4;
  v.setInt32(p, 0, true); p += 4;
  v.setInt32(p, a.length, true); p += 4;
  for (const pt of pts) { v.setFloat64(p, pt[0], true); v.setFloat64(p + 8, pt[1], true); p += 16; }

  const r = S.parseShapefile({ shp: buf }, { parseEpsg: C.parseEpsg });
  assert.strictEqual(r.rings.length, 2, 'the two parts must stay two parcels');
  const firstXs = r.rings[0].points.map((q) => q[0]);
  const secondXs = r.rings[1].points.map((q) => q[0]);
  assert.ok(Math.max(...firstXs) <= 10, 'the parts must not be merged into one ring');
  assert.ok(Math.min(...secondXs) >= 50);
});

/* =====================================================================
 * REFUSALS
 * =================================================================== */

test('an incomplete or unreadable dataset is refused with something actionable', () => {
  const noShp = S.parseShapefile({ dbf: new Uint8Array(40) }, {});
  assert.strictEqual(noShp.ok, false);
  assert.match(noShp.error, /incomplete|no \.shp/i);

  const notShp = S.parseShapefile({ shp: new Uint8Array(200) }, {});
  assert.strictEqual(notShp.ok, false);
  assert.match(notShp.error, /shapefile header/i);

  const tooShort = S.parseShapefile({ shp: new Uint8Array(10) }, {});
  assert.strictEqual(tooShort.ok, false);
  assert.match(tooShort.error, /too short/i);
});

test('a ZIP with no .shp says so rather than failing obscurely', () => {
  const r = S.datasetFromEntries([{ name: 'readme.txt', data: new Uint8Array(4) }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no \.shp/i);
});

test('components are grouped by base name, ignoring macOS resource forks', () => {
  const r = S.datasetFromEntries([
    { name: '__MACOSX/._parcels.shp', data: new Uint8Array(999) },
    { name: 'data/parcels.shp', data: new Uint8Array(10) },
    { name: 'data/parcels.dbf', data: new Uint8Array(3) },
    { name: 'data/parcels.prj', data: new Uint8Array(2) },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'parcels', 'the folder should be stripped from the reported name');
  assert.ok(r.dbf && r.prj);
  assert.strictEqual(r.shp.length, 10, 'the resource fork must not be mistaken for the dataset');
});

test('the largest dataset wins when a ZIP holds several', () => {
  const r = S.datasetFromEntries([
    { name: 'small.shp', data: new Uint8Array(10) },
    { name: 'big.shp', data: new Uint8Array(500) },
  ]);
  assert.strictEqual(r.name, 'big');
  assert.strictEqual(r.others, 1, 'and the operator can be told there were others');
});

/* =====================================================================
 * PRECISION — the failure this project has form for
 * =================================================================== */

test('the winding test does not lose its sign at cadastral magnitudes', () => {
  // Accumulated about the first vertex. Done naively the cross products reach
  // 1e12 while their sum is ~1600, and the answer is noise — which would make
  // outer rings and holes indistinguishable on real coordinates.
  const [x, y] = JH;
  const cw = [[x, y], [x, y + 40], [x + 40, y + 40], [x + 40, y]];
  const ccw = cw.slice().reverse();
  assert.ok(S.signedArea(cw) < 0, 'clockwise must be negative');
  assert.ok(S.signedArea(ccw) > 0, 'counter-clockwise must be positive');
  assert.ok(Math.abs(Math.abs(S.signedArea(cw)) - 1600) < 1e-6);
});
