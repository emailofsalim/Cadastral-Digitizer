/* =========================================================================
 * ESRI Shapefile reader — .shp / .dbf / .prj, and the ZIP they arrive in.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Shapefile) or a CommonJS module.
 *
 * WHY THIS IS HAND-WRITTEN
 *
 * The same reason lib/exporters.js WRITES the format by hand: it is simple,
 * and pulling in a dependency for it would mean bundling and a build step that
 * this project deliberately does not have. Mixed endianness is the only real
 * trap — file and record headers are big-endian, everything inside a record is
 * little-endian — and the writer in exporters.js already documents it.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not project anything, and it does not decide what a coordinate
 * means. A .prj is read only far enough to recover an EPSG code, which is then
 * handed to the caller's OWN CRS engine through `opts.parseEpsg`. Where the
 * code cannot be recovered the CRS is left NULL rather than assumed, and the
 * application's existing "which system is this file in?" question handles it.
 * Silently assuming WGS 84 would put a cadastral parcel in the wrong district
 * with nothing downstream noticing.
 *
 * It also produces the SAME result envelope as lib/importers.js —
 * { ok, rings, crs, crsSource, skipped, warnings } — so a shapefile reaches
 * the workspace through exactly the path a DXF or a KML already takes. No new
 * geometry model, no second renderer, no separate editor.
 * ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Shapefile = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const safe = (fn, fb) => { try { return fn(); } catch (e) { return fb === undefined ? null : fb; } };

  /* Shape type codes. The Z and M variants carry extra trailing arrays which
   * are simply not read: the X/Y prefix of every record is laid out
   * identically, so a PolygonZ reads as a Polygon and its elevations are
   * ignored rather than misinterpreted. */
  const NULL_SHAPE = 0;
  const POINT = 1, POLYLINE = 3, POLYGON = 5, MULTIPOINT = 8;
  const baseType = (t) => {
    if (t === 11 || t === 21) return POINT;
    if (t === 13 || t === 23) return POLYLINE;
    if (t === 15 || t === 25) return POLYGON;
    if (t === 18 || t === 28) return MULTIPOINT;
    return t;
  };
  const TYPE_NAMES = {
    0: 'Null', 1: 'Point', 3: 'Polyline', 5: 'Polygon', 8: 'MultiPoint',
    11: 'PointZ', 13: 'PolylineZ', 15: 'PolygonZ', 18: 'MultiPointZ',
    21: 'PointM', 23: 'PolylineM', 25: 'PolygonM', 28: 'MultiPointM',
  };

  const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

  /* Ring orientation is what tells an outer boundary from a hole in this
   * format: clockwise is outer, counter-clockwise is a hole. This is a winding
   * test, not a geometry engine — the sum is only ever compared with zero.
   *
   * Accumulated about the first vertex because cadastral coordinates are
   * routinely in the millions: at UTM magnitudes the raw cross products reach
   * 1e12 while their sum is the small number actually wanted, and the
   * subtraction throws away most of the precision. The same lesson
   * lib/exporters.js records for signedArea. */
  function signedArea(pts) {
    if (!pts || pts.length < 3) return 0;
    const ox = pts[0][0], oy = pts[0][1];
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      sum += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
    }
    return sum / 2;
  }

  /* ---------------------------------------------------------------------
   * .shp — geometry
   * ------------------------------------------------------------------- */
  function readShp(bytes) {
    const b = u8(bytes);
    if (!b || b.length < 100) return { ok: false, error: 'The .shp file is too short to be a shapefile.' };
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getInt32(0, false) !== 9994) {
      return { ok: false, error: 'That .shp file does not carry a shapefile header.' };
    }

    const records = [];
    const skipped = [];
    // The header states the file length in 16-bit words; trust the buffer too,
    // because truncated downloads are common and a stated length that runs off
    // the end must not be read past.
    const stated = v.getInt32(24, false) * 2;
    const end = Math.min(b.length, stated > 100 ? stated : b.length);

    let off = 100;
    while (off + 8 <= end) {
      const contentWords = v.getInt32(off + 4, false);
      const contentBytes = contentWords * 2;
      const recStart = off + 8;
      if (contentBytes <= 0 || recStart + contentBytes > end) break;

      const type = v.getInt32(recStart, true);
      const kind = baseType(type);
      if (type === NULL_SHAPE) {
        skipped.push({ what: 'a null shape', why: 'the record holds no geometry' });
      } else if (kind === POLYGON || kind === POLYLINE) {
        let p = recStart + 4 + 32;              // skip the record's bounding box
        const numParts = v.getInt32(p, true); p += 4;
        const numPoints = v.getInt32(p, true); p += 4;
        if (numParts > 0 && numPoints > 0 && p + numParts * 4 + numPoints * 16 <= end) {
          const starts = [];
          for (let i = 0; i < numParts; i++) { starts.push(v.getInt32(p, true)); p += 4; }
          const pts = [];
          for (let i = 0; i < numPoints; i++) {
            pts.push([v.getFloat64(p, true), v.getFloat64(p + 8, true)]);
            p += 16;
          }
          const parts = [];
          for (let i = 0; i < starts.length; i++) {
            const from = starts[i];
            const to = i + 1 < starts.length ? starts[i + 1] : numPoints;
            if (to > from) parts.push(pts.slice(from, to));
          }
          records.push({ type, kind, parts });
        } else {
          skipped.push({ what: `a ${TYPE_NAMES[type] || 'shape'} record`, why: 'its part or point counts do not fit the file' });
        }
      } else {
        // Point and MultiPoint carry no area, and this application's geometry
        // model is a ring of at least three corners. Named rather than dropped.
        records.push({ type, kind, parts: [] });
      }
      off = recStart + contentBytes;
    }
    return { ok: true, records, skipped };
  }

  /* ---------------------------------------------------------------------
   * .dbf — attributes
   *
   * dBASE III. Read as Latin-1, which is what a .cpg-less shapefile is in
   * practice; a .cpg saying otherwise is honoured when present.
   * ------------------------------------------------------------------- */
  function readDbf(bytes, encodingHint) {
    const b = u8(bytes);
    if (!b || b.length < 32) return { ok: false, error: 'The .dbf file is too short to be a dBASE table.' };
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const count = v.getInt32(4, true);
    const headerSize = v.getInt16(8, true);
    const recordSize = v.getInt16(10, true);
    if (count < 0 || headerSize < 33 || recordSize < 1) {
      return { ok: false, error: 'The .dbf file header is not readable.' };
    }

    const fields = [];
    for (let p = 32; p < headerSize - 1 && p + 32 <= b.length; p += 32) {
      if (b[p] === 0x0d) break;
      let name = '';
      for (let i = 0; i < 11 && b[p + i]; i++) name += String.fromCharCode(b[p + i]);
      fields.push({ name: name.trim(), type: String.fromCharCode(b[p + 11]), size: b[p + 16] });
    }
    if (!fields.length) return { ok: true, rows: [], fields: [] };

    const utf8 = /utf-?8/i.test(String(encodingHint || ''));
    const decode = (arr) => {
      if (utf8 && typeof TextDecoder === 'function') {
        return safe(() => new TextDecoder('utf-8').decode(arr), null) || latin1(arr);
      }
      return latin1(arr);
    };
    const latin1 = (arr) => {
      let s = '';
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      return s;
    };

    const rows = [];
    for (let r = 0; r < count; r++) {
      const start = headerSize + r * recordSize;
      if (start + recordSize > b.length) break;
      if (b[start] === 0x2a) continue;          // 0x2a marks a deleted record
      let p = start + 1;
      const row = {};
      for (const f of fields) {
        const raw = decode(b.subarray(p, p + f.size)).trim();
        p += f.size;
        if (raw === '') { row[f.name] = null; continue; }
        if (f.type === 'N' || f.type === 'F') {
          const n = Number(raw);
          row[f.name] = Number.isFinite(n) ? n : raw;
        } else if (f.type === 'L') {
          row[f.name] = /^[YyTt]$/.test(raw) ? true : (/^[NnFf]$/.test(raw) ? false : null);
        } else {
          row[f.name] = raw;
        }
      }
      rows.push(row);
    }
    return { ok: true, rows, fields };
  }

  /* ---------------------------------------------------------------------
   * .prj — an EPSG code, or nothing
   *
   * Deliberately not a WKT parser. The only thing wanted is a code the
   * caller's own CRS engine already understands; anything less certain is
   * reported as unknown so the application asks rather than guesses.
   * ------------------------------------------------------------------- */
  function epsgFromPrj(text) {
    const s = String(text || '');
    if (!s.trim()) return null;

    // The trailing AUTHORITY of the outermost system is the reliable one, so
    // the LAST match wins over any nested datum or unit authority.
    const auth = [...s.matchAll(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
    if (auth.length) {
      const n = Number(auth[auth.length - 1][1]);
      if (Number.isFinite(n) && n > 0) return n;
    }

    // Failing that, the one name shape common enough to be unambiguous: a WGS
    // 84 UTM zone. Both spellings are accepted because both are in the wild —
    // ArcGIS writes "WGS_1984_UTM_Zone_45N", QGIS and this project's own
    // exporter write "WGS 84 / UTM zone 45N".
    const utm = s.match(/WGS[_ ]?(?:19)?84[^"]*UTM[_ ]?(?:zone[_ ]?)?(\d{1,2})\s*([NS])/i);
    if (utm) {
      const z = Number(utm[1]);
      if (z >= 1 && z <= 60) return (utm[2].toUpperCase() === 'N' ? 32600 : 32700) + z;
    }
    // A plain geographic WGS 84 with no projection is likewise unambiguous.
    if (/GEOGCS/i.test(s) && !/PROJCS/i.test(s) && /WGS[_ ]?(?:19)?84/i.test(s)) return 4326;
    return null;
  }

  /* ---------------------------------------------------------------------
   * Pick the components out of a set of ZIP entries.
   *
   * Entries come from the caller's existing ZIP reader — this module does not
   * carry a second one. A shapefile inside a ZIP is normally in a folder, and
   * a ZIP can hold several datasets; the components are grouped by base name
   * and the one with geometry wins.
   * ------------------------------------------------------------------- */
  function datasetFromEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const groups = new Map();
    for (const e of list) {
      const name = String((e && e.name) || '');
      const m = name.match(/^(.*)\.(shp|shx|dbf|prj|cpg)$/i);
      if (!m) continue;
      // Skip macOS resource forks, which otherwise present as a second dataset.
      if (/(^|\/)__MACOSX\//i.test(name) || /(^|\/)\._/.test(name)) continue;
      const key = m[1].toLowerCase();
      const ext = m[2].toLowerCase();
      const g = groups.get(key) || { base: m[1], parts: {} };
      g.parts[ext] = e.data;
      groups.set(key, g);
    }
    const usable = [...groups.values()].filter((g) => g.parts.shp);
    if (!usable.length) return { ok: false, error: 'That ZIP contains no .shp file, so there is no shapefile in it to read.' };
    // Largest .shp: with several datasets in one ZIP the substantive one is
    // wanted, not whichever happened to be listed first.
    usable.sort((a, b) => (b.parts.shp.length || 0) - (a.parts.shp.length || 0));
    const pick = usable[0];
    return {
      ok: true,
      name: String(pick.base).split('/').pop(),
      shp: pick.parts.shp,
      shx: pick.parts.shx || null,
      dbf: pick.parts.dbf || null,
      prj: pick.parts.prj || null,
      cpg: pick.parts.cpg || null,
      others: usable.length - 1,
    };
  }

  const asText = (bytes) => {
    if (!bytes) return '';
    const b = u8(bytes);
    if (typeof TextDecoder === 'function') {
      const t = safe(() => new TextDecoder('utf-8').decode(b), null);
      if (t != null) return t;
    }
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  };

  /* Fields whose names cadastral shapefiles actually use for the plot number.
   * Checked in order; the first present and non-empty wins. Everything else in
   * the DBF still travels as attributes, so nothing is lost by guessing wrong. */
  const PLOT_FIELDS = ['PLOT_NO', 'PLOTNO', 'PLOT', 'KHASRA', 'KHASRA_NO', 'SURVEY_NO',
    'SURVEYNO', 'PARCEL_NO', 'PARCELNO', 'PARCEL', 'GIS_ID', 'PID', 'ID'];

  function plotNumberFrom(row) {
    if (!row) return null;
    const keys = Object.keys(row);
    for (const want of PLOT_FIELDS) {
      const k = keys.find((n) => n.toUpperCase() === want);
      if (k && row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return null;
  }

  /* ---------------------------------------------------------------------
   * The reader proper.
   *
   * opts.parseEpsg — the CALLER's EPSG lookup. Injected rather than imported
   * so this module holds no opinion about coordinate systems and there is only
   * ever one projection engine in the application.
   * ------------------------------------------------------------------- */
  function parseShapefile(parts, opts) {
    const o = opts || {};
    const res = { ok: true, rings: [], crs: null, crsSource: null, skipped: [], warnings: [] };
    if (!parts || !parts.shp) {
      return Object.assign(res, { ok: false, error: 'Shapefile dataset is incomplete: no .shp file was found.' });
    }

    const geom = readShp(parts.shp);
    if (!geom.ok) return Object.assign(res, { ok: false, error: geom.error });
    res.skipped.push(...geom.skipped);

    let rows = [];
    if (parts.dbf) {
      const dbf = readDbf(parts.dbf, asText(parts.cpg));
      if (dbf.ok) rows = dbf.rows;
      else res.warnings.push(`The .dbf attribute table could not be read (${dbf.error}) — geometry was imported without attributes.`);
    } else {
      // Not fatal: geometry is what a digitiser needs, and refusing a dataset
      // over a missing attribute table would be the wrong trade.
      res.warnings.push('No .dbf was found, so the parcels carry no attributes — plot numbers included.');
    }

    if (parts.prj) {
      const code = epsgFromPrj(asText(parts.prj));
      const parsed = code != null && typeof o.parseEpsg === 'function' ? o.parseEpsg(`EPSG:${code}`) : null;
      if (parsed) {
        res.crs = parsed;
        res.crsSource = `the shapefile's .prj (EPSG:${code})`;
      } else {
        // A .prj that is present but not recognised is worth saying out loud:
        // the alternative is the operator assuming the CRS was honoured.
        res.warnings.push('The .prj file does not name a coordinate system this tool recognises, so you will be asked which one the coordinates are in.');
      }
    } else {
      res.warnings.push('Shapefile CRS is undefined: there is no .prj file, so you will be asked which coordinate system the coordinates are in.');
    }

    let holes = 0, unsupported = 0;
    geom.records.forEach((rec, i) => {
      const row = rows[i] || null;
      if (rec.kind === POINT || rec.kind === MULTIPOINT) { unsupported++; return; }
      if (!rec.parts.length) return;

      const isPolygon = rec.kind === POLYGON;
      rec.parts.forEach((part) => {
        // A shapefile ring repeats its first vertex to close; the application
        // counts real corners, so the duplicate goes.
        const pts = part.slice();
        if (pts.length > 1) {
          const a = pts[0], b = pts[pts.length - 1];
          if (a[0] === b[0] && a[1] === b[1]) pts.pop();
        }
        if (pts.length < 3) return;

        // Clockwise is an outer ring, counter-clockwise is a hole. This
        // application's geometry model has no holes, so an inner ring is
        // reported rather than silently imported as a solid parcel on top of
        // the one it was cut out of.
        if (isPolygon && signedArea(pts) > 0) { holes++; return; }

        res.rings.push({
          points: pts,
          layer: o.layer || 'Shapefile',
          plotNo: plotNumberFrom(row),
          name: row && (row.NAME || row.Name || row.name) ? String(row.NAME || row.Name || row.name) : null,
          attributes: row,
          closed: isPolygon,
        });
      });
    });

    if (holes) {
      res.skipped.push({
        what: `${holes} inner ring(s)`,
        why: 'they are holes cut out of a parcel, which this tool\'s geometry model does not represent',
      });
    }
    if (unsupported) {
      res.skipped.push({
        what: `${unsupported} point or multipoint feature(s)`,
        why: 'a parcel needs at least three corners, so a point cannot become one',
      });
    }
    if (!res.rings.length) {
      return Object.assign(res, {
        ok: false,
        error: geom.records.length
          ? 'No polygon or line geometry could be read from that shapefile.'
          : 'That shapefile contains no shapes.',
      });
    }
    return res;
  }

  return {
    parseShapefile,
    datasetFromEntries,
    readShp,
    readDbf,
    epsgFromPrj,
    signedArea,
    TYPE_NAMES,
  };
}));
