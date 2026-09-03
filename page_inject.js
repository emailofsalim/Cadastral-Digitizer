/* =========================================================================
 * BhuNaksha / Cadastral Digitizer v15 — page-context orchestrator.
 * -------------------------------------------------------------------------
 * Runs in the PAGE world because it needs the site's own map object. All
 * geometry, projection, tracing and export logic lives in lib/*.js, which are
 * pure and tested; this file is UI, gestures and glue.
 *
 * THE TWO BIGGEST CHANGES FROM v14
 *
 * 1. THE MAP STAYS FULLY INTERACTIVE. v13/v14 set the overlay to
 *    pointer-events:auto whenever a mode was armed, which swallowed every
 *    mouse event — so you could not pan or zoom while digitising or while
 *    placing control points. The overlay is now permanently
 *    pointer-events:none, and gestures are read from the map container in the
 *    capture phase, intercepted ONLY when a drag actually grabs a handle.
 *    A tap (movement under a few pixels) is an action; a drag is a pan. So
 *    panning and zooming work in every mode, always.
 *
 * 2. CONTROL POINTS ARE DRAGGABLE MARKERS, AT ANY ZOOM. v14's two-click
 *    gesture forced a zoom choreography, hijacked the view, and gave one shot
 *    at precision. Now each GCP is a persistent handle: zoom in as far as the
 *    imagery allows, pan freely, and nudge it until it is right. The fit and
 *    its residuals update live as you drag.
 * ========================================================================= */
(() => {
  'use strict';

  /* Developed by Md Salim Ansari. MIT licensed — see LICENSE. */
  const VERSION = '17.0.0';
  const WIDGET_ID = 'bnd15-widget';
  const STYLE_ID = 'bnd15-style';
  const OVERLAY_ID = 'bnd15-overlay';
  const PILL_ID = 'bnd15-pill';
  const TOAST_ID = 'bnd15-toasts';
  const SETTINGS_LS_KEY = 'bnd15.settings';
  const PROJECTS_LS_KEY = 'bnd15.projects';
  const SESSION_SS_KEY = 'bnd15.session';
  const TAP_SLOP_PX = 4;

  if (window.__BND15_ACTIVE__) {
    window.dispatchEvent(new CustomEvent('BND15_MSG', { detail: { type: 'BND15_SHOW_WIDGET' } }));
    return;
  }
  window.__BND15_ACTIVE__ = true;

  const Crs = window.BND_Crs;
  const GcpMath = window.BND_GcpMath;
  const Tracer = window.BND_Tracer;
  const Exp = window.BND_Export;
  const Adapters = window.BND_Adapters;
  const Topo = window.BND_Topology;
  const Viewport = window.BND_Viewport;
  const Raster = window.BND_Raster;
  const HistoryLib = window.BND_History;
  const Imp = window.BND_Importers;
  const GeomEdit = window.BND_GeomEdit;

  const missing = [
    ['lib/crs.js', Crs], ['lib/gcp_math.js', GcpMath], ['lib/tracer.js', Tracer],
    ['lib/exporters.js', Exp], ['lib/site_adapters.js', Adapters],
    ['lib/topology.js', Topo], ['lib/viewport.js', Viewport], ['lib/raster_workspace.js', Raster],
    ['lib/history.js', HistoryLib], ['lib/importers.js', Imp], ['lib/geom_edit.js', GeomEdit],
  ].filter(([, m]) => !m).map(([n]) => n);
  if (missing.length) {
    console.error('[Digitizer] required modules failed to load:', missing.join(', '));
    return;
  }

  const isFn = (v) => typeof v === 'function';
  const safe = (fn, fb) => { try { return fn(); } catch (e) { return fb === undefined ? null : fb; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = Exp.escapeHtml;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* =====================================================================
   * SETTINGS — persisted per origin, so they survive a reload. v13/v14 kept
   * these on a window global, which meant every slider reset on every visit.
   * =================================================================== */
  const DEFAULT_SETTINGS = {
    colorTolerance: 40,
    wallLuminanceThreshold: 100,
    simplifyPx: 2.0,
    leakProtectionRadius: 2,
    edgeGrowthRadius: 2,
    regionSizes: [900, 1400, 2000, 2800],
    scaleFactor: 1.0,
    // Zoom-for-precision is OFF by default and invoked from a button when
    // wanted. Automatically hijacking the view on every trace was intrusive:
    // it moved the map out from under the operator, cost seconds per action,
    // and on portals that reload imagery per view it caused visible churn.
    // Precision is worth having on demand, not imposed.
    precisionZoomBoost: 0,
    manualZoomBoost: 5,
    imageryWaitMs: 2500,
    // Consumed taps must not also reach the portal underneath. Without this,
    // tapping to trace on BhuNaksha ALSO re-selects a parcel, fires the site's
    // own popups, and can change the very view being digitised.
    blockSiteClicks: true,
    vertexGrabPx: 12,
    gcpGrabPx: 14,
    bboxLeakWarnPct: 8,
    // Start on the model that cannot deform a parcel. Cross-validation moves off
    // it as soon as the evidence justifies something richer.
    transformType: 'translation',
    autoRecommend: true,
    robustFitting: true,
    liveRefit: true,
    dxfGeorefMode: 'shift',
    // showValidityWarnings was removed in 16.3.0. It had no control and nothing
    // read it, so it promised control over something it never controlled. The
    // behaviour it named — flagging a self-intersecting or degenerate ring — is
    // a correctness signal and not the sort of thing that should be silenceable
    // by a checkbox anyway.
    applyScaleToAllExports: true,
    // Topology and clean-up
    snapEnabled: true,
    snapToleranceM: 0.5,
    // Editing a corner IS a statement about where that corner really is, so by
    // default it is recorded as one. This is what makes georeferencing a
    // by-product of ordinary digitising rather than a separate chore.
    autoGcpFromEdit: true,
    // A corner shared with a neighbour moves the neighbour too. Without this,
    // dragging one parcel's corner tears a shared boundary into a crossing.
    dragSharedCorners: true,
    // Say so when an operation creates an overlap that did not exist before.
    warnNewCrossings: true,
    regulariseAngleDeg: 8,
    regulariseCollinearM: 0.15,
    regulariseMaxShiftM: 1.5,
    autoRegulariseOnTrace: false,
    batchMinPixels: 400,
    batchMaxRegions: 200,
    // Image / PDF drawing underlay (brief §11). Rotation and opacity are
    // display properties of the sheet; `locked` stops a stray drag moving a
    // sheet that has been calibrated, which is the expensive mistake.
    drawingOpacity: 1,
    drawingRotationDeg: 0,
    drawingLocked: false,
    // Assumed scan resolution for RF calibration (brief §12). An RF alone
    // cannot give a ground scale, so this is asked for rather than assumed
    // silently — 300 dpi is only the starting value in the field.
    scanDpi: 300,
    // Which collapsible sections start open. The map is the point of the
    // screen, so most of the panel starts closed (brief §7). Import and Export
    // are not in this list because they are not sections — they are two of the
    // three permanent buttons, and their menus open from those.
    openSections: ['workflow'],
  };

  function loadSettings() {
    const s = Object.assign({}, DEFAULT_SETTINGS);
    const raw = safe(() => window.localStorage.getItem(SETTINGS_LS_KEY));
    if (raw) {
      const parsed = safe(() => JSON.parse(raw), null);
      if (parsed && typeof parsed === 'object') {
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (parsed[k] !== undefined) s[k] = parsed[k];
        }
      }
    }
    return s;
  }
  const S = loadSettings();
  function saveSettings() {
    safe(() => window.localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(S)));
  }

  /* =====================================================================
   * STATE
   * =================================================================== */
  const st = {
    mode: 'idle',            // idle | trace | draw | edit | gcp
    traceSubmode: 'fill',
    shapes: [],
    nextShapeId: 1,
    drawPoints: [],
    drawUndo: [],
    drawRedo: [],
    editShapeId: null,
    gcps: [],                // { id, shapeId, vertexIndex, source, target, enabled }
    nextGcpId: 1,
    gcpFit: null,
    gcpRecommendation: null,
    backups: {},             // shapeId -> original points
    pickedColor: null,
    plotNo: null,
    plotArea: null,
    plotBbox: null,
    busy: false,
    lastWarning: null,
    crs: null,
    crsDetection: null,
    adapter: null,
    activeGcpId: null,
    projectName: '',
    quality: null,
    // Explicit two-step control-point pairing: choose the vertex, then capture
    // where it really is.
    gcpStage: 'pickVertex',      // 'pickVertex' | 'placeTarget'
    gcpSelection: null,          // { shapeId, vertexIndex }
    lastCapture: null,           // { source, target, lonLat, shift } for readout
    showPreview: true,
    // Draw the pre-shift outline of the selected parcel, so a correction can be
    // compared against what it replaced (brief §4).
    showOriginals: true,
    // Raster workspace (image / PDF page). When active, coordinates are image
    // pixels until georeferencing says otherwise.
    workspace: null,             // the raster adapter, when one is open
    mapAdapter: null,            // the live-map adapter, kept for restoring
    georef: null,                // { fit, crs, rms, looRms, residuals } pixel -> CRS
    georefPoints: [],            // [{ id, pixel:[x,y], world:[x,y], enabled }]
    nextGeorefId: 1,
    georefPick: null,            // pixel awaiting a typed world coordinate
    georefCrs: null,             // which CRS the typed coordinates are in
    /* ---- added in 17.0 ---------------------------------------------- */
    // The parcel every Edit operation acts on. Distinct from editShapeId,
    // which additionally means "show this shape's vertex handles".
    selectedShapeId: null,
    // Drawing scale for a raster sheet: RF or scale bar (brief §12, §13).
    // Never read from or written by the viewport — screen zoom and drawing
    // scale are different things (brief §26).
    calibration: null,
    calibrationPick: [],         // up to two pixels picked for a scale bar
    // A CSV waiting on the operator to confirm its format. Nothing is imported
    // until they do (brief §6, §17).
    csvDialog: null,
    // Which of the three main menus is open, if any (brief §1).
    openMenu: null,              // 'import' | 'export' | null
    importSummary: null,         // what the last import brought in
  };

  /* =====================================================================
   * TOASTS — v13/v14 used blocking alert() for every error, including ones
   * that fired during a drag.
   * =================================================================== */
  function toast(message, kind, ms) {
    let host = document.getElementById(TOAST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = TOAST_ID;
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'bnd15-toast ' + (kind || 'info');
    el.innerHTML = esc(message);
    host.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms || 4200);
  }
  const toastErr = (m) => toast(m, 'err', 6500);
  const toastOk = (m) => toast(m, 'ok');

  /* =====================================================================
   * ADAPTER + CRS BOOTSTRAP
   * =================================================================== */
  function bootAdapter() {
    const r = Adapters.createAdapter(window, document);
    if (!r.ok) return r;
    st.adapter = r.adapter;
    return r;
  }

  function detectCrs() {
    const A = st.adapter;
    if (!A) return null;
    const samples = [];
    const c = A.getCenter();
    if (c) samples.push(c);
    // A few spread samples make the magnitude classification robust.
    const el = A.getContainer();
    if (el && el.getBoundingClientRect) {
      const b = el.getBoundingClientRect();
      for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.5, 0.75]]) {
        const p = A.clientToMapCoord(b.left + b.width * fx, b.top + b.height * fy);
        if (p) samples.push(p);
      }
    }
    if (!samples.length) return null;
    const hints = Adapters.collectCrsHints(A, window);
    // A Leaflet/MapLibre adapter already hands back lon/lat, so short-circuit.
    if (hints.coordsAreLonLat) {
      st.crsDetection = {
        crs: { kind: 'geographic', datum: 'WGS84', label: 'WGS 84 geographic (lon/lat)' },
        confidence: 0.99, needsConfirmation: false, family: 'geographic',
        reasons: [`${A.label} reports coordinates as longitude/latitude directly, so no projection guess is needed.`],
        candidates: [],
      };
    } else {
      st.crsDetection = Crs.detectCrs(samples, hints);
    }
    st.crs = st.crsDetection.crs;
    return st.crsDetection;
  }

  /* In a raster workspace, stored geometry is IMAGE PIXELS. Georeferencing is a
   * pixel -> CRS transform applied on the way out, so nothing downstream has to
   * know which kind of source it came from. Keeping pixels as the stored form
   * also means re-georeferencing later does not compound earlier corrections.
   */
  const isWorkspace = () => !!st.workspace;
  const hasGeoref = () => !!(st.georef && st.georef.fit);
  const toCrsCoord = (p) => (hasGeoref() ? st.georef.fit.apply(p) : p);

  function toLonLat(p) {
    if (isWorkspace()) {
      if (!hasGeoref() || !st.georef.crs) return null;
      const w = st.georef.fit.apply(p);
      return Crs.toWgs84(w[0], w[1], st.georef.crs);
    }
    return st.crs ? Crs.toWgs84(p[0], p[1], st.crs) : null;
  }

  // Shapes as they should leave the extension: georeferenced if possible, and
  // otherwise honestly still in pixels.
  function shapesForExport() {
    if (!isWorkspace() || !hasGeoref()) return st.shapes;
    return st.shapes.map((s) => Object.assign({}, s, {
      points: s.points.map(toCrsCoord),
    }));
  }

  function scaleFactorAt(points) {
    if (!st.crs) return 1;
    const c = Exp.centroidOfRing(points) || points[0];
    return Crs.pointScaleFactor(c[0], c[1], st.crs);
  }

  // Ground area, honouring the CRS. Geographic coordinates get a geodesic
  // computation; projected ones get grid area corrected by the point scale.
  function groundAreaOf(points) {
    if (isWorkspace()) {
      if (!hasGeoref() || !st.georef.crs) {
        // A calibrated drawing scale converts pixel area to ground area even
        // with no survey control at all, which is the usual state of a scanned
        // cadastral sheet (brief §12). Without either, the only honest answer
        // is pixels squared.
        const cal = GeomEdit.pixelAreaToGround(Exp.gridArea(points), st.calibration);
        return cal != null ? cal : Exp.gridArea(points);
      }
      const world = points.map(toCrsCoord);
      if (st.georef.crs.kind === 'geographic') return Exp.geodesicArea(world);
      return Exp.groundAreaFromGrid(world, Crs.pointScaleFactor(world[0][0], world[0][1], st.georef.crs));
    }
    if (!st.crs) return Exp.gridArea(points);
    if (st.crs.kind === 'geographic') return Exp.geodesicArea(points);
    return Exp.groundAreaFromGrid(points, scaleFactorAt(points));
  }
  // px² only when nothing — neither georeferencing nor a calibrated drawing
  // scale — can turn a pixel into a ground distance.
  const areaUnit = () => (isWorkspace() && !hasGeoref() && !st.calibration ? 'px²' : 'm²');

  /* =====================================================================
   * PERSISTENCE
   * =================================================================== */
  /* A saved project must be able to rebuild the whole workspace, not just the
   * outlines (brief §19). Everything the session needs to come back fully
   * editable is written here; `schema` lets an older project still load, since
   * a file that cannot be reopened by the next release is worse than no save
   * format at all. */
  const PROJECT_SCHEMA = 2;

  function serialiseSession() {
    return {
      version: VERSION,
      schema: PROJECT_SCHEMA,
      shapes: st.shapes,
      nextShapeId: st.nextShapeId,
      gcps: st.gcps,
      nextGcpId: st.nextGcpId,
      backups: st.backups,
      plotNo: st.plotNo, plotArea: st.plotArea, plotBbox: st.plotBbox,
      crs: st.crs,
      projectName: st.projectName,
      // --- schema 2: the rest of the workspace ---
      georefPoints: st.georefPoints,
      nextGeorefId: st.nextGeorefId,
      georefCrs: st.georefCrs,
      georef: st.georef ? { crs: st.georef.crs, type: st.georef.type, count: st.georef.count } : null,
      calibration: st.calibration,
      drawing: {
        sourceName: isWorkspace() ? st.adapter.sourceName : null,
        sourceKind: isWorkspace() ? st.adapter.sourceKind : null,
        opacity: S.drawingOpacity,
        rotationDeg: S.drawingRotationDeg,
        locked: S.drawingLocked,
        scanDpi: S.scanDpi,
      },
      settings: {
        transformType: S.transformType,
        dxfGeorefMode: S.dxfGeorefMode,
        scaleFactor: S.scaleFactor,
        snapToleranceM: S.snapToleranceM,
      },
      savedAt: Date.now(),
    };
  }
  function restoreSession(data) {
    if (!data || !Array.isArray(data.shapes)) return false;
    st.shapes = data.shapes;
    st.nextShapeId = data.nextShapeId || (Math.max(0, ...data.shapes.map((s) => +s.id || 0)) + 1);
    st.gcps = Array.isArray(data.gcps) ? data.gcps : [];
    st.nextGcpId = data.nextGcpId || (Math.max(0, ...st.gcps.map((g) => +g.id || 0)) + 1);
    st.backups = data.backups || {};
    if (data.plotNo) st.plotNo = data.plotNo;
    if (data.plotArea) st.plotArea = data.plotArea;
    if (data.plotBbox) st.plotBbox = data.plotBbox;
    if (data.crs) st.crs = data.crs;
    st.projectName = data.projectName || '';

    // Schema 1 projects carry none of the following, and must still load —
    // hence every field is optional rather than required.
    if (Array.isArray(data.georefPoints)) {
      st.georefPoints = data.georefPoints;
      st.nextGeorefId = data.nextGeorefId || (Math.max(0, ...st.georefPoints.map((g) => +g.id || 0)) + 1);
    }
    if (data.georefCrs) st.georefCrs = data.georefCrs;
    st.calibration = data.calibration || null;
    if (data.drawing) {
      if (data.drawing.opacity != null) S.drawingOpacity = data.drawing.opacity;
      if (data.drawing.rotationDeg != null) S.drawingRotationDeg = data.drawing.rotationDeg;
      if (data.drawing.locked != null) S.drawingLocked = !!data.drawing.locked;
      if (data.drawing.scanDpi != null) S.scanDpi = data.drawing.scanDpi;
    }
    if (data.settings) {
      for (const k of ['transformType', 'dxfGeorefMode', 'scaleFactor', 'snapToleranceM']) {
        if (data.settings[k] !== undefined) S[k] = data.settings[k];
      }
    }
    // The fit is recomputed from the restored points rather than trusted from
    // the file: a stored fit could disagree with the geometry it claims to
    // describe if either were edited by hand.
    recomputeGeoref();
    st.selectedShapeId = null;
    return true;
  }

  /* Collapsible sections (brief §7). Open/closed is a setting so the panel
   * comes back the way it was left, and the map stays the largest thing on
   * screen. */
  function sectionOpen(key) {
    return Array.isArray(S.openSections) && S.openSections.includes(key);
  }
  function toggleSection(key, open) {
    const list = Array.isArray(S.openSections) ? S.openSections.slice() : [];
    const i = list.indexOf(key);
    if (open && i < 0) list.push(key);
    if (!open && i >= 0) list.splice(i, 1);
    S.openSections = list;
    saveSettings();
  }
  /* =====================================================================
   * UNDO / REDO
   * ---------------------------------------------------------------------
   * The undoable document is the geometry and the evidence for it: shapes,
   * control points, and the pre-correction backups. Deliberately NOT included
   * are the view (zoom, centre), the mode, and transient pairing state — undo
   * should put the parcels back, not fight the operator over where they are
   * looking.
   * =================================================================== */
  const UNDOABLE_KEYS = ['shapes', 'nextShapeId', 'gcps', 'nextGcpId', 'backups',
    'georefPoints', 'nextGeorefId', 'georef', 'calibration'];

  const history = HistoryLib.createHistory({
    read: () => {
      const doc = {};
      for (const k of UNDOABLE_KEYS) doc[k] = st[k];
      return doc;
    },
    write: (doc) => {
      for (const k of UNDOABLE_KEYS) if (k in doc) st[k] = doc[k];
      // Anything derived from the geometry is now stale and must be recomputed
      // rather than left on screen describing a document that no longer exists.
      st.quality = null;
      st.lastCapture = null;
      clearGcpSelection(true);
      if (!findShape(st.editShapeId)) st.editShapeId = null;
      for (const s of st.shapes) refreshShapeMetrics(s);
      recomputeFit();
    },
  });

  /* Record the state before a mutating operation. `label` completes the sentence
   * "Undo ___", so it reads as what is about to happen. */
  function commit(label) { history.commit(label); }
  function dropCommit() { history.drop(); }

  function undoAction() {
    if (!history.canUndo()) return toast('Nothing left to undo.', 'info', 2200);
    const label = history.undo();
    autosave(); draw(); renderWidget();
    toastOk(`Undone: ${label}`);
  }
  function redoAction() {
    if (!history.canRedo()) return toast('Nothing to redo.', 'info', 2200);
    const label = history.redo();
    autosave(); draw(); renderWidget();
    toastOk(`Redone: ${label}`);
  }

  /* =====================================================================
   * SESSION RESET
   * ---------------------------------------------------------------------
   * There were three separate ad-hoc reset lines in v16.2, each clearing a
   * different subset of the state, which is why control points survived a
   * "clear everything": the geometry went and the evidence stayed. One
   * function now owns it, so a field added to the state cannot be forgotten by
   * two callers out of three.
   * =================================================================== */
  function clearSessionState(opts) {
    const o = opts || {};
    st.shapes = []; st.nextShapeId = 1;
    st.gcps = []; st.nextGcpId = 1;
    st.gcpFit = null; st.gcpRecommendation = null;
    st.backups = {};
    st.lastCapture = null; st.activeGcpId = null;
    st.gcpStage = 'pickVertex'; st.gcpSelection = null;
    st.drawPoints = []; st.drawUndo = []; st.drawRedo = [];
    st.editShapeId = null;
    st.selectedShapeId = null;
    st.quality = null;
    st.lastWarning = null;
    st.mode = 'idle';
    st.csvDialog = null;
    st.importSummary = null;
    st.openMenu = null;
    // Georeferencing points and the drawing scale both belong to an open raster
    // sheet. They go when the sheet goes, and on an explicit full reset, but not
    // otherwise.
    if (o.keepGeoref !== true) {
      st.georef = null; st.georefPoints = []; st.nextGeorefId = 1;
      st.georefPick = null; st.georefCrs = null;
      st.calibration = null; st.calibrationPick = [];
    }
    // Undo across a deliberate wipe would let it be silently half-reversed.
    if (o.keepHistory !== true) history.clear();
  }

  /* What a full reset is about to destroy, itemised, so the confirm dialog can
   * state it instead of asking the operator to accept an unspecified loss. */
  function describeSessionContents() {
    const bits = [];
    if (st.shapes.length) bits.push(`${st.shapes.length} shape(s)`);
    if (st.gcps.length) bits.push(`${st.gcps.length} control point(s)`);
    if (st.georefPoints.length) bits.push(`${st.georefPoints.length} georeference point(s)`);
    if (st.calibration) bits.push('the drawing scale calibration');
    const backups = Object.keys(st.backups).length;
    if (backups) bits.push(`${backups} revertable original(s)`);
    if (st.drawPoints.length) bits.push(`${st.drawPoints.length} corner(s) of an unfinished polygon`);
    return bits;
  }

  function autosave() {
    // Any change to the geometry invalidates a quality report, and a stale
    // grade is worse than none — it would vouch for shapes that have moved.
    st.quality = null;
    safe(() => window.sessionStorage.setItem(SESSION_SS_KEY, JSON.stringify(serialiseSession())));
    reportCount();
  }
  function loadAutosave() {
    const raw = safe(() => window.sessionStorage.getItem(SESSION_SS_KEY));
    return raw ? safe(() => JSON.parse(raw), null) : null;
  }
  function listProjects() {
    const raw = safe(() => window.localStorage.getItem(PROJECTS_LS_KEY));
    const obj = raw ? safe(() => JSON.parse(raw), null) : null;
    return (obj && typeof obj === 'object') ? obj : {};
  }
  function saveProject(name) {
    if (!name) return false;
    const all = listProjects();
    all[name] = serialiseSession();
    const ok = safe(() => { window.localStorage.setItem(PROJECTS_LS_KEY, JSON.stringify(all)); return true; }, false);
    if (ok) st.projectName = name;
    return ok;
  }
  function reportCount() {
    safe(() => window.dispatchEvent(new CustomEvent('BND15_COUNT_EVT', { detail: { count: st.shapes.length } })));
  }

  /* =====================================================================
   * PLOT METADATA CAPTURE — only for portals that expose it.
   * =================================================================== */
  let onPlotUpdate = null;
  function installPlotCapture() {
    const portal = st.adapter && st.adapter.portal;
    if (!portal || portal.plotCapture !== 'jquery-ajax') return;
    const tryPatch = () => {
      const $ = window.jQuery;
      if (!$ || $.__bnd15Patched || !$.ajax) return false;
      $.__bnd15Patched = true;
      const orig = $.ajax;
      $.ajax = function (options) {
        const opt = typeof options === 'string' ? { url: options } : (options || {});
        const prev = opt.success;
        opt.success = function (resp) {
          safe(() => {
            if (resp && resp.plotNo != null) {
              st.plotNo = String(resp.plotNo);
              const m = String(resp.info || '').match(portal.areaPattern || /$^/);
              st.plotArea = m ? m[1].trim() : null;
              if ([resp.xmin, resp.ymin, resp.xmax, resp.ymax].every((v) => typeof v === 'number' && isFinite(v))) {
                st.plotBbox = { xmin: resp.xmin, ymin: resp.ymin, xmax: resp.xmax, ymax: resp.ymax };
              }
              if (isFn(onPlotUpdate)) onPlotUpdate();
            }
          });
          if (prev) return prev.apply(this, arguments);
        };
        return orig.call(this, opt);
      };
      return true;
    };
    if (tryPatch()) return;
    const t = setInterval(() => { if (tryPatch()) clearInterval(t); }, 300);
    setTimeout(() => clearInterval(t), 20000);
  }

  /* =====================================================================
   * OVERLAY — always pointer-events:none. Every gesture is read from the map
   * container instead, which is what keeps panning and zooming alive.
   * =================================================================== */
  let overlayTimer = null, offRender = null;

  function ensureOverlay() {
    let ov = document.getElementById(OVERLAY_ID);
    const host = st.adapter && st.adapter.getContainer();
    if (!host) return null;
    if (!ov) {
      ov = document.createElement('canvas');
      ov.id = OVERLAY_ID;
      ov.style.cssText = 'position:fixed;z-index:2147483644;pointer-events:none;';
      document.body.appendChild(ov);
    }
    syncOverlay();
    if (!overlayTimer) {
      overlayTimer = setInterval(syncOverlay, 500);
      window.addEventListener('scroll', syncOverlay, true);
      window.addEventListener('resize', syncOverlay);
    }
    if (!offRender && st.adapter.onRender) {
      offRender = st.adapter.onRender(() => draw());
    }
    return ov;
  }

  function syncOverlay() {
    const ov = document.getElementById(OVERLAY_ID);
    const host = st.adapter && st.adapter.getContainer();
    if (!ov || !host || !host.getBoundingClientRect) return;
    const r = host.getBoundingClientRect();
    ov.style.left = r.left + 'px';
    ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
    draw();
  }

  // Map coordinate -> overlay canvas pixel.
  function toOverlayPx(mapPt) {
    const A = st.adapter;
    const ov = document.getElementById(OVERLAY_ID);
    if (!A || !ov) return null;
    const client = A.mapCoordToClient(mapPt[0], mapPt[1]);
    if (!client) return null;
    const r = ov.getBoundingClientRect();
    const dpr = ov.width / (r.width || 1);
    return [(client[0] - r.left) * dpr, (client[1] - r.top) * dpr];
  }

  function draw() {
    const ov = document.getElementById(OVERLAY_ID);
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    const r = ov.getBoundingClientRect();
    const dpr = ov.width / (r.width || 1);

    for (const shape of st.shapes) {
      const editing = st.editShapeId === shape.id;
      const selected = st.selectedShapeId === shape.id;
      const pts = shape.points.map(toOverlayPx).filter(Boolean);
      if (pts.length < 2) continue;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      const bad = shape.validity && !shape.validity.valid;
      // Imported geometry is drawn in its own colour so the layer model is
      // visible on the map, not only in the panel (brief §24).
      const imported = shape.source === 'imported';
      ctx.fillStyle = editing ? 'rgba(124,58,237,0.18)'
        : (bad ? 'rgba(249,115,22,0.18)'
          : (imported ? 'rgba(56,189,248,0.15)' : 'rgba(255,45,85,0.15)'));
      ctx.fill();
      ctx.strokeStyle = editing ? '#7c3aed'
        : (bad ? '#f97316' : (imported ? '#38bdf8' : '#ff2d55'));
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
      // The selected parcel is ringed, so "which one will Rotate act on?" is
      // answered on the map rather than guessed from the panel.
      if (selected) {
        ctx.save();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 3.5 * dpr;
        ctx.setLineDash([9 * dpr, 5 * dpr]);
        ctx.stroke();
        ctx.restore();
        const c = GeomEdit.ringCentroid(shape.points);
        const cp = c && toOverlayPx(c);
        if (cp) {
          // The centroid is the pivot Rotate and Scale work about, so it is
          // marked rather than left implicit.
          ctx.save();
          ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2 * dpr;
          ctx.beginPath(); ctx.arc(cp[0], cp[1], 5 * dpr, 0, 7); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cp[0] - 9 * dpr, cp[1]); ctx.lineTo(cp[0] + 9 * dpr, cp[1]);
          ctx.moveTo(cp[0], cp[1] - 9 * dpr); ctx.lineTo(cp[0], cp[1] + 9 * dpr);
          ctx.stroke();
          ctx.restore();
        }
      }
      if (editing) {
        for (const [x, y] of pts) {
          ctx.beginPath(); ctx.arc(x, y, 5 * dpr, 0, 7);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 2 * dpr; ctx.stroke();
        }
      }
    }

    // In-progress manual draw
    if (st.mode === 'draw' && st.drawPoints.length) {
      const pts = st.drawPoints.map(toOverlayPx).filter(Boolean);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y] of pts) {
        ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, 7);
        ctx.fillStyle = '#22d3ee'; ctx.fill();
      }
    }

    // ORIGINAL position of a shifted parcel, so corrected and uncorrected can
    // be compared on screen rather than taken on trust (brief §4). Drawn only
    // for the selected parcel, or the whole session would become unreadable
    // once several have been moved.
    if (st.showOriginals) {
      for (const shape of st.shapes) {
        const orig = st.backups[shape.id];
        if (!orig || (st.selectedShapeId != null && st.selectedShapeId !== shape.id)) continue;
        const pts = orig.map(toOverlayPx).filter(Boolean);
        if (pts.length < 3) continue;
        ctx.save();
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }

    // The two ends of a scale-bar calibration, and the line between them.
    if (isWorkspace() && st.calibrationPick.length) {
      const marks = st.calibrationPick.map(toOverlayPx).filter(Boolean);
      ctx.save();
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2.5 * dpr;
      if (marks.length === 2) {
        ctx.beginPath();
        ctx.moveTo(marks[0][0], marks[0][1]);
        ctx.lineTo(marks[1][0], marks[1][1]);
        ctx.stroke();
      }
      for (const m of marks) {
        ctx.beginPath();
        ctx.moveTo(m[0], m[1] - 10 * dpr); ctx.lineTo(m[0], m[1] + 10 * dpr);
        ctx.moveTo(m[0] - 10 * dpr, m[1]); ctx.lineTo(m[0] + 10 * dpr, m[1]);
        ctx.stroke();
      }
      ctx.restore();
    }

    // PREVIEW of the corrected geometry, before anything is committed. Seeing
    // where a correction will actually put the boundary is the difference
    // between reviewing it and hoping.
    if (st.showPreview && st.gcpFit && st.gcpFit.ok) {
      const scopeIds = new Set(st.gcps.filter((g) => g.enabled !== false && g.shapeId != null).map((g) => g.shapeId));
      const targets = scopeIds.size ? st.shapes.filter((s) => scopeIds.has(s.id)) : st.shapes;
      const preview = GcpMath.previewCorrected(targets, st.gcpFit.fit);
      ctx.save();
      ctx.setLineDash([7 * dpr, 5 * dpr]);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2 * dpr;
      for (const p of preview) {
        const pts = p.points.map(toOverlayPx).filter(Boolean);
        if (pts.length < 3) continue;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Georeference points on a raster: known real-world positions, marked where
    // they sit on the image.
    if (isWorkspace()) {
      for (const p of st.georefPoints) {
        const px = toOverlayPx(p.pixel);
        if (!px) continue;
        const off = p.enabled === false;
        ctx.save();
        ctx.beginPath(); ctx.arc(px[0], px[1], 7 * dpr, 0, 7);
        ctx.fillStyle = off ? '#64748b' : '#a855f7';
        ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = `${10 * dpr}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String(p.id), px[0], px[1] + 3.5 * dpr);
        ctx.restore();
      }
      if (st.georefPick) {
        const px = toOverlayPx(st.georefPick);
        if (px) {
          ctx.save();
          ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2.5 * dpr;
          ctx.beginPath(); ctx.arc(px[0], px[1], 11 * dpr, 0, 7); ctx.stroke();
          const arm = 8 * dpr;
          ctx.beginPath();
          ctx.moveTo(px[0] - arm, px[1]); ctx.lineTo(px[0] + arm, px[1]);
          ctx.moveTo(px[0], px[1] - arm); ctx.lineTo(px[0], px[1] + arm);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // The vertex nominated for pairing, while awaiting its true position.
    if (st.mode === 'gcp' && st.gcpSelection) {
      const shape = findShape(st.gcpSelection.shapeId);
      const p = shape && shape.points[st.gcpSelection.vertexIndex];
      const px = p && toOverlayPx(p);
      if (px) {
        ctx.save();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2.5 * dpr;
        ctx.beginPath(); ctx.arc(px[0], px[1], 13 * dpr, 0, 7); ctx.stroke();
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.arc(px[0], px[1], 24 * dpr, 0, 7); ctx.stroke();
        ctx.setLineDash([]);
        const arm = 9 * dpr;
        ctx.beginPath();
        ctx.moveTo(px[0] - arm, px[1]); ctx.lineTo(px[0] + arm, px[1]);
        ctx.moveTo(px[0], px[1] - arm); ctx.lineTo(px[0], px[1] + arm);
        ctx.stroke();
        ctx.restore();
      }
    }

    // GCP markers: source (where the geometry thinks the corner is) linked to
    // target (where the user says it really is).
    const outliers = new Set((st.gcpFit && st.gcpFit.outliers) || []);
    const enabled = st.gcps.filter((g) => g.enabled !== false);
    st.gcps.forEach((g) => {
      const sp = toOverlayPx(g.source);
      const tp = toOverlayPx(g.target);
      if (!sp || !tp) return;
      const idxAmongEnabled = enabled.indexOf(g);
      const isOutlier = idxAmongEnabled >= 0 && outliers.has(idxAmongEnabled);
      const active = st.activeGcpId === g.id;
      const off = g.enabled === false;

      ctx.strokeStyle = off ? 'rgba(148,163,184,0.6)' : (isOutlier ? '#ef4444' : '#facc15');
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(sp[0], sp[1]); ctx.lineTo(tp[0], tp[1]); ctx.stroke();
      ctx.setLineDash([]);

      // Source: hollow square.
      ctx.strokeStyle = off ? '#94a3b8' : '#38bdf8';
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(sp[0] - 4 * dpr, sp[1] - 4 * dpr, 8 * dpr, 8 * dpr);

      // Target: filled grab handle.
      const rad = (active ? 9 : 7) * dpr;
      ctx.beginPath(); ctx.arc(tp[0], tp[1], rad, 0, 7);
      ctx.fillStyle = off ? '#64748b' : (isOutlier ? '#ef4444' : '#10b981');
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke();
      if (active) {
        ctx.beginPath(); ctx.arc(tp[0], tp[1], rad + 6 * dpr, 0, 7);
        ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2 * dpr; ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${10 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(g.id), tp[0], tp[1] + 3.5 * dpr);
    });
  }

  /* =====================================================================
   * GESTURES — the change that keeps the map usable.
   * =================================================================== */
  let gesture = null;
  let gestureHost = null;
  let refitScheduled = false;

  function hitTestGcp(clientX, clientY) {
    const A = st.adapter;
    if (!A) return null;
    const tol = Number(S.gcpGrabPx) || 14;
    let best = null, bestD = Infinity;
    for (const g of st.gcps) {
      const c = A.mapCoordToClient(g.target[0], g.target[1]);
      if (!c) continue;
      const d = Math.hypot(c[0] - clientX, c[1] - clientY);
      if (d <= tol && d < bestD) { bestD = d; best = { kind: 'gcp', gcp: g }; }
    }
    return best;
  }

  function hitTestVertex(clientX, clientY) {
    if (st.mode !== 'edit' || !st.editShapeId) return null;
    const A = st.adapter;
    const shape = findShape(st.editShapeId);
    if (!A || !shape) return null;
    const tol = Number(S.vertexGrabPx) || 12;
    let best = -1, bestD = Infinity;
    shape.points.forEach((p, i) => {
      const c = A.mapCoordToClient(p[0], p[1]);
      if (!c) return;
      const d = Math.hypot(c[0] - clientX, c[1] - clientY);
      if (d <= tol && d < bestD) { bestD = d; best = i; }
    });
    return best >= 0 ? { kind: 'vertex', shapeId: shape.id, index: best } : null;
  }

  /* Grab the whole parcel for a bodily move (brief §3). Only in move mode, and
   * only on the selected parcel or one the tap lands inside — so an ordinary
   * drag anywhere else is still a map pan, which is what keeps §26's two
   * operations from being confusable. */
  function hitTestShapeForMove(clientX, clientY) {
    if (st.mode !== 'move') return null;
    const shape = hitTestShapeBody(clientX, clientY);
    if (!shape) return null;
    return { kind: 'shape', shapeId: shape.id };
  }

  function onPointerDown(e) {
    if (e.button !== 0 || st.busy) return;
    gesture = { x0: e.clientX, y0: e.clientY, moved: false, drag: null, alt: e.altKey };
    // Grabbing a handle must not pan the map, so this is the one case where the
    // event is intercepted. Everything else falls through to the map.
    const grab = hitTestGcp(e.clientX, e.clientY) || hitTestVertex(e.clientX, e.clientY)
      || hitTestShapeForMove(e.clientX, e.clientY);
    if (grab) {
      if (grab.kind === 'shape') {
        const shape = findShape(grab.shapeId);
        const start = st.adapter.clientToMapCoord(e.clientX, e.clientY);
        if (!shape || !start) { gesture.drag = null; return; }
        st.selectedShapeId = shape.id;
        grab.start = start;
        grab.origin = shape.points.map((p) => p.slice());
        grab.crossBefore = crossingSnapshot();
        gesture.drag = grab;
        commit(`move shape ${shape.id}`);
        e.stopPropagation();
        e.preventDefault();
        draw();
        return;
      }
    }
    if (grab) {
      gesture.drag = grab;
      if (grab.kind === 'gcp') {
        st.activeGcpId = grab.gcp.id;
        grab.origin = grab.gcp.target.slice();
        commit(`move control point ${grab.gcp.id}`);
      } else {
        const shape = findShape(grab.shapeId);
        // Where the corner was before the drag. This is the whole basis of
        // auto-GCP: the operator dragging a corner to where it really belongs is
        // exactly the same statement as tagging a control point, so it should
        // count as one instead of being thrown away.
        grab.origin = shape ? shape.points[grab.index].slice() : null;
        grab.crossBefore = crossingSnapshot();
        commit('move a vertex');
      }
      e.stopPropagation();
      e.preventDefault();
      draw();
    }
  }

  function onPointerMove(e) {
    if (!gesture) return;
    if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > TAP_SLOP_PX) gesture.moved = true;
    if (!gesture.drag) return;
    e.stopPropagation();
    e.preventDefault();
    const pt = st.adapter.clientToMapCoord(e.clientX, e.clientY);
    if (!pt) return;
    if (gesture.drag.kind === 'gcp') {
      gesture.drag.gcp.target = pt;
      if (S.liveRefit && !refitScheduled) {
        refitScheduled = true;
        requestAnimationFrame(() => { refitScheduled = false; recomputeFit(true); renderWidget(); });
      }
    } else if (gesture.drag.kind === 'shape') {
      // The whole parcel follows the pointer. Recomputed from the ORIGINAL
      // ring and the total pointer delta each frame rather than accumulated
      // per-frame, so rounding cannot creep in over a long drag.
      const shape = findShape(gesture.drag.shapeId);
      if (shape) {
        const dx = pt[0] - gesture.drag.start[0];
        const dy = pt[1] - gesture.drag.start[1];
        shape.points = gesture.drag.origin.map((p) => [p[0] + dx, p[1] + dy]);
        gesture.drag.delta = [dx, dy];
      }
    } else {
      const shape = findShape(gesture.drag.shapeId);
      if (shape) shape.points[gesture.drag.index] = pt;
    }
    draw();
  }

  // Swallow the click/mouse events the browser fires AFTER a pointerup we have
  // consumed. Cancelling pointerup alone is not enough: the portal's handlers
  // are usually on 'click', which is synthesised afterwards from the same
  // gesture, so without this a tap to trace also re-selects a parcel on the
  // site underneath.
  let suppressUntil = 0;
  function swallowSyntheticClick(e) {
    if (Date.now() > suppressUntil) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  function armClickSuppression() {
    if (!S.blockSiteClicks) return;
    suppressUntil = Date.now() + 700;
  }

  function onPointerUp(e) {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.drag) {
      e.stopPropagation();
      armClickSuppression();
      // A grab that never moved changed nothing, so it must not leave an undo
      // step that appears to be reversible work.
      if (!g.moved) dropCommit();
      if (g.drag.kind === 'gcp') { recomputeFit(); }
      else if (g.drag.kind === 'shape') {
        const shape = findShape(g.drag.shapeId);
        if (shape && g.moved && g.drag.delta) {
          // The drag already moved the points; this records WHAT was done so
          // the correction stays reviewable and resettable (brief §4). The
          // backup captures the pre-drag ring, not the mid-drag one.
          if (!st.backups[shape.id]) st.backups[shape.id] = g.drag.origin.map((p) => p.slice());
          shape.shift = GeomEdit.composeShift(shape.shift || GeomEdit.identityShift(),
            GeomEdit.shiftForTranslation(g.drag.delta[0], g.drag.delta[1]));
          refreshShapeMetrics(shape);
          reportNewCrossings(g.drag.crossBefore, 'Moving that parcel');
          const d = Math.hypot(g.drag.delta[0], g.drag.delta[1]);
          toastOk(`Shape ${shape.id} moved ${d.toFixed(2)} ${areaUnit() === 'px²' ? 'px' : 'm'}. Ctrl+Z undoes it; ↺ resets it completely.`);
        } else if (shape) {
          refreshShapeMetrics(shape);
        }
      } else {
        const shape = findShape(g.drag.shapeId);
        if (shape) {
          if (g.moved) {
            // Neighbours first: they must move before the crossing check runs,
            // or a properly-shared corner would be reported as a new crossing.
            keepNeighboursConsistent(shape, g.drag.index, g.drag.origin);
            noteVertexMoved(shape, g.drag.index, g.drag.origin);
          }
          refreshShapeMetrics(shape);
          if (g.moved) reportNewCrossings(g.drag.crossBefore, 'Moving that corner');
        }
      }
      autosave();
      renderWidget();
      draw();
      return;
    }
    // A tap, not a pan: only now does a mode action fire. When a tool is armed
    // the tap belongs to us, so the portal must not see it either.
    if (!g.moved) {
      if (st.mode !== 'idle' && !st.busy) {
        e.stopPropagation();
        e.preventDefault();
        armClickSuppression();
      }
      handleTap(e.clientX, e.clientY, g.alt);
    }
  }

  function installGestures() {
    const host = st.adapter && st.adapter.getContainer();
    if (!host || host === gestureHost) return;
    if (gestureHost) removeGestures();
    gestureHost = host;
    host.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    // Capture phase on the host, so these run before the portal's own handlers.
    for (const type of ['click', 'mouseup', 'mousedown', 'dblclick', 'contextmenu']) {
      host.addEventListener(type, swallowSyntheticClick, true);
    }
  }
  function removeGestures() {
    if (gestureHost) {
      gestureHost.removeEventListener('pointerdown', onPointerDown, true);
      for (const type of ['click', 'mouseup', 'mousedown', 'dblclick', 'contextmenu']) {
        gestureHost.removeEventListener(type, swallowSyntheticClick, true);
      }
    }
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
    gestureHost = null;
  }

  async function handleTap(clientX, clientY, altKey) {
    if (st.mode === 'idle' || st.busy) return;
    const A = st.adapter;
    if (st.mode === 'trace') {
      await runTrace(clientX, clientY);
    } else if (st.mode === 'draw') {
      let p = A.clientToMapCoord(clientX, clientY);
      if (!p) return toastErr('Could not read a map coordinate there.');
      // Snap to an existing boundary as you draw, so a parcel traced next to one
      // already digitised shares its edge exactly rather than nearly.
      if (S.snapEnabled && st.shapes.length) {
        const snap = Topo.snapPoint(p, st.shapes, Number(S.snapToleranceM) || 0.5);
        if (snap) {
          p = snap.point;
          toast(`Snapped to ${snap.kind === 'vertex' ? 'a corner' : 'an edge'} of shape ${snap.shapeId} (${snap.dist.toFixed(2)} m).`, 'info', 1800);
        }
      }
      pushDrawUndo();
      st.drawPoints.push(p);
      draw(); renderWidget();
    } else if (st.mode === 'georef') {
      beginGeorefPick(clientX, clientY);
    } else if (st.mode === 'calibrate') {
      pickCalibrationPoint(clientX, clientY);
    } else if (st.mode === 'select' || st.mode === 'move') {
      // Tapping picks the parcel every Edit operation will act on. In move
      // mode a tap selects and a drag moves, which is the same tap-versus-drag
      // rule the rest of the tool follows.
      const shape = hitTestShapeBody(clientX, clientY);
      if (!shape) {
        st.selectedShapeId = null;
        draw(); renderWidget();
        return toast('No parcel there. Tap inside a boundary to select it.', 'info', 3000);
      }
      st.selectedShapeId = shape.id;
      draw(); renderWidget();
      toast(`Selected ${shape.plotNo ? 'plot ' + shape.plotNo : 'shape ' + shape.id} — ${shape.points.length} corners, ${(shape.areaM2 || 0).toFixed(1)} ${areaUnit()}.`, 'info', 3500);
    } else if (st.mode === 'gcp') {
      if (st.gcpStage === 'placeTarget') {
        captureGcpTarget(clientX, clientY);
      } else if (altKey) {
        addLooseGcp(clientX, clientY);
      } else {
        const hit = findNearestVertex(clientX, clientY, (Number(S.gcpGrabPx) || 14) * 2);
        if (!hit) {
          return toast('No vertex close enough to that tap. Tap nearer a corner of a digitised boundary, pick one from the list below, or Alt+tap to place a loose control point.', 'warn', 6000);
        }
        selectGcpVertex(hit.shapeId, hit.vertexIndex);
      }
    } else if (st.mode === 'edit') {
      const shape = findShape(st.editShapeId);
      if (!shape) return;
      if (altKey) {
        const hit = hitTestVertex(clientX, clientY);
        if (hit && shape.points.length > 3) {
          commit('delete a vertex');
          shape.points.splice(hit.index, 1);
          dropGcpsForVertexRemoval(shape.id, hit.index);
          refreshShapeMetrics(shape); autosave(); draw(); renderWidget();
          toastOk('Vertex deleted.');
        } else if (hit) {
          toastErr('A polygon needs at least 3 vertices.');
        }
        return;
      }
      const ins = nearestEdgeInsert(shape, clientX, clientY);
      if (ins) {
        commit('insert a vertex');
        shape.points.splice(ins.after + 1, 0, ins.point);
        shiftGcpVertexIndices(shape.id, ins.after + 1, 1);
        refreshShapeMetrics(shape); autosave(); draw(); renderWidget();
      }
    }
  }

  function nearestEdgeInsert(shape, clientX, clientY) {
    const A = st.adapter;
    const tol = Number(S.vertexGrabPx) || 12;
    let bestD = Infinity, bestI = -1, bestPt = null;
    const n = shape.points.length;
    for (let i = 0; i < n; i++) {
      const a = A.mapCoordToClient(shape.points[i][0], shape.points[i][1]);
      const b = A.mapCoordToClient(shape.points[(i + 1) % n][0], shape.points[(i + 1) % n][1]);
      if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((clientX - a[0]) * dx + (clientY - a[1]) * dy) / len2;
      t = clamp(t, 0, 1);
      const d = Math.hypot(clientX - (a[0] + t * dx), clientY - (a[1] + t * dy));
      if (d < bestD) {
        bestD = d; bestI = i;
        const pa = shape.points[i], pb = shape.points[(i + 1) % n];
        bestPt = [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
      }
    }
    return bestD <= tol * 1.5 ? { after: bestI, point: bestPt } : null;
  }

  /* =====================================================================
   * TRACING
   * =================================================================== */
  function readRaster(canvas, x, y, size) {
    const half = Math.floor(size / 2);
    const minX = Math.max(0, x - half), minY = Math.max(0, y - half);
    const maxX = Math.min(canvas.width, x + half), maxY = Math.min(canvas.height, y + half);
    const w = maxX - minX, h = maxY - minY;
    if (w < 4 || h < 4) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let img;
    try { img = ctx.getImageData(minX, minY, w, h); }
    catch (e) { return { tainted: true }; }
    return { raster: { data: img.data, width: w, height: h }, minX, minY };
  }

  async function runTrace(clientX, clientY) {
    const A = st.adapter;
    const canvas = A.getCanvas();
    if (!canvas) return toastErr('No drawable map canvas found, so colour tracing is unavailable here. Use Draw instead.');

    st.busy = true; renderWidget();
    let restore = null;
    try {
      // Zoom in for resolution before sampling pixels — this genuinely helps,
      // because the flood fill runs against higher-resolution imagery.
      const boost = Math.max(0, Number(S.precisionZoomBoost) || 0);
      const seedMap = A.clientToMapCoord(clientX, clientY);
      if (!seedMap) throw new Error('Could not read a map coordinate there.');
      if (boost > 0) {
        const z0 = A.getZoom(), c0 = A.getCenter();
        if (z0 != null && c0) {
          restore = { z: z0, c: c0 };
          const maxZ = A.getMaxZoom();
          A.setCenter(seedMap);
          A.setZoom(Math.min(typeof maxZ === 'number' ? maxZ : 24, z0 + boost));
          await A.waitForRender(Math.max(400, Number(S.imageryWaitMs) || 2500));
          await sleep(90);
        }
      }

      const live = A.getCanvas();
      // Canvas-pixel mapping comes from the adapter, because it differs by
      // source: a map canvas is scaled by device density, while a raster
      // workspace's canvas IS the image. Computing a density ratio here would
      // silently offset every traced vertex in a workspace.
      let cx, cy;
      if (restore) {
        cx = Math.round(live.width / 2);
        cy = Math.round(live.height / 2);
      } else {
        const cp = A.clientToCanvasPixel(clientX, clientY);
        if (!cp) throw new Error('Could not map that point onto the image.');
        cx = Math.round(cp[0]);
        cy = Math.round(cp[1]);
      }

      let result = null, lastReason = 'Trace failed.';
      for (const size of S.regionSizes) {
        const got = readRaster(live, cx, cy, size);
        if (!got) { lastReason = 'That point is too close to the edge of the map view.'; continue; }
        if (got.tainted) throw new Error('The map canvas is cross-origin protected, so its pixels cannot be read. Colour tracing is impossible on this site — use Draw instead.');
        const r = Tracer.traceRegion(got.raster, cx - got.minX, cy - got.minY, {
          submode: st.traceSubmode,
          colorTolerance: S.colorTolerance,
          wallLuminanceThreshold: S.wallLuminanceThreshold,
          leakProtectionRadius: S.leakProtectionRadius,
          edgeGrowthRadius: S.edgeGrowthRadius,
          simplifyPx: S.simplifyPx,
          targetColor: st.pickedColor || undefined,
        });
        if (!r.ok) { lastReason = r.reason; continue; }
        // If the region ran to the edge of the window, widen and retry — the
        // parcel is probably larger than the sampled area.
        const isLast = size === S.regionSizes[S.regionSizes.length - 1];
        if (r.touchedEdge && !isLast) { lastReason = 'Region larger than the sampled window; widening.'; continue; }
        result = { r, got };
        break;
      }
      if (!result) throw new Error(lastReason);

      const mapPts = result.r.points
        .map(([px, py]) => {
          const client = A.canvasPixelToClient(px + result.got.minX, py + result.got.minY);
          return client ? A.clientToMapCoord(client[0], client[1]) : null;
        })
        .filter(Boolean);
      if (mapPts.length < 3) throw new Error('Could not convert the traced outline into map coordinates.');

      const shape = makeShape(mapPts, 'trace-' + st.traceSubmode);
      commit('trace a boundary');
      st.shapes.push(shape);
      st.mode = 'idle';
      autosave();
      toastOk(`Traced ${shape.plotNo ? 'plot ' + shape.plotNo : 'a boundary'}: ${shape.points.length} vertices, ${shape.areaM2.toFixed(0)} ${areaUnit()}.`);
      if (shape.validity && !shape.validity.valid) {
        toast('The traced boundary has a geometry problem — see the shape list.', 'warn', 7000);
      }
      warnIfTraceLeaked(shape);
    } catch (err) {
      toastErr(String(err && err.message ? err.message : err));
    } finally {
      if (restore) {
        st.adapter.setCenter(restore.c);
        st.adapter.setZoom(restore.z);
        await st.adapter.waitForRender(Math.max(400, Number(S.imageryWaitMs) || 2500));
      }
      st.busy = false;
      renderWidget();
      draw();
    }
  }

  /* `extra` carries the layer model (brief §24): where a parcel came from and
   * which layer it belongs to. Imported geometry is otherwise identical to
   * digitized geometry — same object, same editor, same exporters — which is
   * what §23 requires, so the distinction lives in two fields rather than in a
   * second code path. */
  function makeShape(points, mode, extra) {
    const e = extra || {};
    const shape = {
      id: st.nextShapeId++,
      points,
      // An imported parcel brings its own plot number; a traced one inherits
      // whatever the portal reported for the parcel the operator clicked.
      plotNo: e.plotNo !== undefined ? e.plotNo : st.plotNo,
      areaText: e.areaText !== undefined ? e.areaText : st.plotArea,
      bbox: e.bbox !== undefined ? e.bbox : st.plotBbox,
      mode,
      source: e.source || 'digitized',   // 'digitized' | 'imported'
      layer: e.layer || (e.source === 'imported' ? 'Imported' : 'Digitized'),
      shift: GeomEdit.identityShift(),
    };
    if (e.name) shape.name = e.name;
    if (e.attributes && Object.keys(e.attributes).length) shape.attributes = e.attributes;
    refreshShapeMetrics(shape);
    return shape;
  }

  function refreshShapeMetrics(shape) {
    shape.areaM2 = groundAreaOf(shape.points);
    shape.computedAreaM2 = shape.areaM2;
    shape.perimeterM = Exp.perimeter(shape.points);
    shape.validity = Exp.validateRing(shape.points);
    const recorded = Exp.parseIndianAreaToM2(shape.areaText);
    shape.recordedAreaM2 = recorded;
    shape.areaDiffPct = recorded ? ((shape.areaM2 - recorded) / recorded) * 100 : null;
    // A leak reading compares the ring against the bounding box the portal
    // reported at trace time. Once the geometry moves — a GCP correction, an
    // edit, regularising — the comparison is against a frame the shape no longer
    // sits in, so the figure is stale. It is dropped for the same reason a
    // quality grade is dropped on any change: a stale measurement that grades as
    // an error is worse than no measurement, because it condemns work that may
    // now be correct. Retracing measures it again.
    delete shape.leak;
  }

  /* =====================================================================
   * GEOMETRY EDITING — MOVE, ROTATE, SCALE, COPY  (brief §3, §4, §10)
   * ---------------------------------------------------------------------
   * The main use case is the one the brief names: field-surveyed geometry and
   * cadastral map geometry that describe the same parcel but sit a few metres
   * apart. The operator selects the parcel and slides it into place.
   *
   * NON-DESTRUCTIVE, AND WHAT THAT MEANS HERE
   *
   * Every operation does two things: it moves the live geometry, and it
   * composes the same transform into `shape.shift` — a similarity stored
   * beside the parcel that always states exactly what has been done to the
   * original, however many operations were stacked (see lib/geom_edit.js).
   * The pre-edit geometry goes into st.backups the first time a shape is
   * touched, which is the same mechanism a GCP correction already uses.
   *
   * So: undo is Ctrl+Z, reset is ↺ Revert, "compare original and corrected" is
   * the shift record read against the backup, and export carries the corrected
   * geometry because shape.points IS the corrected geometry (brief §25).
   *
   * MOVING GEOMETRY IS NOT PANNING THE MAP (brief §26). A pan changes the
   * viewport and touches no state here at all; a move changes these points and
   * touches nothing about the view. They cannot be confused because they do not
   * share a code path — the gesture layer routes a drag that grabbed a parcel
   * to onPointerMove's move branch, and everything else to the map underneath.
   * =================================================================== */
  function selectedShape() {
    return findShape(st.selectedShapeId);
  }

  function ensureBackup(shape) {
    if (!st.backups[shape.id]) st.backups[shape.id] = shape.points.map((p) => p.slice());
  }

  /* Apply a similarity to one parcel and record it. Returns what changed, so
   * the caller can report it in the units a surveyor thinks in. */
  function applyShiftToShape(shape, delta) {
    ensureBackup(shape);
    shape.points = GeomEdit.applyShiftToRing(delta, shape.points);
    shape.shift = GeomEdit.composeShift(shape.shift || GeomEdit.identityShift(), delta);
    refreshShapeMetrics(shape);
    return GeomEdit.describeShift(delta, st.backups[shape.id]);
  }

  /* Translate by a map-coordinate delta. Used by both the drag and the typed
   * X/Y box, so the two cannot drift apart in behaviour. */
  function moveShapeBy(shape, dx, dy, label) {
    if (!shape || (!dx && !dy)) return false;
    const before = crossingSnapshot();
    commit(label || `move shape ${shape.id}`);
    applyShiftToShape(shape, GeomEdit.shiftForTranslation(dx, dy));
    reportNewCrossings(before, 'Moving that parcel');
    autosave(); draw(); renderWidget();
    return true;
  }

  /* Rotation and scaling are about the parcel's OWN centroid, so "rotate 2°"
   * turns the plot where it stands instead of swinging it across the sheet. */
  function rotateShapeBy(shape, degrees) {
    if (!shape || !isFinite(degrees) || degrees === 0) return false;
    const c = GeomEdit.ringCentroid(shape.points);
    const before = crossingSnapshot();
    commit(`rotate shape ${shape.id} by ${degrees}°`);
    applyShiftToShape(shape, GeomEdit.shiftForRotationAbout(degrees, c));
    reportNewCrossings(before, 'Rotating that parcel');
    autosave(); draw(); renderWidget();
    return true;
  }

  function scaleShapeBy(shape, factor) {
    if (!shape || !isFinite(factor) || factor <= 0 || factor === 1) return false;
    const c = GeomEdit.ringCentroid(shape.points);
    const before = crossingSnapshot();
    commit(`scale shape ${shape.id} by ${factor}`);
    applyShiftToShape(shape, GeomEdit.shiftForScaleAbout(factor, c));
    reportNewCrossings(before, 'Scaling that parcel');
    autosave(); draw(); renderWidget();
    return true;
  }

  /* Put a shifted parcel back exactly where it started, and clear the record
   * with it. Distinct from Undo: undo steps back one operation, this removes
   * every correction the parcel has accumulated (brief §4). */
  function resetShapeShift(shape) {
    if (!shape) return false;
    const b = st.backups[shape.id];
    if (!b) { toast('That parcel has not been moved, so there is nothing to reset.', 'info', 3500); return false; }
    commit(`reset the shift on shape ${shape.id}`);
    shape.points = b.map((p) => p.slice());
    shape.shift = GeomEdit.identityShift();
    delete shape.lastGcpCorrection;
    delete st.backups[shape.id];
    refreshShapeMetrics(shape);
    autosave(); draw(); renderWidget();
    toastOk(`Shape ${shape.id} put back where it started.`);
    return true;
  }

  function duplicateShape(shape, offsetIt) {
    if (!shape) return null;
    commit(`duplicate shape ${shape.id}`);
    const pts = offsetIt === false
      ? shape.points.map((p) => p.slice())
      : GeomEdit.duplicateRing(shape.points);
    const copy = makeShape(pts, shape.mode || 'copy', {
      plotNo: shape.plotNo, areaText: shape.areaText, bbox: shape.bbox,
      source: shape.source, layer: shape.layer, name: shape.name, attributes: shape.attributes,
    });
    st.shapes.push(copy);
    st.selectedShapeId = copy.id;
    autosave(); draw(); renderWidget();
    return copy;
  }

  /* Which parcel is under this point? Used to select by tapping and to grab a
   * parcel for a move. The topmost match wins, which for overlapping parcels
   * is the most recently added — the one the operator just made. */
  function hitTestShapeBody(clientX, clientY) {
    const A = st.adapter;
    if (!A) return null;
    const pt = A.clientToMapCoord(clientX, clientY);
    if (!pt) return null;
    for (let i = st.shapes.length - 1; i >= 0; i--) {
      const s = st.shapes[i];
      if (s.points && s.points.length >= 3 && Imp.pointInRing(pt, s.points)) return s;
    }
    return null;
  }

  /* =====================================================================
   * CLEAN-UP: REGULARISE, SNAP, TOPOLOGY, QUALITY
   * =================================================================== */
  function regulariseOptions() {
    return {
      angleToleranceDeg: Number(S.regulariseAngleDeg) || 8,
      collinearTolerance: Number(S.regulariseCollinearM) || 0.15,
      maxShift: Number(S.regulariseMaxShiftM) || 1.5,
      minAlignedFraction: 0.6,
    };
  }

  function regulariseShapes(ids) {
    const targets = ids ? st.shapes.filter((s) => ids.includes(s.id)) : st.shapes;
    if (!targets.length) return toastErr('Nothing to regularise.');
    const crossBefore = crossingSnapshot();
    commit(`regularise ${targets.length} shape(s)`);
    let squared = 0, removed = 0, refused = 0;
    const reasons = [];
    for (const shape of targets) {
      if (!st.backups[shape.id]) st.backups[shape.id] = shape.points.map((p) => p.slice());
      const r = Topo.regularise(shape.points, regulariseOptions());
      if (r.squared) squared++; else { refused++; if (r.squareUpReason) reasons.push(r.squareUpReason); }
      removed += r.verticesRemoved;
      shape.points = r.ring;
      shape.regularised = {
        squared: r.squared, orientation: r.orientation,
        verticesRemoved: r.verticesRemoved, areaChangePct: r.areaChangePct,
        maxShift: r.maxShift, reason: r.squareUpReason,
      };
      refreshShapeMetrics(shape);
    }
    autosave(); draw(); renderWidget();
    toastOk(`Regularised ${targets.length} shape(s): ${squared} squared up, ${removed} redundant vertices removed${refused ? `, ${refused} left alone` : ''}. Ctrl+Z undoes it.`);
    // A refusal is information, not a failure — say why for the first one.
    if (reasons.length) toast(reasons[0], 'info', 7000);
    reportNewCrossings(crossBefore, 'Regularising');
  }

  function snapShapesToNeighbours() {
    if (st.shapes.length < 2) return toastErr('Snapping needs at least two shapes.');
    const before = Topo.findUnsnapped(st.shapes, Number(S.snapToleranceM) || 0.5).length;
    if (!before) return toastOk('Nothing to snap — every shared vertex is already exactly coincident.');
    commit('snap shared corners together');
    for (const s of st.shapes) if (!st.backups[s.id]) st.backups[s.id] = s.points.map((p) => p.slice());
    const r = Topo.snapAllToNeighbours(st.shapes, Number(S.snapToleranceM) || 0.5);
    r.shapes.forEach((snapped, i) => { st.shapes[i].points = snapped.points; refreshShapeMetrics(st.shapes[i]); });
    const after = Topo.findUnsnapped(st.shapes, Number(S.snapToleranceM) || 0.5).length;
    autosave(); draw(); renderWidget();
    toastOk(`Snapped ${r.moved} vertex/vertices onto neighbouring boundaries. Unsnapped: ${before} → ${after}.`);
  }

  function currentTopology() {
    if (st.shapes.length < 2) return null;
    return Topo.analyseTopology(st.shapes, {
      tolerance: Number(S.snapToleranceM) || 0.5,
      gridSteps: 100,
    });
  }

  function runQualityReport() {
    if (!st.shapes.length) return toastErr('Nothing to report on.');
    st.quality = Topo.scoreSession(st.shapes, {
      tolerance: Number(S.snapToleranceM) || 0.5, gridSteps: 100,
    });
    renderWidget();
    const q = st.quality;
    toast(`Session grade: ${q.grade} (${q.averageScore.toFixed(0)}/100) — ${q.errorCount} error(s), ${q.warningCount} warning(s).`,
      q.errorCount ? 'warn' : 'ok', 7000);
  }

  /* =====================================================================
   * IMPORT — DXF, KML/KMZ, CSV vertices, GeoJSON  (brief §2, §16, §17, §18)
   * ---------------------------------------------------------------------
   * Imported rings become ordinary shapes through makeShape, so they are drawn
   * by the existing renderer, edited by the existing editor, cleaned by the
   * existing topology code and written by the existing exporters. There is no
   * second editor for imported files, which is precisely what §23 asks for.
   *
   * AUTOMATIC OVERLAY. Nothing asks the operator to place the geometry. The
   * coordinates in the file are used as they are, so a DXF holding real
   * eastings and northings lands where those eastings and northings are. The
   * view is moved to the imported extent afterwards so it is visibly there
   * rather than somewhere off screen — moving the VIEW, not the geometry.
   *
   * THE CRS IS ASKED FOR, NOT GUESSED. A DXF or a CSV of plain numbers cannot
   * say which coordinate system it is in, and inventing one would put parcels
   * in the wrong district. Where the session already knows its CRS the import
   * adopts it and says so; where neither knows, the import stops and asks.
   * =================================================================== */
  function readFile(accept, as) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || '';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        const rd = new FileReader();
        rd.onload = () => resolve({ name: f.name, size: f.size, data: rd.result });
        rd.onerror = () => resolve(null);
        if (as === 'arrayBuffer') rd.readAsArrayBuffer(f); else rd.readAsText(f);
      };
      input.click();
    });
  }

  /* Does the CRS the file implies agree with the session's? Reported rather
   * than reconciled: silently reprojecting geometry the operator did not ask to
   * have reprojected is how coordinates end up subtly wrong. */
  function resolveImportCrs(result, what) {
    const sessionCrs = isWorkspace() ? (st.georef && st.georef.crs) : st.crs;
    if (result.crs && result.crs.kind === 'geographic') {
      if (sessionCrs && sessionCrs.kind !== 'geographic') {
        return {
          ok: false,
          error: `This ${what} holds longitude/latitude, but this session is working in ${Crs.describeCrs(sessionCrs)}. Importing it as-is would put the parcels near the equator. Convert the file to the session's coordinate system first, or start a session on a lon/lat map.`,
        };
      }
      return { ok: true, crs: result.crs, adopted: !sessionCrs };
    }
    if (sessionCrs) return { ok: true, crs: sessionCrs, adopted: false };
    if (result.crs) return { ok: true, crs: result.crs, adopted: true };
    return {
      ok: false,
      ask: true,
      error: `The coordinate system of this ${what} is not stated in the file and this session has not established one either. Confirm the coordinate system first — a wrong zone puts exports hundreds of kilometres out.`,
    };
  }

  /* Bring parsed rings into the session. One undo step for the whole import,
   * because a forty-parcel import that took forty presses to undo would not be
   * undoable in practice. */
  function adoptImportedRings(result, opts) {
    const o = opts || {};
    const crsCheck = resolveImportCrs(result, o.what || 'file');
    if (!crsCheck.ok) {
      toastErr(crsCheck.error);
      return false;
    }
    commit(`import ${result.rings.length} parcel(s) from ${o.what || 'a file'}`);
    const added = [];
    for (const r of result.rings) {
      const shape = makeShape(r.points.map((p) => [p[0], p[1]]), 'import', {
        plotNo: r.plotNo != null && r.plotNo !== '' ? String(r.plotNo) : null,
        areaText: null,
        bbox: null,
        source: 'imported',
        layer: r.layer || o.layer || 'Imported',
        name: r.name || null,
        attributes: r.attributes || null,
      });
      st.shapes.push(shape);
      added.push(shape);
    }
    if (!added.length) { dropCommit(); toastErr('Nothing importable in that file.'); return false; }

    if (crsCheck.adopted && crsCheck.crs && !isWorkspace()) {
      st.crs = crsCheck.crs;
      st.crsDetection = {
        crs: crsCheck.crs, confidence: 0.9, needsConfirmation: false,
        reasons: [`Taken from the imported ${o.what || 'file'}: ${result.crsSource || 'declared in the file'}.`],
        candidates: [],
      };
    }

    st.selectedShapeId = added[added.length - 1].id;
    st.importSummary = {
      what: o.what || 'file',
      name: o.name || '',
      added: added.length,
      skipped: result.skipped || [],
      warnings: result.warnings || [],
      crsLabel: Crs.describeCrs(crsCheck.crs),
      adoptedCrs: !!crsCheck.adopted,
      layers: [...new Set(added.map((s) => s.layer))],
      withPlotNo: added.filter((s) => s.plotNo != null).length,
    };
    autosave(); draw(); renderWidget();
    zoomToImported(added);

    const bits = [`${added.length} parcel(s) imported and overlaid`];
    if (st.importSummary.withPlotNo) bits.push(`${st.importSummary.withPlotNo} with a plot number`);
    if (result.skipped && result.skipped.length) bits.push(`${result.skipped.length} item(s) skipped`);
    toastOk(bits.join(' · ') + '.');
    (result.warnings || []).forEach((w) => toast(w, 'warn', 9000));
    if (crsCheck.adopted) {
      toast(`Coordinate system taken from the file: ${Crs.describeCrs(crsCheck.crs)}. Check it in the panel before exporting.`, 'info', 8000);
    }
    return true;
  }

  /* Move the VIEW to the imported geometry, never the geometry to the view
   * (brief §2, §26). Best-effort: an adapter that cannot be told where to look
   * simply leaves the view alone rather than failing the import. */
  function zoomToImported(shapes) {
    const A = st.adapter;
    if (!A || !shapes.length) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const s of shapes) {
      for (const p of s.points) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
    }
    if (!isFinite(minX)) return;
    safe(() => { if (isFn(A.setCenter)) A.setCenter([(minX + maxX) / 2, (minY + maxY) / 2]); });
  }

  async function importGeometryFile(kind) {
    const spec = {
      dxf: { accept: '.dxf', as: 'text', what: 'DXF' },
      kml: { accept: '.kml,.kmz', as: 'arrayBuffer', what: 'KML/KMZ' },
      csv: { accept: '.csv,.txt', as: 'text', what: 'CSV vertex list' },
      geojson: { accept: '.geojson,.json', as: 'text', what: 'GeoJSON' },
    }[kind];
    if (!spec) return;
    st.openMenu = null;
    let file;
    try {
      file = await readFile(spec.accept, spec.as);
    } catch (e) {
      return toastErr('That file could not be read.');
    }
    if (!file) return;

    try {
      st.busy = true; renderWidget();
      let result;
      if (kind === 'dxf') {
        result = Imp.parseDxf(String(file.data || ''));
      } else if (kind === 'geojson') {
        result = Imp.parseGeoJson(String(file.data || ''));
      } else if (kind === 'kml') {
        const bytes = new Uint8Array(file.data);
        // A KMZ is a ZIP and starts "PK"; a KML is XML. The magic number is
        // checked rather than the extension, because files get renamed.
        const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
        result = isZip ? await Imp.parseKmz(bytes) : Imp.parseKml(new TextDecoder().decode(bytes));
      } else if (kind === 'csv') {
        // CSV needs the format confirming first, so it takes the dialog route
        // and returns here only once the operator has pressed Import.
        const preview = Imp.previewCsv(String(file.data || ''));
        if (!preview.ok) throw new Error(preview.error);
        st.csvDialog = {
          purpose: 'vertices',
          fileName: file.name,
          text: String(file.data || ''),
          preview,
          mapping: Object.assign({}, preview.suggestion),
          formatKey: 'auto',
          groupBy: preview.suggestion.id,
        };
        st.busy = false; renderWidget();
        toast('Check the columns below, then press Import. Nothing is read until you confirm.', 'info', 7000);
        return;
      }
      if (!result || !result.ok) throw new Error((result && result.error) || 'Nothing importable in that file.');
      adoptImportedRings(result, { what: spec.what, name: file.name });
    } catch (err) {
      toastErr(String(err && err.message ? err.message : err));
    } finally {
      st.busy = false;
      renderWidget();
    }
  }

  /* Confirmed CSV import — the second half of the two-step the brief requires
   * for both vertex lists (§17) and control points (§6). */
  function confirmCsvImport() {
    const d = st.csvDialog;
    if (!d) return;
    if (d.purpose === 'gcps') return confirmGcpCsvImport();
    const r = Imp.ringsFromCsv(d.preview, d.mapping, { groupBy: d.groupBy });
    if (!r.ok) return toastErr(r.error);
    if (adoptImportedRings(r, { what: 'CSV vertex list', name: d.fileName, layer: 'CSV' })) {
      st.csvDialog = null;
      renderWidget();
    }
  }

  function confirmGcpCsvImport() {
    const d = st.csvDialog;
    if (!d) return;
    const r = Imp.gcpsFromCsv(d.preview, d.mapping, {
      sourceX: d.sourceX != null ? d.sourceX : null,
      sourceY: d.sourceY != null ? d.sourceY : null,
    });
    if (!r.ok) return toastErr(r.error);
    // A pair with no source coordinate states only where a corner truly is. It
    // cannot become a control point on its own — a control point is a PAIR —
    // so those are reported rather than loaded as half-formed points that
    // would fit a transform of nothing to nothing.
    const usable = r.pairs.filter((p) => p.rawPoint);
    if (!usable.length) {
      return toastErr(`${r.pairs.length} coordinate(s) were read, but none carries a "where the geometry currently says it is" position as well as a true position. A control point is a pair. Map the source columns too, or use the two-step pairing on the map: tap the corner, then tap where it really is.`);
    }
    commit(`load ${usable.length} control point(s) from a CSV`);
    for (const p of usable) {
      st.gcps.push({
        id: st.nextGcpId++, shapeId: null, vertexIndex: null,
        source: p.rawPoint, target: p.confirmedPoint, enabled: p.enabled !== false,
      });
    }
    recomputeFit(); autosave(); draw();
    st.csvDialog = null;
    renderWidget();
    const dropped = r.pairs.length - usable.length;
    toastOk(`${usable.length} control point(s) loaded.${dropped ? ` ${dropped} row(s) had no source coordinate and were skipped.` : ''}`);
  }

  /* =====================================================================
   * RASTER WORKSPACE — images and PDF pages
   * =================================================================== */
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || 'image/*';
      input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
      input.click();
    });
  }

  function requestTabCapture() {
    return new Promise((resolve) => {
      const token = 'c' + Date.now() + Math.random().toString(36).slice(2);
      const onRes = (e) => {
        const d = e && e.detail;
        if (!d || d.token !== token) return;
        window.removeEventListener('BND15_CAPTURE_RES', onRes);
        resolve(d);
      };
      window.addEventListener('BND15_CAPTURE_RES', onRes);
      window.dispatchEvent(new CustomEvent('BND15_CAPTURE_REQ', { detail: { token } }));
      setTimeout(() => {
        window.removeEventListener('BND15_CAPTURE_RES', onRes);
        resolve({ ok: false, error: 'The extension worker did not answer the capture request. Reopen the digitizer from the toolbar button and retry.' });
      }, 8000);
    });
  }

  /* Hide the panel, the overlay and the toasts, run `fn`, then put them back —
   * whatever `fn` does, including throwing. Used for Capture view (brief §22),
   * where the point of the capture is the drawing underneath, not the tool. */
  async function withWidgetHidden(fn) {
    const ids = [WIDGET_ID, OVERLAY_ID, PILL_ID, TOAST_ID];
    const hidden = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.style.visibility !== 'hidden') {
        hidden.push([el, el.style.visibility]);
        el.style.visibility = 'hidden';
      }
    }
    // One frame for the browser to actually paint without the panel before the
    // capture is taken; without it the capture can still contain the widget.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      return await fn();
    } finally {
      for (const [el, prev] of hidden) el.style.visibility = prev || '';
    }
  }

  async function openWorkspace(source) {
    if (st.shapes.length && !confirm(
      'Opening an image workspace switches the coordinate system to image pixels.\n\n' +
      `You have ${st.shapes.length} shape(s) digitised against the current map. Export or save them first if you need them — continue?`)) return;

    let url = null, name = 'image', kind = source;
    try {
      st.busy = true; renderWidget();
      if (source === 'file') {
        const f = await pickFile('image/*');
        if (!f) { st.busy = false; renderWidget(); return; }
        url = URL.createObjectURL(f);
        name = f.name;
      } else if (source === 'capture') {
        /* CAPTURE VIEW (brief §22). The digitizer hides itself so the capture
         * is of the map or PDF alone rather than of the panel sitting on top of
         * it, then comes back. That is the whole of what a page script can do:
         * the browser will not let an extension minimise or hide the browser's
         * own chrome, and this does not pretend otherwise. */
        const res = await withWidgetHidden(() => requestTabCapture());
        if (!res.ok) throw new Error(res.error);
        url = res.dataUrl;
        name = 'captured view';
      } else if (source === 'page') {
        const imgs = Raster.findPageImages(document, window);
        if (!imgs.length) throw new Error('No image large enough to digitize was found on this page.');
        const best = imgs[0];
        if (!best.sameOrigin) throw new Error(best.note);
        url = best.src;
        name = 'page image';
      }
      if (!url) throw new Error('No image source selected.');

      const loaded = await Raster.loadImageSource(document, url);
      if (!loaded.ok) throw new Error(loaded.error);

      const made = Raster.createRasterWorkspace({
        doc: document, win: window, Viewport,
        image: loaded.image, sourceName: name, sourceKind: kind,
      });
      if (!made.ok) throw new Error(made.error);

      // Park the live-map adapter rather than discarding it, so closing the
      // workspace returns to exactly where the operator was.
      if (!st.workspace) st.mapAdapter = st.adapter;
      teardownSurface();
      st.workspace = made.adapter;
      st.adapter = made.adapter;
      clearSessionState();
      st.crs = null; st.crsDetection = null;
      ensureOverlay(); installGestures();
      applyDrawingStyle();
      autosave(); renderWidget(); draw();
      toastOk(`${name} opened — ${loaded.image.width}×${loaded.image.height} px. Trace as usual; coordinates are image pixels until you georeference.`);
      if (kind === 'capture') {
        toast('A capture is at screen resolution, not the source resolution. For a large sheet, zoom in and capture in sections.', 'info', 9000);
      }
    } catch (err) {
      toastErr(String(err && err.message ? err.message : err));
    } finally {
      st.busy = false;
      renderWidget();
    }
  }

  function closeWorkspace() {
    if (!st.workspace) return;
    if (st.shapes.length && !confirm(`Close the image workspace and discard ${st.shapes.length} shape(s) digitised on it?`)) return;
    st.workspace.destroy();
    st.workspace = null;
    clearSessionState();
    teardownSurface();
    st.adapter = st.mapAdapter;
    if (st.adapter) { detectCrs(); ensureOverlay(); installGestures(); }
    autosave(); renderWidget(); draw();
    toastOk(st.adapter ? 'Workspace closed — back to the live map.' : 'Workspace closed.');
  }

  function teardownSurface() {
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
    if (offRender) { offRender(); offRender = null; }
    removeGestures();
  }

  /* ---------------------------------------------------------------------
   * GEOREFERENCING A RASTER
   *
   * An image is pixels. To export real coordinates, at least two points must be
   * paired with known real-world positions — typed in, because they come from a
   * survey record, a corner with published coordinates, or a GPS reading, not
   * from anything the browser can see.
   *
   * The fit is the same least-squares machinery used to correct a live map, with
   * pixels as source and world coordinates as target, so it inherits robust
   * fitting, cross-validation and model recommendation for free.
   * ------------------------------------------------------------------- */
  function beginGeorefPick(clientX, clientY) {
    const p = st.adapter.clientToMapCoord(clientX, clientY);
    if (!p) return toastErr('Could not read an image coordinate there.');
    st.georefPick = p;
    renderWidget(); draw();
    toast(`Image pixel ${p[0].toFixed(1)}, ${p[1].toFixed(1)} captured. Now type its real-world coordinate in the panel.`, 'info', 7000);
  }

  function addGeorefPoint(worldX, worldY) {
    if (!st.georefPick) return toastErr('Tap a point on the image first.');
    if (!isFinite(worldX) || !isFinite(worldY)) return toastErr('That is not a pair of numbers.');
    commit('add a georeference point');
    st.georefPoints.push({
      id: st.nextGeorefId++,
      pixel: st.georefPick.slice(),
      world: [worldX, worldY],
      enabled: true,
    });
    st.georefPick = null;
    recomputeGeoref();
    autosave(); renderWidget(); draw();
    toastOk(`Georeference point ${st.georefPoints.length} added.`);
  }

  /* =====================================================================
   * DRAWING SCALE — RF AND SCALE BAR  (brief §12, §13)
   * ---------------------------------------------------------------------
   * These establish how far a pixel on the sheet is on the ground. They are
   * NOT image resizing and NOT screen zoom: nothing here reads or writes the
   * viewport, so magnifying the display cannot change the calibrated scale
   * (brief §12's closing line, and §26).
   *
   * The calibration is what turns a pixel area into a ground area on an
   * un-georeferenced sheet, which is the common case for a scanned cadastral
   * drawing where the operator wants plot areas but has no survey control.
   * Where GCP georeferencing is present that is the better answer and takes
   * precedence, because it is measured against known positions rather than
   * derived from an assumed scan resolution.
   * =================================================================== */
  function setCalibration(cal, note) {
    commit('set the drawing scale');
    st.calibration = cal;
    st.shapes.forEach(refreshShapeMetrics);
    autosave(); renderWidget(); draw();
    toastOk(note || `Drawing scale set: 1 px = ${cal.metresPerPixel.toFixed(4)} m on the ground.`);
  }

  function applyRfCalibration(rf, dpi) {
    const made = GeomEdit.makeCalibration({ method: 'rf', rfDenominator: rf, dpi, now: Date.now() });
    if (!made.ok) return toastErr(made.error);
    S.scanDpi = Number(dpi);
    saveSettings();
    setCalibration(made.calibration,
      `RF 1:${Number(rf)} at ${Number(dpi)} dpi — 1 px = ${made.calibration.metresPerPixel.toFixed(4)} m. Screen zoom does not change this.`);
  }

  function applyScaleBarCalibration(groundMetres) {
    if (st.calibrationPick.length < 2) {
      return toastErr('Pick two points on the drawing first — the two ends of a distance you know.');
    }
    const made = GeomEdit.makeCalibration({
      method: 'scalebar',
      pixelA: st.calibrationPick[0], pixelB: st.calibrationPick[1],
      groundDistanceMetres: groundMetres, now: Date.now(),
    });
    if (!made.ok) return toastErr(made.error);
    // Where an RF was also entered, say whether the two agree. They are
    // independent measurements of the same quantity, so a disagreement means
    // one of them is wrong and the operator should know which to trust.
    const previous = st.calibration;
    st.calibrationPick = [];
    setCalibration(made.calibration,
      `Scale bar: ${groundMetres} m over ${made.calibration.pixelDistance.toFixed(1)} px — 1 px = ${made.calibration.metresPerPixel.toFixed(4)} m.`);
    if (previous && previous.method === 'rf') {
      const cmp = GeomEdit.compareCalibrations(previous, made.calibration);
      if (cmp) toast(cmp.message, cmp.agree ? 'ok' : 'warn', cmp.agree ? 5000 : 12000);
    }
  }

  function pickCalibrationPoint(clientX, clientY) {
    const p = st.adapter.clientToMapCoord(clientX, clientY);
    if (!p) return toastErr('Could not read an image coordinate there.');
    if (st.calibrationPick.length >= 2) st.calibrationPick = [];
    st.calibrationPick.push(p);
    renderWidget(); draw();
    if (st.calibrationPick.length === 1) {
      toast('First end marked. Now tap the other end of the known distance.', 'info', 6000);
    } else {
      const d = Math.hypot(st.calibrationPick[1][0] - st.calibrationPick[0][0],
        st.calibrationPick[1][1] - st.calibrationPick[0][1]);
      toast(`${d.toFixed(1)} px between the two marks. Type the real ground distance in the panel.`, 'info', 8000);
    }
  }

  function recomputeGeoref() {
    const active = st.georefPoints.filter((g) => g.enabled !== false);
    if (active.length < 2 || !st.georefCrs) { st.georef = null; return; }
    const pairs = active.map((g, i) => ({ vertexIndex: i, rawPoint: g.pixel, confirmedPoint: g.world }));
    const rec = GcpMath.recommendTransform(pairs);
    const type = (rec.validated && rec.recommended) ? rec.recommended : 'similarity';
    const fit = GcpMath.fitGcpTransform(pairs, type, { robust: !!S.robustFitting });
    if (!fit.ok) { st.georef = { error: fit.error }; return; }
    st.georef = {
      fit: fit.fit, crs: st.georefCrs, type,
      rms: fit.rms, looRms: fit.looRms, residuals: fit.residuals,
      outliers: fit.outliers, recommendation: rec, count: active.length,
    };
    st.shapes.forEach(refreshShapeMetrics);
  }

  /* =====================================================================
   * BATCH VECTORISATION
   * =================================================================== */
  async function autoTraceVisible() {
    const A = st.adapter;
    const canvas = A && A.getCanvas();
    if (!canvas) return toastErr('No readable map canvas here, so batch tracing is unavailable. Use Draw instead.');
    if (!confirm('Trace every enclosed parcel in the current view?\n\nParcels clipped by the edge of the view are skipped, because their boundaries are not real. Zoom and pan so the parcels you want are fully visible first.')) return;

    st.busy = true; renderWidget();
    try {
      let img;
      try {
        img = canvas.getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, canvas.width, canvas.height);
      } catch (e) {
        throw new Error('The map canvas is cross-origin protected, so its pixels cannot be read on this site.');
      }
      const raster = { data: img.data, width: canvas.width, height: canvas.height };

      const res = Tracer.findAllRegions(raster, {
        submode: st.traceSubmode,
        colorTolerance: S.colorTolerance,
        wallLuminanceThreshold: S.wallLuminanceThreshold,
        leakProtectionRadius: S.leakProtectionRadius,
        simplifyPx: S.simplifyPx,
        minPixels: Number(S.batchMinPixels) || 400,
        maxRegions: Number(S.batchMaxRegions) || 200,
      });
      if (!res.regions.length) throw new Error(res.summary + ' Try lowering the minimum size, or adjusting the colour tolerance.');

      let added = 0;
      commit(`vectorise ${res.regions.length} region(s)`);
      for (const region of res.regions) {
        const pts = region.points
          .map(([px, py]) => {
            const client = A.canvasPixelToClient(px, py);
            return client ? A.clientToMapCoord(client[0], client[1]) : null;
          })
          .filter(Boolean);
        if (pts.length < 3) continue;
        // Batch tracing produces neighbours, so snapping matters more here than
        // anywhere else: without it every shared boundary is duplicated.
        let finalPts = pts;
        if (S.snapEnabled && st.shapes.length) {
          finalPts = Topo.snapRing(finalPts, st.shapes, Number(S.snapToleranceM) || 0.5).ring;
        }
        if (S.autoRegulariseOnTrace) finalPts = Topo.regularise(finalPts, regulariseOptions()).ring;
        const shape = makeShape(finalPts, 'auto-' + st.traceSubmode);
        // Batch results have no per-parcel metadata: the portal only reports the
        // one parcel the user selected, so claiming a plot number here would be
        // inventing it.
        shape.plotNo = null;
        shape.areaText = null;
        refreshShapeMetrics(shape);
        st.shapes.push(shape);
        added++;
      }
      autosave();
      if (!added) dropCommit();
      toastOk(`${added} parcel(s) added. ${res.summary}${added ? ' Ctrl+Z undoes the whole batch.' : ''}`);
      const topo = currentTopology();
      if (topo && !topo.clean) toast(topo.summary + ' Use Snap and Regularise to clean up.', 'warn', 9000);
    } catch (err) {
      toastErr(String(err && err.message ? err.message : err));
    } finally {
      st.busy = false;
      renderWidget();
      draw();
    }
  }

  /* =====================================================================
   * GCPs
   * =================================================================== */
  function findShape(id) { return st.shapes.find((s) => s.id === id) || null; }

  /* -------------------------------------------------------------------------
   * EXPLICIT TWO-STEP PAIRING
   *
   * Step 1 nominates a vertex; step 2 captures where that vertex truly lies.
   *
   * Earlier builds inferred the vertex from whichever was nearest the click.
   * That is a guess, and on a dense boundary or a corner shared by two parcels
   * it is close to a coin flip — while the entire meaning of a control point is
   * that the operator is asserting THIS corner belongs THERE. So the vertex is
   * now chosen deliberately, is highlighted while chosen, and can also be
   * picked by index from the panel when the map is too crowded to click
   * accurately.
   * ----------------------------------------------------------------------- */
  function findNearestVertex(clientX, clientY, tolerancePx) {
    const A = st.adapter;
    let best = null, bestD = Infinity;
    for (const shape of st.shapes) {
      shape.points.forEach((p, i) => {
        const c = A.mapCoordToClient(p[0], p[1]);
        if (!c) return;
        const d = Math.hypot(c[0] - clientX, c[1] - clientY);
        if (d < bestD) { bestD = d; best = { shapeId: shape.id, vertexIndex: i, dist: d }; }
      });
    }
    return best && bestD <= tolerancePx ? best : null;
  }

  function selectGcpVertex(shapeId, vertexIndex) {
    const shape = findShape(shapeId);
    if (!shape) return toastErr('That shape no longer exists.');
    if (vertexIndex < 0 || vertexIndex >= shape.points.length) {
      return toastErr(`Vertex ${vertexIndex} does not exist — this shape has ${shape.points.length}.`);
    }
    st.gcpSelection = { shapeId, vertexIndex };
    st.gcpStage = 'placeTarget';
    draw(); renderWidget();
    toast(`Vertex ${vertexIndex} of ${shape.plotNo ? 'plot ' + shape.plotNo : 'shape ' + shapeId} selected. Now tap where that corner really is — pan and zoom first if you need to.`, 'info', 6000);
  }

  /* `quiet` skips the redraw, for callers that are mid-way through a larger
   * change and will redraw once at the end. Redrawing from inside a state
   * restore would render a half-restored document. */
  function clearGcpSelection(quiet) {
    st.gcpSelection = null;
    st.gcpStage = 'pickVertex';
    if (!quiet) { draw(); renderWidget(); }
  }

  // Step 2: the coordinate is captured automatically from the tap, in the map's
  // own CRS, and echoed back numerically so it can be checked rather than
  // assumed.
  function captureGcpTarget(clientX, clientY) {
    const A = st.adapter;
    const sel = st.gcpSelection;
    if (!sel) return;
    const shape = findShape(sel.shapeId);
    if (!shape) { clearGcpSelection(); return toastErr('That shape no longer exists.'); }
    const target = A.clientToMapCoord(clientX, clientY);
    if (!target) return toastErr('Could not read a map coordinate there.');

    const made = GcpMath.makeGcpFromVertex(shape, sel.vertexIndex, target);
    if (!made.ok) return toastErr(made.error);

    commit('add a control point');
    const g = Object.assign({ id: st.nextGcpId++ }, made.gcp);
    st.gcps.push(g);
    st.activeGcpId = g.id;
    st.lastCapture = {
      gcpId: g.id,
      source: g.source, target: g.target,
      lonLat: toLonLat(g.target),
      shift: made.shift,
      shapeId: shape.id, vertexIndex: sel.vertexIndex,
    };
    clearGcpSelection();
    recomputeFit();
    autosave();
    draw(); renderWidget();
    toastOk(`Control point ${g.id}: vertex ${sel.vertexIndex} moves ${made.shift.toFixed(2)} m. Drag its handle to refine at any zoom.`);
  }

  // Loose points, for correcting against something that is not an existing
  // vertex — a surveyed mark, or a feature identifiable in the imagery.
  function addLooseGcp(clientX, clientY) {
    const pt = st.adapter.clientToMapCoord(clientX, clientY);
    if (!pt) return toastErr('Could not read a map coordinate there.');
    commit('add a loose control point');
    const g = {
      id: st.nextGcpId++, shapeId: null, vertexIndex: null,
      source: pt.slice(), target: pt.slice(), enabled: true,
    };
    st.gcps.push(g);
    st.activeGcpId = g.id;
    recomputeFit(); autosave(); draw(); renderWidget();
    toastOk(`Loose control point ${g.id} placed. Drag its handle to the true position — it starts with zero shift.`);
  }

  /* =====================================================================
   * EDITING AS EVIDENCE
   * ---------------------------------------------------------------------
   * Dragging a corner to where it really belongs is the same statement as
   * tagging a control point: "the geometry says here, the truth is there".
   * Until now the app threw that statement away and asked the operator to
   * repeat it through a separate two-step GCP workflow. It no longer does.
   *
   * The GCP records the ORIGINAL position as its source, because that is what
   * the untrusted geometry claimed. Using the new position as the source would
   * record a zero shift and teach the fit nothing.
   * =================================================================== */
  function noteVertexMoved(shape, vertexIndex, origin) {
    if (!S.autoGcpFromEdit || !origin) return;
    const now = shape.points[vertexIndex];
    if (!now) return;
    const shift = Math.hypot(now[0] - origin[0], now[1] - origin[1]);
    // A nudge below the snap tolerance is a tidy-up, not a georeferencing
    // observation, and turning every one into evidence would swamp the fit.
    const floor = Math.max(Number(S.snapToleranceM) || 0.5, 0.05);
    if (!(shift > floor)) return;

    // One control point per corner. Re-dragging the same corner refines the
    // existing observation rather than stacking a second, contradictory one on
    // top of it — that stacking is how a fit silently goes wrong.
    const existing = st.gcps.find((g) => g.shapeId === shape.id && g.vertexIndex === vertexIndex);
    if (existing) {
      existing.target = now.slice();
      st.lastCapture = {
        gcpId: existing.id, source: existing.source, target: existing.target,
        lonLat: toLonLat(existing.target),
        shift: Math.hypot(existing.target[0] - existing.source[0], existing.target[1] - existing.source[1]),
        shapeId: shape.id, vertexIndex, fromEdit: true,
      };
      recomputeFit();
      toast(`Control point ${existing.id} refined — now a ${st.lastCapture.shift.toFixed(2)} m shift.`, 'info', 3600);
      return;
    }

    const g = {
      id: st.nextGcpId++, shapeId: shape.id, vertexIndex,
      source: origin.slice(), target: now.slice(), enabled: true, fromEdit: true,
    };
    st.gcps.push(g);
    st.activeGcpId = g.id;
    st.lastCapture = {
      gcpId: g.id, source: g.source, target: g.target,
      lonLat: toLonLat(g.target), shift, shapeId: shape.id, vertexIndex, fromEdit: true,
    };
    recomputeFit();
    toastOk(`Corner moved ${shift.toFixed(2)} m — recorded as control point ${g.id}. ${st.gcps.length === 1 ? 'One more and the fit can be cross-checked.' : `${st.gcps.length} now available to georeference the rest.`}`);
  }

  /* A corner shared with neighbouring parcels moves them with it.
   *
   * This is the fix for adjacent boundaries crossing. Two parcels that meet
   * along a line share the corner coordinates; moving one copy and leaving the
   * other behind converts a shared edge into a pair of edges that cross. Rather
   * than detect that afterwards and complain, keep it from happening.
   */
  function keepNeighboursConsistent(shape, vertexIndex, origin) {
    if (!S.dragSharedCorners || !origin) return 0;
    const now = shape.points[vertexIndex];
    if (!now) return 0;
    const tol = Math.max(Number(S.snapToleranceM) || 0.5, 1e-9);
    const shared = Topo.findCoincidentVertices(st.shapes, origin, tol, shape.id);
    if (!shared.length) return 0;

    const touched = new Set();
    for (const hit of shared) {
      const other = findShape(hit.shapeId);
      if (!other || !other.points[hit.vertexIndex]) continue;
      other.points[hit.vertexIndex] = now.slice();
      refreshShapeMetrics(other);
      touched.add(other.id);
    }
    if (touched.size) {
      toast(`That corner is shared — ${touched.size} neighbouring shape(s) moved with it, so the boundary stays common instead of crossing.`, 'info', 5200);
    }
    return touched.size;
  }

  /* GCPs address a corner by index, so inserting or deleting a vertex silently
   * re-points every later GCP at the wrong corner. These keep them honest. */
  function shiftGcpVertexIndices(shapeId, fromIndex, delta) {
    for (const g of st.gcps) {
      if (g.shapeId === shapeId && g.vertexIndex != null && g.vertexIndex >= fromIndex) {
        g.vertexIndex += delta;
      }
    }
  }
  function dropGcpsForVertexRemoval(shapeId, index) {
    const before = st.gcps.length;
    // A control point for a corner that no longer exists is not recoverable
    // evidence, so it goes rather than quietly attaching to its neighbour.
    st.gcps = st.gcps.filter((g) => !(g.shapeId === shapeId && g.vertexIndex === index));
    shiftGcpVertexIndices(shapeId, index + 1, -1);
    const lost = before - st.gcps.length;
    if (lost) {
      toast(`${lost} control point(s) removed with that corner.`, 'info', 3600);
      recomputeFit();
    }
  }

  /* Did the flood fill escape the parcel that was actually selected?
   *
   * The portal tells us the bounding box of the parcel the operator clicked, so
   * a trace reaching well beyond it has leaked through a gap in the drawn
   * boundary and swallowed a neighbour. The ring still looks plausible — closed,
   * sensible area — so without this check the operator exports a boundary for
   * the wrong piece of land and nothing anywhere says so.
   */
  function warnIfTraceLeaked(shape) {
    const bbox = shape.bbox || st.plotBbox;
    if (!bbox) return null;
    const leak = Topo.bboxLeakage(shape.points, bbox);
    if (!leak) return null;
    // Record the measurement whatever it says. The setting below governs only
    // whether to interrupt with a toast; the quality report applies its own
    // thresholds and must not be blinded by how this one happens to be set.
    shape.leak = leak;
    const limit = Number(S.bboxLeakWarnPct);
    if (!(limit > 0) || leak.leakedPct <= limit) return leak;
    toast(
      `⚠️ About ${leak.leakedPct.toFixed(0)}% of that trace lies outside the bounding box the portal gave for ` +
      `${shape.plotNo ? 'plot ' + shape.plotNo : 'the selected parcel'}. The fill has probably escaped through a gap ` +
      `in the boundary and taken in a neighbour. Raise "Leak protection" or lower "Colour tolerance" under Settings ` +
      `and retrace — Ctrl+Z removes this one.`,
      'warn', 12000);
    return leak;
  }

  /* Compare the crossing pairs before and after an operation and report only
   * what the operation itself introduced. Undo is offered by name, because
   * knowing a mistake was made is only useful with a way back. */
  function crossingSnapshot() {
    return S.warnNewCrossings ? Topo.crossingPairs(st.shapes) : new Set();
  }
  function reportNewCrossings(before, what) {
    if (!S.warnNewCrossings || !before) return 0;
    const added = Topo.newCrossings(before, Topo.crossingPairs(st.shapes));
    if (!added.length) return 0;
    toast(`⚠️ ${what} made ${added.length} pair(s) of boundaries overlap that did not before (shapes ${added.map((k) => k.replace('|', ' & ')).join(', ')}). Press Ctrl+Z to undo, or use Snap to neighbours to close the gap properly.`, 'warn', 11000);
    return added.length;
  }

  function enabledGcps() { return st.gcps.filter((g) => g.enabled !== false); }
  /* How many shapes "Move tagged shapes" would actually touch, so the button can
   * say so instead of leaving the scope to be discovered by pressing it. */
  function taggedShapeCount() {
    const ids = new Set(enabledGcps().map((g) => g.shapeId).filter((v) => v != null));
    return st.shapes.filter((s) => ids.has(s.id)).length;
  }
  function gcpPairs() {
    return enabledGcps().map((g) => ({ vertexIndex: g.vertexIndex, rawPoint: g.source, confirmedPoint: g.target }));
  }

  function recomputeFit(quick) {
    const pairs = gcpPairs();
    // One point is enough for a pure shift, which is the commonest correction
    // and the only one that cannot distort the plot.
    if (pairs.length < 1) { st.gcpFit = null; st.gcpRecommendation = null; return; }
    if (S.autoRecommend && !quick) {
      const rec = st.gcpRecommendation = GcpMath.recommendTransform(pairs);
      // Adopt a cross-validated recommendation. Failing that, still fall back to
      // the simplest solvable model rather than leaving the user staring at a
      // "needs more points" error for a model they never chose.
      const row = rec.table.find((t) => t.type === S.transformType);
      const currentUnusable = !row || !row.solvable;
      if (rec.recommended && (rec.validated || currentUnusable)) {
        S.transformType = rec.recommended;
        saveSettings();
      }
    }
    st.gcpFit = GcpMath.fitGcpTransform(pairs, S.transformType, { robust: !!S.robustFitting });
  }

  function applyCorrection(scope) {
    if (!st.gcpFit || !st.gcpFit.ok) return toastErr('Compute a valid fit first.');
    const fit = st.gcpFit.fit;
    let targets;
    if (scope === 'all') targets = st.shapes;
    else {
      const ids = new Set(enabledGcps().map((g) => g.shapeId).filter((v) => v != null));
      targets = st.shapes.filter((s) => ids.has(s.id));
      if (!targets.length) {
        return toastErr('No control point is anchored to a shape. Use "Move every shape" instead, or place a control point on a boundary corner.');
      }
    }

    // PRE-FLIGHT. The operator reported shapes "shifting somewhere else" on
    // Apply, and the reason is that Apply used to be a leap of faith: a button
    // whose effect was only visible afterwards. Now the exact effect is stated
    // and has to be accepted first.
    const preview = describeApply(fit, targets);
    if (!confirm(preview.prompt)) return;

    const crossBefore = crossingSnapshot();
    commit(`apply ${fit.type} to ${targets.length} shape(s)`);

    for (const shape of targets) {
      if (!st.backups[shape.id]) st.backups[shape.id] = shape.points.map((p) => p.slice());
      shape.points = shape.points.map((p) => fit.apply(p));
      shape.lastGcpCorrection = {
        type: fit.type,
        rmsMeters: st.gcpFit.rms,
        looMeters: st.gcpFit.looRms,
        gcpCount: enabledGcps().length,
        appliedAt: Date.now(),
      };
      refreshShapeMetrics(shape);
    }

    // CONSUME THE CORRECTION.
    //
    // This is the cause of the reported "it moves somewhere different every
    // time". A control point says "the geometry claims `source`, the truth is
    // `target`". Once the shape has been moved, its corner IS at `target`, so
    // the claim is out of date — but the old `source` stayed on file, the fit
    // still measured the same shift, and pressing Apply again applied it a
    // second time. Two presses moved the parcel twice as far, three presses
    // three times, with no warning.
    //
    // Advancing the sources through the same transform makes the fit an identity
    // and a repeat press a genuine no-op, which is what the operator expected
    // all along. The control points remain on screen as the record of what was
    // done, and Revert still restores the untouched geometry from the backup.
    const correctedIds = new Set(targets.map((s) => s.id));
    for (const g of st.gcps) {
      if (g.shapeId == null || correctedIds.has(g.shapeId)) g.source = fit.apply(g.source);
    }
    recomputeFit();

    autosave(); draw(); renderWidget();
    toastOk(`${describeModel(fit.type)} applied to ${targets.length} shape(s). The control points now read as satisfied, so pressing Apply again will not move anything a second time. Ctrl+Z undoes it; "Revert" restores the original geometry.`);
    reportNewCrossings(crossBefore, 'That correction');
  }

  const MODEL_WORDS = {
    translation: 'a straight shift, with no resizing or rotation',
    similarity: 'a shift plus a uniform resize and rotation',
    affine: 'a shift, resize, rotation and shear',
    projective: 'a perspective warp',
    tps: 'a flexible rubber-sheet warp',
  };
  const describeModel = (type) => `${type} (${MODEL_WORDS[type] || 'a fitted transform'})`;

  /* Spell out what Apply is about to do, in metres, before it does it. */
  function describeApply(fit, targets) {
    const unit = areaUnit() === 'px²' ? 'px' : 'm';
    const lines = [];
    let maxMove = 0, maxShape = null;
    for (const shape of targets) {
      const c = centroidOf(shape.points);
      const moved = fit.apply(c);
      const d = Math.hypot(moved[0] - c[0], moved[1] - c[1]);
      if (d > maxMove) { maxMove = d; maxShape = shape; }
    }
    lines.push(`Move ${targets.length} shape(s) using ${describeModel(fit.type)}.`);
    lines.push('');
    lines.push(`Furthest move: ${maxMove.toFixed(2)} ${unit}${maxShape ? ` (shape ${maxShape.id}${maxShape.plotNo ? ', plot ' + maxShape.plotNo : ''})` : ''}.`);

    // Distortion is the part that bites: a model with a scale or rotation term
    // moves distant corners further than near ones, so a fit that looks perfect
    // on the tagged corners can still stretch the plot.
    const radius = Math.max(20, spanOf(targets));
    const mag = GcpMath.describeFitMagnitude(fit, radius);
    if (mag.distortionAtRadius > 0.001) {
      lines.push(`Shape change: a corner ${radius.toFixed(0)} ${unit} from the centre also moves an EXTRA ${mag.distortionAtRadius.toFixed(2)} ${unit} relative to the rest, so the outline will be resized or rotated, not just shifted.`);
    } else {
      lines.push(`Shape change: none. Every corner moves by exactly the same amount, so sizes, angles and areas are preserved.`);
    }

    const en = enabledGcps().length;
    if (st.gcpFit.exactlyDetermined) {
      lines.push('');
      lines.push(`⚠️ ${en} control point(s) is the bare minimum for this model, so its reported error of zero is arithmetic, not accuracy. It has not been checked against anything.`);
    } else if (st.gcpFit.looRms != null) {
      lines.push('');
      lines.push(`Cross-checked accuracy: ±${st.gcpFit.looRms.toFixed(2)} ${unit} on a corner it was not shown.`);
    }
    const already = targets.filter((s) => s.lastGcpCorrection).length;
    if (already) {
      lines.push('');
      lines.push(`Note: ${already} of these shape(s) were already corrected once. "Revert" still restores the original geometry.`);
    }
    lines.push('');
    lines.push('Apply this? (Ctrl+Z will undo it.)');
    return { prompt: lines.join('\n'), maxMove, distortion: mag.distortionAtRadius };
  }

  function centroidOf(points) {
    let x = 0, y = 0;
    for (const p of points) { x += p[0]; y += p[1]; }
    return [x / points.length, y / points.length];
  }
  /* Half the diagonal of everything being moved: the distance at which
   * distortion should be quoted, because that is how far the geometry actually
   * reaches from its own centre. */
  function spanOf(shapes) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const s of shapes) {
      for (const p of s.points) {
        if (p[0] < xmin) xmin = p[0];
        if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      }
    }
    if (!isFinite(xmin)) return 0;
    return Math.hypot(xmax - xmin, ymax - ymin) / 2;
  }

  function revertShape(id) {
    const b = st.backups[id];
    const shape = findShape(id);
    if (!b || !shape) return false;
    commit(`revert shape ${id}`);
    shape.points = b.map((p) => p.slice());
    // The shift record describes what was done to the original. Restoring the
    // original without clearing it would leave the parcel claiming a correction
    // it no longer carries.
    shape.shift = GeomEdit.identityShift();
    delete shape.lastGcpCorrection;
    delete st.backups[id];
    refreshShapeMetrics(shape);
    autosave(); draw(); renderWidget();
    toastOk('Reverted to the original geometry.');
    return true;
  }

  // Zooming is manual and explicit. Nothing in the tool moves the view unless
  // the operator asks for it.
  async function zoomToPoint(mapPt) {
    const A = st.adapter;
    if (!A || !mapPt) return;
    const z = A.getZoom();
    const maxZ = A.getMaxZoom();
    A.setCenter(mapPt);
    if (z != null) {
      A.setZoom(Math.min(typeof maxZ === 'number' ? maxZ : 24, z + (Number(S.manualZoomBoost) || 5)));
    }
    await A.waitForRender(Math.max(400, Number(S.imageryWaitMs) || 2500));
    draw(); renderWidget();
  }

  async function zoomToGcp(id) {
    const g = st.gcps.find((x) => x.id === id);
    if (!g) return;
    st.activeGcpId = id;
    await zoomToPoint(g.target);
    toast('Zoomed in. Drag the handle onto the true corner — pan and zoom freely while you do, or nudge with the arrow keys.', 'info', 5000);
  }

  /* =====================================================================
   * DRAW UNDO
   * =================================================================== */
  function pushDrawUndo() {
    st.drawUndo.push(st.drawPoints.slice());
    if (st.drawUndo.length > 200) st.drawUndo.shift();
    st.drawRedo = [];
  }
  function undoDraw() {
    if (!st.drawUndo.length) return;
    st.drawRedo.push(st.drawPoints.slice());
    st.drawPoints = st.drawUndo.pop();
    draw(); renderWidget();
  }
  function redoDraw() {
    if (!st.drawRedo.length) return;
    st.drawUndo.push(st.drawPoints.slice());
    st.drawPoints = st.drawRedo.pop();
    draw(); renderWidget();
  }

  /* =====================================================================
   * EXPORTS
   * =================================================================== */
  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // In workspace mode the shapes handed to the exporters are already in CRS
  // coordinates (see shapesForExport), so toLonLat here must convert FROM that
  // CRS rather than from pixels again.
  function exportCrs() { return isWorkspace() ? (st.georef && st.georef.crs) : st.crs; }

  function exportOpts() {
    const crs = exportCrs();
    return {
      toLonLat: (p) => (crs ? Crs.toWgs84(p[0], p[1], crs) : null),
      crsLabel: isWorkspace() && !hasGeoref()
        ? `image pixels (${st.adapter.sourceName}) — NOT georeferenced`
        : Crs.describeCrs(crs),
      scaleFactor: S.applyScaleToAllExports ? (Number(S.scaleFactor) || 1) : 1,
      georefMode: S.dxfGeorefMode,
      documentName: st.projectName || 'Digitized Plots',
      includeValidity: true,
    };
  }

  function requireShapes() {
    if (!st.shapes.length) { toastErr('Nothing digitised yet.'); return false; }
    return true;
  }
  function warnIfCrsUnconfirmed() {
    if (isWorkspace()) {
      if (!hasGeoref()) {
        toastErr('This image is not georeferenced, so there are no real-world coordinates to export. Use 🌐 Georeference, or export DXF/CSV which can carry pixel coordinates.');
        return true;
      }
      if (st.georef.looRms == null) {
        toast('Only two georeference points, so nothing cross-checks the fit. Add a third before trusting the output.', 'warn', 8000);
      }
      return false;
    }
    if (!st.crs) {
      toastErr('The coordinate system is not set, so exports cannot be georeferenced. Confirm it in the CRS panel first.');
      return true;
    }
    if (st.crsDetection && st.crsDetection.needsConfirmation) {
      toast('Heads up: the coordinate system is a best guess and has not been confirmed. Check the CRS panel if the output lands in the wrong place.', 'warn', 8000);
    }
    return false;
  }

  const EXPORTS = {
    dxf() {
      const r = Exp.makeDxf(shapesForExport(), exportOpts());
      download('plots.dxf', r.text, 'application/dxf');
      toastOk(`DXF written: ${r.plotsWritten} plot(s), ${r.mode} georeferencing, origin ${r.origin[0]}, ${r.origin[1]}.`);
    },
    kmz() {
      if (warnIfCrsUnconfirmed()) return;
      const kml = Exp.makeKml(shapesForExport(), exportOpts());
      download('plots.kmz', new Blob([Exp.makeZipBytes([{ name: 'doc.kml', data: kml }])], { type: 'application/vnd.google-earth.kmz' }));
      toastOk('KMZ written — open it directly in Google Earth.');
    },
    /* Uncompressed KML alongside KMZ. Both open in Google Earth; a plain .kml
     * is the one that can be inspected and edited in a text editor, which
     * matters when a parcel comes back looking wrong. */
    kml() {
      if (warnIfCrsUnconfirmed()) return;
      download('plots.kml', Exp.makeKml(shapesForExport(), exportOpts()),
        'application/vnd.google-earth.kml+xml');
      toastOk('KML written — open it directly in Google Earth.');
    },
    geojson() {
      if (warnIfCrsUnconfirmed()) return;
      const gj = Exp.makeGeoJson(shapesForExport(), exportOpts());
      download('plots.geojson', JSON.stringify(gj, null, 2), 'application/geo+json');
      toastOk(`GeoJSON written: ${gj.features.length} feature(s).`);
    },
    shapefile() {
      if (warnIfCrsUnconfirmed()) return;
      const r = Exp.shapefileZipBytes(shapesForExport(), {
        baseName: 'plots',
        prjWkt: Exp.prjWktFor(exportCrs()),
      });
      download('plots_shapefile.zip', new Blob([r.bytes], { type: 'application/zip' }));
      toastOk(`Shapefile bundle written: ${r.recordCount} record(s), with .prj.`);
    },
    wkt() {
      download('plots.wkt', Exp.makeWkt(shapesForExport(), exportOpts()), 'text/plain');
      toastOk('WKT written.');
    },
    vertexCsv() {
      download('plot_vertices.csv', Exp.makeVertexCsv(shapesForExport(), exportOpts()), 'text/csv');
      toastOk('Vertex CSV written.');
    },
    areaCsv() {
      download('plot_areas.csv', Exp.makeAreaReportCsv(shapesForExport(), exportOpts()), 'text/csv');
      toastOk('Area report written.');
    },
    gcps() {
      if (!st.gcps.length) return toastErr('No control points to export.');
      const pairs = gcpPairs();
      const res = st.gcpFit && st.gcpFit.residuals;
      const withRes = pairs.map((p, i) => Object.assign({}, p, { residual: res ? res[i] : null }));
      download('control_points.points', Exp.makeGcpPointsFile(withRes, exportOpts()), 'text/plain');
      toastOk(`${pairs.length} control point(s) written — reloadable here or in QGIS.`);
    },
    project() {
      download((st.projectName || 'digitizer-project') + '.json', JSON.stringify(serialiseSession(), null, 2), 'application/json');
      toastOk('Project JSON written.');
    },
  };

  function importFile(kind) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = kind === 'gcps' ? '.points,.csv,.txt' : '.json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const text = String(rd.result || '');
        if (kind === 'gcps') {
          /* The QGIS .points format is self-describing, so it loads directly —
           * the existing parser stays the reader for it (brief §6: retain what
           * is there). Anything else is a CSV whose layout has to be confirmed
           * before a single row is believed, because a column read as an
           * easting when it is a northing produces a fit that is wrong by
           * hundreds of kilometres while reporting a residual of zero. */
          if (!Imp.looksLikeQgisPoints(text)) {
            const preview = Imp.previewCsv(text);
            if (!preview.ok) return toastErr(preview.error);
            const sug = preview.suggestion;
            st.csvDialog = {
              purpose: 'gcps',
              fileName: f.name,
              text,
              preview,
              mapping: Object.assign({}, sug),
              formatKey: 'auto',
              // A control-point file may carry both halves of the pair. Where
              // four numeric columns are present the first two are offered as
              // the source, which is the QGIS-like layout.
              sourceX: null,
              sourceY: null,
            };
            renderWidget();
            return toast('Check the columns below, then press Import. Nothing is read until you confirm.', 'info', 7000);
          }
          const r = Exp.parseGcpPointsFile(text);
          if (!r.pairs.length) return toastErr('No usable control points found in that file.');
          commit(`load ${r.pairs.length} control point(s) from a file`);
          for (const p of r.pairs) {
            st.gcps.push({
              id: st.nextGcpId++, shapeId: null, vertexIndex: null,
              source: p.rawPoint, target: p.confirmedPoint, enabled: p.enabled !== false,
            });
          }
          recomputeFit(); autosave(); draw(); renderWidget();
          toastOk(`${r.pairs.length} control point(s) loaded.${r.errors.length ? ' ' + r.errors.length + ' line(s) skipped.' : ''}`);
          r.errors.forEach((e) => toast(e, 'warn', 5000));
        } else {
          const data = safe(() => JSON.parse(text), null);
          if (!data) return toastErr('That file is not valid JSON.');
          // Loading a project REPLACES the whole session, so it is the single
          // most destructive action in the program. Warn if there is anything to
          // lose, and make it undoable either way.
          const losing = describeSessionContents();
          if (losing.length && !confirm(
            `Loading a project replaces everything in this session.\n\nYou would lose:\n  • ${losing.join('\n  • ')}\n\nCtrl+Z will undo the load. Continue?`)) return;
          commit('load a project');
          if (!restoreSession(data)) { dropCommit(); return toastErr('That JSON does not look like a digitizer project.'); }
          st.shapes.forEach(refreshShapeMetrics);
          recomputeFit(); autosave(); draw(); renderWidget();
          toastOk(`Project loaded: ${st.shapes.length} shape(s), ${st.gcps.length} control point(s). Ctrl+Z undoes the load.`);
        }
      };
      rd.readAsText(f);
    };
    input.click();
  }

  /* =====================================================================
   * WIDGET
   * =================================================================== */
  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
#${WIDGET_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:372px;max-height:90vh;display:flex;flex-direction:column;
background:#07111f;color:#e5e7eb;border:1px solid rgba(148,163,184,.45);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);
font:13px/1.45 "Segoe UI",system-ui,Arial,sans-serif}
#${WIDGET_ID} *{box-sizing:border-box}
#${WIDGET_ID}.min{width:auto;max-height:none}
#${WIDGET_ID}.min .body{display:none}
.bnd15-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;font-weight:800;cursor:move;
background:linear-gradient(135deg,#0ea5e9,#1d4ed8);border-radius:13px 13px 0 0;user-select:none}
.bnd15-head .ver{font-weight:600;font-size:10px;opacity:.85}
.bnd15-head button{border:0;background:rgba(255,255,255,.2);color:#fff;border-radius:7px;cursor:pointer;padding:3px 7px;line-height:1}
.body{padding:10px;overflow-y:auto}
.bnd15-row{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}
.bnd15-btn{flex:1;min-width:74px;border:0;border-radius:8px;padding:7px 8px;font-size:11.5px;font-weight:700;cursor:pointer;color:#fff;background:#334155}
.bnd15-btn:hover{filter:brightness(1.15)}
.bnd15-btn:disabled{opacity:.45;cursor:not-allowed}
.bnd15-btn.blue{background:#0284c7}.bnd15-btn.cyan{background:#0891b2}.bnd15-btn.green{background:#059669}
.bnd15-btn.teal{background:#0d9488}.bnd15-btn.red{background:#dc2626}.bnd15-btn.orange{background:#ea580c}
.bnd15-btn.violet{background:#7c3aed}.bnd15-btn.gray{background:#475569}
.bnd15-btn.on{outline:2px solid #facc15;outline-offset:1px}
.bnd15-btn.sm{flex:0 0 auto;min-width:0;padding:4px 8px;font-size:10.5px}
.card{border:1px solid rgba(148,163,184,.25);border-radius:9px;padding:8px;margin-bottom:7px}
.card h4{margin:0 0 5px;font-size:11.5px;letter-spacing:.03em;text-transform:uppercase;color:#94a3b8}
.mono{font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
.dim{color:#94a3b8;font-size:11px}
.ok{color:#34d399}.warn{color:#fbbf24}.bad{color:#f87171}
.pill{display:inline-block;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:700}
.pill.ok{background:rgba(16,185,129,.2);color:#6ee7b7}
.pill.warn{background:rgba(250,204,21,.2);color:#fde047}
.pill.bad{background:rgba(239,68,68,.2);color:#fca5a5}
.pill.imp{background:rgba(56,189,248,.2);color:#7dd3fc}

/* ---- the three main buttons and their menus (brief §1) ---------------
 * The menus are always in the DOM and revealed with a class, never built on
 * open, so anything looking for a control by id can still find it. */
.bnd15-main{position:relative;margin-bottom:7px}
.bnd15-menu{display:none;margin-top:5px;border:1px solid rgba(148,163,184,.35);border-radius:9px;
padding:5px;background:rgba(2,6,23,.7)}
.bnd15-menu.open{display:block}
.bnd15-menu .mh{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8;padding:2px 4px 4px}
.bnd15-menu .mn{font-size:10px;color:#64748b;padding:5px 4px 2px;border-top:1px solid rgba(148,163,184,.18);margin-top:4px;line-height:1.4}
.bnd15-mi{display:block;width:100%;text-align:left;border:0;background:transparent;color:#e5e7eb;
padding:6px 8px;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit}
.bnd15-mi:hover{background:rgba(56,189,248,.16)}

/* ---- collapsible sections (brief §7) ---- */
details.sect{padding:0}
details.sect>summary{list-style:none;cursor:pointer;padding:7px 8px;font-size:11.5px;font-weight:700;
letter-spacing:.02em;color:#93c5fd;display:flex;justify-content:space-between;align-items:center;gap:6px}
details.sect>summary::-webkit-details-marker{display:none}
details.sect>summary::after{content:'▸';color:#64748b;font-size:10px}
details.sect[open]>summary::after{content:'▾'}
details.sect .sect-b{padding:0 8px 8px}

.bnd15-hist{margin:5px 0}
.item.sel{outline:1px solid rgba(250,204,21,.6);border-radius:6px}
.csvprev{max-height:120px;overflow:auto;border:1px solid rgba(148,163,184,.25);border-radius:7px;margin:5px 0}
.csvprev table{border-collapse:collapse;font-size:10.5px;width:100%}
.csvprev th{position:sticky;top:0;background:#0f1e33;color:#93c5fd;text-align:left;padding:3px 5px;white-space:nowrap}
.csvprev td{padding:2px 5px;border-top:1px solid rgba(148,163,184,.14);white-space:nowrap;color:#cbd5e1}
.list{max-height:150px;overflow-y:auto;border:1px solid rgba(148,163,184,.2);border-radius:8px}
.item{display:flex;align-items:center;gap:5px;padding:5px 7px;font-size:11px;border-bottom:1px solid rgba(148,163,184,.14)}
.item:last-child{border-bottom:0}
.item .grow{flex:1;min-width:0}
.item button{border:0;border-radius:5px;padding:2px 6px;font-size:10px;cursor:pointer;color:#fff;background:#475569}
.item button.del{background:#b91c1c}
.item.bad{background:rgba(239,68,68,.1)}
.item.off{opacity:.5}
.field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;font-size:11px}
.field input[type=range]{flex:1;min-width:70px}
.field input[type=number],.field input[type=text],.field select{background:#0f172a;color:#e5e7eb;border:1px solid rgba(148,163,184,.35);border-radius:6px;padding:3px 5px;font-size:11px;max-width:130px}
.adv{border-top:1px solid rgba(148,163,184,.22);margin-top:6px;padding-top:6px}
.adv-t{cursor:pointer;display:flex;justify-content:space-between;font-size:11.5px;font-weight:700;color:#93c5fd}
.adv-b{display:none;margin-top:6px}
.adv-b.open{display:block}
.status{background:rgba(15,23,42,.85);border:1px solid rgba(148,163,184,.25);border-radius:8px;padding:6px 8px;font-size:11px;color:#cbd5e1;margin-bottom:6px}
#${PILL_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483646;border:0;border-radius:99px;padding:10px 16px;cursor:pointer;
background:linear-gradient(135deg,#0ea5e9,#1d4ed8);color:#fff;font:700 13px/1 "Segoe UI",Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)}
#${TOAST_ID}{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.bnd15-toast{max-width:520px;padding:9px 14px;border-radius:9px;font:600 12.5px/1.4 "Segoe UI",Arial,sans-serif;color:#f8fafc;
background:rgba(30,41,59,.97);border:1px solid rgba(148,163,184,.4);box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .25s,transform .25s}
.bnd15-toast.ok{border-color:#059669;background:rgba(6,78,59,.97)}
.bnd15-toast.err{border-color:#dc2626;background:rgba(127,29,29,.97)}
.bnd15-toast.warn{border-color:#d97706;background:rgba(120,53,15,.97)}
.bnd15-toast.out{opacity:0;transform:translateY(8px)}
.step{background:rgba(250,204,21,.13);border:1px solid rgba(250,204,21,.5);border-radius:8px;padding:7px 8px;margin:6px 0;font-size:11.5px;color:#fef9c3;line-height:1.5}
.step b{color:#fde047}
.capture{background:rgba(16,185,129,.14);border:1px solid rgba(16,185,129,.45);border-radius:8px;padding:7px 8px;margin:6px 0;font-size:11px;color:#d1fae5}
table.coord{width:100%;margin-top:4px;border-collapse:collapse}
table.coord td{padding:1px 0;font-size:10.5px}
table.coord td:first-child{width:52px}
.wf{display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-top:1px solid rgba(148,163,184,.12)}
.wf:first-of-type{border-top:0}
.wf-m{flex:0 0 16px;font-size:11px;line-height:1.5}
.wf-b{flex:1 1 auto;font-size:11px;line-height:1.45}
.wf-h{font-size:10.5px;line-height:1.45;margin-top:1px}
.wf-done .wf-b b{color:#6ee7b7}
.wf-done .wf-h{color:#5b7c72}
.wf-now{background:rgba(250,204,21,.10);border-radius:6px;padding:5px 4px}
.wf-now .wf-b b{color:#fde047}
.wf-now .wf-h{color:#fef9c3}
.wf-todo .wf-b b{color:#94a3b8}
.wf-todo .wf-h{color:#64748b}
.credit{flex:0 0 auto;padding:6px 10px;border-top:1px solid rgba(148,163,184,.22);
        font-size:10.5px;color:#64748b;text-align:center;border-radius:0 0 13px 13px;background:rgba(2,6,23,.4)}
.credit b{color:#94a3b8}
`;
    document.head.appendChild(el);
  }

  function statusLine() {
    if (st.busy) return '⏳ Working at high zoom for accuracy — your view will be restored.';
    const A = st.adapter;
    const base = A ? `${A.label} detected` : 'no map';
    switch (st.mode) {
      case 'trace': return `👉 Tap inside a parcel to trace it. Drag to pan, scroll to zoom — both still work.`;
      case 'draw': return `👉 Tap each corner (${st.drawPoints.length} so far). Ctrl+Z / Ctrl+Y. Finish when done.`;
      case 'edit': return `✥ Drag the white handles. Tap an edge to insert. Alt+tap a handle to delete.`;
      case 'select': return `👆 Tap inside a parcel to select it. The Edit tools act on the selected parcel.`;
      case 'move': return st.selectedShapeId
        ? `✥ Drag the parcel to move it — the map does not move, only the parcel. Ctrl+Z undoes it.`
        : `✥ Drag a parcel to move it bodily. Map pan and zoom still work everywhere else.`;
      case 'calibrate': return st.calibrationPick.length === 1
        ? `📏 Now tap the other end of the distance you know.`
        : `📏 Tap the two ends of a distance you know on the drawing.`;
      case 'georef': return st.georefPick
        ? `🌐 Now type the real-world coordinate of the ringed point in the panel.`
        : `🌐 Tap a point on the image whose real-world coordinate you know.`;
      case 'gcp': return st.gcpStage === 'placeTarget'
        ? `📍 Step 2 of 2 — tap where the ringed corner really is. Pan and zoom first if you need to. Esc cancels.`
        : `📍 Step 1 of 2 — tap a corner to nominate it (or pick one from the list). Alt+tap places a loose point.`;
      default: return st.shapes.length
        ? `✅ ${st.shapes.length} shape(s) digitised — ${base}.`
        : `Ready — ${base}. Trace or Draw to begin.`;
    }
  }

  /* =====================================================================
   * WORKFLOW GUIDE
   * ---------------------------------------------------------------------
   * The old panel showed step numbers only INSIDE the control-point tool, so
   * "Step 1 of 2" appeared with no indication of what the two steps were part
   * of, or whether they were even necessary. This is the whole job, in order,
   * with each stage marked done / current / not needed, and one sentence saying
   * what to do now.
   *
   * Stage 3 is explicitly optional. Control points are for when the portal's
   * geometry is offset from the truth; if it is not, tracing and exporting is
   * the entire workflow, and the panel should say so rather than implying that
   * every job needs georeferencing.
   * =================================================================== */
  function workflowHtml() {
    const hasShapes = st.shapes.length > 0;
    const hasGcps = st.gcps.length > 0;
    const applied = st.shapes.some((s) => s.lastGcpCorrection);
    const needsCrs = !isWorkspace() && st.crsDetection && st.crsDetection.needsConfirmation;
    const needsGeoref = isWorkspace() && !hasGeoref();

    const stages = [];

    if (isWorkspace()) {
      stages.push({
        n: 1, name: 'Georeference the sheet',
        done: !needsGeoref,
        active: needsGeoref,
        hint: needsGeoref
          ? 'Coordinates are image pixels until at least two points on this image are given real-world coordinates. You can trace first and georeference after.'
          : 'Done — pixels now convert to real coordinates.',
      });
    } else {
      stages.push({
        n: 1, name: 'Confirm the coordinate system',
        done: !!st.crs && !needsCrs,
        active: needsCrs,
        hint: needsCrs
          ? 'The zone could not be determined from the page alone. Set it above — a wrong zone puts exports hundreds of kilometres out.'
          : (st.crs ? `Done — ${Crs.describeCrs(st.crs)}.` : 'Waiting for the map to report a projection.'),
      });
    }

    stages.push({
      n: 2, name: 'Digitise the parcels',
      done: hasShapes,
      active: !hasShapes,
      hint: hasShapes
        ? `${st.shapes.length} shape(s) captured. Every corner already carries a coordinate — see the vertex list or export them.`
        : 'Trace fills a coloured parcel in one tap. Draw places corners by hand. Auto-trace does the whole visible view.',
    });

    stages.push({
      n: 3, name: 'Correct the position', optional: true,
      done: applied,
      active: hasShapes && !applied && hasGcps,
      hint: !hasShapes
        ? 'Only needed once something is digitised.'
        : applied
          ? 'A correction has been applied. Pressing Apply again will not move anything further.'
          : hasGcps
            ? `${st.gcps.length} control point(s) recorded. Review the fit below, then Apply.`
            : 'ONLY needed if the portal draws parcels away from their true position. Otherwise skip straight to export. To correct: switch to Edit and drag a corner where it belongs — that alone records a control point.',
    });

    stages.push({
      n: 4, name: 'Check and export',
      done: false,
      active: hasShapes && (applied || !hasGcps),
      hint: hasShapes
        ? 'Run the quality check, then export DXF, KMZ, GeoJSON, Shapefile, WKT or a vertex list.'
        : 'Nothing to export yet.',
    });

    const rows = stages.map((s) => {
      const mark = s.done ? '✅' : s.active ? '👉' : '○';
      const cls = s.done ? 'wf-done' : s.active ? 'wf-now' : 'wf-todo';
      return `<div class="wf ${cls}">
        <span class="wf-m">${mark}</span>
        <span class="wf-b"><b>${s.n}. ${esc(s.name)}</b>${s.optional ? ' <span class="pill">optional</span>' : ''}
        <div class="wf-h">${esc(s.hint)}</div></span>
      </div>`;
    }).join('');

    const current = stages.find((s) => s.active);
    return section('workflow', 'ℹ️ How this works', rows,
      current ? `step ${current.n}` : null);
  }

  /* Undo and redo, named. A button reading "Undo" leaves the operator to find
   * out what it reverses by pressing it; one reading "Undo apply translation to
   * 12 shape(s)" does not. */
  /* Undo | Redo | Remove Last | Reset Everything, at the head of the editing
   * controls (brief §8). All four are always present rather than appearing when
   * they become useful: a control that comes and goes cannot be found reliably,
   * and "where did Undo go?" is a worse problem than a greyed-out button.
   *
   * The labels name what they would reverse — "Undo apply translation to 12
   * shape(s)" rather than a bare "Undo" that leaves the operator to discover
   * its effect by pressing it. */
  function historyBarHtml() {
    const u = history.undoLabel();
    const r = history.redoLabel();
    const any = st.shapes.length > 0;
    return `<div class="bnd15-hist">
      <div class="bnd15-row">
        <button class="bnd15-btn sm gray" id="gUndo" ${u ? '' : 'disabled'} title="Ctrl+Z">↩ Undo${u ? ` ${esc(u)}` : ''}</button>
        <button class="bnd15-btn sm gray" id="gRedo" ${r ? '' : 'disabled'} title="Ctrl+Y">↪ Redo${r ? ` ${esc(r)}` : ''}</button>
      </div>
      <div class="bnd15-row">
        <button class="bnd15-btn sm orange" id="delLast" ${any ? '' : 'disabled'} title="Delete the most recently added shape. Ctrl+Z undoes it.">Remove Last</button>
        <button class="bnd15-btn sm red" id="delAll" title="Wipe the whole session: shapes, control points, georeference points, calibration, backups and undo history. Lists what it will remove first.">Reset Everything</button>
      </div>
    </div>`;
  }

  function crsCardHtml() {
    const d = st.crsDetection;
    if (!d) return `<div class="card"><h4>Coordinate system</h4><div class="dim">Not determined yet.</div></div>`;
    const conf = Math.round((d.confidence || 0) * 100);
    const pillCls = d.needsConfirmation ? (d.crs ? 'warn' : 'bad') : 'ok';
    const pillTxt = d.needsConfirmation ? (d.crs ? 'needs confirming' : 'unknown') : 'confirmed';
    let picker = '';
    if (d.needsConfirmation && d.candidates && d.candidates.length) {
      const opts = d.candidates.map((c) => {
        const sel = st.crs && c.zone === st.crs.zone && c.kind === st.crs.kind ? 'selected' : '';
        return `<option value="${esc(c.epsg || '')}" ${sel}>${esc(c.label)}</option>`;
      }).join('');
      picker = `<div class="field"><span>Set zone</span><select id="crsPick">${opts}</select></div>
        <div class="dim">A wrong zone puts exports hundreds of kilometres away, so this is worth a moment. Use "Check on map" to see where the current guess lands.</div>
        <div class="bnd15-row" style="margin-top:5px"><button class="bnd15-btn sm gray" id="crsCheck">🌍 Check on map</button></div>`;
    }
    return `<div class="card">
      <h4>Coordinate system <span class="pill ${pillCls}">${pillTxt} ${conf}%</span></h4>
      <div class="mono" style="font-size:11px">${esc(Crs.describeCrs(st.crs))}</div>
      <details style="margin-top:4px"><summary class="dim" style="cursor:pointer">How this was determined</summary>
        <ul class="dim" style="margin:4px 0 0;padding-left:16px">${(d.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </details>
      ${picker}
    </div>`;
  }

  function shapeListHtml() {
    if (!st.shapes.length) return '';
    const items = st.shapes.map((s) => {
      const editing = st.editShapeId === s.id;
      const label = s.plotNo ? `Plot ${esc(s.plotNo)}` : `Shape ${s.id}`;
      const bad = s.validity && !s.validity.valid;
      let cmp = '';
      if (s.areaDiffPct != null) {
        const cls = Math.abs(s.areaDiffPct) <= 5 ? 'ok' : (Math.abs(s.areaDiffPct) <= 15 ? 'warn' : 'bad');
        cmp = ` <span class="${cls}">${s.areaDiffPct > 0 ? '+' : ''}${s.areaDiffPct.toFixed(1)}% vs record</span>`;
      }
      const shifted = s.shift && !GeomEdit.isIdentityShift(s.shift)
        ? GeomEdit.describeShift(s.shift, st.backups[s.id] || s.points) : null;
      return `<div class="item ${bad ? 'bad' : ''} ${st.selectedShapeId === s.id ? 'sel' : ''}">
        <span class="grow">${label} · ${s.points.length}v · ${(s.areaM2 || 0).toFixed(0)} ${areaUnit()}${cmp}
          ${s.source === 'imported' ? ` <span class="pill imp" title="Imported from ${esc(s.layer || 'a file')} — edited, cleaned and exported exactly like a traced parcel">${esc(s.layer || 'imported')}</span>` : ''}
          ${s.lastGcpCorrection ? ' <span class="pill ok">GCP</span>' : ''}
          ${shifted ? ` <span class="pill warn" title="${esc(shifted.summary)} — stored separately and resettable">shifted</span>` : ''}
          ${bad ? ` <span class="pill bad" title="${esc(s.validity.problems.map((p) => p.message).join(' '))}">geometry</span>` : ''}
        </span>
        <button data-sel="${s.id}" title="Make this the parcel the Edit tools act on">${st.selectedShapeId === s.id ? '◉' : '○'}</button>
        <button data-edit="${s.id}">${editing ? 'Done' : 'Edit'}</button>
        <button data-reg="${s.id}" title="Regularise just this shape">📐</button>
        ${st.backups[s.id] ? `<button data-revert="${s.id}" title="Restore the geometry from before any correction, shift or clean-up">↺</button>` : ''}
        <button class="del" data-del="${s.id}">✕</button>
      </div>`;
    }).join('');
    const layers = [...new Set(st.shapes.map((s) => s.layer || 'Digitized'))];
    return `<div class="card"><h4>Shapes <span class="pill">${st.shapes.length}</span></h4>
      ${layers.length > 1 ? `<div class="dim" style="font-size:10.5px;margin-bottom:4px">Layers: ${layers.map((l) => esc(l)).join(' · ')}</div>` : ''}
      <div class="list">${items}</div></div>`;
  }

  /* RF and scale-bar calibration (brief §12, §13), plus the drawing-underlay
   * controls of §11. Kept together because they are all properties of the
   * sheet, and rigorously apart from anything to do with screen zoom. */
  function calibrationHtml() {
    const c = st.calibration;
    const picks = st.calibrationPick.length;
    const pickDist = picks === 2
      ? Math.hypot(st.calibrationPick[1][0] - st.calibrationPick[0][0], st.calibrationPick[1][1] - st.calibrationPick[0][1])
      : null;
    const implied = c ? GeomEdit.impliedRf(c, S.scanDpi) : null;

    return `<div class="step" style="margin-top:6px">
      <b>Drawing scale (RF)</b>
      <div class="dim" style="font-size:10.5px;margin-top:2px">
        This is the real-world scale of the drawing — <b>not</b> image resizing, and not screen zoom.
        RF 1:2000 means one unit on the sheet is 2000 units on the ground. Zooming the display never changes it.
      </div>
      <div class="field"><span title="The denominator of the representative fraction printed on the sheet">RF  1 :</span>
        <input type="text" id="rfDen" placeholder="2000" list="bnd15-rf" style="width:70px" value="${c && c.method === 'rf' ? esc(c.rfDenominator) : ''}"></div>
      <div class="field"><span title="An RF relates PAPER distance to ground distance. A pixel is not a paper unit until the scan resolution says how many fit in an inch, so this is asked for rather than assumed.">Scan resolution (dpi)</span>
        <input type="text" id="rfDpi" style="width:70px" value="${esc(S.scanDpi)}"></div>
      <div class="bnd15-row"><button class="bnd15-btn sm green" id="rfApply">Set scale from RF</button></div>
      <div class="dim" style="font-size:10.5px;margin-top:3px">Common: ${GeomEdit.COMMON_RF.map((r) => `1:${r}`).join(' · ')}</div>

      <div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(148,163,184,.25)">
        <b>Or calibrate from a known distance</b>
        <div class="dim" style="font-size:10.5px;margin-top:2px">Needs no DPI, so nothing has to be assumed — the more reliable of the two. Pick the two ends of a scale bar or a boundary whose length you know, then type that length.</div>
        <div class="bnd15-row" style="margin-top:4px">
          <button class="bnd15-btn sm ${st.mode === 'calibrate' ? 'violet on' : 'violet'}" id="calPick">📏 Pick two points ${picks ? `(${picks}/2)` : ''}</button>
        </div>
        ${pickDist != null ? `<div class="mono dim" style="font-size:10.5px;margin-top:3px">${pickDist.toFixed(1)} px between the marks</div>` : ''}
        <div class="field"><span>Known ground distance (m)</span>
          <input type="text" id="calDist" placeholder="50" style="width:70px">
          <button class="bnd15-btn sm green" id="calApply" ${picks === 2 ? '' : 'disabled'}>Set</button></div>
      </div>

      ${c ? `<div class="capture" style="margin-top:6px">
        <b>Calibrated</b> — 1 px = <span class="mono">${c.metresPerPixel.toFixed(5)} m</span> on the ground<br>
        <span class="dim" style="font-size:10.5px">${esc(c.note)}${implied ? ` · implies 1:${implied.toFixed(0)} at ${esc(S.scanDpi)} dpi` : ''}</span>
        <div class="bnd15-row" style="margin-top:4px"><button class="bnd15-btn sm gray" id="calClear">Clear calibration</button></div>
      </div>` : `<div class="dim" style="font-size:10.5px;margin-top:5px">Not calibrated — areas are in px² until an RF or a known distance is given, or the sheet is georeferenced.</div>`}
    </div>`;
  }

  function workspaceCardHtml() {
    if (!isWorkspace()) {
      const pdf = Raster.looksLikePdf(document, window);
      const imgs = Raster.findPageImages(document, window);
      return section('drawing', '🖼 Image / PDF drawing', `
        <div class="dim">Digitize a scanned cadastral sheet, photograph or PDF page with the same tools — tracing, the vertex editor, clean-up, control points and every export. ${pdf ? '<b class="warn">This page looks like a PDF — use Capture view.</b>' : ''}</div>
        <div class="bnd15-row" style="margin-top:6px">
          <button class="bnd15-btn sm blue" id="wsFile">📂 Open file</button>
          <button class="bnd15-btn sm blue" id="wsCapture">📸 Capture view</button>
          ${imgs.length ? `<button class="bnd15-btn sm gray" id="wsPage">🖼 Page image</button>` : ''}
        </div>
        <div class="dim" style="font-size:10.5px;margin-top:4px">Chrome will not let extensions read its PDF viewer's pixels, so PDFs are handled by capturing the rendered view. A capture is screen resolution — zoom in first, and take a large sheet in sections. The digitizer hides itself for the capture and comes back afterwards; the browser does not allow anything beyond that.</div>`);
    }

    const A = st.adapter;
    const g = st.georef;
    const active = st.georefPoints.filter((p) => p.enabled !== false);
    const crsOk = !!st.georefCrs;

    const rows = st.georefPoints.map((p) => {
      const i = active.indexOf(p);
      const res = g && g.residuals && i >= 0 ? g.residuals[i] : null;
      const isOut = g && g.outliers && i >= 0 && g.outliers.includes(i);
      return `<div class="item ${isOut ? 'bad' : ''} ${p.enabled === false ? 'off' : ''}">
        <span class="grow mono" style="font-size:10.5px">#${p.id} px ${p.pixel[0].toFixed(0)},${p.pixel[1].toFixed(0)} → ${p.world[0].toFixed(2)},${p.world[1].toFixed(2)}${res != null ? ` · ${res.toFixed(2)}` : ''}${isOut ? ' ⚠' : ''}</span>
        <button data-greftoggle="${p.id}">${p.enabled === false ? 'off' : 'on'}</button>
        <button class="del" data-grefdel="${p.id}">✕</button></div>`;
    }).join('');

    let fitInfo = '';
    if (g && g.error) fitInfo = `<div class="bad" style="font-size:11px;margin-top:5px">${esc(g.error)}</div>`;
    else if (g && g.fit) {
      fitInfo = `<div class="capture" style="margin-top:5px">
        <b>Georeferenced</b> — ${esc(g.type)} from ${g.count} point(s)<br>
        In-sample RMS <span class="mono">${g.rms.toFixed(3)}</span>
        ${g.looRms != null ? `· predicts an unseen point to <b class="mono">${g.looRms.toFixed(3)}</b>` : '· add a third point for a cross-checked figure'}
        <div class="dim" style="font-size:10.5px;margin-top:3px">Units are whatever the CRS uses. Exports now carry real coordinates.</div>
      </div>`;
    }

    return section('drawing', '🖼 Image / PDF drawing', `
      <div class="dim">${esc(A.sourceName)} · ${A.imageWidth}×${A.imageHeight} px</div>
      <div class="bnd15-row" style="margin-top:6px">
        <button class="bnd15-btn sm gray" id="wsFit">⤢ Fit</button>
        <button class="bnd15-btn sm ${st.mode === 'georef' ? 'violet on' : 'violet'}" id="mGeoref">🌐 Georeference</button>
        <button class="bnd15-btn sm red" id="wsClose">✕ Close</button>
      </div>
      ${calibrationHtml()}
      <div class="field" style="margin-top:6px"><span title="How strongly the underlay is drawn. Lowering it makes traced boundaries easier to see against a dark scan.">Opacity</span>
        <input type="range" id="wsOpacity" min="10" max="100" value="${Math.round((S.drawingOpacity == null ? 1 : S.drawingOpacity) * 100)}"><span class="mono">${Math.round((S.drawingOpacity == null ? 1 : S.drawingOpacity) * 100)}%</span></div>
      <div class="field"><span title="Turn the sheet on screen — for a drawing that was scanned askew. This rotates the underlay only; it does not move any digitized geometry.">Rotation (°)</span>
        <input type="number" id="wsRotate" step="0.5" min="-180" max="180" value="${esc(S.drawingRotationDeg || 0)}"></div>
      <div class="field"><span title="Stop the sheet being panned or zoomed by accident once it is calibrated and georeferenced.">Lock the drawing</span>
        <input type="checkbox" id="wsLock" ${S.drawingLocked ? 'checked' : ''}></div>
      ${st.mode === 'georef' ? `<div class="step" style="margin-top:6px">
        <b>Georeference by known coordinates.</b>
        <div style="margin-top:3px">Tap a point on the image whose real-world coordinate you know — a surveyed corner, a published boundary mark — then type that coordinate. Two points minimum; three or more lets it be cross-checked.</div>
        <div class="field" style="margin-top:5px"><span>Coordinates are in</span>
          <select id="grefCrs">
            <option value="">— choose —</option>
            <option value="4326" ${st.georefCrs && st.georefCrs.kind === 'geographic' ? 'selected' : ''}>Longitude / latitude (WGS 84)</option>
            ${[42, 43, 44, 45, 46, 47].map((z) => `<option value="${32600 + z}" ${st.georefCrs && st.georefCrs.zone === z ? 'selected' : ''}>UTM ${z}N (metres)</option>`).join('')}
          </select></div>
        ${st.georefPick ? `<div class="mono" style="font-size:10.5px;margin-top:4px">picked pixel ${st.georefPick[0].toFixed(1)}, ${st.georefPick[1].toFixed(1)}</div>
          <div class="field"><span>${st.georefCrs && st.georefCrs.kind === 'geographic' ? 'Lon, Lat' : 'Easting, Northing'}</span>
            <input type="text" id="grefWorld" placeholder="${st.georefCrs && st.georefCrs.kind === 'geographic' ? '85.3096, 23.3441' : '432500.25, 2618400.75'}"></div>
          <div class="bnd15-row"><button class="bnd15-btn sm green" id="grefAdd" ${crsOk ? '' : 'disabled'}>Add point</button>
            <button class="bnd15-btn sm gray" id="grefCancel">Cancel</button></div>
          ${crsOk ? '' : '<div class="warn" style="font-size:10.5px">Choose the coordinate system first.</div>'}`
        : `<div class="dim" style="font-size:10.5px;margin-top:4px">Tap the image to pick a point.</div>`}
      </div>` : ''}
      ${st.georefPoints.length ? `<div class="list" style="margin-top:5px">${rows}</div>` : ''}
      ${fitInfo}`,
    g && g.fit ? 'georeferenced' : (st.calibration ? 'scaled' : 'pixels only'));
  }

  /* =====================================================================
   * THE THREE MAIN BUTTONS  (brief §1, §29)
   * ---------------------------------------------------------------------
   * IMPORT ▾ | EXPORT ▾ | SAVE PROJECT, and nothing else at this level.
   * Project import and project export live inside the two menus rather than
   * having permanent buttons of their own; Save Project is separate because it
   * is a different action — a one-press save of the working project, not a
   * choice of output format (§20).
   *
   * BOTH MENUS ARE ALWAYS IN THE DOM and shown or hidden with a class rather
   * than being built when opened. That is deliberate: the browser-integration
   * suite drives these controls by id, and a menu that only exists while open
   * would be unreachable to it — the tests would have to be weakened to match,
   * which §30 forbids.
   * =================================================================== */
  function mainBarHtml() {
    const open = st.openMenu;
    const item = (id, label, hint) =>
      `<button class="bnd15-mi" id="${id}" title="${esc(hint || '')}">${esc(label)}</button>`;
    return `<div class="bnd15-main">
      <div class="bnd15-row">
        <button class="bnd15-btn blue ${open === 'import' ? 'on' : ''}" id="btnImport" aria-expanded="${open === 'import'}">📥 Import ▾</button>
        <button class="bnd15-btn green ${open === 'export' ? 'on' : ''}" id="btnExport" aria-expanded="${open === 'export'}">📤 Export ▾</button>
        <button class="bnd15-btn teal" id="btnSaveProject" title="Save the whole cadastral workspace as ProjectName.json. Saves over the current project once it has a name.">💾 Save Project</button>
      </div>
      <div class="bnd15-menu ${open === 'import' ? 'open' : ''}" id="menuImport">
        <div class="mh">Import</div>
        ${item('xLoad', 'Project JSON', 'Reopen a saved project — parcels, control points, calibration, everything')}
        ${item('iKml', 'KMZ / KML', 'Google Earth parcels; overlaid automatically')}
        ${item('iDxf', 'DXF', 'CAD/survey drawing; layers and absolute coordinates preserved')}
        ${item('iCsv', 'CSV Vertices', 'A point list; you confirm which column is which before anything is read')}
        ${item('iGeo', 'GeoJSON', 'Also written by this tool, so a session round-trips')}
        ${item('gcpImport', 'GCP / control points', 'QGIS .points, or any CSV once you confirm its columns')}
        ${item('iImage', 'Image (scanned sheet)', 'Digitize over a scanned cadastral drawing')}
        ${item('iPdf', 'PDF page (capture)', "Chrome will not let extensions read PDF pixels, so the rendered page is captured")}
      </div>
      <div class="bnd15-menu ${open === 'export' ? 'open' : ''}" id="menuExport">
        <div class="mh">Export</div>
        ${item('xProj', 'Project JSON', 'The complete workspace, reopenable here')}
        ${item('xKmz', 'KMZ', 'For Google Earth')}
        ${item('xKml', 'KML', 'For Google Earth, uncompressed')}
        ${item('xDxf', 'DXF', 'For CAD and survey software')}
        ${item('xCsv', 'CSV Vertices', 'Survey-style point list with projected and lon/lat coordinates')}
        ${item('xGeo', 'GeoJSON', 'RFC 7946')}
        ${item('xShp', 'Shapefile', 'Full .shp/.shx/.dbf/.prj bundle, zipped')}
        ${item('xWkt', 'WKT', 'POLYGON / MULTIPOLYGON')}
        ${item('xArea', 'Area report CSV', 'Digitized against recorded area, per parcel')}
        ${item('gcpExport', 'Control points (.points)', 'QGIS-compatible')}
        <div class="mn">Exports carry the corrected geometry — if a parcel has been shifted or transformed, that is what is written.</div>
      </div>
    </div>`;
  }

  /* =====================================================================
   * EDIT  (brief §10)
   * ---------------------------------------------------------------------
   * Move Vertex, Add Vertex and Delete Vertex are the behaviours that already
   * existed inside Edit mode, given names and buttons instead of being
   * discoverable only by knowing that Alt+tap deletes. Select, Move Geometry,
   * Rotate, Scale, Copy, Duplicate and Delete are new.
   * =================================================================== */
  function editCardHtml() {
    const sel = selectedShape();
    const has = !!sel;
    const shift = sel && sel.shift ? GeomEdit.describeShift(sel.shift, st.backups[sel.id] || sel.points) : null;
    const unit = areaUnit() === 'px²' ? 'px' : 'm';

    const modeBtn = (id, mode, label, hint) =>
      `<button class="bnd15-btn sm ${st.mode === mode ? 'violet on' : 'gray'}" id="${id}" title="${esc(hint)}">${esc(label)}</button>`;

    return section('edit', '✏️ Edit', `
      <div class="bnd15-row">
        ${modeBtn('eSelect', 'select', 'Select', 'Tap a parcel to make it the target of the tools below')}
        ${modeBtn('eMove', 'move', 'Move Geometry', 'Drag the selected parcel bodily. The map does not move; only the parcel does.')}
        ${modeBtn('eVertex', 'edit', 'Move Vertex', 'Drag the white corner handles')}
      </div>
      <div class="bnd15-row">
        <button class="bnd15-btn sm gray" id="eAddVertex" title="Tap an edge in Move Vertex mode to insert a corner there">Add Vertex</button>
        <button class="bnd15-btn sm gray" id="eDelVertex" title="Alt+tap a corner handle in Move Vertex mode to delete it">Delete Vertex</button>
      </div>
      <div class="dim" style="font-size:10.5px">${has
        ? `Selected: <b>${sel.plotNo ? 'Plot ' + esc(sel.plotNo) : 'Shape ' + sel.id}</b> · ${sel.points.length} corners · ${(sel.areaM2 || 0).toFixed(1)} ${areaUnit()} · <span class="pill">${esc(sel.layer || 'Digitized')}</span>`
        : 'Nothing selected. Press <b>Select</b> and tap a parcel, or use the Shapes list.'}</div>

      <div class="field"><span title="Move the selected parcel by an exact amount. Positive X is east, positive Y is north.">Shift X / Y (${unit})</span>
        <input type="text" id="eDx" placeholder="0" style="width:56px">
        <input type="text" id="eDy" placeholder="0" style="width:56px">
        <button class="bnd15-btn sm green" id="eApplyXY" ${has ? '' : 'disabled'}>Apply</button></div>
      <div class="field"><span title="Turn the parcel about its own centre, so it rotates where it stands instead of swinging across the sheet">Rotate (°)</span>
        <input type="text" id="eRot" placeholder="0.0" style="width:56px">
        <button class="bnd15-btn sm green" id="eApplyRot" ${has ? '' : 'disabled'}>Apply</button></div>
      <div class="field"><span title="Resize about the parcel's own centre. 1.01 grows it by 1%.">Scale (×)</span>
        <input type="text" id="eScale" placeholder="1.000" style="width:56px">
        <button class="bnd15-btn sm green" id="eApplyScale" ${has ? '' : 'disabled'}>Apply</button></div>

      <div class="bnd15-row" style="margin-top:5px">
        <button class="bnd15-btn sm gray" id="eCopy" ${has ? '' : 'disabled'} title="Copy the selected parcel's coordinates to the clipboard as WKT">Copy</button>
        <button class="bnd15-btn sm gray" id="eDuplicate" ${has ? '' : 'disabled'} title="Add a second parcel with the same outline, offset so both can be selected">Duplicate</button>
        <button class="bnd15-btn sm red" id="eDelete" ${has ? '' : 'disabled'} title="Delete the selected parcel. Ctrl+Z undoes it.">Delete</button>
      </div>

      ${has && shift && !shift.identity ? `<div class="capture" style="margin-top:6px">
        <b>Shift on this parcel</b> — ${esc(shift.summary)}
        <div class="dim" style="font-size:10.5px;margin-top:3px">Stored separately from the geometry, so it can be read, undone and reset. Exports carry the corrected position.</div>
        <div class="bnd15-row" style="margin-top:4px">
          <button class="bnd15-btn sm gray" id="eResetShift">↺ Reset this shift</button>
          <button class="bnd15-btn sm gray" id="eToggleOrig">${st.showOriginals ? 'Hide' : 'Show'} original outline</button>
        </div>
      </div>` : ''}
    `);
  }

  /* A collapsible panel section (brief §7). <details> keeps its contents in the
   * DOM when closed, which is what lets the map be uncluttered without putting
   * the controls out of reach of anything — operator or test — that looks for
   * them by id. */
  function section(key, title, inner, badge) {
    return `<details class="card sect" data-sect="${key}" ${sectionOpen(key) ? 'open' : ''}>
      <summary><span>${title}</span>${badge ? ` <span class="pill">${esc(badge)}</span>` : ''}</summary>
      <div class="sect-b">${inner}</div>
    </details>`;
  }

  function importSummaryHtml() {
    const s = st.importSummary;
    if (!s) return '';
    return `<div class="capture" style="margin-top:6px">
      <b>Imported</b> — ${s.added} parcel(s) from ${esc(s.what)}${s.name ? ` (${esc(s.name)})` : ''}
      <div class="dim" style="font-size:10.5px;margin-top:3px">
        Layers: ${esc(s.layers.join(', ') || 'none')} · ${s.withPlotNo} with a plot number · ${esc(s.crsLabel)}${s.adoptedCrs ? ' <b class="warn">(taken from the file — check it)</b>' : ''}
      </div>
      ${s.skipped.length ? `<details style="margin-top:4px"><summary class="dim" style="cursor:pointer">${s.skipped.length} item(s) skipped</summary>
        <ul class="dim" style="margin:4px 0 0;padding-left:16px;font-size:10.5px">${s.skipped.map((k) => `<li>${esc(k.what)} — ${esc(k.why)}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }

  /* The CSV format dialog the brief asks for in §6 and §17: show what is in the
   * file, let the operator say which column is which, and import nothing until
   * they confirm. */
  function csvDialogHtml() {
    const d = st.csvDialog;
    if (!d) return '';
    const p = d.preview;
    const colOpts = (selected, allowNone) =>
      `${allowNone ? `<option value="">— none —</option>` : ''}` +
      p.columns.map((c) => `<option value="${c.index}" ${String(selected) === String(c.index) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

    const head = p.header.map((h) => `<th>${esc(h)}</th>`).join('');
    const body = p.sample.map((r) => `<tr>${p.header.map((_, i) => `<td>${esc(r[i] == null ? '' : r[i])}</td>`).join('')}</tr>`).join('');

    return `<div class="card" id="csvDialog">
      <h4>${d.purpose === 'gcps' ? 'Control point' : 'CSV vertex'} import — confirm the format</h4>
      <div class="dim">${esc(d.fileName)} · ${p.rowCount} row(s). Nothing is imported until you press Import.</div>

      <div class="field"><span>Preset</span>
        <select id="csvFormat">${Imp.CSV_FORMATS.map((f) => `<option value="${f.key}" ${d.formatKey === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
      <div class="field"><span>Delimiter</span>
        <select id="csvDelim">${Imp.DELIMITERS.map((x) => `<option value="${esc(x.value)}" ${p.delimiter === x.value ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div>
      <div class="field"><span>First row is a header</span><input type="checkbox" id="csvHeader" ${p.hasHeader ? 'checked' : ''}></div>

      <div class="csvprev"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>

      <div class="field"><span>Point ID</span><select id="csvId">${colOpts(d.mapping.id, true)}</select></div>
      <div class="field"><span>X / Easting / Longitude</span><select id="csvX">${colOpts(d.mapping.x, false)}</select></div>
      <div class="field"><span>Y / Northing / Latitude</span><select id="csvY">${colOpts(d.mapping.y, false)}</select></div>
      <div class="field"><span>Elevation</span><select id="csvZ">${colOpts(d.mapping.z, true)}</select></div>
      <div class="field"><span title="Tick when the two columns above hold degrees rather than metres. This decides whether the numbers are read as lon/lat or as a projected grid.">Those are longitude / latitude</span>
        <input type="checkbox" id="csvLonLat" ${d.mapping.isLonLat ? 'checked' : ''}></div>
      ${d.purpose === 'gcps' ? `
        <div class="dim" style="font-size:10.5px;margin-top:4px">A control point is a <b>pair</b>: where the geometry currently says a corner is, and where it truly is. The two columns above are the true position. If the file also holds the current position, name those columns here.</div>
        <div class="field"><span>Current X (optional)</span><select id="csvSrcX">${colOpts(d.sourceX, true)}</select></div>
        <div class="field"><span>Current Y (optional)</span><select id="csvSrcY">${colOpts(d.sourceY, true)}</select></div>`
      : `<div class="field"><span title="Rows sharing a value here become one parcel. Leave as the ID column when each parcel is listed under its own number.">Group rows into parcels by</span>
          <select id="csvGroup">${colOpts(d.groupBy, true)}</select></div>`}

      <div class="field"><span>Coordinate system</span>
        <select id="csvCrs">
          <option value="">— use this session's (${esc(Crs.describeCrs(isWorkspace() ? (st.georef && st.georef.crs) : st.crs) || 'not set')}) —</option>
          <option value="4326">Longitude / latitude (WGS 84)</option>
          ${[42, 43, 44, 45, 46, 47].map((z) => `<option value="${32600 + z}">UTM ${z}N (metres)</option>`).join('')}
        </select></div>

      <div class="bnd15-row" style="margin-top:6px">
        <button class="bnd15-btn sm green" id="csvImport">Import</button>
        <button class="bnd15-btn sm gray" id="csvCancel">Cancel</button>
      </div>
    </div>`;
  }

  function cleanupCardHtml() {
    if (!st.shapes.length) return '';
    const topo = currentTopology();
    let topoHtml = '';
    if (topo) {
      const cls = topo.clean ? 'ok' : (topo.overlaps.length ? 'bad' : 'warn');
      topoHtml = `<div class="dim" style="margin-top:4px"><span class="pill ${cls}">${topo.clean ? 'topology clean' : 'topology issues'}</span> ${esc(topo.summary)}</div>`;
      if (topo.overlaps.length) {
        topoHtml += `<div class="list" style="margin-top:5px">${topo.overlaps.map((o) => {
          const a = o.estimatedAreaM2;
          return `<div class="item bad"><span class="grow">Shapes ${o.aId} and ${o.bId} overlap${a != null ? ` by roughly <span class="mono">${a.toFixed(1)} m²</span>` : ''}</span></div>`;
        }).join('')}</div>
        <div class="dim" style="font-size:10.5px;margin-top:3px">Overlap areas are grid estimates, not exact clipping — enough to spot the problem, not to quote.</div>`;
      }
    }
    return section('cleanup', '🧹 Clean-up', `
      <div class="dim">A raster trace is a pixel staircase, and parcels traced separately do not share edges. Both make output that a GIS will reject or repair. These work on imported geometry exactly as they do on traced geometry, and every one of them is undoable.</div>
      <div class="bnd15-row" style="margin-top:6px">
        <button class="bnd15-btn sm violet" id="regAll" title="Straighten near-straight edges onto the parcel's own grid and drop redundant vertices">📐 Regularise all</button>
        <button class="bnd15-btn sm teal" id="snapAll" title="Move vertices that are nearly on a neighbour's edge onto it exactly">🧲 Snap shared edges</button>
        <button class="bnd15-btn sm gray" id="qual">📋 Quality report</button>
      </div>
      ${topoHtml}`, topo && !topo.clean ? 'issues' : null);
  }

  function qualityCardHtml() {
    const q = st.quality;
    if (!q) return '';
    const gradeCls = q.averageScore >= 75 ? 'ok' : q.averageScore >= 55 ? 'warn' : 'bad';
    const rows = q.shapes.map((s) => {
      const cls = s.score >= 75 ? 'ok' : s.score >= 55 ? 'warn' : 'bad';
      const detail = s.findings
        .filter((f) => f.severity === 'error' || f.severity === 'warn')
        .map((f) => `• ${f.message} (−${f.points})`).join('\n') || 'No problems found.';
      return `<div class="item"><span class="grow" title="${esc(detail)}">
        ${s.plotNo ? 'Plot ' + esc(s.plotNo) : 'Shape ' + s.id} —
        <span class="pill ${cls}">${s.score.toFixed(0)} ${esc(s.grade)}</span></span></div>`;
    }).join('');
    const worstFindings = q.worst ? q.worst.findings.filter((f) => f.points > 0) : [];
    return `<div class="card">
      <h4>Quality <span class="pill ${gradeCls}">${q.averageScore.toFixed(0)}/100 ${esc(q.grade)}</span></h4>
      <div class="dim">${q.errorCount} error(s), ${q.warningCount} warning(s) across ${q.shapes.length} shape(s). Hover a row for detail.</div>
      <div class="list" style="margin-top:5px">${rows}</div>
      ${q.worst && worstFindings.length ? `<details style="margin-top:5px"><summary class="dim" style="cursor:pointer">Worst shape (${q.worst.plotNo ? 'Plot ' + esc(q.worst.plotNo) : 'Shape ' + q.worst.id}) — why it scored ${q.worst.score.toFixed(0)}</summary>
        <ul style="margin:4px 0 0;padding-left:16px;font-size:11px">${worstFindings.map((f) => `<li class="${f.severity === 'error' ? 'bad' : 'warn'}">${esc(f.message)} <span class="dim">(−${f.points})</span></li>`).join('')}</ul>
        <div class="dim" style="margin-top:4px;font-size:10.5px">Every deduction is itemised so the grade can be argued with rather than believed. The score is 100 minus these.</div>
      </details>` : ''}
    </div>`;
  }

  function gcpCardHtml() {
    const fit = st.gcpFit;
    const rec = st.gcpRecommendation;
    const en = enabledGcps();
    const outliers = new Set((fit && fit.outliers) || []);

    const items = st.gcps.map((g) => {
      const shift = Math.hypot(g.target[0] - g.source[0], g.target[1] - g.source[1]);
      const i = en.indexOf(g);
      const isOut = i >= 0 && outliers.has(i);
      const res = fit && fit.residuals && i >= 0 ? fit.residuals[i] : null;
      return `<div class="item ${isOut ? 'bad' : ''} ${g.enabled === false ? 'off' : ''}">
        <span class="grow">#${g.id} ${g.vertexIndex != null ? `v${g.vertexIndex}` : 'loose'} · moved ${shift.toFixed(2)} m${res != null ? ` · resid ${res.toFixed(3)} m` : ''}${isOut ? ' <span class="pill bad">outlier</span>' : ''}</span>
        <button data-gzoom="${g.id}" title="Zoom in on this control point">🔍</button>
        <button data-gtoggle="${g.id}" title="Include or exclude this point">${g.enabled === false ? 'off' : 'on'}</button>
        <button class="del" data-gdel="${g.id}">✕</button>
      </div>`;
    }).join('');

    let fitHtml = '';
    if (fit && fit.ok) {
      const f = fit.fit;
      let params;
      if (f.type === 'translation') params = `shift ${f.dx.toFixed(2)} m east, ${f.dy.toFixed(2)} m north — no scale or rotation change`;
      else if (f.type === 'similarity') params = `scale ${f.scale.toFixed(6)}, rotation ${(f.rotationRad * 180 / Math.PI).toFixed(4)}°`;
      else if (f.type === 'affine') params = `scaleX ${f.scaleX.toFixed(6)}, scaleY ${f.scaleY.toFixed(6)}, shear ${f.shear.toFixed(6)}`;
      else if (f.type === 'projective') params = 'homography (8 parameters)';
      else params = `spline through ${f.controlCount} points`;

      const rmsNote = fit.exactlyDetermined
        ? `<div class="warn" style="font-size:10.5px">⚠️ With ${en.length} points this ${f.type} fit is exactly determined — the residual is zero by construction and proves nothing. Add another point for a real cross-check.</div>`
        : '';

      // How much this fit would DEFORM the parcels, quoted at the distance the
      // geometry actually reaches. A fit can sit perfectly on the tagged corners
      // and still stretch everything else, which is what "it moved somewhere
      // else" looked like from the operator's side.
      const radius = Math.max(20, spanOf(st.shapes.length ? st.shapes : [{ points: en.map((g) => g.source) }]));
      const mag = GcpMath.describeFitMagnitude(f, radius);
      const distortNote = mag.distortionAtRadius > 0.001
        ? `<div class="warn" style="font-size:10.5px;margin-top:3px">⚠️ Not just a shift: a corner ${radius.toFixed(0)} m from the centre is moved an extra <b class="mono">${mag.distortionAtRadius.toFixed(2)} m</b>, so outlines will be resized or rotated. Switch to <b>translation</b> below to move without reshaping.</div>`
        : `<div class="dim" style="font-size:10.5px;margin-top:3px">Shape-safe: every corner moves by the same <b class="mono">${mag.shiftMetres != null ? mag.shiftMetres.toFixed(2) + ' m' : 'amount'}</b>, so areas and angles are preserved exactly.</div>`;
      const looNote = fit.looRms != null
        ? `<div class="dim">Predicts an unseen corner to <b class="mono">${fit.looRms.toFixed(3)} m</b> (leave-one-out — the honest accuracy figure).</div>`
        : `<div class="dim">Add one more point to get a cross-validated accuracy figure.</div>`;

      fitHtml = `<div style="margin-top:6px;padding:6px;border-radius:7px;background:rgba(16,185,129,.14)">
        <div><b>${esc(f.type)}</b> · ${esc(params)}</div>
        <div>In-sample RMS <span class="mono">${fit.rms.toFixed(3)} m</span> over ${en.length} point(s)</div>
        ${looNote}${rmsNote}
        ${fit.warning ? `<div class="warn" style="font-size:10.5px;margin-top:3px">⚠️ ${esc(fit.warning)}</div>` : ''}
        ${fit.robust && fit.outliers && fit.outliers.length ? `<div class="bad" style="font-size:10.5px;margin-top:3px">${fit.outliers.length} point(s) look inconsistent and were down-weighted (${esc(fit.robust.method)}).</div>` : ''}
        ${distortNote}
        <div class="dim" style="font-size:10.5px;margin-top:6px">Both buttons move geometry using the fit above and ask for confirmation first, stating the exact distances. Ctrl+Z undoes either.</div>
        <div class="bnd15-row" style="margin-top:4px">
          <button class="bnd15-btn sm green" id="applyOne" title="Move only the shapes that have a control point on them">Move ${taggedShapeCount()} tagged shape(s)</button>
          <button class="bnd15-btn sm teal" id="applyAll" title="Move every shape in the session, including ones with no control point of their own">Move all ${st.shapes.length} shape(s)</button>
        </div>
      </div>`;
    } else if (fit && !fit.ok) {
      fitHtml = `<div class="bad" style="font-size:11px;margin-top:5px">${esc(fit.error)}</div>`;
    }

    let recHtml = '';
    if (rec) {
      const rows = rec.table.map((t) => {
        const on = t.type === S.transformType;
        return `<div class="item ${on ? '' : 'off'}"><span class="grow">${esc(t.label)} ${t.looRms != null ? `<span class="mono">${t.looRms.toFixed(3)} m</span>` : `<span class="dim">needs ${t.minPoints + 1}+ pts</span>`}</span>
          <button data-usetype="${t.type}" ${t.feasible ? '' : 'disabled'}>${on ? 'in use' : 'use'}</button></div>`;
      }).join('');
      recHtml = `<details style="margin-top:6px"><summary class="dim" style="cursor:pointer">Model comparison — ${esc(rec.reason)}</summary>
        <div class="list" style="margin-top:5px">${rows}</div>
        <div class="dim" style="margin-top:4px">Ranked by how well each predicts a control point it was not given. The simplest model within a hair of the best wins, because a more flexible transform distorts more for no real gain.</div>
      </details>`;
    }

    // ---- step indicator + explicit vertex picker ----
    let stepHtml = '';
    if (st.mode === 'gcp') {
      if (st.gcpStage === 'placeTarget' && st.gcpSelection) {
        const shape = findShape(st.gcpSelection.shapeId);
        const src = shape && shape.points[st.gcpSelection.vertexIndex];
        stepHtml = `<div class="step">
          <b>Step 2 of 2 — capture the true position.</b><br>
          Selected: vertex <b>${st.gcpSelection.vertexIndex}</b> of ${shape && shape.plotNo ? 'plot ' + esc(shape.plotNo) : 'shape ' + st.gcpSelection.shapeId}
          ${src ? `<div class="mono dim" style="font-size:10.5px">currently at ${src[0].toFixed(3)}, ${src[1].toFixed(3)}</div>` : ''}
          <div style="margin-top:3px">Tap where that corner really is. The coordinate is captured automatically.</div>
          <div class="bnd15-row" style="margin-top:5px">
            <button class="bnd15-btn sm gray" id="gcpCancelSel">✕ Cancel</button>
            <button class="bnd15-btn sm gray" id="gcpZoomSel">🔍 Zoom to it first</button>
          </div></div>`;
      } else {
        const opts = st.shapes.map((s) => {
          const tagged = new Set(st.gcps.filter((g) => g.shapeId === s.id).map((g) => g.vertexIndex));
          const verts = s.points.map((p, i) =>
            `<option value="${s.id}:${i}">v${i}${tagged.has(i) ? ' ✓' : ''} — ${p[0].toFixed(1)}, ${p[1].toFixed(1)}</option>`).join('');
          return `<optgroup label="${s.plotNo ? 'Plot ' + esc(s.plotNo) : 'Shape ' + s.id}">${verts}</optgroup>`;
        }).join('');
        stepHtml = `<div class="step">
          <b>Step 1 of 2 — choose which vertex.</b>
          <div style="margin-top:3px">Tap a corner on the map, or pick it here when the boundary is too dense to click accurately. Alt+tap places a loose point instead.</div>
          ${st.shapes.length ? `<div class="field" style="margin-top:5px"><span>Vertex</span>
            <select id="vertexPick"><option value="">— select —</option>${opts}</select></div>` : ''}
        </div>`;
      }
    }

    // ---- readout of the last captured pair ----
    let captureHtml = '';
    if (st.lastCapture) {
      const c = st.lastCapture;
      captureHtml = `<div class="capture">
        <b>Captured</b> — control point ${c.gcpId}, vertex ${c.vertexIndex} of shape ${c.shapeId}
        <table class="coord"><tbody>
          <tr><td class="dim">stored</td><td class="mono">${c.source[0].toFixed(3)}, ${c.source[1].toFixed(3)}</td></tr>
          <tr><td class="dim">true</td><td class="mono">${c.target[0].toFixed(3)}, ${c.target[1].toFixed(3)}</td></tr>
          ${c.lonLat ? `<tr><td class="dim">lon/lat</td><td class="mono">${c.lonLat[0].toFixed(7)}, ${c.lonLat[1].toFixed(7)}</td></tr>` : ''}
          <tr><td class="dim">shift</td><td class="mono">${c.shift.toFixed(3)} m</td></tr>
        </tbody></table></div>`;
    }

    // ---- per-shape coverage ----
    let coverHtml = '';
    if (en.length) {
      const cov = GcpMath.assessCoverage(st.shapes, st.gcps);
      const rows = cov.perShape.filter((p) => p.count > 0).map((p) => {
        const q = p.spread;
        const cls = !q ? 'warn' : (q.quality === 'good' ? 'ok' : (q.quality === 'minimal' ? 'warn' : 'bad'));
        return `<div class="item"><span class="grow" title="${q ? esc(q.message) : ''}">
          ${p.plotNo ? 'Plot ' + esc(p.plotNo) : 'Shape ' + p.shapeId}: ${p.count} pt(s) on v${p.taggedVertices.join(', v')}
          <span class="pill ${cls}">${q ? esc(q.quality) : 'n/a'}</span></span></div>`;
      }).join('');
      coverHtml = `<details style="margin-top:6px"><summary class="dim" style="cursor:pointer">Coverage — ${esc(cov.summary)}</summary>
        <div class="list" style="margin-top:5px">${rows || '<div class="item dim">No shape-anchored points.</div>'}</div>
        <div class="dim" style="font-size:10.5px;margin-top:4px">Spread matters more than count: points clustered along one edge can show an excellent residual while being unconstrained across it. Hover a row for detail.</div>
      </details>`;
    }

    return section('gcp', '📍 Ground control points', `
      ${stepHtml}${captureHtml}
      <div class="field"><span title="Show a dashed outline of where the correction will put the boundary">Preview correction</span><input type="checkbox" id="showPrev" ${st.showPreview ? 'checked' : ''}></div>
      <div class="field"><span>Transform</span>
        <select id="ttype">
          ${Object.keys(GcpMath.MODELS).map((k) => `<option value="${k}" ${S.transformType === k ? 'selected' : ''}>${esc(GcpMath.MODELS[k].label)} (min ${GcpMath.MODELS[k].minPoints})</option>`).join('')}
        </select></div>
      <div class="field"><span title="Down-weight points that disagree with the rest">Robust fitting</span><input type="checkbox" id="robust" ${S.robustFitting ? 'checked' : ''}></div>
      <div class="field"><span title="Pick the transform by cross-validation">Auto-pick transform</span><input type="checkbox" id="autorec" ${S.autoRecommend ? 'checked' : ''}></div>
      ${st.gcps.length ? `<div class="list" style="margin-top:5px">${items}</div>` : '<div class="dim" style="margin-top:5px">No control points yet.</div>'}
      <div class="bnd15-row" style="margin-top:6px">
        <button class="bnd15-btn sm gray" id="gcpClear">Clear points</button>
        <button class="bnd15-btn sm gray" id="gcpLoad" title="Load control points from a QGIS .points file or any CSV — you confirm the columns first">Load GCP</button>
      </div>
      ${coverHtml}${fitHtml}${recHtml}`,
    `${en.length} active`);
  }

  function buildWidget() {
    installStyle();
    const old = document.getElementById(WIDGET_ID);
    if (old) old.remove();
    const w = document.createElement('div');
    w.id = WIDGET_ID;
    w.innerHTML = `
      <div class="bnd15-head"><span>🧭 Cadastral Digitizer <span class="ver">v${VERSION}</span></span>
        <span><button id="min" title="Minimise">▁</button><button id="close" title="Close">✕</button></span></div>
      <div class="body" id="body"></div>
      <div class="credit">Developed by <b>Md Salim Ansari</b> · MIT licence</div>`;
    document.body.appendChild(w);

    // Dragging the title bar moves the widget.
    const head = w.querySelector('.bnd15-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = w.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      w.style.left = (e.clientX - drag.dx) + 'px';
      w.style.top = (e.clientY - drag.dy) + 'px';
      w.style.right = 'auto'; w.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });

    w.querySelector('#min').onclick = () => w.classList.toggle('min');
    w.querySelector('#close').onclick = closeWidget;

    renderWidget();
    return w;
  }

  let advOpen = false;

  function renderWidget() {
    const w = document.getElementById(WIDGET_ID);
    if (!w) return;
    const body = w.querySelector('#body');
    const A = st.adapter;

    body.innerHTML = `
      <div class="status">${esc(statusLine())}</div>
      ${mainBarHtml()}
      ${importSummaryHtml()}
      ${csvDialogHtml()}
      ${historyBarHtml()}
      ${workflowHtml()}
      ${st.plotNo ? `<div class="card"><h4>Selected parcel</h4><div>Plot <b>${esc(st.plotNo)}</b>${st.plotArea ? ` · recorded ${esc(st.plotArea)}` : ''}</div></div>` : ''}
      ${workspaceCardHtml()}
      ${isWorkspace() ? '' : crsCardHtml()}
      <div class="bnd15-row">
        <button class="bnd15-btn blue ${st.mode === 'trace' ? 'on' : ''}" id="mTrace" ${A ? '' : 'disabled'}>⚡ Trace</button>
        <button class="bnd15-btn cyan ${st.mode === 'draw' ? 'on' : ''}" id="mDraw" ${A ? '' : 'disabled'}>✏️ Draw</button>
        <button class="bnd15-btn violet ${st.mode === 'gcp' ? 'on' : ''}" id="mGcp" ${A ? '' : 'disabled'}>📍 Control pts</button>
      </div>
      <div class="bnd15-row">
        <button class="bnd15-btn orange" id="mAuto" ${A ? '' : 'disabled'} title="Trace every fully-visible enclosed parcel in the current view at once">⚡⚡ Auto-trace whole view</button>
        <button class="bnd15-btn sm gray" id="zoomIn" ${A ? '' : 'disabled'} title="Zoom in on the map centre for precision. Nothing zooms automatically.">🔍 Zoom in</button>
      </div>
      <div class="bnd15-row">
        <button class="bnd15-btn sm gray ${st.traceSubmode === 'fill' ? 'on' : ''}" id="sFill">Fill colour</button>
        <button class="bnd15-btn sm gray ${st.traceSubmode === 'border' ? 'on' : ''}" id="sBorder">Border lines</button>
        <button class="bnd15-btn sm gray" id="pick">🎨 Pick</button>
      </div>
      ${st.mode === 'draw' ? `<div class="bnd15-row">
        <button class="bnd15-btn sm gray" id="dUndo">↩ Undo</button>
        <button class="bnd15-btn sm gray" id="dRedo">↪ Redo</button>
        <button class="bnd15-btn sm green" id="dFinish">✅ Finish</button>
        <button class="bnd15-btn sm red" id="dCancel">Cancel</button></div>` : ''}
      ${shapeListHtml()}
      ${editCardHtml()}
      ${cleanupCardHtml()}
      ${qualityCardHtml()}
      ${gcpCardHtml()}
      <div class="adv">
        <div class="adv-t" id="advT"><span>⚙️ Settings</span><span>${advOpen ? '▾' : '▸'}</span></div>
        <div class="adv-b ${advOpen ? 'open' : ''}" id="advB">
          <div class="dim" style="font-size:10.5px;margin-bottom:5px">Only the four settings below usually need touching. Everything else has a sensible default and is tucked away.</div>
          <div class="field"><span title="How close a colour must be to the seed pixel to count as the same parcel">Colour tolerance</span><input type="range" id="sTol" min="5" max="120" value="${S.colorTolerance}"><span class="mono">${S.colorTolerance}</span></div>
          <div class="field"><span title="How aggressively the traced outline is smoothed">Simplify (px)</span><input type="number" id="sSimp" step="0.5" min="0.5" max="10" value="${S.simplifyPx}"></div>
          <div class="field"><span title="How far a vertex can be from a neighbour's boundary and still snap onto it">Snap tolerance (m)</span><input type="number" id="sSnapTol" step="0.05" min="0.01" value="${S.snapToleranceM}"></div>
          <div class="field"><span title="How much the Zoom in button magnifies">Manual zoom steps</span><input type="number" id="sZoomBoost" min="1" max="10" value="${S.manualZoomBoost}"></div>

          <details style="margin-top:7px"><summary class="dim" style="cursor:pointer;font-weight:700">Tracing</summary>
            <div class="field"><span title="Border-lines mode treats anything darker than this as a wall">Wall threshold</span><input type="range" id="sWall" min="20" max="200" value="${S.wallLuminanceThreshold}"><span class="mono">${S.wallLuminanceThreshold}</span></div>
            <div class="field"><span title="Erode-then-regrow radius that stops a fill escaping through a narrow gap">Leak protection (px)</span><input type="range" id="sLeak" min="0" max="5" value="${S.leakProtectionRadius}"><span class="mono">${S.leakProtectionRadius}</span></div>
            <div class="field"><span>Edge growth (px)</span><input type="range" id="sGrow" min="0" max="5" value="${S.edgeGrowthRadius}"><span class="mono">${S.edgeGrowthRadius}</span></div>
            <div class="field"><span title="Leave at 0 so tracing never moves your view. Use the Zoom in button instead.">Auto-zoom before trace</span><input type="number" id="sBoost" min="0" max="10" value="${S.precisionZoomBoost}"></div>
            <div class="field"><span title="Warn when this much of a trace falls outside the bounding box the portal reported for the selected parcel — the sign that a fill escaped into a neighbour. Set 0 to disable.">Leak warning (% outside)</span><input type="number" id="sLeakPct" min="0" max="100" step="1" value="${S.bboxLeakWarnPct}"></div>
            <div class="field"><span>Imagery wait (ms)</span><input type="number" id="sWait" min="200" max="10000" step="100" value="${S.imageryWaitMs}"></div>
            <div class="field"><span>Batch: min parcel size (px)</span><input type="number" id="sBatchMin" min="50" step="50" value="${S.batchMinPixels}"></div>
            <div class="field"><span>Batch: max parcels</span><input type="number" id="sBatchMax" min="1" max="1000" value="${S.batchMaxRegions}"></div>
          </details>

          <details style="margin-top:5px"><summary class="dim" style="cursor:pointer;font-weight:700">Clean-up</summary>
            <div class="field"><span title="Snap new vertices onto existing boundaries as you draw">Snap while drawing</span><input type="checkbox" id="sSnap" ${S.snapEnabled ? 'checked' : ''}></div>
            <div class="field"><span title="How far off a grid direction an edge can be and still be straightened onto it">Regularise angle (°)</span><input type="number" id="sRegAng" min="1" max="30" value="${S.regulariseAngleDeg}"></div>
            <div class="field"><span title="Vertices offset less than this from the line between their neighbours are dropped">Collinear tolerance (m)</span><input type="number" id="sRegCol" step="0.05" min="0.01" value="${S.regulariseCollinearM}"></div>
            <div class="field"><span title="Refuse to regularise if it would move a vertex further than this">Max vertex shift (m)</span><input type="number" id="sRegMax" step="0.1" min="0.1" value="${S.regulariseMaxShiftM}"></div>
            <div class="field"><span>Regularise on auto-trace</span><input type="checkbox" id="sAutoReg" ${S.autoRegulariseOnTrace ? 'checked' : ''}></div>
            <div class="field"><span title="A corner shared with neighbouring parcels moves them with it, so a shared boundary stays common instead of tearing into a crossing. Turn off only if you deliberately want to move one parcel away from its neighbour.">Shared corners move neighbours</span><input type="checkbox" id="sShared" ${S.dragSharedCorners ? 'checked' : ''}></div>
            <div class="field"><span title="Warn when an operation makes two boundaries overlap that did not overlap before. Only new overlaps are reported, not ones already in the session.">Warn on new overlaps</span><input type="checkbox" id="sWarnCross" ${S.warnNewCrossings ? 'checked' : ''}></div>
          </details>

          <details style="margin-top:5px"><summary class="dim" style="cursor:pointer;font-weight:700">Control points</summary>
            <div class="field"><span>Handle grab radius (px)</span><input type="number" id="sGrab" min="6" max="40" value="${S.gcpGrabPx}"></div>
            <div class="field"><span>Live re-fit while dragging</span><input type="checkbox" id="sLive" ${S.liveRefit ? 'checked' : ''}></div>
            <div class="field"><span title="Dragging a corner in Edit mode records a control point from where it was to where you put it. Turn off to use only the explicit two-step pairing.">Editing a corner makes a control point</span><input type="checkbox" id="sAutoGcp" ${S.autoGcpFromEdit ? 'checked' : ''}></div>
            <div class="field"><span title="Cross-validate every model and adopt the simplest one that predicts an unseen corner as well as any other. Turn off to choose the model yourself.">Auto-pick the transform model</span><input type="checkbox" id="sAutoRec2" ${S.autoRecommend ? 'checked' : ''}></div>
            <div class="field"><span title="Down-weight control points that disagree with the rest. Needs at least the model's minimum plus two points before it will name any point an outlier.">Robust outlier rejection</span><input type="checkbox" id="sRobust2" ${S.robustFitting ? 'checked' : ''}></div>
          </details>

          <details style="margin-top:5px"><summary class="dim" style="cursor:pointer;font-weight:700">Export &amp; page behaviour</summary>
            <div class="field"><span>DXF georeferencing</span><select id="sGeoref">
              <option value="shift" ${S.dxfGeorefMode === 'shift' ? 'selected' : ''}>Shifted (origin recorded)</option>
              <option value="absolute" ${S.dxfGeorefMode === 'absolute' ? 'selected' : ''}>Absolute CRS coords</option>
              <option value="local" ${S.dxfGeorefMode === 'local' ? 'selected' : ''}>Local (no georeferencing)</option>
            </select></div>
            <div class="field"><span>Scale factor</span><input type="number" id="sScale" step="0.001" min="0.001" value="${S.scaleFactor}"></div>
            <div class="field"><span title="v13/v14 applied it to DXF only, so the three exports disagreed">Scale factor on all exports</span><input type="checkbox" id="sScaleAll" ${S.applyScaleToAllExports ? 'checked' : ''}></div>
            <div class="field"><span title="Stops a tap meant for this tool from also reaching the portal underneath and re-selecting a parcel">Block clicks reaching the site</span><input type="checkbox" id="sBlockClicks" ${S.blockSiteClicks ? 'checked' : ''}></div>
          </details>

          <div class="bnd15-row" style="margin-top:7px"><button class="bnd15-btn sm gray" id="sReset">Reset settings</button></div>
        </div>
      </div>`;

    wire(body);
    draw();
  }

  function wire(body) {
    const q = (id) => body.querySelector('#' + id);
    const on = (id, ev, fn) => { const el = q(id); if (el) el[ev] = fn; };

    function setMode(m) {
      st.mode = st.mode === m ? 'idle' : m;
      if (st.mode !== 'draw') { st.drawPoints = []; st.drawUndo = []; st.drawRedo = []; }
      if (st.mode !== 'edit') st.editShapeId = null;
      if (st.mode !== 'gcp') { st.gcpSelection = null; st.gcpStage = 'pickVertex'; }
      if (st.mode !== 'calibrate') st.calibrationPick = [];
      // Leaving Select and Move keeps the selection: the Edit card's numeric
      // controls act on it, and losing it every time a mode is turned off would
      // make "select, then type a shift" impossible.
      renderWidget();
    }
    on('mAuto', 'onclick', autoTraceVisible);
    on('wsFile', 'onclick', () => openWorkspace('file'));
    on('wsCapture', 'onclick', () => openWorkspace('capture'));
    on('wsPage', 'onclick', () => openWorkspace('page'));
    on('wsClose', 'onclick', closeWorkspace);
    on('wsFit', 'onclick', () => { if (st.adapter.fitToView) st.adapter.fitToView(); draw(); });
    on('mGeoref', 'onclick', () => {
      st.mode = st.mode === 'georef' ? 'idle' : 'georef';
      st.georefPick = null;
      renderWidget();
    });
    on('grefCrs', 'onchange', (e) => {
      st.georefCrs = e.target.value ? Crs.parseEpsg(e.target.value) : null;
      recomputeGeoref(); renderWidget();
    });
    on('grefCancel', 'onclick', () => { st.georefPick = null; renderWidget(); draw(); });
    on('grefAdd', 'onclick', () => {
      const el = body.querySelector('#grefWorld');
      const parts = String(el ? el.value : '').split(/[,\s]+/).filter(Boolean).map(Number);
      if (parts.length < 2) return toastErr('Type two numbers, separated by a comma.');
      addGeorefPoint(parts[0], parts[1]);
    });
    body.querySelectorAll('[data-greftoggle]').forEach((b) => b.onclick = () => {
      const p = st.georefPoints.find((x) => x.id === +b.dataset.greftoggle);
      if (p) {
        commit(`${p.enabled === false ? 'include' : 'exclude'} georeference point ${p.id}`);
        p.enabled = p.enabled === false;
        recomputeGeoref(); autosave(); renderWidget(); draw();
      }
    });
    body.querySelectorAll('[data-grefdel]').forEach((b) => b.onclick = () => {
      commit(`delete georeference point ${+b.dataset.grefdel}`);
      st.georefPoints = st.georefPoints.filter((x) => x.id !== +b.dataset.grefdel);
      recomputeGeoref(); autosave(); renderWidget(); draw();
    });
    on('regAll', 'onclick', () => regulariseShapes(null));
    on('snapAll', 'onclick', snapShapesToNeighbours);
    on('qual', 'onclick', runQualityReport);
    on('mTrace', 'onclick', () => setMode('trace'));
    on('mDraw', 'onclick', () => setMode('draw'));
    on('mGcp', 'onclick', () => setMode('gcp'));
    on('sFill', 'onclick', () => { st.traceSubmode = 'fill'; renderWidget(); });
    on('sBorder', 'onclick', () => { st.traceSubmode = 'border'; renderWidget(); });
    on('pick', 'onclick', async () => {
      if (!window.EyeDropper) return toastErr('This browser has no EyeDropper API. Just tap the parcel — Trace samples the colour under your tap.');
      try {
        const res = await new window.EyeDropper().open();
        const h = res.sRGBHex;
        st.pickedColor = { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
        toastOk(`Target colour set to ${h}.`);
      } catch (e) { /* cancelled */ }
    });

    on('dUndo', 'onclick', undoDraw);
    on('dRedo', 'onclick', redoDraw);
    on('gUndo', 'onclick', undoAction);
    on('gRedo', 'onclick', redoAction);
    on('dCancel', 'onclick', () => { st.drawPoints = []; st.mode = 'idle'; renderWidget(); });
    on('dFinish', 'onclick', () => {
      if (st.drawPoints.length < 3) return toastErr('A polygon needs at least 3 corners.');
      const shape = makeShape(st.drawPoints.slice(), 'manual');
      const crossBefore = crossingSnapshot();
      commit('draw a shape by hand');
      st.shapes.push(shape);
      st.drawPoints = []; st.drawUndo = []; st.drawRedo = []; st.mode = 'idle';
      autosave(); draw(); renderWidget();
      // A hand-drawn ring is a set of coordinates like any other, so its corners
      // are immediately available as control-point anchors. Say so, because the
      // alternative is the operator assuming GCPs need a separate survey.
      toastOk(`Shape ${shape.id} added: ${shape.points.length} corners, ${shape.areaM2.toFixed(0)} ${areaUnit()}. Every corner is now taggable as a control point.`);
      reportNewCrossings(crossBefore, 'That shape');
    });

    on('delLast', 'onclick', () => {
      if (!st.shapes.length) return toast('There is no shape to remove.', 'info', 2200);
      const last = st.shapes[st.shapes.length - 1];
      commit(`delete shape ${last.id}`);
      st.shapes.pop();
      st.gcps = st.gcps.filter((g) => g.shapeId !== last.id);
      delete st.backups[last.id];
      if (st.editShapeId === last.id) { st.editShapeId = null; st.mode = 'idle'; }
      recomputeFit(); autosave(); draw(); renderWidget();
      toastOk(`Shape ${last.id} deleted. Ctrl+Z undoes it.`);
    });
    on('delAll', 'onclick', () => {
      const contents = describeSessionContents();
      if (!contents.length) return toast('The session is already empty.', 'info', 2200);
      // State what is about to be lost. "Remove every shape and control point"
      // was both vague and, as it turned out, untrue.
      if (!confirm(`Reset this session completely?\n\nThis removes:\n  • ${contents.join('\n  • ')}\n\nUndo history is cleared too. Exported files are not affected.`)) return;
      clearSessionState();
      autosave(); draw(); renderWidget();
      toastOk('Session reset — shapes, control points and history all cleared.');
    });

    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
      const id = +b.dataset.edit;
      st.editShapeId = st.editShapeId === id ? null : id;
      st.mode = st.editShapeId ? 'edit' : 'idle';
      renderWidget();
    });
    body.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
      const id = +b.dataset.del;
      commit(`delete shape ${id}`);
      st.shapes = st.shapes.filter((s) => s.id !== id);
      st.gcps = st.gcps.filter((g) => g.shapeId !== id);
      delete st.backups[id];
      if (st.editShapeId === id) { st.editShapeId = null; st.mode = 'idle'; }
      recomputeFit(); autosave(); draw(); renderWidget();
    });
    body.querySelectorAll('[data-revert]').forEach((b) => b.onclick = () => revertShape(+b.dataset.revert));
    body.querySelectorAll('[data-reg]').forEach((b) => b.onclick = () => regulariseShapes([+b.dataset.reg]));

    on('ttype', 'onchange', (e) => { S.transformType = e.target.value; S.autoRecommend = false; saveSettings(); recomputeFit(true); renderWidget(); });
    on('robust', 'onchange', (e) => { S.robustFitting = e.target.checked; saveSettings(); recomputeFit(); renderWidget(); });
    on('autorec', 'onchange', (e) => { S.autoRecommend = e.target.checked; saveSettings(); recomputeFit(); renderWidget(); });
    body.querySelectorAll('[data-usetype]').forEach((b) => b.onclick = () => {
      S.transformType = b.dataset.usetype; S.autoRecommend = false; saveSettings(); recomputeFit(true); renderWidget();
    });
    body.querySelectorAll('[data-gzoom]').forEach((b) => b.onclick = () => zoomToGcp(+b.dataset.gzoom));
    body.querySelectorAll('[data-gtoggle]').forEach((b) => b.onclick = () => {
      const g = st.gcps.find((x) => x.id === +b.dataset.gtoggle);
      if (g) {
        commit(`${g.enabled === false ? 'include' : 'exclude'} control point ${g.id}`);
        g.enabled = g.enabled === false;
        recomputeFit(); autosave(); draw(); renderWidget();
      }
    });
    body.querySelectorAll('[data-gdel]').forEach((b) => b.onclick = () => {
      const id = +b.dataset.gdel;
      commit(`delete control point ${id}`);
      st.gcps = st.gcps.filter((g) => g.id !== id);
      if (st.activeGcpId === id) st.activeGcpId = null;
      if (st.lastCapture && st.lastCapture.gcpId === id) st.lastCapture = null;
      recomputeFit(); autosave(); draw(); renderWidget();
    });
    on('gcpClear', 'onclick', () => {
      if (!st.gcps.length) return toast('There are no control points to clear.', 'info', 2200);
      commit(`clear ${st.gcps.length} control point(s)`);
      st.gcps = []; st.nextGcpId = 1;
      st.gcpFit = null; st.gcpRecommendation = null;
      st.lastCapture = null; st.activeGcpId = null;
      clearGcpSelection(true);
      autosave(); draw(); renderWidget();
      toastOk('All control points cleared. The shapes are untouched — use Revert or Ctrl+Z to undo a correction.');
    });
    on('gcpCancelSel', 'onclick', clearGcpSelection);
    on('gcpZoomSel', 'onclick', () => {
      const sel = st.gcpSelection;
      const shape = sel && findShape(sel.shapeId);
      if (shape) zoomToPoint(shape.points[sel.vertexIndex]);
    });
    on('vertexPick', 'onchange', (e) => {
      if (!e.target.value) return;
      const [sid, vi] = e.target.value.split(':').map(Number);
      selectGcpVertex(sid, vi);
    });
    on('showPrev', 'onchange', (e) => { st.showPreview = e.target.checked; draw(); renderWidget(); });
    on('zoomIn', 'onclick', () => {
      const c = st.adapter && st.adapter.getCenter();
      if (c) zoomToPoint(c);
    });
    on('gcpExport', 'onclick', EXPORTS.gcps);
    on('gcpImport', 'onclick', () => importFile('gcps'));
    on('applyOne', 'onclick', () => applyCorrection('tagged'));
    on('applyAll', 'onclick', () => applyCorrection('all'));

    on('crsPick', 'onchange', (e) => {
      const parsed = Crs.parseEpsg(e.target.value);
      if (!parsed) return;
      st.crs = parsed;
      if (st.crsDetection) st.crsDetection.needsConfirmation = false;
      st.shapes.forEach(refreshShapeMetrics);
      autosave(); renderWidget();
      toastOk(`Coordinate system set to ${Crs.describeCrs(parsed)}.`);
    });
    on('crsCheck', 'onclick', () => {
      const c = st.adapter && st.adapter.getCenter();
      if (!c || !st.crs) return toastErr('Nothing to check yet.');
      const ll = Crs.toWgs84(c[0], c[1], st.crs);
      if (!ll) return toastErr('Could not convert the map centre.');
      toast(`Map centre resolves to ${Math.abs(ll[1]).toFixed(5)}°${ll[1] >= 0 ? 'N' : 'S'} ${Math.abs(ll[0]).toFixed(5)}°${ll[0] >= 0 ? 'E' : 'W'}. If that is not where you are, the zone is wrong.`, 'info', 9000);
      window.open(`https://www.openstreetmap.org/?mlat=${ll[1]}&mlon=${ll[0]}#map=15/${ll[1]}/${ll[0]}`, '_blank', 'noopener');
    });

    const bind = (id, key, cast, extra) => on(id, 'oninput', (e) => {
      S[key] = cast(e.target.value);
      saveSettings();
      if (extra) extra();
    });
    bind('sTol', 'colorTolerance', Number);
    bind('sWall', 'wallLuminanceThreshold', Number);
    bind('sLeak', 'leakProtectionRadius', Number);
    bind('sLeakPct', 'bboxLeakWarnPct', Number);
    bind('sGrow', 'edgeGrowthRadius', Number);
    bind('sSimp', 'simplifyPx', Number);
    bind('sBoost', 'precisionZoomBoost', Number);
    bind('sWait', 'imageryWaitMs', Number);
    bind('sGrab', 'gcpGrabPx', Number);
    bind('sScale', 'scaleFactor', Number);
    on('sGeoref', 'onchange', (e) => { S.dxfGeorefMode = e.target.value; saveSettings(); });
    on('sScaleAll', 'onchange', (e) => { S.applyScaleToAllExports = e.target.checked; saveSettings(); });
    on('sLive', 'onchange', (e) => { S.liveRefit = e.target.checked; saveSettings(); });
    on('sSnap', 'onchange', (e) => { S.snapEnabled = e.target.checked; saveSettings(); });
    on('sAutoReg', 'onchange', (e) => { S.autoRegulariseOnTrace = e.target.checked; saveSettings(); });
    on('sShared', 'onchange', (e) => { S.dragSharedCorners = e.target.checked; saveSettings(); });
    on('sWarnCross', 'onchange', (e) => { S.warnNewCrossings = e.target.checked; saveSettings(); });
    on('sAutoGcp', 'onchange', (e) => { S.autoGcpFromEdit = e.target.checked; saveSettings(); });
    // The transform controls appear both on the control-point card and here, so
    // both copies must write the same setting and both must redraw the card.
    on('sAutoRec2', 'onchange', (e) => { S.autoRecommend = e.target.checked; saveSettings(); recomputeFit(); renderWidget(); });
    on('sRobust2', 'onchange', (e) => { S.robustFitting = e.target.checked; saveSettings(); recomputeFit(); renderWidget(); });
    bind('sSnapTol', 'snapToleranceM', Number);
    bind('sRegAng', 'regulariseAngleDeg', Number);
    bind('sRegCol', 'regulariseCollinearM', Number);
    bind('sRegMax', 'regulariseMaxShiftM', Number);
    bind('sBatchMin', 'batchMinPixels', Number);
    bind('sBatchMax', 'batchMaxRegions', Number);
    bind('sZoomBoost', 'manualZoomBoost', Number);
    on('sBlockClicks', 'onchange', (e) => { S.blockSiteClicks = e.target.checked; saveSettings(); });
    on('sReset', 'onclick', () => {
      Object.assign(S, DEFAULT_SETTINGS);
      saveSettings(); renderWidget();
      toastOk('Settings reset.');
    });
    on('advT', 'onclick', () => { advOpen = !advOpen; renderWidget(); });

    for (const [id, fn] of [['xDxf', 'dxf'], ['xKmz', 'kmz'], ['xGeo', 'geojson'], ['xShp', 'shapefile'],
      ['xWkt', 'wkt'], ['xCsv', 'vertexCsv'], ['xArea', 'areaCsv']]) {
      on(id, 'onclick', () => {
        if (!requireShapes()) return;
        EXPORTS[fn]();
        // The menu has done its job; leaving it open covers the map.
        st.openMenu = null;
        renderWidget();
      });
    }
    on('xKml', 'onclick', () => { if (requireShapes()) EXPORTS.kml(); });
    on('xProj', 'onclick', () => {
      const name = prompt('Project name (also saved in this browser):', st.projectName || 'project-1');
      if (name == null) return;
      st.projectName = name.trim();
      if (saveProject(st.projectName)) toastOk(`Saved as "${st.projectName}" and downloading a copy.`);
      EXPORTS.project();
    });
    on('xLoad', 'onclick', () => importFile('project'));

    /* ---- the three main buttons (brief §1, §20) --------------------- */
    on('btnImport', 'onclick', () => { st.openMenu = st.openMenu === 'import' ? null : 'import'; renderWidget(); });
    on('btnExport', 'onclick', () => { st.openMenu = st.openMenu === 'export' ? null : 'export'; renderWidget(); });
    on('btnSaveProject', 'onclick', saveProjectNow);

    /* ---- import entries --------------------------------------------- */
    on('iDxf', 'onclick', () => importGeometryFile('dxf'));
    on('iKml', 'onclick', () => importGeometryFile('kml'));
    on('iCsv', 'onclick', () => importGeometryFile('csv'));
    on('iGeo', 'onclick', () => importGeometryFile('geojson'));
    on('iImage', 'onclick', () => { st.openMenu = null; openWorkspace('file'); });
    on('iPdf', 'onclick', () => { st.openMenu = null; openWorkspace('capture'); });
    on('gcpLoad', 'onclick', () => importFile('gcps'));

    /* ---- CSV format dialog (brief §6, §17) -------------------------- */
    const reparseCsv = (patch) => {
      const d = st.csvDialog;
      if (!d) return;
      Object.assign(d, patch || {});
      const pv = Imp.previewCsv(d.text, { delimiter: d.preview.delimiter, hasHeader: d.preview.hasHeader });
      if (pv.ok) {
        d.preview = pv;
        d.mapping = Object.assign({}, pv.suggestion);
        if (d.groupBy != null) d.groupBy = pv.suggestion.id;
      }
      renderWidget();
    };
    on('csvDelim', 'onchange', (e) => {
      const d = st.csvDialog; if (!d) return;
      const pv = Imp.previewCsv(d.text, { delimiter: e.target.value, hasHeader: d.preview.hasHeader });
      if (!pv.ok) return toastErr(pv.error);
      d.preview = pv; d.mapping = Object.assign({}, pv.suggestion); d.groupBy = pv.suggestion.id;
      renderWidget();
    });
    on('csvHeader', 'onchange', (e) => {
      const d = st.csvDialog; if (!d) return;
      const pv = Imp.previewCsv(d.text, { delimiter: d.preview.delimiter, hasHeader: e.target.checked });
      if (!pv.ok) return toastErr(pv.error);
      d.preview = pv; d.mapping = Object.assign({}, pv.suggestion); d.groupBy = pv.suggestion.id;
      renderWidget();
    });
    on('csvFormat', 'onchange', (e) => {
      const d = st.csvDialog; if (!d) return;
      d.formatKey = e.target.value;
      const preset = Imp.CSV_FORMATS.find((f) => f.key === e.target.value);
      // "Auto detect" re-runs the sniffing; a named layout overrides it; "custom"
      // leaves whatever the operator has already chosen alone.
      if (e.target.value === 'auto') d.mapping = Object.assign({}, d.preview.suggestion);
      else if (preset && preset.mapping) d.mapping = Object.assign({}, preset.mapping);
      renderWidget();
    });
    const mapCol = (id, key) => on(id, 'onchange', (e) => {
      const d = st.csvDialog; if (!d) return;
      d.mapping[key] = e.target.value === '' ? null : Number(e.target.value);
      d.formatKey = 'custom';
      renderWidget();
    });
    mapCol('csvId', 'id'); mapCol('csvX', 'x'); mapCol('csvY', 'y'); mapCol('csvZ', 'z');
    on('csvLonLat', 'onchange', (e) => { if (st.csvDialog) { st.csvDialog.mapping.isLonLat = e.target.checked; renderWidget(); } });
    on('csvGroup', 'onchange', (e) => { if (st.csvDialog) st.csvDialog.groupBy = e.target.value === '' ? null : Number(e.target.value); });
    on('csvSrcX', 'onchange', (e) => { if (st.csvDialog) st.csvDialog.sourceX = e.target.value === '' ? null : Number(e.target.value); });
    on('csvSrcY', 'onchange', (e) => { if (st.csvDialog) st.csvDialog.sourceY = e.target.value === '' ? null : Number(e.target.value); });
    on('csvCrs', 'onchange', (e) => {
      const code = e.target.value;
      if (!code) return;
      const crs = Crs.parseEpsg(code);
      if (!crs) return toastErr('That EPSG code is not one this build knows.');
      if (isWorkspace()) { st.georefCrs = crs; }
      else {
        st.crs = crs;
        st.crsDetection = { crs, confidence: 1, needsConfirmation: false, reasons: ['Chosen during CSV import.'], candidates: [] };
      }
      toast(`Coordinate system set to ${Crs.describeCrs(crs)} for this import.`, 'info', 5000);
    });
    on('csvImport', 'onclick', confirmCsvImport);
    on('csvCancel', 'onclick', () => { st.csvDialog = null; renderWidget(); toast('Import cancelled — nothing was read.', 'info', 2500); });
    void reparseCsv;

    /* ---- Edit tools (brief §10) ------------------------------------- */
    on('eSelect', 'onclick', () => setMode('select'));
    on('eMove', 'onclick', () => {
      if (!st.shapes.length) return toastErr('Nothing to move yet.');
      setMode('move');
      if (st.mode === 'move') {
        toast('Drag a parcel to move it. The map itself does not move — panning still works everywhere else.', 'info', 6000);
      }
    });
    on('eVertex', 'onclick', () => {
      const target = selectedShape() || st.shapes[st.shapes.length - 1];
      if (!target) return toastErr('Nothing to edit yet.');
      if (st.mode === 'edit') { st.mode = 'idle'; st.editShapeId = null; }
      else { st.mode = 'edit'; st.editShapeId = target.id; st.selectedShapeId = target.id; }
      renderWidget();
    });
    on('eAddVertex', 'onclick', () => toast('In Move Vertex mode, tap an edge of the parcel to insert a corner there.', 'info', 5000));
    on('eDelVertex', 'onclick', () => toast('In Move Vertex mode, Alt+tap a white corner handle to delete that corner.', 'info', 5000));

    const numFrom = (id) => {
      const el = q(id);
      const v = el ? parseFloat(String(el.value).trim()) : NaN;
      return isFinite(v) ? v : null;
    };
    on('eApplyXY', 'onclick', () => {
      const shape = selectedShape();
      if (!shape) return toastErr('Select a parcel first.');
      const dx = numFrom('eDx') || 0;
      const dy = numFrom('eDy') || 0;
      if (!dx && !dy) return toastErr('Enter an X or Y shift.');
      moveShapeBy(shape, dx, dy, `move shape ${shape.id} by ${dx}, ${dy}`);
      toastOk(`Shape ${shape.id} moved ${dx}, ${dy}. Ctrl+Z undoes it.`);
    });
    on('eApplyRot', 'onclick', () => {
      const shape = selectedShape();
      if (!shape) return toastErr('Select a parcel first.');
      const deg = numFrom('eRot');
      if (deg == null || deg === 0) return toastErr('Enter a rotation in degrees.');
      rotateShapeBy(shape, deg);
      toastOk(`Shape ${shape.id} rotated ${deg}° about its own centre.`);
    });
    on('eApplyScale', 'onclick', () => {
      const shape = selectedShape();
      if (!shape) return toastErr('Select a parcel first.');
      const f = numFrom('eScale');
      if (f == null || f <= 0) return toastErr('Enter a positive scale factor, for example 1.01.');
      if (f === 1) return toastErr('A factor of 1 changes nothing.');
      scaleShapeBy(shape, f);
      toastOk(`Shape ${shape.id} scaled ×${f} about its own centre. Its area changed by ${(((f * f) - 1) * 100).toFixed(2)}%.`);
    });
    on('eCopy', 'onclick', () => {
      const shape = selectedShape();
      if (!shape) return toastErr('Select a parcel first.');
      const wkt = Exp.makeWkt([shape], exportOpts());
      const done = () => toastOk(`Shape ${shape.id} copied to the clipboard as WKT.`);
      safe(() => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(wkt).then(done, () => toastErr('The browser refused clipboard access. Export WKT instead.'));
        } else {
          // No clipboard permission is a normal state, not a failure worth
          // losing the geometry over.
          download(`shape_${shape.id}.wkt`, wkt, 'text/plain');
          toastOk(`Clipboard unavailable, so shape ${shape.id} was written to a .wkt file instead.`);
        }
      });
    });
    on('eDuplicate', 'onclick', () => {
      const shape = selectedShape();
      if (!shape) return toastErr('Select a parcel first.');
      const copy = duplicateShape(shape);
      if (copy) toastOk(`Duplicated as shape ${copy.id}, offset so both can be selected. Ctrl+Z undoes it.`);
    });
    on('eDelete', 'onclick', () => {
      const shape = selectedShape();
      if (!shape) return toastErr('Select a parcel first.');
      commit(`delete shape ${shape.id}`);
      st.shapes = st.shapes.filter((s) => s.id !== shape.id);
      st.gcps = st.gcps.filter((g) => g.shapeId !== shape.id);
      delete st.backups[shape.id];
      if (st.editShapeId === shape.id) { st.editShapeId = null; st.mode = 'idle'; }
      st.selectedShapeId = null;
      recomputeFit(); autosave(); draw(); renderWidget();
      toastOk(`Shape ${shape.id} deleted. Ctrl+Z undoes it.`);
    });
    on('eResetShift', 'onclick', () => resetShapeShift(selectedShape()));
    on('eToggleOrig', 'onclick', () => { st.showOriginals = !st.showOriginals; draw(); renderWidget(); });

    body.querySelectorAll('[data-sel]').forEach((b) => b.onclick = () => {
      const id = +b.dataset.sel;
      st.selectedShapeId = st.selectedShapeId === id ? null : id;
      draw(); renderWidget();
    });

    /* ---- drawing scale and underlay (brief §11, §12, §13) ----------- */
    on('rfApply', 'onclick', () => {
      const el = q('rfDen'); const dpiEl = q('rfDpi');
      applyRfCalibration(el ? el.value : null, dpiEl ? dpiEl.value : S.scanDpi);
    });
    on('calPick', 'onclick', () => {
      st.calibrationPick = [];
      setMode('calibrate');
      if (st.mode === 'calibrate') toast('Tap the two ends of a distance you know on the drawing.', 'info', 6000);
    });
    on('calApply', 'onclick', () => {
      const el = q('calDist');
      applyScaleBarCalibration(el ? parseFloat(el.value) : NaN);
    });
    on('calClear', 'onclick', () => {
      commit('clear the drawing scale');
      st.calibration = null; st.calibrationPick = [];
      st.shapes.forEach(refreshShapeMetrics);
      autosave(); renderWidget(); draw();
      toastOk('Drawing scale cleared — areas are back to pixels.');
    });
    on('wsOpacity', 'oninput', (e) => {
      S.drawingOpacity = Number(e.target.value) / 100;
      saveSettings(); applyDrawingStyle();
      const label = e.target.parentElement && e.target.parentElement.querySelector('.mono');
      if (label) label.textContent = `${e.target.value}%`;
    });
    on('wsRotate', 'onchange', (e) => {
      S.drawingRotationDeg = Number(e.target.value) || 0;
      saveSettings(); applyDrawingStyle();
    });
    on('wsLock', 'onchange', (e) => {
      S.drawingLocked = e.target.checked;
      saveSettings(); applyDrawingStyle();
      toast(S.drawingLocked
        ? 'Drawing locked — panning and zooming the sheet is disabled so a calibrated position cannot be nudged by accident.'
        : 'Drawing unlocked.', 'info', 4000);
    });

    /* ---- collapsible sections (brief §7) ---------------------------- */
    body.querySelectorAll('details.sect').forEach((d) => {
      d.addEventListener('toggle', () => toggleSection(d.dataset.sect, d.open));
    });
  }

  /* Save the working project in one press (brief §20). Once it has a name it
   * saves over that project rather than making "project-1 (2)" every time. */
  function saveProjectNow() {
    st.openMenu = null;
    let name = st.projectName;
    if (!name) {
      const asked = prompt('Name this project (it is saved in this browser and written as ProjectName.json):', 'project-1');
      if (asked == null) return;
      name = String(asked).trim();
      if (!name) return toastErr('A project needs a name.');
      st.projectName = name;
    }
    const stored = saveProject(name);
    const safeName = name.replace(/[^\w\-. ]+/g, '_');
    download(`${safeName}.json`, JSON.stringify(serialiseSession(), null, 2), 'application/json');
    renderWidget();
    toastOk(`"${name}" saved${stored ? ' in this browser' : ''} and written as ${safeName}.json — ${st.shapes.length} parcel(s), ${st.gcps.length} control point(s).`);
  }

  /* Opacity, rotation and lock are display properties of the underlay. They
   * change how the sheet is PRESENTED and never touch a coordinate — a
   * rotation here does not move one digitized vertex (brief §11, §26). */
  function applyDrawingStyle() {
    const A = st.workspace;
    if (!A) return;
    safe(() => {
      if (isFn(A.setDisplayStyle)) {
        A.setDisplayStyle({
          opacity: S.drawingOpacity == null ? 1 : S.drawingOpacity,
          rotationDeg: Number(S.drawingRotationDeg) || 0,
        });
      }
      // Locking gates the sheet's own pan and zoom handlers rather than the
      // container's pointer events, so tracing and editing stay fully live on a
      // locked sheet — the point of locking is that the CALIBRATION cannot be
      // disturbed, not that work stops.
      if (isFn(A.setLocked)) A.setLocked(S.drawingLocked);
    });
    draw();
  }

  /* =====================================================================
   * KEYBOARD
   * =================================================================== */
  let lastNudgeAt = 0;
  let lastNudgeGcpId = null;

  function onKeyDown(e) {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (e.key === 'Escape') {
      // Mid-pairing, Esc cancels just that pairing rather than the whole mode —
      // abandoning the session because of one mis-tap would be needless.
      if (st.gcpStage === 'placeTarget') { clearGcpSelection(); return; }
      if (st.mode !== 'idle') { st.mode = 'idle'; st.editShapeId = null; st.drawPoints = []; renderWidget(); }
      return;
    }
    // Ctrl+Z / Ctrl+Y everywhere, not just while drawing.
    //
    // While a polygon is being drawn, undo means "take back that corner", which
    // is what the operator means by it at that moment. Everywhere else it means
    // "take back that operation" — deleting a shape, applying a correction,
    // regularising, snapping. Both are Ctrl+Z; which one is meant is never
    // ambiguous, because the corner-level stack only exists mid-draw.
    const z = e.key.toLowerCase() === 'z';
    const y = e.key.toLowerCase() === 'y';
    if (e.ctrlKey || e.metaKey) {
      if (z && !e.shiftKey) {
        e.preventDefault();
        if (st.mode === 'draw' && st.drawUndo.length) undoDraw(); else undoAction();
        return;
      }
      if (y || (z && e.shiftKey)) {
        e.preventDefault();
        if (st.mode === 'draw' && st.drawRedo.length) redoDraw(); else redoAction();
        return;
      }
    }
    // Nudge the active control point by one pixel with the arrow keys — the
    // last word in precision once you have zoomed in.
    if (st.activeGcpId && /^Arrow/.test(e.key)) {
      const g = st.gcps.find((x) => x.id === st.activeGcpId);
      const A = st.adapter;
      if (!g || !A) return;
      const c = A.mapCoordToClient(g.target[0], g.target[1]);
      if (!c) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const np = A.clientToMapCoord(c[0] + dx, c[1] + dy);
      if (np) {
        // Coalesce a run of nudges into one undo step. One entry per keypress
        // would fill the whole stack with single-pixel moves and bury the
        // operation the operator actually wants back.
        const now = Date.now();
        if (now - lastNudgeAt > 900 || lastNudgeGcpId !== g.id) commit(`nudge control point ${g.id}`);
        lastNudgeAt = now; lastNudgeGcpId = g.id;
        g.target = np; recomputeFit(); autosave(); draw(); renderWidget();
      }
      e.preventDefault();
    }
  }

  /* =====================================================================
   * LIFECYCLE
   * =================================================================== */
  function showPill() {
    hidePill();
    const b = document.createElement('button');
    b.id = PILL_ID;
    b.textContent = `🧭 Digitizer${st.shapes.length ? ` (${st.shapes.length})` : ''}`;
    b.onclick = () => { hidePill(); buildWidget(); };
    document.body.appendChild(b);
  }
  function hidePill() {
    const p = document.getElementById(PILL_ID);
    if (p) p.remove();
  }

  function closeWidget() {
    const w = document.getElementById(WIDGET_ID);
    if (w) w.remove();
    showPill();
  }

  function showWidget() {
    hidePill();
    const w = document.getElementById(WIDGET_ID);
    if (w) { w.classList.remove('min'); renderWidget(); }
    else buildWidget();
  }

  window.addEventListener('BND15_MSG', (e) => {
    const m = e && e.detail;
    if (!m) return;
    if (m.type === 'BND15_SHOW_WIDGET') showWidget();
    else if (m.type === 'BND15_TOGGLE_WIDGET') {
      document.getElementById(WIDGET_ID) ? closeWidget() : showWidget();
    }
  });

  async function boot() {
    const r = bootAdapter();
    if (!r.ok) {
      installStyle();
      buildWidget();
      toastErr(r.error);
      return;
    }
    installPlotCapture();
    onPlotUpdate = () => renderWidget();

    // Wait briefly for the map to have a view before sampling for CRS.
    for (let i = 0; i < 20 && !st.adapter.getCenter(); i++) await sleep(150);
    detectCrs();

    const saved = loadAutosave();
    if (saved && restoreSession(saved)) {
      st.shapes.forEach(refreshShapeMetrics);
      recomputeFit();
    }

    ensureOverlay();
    installGestures();
    document.addEventListener('keydown', onKeyDown, true);
    // The map element can be replaced by the host app; re-attach if so.
    setInterval(() => { ensureOverlay(); installGestures(); }, 2000);

    buildWidget();
    reportCount();

    const d = st.crsDetection;
    if (d && d.needsConfirmation) {
      toast(d.crs
        ? `Coordinate system is a best guess (${Crs.describeCrs(d.crs)}). Confirm it before exporting.`
        : 'Could not determine the coordinate system. Set it in the CRS panel before exporting.',
      'warn', 9000);
    } else if (d && d.crs) {
      toastOk(`Ready — ${st.adapter.label}, ${Crs.describeCrs(d.crs)}.`);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
