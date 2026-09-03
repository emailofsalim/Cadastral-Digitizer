/* =========================================================================
 * Global CRS engine — projections, datums, and hint-driven detection.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Crs) or a CommonJS module.
 *
 * WHY THIS REPLACES THE v13/v14 APPROACH
 *
 * Earlier versions hardcoded UTM Zone 45N and "detected" the projection from
 * coordinate magnitude alone:
 *
 *     if (|x| < 1e6 && |y| > 1e6) return utmToLonLat(x, y, 45, true);
 *
 * That works only for Jharkhand. Point it at Rajasthan (zone 43) and every
 * export lands hundreds of kilometres away, silently, because the arithmetic
 * still succeeds.
 *
 * AN IMPORTANT LIMIT, STATED UP FRONT
 *
 * A UTM easting/northing pair CANNOT identify its own zone. Easting encodes
 * offset from *some* central meridian; assume zone 43 and you get a
 * self-consistent longitude near 75E, assume zone 45 and you get an equally
 * self-consistent longitude near 87E. Every zone assumption is internally
 * valid — the same numbers are a real place in all 60 of them. No amount of
 * cleverness recovers the zone from the coordinates alone; the information is
 * simply not in them.
 *
 * So detection here is deliberately split in two:
 *
 *   1. FAMILY (geographic / Web Mercator / UTM-like / unknown) — inferred
 *      reliably from magnitude, because those families occupy disjoint
 *      numeric ranges.
 *   2. ZONE / exact CRS — resolved only from external evidence: a declared
 *      EPSG or projection code, a tile/WMS request parameter, the portal's
 *      host, or page text naming a state. When the evidence is weak, this
 *      module says so via `needsConfirmation` and returns ranked candidates
 *      instead of guessing.
 *
 * Refusing to guess is the point. A wrong zone is not a small error, and
 * v13's silent hardcoded 45 is exactly the failure mode being removed.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Crs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  /* =====================================================================
   * ELLIPSOIDS
   * Everest 1830 and its variants matter for Indian legacy cadastral data
   * (Kalianpur datums); WGS84/GRS80 for everything modern.
   * =================================================================== */
  const ELLIPSOIDS = {
    WGS84:          { a: 6378137.0,     invF: 298.257223563, name: 'WGS 84' },
    GRS80:          { a: 6378137.0,     invF: 298.257222101, name: 'GRS 1980' },
    EVEREST_1830:   { a: 6377276.345,   invF: 300.8017,      name: 'Everest 1830 (1937 Adjustment)' },
    EVEREST_1830_1975: { a: 6377301.243, invF: 300.8017,     name: 'Everest 1830 (1975 Definition)' },
    EVEREST_1830_1956: { a: 6377301.243, invF: 300.8017,     name: 'Everest 1830 (1956 Definition)' },
    CLARKE_1866:    { a: 6378206.4,     invF: 294.9786982,   name: 'Clarke 1866' },
    BESSEL_1841:    { a: 6377397.155,   invF: 299.1528128,   name: 'Bessel 1841' },
    INTL_1924:      { a: 6378388.0,     invF: 297.0,         name: 'International 1924' },
  };

  function ellipsoidParams(ell) {
    const e = ell || ELLIPSOIDS.WGS84;
    const a = e.a;
    const f = 1 / e.invF;
    const e2 = f * (2 - f);
    return { a, f, e2, e: Math.sqrt(e2), ep2: e2 / (1 - e2), b: a * (1 - f) };
  }

  /* =====================================================================
   * MERIDIAN ARC
   * Exported because it is the single most error-prone piece of the UTM
   * chain, and the test suite validates this series against independent
   * numerical integration of the meridional radius rather than trusting it.
   * =================================================================== */
  function meridianArc(latRad, ell) {
    const { a, e2 } = ellipsoidParams(ell);
    const e4 = e2 * e2, e6 = e4 * e2;
    return a * (
      (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * latRad
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * latRad)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * latRad)
      - (35 * e6 / 3072) * Math.sin(6 * latRad)
    );
  }

  // Radius of curvature in the meridian — the integrand whose integral is
  // meridianArc. Exported so the tests can integrate it independently.
  function meridionalRadius(latRad, ell) {
    const { a, e2 } = ellipsoidParams(ell);
    const s = Math.sin(latRad);
    return a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
  }

  /* =====================================================================
   * UTM — any zone, either hemisphere, any ellipsoid.
   * =================================================================== */
  const UTM_K0 = 0.9996;
  const UTM_FALSE_EASTING = 500000;
  const UTM_FALSE_NORTHING_SOUTH = 10000000;

  function utmZoneFromLon(lonDeg) {
    let lon = ((lonDeg + 180) % 360 + 360) % 360 - 180; // normalise to [-180,180)
    return Math.floor((lon + 180) / 6) + 1;
  }
  function utmCentralMeridian(zone) { return (zone - 1) * 6 - 180 + 3; }

  function utmForward(lonDeg, latDeg, zone, ell) {
    const { a, e2, ep2 } = ellipsoidParams(ell);
    const phi = latDeg * DEG;
    const lon0 = utmCentralMeridian(zone) * DEG;
    const lam = lonDeg * DEG;

    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi), tanPhi = Math.tan(phi);
    const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = ep2 * cosPhi * cosPhi;
    let dLam = lam - lon0;
    // Keep the longitude difference in (-pi, pi] so points near the
    // antimeridian do not blow the series up.
    while (dLam > Math.PI) dLam -= 2 * Math.PI;
    while (dLam < -Math.PI) dLam += 2 * Math.PI;
    const A = dLam * cosPhi;
    const M = meridianArc(phi, ell);

    const A2 = A * A, A3 = A2 * A, A4 = A3 * A, A5 = A4 * A, A6 = A5 * A;
    const easting = UTM_FALSE_EASTING + UTM_K0 * N * (
      A + (1 - T + C) * A3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A5 / 120
    );
    let northing = UTM_K0 * (
      M + N * tanPhi * (
        A2 / 2 + (5 - T + 9 * C + 4 * C * C) * A4 / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A6 / 720
      )
    );
    if (latDeg < 0) northing += UTM_FALSE_NORTHING_SOUTH;
    return [easting, northing];
  }

  function utmInverse(easting, northing, zone, northernHemisphere, ell) {
    const { a, e2, ep2 } = ellipsoidParams(ell);
    const x = easting - UTM_FALSE_EASTING;
    let y = northing;
    if (!northernHemisphere) y -= UTM_FALSE_NORTHING_SOUTH;

    const lon0 = utmCentralMeridian(zone) * DEG;
    const M = y / UTM_K0;
    const e4 = e2 * e2, e6 = e4 * e2;
    const mu = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const sqrt1me2 = Math.sqrt(1 - e2);
    const e1 = (1 - sqrt1me2) / (1 + sqrt1me2);
    const e1_2 = e1 * e1, e1_3 = e1_2 * e1, e1_4 = e1_3 * e1;

    const phi1 = mu
      + (3 * e1 / 2 - 27 * e1_3 / 32) * Math.sin(2 * mu)
      + (21 * e1_2 / 16 - 55 * e1_4 / 32) * Math.sin(4 * mu)
      + (151 * e1_3 / 96) * Math.sin(6 * mu)
      + (1097 * e1_4 / 512) * Math.sin(8 * mu);

    const sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1), tanPhi1 = Math.tan(phi1);
    const C1 = ep2 * cosPhi1 * cosPhi1;
    const T1 = tanPhi1 * tanPhi1;
    const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
    const D = x / (N1 * UTM_K0);
    const D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D;

    const lat = phi1 - (N1 * tanPhi1 / R1) * (
      D2 / 2
      - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720
    );
    const lon = lon0 + (
      D
      - (1 + 2 * T1 + C1) * D3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120
    ) / cosPhi1;

    return [lon * RAD, lat * RAD];
  }

  /* =====================================================================
   * WEB MERCATOR (EPSG:3857)
   * =================================================================== */
  const WEBMERC_R = 6378137.0;
  const WEBMERC_MAX = Math.PI * WEBMERC_R; // 20037508.34

  function webMercatorForward(lonDeg, latDeg) {
    const lat = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
    return [
      lonDeg * DEG * WEBMERC_R,
      Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)) * WEBMERC_R,
    ];
  }
  function webMercatorInverse(x, y) {
    return [
      (x / WEBMERC_R) * RAD,
      (2 * Math.atan(Math.exp(y / WEBMERC_R)) - Math.PI / 2) * RAD,
    ];
  }

  /* =====================================================================
   * LAMBERT CONFORMAL CONIC (2 standard parallels)
   * Used by India's NSDI grid and several national cadastral systems.
   * =================================================================== */
  function lccConstants(def, ell) {
    const { a, e } = ellipsoidParams(ell);
    const phi1 = def.lat1 * DEG, phi2 = def.lat2 * DEG, phi0 = def.lat0 * DEG;
    const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) * Math.sin(phi));
    const t = (phi) => Math.tan(Math.PI / 4 - phi / 2) /
      Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2);
    const m1 = m(phi1), m2 = m(phi2), t1 = t(phi1), t2 = t(phi2), t0 = t(phi0);
    // Equal standard parallels degenerate to the tangent (1SP) case.
    const n = Math.abs(phi1 - phi2) < 1e-12
      ? Math.sin(phi1)
      : Math.log(m1 / m2) / Math.log(t1 / t2);
    const F = m1 / (n * Math.pow(t1, n));
    return { a, e, n, F, rho0: a * F * Math.pow(t0, n), t };
  }

  function lccForward(lonDeg, latDeg, def, ell) {
    const k = lccConstants(def, ell);
    const rho = k.a * k.F * Math.pow(k.t(latDeg * DEG), k.n);
    let dLon = (lonDeg - def.lon0) * DEG;
    while (dLon > Math.PI) dLon -= 2 * Math.PI;
    while (dLon < -Math.PI) dLon += 2 * Math.PI;
    const theta = k.n * dLon;
    return [
      (def.x0 || 0) + rho * Math.sin(theta),
      (def.y0 || 0) + k.rho0 - rho * Math.cos(theta),
    ];
  }

  function lccInverse(x, y, def, ell) {
    const k = lccConstants(def, ell);
    const dx = x - (def.x0 || 0);
    const dy = k.rho0 - (y - (def.y0 || 0));
    const sign = k.n >= 0 ? 1 : -1;
    const rho = sign * Math.hypot(dx, dy);
    if (rho === 0) return [def.lon0, k.n >= 0 ? 90 : -90];
    const tPrime = Math.pow(rho / (k.a * k.F), 1 / k.n);
    const theta = Math.atan2(sign * dx, sign * dy);
    const lon = theta / k.n * RAD + def.lon0;
    // Iterate for latitude; converges in a handful of passes.
    let phi = Math.PI / 2 - 2 * Math.atan(tPrime);
    for (let i = 0; i < 12; i++) {
      const s = Math.sin(phi);
      const next = Math.PI / 2 - 2 * Math.atan(
        tPrime * Math.pow((1 - k.e * s) / (1 + k.e * s), k.e / 2)
      );
      if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
      phi = next;
    }
    return [lon, phi * RAD];
  }

  /* =====================================================================
   * DATUM SHIFTS — 7-parameter Helmert via ECEF.
   *
   * Indian cadastral records frequently sit on Kalianpur/Everest datums, and
   * ignoring the shift costs tens to hundreds of metres. The machinery is
   * exact; the PARAMETER SETS are the uncertain part, so they are marked with
   * an accuracy estimate and none is applied unless explicitly selected.
   * Defaulting to "no shift" and saying so beats applying numbers we cannot
   * verify and quietly biasing every export.
   * =================================================================== */
  const DATUMS = {
    WGS84: { name: 'WGS 84', ellipsoid: 'WGS84', toWgs84: null, accuracyM: 0 },
    // Published parameter sets vary by source and by region within India.
    // Treat these as approximate; verify against local control before relying
    // on them for legal survey work.
    KALIANPUR_1975: {
      name: 'Kalianpur 1975 (India)', ellipsoid: 'EVEREST_1830_1975',
      toWgs84: { dx: 295.0, dy: 736.0, dz: 257.0, rx: 0, ry: 0, rz: 0, s: 0 },
      accuracyM: 20, approximate: true,
    },
    KALIANPUR_1937: {
      name: 'Kalianpur 1937 (India)', ellipsoid: 'EVEREST_1830',
      toWgs84: { dx: 282.9, dy: 726.0, dz: 254.1, rx: 0, ry: 0, rz: 0, s: 0 },
      accuracyM: 20, approximate: true,
    },
  };

  function geodeticToEcef(lonDeg, latDeg, h, ell) {
    const { a, e2 } = ellipsoidParams(ell);
    const phi = latDeg * DEG, lam = lonDeg * DEG;
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const height = h || 0;
    return [
      (N + height) * cosPhi * Math.cos(lam),
      (N + height) * cosPhi * Math.sin(lam),
      (N * (1 - e2) + height) * sinPhi,
    ];
  }

  function ecefToGeodetic(X, Y, Z, ell) {
    const { a, e2, b } = ellipsoidParams(ell);
    const lam = Math.atan2(Y, X);
    const p = Math.hypot(X, Y);
    // Bowring / Ferrari-style iteration; ample for our accuracy needs.
    let phi = Math.atan2(Z, p * (1 - e2));
    let N = a, h = 0;
    for (let i = 0; i < 8; i++) {
      const sinPhi = Math.sin(phi);
      N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
      h = p / Math.cos(phi) - N;
      const next = Math.atan2(Z, p * (1 - e2 * N / (N + h)));
      if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
      phi = next;
    }
    void b;
    return [lam * RAD, phi * RAD, h];
  }

  // Position-vector convention: rotations are applied to the source vector.
  function helmert(X, Y, Z, p) {
    const rx = (p.rx || 0) / 3600 * DEG;
    const ry = (p.ry || 0) / 3600 * DEG;
    const rz = (p.rz || 0) / 3600 * DEG;
    const s = 1 + (p.s || 0) * 1e-6;
    return [
      (p.dx || 0) + s * (X - rz * Y + ry * Z),
      (p.dy || 0) + s * (rz * X + Y - rx * Z),
      (p.dz || 0) + s * (-ry * X + rx * Y + Z),
    ];
  }

  function datumToWgs84(lonDeg, latDeg, h, datumKey) {
    const d = DATUMS[datumKey];
    if (!d || !d.toWgs84) return [lonDeg, latDeg, h || 0];
    const ell = ELLIPSOIDS[d.ellipsoid];
    const [X, Y, Z] = geodeticToEcef(lonDeg, latDeg, h || 0, ell);
    const [X2, Y2, Z2] = helmert(X, Y, Z, d.toWgs84);
    return ecefToGeodetic(X2, Y2, Z2, ELLIPSOIDS.WGS84);
  }

  /* =====================================================================
   * EPSG CODE PARSING — the strongest hint available when a map declares one.
   * =================================================================== */
  function parseEpsg(code) {
    if (code == null) return null;
    const m = String(code).match(/(\d{4,6})/);
    if (!m) return null;
    const n = parseInt(m[1], 10);

    if (n === 4326) return { kind: 'geographic', datum: 'WGS84', epsg: n, label: 'WGS 84 geographic' };
    if (n === 3857 || n === 900913 || n === 102100 || n === 102113) {
      return { kind: 'webmercator', datum: 'WGS84', epsg: n, label: 'Web Mercator' };
    }
    // WGS84 / UTM north 32601-32660, south 32701-32760
    if (n >= 32601 && n <= 32660) return { kind: 'utm', zone: n - 32600, north: true, datum: 'WGS84', epsg: n, label: `WGS 84 / UTM ${n - 32600}N` };
    if (n >= 32701 && n <= 32760) return { kind: 'utm', zone: n - 32700, north: false, datum: 'WGS84', epsg: n, label: `WGS 84 / UTM ${n - 32700}S` };
    // WGS72 UTM north 32201-32260 (occasionally seen in older stacks)
    if (n >= 32201 && n <= 32260) return { kind: 'utm', zone: n - 32200, north: true, datum: 'WGS84', epsg: n, label: `UTM ${n - 32200}N (WGS 72, treated as WGS 84)` };
    // Kalianpur 1975 / India zones 24378-24382 (LCC-based Indian grid)
    if (n >= 24378 && n <= 24382) {
      return { kind: 'india-grid', indiaZone: n - 24377, datum: 'KALIANPUR_1975', epsg: n, label: `Kalianpur 1975 / India zone ${n - 24377}`, approximate: true };
    }
    return { kind: 'unknown', epsg: n, label: `EPSG:${n} (unrecognised)` };
  }

  /* =====================================================================
   * REGIONAL PRIORS
   *
   * These resolve the zone ambiguity that coordinates alone cannot. Keyed by
   * host fragment and by state name, both of which Indian cadastral portals
   * expose plainly.
   * =================================================================== */
  const INDIA_BBOX = { west: 68.0, east: 97.5, south: 6.5, north: 37.6 };

  // Indian states/UTs mapped to the UTM zone(s) their territory falls in.
  // Where a state straddles a boundary both are listed, most-likely first.
  const INDIA_STATE_UTM_ZONES = {
    'gujarat': [43, 42], 'rajasthan': [43, 42, 44], 'maharashtra': [43, 44],
    'goa': [43], 'madhya pradesh': [44, 43], 'chhattisgarh': [44, 45],
    'karnataka': [43, 44], 'kerala': [43], 'tamil nadu': [44, 43],
    'andhra pradesh': [44], 'telangana': [44], 'odisha': [45, 44],
    'jharkhand': [45], 'bihar': [45], 'west bengal': [45],
    'uttar pradesh': [44, 45], 'uttarakhand': [44], 'haryana': [43, 44],
    'punjab': [43], 'himachal pradesh': [43, 44], 'delhi': [43, 44],
    'jammu': [43], 'kashmir': [43], 'ladakh': [43, 44],
    'assam': [46, 45], 'meghalaya': [46], 'tripura': [46], 'mizoram': [46],
    'manipur': [46], 'nagaland': [46], 'arunachal pradesh': [46, 47],
    'sikkim': [45], 'puducherry': [44], 'chandigarh': [43],
    'andaman': [46], 'nicobar': [46], 'lakshadweep': [43],
  };

  // Host fragments seen across Indian cadastral / land-record portals, mapped
  // to the state whose priors should apply.
  const HOST_STATE_HINTS = [
    [/jharbhunaksha|jharkhand/i, 'jharkhand'],
    [/bhunakshabihar|bihar/i, 'bihar'],
    [/bhunaksha.*odisha|odisha|bhulekh\.ori/i, 'odisha'],
    [/banglarbhumi|wbbhulekh|westbengal/i, 'west bengal'],
    [/bhunakshamp|mpbhulekh|landrecords\.mp/i, 'madhya pradesh'],
    [/bhunaksha.*cg|cgbhuiyan|chhattisgarh/i, 'chhattisgarh'],
    [/apnakhata|bhunaksha.*raj|rajasthan/i, 'rajasthan'],
    [/mahabhunakasha|mahabhulekh|bhulekh.*mahabhumi|maharashtra/i, 'maharashtra'],
    [/anyror|gujarat|revenuedepartment\.gujarat/i, 'gujarat'],
    [/dishaank|bhoomi|landrecords\.karnataka|karnataka/i, 'karnataka'],
    [/tamilnilam|eservices\.tn|tamilnadu/i, 'tamil nadu'],
    [/meebhoomi|apland|andhra/i, 'andhra pradesh'],
    [/dharani|telangana/i, 'telangana'],
    [/upbhulekh|upbhunaksha|uttarpradesh/i, 'uttar pradesh'],
    [/jamabandi|haryana/i, 'haryana'],
    [/jamabandi\.punjab|punjab/i, 'punjab'],
    [/himbhoomi|hpbhulekh|himachal/i, 'himachal pradesh'],
    [/assam|dharitree/i, 'assam'],
    [/kerala|erekha/i, 'kerala'],
    [/devbhoomi|uttarakhand/i, 'uttarakhand'],
  ];

  function stateFromHost(host) {
    if (!host) return null;
    for (const [re, state] of HOST_STATE_HINTS) if (re.test(host)) return state;
    return null;
  }
  function stateFromText(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();
    for (const state of Object.keys(INDIA_STATE_UTM_ZONES)) {
      if (lower.includes(state)) return state;
    }
    return null;
  }

  /* =====================================================================
   * FAMILY CLASSIFICATION — the part that IS reliable from magnitude alone,
   * because these families occupy disjoint numeric ranges.
   * =================================================================== */
  function classifyFamily(samples) {
    const pts = (samples || []).filter(p =>
      Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
    if (!pts.length) return { family: 'unknown', reason: 'no sample coordinates supplied' };

    const maxAbsX = Math.max(...pts.map(p => Math.abs(p[0])));
    const maxAbsY = Math.max(...pts.map(p => Math.abs(p[1])));

    if (maxAbsX <= 180 && maxAbsY <= 90) {
      return { family: 'geographic', reason: `all coordinates within lon/lat bounds (max |x|=${maxAbsX.toFixed(3)}, |y|=${maxAbsY.toFixed(3)})` };
    }
    // UTM eastings are constrained to roughly 100k-900k by construction, and
    // northings to 0-10e6. Web Mercator routinely exceeds both.
    const utmLikeX = pts.every(p => Math.abs(p[0]) >= 100000 && Math.abs(p[0]) <= 900000);
    const utmLikeY = pts.every(p => p[1] >= -1e7 && p[1] <= 1e7);
    if (utmLikeX && utmLikeY && maxAbsY > 90) {
      return { family: 'utm', reason: `eastings in 100k-900k and northings within +/-10e6 — consistent with a transverse Mercator grid` };
    }
    if (maxAbsX <= WEBMERC_MAX * 1.001 && maxAbsY <= WEBMERC_MAX * 1.001) {
      return { family: 'webmercator', reason: `coordinates within +/-${WEBMERC_MAX.toFixed(0)} m, consistent with Web Mercator` };
    }
    return { family: 'unknown', reason: `coordinate magnitudes (max |x|=${maxAbsX.toFixed(0)}, |y|=${maxAbsY.toFixed(0)}) match no known family` };
  }

  /* =====================================================================
   * CRS DETECTION
   *
   * hints: {
   *   epsgCode      declared projection code from the map library
   *   host          window.location.hostname
   *   pageText      any scraped text that might name a state/region
   *   tileUrls      [] request URLs that may carry SRS/CRS parameters
   *   region        explicit override, e.g. 'india'
   * }
   *
   * Returns:
   * {
   *   crs               best CRS descriptor, or null
   *   confidence        0..1
   *   needsConfirmation true when the zone is not pinned by evidence
   *   family, reasons[], candidates[]
   * }
   * =================================================================== */
  function extractEpsgFromUrls(urls) {
    for (const u of urls || []) {
      const m = String(u).match(/(?:SRS|CRS|srsName)=(?:EPSG(?:%3A|:)?)?(\d{4,6})/i);
      if (m) return m[1];
    }
    return null;
  }

  function detectCrs(samples, hints) {
    const h = hints || {};
    const reasons = [];
    const fam = classifyFamily(samples);
    reasons.push('Magnitude analysis: ' + fam.reason);

    // ---- Evidence 1: a declared EPSG code, directly or from tile requests ----
    let declared = parseEpsg(h.epsgCode);
    if (declared) reasons.push(`Map declares ${h.epsgCode} -> ${declared.label}`);
    if (!declared || declared.kind === 'unknown') {
      const fromUrl = extractEpsgFromUrls(h.tileUrls);
      if (fromUrl) {
        const parsed = parseEpsg(fromUrl);
        if (parsed && parsed.kind !== 'unknown') {
          declared = parsed;
          reasons.push(`Tile/WMS request declares EPSG:${fromUrl} -> ${parsed.label}`);
        }
      }
    }

    // A declared code can still be wrong — the Jharkhand portal was observed
    // reporting a code inconsistent with its own coordinate magnitudes. So a
    // declaration is only trusted when the magnitudes agree with it.
    if (declared && declared.kind !== 'unknown') {
      const agrees =
        (declared.kind === 'geographic' && fam.family === 'geographic') ||
        (declared.kind === 'webmercator' && fam.family === 'webmercator') ||
        (declared.kind === 'utm' && fam.family === 'utm') ||
        (declared.kind === 'india-grid' && (fam.family === 'utm' || fam.family === 'unknown'));
      if (agrees) {
        return {
          crs: declared, family: fam.family, confidence: 0.97,
          needsConfirmation: false,
          reasons: reasons.concat('Declared code agrees with observed coordinate magnitudes.'),
          candidates: [declared],
        };
      }
      reasons.push(
        `⚠️ Declared ${declared.label} CONFLICTS with observed magnitudes (${fam.family}). ` +
        `Ignoring the declaration — this site is known to mislabel its projection.`);
    }

    // ---- Families that need no zone ----
    if (fam.family === 'geographic') {
      const crs = { kind: 'geographic', datum: 'WGS84', label: 'WGS 84 geographic (lon/lat)' };
      return { crs, family: fam.family, confidence: 0.95, needsConfirmation: false, reasons, candidates: [crs] };
    }
    if (fam.family === 'webmercator') {
      const crs = { kind: 'webmercator', datum: 'WGS84', label: 'Web Mercator (EPSG:3857)' };
      return { crs, family: fam.family, confidence: 0.9, needsConfirmation: false, reasons, candidates: [crs] };
    }

    // ---- UTM: the zone must come from evidence outside the coordinates ----
    if (fam.family === 'utm') {
      reasons.push(
        'UTM zone cannot be derived from easting/northing alone — the same pair is a ' +
        'valid location in all 60 zones. Resolving from regional evidence instead.');

      const state = h.state || stateFromHost(h.host) || stateFromText(h.pageText);
      const northern = (samples || []).every(p => p[1] >= 0);
      let zones = null;
      let basis = null;

      if (state && INDIA_STATE_UTM_ZONES[state]) {
        zones = INDIA_STATE_UTM_ZONES[state];
        basis = `region identified as ${state} (${h.state ? 'explicitly set' : (stateFromHost(h.host) ? 'from host ' + h.host : 'from page text')})`;
      } else if (String(h.region || '').toLowerCase() === 'india') {
        zones = [43, 44, 45, 42, 46, 47];
        basis = 'region set to India, but no state identified';
      }

      if (zones && zones.length) {
        reasons.push(`Zone candidates from ${basis}: ${zones.map(z => z + (northern ? 'N' : 'S')).join(', ')}`);
        const candidates = zones.map((zone, i) => ({
          kind: 'utm', zone, north: northern, datum: 'WGS84',
          label: `WGS 84 / UTM ${zone}${northern ? 'N' : 'S'}`,
          epsg: (northern ? 32600 : 32700) + zone,
          rank: i,
        }));
        // Cross-check: does the winning zone place the samples inside the
        // expected region? If not, say so rather than proceeding quietly.
        const best = candidates[0];
        const check = validateAgainstRegion(samples, best, 'india');
        if (check.ok) reasons.push(`Plausibility check: samples land at ${check.centroidText}, inside India.`);
        else reasons.push(`⚠️ Plausibility check FAILED for ${best.label}: samples land at ${check.centroidText}, outside India.`);

        return {
          crs: best, family: 'utm',
          // Never fully confident: only one state straddling a zone boundary
          // is enough to make the first candidate wrong.
          confidence: candidates.length === 1 ? (check.ok ? 0.85 : 0.4) : (check.ok ? 0.7 : 0.35),
          needsConfirmation: candidates.length > 1 || !check.ok,
          reasons, candidates,
        };
      }

      // No regional evidence at all — enumerate every zone honestly.
      const all = [];
      for (let z = 1; z <= 60; z++) {
        all.push({
          kind: 'utm', zone: z, north: northern, datum: 'WGS84',
          label: `WGS 84 / UTM ${z}${northern ? 'N' : 'S'}`,
          epsg: (northern ? 32600 : 32700) + z, rank: z,
        });
      }
      reasons.push(
        'No EPSG code, host, or page text identified the region. All 60 zones are ' +
        'equally consistent with these coordinates — the zone MUST be confirmed by ' +
        'the user before any export can be trusted.');
      return {
        crs: null, family: 'utm', confidence: 0,
        needsConfirmation: true, reasons, candidates: all,
      };
    }

    return {
      crs: null, family: fam.family, confidence: 0,
      needsConfirmation: true,
      reasons: reasons.concat('Could not classify this coordinate system. Set it manually.'),
      candidates: [],
    };
  }

  function validateAgainstRegion(samples, crs, region) {
    const pts = (samples || []).slice(0, 8);
    if (!pts.length || !crs) return { ok: false, centroidText: 'n/a' };
    const lls = pts.map(p => toWgs84(p[0], p[1], crs)).filter(Boolean);
    if (!lls.length) return { ok: false, centroidText: 'n/a' };
    const lon = lls.reduce((a, p) => a + p[0], 0) / lls.length;
    const lat = lls.reduce((a, p) => a + p[1], 0) / lls.length;
    const centroidText = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    let ok = isFinite(lon) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (ok && String(region || '').toLowerCase() === 'india') {
      ok = lon >= INDIA_BBOX.west && lon <= INDIA_BBOX.east &&
           lat >= INDIA_BBOX.south && lat <= INDIA_BBOX.north;
    }
    return { ok, centroidText, lon, lat };
  }

  /* =====================================================================
   * PROJECTION DISPATCH
   * =================================================================== */
  const INDIA_GRID_ZONES = {
    // Kalianpur / India zones (LCC). Origins per the classic Survey of India
    // definitions; flagged approximate because published false origins vary.
    1: { lat1: 39.5, lat2: 39.5, lat0: 39.5, lon0: 68.0,  x0: 2743185.69, y0: 914395.23 },
    2: { lat1: 32.5, lat2: 32.5, lat0: 32.5, lon0: 68.0,  x0: 2743185.69, y0: 914395.23 },
    3: { lat1: 26.0, lat2: 26.0, lat0: 26.0, lon0: 74.0,  x0: 2743185.69, y0: 914395.23 },
    4: { lat1: 19.0, lat2: 19.0, lat0: 19.0, lon0: 80.0,  x0: 2743185.69, y0: 914395.23 },
    5: { lat1: 12.0, lat2: 12.0, lat0: 12.0, lon0: 80.0,  x0: 2743185.69, y0: 914395.23 },
  };

  function ellipsoidForCrs(crs) {
    const datum = DATUMS[crs && crs.datum] || DATUMS.WGS84;
    return ELLIPSOIDS[datum.ellipsoid] || ELLIPSOIDS.WGS84;
  }

  // Map coordinate -> WGS84 lon/lat. Returns null for an unusable CRS rather
  // than silently falling back to a guess.
  function toWgs84(x, y, crs) {
    if (!crs) return null;
    const ell = ellipsoidForCrs(crs);
    let lonLat = null;
    switch (crs.kind) {
      case 'geographic': lonLat = [x, y]; break;
      case 'webmercator': lonLat = webMercatorInverse(x, y); break;
      case 'utm': lonLat = utmInverse(x, y, crs.zone, crs.north !== false, ell); break;
      case 'lcc': lonLat = lccInverse(x, y, crs.def, ell); break;
      case 'india-grid': {
        const def = INDIA_GRID_ZONES[crs.indiaZone];
        if (!def) return null;
        lonLat = lccInverse(x, y, def, ell);
        break;
      }
      default: return null;
    }
    if (!lonLat || !isFinite(lonLat[0]) || !isFinite(lonLat[1])) return null;
    if (crs.datum && crs.datum !== 'WGS84') {
      const shifted = datumToWgs84(lonLat[0], lonLat[1], 0, crs.datum);
      return [shifted[0], shifted[1]];
    }
    return lonLat;
  }

  // WGS84 lon/lat -> map coordinate, for round-tripping and for placing
  // externally-surveyed control points onto the map.
  function fromWgs84(lon, lat, crs) {
    if (!crs) return null;
    const ell = ellipsoidForCrs(crs);
    switch (crs.kind) {
      case 'geographic': return [lon, lat];
      case 'webmercator': return webMercatorForward(lon, lat);
      case 'utm': return utmForward(lon, lat, crs.zone, ell);
      case 'lcc': return lccForward(lon, lat, crs.def, ell);
      case 'india-grid': {
        const def = INDIA_GRID_ZONES[crs.indiaZone];
        return def ? lccForward(lon, lat, def, ell) : null;
      }
      default: return null;
    }
  }

  /* =====================================================================
   * GROUND-DISTANCE UTILITIES
   *
   * Areas and lengths must be measured on the ground, not in grid units.
   * Transverse Mercator grid distance differs from true ground distance by
   * the point scale factor — about 0.4 parts per thousand at a UTM central
   * meridian, growing toward the zone edge. On a 4000 m² plot that is a few
   * square metres, which matters when the output is compared against a
   * recorded area.
   * =================================================================== */
  function utmPointScaleFactor(easting, northing, zone, north, ell) {
    const [lon, lat] = utmInverse(easting, northing, zone, north, ell);
    const { e2, ep2 } = ellipsoidParams(ell);
    const phi = lat * DEG;
    const cosPhi = Math.cos(phi);
    let dLon = (lon - utmCentralMeridian(zone)) * DEG;
    const T = Math.tan(phi) ** 2;
    const C = ep2 * cosPhi * cosPhi;
    const A = dLon * cosPhi;
    void e2;
    // k = k0 * (1 + (1+C)A^2/2 + (5-4T+42C+13C^2-28ep2)A^4/24 + ...)
    return UTM_K0 * (1 + (1 + C) * A * A / 2 +
      (5 - 4 * T + 42 * C + 13 * C * C - 28 * ep2) * Math.pow(A, 4) / 24);
  }

  // Scale factor for whatever CRS is in use, at a given map coordinate.
  // Multiply grid distances by 1/k to get ground distance; areas by 1/k^2.
  function pointScaleFactor(x, y, crs) {
    if (!crs) return 1;
    if (crs.kind === 'utm') {
      return utmPointScaleFactor(x, y, crs.zone, crs.north !== false, ellipsoidForCrs(crs));
    }
    if (crs.kind === 'webmercator') {
      // Web Mercator scale grows as 1/cos(lat) — very large at high latitude.
      const [, lat] = webMercatorInverse(x, y);
      return 1 / Math.cos(lat * DEG);
    }
    return 1; // geographic has no single linear scale; callers use geodesic maths
  }

  // Geodesic distance on the WGS84 ellipsoid (Vincenty inverse), for
  // validating GCP shifts and measuring true ground separations.
  function geodesicDistance(lon1, lat1, lon2, lat2, ell) {
    const { a, f, b } = ellipsoidParams(ell || ELLIPSOIDS.WGS84);
    const L = (lon2 - lon1) * DEG;
    const U1 = Math.atan((1 - f) * Math.tan(lat1 * DEG));
    const U2 = Math.atan((1 - f) * Math.tan(lat2 * DEG));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
    let lambda = L, prev = 0, iter = 0;
    let sinSigma, cosSigma, sigma, sinAlpha, cos2Alpha, cos2SigmaM;
    do {
      const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
      sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
      if (sinSigma === 0) return 0;
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
      sigma = Math.atan2(sinSigma, cosSigma);
      sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
      cos2Alpha = 1 - sinAlpha * sinAlpha;
      cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - 2 * sinU1 * sinU2 / cos2Alpha;
      const C = f / 16 * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
      prev = lambda;
      lambda = L + (1 - C) * f * sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    } while (Math.abs(lambda - prev) > 1e-12 && ++iter < 200);

    const u2 = cos2Alpha * (a * a - b * b) / (b * b);
    const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 *
      (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
        B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    return b * A * (sigma - deltaSigma);
  }

  function describeCrs(crs) {
    if (!crs) return 'not determined';
    return crs.label || crs.kind;
  }

  /* =====================================================================
   * REPROJECTION BETWEEN TWO KNOWN COORDINATE SYSTEMS
   * ---------------------------------------------------------------------
   * Converting from one CRS to another is arithmetic, not a guess, PROVIDED
   * both ends are actually known. That distinction is the whole reason
   * detectCrs refuses to invent a UTM zone: a conversion out of an unknown
   * system is a fabrication, while a conversion out of a declared one is
   * exact. KML and GeoJSON declare WGS 84 lon/lat by specification, so an
   * import from either into a projected session is the second case and should
   * simply be done.
   *
   * WGS 84 lon/lat is the hub: every supported CRS converts to and from it.
   *
   * THE ONE CAVEAT, AND WHY IT IS REPORTED RATHER THAN HIDDEN
   *
   * toWgs84 applies a datum shift when the source datum is not WGS 84;
   * fromWgs84 deliberately does NOT apply the inverse, because published
   * Kalianpur/Everest parameters vary by source and region and are worth tens
   * of metres. That is the project's standing policy — datum shifts are never
   * applied unless explicitly selected. So a conversion INTO a non-WGS 84
   * datum uses that datum's ellipsoid but not its shift, and
   * describeReprojection says so plainly. Silently emitting coordinates tens
   * of metres out, on a cadastral boundary, would be the worst of the
   * available behaviours.
   * =================================================================== */

  /* Do these two describe the same coordinate system? Compared on the fields
   * that actually change the numbers, not by object identity. */
  function crsEquivalent(a, b) {
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    const datumA = a.datum || 'WGS84';
    const datumB = b.datum || 'WGS84';
    if (datumA !== datumB) return false;
    switch (a.kind) {
      case 'utm':
        return a.zone === b.zone && (a.north !== false) === (b.north !== false);
      case 'india-grid':
        return a.indiaZone === b.indiaZone;
      case 'lcc':
        return JSON.stringify(a.def || null) === JSON.stringify(b.def || null);
      default:
        // geographic and webmercator carry no further parameters here.
        return true;
    }
  }

  /* One point, from one CRS to another. Null when either end cannot express
   * it, so a caller can report the failure instead of propagating NaN. */
  function reproject(x, y, fromCrs, toCrs) {
    if (!fromCrs || !toCrs) return null;
    if (crsEquivalent(fromCrs, toCrs)) return [x, y];
    const lonLat = toWgs84(x, y, fromCrs);
    if (!lonLat) return null;
    const out = fromWgs84(lonLat[0], lonLat[1], toCrs);
    if (!out || !isFinite(out[0]) || !isFinite(out[1])) return null;
    return out;
  }

  /* A whole ring. Reports how many vertices could not be converted rather
   * than returning a partly-garbage boundary. */
  function reprojectRing(points, fromCrs, toCrs) {
    if (!Array.isArray(points)) return { ok: false, points: [], failed: 0 };
    if (crsEquivalent(fromCrs, toCrs)) {
      return { ok: true, points: points.map((p) => [p[0], p[1]]), failed: 0, unchanged: true };
    }
    const out = [];
    let failed = 0;
    for (const p of points) {
      const q = reproject(p[0], p[1], fromCrs, toCrs);
      if (q) out.push(q); else failed++;
    }
    return { ok: out.length >= 3, points: out, failed };
  }

  /* What a conversion between these two would do, in words, including the
   * datum caveat where it applies. */
  function describeReprojection(fromCrs, toCrs) {
    if (!fromCrs || !toCrs) {
      return { needed: false, possible: false, exact: false, message: 'One of the coordinate systems is unknown, so nothing can be converted.' };
    }
    if (crsEquivalent(fromCrs, toCrs)) {
      return { needed: false, possible: true, exact: true, message: 'Both are the same coordinate system; no conversion is needed.' };
    }
    const fromDatum = fromCrs.datum || 'WGS84';
    const toDatum = toCrs.datum || 'WGS84';
    const datumCaveat = toDatum !== 'WGS84';
    const base = `Converted from ${describeCrs(fromCrs)} to ${describeCrs(toCrs)}.`;
    if (datumCaveat) {
      return {
        needed: true, possible: true, exact: false, datumCaveat: true,
        message: `${base} The target uses the ${toDatum} datum, and this build applies that datum's ellipsoid but NOT its shift — published parameters vary by source and region and are worth tens of metres. Treat the result as approximate and check it against a known point before relying on it.`,
      };
    }
    return {
      needed: true, possible: true, exact: true, datumCaveat: false,
      fromDatum, toDatum,
      message: `${base} Both use the WGS 84 datum, so the conversion is exact to the precision of the projection maths.`,
    };
  }

  return {
    crsEquivalent, reproject, reprojectRing, describeReprojection,
    DEG, RAD,
    ELLIPSOIDS, DATUMS, INDIA_BBOX, INDIA_STATE_UTM_ZONES, INDIA_GRID_ZONES,
    ellipsoidParams,
    meridianArc, meridionalRadius,
    utmZoneFromLon, utmCentralMeridian, utmForward, utmInverse, utmPointScaleFactor,
    webMercatorForward, webMercatorInverse, WEBMERC_MAX,
    lccForward, lccInverse,
    geodeticToEcef, ecefToGeodetic, helmert, datumToWgs84,
    parseEpsg, stateFromHost, stateFromText,
    classifyFamily, detectCrs, validateAgainstRegion,
    toWgs84, fromWgs84, pointScaleFactor, geodesicDistance, describeCrs,
  };
});
