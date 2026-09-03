/* =========================================================================
 * End-to-end integration across all five libraries.
 *
 * The individual suites verify each module in isolation. This one runs the
 * actual workflow — detect the map, resolve the CRS, trace a parcel from
 * pixels, correct it with control points, export it — because that is where
 * interface mismatches live: an axis swap, a pixel-vs-map coordinate mix-up, a
 * ring winding convention applied at the wrong layer.
 *
 * The map is a stub, but the numbers are real: a synthetic raster is traced,
 * the resulting pixels are converted through the adapter into UTM 45N, and the
 * recovered ground area is checked against the geometry that was painted.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Crs = require('../lib/crs.js');
const GcpMath = require('../lib/gcp_math.js');
const Tracer = require('../lib/tracer.js');
const Exp = require('../lib/exporters.js');
const Adapters = require('../lib/site_adapters.js');

/* ---------------------------------------------------------------------
 * A stub OpenLayers map over UTM 45N at a known, exact resolution, so that
 * pixel distances convert to metres with no rounding slack.
 * ------------------------------------------------------------------- */
const RECT = { left: 0, top: 0, width: 400, height: 300 };
const METRES_PER_PX = 0.25;
const CENTRE = [432500, 2618400];

function makeStubMap() {
  const canvas = { width: RECT.width, height: RECT.height, clientWidth: RECT.width };
  const el = {
    getBoundingClientRect: () => ({ ...RECT, right: RECT.width, bottom: RECT.height }),
    querySelector: () => canvas,
  };
  const state = { center: CENTRE.slice(), zoom: 20 };
  const view = {
    getZoom: () => state.zoom, setZoom: (z) => { state.zoom = z; },
    getCenter: () => state.center.slice(), setCenter: (c) => { state.center = c.slice(); },
    getMinZoom: () => 0, getMaxZoom: () => 24, setMinZoom: () => {}, setMaxZoom: () => {},
    getResolution: () => METRES_PER_PX,
    getProjection: () => ({ getCode: () => 'EPSG:32645' }),
  };
  return {
    getView: () => view,
    getViewport: () => el,
    getCoordinateFromPixel: ([px, py]) => [
      state.center[0] + (px - RECT.width / 2) * METRES_PER_PX,
      state.center[1] - (py - RECT.height / 2) * METRES_PER_PX,
    ],
    getPixelFromCoordinate: ([x, y]) => [
      (x - state.center[0]) / METRES_PER_PX + RECT.width / 2,
      (state.center[1] - y) / METRES_PER_PX + RECT.height / 2,
    ],
    getLayers: () => ({ getArray: () => [] }),
    on: () => {}, un: () => {},
  };
}

function makeWin(host) {
  return {
    map: makeStubMap(),
    location: { hostname: host || 'jharbhunaksha.jharkhand.gov.in' },
    document: { body: { innerText: 'State: Jharkhand' } },
    performance: { getEntriesByType: () => [] },
  };
}

/* ---------------------------------------------------------------------
 * A raster with one pale parcel inside a dark boundary, 120 x 80 px.
 * At 0.25 m/px that parcel is 30 m x 20 m = 600 m² of ground.
 * ------------------------------------------------------------------- */
const PARCEL = { r: 240, g: 220, b: 180 };
const SURROUND = { r: 200, g: 230, b: 240 };
const WALL = { r: 20, g: 20, b: 20 };
const PARCEL_PX = { x: 40, y: 50, w: 120, h: 80 };

function makeRaster() {
  const w = RECT.width, h = RECT.height;
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, c) => {
    const i = (y * w + x) * 4;
    data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, SURROUND);
  // Wall one pixel outside the parcel on every side.
  for (let y = PARCEL_PX.y - 1; y <= PARCEL_PX.y + PARCEL_PX.h; y++) {
    for (let x = PARCEL_PX.x - 1; x <= PARCEL_PX.x + PARCEL_PX.w; x++) put(x, y, WALL);
  }
  for (let y = PARCEL_PX.y; y < PARCEL_PX.y + PARCEL_PX.h; y++) {
    for (let x = PARCEL_PX.x; x < PARCEL_PX.x + PARCEL_PX.w; x++) put(x, y, PARCEL);
  }
  return { data, width: w, height: h };
}

// Mirrors what page_inject.js does: trace in raster pixels, then convert each
// pixel through the adapter into map coordinates.
function traceToMapCoords(adapter, raster, seedPx) {
  const r = Tracer.traceRegion(raster, seedPx[0], seedPx[1], {
    submode: 'fill', colorTolerance: 30,
    leakProtectionRadius: 1, edgeGrowthRadius: 0, simplifyPx: 1.5,
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const pts = r.points
    .map(([px, py]) => adapter.clientToMapCoord(RECT.left + px, RECT.top + py))
    .filter(Boolean);
  return { ok: true, points: pts, raw: r };
}

/* =====================================================================
 * THE WORKFLOW
 * =================================================================== */

test('adapter detection through CRS resolution to a confirmed zone', () => {
  const win = makeWin();
  const r = Adapters.createAdapter(win, {});
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.adapter.id, 'openlayers');
  assert.strictEqual(r.adapter.portal.id, 'bhunaksha-nic');

  const hints = Adapters.collectCrsHints(r.adapter, win);
  const detected = Crs.detectCrs([r.adapter.getCenter()], hints);
  assert.strictEqual(detected.crs.kind, 'utm');
  assert.strictEqual(detected.crs.zone, 45);
  assert.strictEqual(detected.needsConfirmation, false);
});

test('a traced parcel recovers its true ground area to within a pixel of error', () => {
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});
  const crs = { kind: 'utm', zone: 45, north: true, datum: 'WGS84' };

  const traced = traceToMapCoords(adapter, makeRaster(),
    [PARCEL_PX.x + PARCEL_PX.w / 2, PARCEL_PX.y + PARCEL_PX.h / 2]);
  assert.strictEqual(traced.ok, true, traced.reason);
  assert.ok(traced.points.length >= 4 && traced.points.length <= 8,
    `a rectangular parcel should give ~4 corners, got ${traced.points.length}`);

  // 120 px x 80 px at 0.25 m/px = 30 m x 20 m = 600 m² in grid units.
  const gridArea = Exp.gridArea(traced.points);
  assert.ok(Math.abs(gridArea - 600) < 25,
    `grid area ${gridArea.toFixed(1)} m² should be near 600 m² (tolerance is a pixel of edge placement)`);

  // Ground area must be slightly LARGER than grid area here, because UTM's
  // scale factor is below 1 near the central meridian.
  const k = Crs.pointScaleFactor(CENTRE[0], CENTRE[1], crs);
  const ground = Exp.groundAreaFromGrid(traced.points, k);
  assert.ok(k < 1, `k should be under 1 at this easting, got ${k}`);
  assert.ok(ground > gridArea, 'ground area must exceed grid area when k < 1');

  // And the two independent area routes must agree once projected.
  const lonLat = traced.points.map((p) => Crs.toWgs84(p[0], p[1], crs));
  const geodesic = Exp.geodesicArea(lonLat);
  assert.ok(Math.abs(geodesic - ground) / ground < 1e-3,
    `geodesic ${geodesic.toFixed(2)} vs scale-corrected ${ground.toFixed(2)}`);
});

test('traced geometry is valid and lands in Jharkhand once projected', () => {
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});
  const crs = { kind: 'utm', zone: 45, north: true, datum: 'WGS84' };
  const traced = traceToMapCoords(adapter, makeRaster(),
    [PARCEL_PX.x + 10, PARCEL_PX.y + 10]);
  assert.strictEqual(traced.ok, true, traced.reason);

  const v = Exp.validateRing(traced.points);
  assert.strictEqual(v.valid, true, JSON.stringify(v.problems));

  for (const p of traced.points) {
    const ll = Crs.toWgs84(p[0], p[1], crs);
    assert.ok(ll, 'every vertex must project');
    assert.ok(ll[0] > 84 && ll[0] < 90, `lon ${ll[0]} outside Jharkhand's band`);
    assert.ok(ll[1] > 21 && ll[1] < 26, `lat ${ll[1]} outside Jharkhand's band`);
  }
});

test('control points placed in screen space correct a drifted parcel', () => {
  // The full georeferencing loop as the UI drives it: the user drags a handle
  // on screen, so the correction is fitted from map coordinates derived from
  // pixel positions — the place where a coordinate-space mix-up would show up.
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});

  const traced = traceToMapCoords(adapter, makeRaster(),
    [PARCEL_PX.x + PARCEL_PX.w / 2, PARCEL_PX.y + PARCEL_PX.h / 2]);
  assert.strictEqual(traced.ok, true);

  // Pretend the whole trace sits 2.5 m east and 1.5 m south of the truth.
  const DRIFT = [2.5, -1.5];
  const truth = (p) => [p[0] + DRIFT[0], p[1] + DRIFT[1]];

  // For four corners, the user drags each handle from its stored position to
  // the true one; both ends are expressed via screen pixels.
  const gcps = traced.points.slice(0, 4).map((src, i) => {
    const wantMap = truth(src);
    const px = adapter.mapCoordToClient(wantMap[0], wantMap[1]);
    const draggedTo = adapter.clientToMapCoord(px[0], px[1]);
    return { vertexIndex: i, rawPoint: src, confirmedPoint: draggedTo };
  });

  const fit = GcpMath.fitGcpTransform(gcps, 'similarity', { robust: true });
  assert.strictEqual(fit.ok, true, fit.error);
  assert.ok(fit.rms < 1e-6, `RMS ${fit.rms} should be negligible for a pure shift`);

  // Every vertex, including untagged ones, must move onto the truth.
  for (const p of traced.points) {
    const got = fit.fit.apply(p);
    const want = truth(p);
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-6,
      'correction must generalise to untagged vertices');
  }
  // And the recovered transform must be a pure translation.
  assert.ok(Math.abs(fit.fit.scale - 1) < 1e-9, `scale ${fit.fit.scale}`);
  assert.ok(Math.abs(fit.fit.rotationRad) < 1e-9, `rotation ${fit.fit.rotationRad}`);
});

test('a mis-dragged control point is caught before it corrupts the result', () => {
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});
  const traced = traceToMapCoords(adapter, makeRaster(), [100, 90]);
  const ring = traced.points;
  assert.ok(ring.length >= 4);

  const truth = (p) => [p[0] + 2, p[1] - 1];
  // Six good points around the ring, plus one dragged 12 m wide of the mark.
  const src = [];
  for (let i = 0; i < 6; i++) src.push(ring[i % ring.length]);
  const gcps = src.map((p, i) => ({ vertexIndex: i, rawPoint: p, confirmedPoint: truth(p) }));
  gcps.push({ vertexIndex: 6, rawPoint: ring[0], confirmedPoint: [ring[0][0] + 14, ring[0][1] - 8] });

  const robust = GcpMath.fitGcpTransform(gcps, 'similarity', { robust: true });
  assert.strictEqual(robust.ok, true);
  assert.ok(robust.outliers && robust.outliers.includes(6),
    `the blunder should be flagged, got ${JSON.stringify(robust.outliers)}`);

  // The robust fit must still recover the true shift despite the bad point.
  const got = robust.fit.apply(ring[2]);
  const want = truth(ring[2]);
  assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 0.5,
    'the robust fit should be close to truth despite the outlier');
});

test('the recommended transform for pure drift is the least distorting one', () => {
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});
  const traced = traceToMapCoords(adapter, makeRaster(), [100, 90]);
  const ring = traced.points;
  const pairs = [];
  for (let i = 0; i < 6; i++) {
    const p = ring[i % ring.length];
    pairs.push({ vertexIndex: i, rawPoint: p, confirmedPoint: [p[0] + 3, p[1] - 2] });
  }
  const rec = GcpMath.recommendTransform(pairs);
  // Every pair says the same thing: move 3 m east, 2 m south. A similarity fit
  // would explain that equally well while also inventing a scale and a
  // rotation, so the parsimony rule must stop short of it.
  assert.strictEqual(rec.recommended, 'translation', rec.reason);
  const distortion = GcpMath.describeFitMagnitude(
    GcpMath.fitGcpTransform(pairs, rec.recommended).fit, 100).distortionAtRadius;
  assert.strictEqual(distortion, 0, 'a pure shift must move a far corner by exactly the same amount');
});

test('every export format is produced from one traced, corrected session', () => {
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});
  const crs = { kind: 'utm', zone: 45, north: true, datum: 'WGS84' };
  const traced = traceToMapCoords(adapter, makeRaster(), [100, 90]);
  assert.strictEqual(traced.ok, true);

  const shape = {
    id: 1, points: traced.points, plotNo: '123 & 4/A', mode: 'trace-fill',
    areaText: '0 एकड़ 14.8 डिसमिल',
    computedAreaM2: Exp.groundAreaFromGrid(traced.points, Crs.pointScaleFactor(CENTRE[0], CENTRE[1], crs)),
    lastGcpCorrection: { type: 'similarity', rmsMeters: 0.02, gcpCount: 4 },
  };
  const opts = {
    toLonLat: (p) => Crs.toWgs84(p[0], p[1], crs),
    crsLabel: Crs.describeCrs(crs),
    georefMode: 'shift',
    includeValidity: true,
  };

  const dxf = Exp.makeDxf([shape], opts);
  assert.strictEqual(dxf.plotsWritten, 1);
  assert.ok(dxf.text.includes('$INSBASE'), 'DXF must record its origin');

  const kml = Exp.makeKml([shape], opts);
  // The v13 ampersand bug, end to end.
  assert.ok(kml.includes('123 &amp; 4/A'), 'plot number must be XML-escaped');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(kml), 'no unescaped ampersands anywhere');

  const gj = Exp.makeGeoJson([shape], opts);
  assert.strictEqual(gj.features.length, 1);
  const ring = gj.features[0].geometry.coordinates[0];
  assert.ok(Exp.isCounterClockwise(ring), 'GeoJSON exterior must be CCW');
  for (const p of ring) {
    assert.ok(p[0] > 84 && p[0] < 90 && p[1] > 21 && p[1] < 26,
      `exported lon/lat ${p} must be in Jharkhand`);
  }

  const shp = Exp.shapefileZipBytes([shape], { baseName: 'plots', prjWkt: Exp.prjWktFor(crs) });
  assert.strictEqual(shp.recordCount, 1);
  assert.ok(shp.bytes.byteLength > 300);

  assert.match(Exp.makeWkt([shape], opts), /^POLYGON\(\(/);
  assert.ok(Exp.makeVertexCsv([shape], opts).split('\r\n').length > 2);
  assert.match(Exp.makeAreaReportCsv([shape], opts), /difference_pct/);
});

test('shapefile and GeoJSON disagree on winding, deliberately and correctly', () => {
  // Both conventions are produced from the same source ring in one session, so
  // a single shared helper getting it wrong would be invisible without this.
  const win = makeWin();
  const { adapter } = Adapters.createAdapter(win, {});
  const traced = traceToMapCoords(adapter, makeRaster(), [100, 90]);
  const shape = { id: 1, points: traced.points, plotNo: 'x' };

  const gjRing = Exp.makeGeoJson([shape], {}).features[0].geometry.coordinates[0];
  assert.ok(Exp.isCounterClockwise(gjRing), 'GeoJSON: counter-clockwise');

  const sf = Exp.shapefileFrom([shape], {});
  const dv = new DataView(sf.shp.buffer, sf.shp.byteOffset, sf.shp.byteLength);
  let p = 100 + 8 + 4 + 32;
  const numParts = dv.getInt32(p, true); p += 4;
  const numPoints = dv.getInt32(p, true); p += 4;
  p += 4 * numParts;
  const shpRing = [];
  for (let i = 0; i < numPoints; i++) {
    shpRing.push([dv.getFloat64(p, true), dv.getFloat64(p + 8, true)]);
    p += 16;
  }
  assert.ok(!Exp.isCounterClockwise(shpRing), 'Shapefile: clockwise');
});

test('a Leaflet portal in lon/lat runs the same workflow without a zone', () => {
  // Proves the abstraction holds: no UTM anywhere, no confirmation needed, and
  // areas come out geodesically instead of via a grid scale factor.
  const el = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }),
    querySelector: () => ({ width: 400, height: 300 }),
  };
  const centre = { lat: 23.3441, lng: 85.3096 };
  const degPerPx = 2.5e-6;
  const leafletMap = {
    getContainer: () => el,
    containerPointToLatLng: ([px, py]) => ({
      lat: centre.lat - (py - 150) * degPerPx,
      lng: centre.lng + (px - 200) * degPerPx,
    }),
    latLngToContainerPoint: ([lat, lng]) => ({
      x: (lng - centre.lng) / degPerPx + 200,
      y: (centre.lat - lat) / degPerPx + 150,
    }),
    getZoom: () => 18, setZoom: () => {},
    getCenter: () => ({ ...centre }), panTo: () => {},
    getMinZoom: () => 0, getMaxZoom: () => 22, setMinZoom: () => {}, setMaxZoom: () => {},
    options: { crs: { code: 'EPSG:3857' } },
    on: () => {}, off: () => {}, eachLayer: () => {},
  };
  const win = {
    theMap: leafletMap,
    location: { hostname: 'banglarbhumi.wb.gov.in' },
    document: { body: { innerText: 'West Bengal' } },
    performance: { getEntriesByType: () => [] },
  };

  const r = Adapters.createAdapter(win, {});
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.adapter.id, 'leaflet');
  assert.strictEqual(r.adapter.coordsAreLonLat, true);

  const traced = traceToMapCoords(r.adapter, makeRaster(),
    [PARCEL_PX.x + PARCEL_PX.w / 2, PARCEL_PX.y + PARCEL_PX.h / 2]);
  assert.strictEqual(traced.ok, true, traced.reason);
  // Coordinates are already geographic, so they must look like lon/lat.
  for (const p of traced.points) {
    assert.ok(Math.abs(p[0] - 85.3) < 0.01, `lon ${p[0]}`);
    assert.ok(Math.abs(p[1] - 23.34) < 0.01, `lat ${p[1]}`);
  }
  // Geodesic area is the right measure here; check it is sane and non-zero.
  const area = Exp.geodesicArea(traced.points);
  assert.ok(area > 100 && area < 100000, `geodesic area ${area} m² should be plausible`);

  const detected = Crs.detectCrs(traced.points, Adapters.collectCrsHints(r.adapter, win));
  assert.strictEqual(detected.crs.kind, 'geographic');
  assert.strictEqual(detected.needsConfirmation, false);
});

test('an unconfirmed CRS is surfaced rather than silently assumed', () => {
  // A portal with no EPSG code, an unrecognised host and no state in the page:
  // the workflow must reach the export stage still flagged, not guessing.
  const win = makeWin('cadastre.example.org');
  win.document.body.innerText = 'Parcel viewer';
  win.map.getView().getProjection = () => ({ getCode: () => '' });
  const { adapter } = Adapters.createAdapter(win, {});
  const hints = Adapters.collectCrsHints(adapter, win);
  hints.region = null;
  const detected = Crs.detectCrs([adapter.getCenter()], hints);
  assert.strictEqual(detected.crs, null, 'must not invent a zone');
  assert.strictEqual(detected.needsConfirmation, true);
  assert.strictEqual(detected.candidates.length, 60);
  // And with no CRS, projection must refuse rather than produce a plausible lie.
  assert.strictEqual(Crs.toWgs84(432500, 2618400, detected.crs), null);
});
