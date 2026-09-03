/* =========================================================================
 * Geometry utilities and export writers.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Export) or a CommonJS module. Pure:
 * no DOM, no map, so all of it is testable headlessly.
 *
 * WHAT v13/v14 GOT WRONG AND THIS FIXES
 *
 *  - plotNo was interpolated straight into KML and widget HTML. A parcel
 *    number containing "&" produced a KMZ that no reader would open, and a
 *    hostile or merely odd server response could inject markup.
 *  - scaleFactor applied to DXF only, so the three exports of one session
 *    silently disagreed with each other.
 *  - DXF discarded absolute position entirely (origin = first shape's
 *    centroid), making the output unusable in GIS without manual placement.
 *  - GeoJSON ring winding was whatever the tracer produced. RFC 7946 requires
 *    counter-clockwise exteriors, and strict readers enforce it.
 *  - Areas were computed by shoelace on grid coordinates and reported as
 *    ground area. On a transverse Mercator grid those differ by the square of
 *    the point scale factor — small, but systematic, and it is compared
 *    against a legally recorded area.
 *  - Self-intersecting rings (a common flood-fill artefact) were exported
 *    without comment, and are invalid in nearly every consumer.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Export = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================
   * ESCAPING
   * =================================================================== */
  const XML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  function escapeXml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => XML_MAP[c]);
  }
  const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => HTML_MAP[c]);
  }
  // Spreadsheet software treats a leading =, +, -, @, tab or CR as a formula.
  // A parcel identifier beginning with one of those becomes executable content
  // in Excel, so it is neutralised with a leading apostrophe.
  function escapeCsv(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  // DXF strings are length-prefixed by group code, not quoted, but embedded
  // newlines corrupt the file structure.
  function sanitizeDxfText(v) {
    return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, 250);
  }

  /* =====================================================================
   * RING GEOMETRY
   * =================================================================== */
  function isClosed(ring) {
    if (ring.length < 2) return false;
    const a = ring[0], b = ring[ring.length - 1];
    return a[0] === b[0] && a[1] === b[1];
  }
  function closeRing(ring) {
    if (!ring.length || isClosed(ring)) return ring.slice();
    return ring.concat([[ring[0][0], ring[0][1]]]);
  }
  function openRing(ring) {
    const r = ring.slice();
    while (r.length > 1 && isClosed(r)) r.pop();
    return r;
  }

  // Signed shoelace area. Positive means counter-clockwise in a standard
  // right-handed frame (x east, y north), which is what RFC 7946 wants for
  // exterior rings.
  /* Shoelace area, accumulated in a LOCAL FRAME.
   *
   * Same reasoning as centroidOfRing: the cross products scale with the square
   * of the coordinate magnitude while the area depends on their difference. On
   * a rotated 1600 m² plot at Jharkhand UTM values the raw form lost about
   * 0.15 ppm to cancellation — nowhere near a cadastral tolerance, but it is
   * noise where double precision should be giving ~1e-13, and area is this
   * program's headline output. Subtracting the first vertex costs one
   * subtraction per term; area is translation-invariant, so the result is
   * unchanged in exact arithmetic and the sign (used for winding) with it.
   */
  function signedArea(ring) {
    const r = openRing(ring);
    if (r.length < 3) return 0;
    const ox = r[0][0], oy = r[0][1];
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      a += (p[0] - ox) * (q[1] - oy) - (q[0] - ox) * (p[1] - oy);
    }
    return a / 2;
  }
  function gridArea(ring) { return Math.abs(signedArea(ring)); }
  function isCounterClockwise(ring) { return signedArea(ring) > 0; }
  function ensureWinding(ring, wantCcw) {
    const ccw = isCounterClockwise(ring);
    return ccw === !!wantCcw ? ring.slice() : ring.slice().reverse();
  }

  function perimeter(ring) {
    const r = closeRing(ring);
    let p = 0;
    for (let i = 0; i < r.length - 1; i++) {
      p += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]);
    }
    return p;
  }

  function centroidOfRing(ring) {
    const r = openRing(ring);
    if (!r.length) return null;
    // Area-weighted centroid, not the mean of vertices: the vertex mean is
    // biased toward wherever the tracer happened to place more points, which
    // for a flood-fill boundary is systematically the wiggly side.
    //
    // Accumulated in a LOCAL FRAME, for the same reason the affine fit is
    // solved on centred coordinates. The cross products grow as the square of
    // the coordinate magnitude while the answer depends on their difference: at
    // Jharkhand UTM values they reach ~1.1e12 for a plot of ~1600 m², and a
    // rotated 40 m square came out 13 cm from its true centre. Subtracting the
    // first vertex makes every term the size of the plot rather than the size
    // of the grid; the centroid is translation-equivariant, so adding it back
    // is exact.
    const ox = r[0][0], oy = r[0][1];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const px = p[0] - ox, py = p[1] - oy;
      const qx = q[0] - ox, qy = q[1] - oy;
      const cross = px * qy - qx * py;
      a += cross;
      cx += (px + qx) * cross;
      cy += (py + qy) * cross;
    }
    if (Math.abs(a) < 1e-12) {
      const n = r.length;
      return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n];
    }
    return [cx / (3 * a) + ox, cy / (3 * a) + oy];
  }

  function boundsOf(rings) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const ring of rings) for (const p of ring) {
      if (p[0] < xmin) xmin = p[0];
      if (p[1] < ymin) ymin = p[1];
      if (p[0] > xmax) xmax = p[0];
      if (p[1] > ymax) ymax = p[1];
    }
    return { xmin, ymin, xmax, ymax };
  }

  /* ---------------------------------------------------------------------
   * VALIDITY — self-intersection detection.
   *
   * Flood-fill boundaries pinch themselves surprisingly often, especially
   * where a parcel narrows to a track. A pinched ring has a well-defined
   * shoelace area, so nothing downstream complains; it is simply wrong, and
   * most GIS tools will either reject or silently repair it.
   * ------------------------------------------------------------------- */
  function segmentsIntersect(p1, p2, p3, p4) {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    const onSeg = (a, b, c) =>
      Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
      Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
    if (d1 === 0 && onSeg(p3, p4, p1)) return true;
    if (d2 === 0 && onSeg(p3, p4, p2)) return true;
    if (d3 === 0 && onSeg(p1, p2, p3)) return true;
    if (d4 === 0 && onSeg(p1, p2, p4)) return true;
    return false;
  }

  function findSelfIntersections(ring, limit) {
    const r = openRing(ring);
    const n = r.length;
    const out = [];
    const cap = limit || 20;
    if (n < 4) return out;
    for (let i = 0; i < n; i++) {
      const a1 = r[i], a2 = r[(i + 1) % n];
      // Skip adjacent segments: they legitimately share an endpoint.
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const b1 = r[j], b2 = r[(j + 1) % n];
        if (segmentsIntersect(a1, a2, b1, b2)) {
          out.push([i, j]);
          if (out.length >= cap) return out;
        }
      }
    }
    return out;
  }

  function validateRing(ring) {
    const problems = [];
    const r = openRing(ring);
    if (r.length < 3) problems.push({ code: 'too-few-points', message: `A polygon needs at least 3 distinct points; this ring has ${r.length}.` });
    // Consecutive duplicates are harmless to area but break some writers.
    let dupes = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if (a[0] === b[0] && a[1] === b[1]) dupes++;
    }
    if (dupes) problems.push({ code: 'duplicate-points', message: `${dupes} zero-length edge(s) — consecutive identical vertices.` });
    if (r.length >= 4) {
      const xs = findSelfIntersections(ring, 5);
      if (xs.length) {
        problems.push({
          code: 'self-intersection',
          message: `The boundary crosses itself (${xs.length === 5 ? 'at least 5' : xs.length} place(s), first between edge ${xs[0][0]} and edge ${xs[0][1]}). Most GIS tools reject or silently repair this. It usually means the trace pinched where the parcel narrows — fix it with the vertex editor.`,
          pairs: xs,
        });
      }
    }
    if (Math.abs(signedArea(r)) < 1e-9) {
      problems.push({ code: 'zero-area', message: 'The ring encloses no area — all points may be collinear.' });
    }
    return { valid: problems.length === 0, problems };
  }

  /* ---------------------------------------------------------------------
   * AREA
   *
   * Three distinct quantities, deliberately named apart because conflating
   * them is how a plot ends up "matching" a recorded area that it does not.
   * ------------------------------------------------------------------- */
  // WGS84 authalic (equal-area) mean radius. Kept for reference, but NOT used
  // for parcel areas — see below.
  const AUTHALIC_R = 6371007.181;
  const WGS84_A = 6378137.0;
  const WGS84_E2 = 0.00669437999014; // f = 1/298.257223563

  // Local Gaussian radius of curvature, sqrt(M*N).
  //
  // WHY THIS RATHER THAN THE AUTHALIC RADIUS: cross-checking geodesic area
  // against an independently projected planar area exposed a systematic 0.23%
  // discrepancy at Jharkhand's latitude. That is not noise — it is the
  // difference between the ellipsoid's local curvature and the global mean
  // radius, and it is a consistent OVER-estimate of about 9 m² on a 4000 m²
  // plot. When the number is being compared against a legally recorded area,
  // a systematic bias in that range is not acceptable. Using the local radius
  // at the polygon's mean latitude reduces the error to ~2e-5.
  function gaussianRadiusAt(latRad) {
    const s = Math.sin(latRad);
    const t = 1 - WGS84_E2 * s * s;
    const M = WGS84_A * (1 - WGS84_E2) / Math.pow(t, 1.5);
    const N = WGS84_A / Math.sqrt(t);
    return Math.sqrt(M * N);
  }

  // Geodesic area of a lon/lat ring, by spherical excess on a sphere matched
  // to the ellipsoid's curvature at this latitude (Chamberlain & Duquette).
  function geodesicArea(lonLatRing) {
    const r = openRing(lonLatRing);
    const n = r.length;
    if (n < 3) return 0;
    const rad = Math.PI / 180;
    let meanLat = 0;
    for (const p of r) meanLat += p[1];
    meanLat = (meanLat / n) * rad;
    const R = gaussianRadiusAt(meanLat);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p1 = r[i], p2 = r[(i + 1) % n];
      total += (p2[0] - p1[0]) * rad * (Math.sin(p1[1] * rad) + Math.sin(p2[1] * rad));
    }
    return Math.abs(total * R * R / 2);
  }

  // Grid area corrected to the ground by the point scale factor. `k` is the
  // CRS scale factor at the plot; areas scale as k^2.
  function groundAreaFromGrid(ring, k) {
    const kk = (isFinite(k) && k > 0) ? k : 1;
    return gridArea(ring) / (kk * kk);
  }

  const M2_PER_ACRE = 4046.8564224;
  const M2_PER_DECIMAL = 40.468564224; // 1/100 acre, the Indian "decimal"
  const M2_PER_HECTARE = 10000;
  function formatAreaIndian(m2) {
    const acres = m2 / M2_PER_ACRE;
    const whole = Math.floor(acres);
    const decimals = (acres - whole) * 100;
    return {
      m2,
      hectares: m2 / M2_PER_HECTARE,
      acres,
      text: `${whole} एकड़ ${decimals.toFixed(2)} डिसमिल (${m2.toFixed(1)} m², ${(m2 / M2_PER_HECTARE).toFixed(4)} ha)`,
    };
  }
  function parseIndianAreaToM2(text) {
    if (!text) return null;
    const s = String(text);
    const acre = s.match(/([\d.]+)\s*(?:एकड़|acre)/i);
    const dec = s.match(/([\d.]+)\s*(?:डिस(?:मिल)?|decimal)/i);
    const hect = s.match(/([\d.]+)\s*(?:हेक्टेयर|hectare|ha)\b/i);
    const sqm = s.match(/([\d.]+)\s*(?:वर्ग\s*मीटर|sq\.?\s*m|m2|m²)/i);
    if (!acre && !dec && !hect && !sqm) return null;
    let m2 = 0;
    if (acre) m2 += parseFloat(acre[1]) * M2_PER_ACRE;
    if (dec) m2 += parseFloat(dec[1]) * M2_PER_DECIMAL;
    if (hect) m2 += parseFloat(hect[1]) * M2_PER_HECTARE;
    if (sqm) m2 += parseFloat(sqm[1]);
    return m2 > 0 ? m2 : null;
  }

  /* =====================================================================
   * DXF
   *
   * Georeferencing mode is explicit rather than implied:
   *   absolute  true CRS coordinates. Correct for GIS, but large numbers that
   *             some older CAD setups round badly.
   *   shift     absolute minus a round origin, with the origin written into the
   *             file as a comment and as $INSBASE so it is never lost.
   *   local     v13 behaviour, origin at the first shape's centroid. Kept for
   *             continuity but it throws the georeferencing away.
   * =================================================================== */
  function makeDxf(shapes, opts) {
    const o = opts || {};
    const mode = o.georefMode || 'shift';
    const factor = (isFinite(o.scaleFactor) && o.scaleFactor > 0) ? o.scaleFactor : 1;
    const usable = shapes.filter((s) => s.points && s.points.length >= 3);
    if (!usable.length) return { text: '', plotsWritten: 0, origin: [0, 0], mode };

    const all = usable.map((s) => s.points);
    const b = boundsOf(all);
    let origin = [0, 0];
    if (mode === 'local') {
      origin = centroidOfRing(usable[0].points) || [0, 0];
    } else if (mode === 'shift') {
      origin = [Math.floor(b.xmin / 1000) * 1000, Math.floor(b.ymin / 1000) * 1000];
    }

    const lines = [];
    const w = (code, val) => { lines.push(String(code)); lines.push(String(val)); };
    const xform = ([x, y]) => [(x - origin[0]) * factor, (y - origin[1]) * factor];

    w(999, `BhuNaksha Digitizer export`);
    w(999, `CRS: ${sanitizeDxfText(o.crsLabel || 'unspecified')}`);
    w(999, `Georeferencing mode: ${mode}`);
    w(999, `Coordinate origin offset: ${origin[0]} ${origin[1]} (add these back to recover true CRS coordinates)`);
    w(999, `Scale factor applied: ${factor}`);

    w(0, 'SECTION'); w(2, 'HEADER');
    w(9, '$ACADVER'); w(1, 'AC1009');
    w(9, '$INSBASE'); w(10, origin[0]); w(20, origin[1]); w(30, 0);
    w(9, '$EXTMIN'); w(10, (b.xmin - origin[0]) * factor); w(20, (b.ymin - origin[1]) * factor); w(30, 0);
    w(9, '$EXTMAX'); w(10, (b.xmax - origin[0]) * factor); w(20, (b.ymax - origin[1]) * factor); w(30, 0);
    w(0, 'ENDSEC');

    w(0, 'SECTION'); w(2, 'TABLES');
    w(0, 'TABLE'); w(2, 'LAYER'); w(70, 2);
    w(0, 'LAYER'); w(2, 'Plot_Boundary'); w(70, 0); w(62, 5); w(6, 'CONTINUOUS');
    w(0, 'LAYER'); w(2, 'Plot_Label'); w(70, 0); w(62, 3); w(6, 'CONTINUOUS');
    w(0, 'ENDTAB'); w(0, 'ENDSEC');

    w(0, 'SECTION'); w(2, 'ENTITIES');
    let plotsWritten = 0;
    for (const shape of usable) {
      const local = openRing(shape.points).map(xform);
      w(0, 'POLYLINE'); w(8, 'Plot_Boundary'); w(66, 1); w(70, 1); // 70=1: closed
      for (const [lx, ly] of local) {
        w(0, 'VERTEX'); w(8, 'Plot_Boundary'); w(10, lx.toFixed(4)); w(20, ly.toFixed(4)); w(30, '0.0');
      }
      w(0, 'SEQEND');
      const label = sanitizeDxfText(shape.plotNo ? `Plot ${shape.plotNo}` : `Shape ${shape.id}`);
      const c = centroidOfRing(local);
      if (c) {
        w(0, 'TEXT'); w(8, 'Plot_Label');
        w(10, c[0].toFixed(4)); w(20, c[1].toFixed(4)); w(30, '0.0');
        w(40, o.textHeight || 2); w(1, label);
      }
      plotsWritten++;
    }
    w(0, 'ENDSEC'); w(0, 'EOF');
    return { text: lines.join('\r\n'), plotsWritten, origin, mode };
  }

  /* =====================================================================
   * KML / GeoJSON / WKT
   * =================================================================== */
  function makeKml(shapes, opts) {
    const o = opts || {};
    const toLonLat = o.toLonLat || ((p) => p);
    const placemarks = shapes.filter((s) => s.points && s.points.length >= 3).map((shape) => {
      const ring = closeRing(openRing(shape.points).map(toLonLat).filter(Boolean));
      const coords = ring.map((p) => `${p[0]},${p[1]},0`).join(' ');
      const name = escapeXml(shape.plotNo ? `Plot ${shape.plotNo}` : `Shape ${shape.id}`);
      const desc = [];
      if (shape.areaText) desc.push(`Recorded area: ${shape.areaText}`);
      if (shape.computedAreaM2 != null) desc.push(`Digitised area: ${shape.computedAreaM2.toFixed(1)} m²`);
      if (o.crsLabel) desc.push(`Source CRS: ${o.crsLabel}`);
      if (shape.lastGcpCorrection) {
        desc.push(`GCP-corrected (${shape.lastGcpCorrection.type}, ${shape.lastGcpCorrection.gcpCount || '?'} control points)`);
      }
      return `<Placemark><name>${name}</name>` +
        `<description>${escapeXml(desc.join('. '))}</description>` +
        `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates>` +
        `</LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${escapeXml(o.documentName || 'Digitized Plots')}</name>${placemarks}` +
      `</Document></kml>`;
  }

  function makeGeoJson(shapes, opts) {
    const o = opts || {};
    const toLonLat = o.toLonLat || ((p) => p);
    const features = shapes.filter((s) => s.points && s.points.length >= 3).map((shape) => {
      const src = openRing(shape.points);
      const lonLat = src.map(toLonLat).filter(Boolean);
      // RFC 7946: exterior rings counter-clockwise, and rings closed.
      const ring = closeRing(ensureWinding(lonLat, true));
      const props = {
        plotNo: shape.plotNo == null ? null : String(shape.plotNo),
        recordedArea: shape.areaText || null,
        digitisedAreaM2: shape.computedAreaM2 == null ? null : Number(shape.computedAreaM2.toFixed(2)),
        perimeterM: Number(perimeter(src).toFixed(2)),
        mode: shape.mode || null,
        vertexCount: src.length,
        sourceCrs: o.crsLabel || null,
        // Raw source-CRS coordinates, so a downstream tool can re-georeference
        // without inheriting any assumption made here.
        sourceCoords: closeRing(src),
      };
      if (shape.lastGcpCorrection) props.gcpCorrection = shape.lastGcpCorrection;
      if (o.includeValidity) props.validity = validateRing(src);
      return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
    });
    const fc = { type: 'FeatureCollection', features };
    if (o.crsLabel) fc.metadata = { sourceCrs: o.crsLabel, generator: 'BhuNaksha Digitizer', exportedAt: new Date().toISOString() };
    return fc;
  }

  function makeWkt(shapes, opts) {
    const o = opts || {};
    const t = o.toLonLat || ((p) => p);
    const polys = shapes.filter((s) => s.points && s.points.length >= 3).map((s) => {
      const ring = closeRing(openRing(s.points).map(t).filter(Boolean));
      return `((${ring.map((p) => `${p[0]} ${p[1]}`).join(', ')}))`;
    });
    if (!polys.length) return '';
    return polys.length === 1 ? `POLYGON${polys[0]}` : `MULTIPOLYGON(${polys.join(', ')})`;
  }

  /* =====================================================================
   * CSV — vertex list in survey form.
   * =================================================================== */
  function makeVertexCsv(shapes, opts) {
    const o = opts || {};
    const toLonLat = o.toLonLat || (() => null);
    const rows = [['plot_no', 'shape_id', 'vertex_index', 'easting_or_lon', 'northing_or_lat', 'longitude', 'latitude']];
    for (const shape of shapes) {
      if (!shape.points || !shape.points.length) continue;
      openRing(shape.points).forEach((p, i) => {
        const ll = toLonLat(p);
        rows.push([
          escapeCsv(shape.plotNo == null ? '' : shape.plotNo),
          escapeCsv(shape.id),
          i,
          p[0].toFixed(4), p[1].toFixed(4),
          ll ? ll[0].toFixed(9) : '', ll ? ll[1].toFixed(9) : '',
        ]);
      });
    }
    return rows.map((r) => r.join(',')).join('\r\n');
  }

  function makeAreaReportCsv(shapes, opts) {
    const o = opts || {};
    const rows = [['plot_no', 'shape_id', 'vertices', 'digitised_area_m2', 'digitised_area_acres',
      'recorded_area_text', 'recorded_area_m2', 'difference_pct', 'perimeter_m', 'valid', 'problems']];
    for (const shape of shapes) {
      if (!shape.points || shape.points.length < 3) continue;
      const areaM2 = shape.computedAreaM2 != null ? shape.computedAreaM2 : gridArea(shape.points);
      const recorded = parseIndianAreaToM2(shape.areaText);
      const diff = recorded ? ((areaM2 - recorded) / recorded) * 100 : null;
      const v = validateRing(shape.points);
      rows.push([
        escapeCsv(shape.plotNo == null ? '' : shape.plotNo),
        escapeCsv(shape.id),
        openRing(shape.points).length,
        areaM2.toFixed(2),
        (areaM2 / M2_PER_ACRE).toFixed(5),
        escapeCsv(shape.areaText || ''),
        recorded ? recorded.toFixed(2) : '',
        diff == null ? '' : diff.toFixed(2),
        perimeter(shape.points).toFixed(2),
        v.valid ? 'yes' : 'no',
        escapeCsv(v.problems.map((p) => p.code).join('; ')),
      ]);
    }
    return rows.map((r) => r.join(',')).join('\r\n');
  }

  /* =====================================================================
   * GCP EXCHANGE — QGIS-compatible .points format.
   *
   * Control points are expensive to collect and were previously trapped in a
   * sessionStorage blob. This makes them portable: reusable across sessions,
   * reviewable by a colleague, and loadable into QGIS's georeferencer.
   * =================================================================== */
  function makeGcpPointsFile(gcpPairs, opts) {
    const o = opts || {};
    const lines = [];
    lines.push(`#CRS: ${o.crsLabel || 'unknown'}`);
    lines.push('mapX,mapY,pixelX,pixelY,enable,dX,dY,residual');
    for (const g of gcpPairs) {
      const t = g.confirmedPoint, s = g.rawPoint;
      lines.push([
        t[0].toFixed(4), t[1].toFixed(4),
        s[0].toFixed(4), s[1].toFixed(4),
        g.enabled === false ? 0 : 1,
        (t[0] - s[0]).toFixed(4), (t[1] - s[1]).toFixed(4),
        g.residual == null ? '' : g.residual.toFixed(4),
      ].join(','));
    }
    return lines.join('\n');
  }

  function parseGcpPointsFile(text) {
    const pairs = [];
    const errors = [];
    const lines = String(text || '').split(/\r?\n/);
    let idx = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || /^mapX/i.test(line)) continue;
      const f = line.split(',');
      if (f.length < 4) { errors.push(`Skipped malformed line: ${line.slice(0, 60)}`); continue; }
      const mapX = parseFloat(f[0]), mapY = parseFloat(f[1]);
      const pxX = parseFloat(f[2]), pxY = parseFloat(f[3]);
      if (![mapX, mapY, pxX, pxY].every(isFinite)) { errors.push(`Skipped non-numeric line: ${line.slice(0, 60)}`); continue; }
      pairs.push({
        vertexIndex: idx++,
        rawPoint: [pxX, pxY],
        confirmedPoint: [mapX, mapY],
        enabled: f[4] === undefined ? true : f[4].trim() !== '0',
      });
    }
    return { pairs, errors };
  }

  /* =====================================================================
   * SHAPEFILE (.shp / .shx / .dbf / .prj / .cpg)
   *
   * Written by hand because the format is simple and pulling in a dependency
   * for it would mean bundling and a build step. Mixed endianness is the only
   * real trap: the file headers and record headers are big-endian, everything
   * inside a record is little-endian.
   * =================================================================== */
  const SHP_POLYGON = 5;

  function shapefileFrom(shapes, opts) {
    const o = opts || {};
    const usable = shapes.filter((s) => s.points && s.points.length >= 3);
    // Shapefile polygon rings must be CLOCKWISE for outer rings — the opposite
    // of GeoJSON. Getting this backwards makes the polygon a hole.
    const rings = usable.map((s) => closeRing(ensureWinding(openRing(s.points), false)));
    const total = boundsOf(rings.length ? rings : [[[0, 0]]]);

    // ---- record content sizes ----
    // 4 (type) + 32 (box) + 4 (numParts) + 4 (numPoints) + 4*parts + 16*points
    const contentLengths = rings.map((r) => 44 + 4 * 1 + 16 * r.length);
    const shpSize = 100 + contentLengths.reduce((a, c) => a + 8 + c, 0);
    const shxSize = 100 + rings.length * 8;

    const shp = new Uint8Array(shpSize);
    const shx = new Uint8Array(shxSize);
    const shpV = new DataView(shp.buffer);
    const shxV = new DataView(shx.buffer);

    function writeHeader(view, sizeBytes) {
      view.setInt32(0, 9994, false);            // file code, big-endian
      for (let i = 4; i < 24; i += 4) view.setInt32(i, 0, false); // unused
      view.setInt32(24, sizeBytes / 2, false);  // length in 16-bit words
      view.setInt32(28, 1000, true);            // version, little-endian
      view.setInt32(32, SHP_POLYGON, true);
      view.setFloat64(36, total.xmin, true);
      view.setFloat64(44, total.ymin, true);
      view.setFloat64(52, total.xmax, true);
      view.setFloat64(60, total.ymax, true);
      view.setFloat64(68, 0, true); view.setFloat64(76, 0, true); // z range
      view.setFloat64(84, 0, true); view.setFloat64(92, 0, true); // m range
    }
    writeHeader(shpV, shpSize);
    writeHeader(shxV, shxSize);

    let off = 100;
    rings.forEach((ring, i) => {
      const content = contentLengths[i];
      shpV.setInt32(off, i + 1, false);        // record number, big-endian
      shpV.setInt32(off + 4, content / 2, false); // content length in words
      let p = off + 8;
      shpV.setInt32(p, SHP_POLYGON, true); p += 4;
      const b = boundsOf([ring]);
      shpV.setFloat64(p, b.xmin, true); p += 8;
      shpV.setFloat64(p, b.ymin, true); p += 8;
      shpV.setFloat64(p, b.xmax, true); p += 8;
      shpV.setFloat64(p, b.ymax, true); p += 8;
      shpV.setInt32(p, 1, true); p += 4;             // numParts
      shpV.setInt32(p, ring.length, true); p += 4;   // numPoints
      shpV.setInt32(p, 0, true); p += 4;             // part 0 starts at index 0
      for (const pt of ring) {
        shpV.setFloat64(p, pt[0], true); p += 8;
        shpV.setFloat64(p, pt[1], true); p += 8;
      }
      shxV.setInt32(100 + i * 8, off / 2, false);
      shxV.setInt32(100 + i * 8 + 4, content / 2, false);
      off += 8 + content;
    });

    // ---- DBF (dBASE III) ----
    const fields = [
      { name: 'PLOT_NO', type: 'C', size: 40 },
      { name: 'SHAPE_ID', type: 'C', size: 12 },
      { name: 'AREA_M2', type: 'N', size: 18, dec: 2 },
      { name: 'AREA_ACRE', type: 'N', size: 18, dec: 5 },
      { name: 'PERIM_M', type: 'N', size: 18, dec: 2 },
      { name: 'REC_AREA', type: 'C', size: 60 },
      { name: 'VERTICES', type: 'N', size: 8, dec: 0 },
      { name: 'GCP_TYPE', type: 'C', size: 14 },
      { name: 'VALID', type: 'C', size: 3 },
    ];
    const recordSize = 1 + fields.reduce((a, f) => a + f.size, 0);
    const headerSize = 32 + fields.length * 32 + 1;
    const dbf = new Uint8Array(headerSize + usable.length * recordSize + 1);
    const dv = new DataView(dbf.buffer);
    const now = new Date();
    dbf[0] = 0x03;
    dbf[1] = now.getFullYear() - 1900;
    dbf[2] = now.getMonth() + 1;
    dbf[3] = now.getDate();
    dv.setInt32(4, usable.length, true);
    dv.setInt16(8, headerSize, true);
    dv.setInt16(10, recordSize, true);
    let fp = 32;
    const ascii = (s, len) => {
      const out = new Uint8Array(len);
      const str = String(s).slice(0, len);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
      return out;
    };
    for (const f of fields) {
      dbf.set(ascii(f.name, 11), fp);
      dbf[fp + 11] = f.type.charCodeAt(0);
      dbf[fp + 16] = f.size;
      dbf[fp + 17] = f.dec || 0;
      fp += 32;
    }
    dbf[fp] = 0x0d;
    let rp = headerSize;
    usable.forEach((shape, i) => {
      dbf[rp] = 0x20; // not deleted
      let cp = rp + 1;
      const src = openRing(shape.points);
      const areaM2 = shape.computedAreaM2 != null ? shape.computedAreaM2 : gridArea(src);
      const v = validateRing(src);
      const vals = [
        shape.plotNo == null ? '' : String(shape.plotNo),
        String(shape.id == null ? i + 1 : shape.id),
        areaM2.toFixed(2),
        (areaM2 / M2_PER_ACRE).toFixed(5),
        perimeter(src).toFixed(2),
        shape.areaText || '',
        String(src.length),
        shape.lastGcpCorrection ? String(shape.lastGcpCorrection.type) : '',
        v.valid ? 'YES' : 'NO',
      ];
      fields.forEach((f, k) => {
        const raw = vals[k];
        // Character fields are left-aligned, numeric fields right-aligned.
        const padded = f.type === 'N'
          ? String(raw).slice(0, f.size).padStart(f.size, ' ')
          : String(raw).slice(0, f.size).padEnd(f.size, ' ');
        dbf.set(ascii(padded, f.size), cp);
        cp += f.size;
      });
      rp += recordSize;
    });
    dbf[dbf.length - 1] = 0x1a; // EOF marker

    return {
      shp, shx, dbf,
      prj: o.prjWkt || '',
      cpg: 'UTF-8',
      recordCount: usable.length,
      bounds: total,
    };
  }

  // Minimal WKT for the .prj sidecar. Without this, GIS software has to guess
  // the CRS, which is the exact class of error this release exists to remove.
  function prjWktFor(crs) {
    if (!crs) return '';
    if (crs.kind === 'geographic') {
      return 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
        'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    }
    if (crs.kind === 'webmercator') {
      return 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
        'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],' +
        'UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],' +
        'PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],' +
        'PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]';
    }
    if (crs.kind === 'utm') {
      const cm = (crs.zone - 1) * 6 - 180 + 3;
      const north = crs.north !== false;
      return `PROJCS["WGS 84 / UTM zone ${crs.zone}${north ? 'N' : 'S'}",` +
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
        'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
        'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],' +
        `PARAMETER["central_meridian",${cm}],PARAMETER["scale_factor",0.9996],` +
        `PARAMETER["false_easting",500000],PARAMETER["false_northing",${north ? 0 : 10000000}],` +
        'UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';
    }
    return '';
  }

  /* =====================================================================
   * ZIP (stored, no compression) — for KMZ and shapefile bundles.
   * =================================================================== */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  // Returns the raw bytes, so callers can wrap in a Blob (browser) or write to
  // disk (tests). Keeping Blob out of here is what makes it testable in Node.
  function makeZipBytes(files) {
    const locals = [], centrals = [];
    let offset = 0;
    const d = new Date();
    const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

    for (const f of files) {
      const nameBytes = utf8Encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : utf8Encode(String(f.data));
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); // UTF-8 name flag
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      locals.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centrals.push(central);
      offset += local.length + data.length;
    }

    const centralSize = centrals.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const totalLen = offset + centralSize + 22;
    const out = new Uint8Array(totalLen);
    let p = 0;
    for (const part of locals.concat(centrals, [end])) { out.set(part, p); p += part.length; }
    return out;
  }

  function shapefileZipBytes(shapes, opts) {
    const o = opts || {};
    const base = o.baseName || 'plots';
    const sf = shapefileFrom(shapes, o);
    const files = [
      { name: `${base}.shp`, data: sf.shp },
      { name: `${base}.shx`, data: sf.shx },
      { name: `${base}.dbf`, data: sf.dbf },
      { name: `${base}.cpg`, data: sf.cpg },
    ];
    if (sf.prj) files.push({ name: `${base}.prj`, data: sf.prj });
    return { bytes: makeZipBytes(files), recordCount: sf.recordCount };
  }

  return {
    gaussianRadiusAt,
    // escaping
    escapeXml, escapeHtml, escapeCsv, sanitizeDxfText,
    // ring geometry
    isClosed, closeRing, openRing, signedArea, gridArea, isCounterClockwise,
    ensureWinding, perimeter, centroidOfRing, boundsOf,
    // validity
    segmentsIntersect, findSelfIntersections, validateRing,
    // area
    geodesicArea, groundAreaFromGrid, formatAreaIndian, parseIndianAreaToM2,
    M2_PER_ACRE, M2_PER_DECIMAL, M2_PER_HECTARE, AUTHALIC_R,
    // writers
    makeDxf, makeKml, makeGeoJson, makeWkt, makeVertexCsv, makeAreaReportCsv,
    makeGcpPointsFile, parseGcpPointsFile,
    shapefileFrom, prjWktFor, shapefileZipBytes,
    crc32, utf8Encode, makeZipBytes,
  };
});
