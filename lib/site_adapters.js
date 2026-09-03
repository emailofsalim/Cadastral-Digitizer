/* =========================================================================
 * Map-library adapters + cadastral portal registry.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Adapters) or a CommonJS module.
 *
 * WHY: v13/v14 talked to `window.map` directly and assumed OpenLayers with
 * BhuNaksha's exact globals. That is one deployment of one state's portal.
 * Every function the digitizer actually needs from a map is small and
 * library-agnostic:
 *
 *   - screen pixel  <->  map coordinate
 *   - zoom and centre, get and set
 *   - a "finished rendering" signal, so overlays stay pinned to the ground
 *   - the drawable element, for pixel sampling during colour tracing
 *   - whatever the map is willing to say about its own projection
 *
 * So that becomes an interface, with one implementation per library. Adding a
 * new portal then usually means adding nothing at all — if it runs OpenLayers,
 * Leaflet, MapLibre, Mapbox GL or Google Maps, it already works.
 *
 * Every adapter is constructed against an injected `win`/`doc`, never a
 * captured global, so the whole layer is testable headlessly.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Adapters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isFn = (v) => typeof v === 'function';

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback === undefined ? null : fallback; }
  }

  /* =====================================================================
   * MAP INSTANCE DISCOVERY
   *
   * Portals expose their map object under wildly inconsistent names, so
   * duck-typing beats a name list. Names are still checked first because it is
   * cheap and avoids walking a large global scope.
   * =================================================================== */
  const COMMON_MAP_GLOBALS = [
    'map', 'Map', 'olMap', 'ol_map', 'theMap', 'mymap', 'myMap', 'mapObj',
    'mapObject', 'gisMap', 'leafletMap', 'mapView', 'viewer', 'mapInstance',
    'bhunakshaMap', 'plotMap', '_map', 'mapa',
  ];

  const SIGNATURES = {
    openlayers: (o) => !!o && isFn(o.getCoordinateFromPixel) && isFn(o.getPixelFromCoordinate) && isFn(o.getView),
    leaflet: (o) => !!o && isFn(o.containerPointToLatLng) && isFn(o.latLngToContainerPoint) && isFn(o.getZoom),
    maplibre: (o) => !!o && isFn(o.unproject) && isFn(o.project) && isFn(o.getZoom) && isFn(o.getCenter) && !isFn(o.containerPointToLatLng),
    google: (o) => !!o && isFn(o.getProjection) && isFn(o.getBounds) && isFn(o.getDiv) && !isFn(o.getCoordinateFromPixel),
  };

  // Order matters: the most specific signature is tested first.
  const DETECTION_ORDER = ['openlayers', 'leaflet', 'maplibre', 'google'];

  function findMapInstance(win) {
    if (!win) return null;
    const seen = new Set();
    const test = (obj) => {
      for (const kind of DETECTION_ORDER) {
        if (SIGNATURES[kind](obj)) return kind;
      }
      return null;
    };

    for (const name of COMMON_MAP_GLOBALS) {
      const obj = safe(() => win[name]);
      if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
      seen.add(obj);
      const kind = test(obj);
      if (kind) return { kind, mapObject: obj, foundAs: name };
    }

    // Fall back to a shallow sweep of own enumerable globals. Deliberately not
    // recursive: walking a page's whole object graph is slow and can trip
    // getters with side effects.
    const keys = safe(() => Object.keys(win), []) || [];
    for (const name of keys) {
      if (COMMON_MAP_GLOBALS.indexOf(name) !== -1) continue;
      const obj = safe(() => win[name]);
      if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
      seen.add(obj);
      const kind = test(obj);
      if (kind) return { kind, mapObject: obj, foundAs: name };
    }
    return null;
  }

  /* =====================================================================
   * ADAPTER INTERFACE
   *
   * Each adapter returns an object with this shape. `coordsAreLonLat` tells
   * the CRS layer whether the numbers coming out are already geographic —
   * Leaflet and MapLibre hand back lon/lat, OpenLayers hands back whatever
   * projected system the view uses.
   * =================================================================== */

  function makeOpenLayersAdapter(map, win, doc) {
    const getView = () => safe(() => map.getView());
    const viewport = () => safe(() => map.getViewport());

    return {
      id: 'openlayers',
      label: 'OpenLayers',
      mapObject: map,
      coordsAreLonLat: false,

      getContainer: () => viewport(),
      getCanvas: () => {
        const vp = viewport();
        return vp && vp.querySelector ? vp.querySelector('canvas') : null;
      },

      clientToMapCoord(clientX, clientY) {
        const el = this.getContainer();
        if (!el || !el.getBoundingClientRect) return null;
        const r = el.getBoundingClientRect();
        return safe(() => map.getCoordinateFromPixel([clientX - r.left, clientY - r.top]));
      },
      mapCoordToClient(x, y) {
        const el = this.getContainer();
        if (!el || !el.getBoundingClientRect) return null;
        const p = safe(() => map.getPixelFromCoordinate([x, y]));
        if (!p) return null;
        const r = el.getBoundingClientRect();
        return [p[0] + r.left, p[1] + r.top];
      },


      getZoom: () => safe(() => getView().getZoom()),
      setZoom: (z) => safe(() => getView().setZoom(z)),
      getCenter: () => safe(() => getView().getCenter()),
      setCenter: (c) => safe(() => getView().setCenter(c)),
      getMaxZoom: () => safe(() => getView().getMaxZoom(), 24),
      getMinZoom: () => safe(() => getView().getMinZoom(), 0),
      setZoomRange(min, max) {
        safe(() => getView().setMinZoom(min));
        safe(() => getView().setMaxZoom(max));
      },
      getResolution: () => safe(() => getView().getResolution()),

      getProjectionCode: () => safe(() => getView().getProjection().getCode()),

      onRender(cb) {
        if (!isFn(map.on)) return () => {};
        map.on('postrender', cb);
        return () => safe(() => map.un('postrender', cb));
      },

      // Layer sources expose imageloadend, which is a far better "ready"
      // signal than a fixed timeout when zooming for precision.
      waitForRender(timeoutMs) {
        return new Promise((resolve) => {
          const names = ['plotLyr', 'selPlotLyr', 'ownerPlotLyr'];
          const sources = names
            .map((n) => safe(() => win[n] && win[n].getSource()))
            .filter(Boolean);
          if (!sources.length) { setTimeout(resolve, Math.min(600, timeoutMs)); return; }
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          const timer = setTimeout(finish, timeoutMs);
          let pending = sources.length;
          const one = () => { if (--pending <= 0) { clearTimeout(timer); finish(); } };
          for (const s of sources) { if (isFn(s.once)) s.once('imageloadend', one); else one(); }
        });
      },

      getTileUrls() {
        const urls = [];
        safe(() => {
          const layers = map.getLayers && map.getLayers().getArray ? map.getLayers().getArray() : [];
          for (const l of layers) {
            const src = l.getSource && l.getSource();
            if (!src) continue;
            const u = (src.getUrls && src.getUrls()) || (src.getUrl && src.getUrl());
            if (typeof u === 'string') urls.push(u);
            else if (Array.isArray(u)) urls.push.apply(urls, u);
            const params = src.getParams && src.getParams();
            if (params) urls.push(JSON.stringify(params));
          }
        });
        // Also sweep recent network requests, which often carry SRS/CRS.
        safe(() => {
          const entries = win.performance && win.performance.getEntriesByType
            ? win.performance.getEntriesByType('resource') : [];
          for (const e of entries.slice(-80)) {
            if (/SRS|CRS|srsName|bbox/i.test(e.name)) urls.push(e.name);
          }
        });
        return urls;
      },
      _doc: doc,
    };
  }

  function makeLeafletAdapter(map, win, doc) {
    const container = () => safe(() => map.getContainer && map.getContainer());
    return {
      id: 'leaflet',
      label: 'Leaflet',
      mapObject: map,
      // Leaflet's public API is lat/lng regardless of its internal CRS, so the
      // digitizer can treat these as geographic directly.
      coordsAreLonLat: true,

      getContainer: container,
      getCanvas: () => {
        const el = container();
        return el && el.querySelector ? el.querySelector('canvas') : null;
      },

      clientToMapCoord(clientX, clientY) {
        const el = container();
        if (!el || !el.getBoundingClientRect) return null;
        const r = el.getBoundingClientRect();
        const ll = safe(() => map.containerPointToLatLng([clientX - r.left, clientY - r.top]));
        return ll ? [ll.lng, ll.lat] : null;
      },
      mapCoordToClient(x, y) {
        const el = container();
        if (!el || !el.getBoundingClientRect) return null;
        const p = safe(() => map.latLngToContainerPoint([y, x])); // Leaflet takes [lat, lng]
        if (!p) return null;
        const r = el.getBoundingClientRect();
        return [p.x + r.left, p.y + r.top];
      },

      getZoom: () => safe(() => map.getZoom()),
      setZoom: (z) => safe(() => map.setZoom(z, { animate: false })),
      getCenter: () => safe(() => { const c = map.getCenter(); return c ? [c.lng, c.lat] : null; }),
      setCenter: (c) => safe(() => map.panTo([c[1], c[0]], { animate: false })),
      getMaxZoom: () => safe(() => map.getMaxZoom(), 22),
      getMinZoom: () => safe(() => map.getMinZoom(), 0),
      setZoomRange(min, max) {
        safe(() => map.setMinZoom(min));
        safe(() => map.setMaxZoom(max));
      },
      getResolution: () => null,

      // Leaflet reports lat/lng; the underlying CRS code is informative but the
      // coordinates handed to us are geographic either way.
      getProjectionCode: () => safe(() => (map.options && map.options.crs && map.options.crs.code) || 'EPSG:4326'),

      onRender(cb) {
        if (!isFn(map.on)) return () => {};
        map.on('move zoom moveend zoomend', cb);
        return () => safe(() => map.off('move zoom moveend zoomend', cb));
      },
      waitForRender(timeoutMs) {
        return new Promise((resolve) => {
          let done = false;
          const finish = () => { if (done) return; done = true; safe(() => map.off('load moveend zoomend', finish)); resolve(); };
          const timer = setTimeout(finish, timeoutMs);
          void timer;
          if (isFn(map.once)) map.once('moveend zoomend', finish);
          else setTimeout(finish, Math.min(500, timeoutMs));
        });
      },
      getTileUrls() {
        const urls = [];
        safe(() => map.eachLayer && map.eachLayer((l) => {
          if (l && l._url) urls.push(l._url);
          if (l && l.wmsParams) urls.push(JSON.stringify(l.wmsParams));
        }));
        return urls;
      },
      _doc: doc,
    };
  }

  function makeMapLibreAdapter(map, win, doc) {
    const container = () => safe(() => map.getContainer && map.getContainer());
    return {
      id: 'maplibre',
      label: 'MapLibre / Mapbox GL',
      mapObject: map,
      coordsAreLonLat: true,

      getContainer: container,
      getCanvas: () => safe(() => (map.getCanvas ? map.getCanvas() : null)),

      clientToMapCoord(clientX, clientY) {
        const el = container();
        if (!el || !el.getBoundingClientRect) return null;
        const r = el.getBoundingClientRect();
        const ll = safe(() => map.unproject([clientX - r.left, clientY - r.top]));
        return ll ? [ll.lng, ll.lat] : null;
      },
      mapCoordToClient(x, y) {
        const el = container();
        if (!el || !el.getBoundingClientRect) return null;
        const p = safe(() => map.project([x, y]));
        if (!p) return null;
        const r = el.getBoundingClientRect();
        return [p.x + r.left, p.y + r.top];
      },

      getZoom: () => safe(() => map.getZoom()),
      setZoom: (z) => safe(() => map.setZoom(z)),
      getCenter: () => safe(() => { const c = map.getCenter(); return c ? [c.lng, c.lat] : null; }),
      setCenter: (c) => safe(() => map.setCenter(c)),
      getMaxZoom: () => safe(() => map.getMaxZoom(), 24),
      getMinZoom: () => safe(() => map.getMinZoom(), 0),
      setZoomRange(min, max) {
        safe(() => map.setMinZoom(min));
        safe(() => map.setMaxZoom(max));
      },
      getResolution: () => null,
      getProjectionCode: () => 'EPSG:4326',

      onRender(cb) {
        if (!isFn(map.on)) return () => {};
        map.on('render', cb);
        return () => safe(() => map.off('render', cb));
      },
      waitForRender(timeoutMs) {
        return new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          setTimeout(finish, timeoutMs);
          if (isFn(map.once)) map.once('idle', finish);
        });
      },
      getTileUrls() {
        const urls = [];
        safe(() => {
          const style = map.getStyle && map.getStyle();
          if (style && style.sources) {
            for (const k of Object.keys(style.sources)) {
              const s = style.sources[k];
              if (s.url) urls.push(s.url);
              if (Array.isArray(s.tiles)) urls.push.apply(urls, s.tiles);
            }
          }
        });
        return urls;
      },
      _doc: doc,
    };
  }

  function makeGoogleAdapter(map, win, doc) {
    // Google Maps has no public pixel<->latLng API on the map itself; it is
    // only exposed through an OverlayView's MapCanvasProjection. That overlay
    // has to be attached and drawn before projection is available, so this
    // adapter is best-effort and reports its own readiness honestly.
    let projection = null;
    safe(() => {
      const g = win.google && win.google.maps;
      if (!g || !g.OverlayView) return;
      const ov = new g.OverlayView();
      ov.onAdd = function () {};
      ov.draw = function () { projection = this.getProjection(); };
      ov.onRemove = function () {};
      ov.setMap(map);
    });

    const div = () => safe(() => map.getDiv && map.getDiv());
    return {
      id: 'google',
      label: 'Google Maps',
      mapObject: map,
      coordsAreLonLat: true,
      isReady: () => !!projection,
      readinessNote: 'Google Maps exposes coordinates only via an OverlayView projection, which needs one render pass before it works. If tagging does nothing, pan the map once and retry.',

      getContainer: div,
      getCanvas: () => {
        const el = div();
        return el && el.querySelector ? el.querySelector('canvas') : null;
      },

      clientToMapCoord(clientX, clientY) {
        if (!projection) return null;
        const el = div();
        if (!el || !el.getBoundingClientRect) return null;
        const r = el.getBoundingClientRect();
        const g = win.google.maps;
        const ll = safe(() => projection.fromContainerPixelToLatLng(
          new g.Point(clientX - r.left, clientY - r.top)));
        return ll ? [ll.lng(), ll.lat()] : null;
      },
      mapCoordToClient(x, y) {
        if (!projection) return null;
        const el = div();
        if (!el || !el.getBoundingClientRect) return null;
        const g = win.google.maps;
        const p = safe(() => projection.fromLatLngToContainerPixel(new g.LatLng(y, x)));
        if (!p) return null;
        const r = el.getBoundingClientRect();
        return [p.x + r.left, p.y + r.top];
      },

      getZoom: () => safe(() => map.getZoom()),
      setZoom: (z) => safe(() => map.setZoom(Math.round(z))),
      getCenter: () => safe(() => { const c = map.getCenter(); return c ? [c.lng(), c.lat()] : null; }),
      setCenter: (c) => safe(() => map.setCenter({ lat: c[1], lng: c[0] })),
      getMaxZoom: () => 22,
      getMinZoom: () => 0,
      setZoomRange() {},
      getResolution: () => null,
      getProjectionCode: () => 'EPSG:4326',

      onRender(cb) {
        const g = safe(() => win.google && win.google.maps);
        if (!g || !g.event) return () => {};
        const l1 = g.event.addListener(map, 'bounds_changed', cb);
        const l2 = g.event.addListener(map, 'idle', cb);
        return () => safe(() => { g.event.removeListener(l1); g.event.removeListener(l2); });
      },
      waitForRender(timeoutMs) {
        return new Promise((resolve) => {
          const g = safe(() => win.google && win.google.maps);
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          setTimeout(finish, timeoutMs);
          if (g && g.event) g.event.addListenerOnce(map, 'idle', finish);
        });
      },
      getTileUrls: () => [],
      _doc: doc,
    };
  }

  const FACTORIES = {
    openlayers: makeOpenLayersAdapter,
    leaflet: makeLeafletAdapter,
    maplibre: makeMapLibreAdapter,
    google: makeGoogleAdapter,
  };

  /* ---------------------------------------------------------------------
   * CANVAS-PIXEL MAPPING
   *
   * Colour tracing works on raw canvas pixels, and a map canvas is usually
   * backed at a higher density than its CSS size, so the ratio has to be
   * applied. Every map adapter derives it the same way, so it is attached once
   * here rather than repeated four times — and, more importantly, so callers
   * never have to rediscover it. Getting the ratio wrong offsets every traced
   * vertex by a plausible-looking amount, which is exactly the kind of bug that
   * survives review.
   *
   * Adapters that already define these (the raster workspace, where canvas
   * pixels ARE the coordinate system) keep their own.
   * ------------------------------------------------------------------- */
  function attachCanvasPixelHelpers(adapter) {
    if (isFn(adapter.clientToCanvasPixel) && isFn(adapter.canvasPixelToClient)) return adapter;
    const ratio = () => {
      const c = adapter.getCanvas();
      const el = adapter.getContainer();
      if (!c) return null;
      const r = el && isFn(el.getBoundingClientRect) ? el.getBoundingClientRect() : null;
      const cssWidth = c.clientWidth || (r && r.width) || c.width;
      return cssWidth ? c.width / cssWidth : 1;
    };
    adapter.clientToCanvasPixel = function (clientX, clientY) {
      const el = adapter.getContainer();
      const k = ratio();
      if (!el || k == null || !isFn(el.getBoundingClientRect)) return null;
      const r = el.getBoundingClientRect();
      return [(clientX - r.left) * k, (clientY - r.top) * k];
    };
    adapter.canvasPixelToClient = function (px, py) {
      const el = adapter.getContainer();
      const k = ratio();
      if (!el || k == null || !isFn(el.getBoundingClientRect)) return null;
      const r = el.getBoundingClientRect();
      return [px / k + r.left, py / k + r.top];
    };
    return adapter;
  }

  /* =====================================================================
   * PORTAL REGISTRY
   *
   * Only for things that are genuinely site-specific: how to scrape the
   * selected parcel's identifier and recorded area. Everything geometric goes
   * through the adapter, so a portal absent from this list still works — it
   * just will not auto-label plots.
   * =================================================================== */
  const PORTALS = [
    {
      id: 'bhunaksha-nic',
      label: 'BhuNaksha (NIC, multi-state)',
      // The NIC BhuNaksha codebase is deployed under many hostnames.
      match: /bhunaksha|jharbhunaksha|bhu-naksha|bhunakshha/i,
      // Responses carry plotNo / has_data / an info blob with the area.
      plotCapture: 'jquery-ajax',
      areaPattern: /क्षेत्रफल\s*:?\s*([^\n<]+)/,
    },
    {
      id: 'mahabhunakasha',
      label: 'MahaBhunakasha (Maharashtra)',
      match: /mahabhunakasha|mahabhumi/i,
      plotCapture: 'jquery-ajax',
      areaPattern: /(?:क्षेत्र|Area)\s*:?\s*([^\n<]+)/i,
    },
    {
      id: 'dishaank',
      label: 'Dishaank (Karnataka)',
      match: /dishaank|landrecords\.karnataka/i,
      plotCapture: 'none',
    },
    {
      id: 'banglarbhumi',
      label: 'Banglarbhumi (West Bengal)',
      match: /banglarbhumi/i,
      plotCapture: 'none',
    },
    {
      id: 'generic',
      label: 'Generic GIS / cadastral viewer',
      match: /.*/,
      plotCapture: 'none',
    },
  ];

  function identifyPortal(host) {
    const h = String(host || '');
    for (const p of PORTALS) if (p.match.test(h)) return p;
    return PORTALS[PORTALS.length - 1];
  }

  /* =====================================================================
   * ENTRY POINT
   * =================================================================== */
  function createAdapter(win, doc, opts) {
    const o = opts || {};
    const found = o.mapObject
      ? { kind: o.kind || null, mapObject: o.mapObject, foundAs: 'supplied' }
      : findMapInstance(win);
    if (!found) {
      return {
        ok: false,
        error: 'No supported map found on this page. This extension understands OpenLayers, Leaflet, MapLibre, Mapbox GL and Google Maps. If the map is inside an iframe, open that frame directly and try again.',
      };
    }
    let kind = found.kind;
    if (!kind) {
      for (const k of DETECTION_ORDER) if (SIGNATURES[k](found.mapObject)) { kind = k; break; }
    }
    const factory = FACTORIES[kind];
    if (!factory) return { ok: false, error: `Found a map object but could not classify it (${kind || 'unknown'}).` };

    const adapter = attachCanvasPixelHelpers(factory(found.mapObject, win, doc));
    adapter.foundAs = found.foundAs;
    adapter.portal = identifyPortal(safe(() => win.location && win.location.hostname, '') || '');
    return { ok: true, adapter };
  }

  // Collected once and handed to the CRS layer, which decides what it can
  // conclude. Kept separate so detection logic stays pure and testable.
  function collectCrsHints(adapter, win) {
    return {
      epsgCode: safe(() => adapter.getProjectionCode()),
      host: safe(() => win.location && win.location.hostname, '') || '',
      pageText: safe(() => {
        const t = win.document && win.document.body ? win.document.body.innerText : '';
        return String(t || '').slice(0, 4000);
      }, '') || '',
      tileUrls: safe(() => adapter.getTileUrls(), []) || [],
      region: 'india',
      coordsAreLonLat: !!adapter.coordsAreLonLat,
    };
  }

  return {
    findMapInstance, createAdapter, collectCrsHints, attachCanvasPixelHelpers,
    identifyPortal, PORTALS, SIGNATURES, DETECTION_ORDER, COMMON_MAP_GLOBALS,
    makeOpenLayersAdapter, makeLeafletAdapter, makeMapLibreAdapter, makeGoogleAdapter,
  };
});
