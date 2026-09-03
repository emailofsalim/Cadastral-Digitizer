/* =========================================================================
 * Cadastral import readers — DXF, KML/KMZ, CSV vertices, GCP CSV.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Importers) or a CommonJS module. Pure:
 * no DOM, no map, no map adapter, so all of it is testable headlessly — the
 * same rule the rest of lib/ follows.
 *
 * WHAT THESE RETURN
 *
 * Every reader returns the same envelope:
 *
 *   { ok, rings: [{ points, plotNo, name, layer, attributes }],
 *     crs, crsSource, skipped: [{ what, why }], warnings: [] }
 *
 * `rings` are plain coordinate arrays in the file's own coordinate system.
 * The caller turns them into ordinary session shapes through the same
 * makeShape() a traced parcel uses, which is what makes imported geometry
 * editable, cleanable, correctable and exportable with no separate code path
 * (upgrade brief §23).
 *
 * THREE RULES THESE READERS FOLLOW
 *
 *  1. COORDINATES ARE CARRIED THROUGH UNTOUCHED. No rounding, no re-projection,
 *     no recentring. A cadastral import that quietly loses the last two decimal
 *     places of an easting has destroyed survey accuracy that cannot be
 *     recovered from the result. Absolute position is preserved so imported
 *     geometry lands on the map where it belongs, with no manual placement
 *     (brief §2, §16).
 *
 *  2. THE CRS IS NEVER GUESSED. A reader reports the CRS only where the format
 *     genuinely declares one: KML/KMZ is WGS 84 lon/lat by specification, and a
 *     DXF may carry an EPSG code. Otherwise `crs` is null and the caller must
 *     ask. This mirrors lib/crs.js, which refuses to invent a UTM zone for the
 *     same reason — the information is not in the numbers.
 *
 *  3. UNSUPPORTED CONTENT IS SKIPPED WITH A REASON, NEVER THROWN. A cadastral
 *     KMZ routinely carries ground overlays, styles, network links and 3D
 *     models. Refusing the whole file because of one unreadable placemark is
 *     the wrong trade when the other forty parcels are perfectly good, so each
 *     is recorded in `skipped` and reported (brief §18).
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Importers = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
    return isFinite(n) ? n : null;
  };

  function emptyResult() {
    return { ok: true, rings: [], crs: null, crsSource: null, skipped: [], warnings: [] };
  }

  /* A ring needs three distinct corners to bound any area at all. Closing
   * duplicates are dropped here so downstream vertex counts mean what they say;
   * the exporters close rings again themselves when a format requires it. */
  function tidyRing(pts) {
    const out = [];
    for (const p of pts) {
      if (!p || p.length < 2) continue;
      const x = num(p[0]); const y = num(p[1]);
      if (x === null || y === null) continue;
      const last = out[out.length - 1];
      if (last && last[0] === x && last[1] === y) continue;
      out.push([x, y]);
    }
    while (out.length > 1) {
      const a = out[0]; const b = out[out.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) out.pop(); else break;
    }
    return out;
  }

  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0]; const yi = ring[i][1];
      const xj = ring[j][0]; const yj = ring[j][1];
      if (((yi > p[1]) !== (yj > p[1])) &&
          (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* =====================================================================
   * DXF  (brief §16)
   * ---------------------------------------------------------------------
   * ASCII DXF is a flat stream of (group code, value) pairs on alternating
   * lines. That is genuinely all it is, which is why a reader for the entity
   * types cadastral drawings actually use is small and does not need a
   * third-party library.
   *
   * Read: LWPOLYLINE (10/20 pairs, 70 bit 1 = closed), POLYLINE/VERTEX/SEQEND
   * (the older form, still emitted by plenty of survey software), and LINE
   * runs. Layers are preserved on each ring. TEXT and MTEXT are collected and
   * matched to whichever ring contains them, which is how a plot number gets
   * onto its parcel — cadastral DXFs label parcels this way rather than with
   * attributes.
   *
   * Binary DXF and DWG are refused explicitly rather than producing garbage.
   * =================================================================== */
  function parseDxf(text) {
    const res = emptyResult();
    const src = String(text || '');

    if (/^AutoCAD Binary DXF/.test(src)) {
      return Object.assign(res, { ok: false, error: 'This is a binary DXF. Re-save it as ASCII DXF (R12 or later) and import again.' });
    }
    if (/^(AC10|MC02)/.test(src)) {
      return Object.assign(res, { ok: false, error: 'This is a DWG file, not a DXF. Export it as ASCII DXF and import again.' });
    }

    // Group codes and values alternate, one per line. \r is tolerated because
    // DXFs are overwhelmingly written on Windows.
    const lines = src.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (!isFinite(code)) continue;
      pairs.push([code, lines[i + 1]]);
    }
    if (!pairs.length) {
      return Object.assign(res, { ok: false, error: 'No DXF group codes found — this does not look like a DXF file.' });
    }

    // $INSBASE is how this project's own DXF export records the origin it
    // shifted by, so a round-trip through "shifted" mode comes back in place
    // instead of at the origin.
    let insbase = null;
    for (let i = 0; i < pairs.length - 1; i++) {
      if (pairs[i][0] === 9 && String(pairs[i][1]).trim() === '$INSBASE') {
        let x = null; let y = null;
        for (let j = i + 1; j < Math.min(i + 8, pairs.length); j++) {
          if (pairs[j][0] === 10) x = num(pairs[j][1]);
          if (pairs[j][0] === 20) y = num(pairs[j][1]);
        }
        if (x !== null && y !== null && (x !== 0 || y !== 0)) insbase = [x, y];
        break;
      }
    }

    const epsg = (src.match(/EPSG[:\s]*(\d{4,6})/i) || [])[1];
    if (epsg) { res.crs = { epsg: Number(epsg) }; res.crsSource = 'an EPSG code named in the DXF'; }

    const labels = [];
    const lineRuns = [];
    let entity = null;
    // The older POLYLINE form spreads its coordinates across child VERTEX
    // entities terminated by SEQEND, so the polyline stays open while they are
    // read. LWPOLYLINE carries its own, and never sets this.
    let openPoly = null;

    const flush = () => {
      if (!entity) return;
      if (entity.kind === 'text') {
        if (entity.at && entity.value) labels.push({ at: entity.at, value: entity.value, layer: entity.layer });
      } else if (entity.kind === 'line') {
        if (entity.a && entity.b) lineRuns.push({ a: entity.a, b: entity.b, layer: entity.layer });
      } else if (entity.kind === 'poly') {
        const ring = tidyRing(entity.points);
        // An unclosed 2-point polyline is a boundary segment, not a parcel;
        // it is picked up by the LINE-run joiner below instead of being
        // silently promoted to a degenerate "parcel".
        if (ring.length >= 3) {
          res.rings.push({
            points: ring,
            layer: entity.layer || '0',
            plotNo: null,
            name: entity.handle ? `DXF ${entity.handle}` : null,
            attributes: {},
            closed: !!entity.closed,
          });
        } else if (ring.length === 2) {
          lineRuns.push({ a: ring[0], b: ring[1], layer: entity.layer });
        } else if (entity.points.length) {
          res.skipped.push({ what: `${entity.type} on layer ${entity.layer || '0'}`, why: 'fewer than three distinct vertices' });
        }
      }
      entity = null;
    };

    for (let i = 0; i < pairs.length; i++) {
      const [code, rawVal] = pairs[i];
      const val = String(rawVal == null ? '' : rawVal).trim();

      if (code === 0) {
        // A VERTEX must not flush the POLYLINE it belongs to, and SEQEND is
        // exactly the marker that says the polyline is now complete.
        if (val === 'VERTEX' && openPoly) {
          entity = { kind: 'vertex', layer: openPoly.layer, pending: null };
          continue;
        }
        if (val === 'SEQEND' && openPoly) {
          entity = openPoly;
          openPoly = null;
          flush();
          continue;
        }
        flush();
        if (val === 'LWPOLYLINE') entity = { kind: 'poly', type: val, points: [], layer: '0', closed: false, pending: null };
        else if (val === 'POLYLINE') {
          openPoly = { kind: 'poly', type: val, points: [], layer: '0', closed: false, pending: null, old: true };
          entity = openPoly;
        } else if (val === 'VERTEX') entity = null;
        else if (val === 'SEQEND') entity = null;
        else if (val === 'LINE') entity = { kind: 'line', layer: '0', a: null, b: null };
        else if (val === 'TEXT' || val === 'MTEXT') entity = { kind: 'text', layer: '0', at: null, value: '' };
        else if (val === 'CIRCLE' || val === 'ARC' || val === 'SPLINE' || val === 'ELLIPSE') {
          res.skipped.push({ what: val, why: 'curved entities have no cadastral vertex list' });
          entity = null;
        } else entity = null;
        continue;
      }
      if (!entity) continue;

      if (code === 8) { entity.layer = val || '0'; continue; }
      if (code === 5 && entity.kind === 'poly') { entity.handle = val; continue; }

      if (entity.kind === 'poly' && !entity.old) {
        // LWPOLYLINE: an x always precedes its y, so a 10 opens a vertex and
        // the matching 20 closes it. Bulge (42) is ignored deliberately —
        // approximating an arc would invent vertices that are not survey data.
        if (code === 10) { entity.pending = [num(val), null]; continue; }
        if (code === 20 && entity.pending) { entity.pending[1] = num(val); entity.points.push(entity.pending); entity.pending = null; continue; }
        if (code === 70) { entity.closed = (parseInt(val, 10) & 1) === 1; continue; }
      } else if (entity.kind === 'poly' && entity.old) {
        if (code === 70) { entity.closed = (parseInt(val, 10) & 1) === 1; continue; }
      } else if (entity.kind === 'vertex') {
        if (code === 10) { entity.pending = [num(val), null]; continue; }
        if (code === 20 && entity.pending) {
          entity.pending[1] = num(val);
          // Walk back to the POLYLINE this VERTEX belongs to. The parser keeps
          // it on `openPoly` rather than re-scanning.
          if (openPoly) openPoly.points.push(entity.pending);
          entity.pending = null;
          continue;
        }
      } else if (entity.kind === 'line') {
        if (code === 10) entity.a = [num(val), entity.a ? entity.a[1] : null];
        else if (code === 20 && entity.a) entity.a[1] = num(val);
        else if (code === 11) entity.b = [num(val), entity.b ? entity.b[1] : null];
        else if (code === 21 && entity.b) entity.b[1] = num(val);
        continue;
      } else if (entity.kind === 'text') {
        if (code === 10) entity.at = [num(val), entity.at ? entity.at[1] : null];
        else if (code === 20 && entity.at) entity.at[1] = num(val);
        else if (code === 1) entity.value = String(rawVal == null ? '' : rawVal).trim();
        continue;
      }
    }
    if (entity && entity.kind === 'vertex') entity = null;
    flush();
    // A POLYLINE whose SEQEND is missing — truncated file, or a writer that
    // omits it — still holds real vertices, so it is completed rather than lost.
    if (openPoly) { entity = openPoly; openPoly = null; flush(); }

    // LINE runs joined end-to-end into rings. Cadastral DXFs from older
    // software describe a parcel as a set of separate LINE entities rather
    // than one polyline, and dropping those would lose most of the drawing.
    for (const ring of joinLineRuns(lineRuns)) res.rings.push(ring);

    // A plot number sitting inside a ring belongs to that parcel. This is how
    // cadastral DXFs label parcels; there is no attribute to read.
    for (const label of labels) {
      if (!label.at || label.at[0] === null || label.at[1] === null) continue;
      for (const r of res.rings) {
        if (r.plotNo == null && pointInRing(label.at, r.points)) { r.plotNo = label.value; break; }
      }
    }

    if (insbase) {
      res.warnings.push(`This DXF records an origin shift of ${insbase[0]}, ${insbase[1]} in $INSBASE. Coordinates were imported exactly as written; if the drawing was exported in "shifted" mode, add that origin back.`);
    }
    if (!res.rings.length) {
      res.ok = false;
      res.error = 'No closed polylines, polygons or joinable line runs were found in this DXF.';
    }
    return res;
  }

  /* Join LINE entities into closed rings by walking shared endpoints. The
   * tolerance is absolute-zero equality first, then a small snap, because a
   * drawing written by one package and read by another routinely disagrees in
   * the last decimal place. */
  function joinLineRuns(runs, tol) {
    const t = tol == null ? 1e-6 : tol;
    const same = (a, b) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t;
    const byLayer = new Map();
    for (const r of runs) {
      if (!r.a || !r.b || r.a[0] === null || r.a[1] === null || r.b[0] === null || r.b[1] === null) continue;
      const k = r.layer || '0';
      if (!byLayer.has(k)) byLayer.set(k, []);
      byLayer.get(k).push(r);
    }
    const rings = [];
    for (const [layer, segs] of byLayer) {
      const used = new Array(segs.length).fill(false);
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        const chain = [segs[i].a.slice(), segs[i].b.slice()];
        let grew = true;
        while (grew) {
          grew = false;
          for (let j = 0; j < segs.length; j++) {
            if (used[j]) continue;
            const head = chain[0]; const tail = chain[chain.length - 1];
            if (same(tail, segs[j].a)) { chain.push(segs[j].b.slice()); used[j] = true; grew = true; }
            else if (same(tail, segs[j].b)) { chain.push(segs[j].a.slice()); used[j] = true; grew = true; }
            else if (same(head, segs[j].b)) { chain.unshift(segs[j].a.slice()); used[j] = true; grew = true; }
            else if (same(head, segs[j].a)) { chain.unshift(segs[j].b.slice()); used[j] = true; grew = true; }
          }
        }
        // Only a chain that closes on itself is a parcel. An open chain is a
        // road centreline or a stray boundary segment, and turning it into a
        // polygon would invent an area that is not in the drawing.
        if (chain.length >= 4 && same(chain[0], chain[chain.length - 1])) {
          const ring = tidyRing(chain);
          if (ring.length >= 3) rings.push({ points: ring, layer, plotNo: null, name: null, attributes: {}, closed: true });
        }
      }
    }
    return rings;
  }

  /* =====================================================================
   * KML / KMZ  (brief §18)
   * ---------------------------------------------------------------------
   * KML coordinates are lon,lat[,alt] triples separated by whitespace, and the
   * CRS is WGS 84 by specification — the one format here whose coordinate
   * system is genuinely known rather than guessed.
   *
   * Parsed with regex rather than DOMParser so the reader stays pure and
   * testable in Node. KML's grammar for the parts that matter is regular
   * enough for this to be sound, and the alternative would put the reader
   * behind a DOM the rest of lib/ deliberately does without.
   * =================================================================== */
  function decodeXmlEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&');
  }

  function parseKmlCoordinates(text) {
    const pts = [];
    const tokens = String(text || '').trim().split(/\s+/);
    for (const tok of tokens) {
      if (!tok) continue;
      const bits = tok.split(',');
      if (bits.length < 2) continue;
      const x = num(bits[0]); const y = num(bits[1]);
      if (x === null || y === null) continue;
      pts.push([x, y]);
    }
    return pts;
  }

  function parseKml(text) {
    const res = emptyResult();
    const src = String(text || '');
    if (!/<\s*kml|<\s*Placemark|<\s*Document|<\s*Folder/i.test(src)) {
      return Object.assign(res, { ok: false, error: 'This does not look like KML. If it is a KMZ, import it as KMZ.' });
    }
    // KML is lon/lat on WGS 84 by specification — not a guess.
    res.crs = { kind: 'geographic', datum: 'WGS84', epsg: 4326 };
    res.crsSource = 'the KML specification (WGS 84 lon/lat)';

    const placemarks = src.match(/<Placemark\b[\s\S]*?<\/Placemark>/gi) || [];
    if (!placemarks.length) {
      // Some exports put a bare Polygon outside any Placemark.
      const loose = src.match(/<Polygon\b[\s\S]*?<\/Polygon>/gi) || [];
      for (const poly of loose) collectPolygon(poly, {}, res, 'unnamed');
      if (!res.rings.length) return Object.assign(res, { ok: false, error: 'No placemarks or polygons found in this KML.' });
      return res;
    }

    for (const pm of placemarks) {
      const name = decodeXmlEntities((pm.match(/<name>([\s\S]*?)<\/name>/i) || [])[1] || '').trim();
      const desc = decodeXmlEntities((pm.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '').trim();

      const attributes = {};
      // <ExtendedData><Data name="x"><value>y</value></Data></ExtendedData>
      const dataRe = /<Data\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/Data>/gi;
      let m;
      while ((m = dataRe.exec(pm))) attributes[decodeXmlEntities(m[1])] = decodeXmlEntities(m[2]).trim();
      // <SimpleData name="x">y</SimpleData>, the schema-typed form
      const simpleRe = /<SimpleData\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/SimpleData>/gi;
      while ((m = simpleRe.exec(pm))) attributes[decodeXmlEntities(m[1])] = decodeXmlEntities(m[2]).trim();

      const styleUrl = ((pm.match(/<styleUrl>([\s\S]*?)<\/styleUrl>/i) || [])[1] || '').trim();

      const polys = pm.match(/<Polygon\b[\s\S]*?<\/Polygon>/gi) || [];
      if (polys.length) {
        for (const poly of polys) collectPolygon(poly, { name, desc, attributes, styleUrl }, res, name || 'unnamed');
        continue;
      }
      // A LinearRing outside a Polygon is unusual but readable, and a boundary
      // is a boundary.
      const rings = pm.match(/<LinearRing\b[\s\S]*?<\/LinearRing>/gi) || [];
      if (rings.length) {
        for (const r of rings) {
          const coords = (r.match(/<coordinates>([\s\S]*?)<\/coordinates>/i) || [])[1];
          pushRing(parseKmlCoordinates(coords), { name, desc, attributes, styleUrl }, res, name || 'unnamed');
        }
        continue;
      }
      const kind = (pm.match(/<(Point|LineString|Model|GroundOverlay|NetworkLink|Track)\b/i) || [])[1];
      res.skipped.push({
        what: name ? `"${name}"` : (kind || 'a placemark'),
        why: kind ? `${kind} carries no parcel boundary` : 'no polygon geometry',
      });
    }

    if (!res.rings.length) {
      res.ok = false;
      res.error = `No parcel boundaries found. ${res.skipped.length} placemark(s) held no polygon geometry.`;
    }
    return res;
  }

  function collectPolygon(polyXml, meta, res, label) {
    // Only the outer boundary describes the parcel. Inner boundaries are holes
    // and are recorded as skipped rather than silently flattened into the
    // outline, which would make a doughnut plot export as a solid one.
    const outer = polyXml.match(/<outerBoundaryIs>[\s\S]*?<\/outerBoundaryIs>/i);
    const source = outer ? outer[0] : polyXml;
    const coords = (source.match(/<coordinates>([\s\S]*?)<\/coordinates>/i) || [])[1];
    pushRing(parseKmlCoordinates(coords), meta, res, label);
    const inners = polyXml.match(/<innerBoundaryIs>/gi);
    if (inners) res.skipped.push({ what: `${inners.length} inner ring(s) of "${label}"`, why: 'holes are not represented in this session model' });
  }

  function pushRing(pts, meta, res, label) {
    const ring = tidyRing(pts);
    if (ring.length < 3) {
      res.skipped.push({ what: `"${label}"`, why: 'fewer than three distinct vertices' });
      return;
    }
    const attrs = (meta && meta.attributes) || {};
    // A plot number is worth looking for under the names cadastral exports
    // actually use, before falling back to the placemark name.
    const plotKey = Object.keys(attrs).find((k) => /^(plot|khasra|survey|parcel|kide|gata)[_ ]?(no|number|num)?$/i.test(k));
    res.rings.push({
      points: ring,
      plotNo: plotKey ? attrs[plotKey] : ((meta && meta.name) || null),
      name: (meta && meta.name) || null,
      description: (meta && meta.desc) || null,
      layer: (meta && meta.styleUrl) ? String(meta.styleUrl).replace(/^#/, '') : 'KML',
      attributes: attrs,
      closed: true,
    });
  }

  /* ---- KMZ -----------------------------------------------------------
   * A KMZ is a ZIP holding a KML. Entries are read from the central directory
   * rather than by scanning for local headers, because a local header may
   * carry zero sizes with the real ones in a trailing data descriptor.
   *
   * Stored (method 0) entries are returned synchronously. Deflated (method 8)
   * ones go through DecompressionStream('deflate-raw'), which Chrome and Node
   * both provide — so a KMZ is readable without bundling an inflate
   * implementation that could not be tested here.
   * ------------------------------------------------------------------- */
  function readZipEntries(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // Find the end-of-central-directory record, scanning back over the comment.
    let eocd = -1;
    const minEocd = 22;
    for (let i = u8.length - minEocd; i >= 0 && i >= u8.length - minEocd - 65535; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, error: 'Not a ZIP/KMZ archive (no end-of-central-directory record).' };

    const count = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count && ptr + 46 <= u8.length; n++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) break;
      const method = dv.getUint16(ptr + 10, true);
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = dv.getUint32(ptr + 42, true);
      const name = utf8Decode(u8.subarray(ptr + 46, ptr + 46 + nameLen));

      // The local header's own name/extra lengths are authoritative for where
      // the data starts; the central directory's may differ.
      if (localOff + 30 <= u8.length && dv.getUint32(localOff, true) === 0x04034b50) {
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        entries.push({ name, method, data: u8.subarray(dataStart, dataStart + compSize) });
      }
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return { ok: true, entries };
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot decompress the KMZ. Unzip it and import the .kml inside.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* Pull the KML document out of a KMZ. Async because inflation is. */
  async function extractKmlFromKmz(bytes) {
    const zip = readZipEntries(bytes);
    if (!zip.ok) return { ok: false, error: zip.error };
    // doc.kml by convention, but the specification only requires that the
    // first .kml encountered is the document, so accept either.
    const candidates = zip.entries.filter((e) => /\.kml$/i.test(e.name));
    if (!candidates.length) return { ok: false, error: 'No .kml file inside this KMZ.' };
    const chosen = candidates.find((e) => /(^|\/)doc\.kml$/i.test(e.name)) || candidates[0];
    let raw;
    if (chosen.method === 0) raw = chosen.data;
    else if (chosen.method === 8) raw = await inflateRaw(chosen.data);
    else return { ok: false, error: `The KML inside this KMZ uses compression method ${chosen.method}, which is not supported. Unzip it and import the .kml.` };
    const others = zip.entries.filter((e) => e !== chosen && !/\/$/.test(e.name));
    return { ok: true, kml: utf8Decode(raw), entryName: chosen.name, otherEntries: others.map((e) => e.name) };
  }

  async function parseKmz(bytes) {
    const got = await extractKmlFromKmz(bytes);
    if (!got.ok) return Object.assign(emptyResult(), { ok: false, error: got.error });
    const res = parseKml(got.kml);
    // Images and styles inside a KMZ are not parcel geometry, but saying they
    // were left behind is more useful than silence.
    const assets = (got.otherEntries || []).filter((n) => !/\.kml$/i.test(n));
    if (assets.length) res.skipped.push({ what: `${assets.length} non-KML file(s) in the KMZ`, why: 'images, styles and overlays carry no parcel geometry' });
    return res;
  }

  /* =====================================================================
   * CSV — delimiter sniffing, preview and column mapping
   * ---------------------------------------------------------------------
   * Shared by CSV vertex import (brief §17) and GCP CSV import (brief §6).
   * Both need the same thing: show the operator what the file actually
   * contains and let them say which column is which, rather than assuming a
   * layout and being wrong in a way that puts a parcel in the wrong district.
   * =================================================================== */
  const DELIMITERS = [
    { value: ',', label: 'Comma  ,' },
    { value: ';', label: 'Semicolon  ;' },
    { value: '\t', label: 'Tab' },
    { value: ' ', label: 'Space' },
    { value: '|', label: 'Pipe  |' },
  ];

  function sniffDelimiter(text) {
    const lines = String(text || '').split(/\r\n|\r|\n/).filter((l) => l.trim() && !/^\s*[#;]/.test(l)).slice(0, 20);
    if (!lines.length) return ',';
    let best = ','; let bestScore = -1;
    for (const d of DELIMITERS) {
      const counts = lines.map((l) => splitCsvLine(l, d.value).length);
      const first = counts[0];
      if (first < 2) continue;
      // A real delimiter gives the same field count on every line. Consistency
      // matters more than raw count: a decimal comma in a semicolon file would
      // otherwise win on count alone.
      const consistent = counts.filter((c) => c === first).length / counts.length;
      const score = consistent * 100 + Math.min(first, 12);
      if (score > bestScore) { bestScore = score; best = d.value; }
    }
    return best;
  }

  /* Quote-aware split. Survey CSVs carry owner names and remarks with commas
   * in them, and a naive split shifts every later column by one. */
  function splitCsvLine(line, delim) {
    const d = delim || ',';
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
        } else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === d) { out.push(cur); cur = ''; }
      else if (d === ' ' && /\s/.test(ch)) {
        if (cur !== '') { out.push(cur); cur = ''; }
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function looksLikeHeader(fields) {
    if (!fields || !fields.length) return false;
    // A header row is one where the coordinate columns are not numbers.
    const numeric = fields.filter((f) => f !== '' && num(f) !== null).length;
    return numeric <= Math.floor(fields.length / 3);
  }

  /* Read a CSV into { delimiter, header, rows, columns } for the preview
   * dialog. Nothing is imported at this stage — the operator confirms first
   * (brief §6: "Only import after the user confirms the format"). */
  function previewCsv(text, opts) {
    const o = opts || {};
    const delimiter = o.delimiter || sniffDelimiter(text);
    const all = String(text || '').split(/\r\n|\r|\n/);
    const dataLines = [];
    for (const raw of all) {
      if (!raw.trim()) continue;
      if (/^\s*[#]/.test(raw)) continue;               // comment
      dataLines.push(raw);
    }
    if (!dataLines.length) return { ok: false, error: 'The file has no data rows.' };

    const first = splitCsvLine(dataLines[0], delimiter);
    const hasHeader = o.hasHeader != null ? !!o.hasHeader : looksLikeHeader(first);
    const header = hasHeader ? first : first.map((_, i) => `Column ${i + 1}`);
    const body = hasHeader ? dataLines.slice(1) : dataLines;
    const rows = body.map((l) => splitCsvLine(l, delimiter));

    const width = Math.max(header.length, ...rows.slice(0, 50).map((r) => r.length));
    while (header.length < width) header.push(`Column ${header.length + 1}`);

    return {
      ok: true, delimiter, hasHeader, header, rows,
      columns: header.map((name, index) => ({ index, name })),
      rowCount: rows.length,
      sample: rows.slice(0, Math.max(1, o.sampleRows || 8)),
      suggestion: suggestMapping(header, rows),
    };
  }

  /* The four layouts the brief names, plus the general case. Detection is by
   * header text where there is a header, and by magnitude where there is not:
   * a value in [-180,180] paired with one in [-90,90] is lon/lat, and six- or
   * seven-figure values are a projected easting/northing. That distinction is
   * safe because the ranges are disjoint — the same argument lib/crs.js makes
   * for detecting the CRS *family* but not the zone. */
  const ROLE_PATTERNS = [
    { role: 'id', re: /^(id|point|pt|pt_?id|name|no|sr|serial|vertex|corner|plot|khasra|survey|parcel)/i },
    { role: 'x', re: /^(x|east|easting|e|lon|long|longitude)\b/i },
    { role: 'y', re: /^(y|north|northing|n|lat|latitude)\b/i },
    { role: 'z', re: /^(z|elev|elevation|height|ht|alt|altitude|rl)\b/i },
  ];

  function suggestMapping(header, rows) {
    const map = { id: null, x: null, y: null, z: null, isLonLat: false };
    const used = new Set();

    // Longitude and latitude need matching before the generic x/y patterns, or
    // "lat" would be taken as a y and "lon" as an x with no note that these are
    // geographic — which decides whether the numbers are degrees or metres.
    header.forEach((h, i) => {
      if (/^(lon|long|longitude)\b/i.test(h) && map.x === null) { map.x = i; map.isLonLat = true; used.add(i); }
      if (/^(lat|latitude)\b/i.test(h) && map.y === null) { map.y = i; map.isLonLat = true; used.add(i); }
    });
    for (const { role, re } of ROLE_PATTERNS) {
      if (map[role] !== null && map[role] !== undefined) continue;
      const i = header.findIndex((h, idx) => !used.has(idx) && re.test(String(h).trim()));
      if (i >= 0) { map[role] = i; used.add(i); }
    }

    // No usable header: fall back to position and magnitude.
    const numericCols = [];
    const probe = rows.slice(0, 25);
    const width = Math.max(...probe.map((r) => r.length), header.length);
    for (let c = 0; c < width; c++) {
      const vals = probe.map((r) => num(r[c])).filter((v) => v !== null);
      if (vals.length >= Math.max(1, Math.floor(probe.length * 0.6))) {
        numericCols.push({ index: c, max: Math.max(...vals.map(Math.abs)) });
      }
    }
    if (map.x === null || map.y === null) {
      const free = numericCols.filter((c) => !used.has(c.index));
      if (free.length >= 2) {
        if (map.x === null) { map.x = free[0].index; used.add(free[0].index); }
        const rest = free.filter((c) => c.index !== map.x);
        if (map.y === null && rest.length) { map.y = rest[0].index; used.add(rest[0].index); }
      }
      const xc = numericCols.find((c) => c.index === map.x);
      const yc = numericCols.find((c) => c.index === map.y);
      if (xc && yc && xc.max <= 180 && yc.max <= 90) map.isLonLat = true;
    }
    if (map.id === null) {
      const nonNumeric = header.map((_, i) => i).find((i) => !used.has(i) && !numericCols.some((c) => c.index === i));
      if (nonNumeric !== undefined) map.id = nonNumeric;
    }
    return map;
  }

  const CSV_FORMATS = [
    { key: 'auto', label: 'Auto detect', mapping: null },
    { key: 'id_e_n_z', label: 'ID, Easting, Northing, Elevation', mapping: { id: 0, x: 1, y: 2, z: 3, isLonLat: false } },
    { key: 'id_x_y_z', label: 'ID, X, Y, Z', mapping: { id: 0, x: 1, y: 2, z: 3, isLonLat: false } },
    { key: 'id_lat_lon_z', label: 'ID, Latitude, Longitude, Elevation', mapping: { id: 0, x: 2, y: 1, z: 3, isLonLat: true } },
    { key: 'id_x_y', label: 'ID, X, Y', mapping: { id: 0, x: 1, y: 2, z: null, isLonLat: false } },
    { key: 'custom', label: 'Custom column mapping', mapping: null },
  ];

  /* =====================================================================
   * CSV VERTICES -> RINGS  (brief §17)
   * ---------------------------------------------------------------------
   * Rows are grouped by the id column so one file can carry many parcels, which
   * is how a survey point list actually arrives. Where the id is per-vertex
   * rather than per-parcel (1,2,3,4...) every row lands in one ring, which is
   * the other common case; a `groupBy` column can be named explicitly when the
   * file has both.
   * =================================================================== */
  function ringsFromCsv(preview, mapping, opts) {
    const o = opts || {};
    const res = emptyResult();
    if (!preview || !preview.ok) return Object.assign(res, { ok: false, error: 'Nothing to import.' });
    const m = mapping || preview.suggestion;
    if (!m || m.x === null || m.y === null || m.x === undefined || m.y === undefined) {
      return Object.assign(res, { ok: false, error: 'Say which columns hold the X/Easting and Y/Northing values.' });
    }

    const groupCol = o.groupBy != null ? o.groupBy : (o.groupByParcel === false ? null : m.id);
    const groups = new Map();
    let bad = 0;

    preview.rows.forEach((row, i) => {
      const x = num(row[m.x]);
      const y = num(row[m.y]);
      if (x === null || y === null) { bad++; return; }
      // A lat/lon mapping names the columns by meaning, and the ring is stored
      // x-first (lon, lat) to match every other coordinate in this program.
      const pt = [x, y];
      const key = groupCol != null && row[groupCol] !== undefined && String(row[groupCol]).trim() !== ''
        ? String(row[groupCol]).trim()
        : '__all__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ pt, row: i, z: m.z != null ? num(row[m.z]) : null });
    });

    if (bad) res.skipped.push({ what: `${bad} row(s)`, why: 'the X or Y column did not hold a number' });

    // A group of one or two points is a survey mark, not a parcel. If EVERY
    // group is that small the id column was per-vertex, so regroup as one ring
    // rather than reporting that nothing could be imported.
    const sizes = [...groups.values()].map((g) => g.length);
    const allTiny = sizes.length > 2 && sizes.every((s) => s < 3);
    if (allTiny) {
      const flat = [];
      for (const g of groups.values()) for (const e of g) flat.push(e);
      groups.clear();
      groups.set('__all__', flat);
      res.warnings.push('The ID column held a different value on every row, so it names vertices rather than parcels. All points were read as one boundary — set "Group rows into parcels by" to a parcel column if that is wrong.');
    }

    for (const [key, entries] of groups) {
      const ring = tidyRing(entries.map((e) => e.pt));
      if (ring.length < 3) {
        res.skipped.push({ what: key === '__all__' ? 'the point list' : `parcel "${key}"`, why: `only ${ring.length} distinct vertex(es) — a boundary needs three` });
        continue;
      }
      res.rings.push({
        points: ring,
        plotNo: key === '__all__' ? null : key,
        name: key === '__all__' ? null : key,
        layer: 'CSV',
        attributes: {},
        closed: true,
      });
    }

    if (m.isLonLat) {
      res.crs = { kind: 'geographic', datum: 'WGS84', epsg: 4326 };
      res.crsSource = 'the latitude/longitude columns you mapped';
    }
    if (!res.rings.length) {
      res.ok = false;
      res.error = res.skipped.length
        ? `No parcel could be formed. ${res.skipped.map((s) => `${s.what}: ${s.why}`).join('; ')}`
        : 'No usable coordinates in that file.';
    }
    return res;
  }

  /* =====================================================================
   * GCP CSV -> PAIRS  (brief §6)
   * ---------------------------------------------------------------------
   * A control point pairs a source coordinate (where the geometry says the
   * corner is) with a target (where it really is). Two shapes of file are in
   * use: the QGIS .points four-column form, which lib/exporters.js already
   * reads and writes, and a plain survey list of true positions.
   *
   * The QGIS path is delegated to the existing parser rather than
   * reimplemented — the brief's §6 says to retain existing functionality, and
   * a second parser for the same format is how two readers drift apart.
   * =================================================================== */
  function looksLikeQgisPoints(text) {
    const head = String(text || '').split(/\r\n|\r|\n/).slice(0, 3).join('\n');
    return /mapX\s*,\s*mapY\s*,\s*(pixelX|sourceX)/i.test(head) || /^#\s*Georeferencer/i.test(head);
  }

  function gcpsFromCsv(preview, mapping, opts) {
    const o = opts || {};
    const m = mapping || (preview && preview.suggestion);
    const out = { ok: true, pairs: [], skipped: [], warnings: [] };
    if (!preview || !preview.ok) return { ok: false, error: 'Nothing to import.', pairs: [], skipped: [] };
    if (!m || m.x == null || m.y == null) {
      return { ok: false, error: 'Say which columns hold the X/Easting and Y/Northing values.', pairs: [], skipped: [] };
    }
    // Where the file also carries the source ("as digitized") coordinate, both
    // halves of the pair come from the file. Where it does not, the row states
    // only the true position and the caller must attach it to a vertex — the
    // same distinction the existing two-step pairing makes.
    const hasSource = o.sourceX != null && o.sourceY != null;
    let bad = 0;
    preview.rows.forEach((row, i) => {
      const tx = num(row[m.x]); const ty = num(row[m.y]);
      if (tx === null || ty === null) { bad++; return; }
      const pair = {
        id: m.id != null && row[m.id] !== undefined ? String(row[m.id]).trim() : String(i + 1),
        confirmedPoint: [tx, ty],
        rawPoint: null,
        elevation: m.z != null ? num(row[m.z]) : null,
        enabled: true,
      };
      if (hasSource) {
        const sx = num(row[o.sourceX]); const sy = num(row[o.sourceY]);
        if (sx !== null && sy !== null) pair.rawPoint = [sx, sy];
      }
      out.pairs.push(pair);
    });
    if (bad) out.skipped.push({ what: `${bad} row(s)`, why: 'the coordinate columns did not hold numbers' });
    if (!out.pairs.length) { out.ok = false; out.error = 'No usable control points in that file.'; }
    out.isLonLat = !!m.isLonLat;
    out.hasSource = hasSource;
    return out;
  }

  /* =====================================================================
   * FORMAT DISPATCH
   * =================================================================== */
  const FORMATS = [
    { key: 'project', label: 'Project JSON', accept: '.json', binary: false },
    { key: 'kmz', label: 'KMZ / KML', accept: '.kmz,.kml', binary: 'maybe' },
    { key: 'dxf', label: 'DXF', accept: '.dxf', binary: false },
    { key: 'csv', label: 'CSV vertices', accept: '.csv,.txt', binary: false },
    { key: 'geojson', label: 'GeoJSON', accept: '.geojson,.json', binary: false },
    { key: 'gcps', label: 'GCP / control points', accept: '.points,.csv,.txt', binary: false },
  ];

  function formatFromFilename(name) {
    const n = String(name || '').toLowerCase();
    if (/\.kmz$/.test(n)) return 'kmz';
    if (/\.kml$/.test(n)) return 'kml';
    if (/\.dxf$/.test(n)) return 'dxf';
    if (/\.geojson$/.test(n)) return 'geojson';
    if (/\.points$/.test(n)) return 'gcps';
    if (/\.csv$|\.txt$/.test(n)) return 'csv';
    if (/\.json$/.test(n)) return 'json';
    return null;
  }

  /* GeoJSON is not in the brief's import list, but this project exports it and
   * a format it writes and cannot read back is a gap the operator will find. */
  function parseGeoJson(text) {
    const res = emptyResult();
    const data = (() => { try { return JSON.parse(String(text || '')); } catch (e) { return null; } })();
    if (!data || typeof data !== 'object') return Object.assign(res, { ok: false, error: 'That file is not valid JSON.' });
    // RFC 7946 fixes the CRS as WGS 84 lon/lat.
    res.crs = { kind: 'geographic', datum: 'WGS84', epsg: 4326 };
    res.crsSource = 'the GeoJSON specification (RFC 7946, WGS 84 lon/lat)';

    const features = data.type === 'FeatureCollection' ? (data.features || [])
      : data.type === 'Feature' ? [data]
        : data.type ? [{ type: 'Feature', geometry: data, properties: {} }] : [];
    if (!features.length) return Object.assign(res, { ok: false, error: 'No GeoJSON features found.' });

    for (const f of features) {
      const g = f && f.geometry;
      const props = (f && f.properties) || {};
      if (!g) { res.skipped.push({ what: 'a feature', why: 'no geometry' }); continue; }
      const polys = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : null;
      if (!polys) { res.skipped.push({ what: g.type || 'a feature', why: 'not a polygon' }); continue; }
      for (const poly of polys) {
        if (!poly || !poly.length) continue;
        const ring = tidyRing(poly[0]);
        if (ring.length < 3) { res.skipped.push({ what: 'a ring', why: 'fewer than three distinct vertices' }); continue; }
        if (poly.length > 1) res.skipped.push({ what: `${poly.length - 1} inner ring(s)`, why: 'holes are not represented in this session model' });
        const plotKey = Object.keys(props).find((k) => /^(plot|khasra|survey|parcel)[_ ]?(no|number)?$/i.test(k));
        res.rings.push({
          points: ring,
          plotNo: plotKey ? props[plotKey] : (props.plot_no != null ? props.plot_no : null),
          name: props.name != null ? props.name : null,
          layer: 'GeoJSON',
          attributes: props,
          closed: true,
        });
      }
    }
    if (!res.rings.length) { res.ok = false; res.error = 'No polygon features found in that GeoJSON.'; }
    return res;
  }

  return {
    // rings + envelope
    tidyRing, pointInRing,
    // DXF
    parseDxf, joinLineRuns,
    // KML / KMZ
    parseKml, parseKmz, parseKmlCoordinates, decodeXmlEntities,
    readZipEntries, extractKmlFromKmz, inflateRaw,
    // GeoJSON
    parseGeoJson,
    // CSV
    DELIMITERS, CSV_FORMATS, sniffDelimiter, splitCsvLine, looksLikeHeader,
    previewCsv, suggestMapping, ringsFromCsv, gcpsFromCsv, looksLikeQgisPoints,
    // dispatch
    FORMATS, formatFromFilename,
  };
});
