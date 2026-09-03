/* =========================================================================
 * REQUIREMENTS TRACEABILITY
 *
 * Every requirement defined for this project, asserted against the shipped
 * code. Prose claims in a README rot silently; these do not — if a capability
 * is removed or renamed, this file fails.
 *
 * It is deliberately shallow: each check confirms a capability is present and
 * minimally behaves as described. Depth lives in the dedicated suites. The
 * purpose here is coverage of the requirement list, so nothing quietly goes
 * missing between releases.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));

const Crs = require('../lib/crs.js');
const Gcp = require('../lib/gcp_math.js');
const Tracer = require('../lib/tracer.js');
const Topo = require('../lib/topology.js');
const Exp = require('../lib/exporters.js');
const Adapters = require('../lib/site_adapters.js');
const Viewport = require('../lib/viewport.js');
const Raster = require('../lib/raster_workspace.js');

const PAGE = read('page_inject.js');
const MANIFEST = JSON.parse(read('manifest.json'));
const PKG = JSON.parse(read('package.json'));

const JH = [432500, 2618400];
const ring = (n, r) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    p.push([JH[0] + r * Math.cos(a), JH[1] + r * Math.sin(a)]);
  }
  return p;
};

/* =====================================================================
 * R1 — Repair the v13 GCP feature
 * =================================================================== */

test('R1a: the affine fit is accurate at real UTM magnitudes', () => {
  const src = ring(6, 40);
  const truth = ([x, y]) => [1.0002 * x + 0.0007 * y + 12.5, -0.0005 * x + 0.9998 * y - 8.25];
  const fit = Gcp.fitAffine(src, src.map(truth));
  assert.ok(fit, 'must solve');
  // v13 was wrong by 1187 m on exactly this input.
  assert.ok(Gcp.rmsOf(Gcp.residuals(src, src.map(truth), fit)) < 1e-6);
});

test('R1b: degeneracy is rejected scale-invariantly', () => {
  for (const o of [[0, 0], [432500, 2618400]]) {
    const collinear = [[o[0], o[1]], [o[0] + 40, o[1] + 40], [o[0] + 80, o[1] + 80]];
    assert.strictEqual(Gcp.fitAffine(collinear, collinear), null, `at ${o}`);
  }
});

test('R1c: the getCenter-readback no-op is gone', () => {
  assert.ok(!/confirmCoordinateAtMaxZoom/.test(PAGE) || /REMOVED/.test(PAGE),
    'the v13 helper that returned its own input must not be live');
});

/* =====================================================================
 * R2 — Global CRS support, no silent zone guessing
 * =================================================================== */

test('R2a: every UTM zone and both hemispheres round-trip', () => {
  for (const z of [1, 30, 43, 45, 60]) {
    for (const north of [true, false]) {
      const lon = Crs.utmCentralMeridian(z) + 1;
      const lat = north ? 20 : -20;
      const xy = Crs.utmForward(lon, lat, z, Crs.ELLIPSOIDS.WGS84);
      const ll = Crs.utmInverse(xy[0], xy[1], z, north, Crs.ELLIPSOIDS.WGS84);
      assert.ok(Crs.geodesicDistance(lon, lat, ll[0], ll[1]) < 0.01, `zone ${z}${north ? 'N' : 'S'}`);
    }
  }
});

test('R2b: with no evidence the zone is not invented', () => {
  const r = Crs.detectCrs([[432500, 2618400]], {});
  assert.strictEqual(r.crs, null);
  assert.strictEqual(r.needsConfirmation, true);
  assert.strictEqual(r.candidates.length, 60);
});

test('R2c: Web Mercator, geographic, LCC and Everest are all supported', () => {
  assert.ok(Crs.webMercatorForward && Crs.lccForward && Crs.ELLIPSOIDS.EVEREST_1830);
  assert.strictEqual(Crs.detectCrs([[85.3, 23.3]], {}).crs.kind, 'geographic');
  assert.strictEqual(Crs.detectCrs([[9495000, 2670000]], {}).crs.kind, 'webmercator');
});

/* =====================================================================
 * R3 — Work on any Indian cadastral portal, and worldwide
 * =================================================================== */

test('R3a: four map libraries are supported', () => {
  for (const k of ['openlayers', 'leaflet', 'maplibre', 'google']) {
    assert.ok(Adapters.SIGNATURES[k], `signature for ${k}`);
  }
});

test('R3b: Indian portals resolve their zone from the hostname', () => {
  const cases = [['jharbhunaksha.jharkhand.gov.in', 45], ['apnakhata.rajasthan.gov.in', 43], ['dharitree.assam.gov.in', 46]];
  for (const [host, zone] of cases) {
    assert.strictEqual(Crs.detectCrs([[432500, 2618400]], { host }).crs.zone, zone, host);
  }
});

test('R3c: no standing host permissions are requested', () => {
  assert.strictEqual(MANIFEST.host_permissions, undefined);
  assert.deepStrictEqual(MANIFEST.permissions.slice().sort(), ['activeTab', 'scripting']);
});

/* =====================================================================
 * R4 — Move a control point while zoomed, map stays interactive
 * =================================================================== */

test('R4a: control points are draggable handles, hit-tested and nudgeable', () => {
  assert.match(PAGE, /hitTestGcp/);
  assert.match(PAGE, /ArrowLeft|\/\^Arrow\//, 'arrow-key nudge');
  assert.match(PAGE, /zoomToGcp/);
});

test('R4b: the overlay never takes pointer events', () => {
  assert.match(PAGE, /pointer-events:none/,
    'the overlay must not swallow input, or the map cannot be panned');
});

test('R4c: a tap is an action and a drag is a pan', () => {
  assert.match(PAGE, /TAP_SLOP_PX/);
  assert.match(PAGE, /g\.moved/);
});

/* =====================================================================
 * R5 — Intelligence: model choice, outliers, coverage
 * =================================================================== */

test('R5a: model choice is cross-validated, not guessed', () => {
  const src = ring(10, 60);
  const rec = Gcp.recommendTransform(src.map((p, i) => ({
    vertexIndex: i, rawPoint: p, confirmedPoint: [p[0] + 3, p[1] - 2],
  })));
  assert.strictEqual(rec.validated, true);
  // The data is a pure shift, so the parsimony rule must stop at translation
  // rather than reaching for a model that can also scale and rotate.
  assert.strictEqual(rec.recommended, 'translation', rec.reason);
  assert.ok(rec.table.every((r) => 'looRms' in r));
});

test('R5b: a blunder is detected and down-weighted', () => {
  const src = ring(8, 60);
  const tgt = src.map(([x, y]) => [x + 3, y - 2]);
  tgt[5] = [tgt[5][0] + 25, tgt[5][1] + 18];
  const r = Gcp.fitRobust(src.map((p, i) => ({ vertexIndex: i, rawPoint: p, confirmedPoint: tgt[i] })), 'similarity', { seed: 1 });
  assert.ok(r.outliers.includes(5));
});

test('R5c: five transform models are available', () => {
  for (const k of ['translation', 'similarity', 'affine', 'projective', 'tps']) {
    assert.ok(Gcp.MODELS[k], k);
  }
});

test('R5d: coverage reports spread per shape, not just a count', () => {
  assert.strictEqual(Gcp.describeGcpSpread([
    { source: [JH[0], JH[1]] }, { source: [JH[0] + 20, JH[1] + 0.05] }, { source: [JH[0] + 40, JH[1] + 0.1] },
  ]).quality, 'collinear');
});

/* =====================================================================
 * R6 — Explicit vertex pairing with automatic coordinate capture
 * =================================================================== */

test('R6a: a control point is paired to a chosen vertex index', () => {
  const shape = { id: 3, points: ring(6, 40) };
  const r = Gcp.makeGcpFromVertex(shape, 4, [JH[0] + 5, JH[1]]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.gcp.vertexIndex, 4);
  assert.deepStrictEqual(r.gcp.source, shape.points[4]);
  assert.strictEqual(Gcp.makeGcpFromVertex(shape, 99, [0, 0]).ok, false);
});

test('R6b: the workflow is two-step and the capture is echoed numerically', () => {
  assert.match(PAGE, /gcpStage/);
  assert.match(PAGE, /captureGcpTarget/);
  assert.match(PAGE, /lastCapture/);
  assert.match(PAGE, /lon\/lat/, 'the captured coordinate is shown in lon/lat too');
});

test('R6c: a vertex can also be chosen by index from the panel', () => {
  assert.match(PAGE, /vertexPick/);
});

/* =====================================================================
 * R7 — See the corrected shape before committing
 * =================================================================== */

test('R7: the corrected geometry can be previewed without mutating it', () => {
  const shapes = [{ id: 1, points: ring(5, 30) }];
  const before = JSON.stringify(shapes);
  const preview = Gcp.previewCorrected(shapes, { apply: (p) => [p[0] + 9, p[1]] });
  assert.strictEqual(JSON.stringify(shapes), before, 'must not mutate');
  assert.ok(Math.abs(preview[0].points[0][0] - (shapes[0].points[0][0] + 9)) < 1e-9);
  assert.match(PAGE, /showPreview/);
});

/* =====================================================================
 * R8 — Do not leak clicks to the host site
 * =================================================================== */

test('R8: consumed taps are stopped before the portal sees them', () => {
  assert.match(PAGE, /swallowSyntheticClick/);
  assert.match(PAGE, /stopImmediatePropagation/);
  // Cancelling pointerup alone is not enough: portals listen on click.
  for (const type of ['click', 'mouseup', 'dblclick', 'contextmenu']) {
    assert.match(PAGE, new RegExp(`'${type}'`), `${type} must be covered`);
  }
  assert.match(PAGE, /blockSiteClicks/, 'and it must be switchable');
});

/* =====================================================================
 * R9 — Sensible defaults, manual zoom
 * =================================================================== */

test('R9a: auto-zoom is off; zooming is an explicit action', () => {
  assert.match(PAGE, /precisionZoomBoost: 0/);
  assert.match(PAGE, /zoomToPoint/);
  assert.match(PAGE, /id="zoomIn"/);
});

test('R9b: protective defaults are on, intrusive ones are off', () => {
  const block = PAGE.match(/const DEFAULT_SETTINGS = \{([\s\S]*?)\n  \};/)[1];
  const val = (k) => (block.match(new RegExp(k + ':\\s*([^,\\n]+)')) || [])[1];
  for (const k of ['snapEnabled', 'robustFitting', 'autoRecommend', 'blockSiteClicks', 'liveRefit']) {
    assert.strictEqual(val(k), 'true', `${k} should default on`);
  }
  assert.strictEqual(val('autoRegulariseOnTrace'), 'false', 'must not alter geometry unasked');
});

/* =====================================================================
 * R10 — Powerful export set
 * =================================================================== */

test('R10a: seven export formats plus project save', () => {
  for (const fn of ['makeDxf', 'makeKml', 'makeGeoJson', 'shapefileZipBytes', 'makeWkt', 'makeVertexCsv', 'makeAreaReportCsv']) {
    assert.strictEqual(typeof Exp[fn], 'function', fn);
  }
  assert.match(PAGE, /project\(\)/);
});

test('R10b: injection through exported text is escaped', () => {
  const shapes = [{ id: 1, points: ring(4, 20), plotNo: '1 & 2 <x>' }];
  const kml = Exp.makeKml(shapes, {});
  assert.ok(kml.includes('&amp;') && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(kml));
  assert.strictEqual(Exp.escapeCsv('=1+1'), "'=1+1");
});

test('R10c: shapefile is a full bundle with a .prj', () => {
  const sf = Exp.shapefileFrom([{ id: 1, points: ring(4, 20), plotNo: 'x' }], {});
  assert.ok(sf.shp && sf.shx && sf.dbf);
  assert.match(Exp.prjWktFor({ kind: 'utm', zone: 45, north: true }), /UTM zone 45N/);
});

test('R10d: winding conventions differ correctly between formats', () => {
  const shapes = [{ id: 1, points: ring(4, 20) }];
  assert.ok(Exp.isCounterClockwise(Exp.makeGeoJson(shapes, {}).features[0].geometry.coordinates[0]),
    'GeoJSON exteriors are counter-clockwise');
  // Shapefile outer rings are clockwise; the opposite would mean "hole".
  assert.ok(!Exp.isCounterClockwise(Exp.ensureWinding(ring(4, 20), false)));
});

test('R10e: control points are portable', () => {
  const text = Exp.makeGcpPointsFile([{ rawPoint: [1, 2], confirmedPoint: [3, 4] }], { crsLabel: 'UTM 45N' });
  assert.strictEqual(Exp.parseGcpPointsFile(text).pairs.length, 1);
});

/* =====================================================================
 * R11 — Batch vectorisation
 * =================================================================== */

test('R11: a whole view can be vectorised at once', () => {
  assert.strictEqual(typeof Tracer.findAllRegions, 'function');
  assert.strictEqual(typeof Tracer.labelRegions, 'function');
  assert.match(PAGE, /autoTraceVisible/);
});

/* =====================================================================
 * R12 — Topology and clean-up
 * =================================================================== */

test('R12a: regularise recovers a rectangle and refuses non-rectilinear shapes', () => {
  const wobbly = [];
  for (let x = 0; x < 40; x += 2) wobbly.push([x, (x / 2) % 2 ? 0.4 : 0]);
  for (let y = 0; y < 25; y += 2) wobbly.push([40, y]);
  for (let x = 40; x > 0; x -= 2) wobbly.push([x, 25]);
  for (let y = 25; y > 0; y -= 2) wobbly.push([0, y]);
  const r = Topo.regularise(wobbly, { angleToleranceDeg: 20, collinearTolerance: 0.6 });
  assert.strictEqual(r.ring.length, 4, `expected 4 corners, got ${r.ring.length}`);

  const circle = [];
  for (let i = 0; i < 24; i++) circle.push([20 * Math.cos(i / 24 * 2 * Math.PI), 20 * Math.sin(i / 24 * 2 * Math.PI)]);
  assert.strictEqual(Topo.squareUp(circle, {}).applied, false);
});

test('R12b: shared edges snap exactly, and exact sharing is not an overlap', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(Topo.ringsOverlap(a, [[10, 0], [20, 0], [20, 10], [10, 10]]), false);
  const dirty = [{ id: 1, points: a }, { id: 2, points: [[10.08, 0], [20, 0], [20, 10], [10.08, 10]] }];
  assert.ok(Topo.findUnsnapped(dirty, 0.5).length > 0);
  assert.deepStrictEqual(Topo.findUnsnapped(Topo.snapAllToNeighbours(dirty, 0.5).shapes, 0.5), []);
});

test('R12c: quality scores are itemised and add up', () => {
  const s = Topo.scoreShape({ id: 1, points: [[0, 0], [10, 0], [10, 10], [0, 10]], validity: { valid: true, problems: [] }, areaDiffPct: 12 }, {});
  const total = s.findings.filter((f) => f.points > 0).reduce((a, f) => a + f.points, 0);
  assert.strictEqual(s.score, Math.max(0, 100 - total));
});

/* =====================================================================
 * R13 — Images, scanned sheets and PDFs
 * =================================================================== */

test('R13a: a static raster is offered through the same adapter contract', () => {
  assert.strictEqual(typeof Raster.createRasterWorkspace, 'function');
  assert.strictEqual(typeof Viewport.createViewport, 'function');
  assert.match(PAGE, /openWorkspace/);
  for (const id of ['wsFile', 'wsCapture', 'wsPage']) {
    assert.match(PAGE, new RegExp(`id="${id}"`), id);
  }
});

test('R13b: PDFs are handled by tab capture, end to end', () => {
  assert.match(read('background.js'), /captureVisibleTab/);
  assert.match(read('content.js'), /BND15_CAPTURE_REQ/);
  assert.match(PAGE, /requestTabCapture/);
  assert.strictEqual(Raster.looksLikePdf({ contentType: '', querySelector: () => null }, { location: { href: 'https://x/y.pdf' } }), true);
});

test('R13c: an ungeoreferenced image reports pixels, not fabricated metres', () => {
  assert.match(PAGE, /px²/);
  assert.match(PAGE, /NOT georeferenced/);
});

test('R13d: georeferencing reuses the tested fitting machinery', () => {
  assert.match(PAGE, /addGeorefPoint/);
  assert.match(PAGE, /recomputeGeoref/);
  assert.match(PAGE, /GcpMath\.fitGcpTransform\(pairs, type/, 'pixel->world uses the same solver');
});

/* =====================================================================
 * R14 — Areas honest about grid, ground and geodesic
 * =================================================================== */

test('R14: three area measures, and the scale correction points the right way', () => {
  const sq = [[0, 0], [40, 0], [40, 30], [0, 30]];
  assert.strictEqual(Exp.gridArea(sq), 1200);
  assert.ok(Exp.groundAreaFromGrid(sq, 0.9996) > 1200, 'k<1 means ground exceeds grid');
  // Local curvature, not a global mean radius.
  assert.ok(Math.abs(Exp.gaussianRadiusAt(23.67 * Math.PI / 180) - Exp.AUTHALIC_R) > 5000);
});

/* =====================================================================
 * R15 — Licence and authorship
 * =================================================================== */

test('R15: MIT licence and authorship, in every surface', () => {
  assert.ok(exists('LICENSE'));
  const lic = read('LICENSE');
  assert.match(lic, /MIT License/);
  assert.match(lic, /Md Salim Ansari/);
  assert.strictEqual(MANIFEST.author, 'Md Salim Ansari');
  assert.strictEqual(PKG.author, 'Md Salim Ansari');
  assert.strictEqual(PKG.license, 'MIT');
  assert.match(PAGE, /Md Salim Ansari/);
  assert.match(read('popup.html'), /Md Salim Ansari/);
  assert.match(read('README.md'), /Md Salim Ansari/);
});

/* =====================================================================
 * R16 — Packaging integrity
 * =================================================================== */

test('R16a: every file the manifest and injector reference exists', () => {
  const bg = read('background.js');
  const injected = [...bg.match(/MAIN_WORLD_FILES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const refs = [MANIFEST.background.service_worker, MANIFEST.action.default_popup, 'popup.js', 'content.js',
    ...Object.values(MANIFEST.icons), ...injected];
  for (const f of refs) assert.ok(exists(f), `missing ${f}`);
});

test('R16b: page_inject requires exactly the globals the libraries provide', () => {
  const needs = [...new Set([...PAGE.matchAll(/window\.(BND_\w+)/g)].map((m) => m[1]))].sort();
  const has = fs.readdirSync(path.join(ROOT, 'lib'))
    .map((f) => (read(`lib/${f}`).match(/root\.(BND_\w+)\s*=/) || [])[1]).filter(Boolean).sort();
  assert.deepStrictEqual(needs.filter((n) => !has.includes(n)), [], 'unsatisfied globals');
});

test('R16c: libraries are injected before the script that reads them', () => {
  const bg = read('background.js');
  const injected = [...bg.match(/MAIN_WORLD_FILES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(injected[injected.length - 1], 'page_inject.js',
    'page_inject reads the globals at evaluation time, so it must be last');
  assert.ok(injected.slice(0, -1).every((f) => f.startsWith('lib/')));
});

test('R16e: the version is identical everywhere it is stated', () => {
  // Four files state the version independently, and they had already drifted
  // once (package.json ahead of the rest). A user reading the popup should not
  // be told a different version from the one Chrome reports.
  const pi = (PAGE.match(/VERSION = '([^']*)'/) || [])[1];
  const po = (read('popup.html').match(/v(\d+\.\d+\.\d+)/) || [])[1];
  const stated = { manifest: MANIFEST.version, package: PKG.version, page_inject: pi, popup: po };
  for (const [where, v] of Object.entries(stated)) {
    assert.ok(/^\d+\.\d+\.\d+$/.test(v || ''), `${where} has no usable version: ${v}`);
  }
  assert.strictEqual(new Set(Object.values(stated)).size, 1,
    `versions disagree: ${JSON.stringify(stated)}`);
});

test('R16f: the README does not claim a test count it cannot back up', () => {
  // The README has quoted a stale figure before. Compare its claim against the
  // number of test() calls actually present.
  const readme = read('README.md');
  const claimed = [...readme.matchAll(/(\d{3}) tests/g)].map((m) => Number(m[1]));
  assert.ok(claimed.length > 0, 'the README should state how many tests there are');
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js'));
  let actual = 0;
  for (const f of files) {
    actual += (read(`test/${f}`).match(/^\s*t?\(?test\(|^t\(/gm) || []).length;
  }
  // Counted loosely, so allow a small margin; the point is catching a figure
  // that has fallen badly out of date, not policing an exact tally.
  for (const c of new Set(claimed)) {
    assert.ok(Math.abs(c - actual) <= 25,
      `README claims ${c} tests but roughly ${actual} are declared — update it`);
  }
});

test('R16d: the extension itself has no runtime dependencies', () => {
  assert.ok(!PKG.dependencies, 'no runtime dependencies');
  // jsdom is dev-only and optional; the suite must run without it.
  assert.ok(PKG.devDependencies && PKG.devDependencies.jsdom);
  assert.match(read('test/browser_integration.test.js'), /test\.skip/,
    'the browser tests must skip gracefully when jsdom is absent');
});


/* =====================================================================
 * R17 — Field-reported defects, v16.2 -> v16.3
 *
 * Each of these traces to something an operator hit in real use. They are kept
 * together so the release that fixed them cannot regress silently.
 * =================================================================== */

test('R17a: a correction is consumed on apply, so a second press cannot double-shift', () => {
  // A control point asserts "the geometry claims A, the truth is B". Once the
  // shape has been moved, its corner IS at B; leaving the stale claim on file
  // meant the next press applied the same shift again.
  assert.match(PAGE, /g\.source = fit\.apply\(g\.source\)/,
    'applying a correction must advance the control-point sources through it');
  assert.match(PAGE, /CONSUME THE CORRECTION/,
    'and the reason must be recorded where the next reader will find it');
});

test('R17b: there is exactly one session-reset routine, and every reset path uses it', () => {
  // Three ad-hoc reset lines each cleared a different subset of the state, which
  // is why control points survived a "clear everything".
  assert.match(PAGE, /function clearSessionState\(/, 'a single reset routine must exist');
  const calls = (PAGE.match(/clearSessionState\(/g) || []).length;
  assert.ok(calls >= 4, `expected every reset path to call it, found ${calls} references`);
  // And no path may go back to wiping shapes by hand.
  const adhoc = PAGE.match(/st\.shapes = \[\];\s*st\.gcps = \[\]/g) || [];
  assert.strictEqual(adhoc.length, 0,
    'no reset may open-code the field list again; that is how fields get forgotten');

  for (const field of ['st.gcps = []', 'st.backups = {}', 'st.georefPoints = []',
    'st.lastCapture = null', 'st.gcpSelection = null', 'st.quality = null']) {
    assert.ok(clearBody().includes(field), `a full reset must clear ${field}`);
  }
});

function clearBody() {
  const i = PAGE.indexOf('function clearSessionState(');
  assert.ok(i > 0);
  return PAGE.slice(i, PAGE.indexOf('\n  }', i));
}

test('R17c: undo and redo cover whole operations, not only drawn corners', () => {
  const H = require('../lib/history.js');
  const state = { doc: { shapes: [{ id: 1, points: [[0, 0]] }] } };
  const h = H.createHistory({ read: () => state.doc, write: (d) => { state.doc = d; } });
  h.commit('delete shape 1');
  state.doc.shapes = [];
  assert.strictEqual(h.undo(), 'delete shape 1');
  assert.strictEqual(state.doc.shapes.length, 1);

  // Every destructive operation in the app must record a step.
  for (const op of ['apply ', 'regularise ', 'delete shape ', 'snap shared corners',
    'move a vertex', 'clear ', 'revert shape ']) {
    assert.ok(PAGE.includes(`commit(\`${op}`) || PAGE.includes(`commit('${op}`),
      `no undo step is recorded for "${op}"`);
  }
  // And the shortcut must not be confined to draw mode any more.
  assert.match(PAGE, /if \(st\.mode === 'draw' && st\.drawUndo\.length\) undoDraw\(\); else undoAction\(\)/,
    'Ctrl+Z must fall through to the session-wide undo outside draw mode');
});

test('R17d: editing a vertex records the move as georeferencing evidence', () => {
  assert.match(PAGE, /function noteVertexMoved\(/);
  assert.match(PAGE, /autoGcpFromEdit: true/, 'and it must be on by default');
  // The source must be where the corner WAS, or the control point records a zero
  // shift and teaches the fit nothing.
  assert.match(PAGE, /source: origin\.slice\(\)/,
    'the control point must record the pre-drag position as its source');
});

test('R17e: a shared corner moves every parcel that meets there', () => {
  const shapes = [
    { id: 1, points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { id: 2, points: [[10, 0], [20, 0], [20, 10], [10, 10]] },
    { id: 3, points: [[10, 10], [20, 10], [20, 20], [10, 20]] },
  ];
  const hits = Topo.findCoincidentVertices(shapes, [10, 10], 0.5, 1);
  assert.ok(hits.length >= 2, 'both neighbours at that corner must be found');
  assert.match(PAGE, /function keepNeighboursConsistent\(/);
  assert.match(PAGE, /dragSharedCorners: true/, 'and it must be on by default');
});

test('R17f: an overlap that an operation created is distinguished from one already there', () => {
  const before = Topo.crossingPairs([
    { id: 1, points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { id: 2, points: [[8, 0], [18, 0], [18, 10], [8, 10]] },
  ]);
  assert.strictEqual(before.size, 1, 'the pre-existing overlap must be seen');
  const after = Topo.crossingPairs([
    { id: 1, points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { id: 2, points: [[8, 0], [18, 0], [18, 10], [8, 10]] },
    { id: 3, points: [[0, 8], [6, 8], [6, 18], [0, 18]] },
  ]);
  assert.deepStrictEqual(Topo.newCrossings(before, after), ['1|3'],
    'only the newly created overlap is the operation\'s fault');
  assert.match(PAGE, /function reportNewCrossings\(/);
});

test('R17g: Apply states its effect in metres before doing anything', () => {
  assert.match(PAGE, /function describeApply\(/);
  assert.match(PAGE, /if \(!confirm\(preview\.prompt\)\) return/,
    'the preview must be a precondition, not a notification afterwards');
  assert.match(PAGE, /Furthest move/, 'the distance must be quoted');
  assert.match(PAGE, /Shape change/, 'and so must the distortion');
});

test('R17h: the apply buttons name their scope instead of saying "all"', () => {
  assert.ok(!/Apply to tagged shapes/.test(PAGE),
    'the old ambiguous label must be gone');
  assert.ok(!/>Apply to all</.test(PAGE), 'and so must "Apply to all"');
  assert.match(PAGE, /Move \$\{taggedShapeCount\(\)\} tagged shape/);
  assert.match(PAGE, /Move all \$\{st\.shapes\.length\} shape/);
});

test('R17i: the panel states the whole workflow, marking correction optional', () => {
  assert.match(PAGE, /function workflowHtml\(/);
  for (const stage of ['Digitise the parcels', 'Correct the position', 'Check and export']) {
    assert.ok(PAGE.includes(stage), `the guide must name "${stage}"`);
  }
  assert.match(PAGE, /optional: true/,
    'georeferencing is not part of every job and must not be presented as such');
});

test('R17j: one control point is enough for a shift, and the model is chosen for it', () => {
  const one = [{ vertexIndex: 0, rawPoint: JH, confirmedPoint: [JH[0] + 3, JH[1] - 2] }];
  const rec = Gcp.recommendTransform(one);
  assert.strictEqual(rec.recommended, 'translation',
    'with a single point only a shift is solvable, and it must be offered');
  assert.strictEqual(rec.validated, false, 'while being honest that nothing was checked');
  const fit = Gcp.fitGcpTransform(one, 'translation');
  assert.strictEqual(fit.ok, true);
  assert.strictEqual(Gcp.describeFitMagnitude(fit.fit, 500).distortionAtRadius, 0);
  assert.match(PAGE, /if \(pairs\.length < 1\)/, 'the app must fit from one point too');
});

test('R17k: a control point survives its shape being re-cornered, or is dropped', () => {
  assert.match(PAGE, /function shiftGcpVertexIndices\(/,
    'inserting a vertex must renumber the control points after it');
  assert.match(PAGE, /function dropGcpsForVertexRemoval\(/,
    'and deleting one must not leave a control point pointing at a different corner');
  assert.match(PAGE, /shiftGcpVertexIndices\(shape\.id, ins\.after \+ 1, 1\)/);
  assert.match(PAGE, /dropGcpsForVertexRemoval\(shape\.id, hit\.index\)/);
});

test('R17l: an axis-aligned band overlap is detected', () => {
  // Every vertex lies on the other ring's boundary, so a vertex-only test misses
  // it. Axis-aligned parcels are the common case, not an edge case.
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(Topo.ringsOverlap(a, [[8, 0], [18, 0], [18, 10], [8, 10]]), true);
  assert.strictEqual(Topo.ringsOverlap(a, [[10, 0], [20, 0], [20, 10], [10, 10]]), false,
    'while an exactly shared edge remains correct topology');
});

test('R17m: the browser harness cannot disagree with the extension about its own files', () => {
  // A hand-typed copy of the file list in the test harness went stale and made
  // every DOM test fail with an unrelated message.
  const harness = read('test/browser_integration.test.js');
  assert.match(harness, /MAIN_WORLD_FILES/,
    'the harness must read the real file list from background.js');
  const bg = read('background.js');
  for (const lib of ['lib/history.js', 'lib/gcp_math.js', 'lib/topology.js']) {
    assert.ok(bg.includes(`'${lib}'`), `${lib} must be injected by background.js`);
  }
});


test('R17n: the panel reads fields that describeFitMagnitude actually returns', () => {
  // A "shiftMeters"/"shiftMetres" mismatch silently degraded the fit card to a
  // vaguer sentence instead of the figure. Spelling drift between a library and
  // its only caller is invisible at runtime, so it is checked here.
  const mag = Gcp.describeFitMagnitude(
    Gcp.fitGcpTransform([{ vertexIndex: 0, rawPoint: JH, confirmedPoint: [JH[0] + 3, JH[1] - 4] }],
      'translation').fit, 100);
  const used = new Set();
  for (const m of PAGE.matchAll(/\bmag\.(\w+)/g)) used.add(m[1]);
  assert.ok(used.size > 0, 'the panel should be reading the magnitude description');
  for (const key of used) {
    assert.ok(key in mag, `the panel reads mag.${key}, which describeFitMagnitude does not return`);
  }
  assert.strictEqual(mag.shiftMetres, 5, 'a 3-4-5 shift should measure 5 m');
});


test('R17o: every setting is either reachable from the UI or declared internal', () => {
  // Three settings added in 16.3 had a default and behaviour but no control and
  // no change handler, while the README told the operator to switch one of them
  // off "under Settings". A setting nobody can reach is not a setting, and a
  // README that describes one is worse than silence.
  //
  // The allowlist is the point of this test: adding a setting with no UI is
  // allowed, but it has to be an explicit decision recorded here rather than an
  // oversight nobody notices.
  const NO_UI_BY_DESIGN = {
    regionSizes: 'internal ladder of trace window sizes, tried in order; not a dial',
    vertexGrabPx: 'a second grab radius alongside gcpGrabPx would be a distinction without a difference',
  };

  const block = PAGE.match(/DEFAULT_SETTINGS\s*=\s*\{([\s\S]*?)\n {2}\};/);
  assert.ok(block, 'DEFAULT_SETTINGS must be findable');
  const keys = [...block[1].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 20, `expected the full settings list, found ${keys.length}`);

  // A setting nothing READS is worse than one nothing can change: it is a
  // promise of control over behaviour that does not exist. showValidityWarnings
  // was exactly that, and it sat in the defaults for several releases.
  const dead = keys.filter((key) => {
    const reads = (PAGE.match(new RegExp(`S\\.${key}\\b`, 'g')) || []).length;
    // One occurrence is the default declaration itself.
    return reads <= 1 && !new RegExp(`bind\\(\\s*'[^']+'\\s*,\\s*'${key}'`).test(PAGE);
  });
  assert.deepStrictEqual(dead, [],
    `these settings are declared but never read — they promise control over nothing: ${dead.join(', ')}`);

  const unreachable = [];
  for (const key of keys) {
    if (key in NO_UI_BY_DESIGN) continue;
    // Reachable means something can write it: either a hand-written change
    // handler (`S.key = ...`) or the bind() helper used for numeric fields.
    const written = new RegExp(`S\\.${key}\\s*=`).test(PAGE)
      || new RegExp(`bind\\(\\s*'[^']+'\\s*,\\s*'${key}'`).test(PAGE);
    if (!written) unreachable.push(key);
  }
  assert.deepStrictEqual(unreachable, [],
    `these settings have no way to change them and are not on the by-design list: ${unreachable.join(', ')}`);

  // And the three from 16.3 specifically must have a control, not just a handler.
  for (const [key, id] of [['autoGcpFromEdit', 'sAutoGcp'], ['dragSharedCorners', 'sShared'],
    ['warnNewCrossings', 'sWarnCross']]) {
    assert.ok(PAGE.includes(`id="${id}"`), `${key} needs a control (#${id})`);
    assert.ok(PAGE.includes(`on('${id}', 'onchange'`), `${key} needs a change handler`);
    assert.ok(new RegExp(`S\\.${key} = e\\.target\\.checked`).test(PAGE),
      `#${id} must write S.${key}`);
  }
});

test('R17p: the README only promises settings that exist', () => {
  // "Switch it off under Settings" was true of nothing at the time it was
  // written. Every settings label the README names must appear in the panel.
  const readme = read('README.md');
  const named = ['Snap while drawing', 'Auto-zoom before trace'];
  for (const label of named) {
    if (!readme.includes(label)) continue;
    assert.ok(PAGE.includes(label), `README names the setting "${label}", which the panel does not have`);
  }
  // And where it says a behaviour can be switched off, a control must exist.
  if (/Switch it off under Settings/.test(readme)) {
    assert.ok(PAGE.includes('id="sAutoGcp"'),
      'the README says auto-GCP can be switched off, so the control must be there');
  }
});


test('R17q: a flood fill that escaped the selected parcel is detected and reported', () => {
  // bboxLeakWarnPct sat in the defaults for several releases with nothing reading
  // it. The portal hands us the bounding box of the parcel that was clicked, so a
  // trace reaching well beyond it is a leak that can be measured rather than
  // guessed at — and a leaked trace is still a closed ring with a plausible area,
  // so nothing else would have noticed.
  const box = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
  const clean = Topo.bboxLeakage([[1, 1], [9, 1], [9, 9], [1, 9]], box);
  assert.ok(clean.leakedPct < 1, `a contained trace should read ~0%, got ${clean.leakedPct}`);

  const leaked = Topo.bboxLeakage([[0, 0], [30, 0], [30, 10], [0, 10]], box);
  assert.ok(leaked.leakedPct > 60, `two neighbours swallowed should read high, got ${leaked.leakedPct}`);
  assert.strictEqual(leaked.exact, false, 'the estimate must not claim exactness');

  assert.match(PAGE, /function warnIfTraceLeaked\(/, 'the trace path must run the check');
  assert.match(PAGE, /warnIfTraceLeaked\(shape\)/, 'and actually call it after tracing');
  assert.match(PAGE, /Number\(S\.bboxLeakWarnPct\)/, 'gated on the setting, which must now be read');
  assert.ok(PAGE.includes('id="sLeakPct"'), 'and the threshold needs a control');
});


test('R17r: every operation that mutates the session records an undo step', () => {
  // Undo coverage cannot be asserted by listing the operations I remembered — that
  // is the same list that missed georeference points and both file loaders on the
  // first pass, even though georefPoints was already in the undo document, which
  // is worse than not covering it at all.
  //
  // So this works the other way round: find every line that mutates the undoable
  // document, and require a commit() within the enclosing function above it.
  const lines = PAGE.split('\n');
  const MUTATES = [
    /\bst\.shapes\.push\(/, /\bst\.shapes\.pop\(/, /\bst\.shapes = st\.shapes\.filter\(/,
    /\bst\.gcps\.push\(/, /\bst\.gcps = st\.gcps\.filter\(/,
    /\bst\.georefPoints\.push\(/, /\bst\.georefPoints = st\.georefPoints\.filter\(/,
    /\bshape\.points\.splice\(/, /\bshape\.points = /,
    /\brestoreSession\(data\)/,
  ];
  // Lines inside these functions are not user operations: they are the undo
  // machinery itself, the reset routine, and index bookkeeping called BY an
  // operation that has already committed.
  const EXEMPT_FUNCTIONS = [
    'function clearSessionState(', 'function restoreSession(', 'function serialiseSession(',
    'function dropGcpsForVertexRemoval(', 'function shiftGcpVertexIndices(',
    'function loadAutosave(', 'function boot(',
    // Called from a vertex drag that already committed at pointer-DOWN, because
    // the pre-drag position has to be captured before the drag moves it. A second
    // commit here would make one drag take two presses of Ctrl+Z to undo.
    'function noteVertexMoved(', 'function keepNeighboursConsistent(',
    // Same reasoning, for the whole-parcel move added in 17.0: onPointerDown
    // commits before the drag begins, so the pre-drag ring is the one restored.
    // onPointerMove then repaints the parcel every frame from that ring.
    'function onPointerMove(',
    // The shared helper behind move/rotate/scale. Every caller commits first —
    // which the test below asserts rather than taking on trust, so this
    // exemption cannot become a hole if a future caller forgets.
    'function applyShiftToShape(',
  ];

  const enclosing = (idx) => {
    for (let i = idx; i >= 0; i--) {
      const m = lines[i].match(/^\s*(?:function (\w+)\(|(?:on|const)\s*\(?['"]?(\w+))/);
      if (m && /^\s{0,4}function /.test(lines[i])) return { name: lines[i].trim(), start: i };
    }
    return { name: '<top level>', start: 0 };
  };

  const gaps = [];
  lines.forEach((line, i) => {
    if (!MUTATES.some((re) => re.test(line))) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;                 // a comment mentioning it
    const fn = enclosing(i);
    if (EXEMPT_FUNCTIONS.some((f) => fn.name.startsWith(f.replace('function ', 'function ')))) return;
    // Look back for a commit() between the function start and this mutation, or
    // within a short window for handlers defined inline.
    const from = Math.max(fn.start, i - 40);
    const window = lines.slice(from, i + 1).join('\n');
    if (!/\bcommit\(/.test(window)) {
      gaps.push(`line ${i + 1} in ${fn.name.slice(0, 60)}: ${line.trim().slice(0, 70)}`);
    }
  });

  assert.deepStrictEqual(gaps, [],
    `these mutations have no undo step:\n  ${gaps.join('\n  ')}`);
});

test('R17r2: the exempted shift helper is only ever called after a commit', () => {
  // applyShiftToShape is exempted from the sweep above because its callers
  // commit. That is only true while it stays true, so it is checked rather than
  // asserted in a comment: every call site must have a commit() above it within
  // the same function.
  const lines = PAGE.split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    if (!/^\s*applyShiftToShape\(/.test(line)) return;
    let start = 0;
    for (let j = i; j >= 0; j--) {
      if (/^\s{0,4}function /.test(lines[j])) { start = j; break; }
    }
    const window = lines.slice(start, i).join('\n');
    if (!/\bcommit\(/.test(window)) bad.push(`line ${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(bad, [],
    `applyShiftToShape must only be reached from an operation that has already committed:\n  ${bad.join('\n  ')}`);
  // And the drag path must commit at pointer-down, for the same reason the
  // vertex drag does: the pre-drag ring is what undo has to restore.
  assert.match(PAGE, /commit\(`move shape \$\{shape\.id\}`\)/,
    'the whole-parcel drag must commit before it starts moving anything');
});

test('R17s: the undo document covers every field a mutation touches', () => {
  // georefPoints was in the undo document while nothing that changed it recorded a
  // step, so an unrelated undo could silently revert georeferencing work. The two
  // lists have to agree.
  const keys = (PAGE.match(/const UNDOABLE_KEYS = \[([\s\S]*?)\];/) || [])[1];
  assert.ok(keys, 'UNDOABLE_KEYS must be declared');
  for (const field of ['shapes', 'gcps', 'backups', 'georefPoints', 'georef']) {
    assert.ok(keys.includes(`'${field}'`), `${field} must be part of the undoable document`);
  }
  // Counters must travel with the things they number, or undo reuses an id.
  for (const counter of ['nextShapeId', 'nextGcpId', 'nextGeorefId']) {
    assert.ok(keys.includes(`'${counter}'`),
      `${counter} must be undone too, or a restored shape collides with a new one`);
  }
});


test('R17t: a leak is measured and recorded independently of whether it was warned about', () => {
  // The toast threshold and the quality thresholds are separate judgements. If the
  // measurement were only stored when the toast fired, turning the warning off — or
  // setting it above the quality report's own 5% and 25% bands — would silently
  // blind the report to leaks it grades on.
  const src = PAGE.slice(PAGE.indexOf('function warnIfTraceLeaked('));
  const body = src.slice(0, src.indexOf('\n  }'));
  const recordAt = body.indexOf('shape.leak = leak');
  const gateAt = body.indexOf('S.bboxLeakWarnPct');
  assert.ok(recordAt > 0, 'the measurement must be stored on the shape');
  assert.ok(gateAt > 0, 'and the toast must be gated on the setting');
  assert.ok(recordAt < gateAt,
    'the measurement must be recorded BEFORE the warning threshold is consulted');

  // And the scorer must grade on it.
  const graded = Topo.scoreShape({
    id: 1, points: [[0, 0], [10, 0], [10, 10], [0, 10]],
    validity: { valid: true, problems: [] }, leak: { leakedPct: 62 },
  }, {});
  assert.ok(graded.findings.some((f) => f.code === 'bbox-leak' && f.severity === 'error'),
    'a heavily leaked trace must be graded as an error');
});


test('R17u: a leak reading is dropped once the geometry it described has moved', () => {
  // The reading compares the ring against the bounding box the portal reported at
  // trace time. After a GCP correction the shape has deliberately moved out of that
  // frame, so the figure no longer means anything — and because it grades as an
  // ERROR in the quality report, a stale one would condemn work that is now
  // correct. This is the same rule the code already applies to a quality grade.
  const src = PAGE.slice(PAGE.indexOf('function refreshShapeMetrics('));
  const body = src.slice(0, src.indexOf('\n  }'));
  assert.match(body, /delete shape\.leak/,
    'refreshShapeMetrics must drop a stale leak reading');

  // Ordering matters: makeShape refreshes metrics and the leak is measured after,
  // so a fresh trace keeps its reading.
  const mk = PAGE.indexOf('function makeShape(');
  const mkBody = PAGE.slice(mk, PAGE.indexOf('\n  }', mk));
  assert.match(mkBody, /refreshShapeMetrics\(shape\)/,
    'makeShape refreshes metrics, so the leak must be measured after makeShape returns');
  const traceCall = PAGE.indexOf('warnIfTraceLeaked(shape)');
  const makeCall = PAGE.indexOf("makeShape(mapPts, 'trace-");
  assert.ok(makeCall > 0 && traceCall > makeCall,
    'the trace path must measure the leak after the shape is built, or it would be wiped');

  // And every geometry-changing operation goes through refreshShapeMetrics, which
  // is what makes one deletion enough.
  for (const op of ['applyCorrection', 'regulariseShapes', 'revertShape']) {
    const i = PAGE.indexOf(`function ${op}(`);
    assert.ok(i > 0, `${op} should exist`);
    const b = PAGE.slice(i, PAGE.indexOf('\n  }', i));
    assert.match(b, /refreshShapeMetrics\(/, `${op} must refresh metrics so the reading cannot go stale`);
  }
});

/* =====================================================================
 * R18 — THE v17 UPGRADE BRIEF
 * ---------------------------------------------------------------------
 * One assertion per section of BhuNaksha_Digitizer_Final_Upgrade_Instructions
 * as adjusted in UPGRADE_INSTRUCTIONS_ADJUSTED.md, so a capability added for
 * that brief cannot quietly disappear again.
 * =================================================================== */

const Imp = require('../lib/importers.js');
const Geo = require('../lib/geom_edit.js');

test('R18-1: exactly three primary controls, with project I/O inside the menus', () => {
  for (const id of ['btnImport', 'btnExport', 'btnSaveProject']) {
    assert.match(PAGE, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  // Project import/export must not ALSO be permanent buttons; they live in the
  // menus, which is where the brief puts them.
  const mainBar = PAGE.match(/function mainBarHtml\(\)[\s\S]*?\n  \}/)[0];
  const primary = [...mainBar.matchAll(/class="bnd15-btn [^"]*" id="(btn\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(primary, ['btnImport', 'btnExport', 'btnSaveProject']);
  // Menu entries are built by the item() helper, so the id is its first
  // argument rather than literal markup here.
  assert.ok(/item\('xProj'/.test(mainBar) && /item\('xLoad'/.test(mainBar),
    'project JSON export and import must be menu entries');
});

test('R18-1b: the menus stay in the DOM when closed', () => {
  // Building them on open would put every export out of reach of anything that
  // looks for a control by id, and the integration suite would have to be
  // weakened to match.
  assert.match(PAGE, /\.bnd15-menu\{display:none/, 'closed menus are hidden by CSS');
  assert.match(PAGE, /\.bnd15-menu\.open\{display:block\}/);
});

test('R18-2: an import overlays automatically and never repositions geometry', () => {
  assert.match(PAGE, /function adoptImportedRings\(/);
  assert.match(PAGE, /function zoomToImported\(/, 'the VIEW moves to the geometry');
  // The geometry must be taken as written. A reader that recentres or rounds
  // has destroyed survey position.
  assert.match(PAGE, /r\.points\.map\(\(p\) => \[p\[0\], p\[1\]\]\)/,
    'imported coordinates must be carried through unchanged');
});

test('R18-2b: an import asks for the CRS rather than guessing it', () => {
  assert.match(PAGE, /function resolveImportCrs\(/);
  const fn = PAGE.match(/function resolveImportCrs\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /ask: true/, 'with no evidence it must ask, not assume');
  assert.match(fn, /not stated in the file/);
  // And a lon/lat file must not be silently dropped into a projected session.
  assert.match(fn, /near the equator/);
});

test('R18-3/4: move, rotate and scale exist and record a separate shift', () => {
  for (const fn of ['moveShapeBy', 'rotateShapeBy', 'scaleShapeBy', 'resetShapeShift', 'applyShiftToShape']) {
    assert.match(PAGE, new RegExp(`function ${fn}\\(`), `${fn} must exist`);
  }
  assert.match(PAGE, /shape\.shift = GeomEdit\.composeShift\(/,
    'every operation must compose into the stored record');
  // Rotation and scale about the parcel's own centroid, so they do not translate.
  assert.match(PAGE, /GeomEdit\.shiftForRotationAbout\(degrees, c\)/);
  assert.match(PAGE, /GeomEdit\.shiftForScaleAbout\(factor, c\)/);
});

test('R18-4b: the shift record reproduces stacked operations exactly', () => {
  const ring = ring4();
  const c = Geo.ringCentroid(ring);
  let step = Geo.translateRing(ring, 3.25, -2.5);
  step = Geo.rotateRing(step, 1.5, c);
  step = Geo.scaleRing(step, 1.02, c);
  let s = Geo.composeShift(Geo.identityShift(), Geo.shiftForTranslation(3.25, -2.5));
  s = Geo.composeShift(s, Geo.shiftForRotationAbout(1.5, c));
  s = Geo.composeShift(s, Geo.shiftForScaleAbout(1.02, c));
  const viaRecord = Geo.applyShiftToRing(s, ring);
  const worst = Math.max(...step.map((p, i) => Math.hypot(p[0] - viaRecord[i][0], p[1] - viaRecord[i][1])));
  assert.ok(worst < 1e-6, `record disagrees with the geometry by ${worst} m`);
  // And inverting it is how "reset the shift" restores the original.
  const back = Geo.applyShiftToRing(Geo.invertShift(s), viaRecord);
  assert.ok(Math.max(...back.map((p, i) => Math.hypot(p[0] - ring[i][0], p[1] - ring[i][1]))) < 1e-6);
});

function ring4() {
  return [[432500.25, 2618400.75], [432540.25, 2618400.75],
    [432540.25, 2618440.75], [432500.25, 2618440.75]];
}

test('R18-5: the existing GCP mathematics is retained, unreplaced', () => {
  // The brief says to use the existing engine. All five models must still be
  // there, and translation must still be the default — the least-distorting.
  for (const m of ['translation', 'similarity', 'affine', 'projective', 'tps']) {
    assert.ok(Gcp.MODELS[m], `${m} must survive`);
  }
  assert.match(PAGE, /transformType: 'translation'/);
  assert.strictEqual(typeof Gcp.fitRobust, 'function');
  assert.strictEqual(typeof Gcp.crossValidateLoo, 'function');
});

test('R18-6: a GCP CSV is previewed and confirmed before anything is read', () => {
  assert.match(PAGE, /purpose: 'gcps'/);
  assert.match(PAGE, /id="csvImport"/, 'an explicit Import button');
  assert.match(PAGE, /Nothing is imported until you press Import/);
  // The four named layouts plus auto-detect and custom mapping.
  const keys = Imp.CSV_FORMATS.map((f) => f.key);
  for (const k of ['auto', 'id_e_n_z', 'id_x_y_z', 'id_lat_lon_z', 'custom']) {
    assert.ok(keys.includes(k), `format ${k} must be offered`);
  }
  // Delimiter and CRS are selectable.
  assert.match(PAGE, /id="csvDelim"/);
  assert.match(PAGE, /id="csvCrs"/);
  // And the QGIS reader that already existed is still the reader for .points.
  assert.match(PAGE, /Exp\.parseGcpPointsFile\(text\)/);
});

test('R18-7: the six named sections are collapsible', () => {
  assert.match(PAGE, /function section\(key, title, inner, badge\)/);
  for (const key of ['workflow', 'cleanup', 'edit', 'gcp', 'drawing']) {
    assert.ok(PAGE.includes(`section('${key}'`), `"${key}" must be a collapsible section`);
  }
  assert.match(PAGE, /id="advT"/, 'and Settings keeps its own');
  assert.match(PAGE, /function toggleSection\(/, 'with the state remembered');
});

test('R18-8: the four editing controls sit together, in order', () => {
  const bar = PAGE.match(/function historyBarHtml\(\)[\s\S]*?\n  \}/)[0];
  const ids = [...bar.matchAll(/id="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ['gUndo', 'gRedo', 'delLast', 'delAll']);
  // Always rendered, so they can always be found.
  assert.ok(!/if \(!u && !r\) return '';/.test(bar),
    'the bar must not vanish when there is nothing to undo');
});

test('R18-10: every Edit tool the brief lists is present', () => {
  // The names must be present as operator-facing text. That they actually
  // RENDER into the Edit section is asserted against a real DOM in
  // browser_integration.test.js; this is the shallow traceability check.
  const editCard = PAGE.match(/function editCardHtml\(\)[\s\S]*?\n  \}/)[0];
  for (const tool of ['Select', 'Move Geometry', 'Move Vertex', 'Add Vertex',
    'Delete Vertex', 'Rotate', 'Scale', 'Copy', 'Duplicate', 'Delete']) {
    assert.ok(editCard.includes(tool), `Edit must offer "${tool}"`);
  }
  // Checked at the wiring rather than the markup: the mode buttons are built by
  // a helper, so their id is an argument, and a control that renders but is not
  // wired is the failure that actually matters.
  for (const id of ['eSelect', 'eMove', 'eVertex', 'eAddVertex', 'eDelVertex',
    'eApplyXY', 'eApplyRot', 'eApplyScale', 'eCopy', 'eDuplicate', 'eDelete', 'eResetShift']) {
    assert.ok(PAGE.includes(`on('${id}',`), `${id} must be wired to a handler`);
  }
});

test('R18-11: the drawing underlay has opacity, rotation and lock', () => {
  for (const id of ['wsOpacity', 'wsRotate', 'wsLock']) {
    assert.match(PAGE, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  // Locking must stop the SHEET moving without stopping digitizing on it.
  const rw = read('lib/raster_workspace.js');
  assert.match(rw, /setLocked\(v\)/);
  assert.match(rw, /if \(locked\) return;/, 'the pan/zoom handlers must be gated');
  assert.match(rw, /setDisplayStyle\(opts\)/);
});

test('R18-12: an RF needs a resolution, and refuses without one', () => {
  // The one place the brief asked for something that does not follow: an RF
  // relates paper distance to ground distance and says nothing about pixels.
  assert.strictEqual(Geo.groundMetresPerPixelFromRf(2000, null).ok, false);
  assert.match(Geo.groundMetresPerPixelFromRf(2000, null).error, /resolution|dpi/i);
  const r = Geo.groundMetresPerPixelFromRf(2000, 300);
  assert.ok(Math.abs(r.metresPerPixel - (2000 * 0.0254 / 300)) < 1e-12);
  assert.match(PAGE, /id="rfDen"/);
  assert.match(PAGE, /id="rfDpi"/, 'and the DPI must be asked for, not assumed');
});

test('R18-12b: drawing scale is independent of screen zoom', () => {
  // Nothing in the calibration may read the viewport, or magnifying the display
  // would change the calibrated scale.
  const src = read('lib/geom_edit.js');
  assert.ok(!/viewport|getZoom|screenScale/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the calibration library must not touch the viewport');
  const cal = Geo.makeCalibration({ method: 'rf', rfDenominator: 2000, dpi: 300 }).calibration;
  for (const k of Object.keys(cal)) {
    assert.ok(!/zoom|screen|viewport/i.test(k), `a calibration must not store "${k}"`);
  }
});

test('R18-13: a scale bar calibrates from two points and a known distance', () => {
  const r = Geo.metresPerPixelFromScaleBar([100, 100], [400, 100], 50);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.metresPerPixel - 50 / 300) < 1e-12);
  assert.match(PAGE, /function pickCalibrationPoint\(/);
  assert.match(PAGE, /id="calApply"/);
  // Stored in the project.
  assert.match(PAGE, /calibration: st\.calibration/);
});

test('R18-16/17/18: DXF, CSV and KMZ readers exist and skip gracefully', () => {
  for (const fn of ['parseDxf', 'parseKml', 'parseKmz', 'ringsFromCsv', 'parseGeoJson']) {
    assert.strictEqual(typeof Imp[fn], 'function', fn);
  }
  // Every reader answers with the same envelope, including a reason for each
  // thing it could not read.
  const r = Imp.parseKml('<kml><Placemark><name>x</name><Point><coordinates>1,1</coordinates></Point></Placemark></kml>');
  assert.ok(Array.isArray(r.skipped) && r.skipped[0].why, 'skips must carry a reason');
  assert.strictEqual(r.ok, false, 'and a file with nothing usable must say so');
});

test('R18-19: a saved project can rebuild the whole workspace', () => {
  const fn = PAGE.match(/function serialiseSession\(\)[\s\S]*?\n  \}/)[0];
  for (const field of ['shapes', 'gcps', 'crs', 'projectName', 'georefPoints',
    'georefCrs', 'calibration', 'drawing', 'settings', 'backups']) {
    assert.ok(fn.includes(field), `a project must store ${field}`);
  }
  assert.match(PAGE, /const PROJECT_SCHEMA = /, 'and be versioned so old files still load');
});

test('R18-20: Save Project updates the current project instead of duplicating', () => {
  assert.match(PAGE, /function saveProjectNow\(/);
  const fn = PAGE.match(/function saveProjectNow\(\)[\s\S]*?\n  \}/)[0];
  assert.match(fn, /if \(!name\)/, 'it must only ask for a name when it has none');
  assert.match(fn, /\$\{safeName\}\.json/, 'and write ProjectName.json');
});

test('R18-22: Capture View hides the digitizer, and claims nothing more', () => {
  assert.match(PAGE, /function withWidgetHidden\(/);
  assert.match(PAGE, /withWidgetHidden\(\(\) => requestTabCapture\(\)\)/);
  // Restored whatever happens, including a thrown capture.
  const fn = PAGE.match(/async function withWidgetHidden\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /finally/, 'the panel must come back even if the capture fails');
});

test('R18-23/24: imported geometry is an ordinary shape, with a layer', () => {
  // One shape factory, so imported parcels get the same editor, clean-up,
  // control points, undo and exports as traced ones.
  assert.match(PAGE, /const shape = makeShape\(r\.points/,
    'imports must go through the same makeShape as tracing');
  assert.match(PAGE, /source: 'imported'/);
  assert.match(PAGE, /source: e\.source \|\| 'digitized'/);
  assert.match(PAGE, /layer: e\.layer/);
  // And there must be no second editor.
  assert.ok(!/function editImported|importedEditMode/.test(PAGE),
    'imported geometry must not get an editor of its own');
});

test('R18-25: exports carry the corrected geometry', () => {
  // shape.points IS the corrected geometry, so this is true by construction —
  // but the shift record must not be what is exported instead.
  assert.match(PAGE, /function shapesForExport\(\)/);
  const fn = PAGE.match(/function shapesForExport\(\)[\s\S]*?\n  \}/)[0];
  assert.ok(!/backups|shift/.test(fn),
    'export must read the live corrected points, never the pre-shift original');
});

test('R18-27: the existing architecture is extended, not replaced', () => {
  // Every library the brief names must still be there and still be loaded.
  const bg = read('background.js');
  for (const f of ['lib/crs.js', 'lib/gcp_math.js', 'lib/history.js', 'lib/exporters.js',
    'lib/topology.js', 'lib/site_adapters.js', 'lib/raster_workspace.js',
    'lib/tracer.js', 'lib/viewport.js', 'lib/importers.js', 'lib/geom_edit.js']) {
    assert.ok(exists(f), `${f} must exist`);
    assert.ok(bg.includes(f), `${f} must be injected`);
  }
  // The new libraries follow the same purity rule as the rest of lib/.
  for (const f of ['lib/importers.js', 'lib/geom_edit.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bdocument\.|window\./.test(src), `${f} must stay DOM-free`);
  }
});

test('R18-x: the centroid and area are stable at real UTM magnitudes', () => {
  // Found while building the rotate tool: the shoelace centroid is a ratio of
  // sums that grow as the square of the coordinate magnitude, and at Jharkhand
  // values a rotated 40 m square came out 13 cm from its true centre. That
  // centroid is the pivot Rotate turns about, so the error translated the
  // parcel while claiming only to rotate it.
  const ring = ring4();
  const c0 = Geo.ringCentroid(ring);
  for (const deg of [0, 12, 37, 90, 180, 271.5]) {
    const rot = Geo.rotateRing(ring, deg, c0);
    for (const centroid of [Geo.ringCentroid(rot), Exp.centroidOfRing(rot)]) {
      const drift = Math.hypot(centroid[0] - c0[0], centroid[1] - c0[1]);
      assert.ok(drift < 1e-6, `centroid drifted ${drift} m under a ${deg}° rotation`);
    }
  }
  // And the same cancellation in signedArea.
  const area0 = Exp.gridArea(ring);
  const rotated = Exp.gridArea(Geo.rotateRing(ring, 37, c0));
  assert.ok(Math.abs(rotated - area0) < 1e-6,
    `area changed by ${Math.abs(rotated - area0)} m² under a pure rotation`);
});

test('R18-7b: every default-open section names a section that exists', () => {
  // 'io' was in this list from an earlier design in which Import/Export was a
  // collapsible section rather than two of the three permanent buttons. It
  // named nothing, so it silently did nothing — the same class of decorative
  // setting the suite already guards against elsewhere.
  const block = PAGE.match(/const DEFAULT_SETTINGS = \{([\s\S]*?)\n  \};/)[1];
  const defaults = (block.match(/openSections:\s*\[([^\]]*)\]/) || [])[1] || '';
  const wanted = [...defaults.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(wanted.length, 'some section should start open');
  const declared = new Set([...PAGE.matchAll(/section\('([^']+)'/g)].map((m) => m[1]));
  for (const key of wanted) {
    assert.ok(declared.has(key),
      `openSections names "${key}", but no section('${key}', ...) exists — it would open nothing`);
  }
});

test('R18-7c: a control behind a collapsed section is reachable by opening it', () => {
  // jsdom has no layout, so it will click a hidden button and report success.
  // Real Chrome will not. The E2E suite is what enforces this, and it must
  // drive the UI the way an operator does rather than reaching past it.
  const e2e = read('test/chrome_e2e.test.js');
  assert.match(e2e, /details\.sect\[data-sect="cleanup"\] > summary/,
    'the E2E suite must expand a section before using the controls inside it');
  assert.match(e2e, /#btnExport/,
    'and open the Export menu before clicking an export');
});
