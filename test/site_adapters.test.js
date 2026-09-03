/* =========================================================================
 * Tests for lib/site_adapters.js
 *
 * Each map library is stubbed with the same contract the real one has, so the
 * adapter layer can be verified without a browser. Two classes of bug matter
 * most here and both are covered explicitly:
 *
 *   1. Container offset. Screen coordinates are page-relative but every map
 *      library wants container-relative pixels. Forgetting the bounding rect
 *      offsets every single digitised vertex by the position of the map on the
 *      page, which looks plausible and is completely wrong.
 *   2. Axis order. Leaflet speaks [lat, lng]; this codebase speaks [lon, lat]
 *      everywhere. A silent swap puts Jharkhand plots in Somalia.
 * ========================================================================= */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/site_adapters.js');

/* ---------------------------------------------------------------------
 * Stub DOM element with a non-zero page offset, so offset bugs surface.
 * ------------------------------------------------------------------- */
const RECT = { left: 120, top: 80, width: 800, height: 600 };

function makeElement() {
  const canvas = { tagName: 'CANVAS', width: 800, height: 600 };
  return {
    getBoundingClientRect: () => ({ ...RECT, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height }),
    querySelector: (sel) => (sel === 'canvas' ? canvas : null),
    __canvas: canvas,
  };
}

/* ---------------------------------------------------------------------
 * Stub OpenLayers map: a linear projected view, 0.5 map units per pixel.
 * ------------------------------------------------------------------- */
function makeOlMap(opts) {
  const o = opts || {};
  const el = makeElement();
  const state = {
    center: o.center || [432500, 2618400],
    zoom: o.zoom === undefined ? 18 : o.zoom,
    minZoom: 0, maxZoom: 24,
    code: o.code || 'EPSG:32645',
  };
  const res = () => 0.5 / Math.pow(2, state.zoom - 18);
  const view = {
    getZoom: () => state.zoom,
    setZoom: (z) => { state.zoom = z; },
    getCenter: () => state.center.slice(),
    setCenter: (c) => { state.center = c.slice(); },
    getMinZoom: () => state.minZoom,
    setMinZoom: (z) => { state.minZoom = z; },
    getMaxZoom: () => state.maxZoom,
    setMaxZoom: (z) => { state.maxZoom = z; },
    getResolution: res,
    getProjection: () => ({ getCode: () => state.code }),
  };
  const listeners = {};
  return {
    __state: state,
    getView: () => view,
    getViewport: () => el,
    // Container-relative pixel -> map coordinate.
    getCoordinateFromPixel: ([px, py]) => [
      state.center[0] + (px - RECT.width / 2) * res(),
      state.center[1] - (py - RECT.height / 2) * res(),
    ],
    getPixelFromCoordinate: ([x, y]) => [
      (x - state.center[0]) / res() + RECT.width / 2,
      (state.center[1] - y) / res() + RECT.height / 2,
    ],
    getLayers: () => ({
      getArray: () => [{
        getSource: () => ({
          getUrls: () => ['https://portal.example.gov.in/geoserver/wms'],
          getParams: () => ({ LAYERS: 'plots', SRS: 'EPSG:32645' }),
        }),
      }],
    }),
    on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    un: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
    __emit: (ev) => (listeners[ev] || []).forEach((f) => f()),
    __listenerCount: (ev) => (listeners[ev] || []).length,
  };
}

/* ---------------------------------------------------------------------
 * Stub Leaflet map. Note the [lat, lng] argument order, faithfully.
 * ------------------------------------------------------------------- */
function makeLeafletMap() {
  const el = makeElement();
  const state = { center: { lat: 23.3441, lng: 85.3096 }, zoom: 17 };
  const degPerPx = 1e-5;
  const listeners = {};
  return {
    __state: state,
    getContainer: () => el,
    // Leaflet returns an object with .lat/.lng
    containerPointToLatLng: ([px, py]) => ({
      lat: state.center.lat - (py - RECT.height / 2) * degPerPx,
      lng: state.center.lng + (px - RECT.width / 2) * degPerPx,
    }),
    // ...and accepts [lat, lng].
    latLngToContainerPoint: ([lat, lng]) => ({
      x: (lng - state.center.lng) / degPerPx + RECT.width / 2,
      y: (state.center.lat - lat) / degPerPx + RECT.height / 2,
    }),
    getZoom: () => state.zoom,
    setZoom: (z) => { state.zoom = z; },
    getCenter: () => ({ ...state.center }),
    panTo: ([lat, lng]) => { state.center = { lat, lng }; },
    getMinZoom: () => 0,
    getMaxZoom: () => 22,
    setMinZoom: () => {},
    setMaxZoom: () => {},
    options: { crs: { code: 'EPSG:3857' } },
    on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    off: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
    eachLayer: (fn) => fn({ _url: 'https://tiles.example.com/{z}/{x}/{y}.png' }),
    __listenerCount: (ev) => (listeners[ev] || []).length,
  };
}

/* ---------------------------------------------------------------------
 * Stub MapLibre / Mapbox GL map. project/unproject use {lng,lat} and {x,y}.
 * ------------------------------------------------------------------- */
function makeMapLibreMap() {
  const el = makeElement();
  const state = { center: { lng: 85.3096, lat: 23.3441 }, zoom: 16 };
  const degPerPx = 2e-5;
  const listeners = {};
  return {
    __state: state,
    getContainer: () => el,
    getCanvas: () => el.__canvas,
    unproject: ([px, py]) => ({
      lng: state.center.lng + (px - RECT.width / 2) * degPerPx,
      lat: state.center.lat - (py - RECT.height / 2) * degPerPx,
    }),
    project: ([lng, lat]) => ({
      x: (lng - state.center.lng) / degPerPx + RECT.width / 2,
      y: (state.center.lat - lat) / degPerPx + RECT.height / 2,
    }),
    getZoom: () => state.zoom,
    setZoom: (z) => { state.zoom = z; },
    getCenter: () => ({ ...state.center }),
    setCenter: (c) => { state.center = { lng: c[0], lat: c[1] }; },
    getMinZoom: () => 0,
    getMaxZoom: () => 24,
    setMinZoom: () => {}, setMaxZoom: () => {},
    getStyle: () => ({ sources: { base: { tiles: ['https://t.example.com/{z}/{x}/{y}.pbf'] } } }),
    on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    off: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
    __listenerCount: (ev) => (listeners[ev] || []).length,
  };
}

function makeWin(globals, host) {
  return {
    ...globals,
    location: { hostname: host || 'jharbhunaksha.jharkhand.gov.in' },
    document: { body: { innerText: 'State: Jharkhand District: Ranchi' } },
    performance: { getEntriesByType: () => [] },
  };
}

/* =====================================================================
 * DISCOVERY
 * =================================================================== */

test('finds an OpenLayers map under the conventional global name', () => {
  const found = A.findMapInstance(makeWin({ map: makeOlMap() }));
  assert.ok(found);
  assert.strictEqual(found.kind, 'openlayers');
  assert.strictEqual(found.foundAs, 'map');
});

test('finds maps under unconventional global names by duck-typing', () => {
  for (const name of ['olMap', 'gisMap', 'someWeirdName_xyz']) {
    const found = A.findMapInstance(makeWin({ [name]: makeOlMap() }));
    assert.ok(found, `should find a map named ${name}`);
    assert.strictEqual(found.kind, 'openlayers');
    assert.strictEqual(found.foundAs, name);
  }
});

test('distinguishes the four supported libraries', () => {
  assert.strictEqual(A.findMapInstance(makeWin({ map: makeOlMap() })).kind, 'openlayers');
  assert.strictEqual(A.findMapInstance(makeWin({ map: makeLeafletMap() })).kind, 'leaflet');
  assert.strictEqual(A.findMapInstance(makeWin({ map: makeMapLibreMap() })).kind, 'maplibre');
});

test('does not mistake unrelated objects for maps', () => {
  const win = makeWin({
    jQuery: function () {}, someConfig: { a: 1, b: 2 },
    partial: { getZoom: () => 5 }, // has one method but not the signature
  });
  assert.strictEqual(A.findMapInstance(win), null);
});

test('createAdapter explains itself when no map is present', () => {
  const r = A.createAdapter(makeWin({}), {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /OpenLayers/);
  assert.match(r.error, /iframe/i, 'should mention the iframe case, a common real cause');
});

/* =====================================================================
 * OPENLAYERS ADAPTER
 * =================================================================== */

test('OpenLayers adapter converts client pixels through the container offset', () => {
  const map = makeOlMap();
  const { adapter } = A.createAdapter(makeWin({ map }), {});
  // Clicking the exact centre of the map element must yield the view centre.
  const centreClient = [RECT.left + RECT.width / 2, RECT.top + RECT.height / 2];
  const coord = adapter.clientToMapCoord(centreClient[0], centreClient[1]);
  assert.ok(Math.abs(coord[0] - 432500) < 1e-9, `easting ${coord[0]}`);
  assert.ok(Math.abs(coord[1] - 2618400) < 1e-9, `northing ${coord[1]}`);

  // Had the container offset been ignored, the result would be displaced by
  // (120, 80) pixels worth of ground — assert that specific failure is absent.
  const naive = map.getCoordinateFromPixel(centreClient);
  assert.ok(Math.hypot(naive[0] - coord[0], naive[1] - coord[1]) > 1,
    'the offset must actually matter in this fixture, or the test proves nothing');
});

test('OpenLayers client<->map conversion round-trips', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeOlMap() }), {});
  for (const [cx, cy] of [[200, 150], [520, 380], [900, 600]]) {
    const coord = adapter.clientToMapCoord(cx, cy);
    const back = adapter.mapCoordToClient(coord[0], coord[1]);
    assert.ok(Math.abs(back[0] - cx) < 1e-6, `x ${cx} -> ${back[0]}`);
    assert.ok(Math.abs(back[1] - cy) < 1e-6, `y ${cy} -> ${back[1]}`);
  }
});

test('OpenLayers adapter exposes zoom, centre and projection code', () => {
  const map = makeOlMap({ zoom: 18, code: 'EPSG:32645' });
  const { adapter } = A.createAdapter(makeWin({ map }), {});
  assert.strictEqual(adapter.getZoom(), 18);
  adapter.setZoom(21);
  assert.strictEqual(adapter.getZoom(), 21);
  adapter.setCenter([500000, 2600000]);
  assert.deepStrictEqual(adapter.getCenter(), [500000, 2600000]);
  assert.strictEqual(adapter.getProjectionCode(), 'EPSG:32645');
  assert.strictEqual(adapter.coordsAreLonLat, false, 'OL coords are projected, not lon/lat');
});

test('OpenLayers render subscription attaches and detaches cleanly', () => {
  const map = makeOlMap();
  const { adapter } = A.createAdapter(makeWin({ map }), {});
  let calls = 0;
  const off = adapter.onRender(() => { calls++; });
  map.__emit('postrender');
  map.__emit('postrender');
  assert.strictEqual(calls, 2);
  off();
  assert.strictEqual(map.__listenerCount('postrender'), 0, 'must not leak listeners');
  map.__emit('postrender');
  assert.strictEqual(calls, 2, 'no further callbacks after unsubscribe');
});

test('OpenLayers adapter harvests SRS hints from layer sources', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeOlMap() }), {});
  const urls = adapter.getTileUrls();
  assert.ok(urls.some((u) => /EPSG:32645/.test(u)), `expected an SRS hint in ${JSON.stringify(urls)}`);
});

/* =====================================================================
 * LEAFLET ADAPTER — axis order is the risk here.
 * =================================================================== */

test('Leaflet adapter normalises [lat,lng] to [lon,lat]', () => {
  const map = makeLeafletMap();
  const { adapter } = A.createAdapter(makeWin({ map }), {});
  const coord = adapter.clientToMapCoord(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);
  // Must be [lon, lat] = [85.3096, 23.3441], NOT the other way round.
  assert.ok(Math.abs(coord[0] - 85.3096) < 1e-9, `expected lon first, got ${coord[0]}`);
  assert.ok(Math.abs(coord[1] - 23.3441) < 1e-9, `expected lat second, got ${coord[1]}`);
  assert.ok(coord[0] > coord[1], 'in Jharkhand longitude exceeds latitude — a swap would be obvious');
});

test('Leaflet client<->map conversion round-trips with correct axis order', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeLeafletMap() }), {});
  for (const [cx, cy] of [[300, 200], [700, 500]]) {
    const coord = adapter.clientToMapCoord(cx, cy);
    const back = adapter.mapCoordToClient(coord[0], coord[1]);
    assert.ok(Math.abs(back[0] - cx) < 1e-6, `x ${cx} -> ${back[0]}`);
    assert.ok(Math.abs(back[1] - cy) < 1e-6, `y ${cy} -> ${back[1]}`);
  }
});

test('Leaflet setCenter takes [lon,lat] and pans correctly', () => {
  const map = makeLeafletMap();
  const { adapter } = A.createAdapter(makeWin({ map }), {});
  adapter.setCenter([85.5, 23.5]);
  assert.ok(Math.abs(map.__state.center.lng - 85.5) < 1e-12, 'lng must receive the first element');
  assert.ok(Math.abs(map.__state.center.lat - 23.5) < 1e-12, 'lat must receive the second');
  assert.deepStrictEqual(adapter.getCenter(), [85.5, 23.5]);
});

test('Leaflet coordinates are declared geographic', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeLeafletMap() }), {});
  assert.strictEqual(adapter.coordsAreLonLat, true);
});

/* =====================================================================
 * MAPLIBRE ADAPTER
 * =================================================================== */

test('MapLibre adapter converts and round-trips in [lon,lat]', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeMapLibreMap() }), {});
  const centre = adapter.clientToMapCoord(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);
  assert.ok(Math.abs(centre[0] - 85.3096) < 1e-9, `lon ${centre[0]}`);
  assert.ok(Math.abs(centre[1] - 23.3441) < 1e-9, `lat ${centre[1]}`);
  const back = adapter.mapCoordToClient(centre[0], centre[1]);
  assert.ok(Math.abs(back[0] - (RECT.left + RECT.width / 2)) < 1e-6);
  assert.ok(Math.abs(back[1] - (RECT.top + RECT.height / 2)) < 1e-6);
  assert.strictEqual(adapter.coordsAreLonLat, true);
});

test('MapLibre adapter reads its canvas and style sources', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeMapLibreMap() }), {});
  assert.ok(adapter.getCanvas(), 'canvas required for colour tracing');
  assert.ok(adapter.getTileUrls().some((u) => /example\.com/.test(u)));
});

/* =====================================================================
 * PORTAL REGISTRY
 * =================================================================== */

test('portal identification covers the BhuNaksha family and falls back safely', () => {
  assert.strictEqual(A.identifyPortal('jharbhunaksha.jharkhand.gov.in').id, 'bhunaksha-nic');
  assert.strictEqual(A.identifyPortal('bhunaksha.bihar.gov.in').id, 'bhunaksha-nic');
  assert.strictEqual(A.identifyPortal('mahabhunakasha.mahabhumi.gov.in').id, 'mahabhunakasha');
  assert.strictEqual(A.identifyPortal('dishaank.karnataka.gov.in').id, 'dishaank');
  assert.strictEqual(A.identifyPortal('banglarbhumi.wb.gov.in').id, 'banglarbhumi');
  // An unknown portal must still yield a usable generic entry, never null.
  const unknown = A.identifyPortal('some.random.cadastre.example.org');
  assert.strictEqual(unknown.id, 'generic');
  assert.ok(unknown.label);
});

test('adapter records which portal it is running on', () => {
  const { adapter } = A.createAdapter(makeWin({ map: makeOlMap() }, 'bhunaksha.bihar.gov.in'), {});
  assert.strictEqual(adapter.portal.id, 'bhunaksha-nic');
});

/* =====================================================================
 * CRS HINT COLLECTION — feeds lib/crs.js
 * =================================================================== */

test('collectCrsHints gathers every independent line of evidence', () => {
  const win = makeWin({ map: makeOlMap({ code: 'EPSG:32645' }) });
  const { adapter } = A.createAdapter(win, {});
  const hints = A.collectCrsHints(adapter, win);
  assert.strictEqual(hints.epsgCode, 'EPSG:32645');
  assert.strictEqual(hints.host, 'jharbhunaksha.jharkhand.gov.in');
  assert.match(hints.pageText, /Jharkhand/);
  assert.ok(Array.isArray(hints.tileUrls) && hints.tileUrls.length > 0);
  assert.strictEqual(hints.coordsAreLonLat, false);
});

test('hints from the adapter actually resolve a CRS end to end', () => {
  // The two libraries have to work together, not just individually.
  const CRS = require('../lib/crs.js');
  const win = makeWin({ map: makeOlMap({ code: 'EPSG:32645' }) });
  const { adapter } = A.createAdapter(win, {});
  const hints = A.collectCrsHints(adapter, win);
  const samples = [[432500, 2618400], [432560, 2618480]];
  const detected = CRS.detectCrs(samples, hints);
  assert.strictEqual(detected.crs.kind, 'utm');
  assert.strictEqual(detected.crs.zone, 45);
  assert.strictEqual(detected.needsConfirmation, false);
});

test('a Leaflet portal resolves to geographic without needing a zone', () => {
  const CRS = require('../lib/crs.js');
  const win = makeWin({ map: makeLeafletMap() }, 'banglarbhumi.wb.gov.in');
  const { adapter } = A.createAdapter(win, {});
  const hints = A.collectCrsHints(adapter, win);
  const samples = [[85.3096, 23.3441], [85.3102, 23.3448]];
  const detected = CRS.detectCrs(samples, hints);
  assert.strictEqual(detected.crs.kind, 'geographic');
  assert.strictEqual(detected.needsConfirmation, false,
    'lon/lat needs no zone, so nothing should require confirmation');
});
