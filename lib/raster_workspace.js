/* =========================================================================
 * Raster workspace — digitize a scanned sheet, photo or PDF page.
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Raster) or a CommonJS module.
 *
 * WHAT THIS IS
 *
 * A static image, presented through EXACTLY the interface a live web map
 * exposes. Because it satisfies the same adapter contract, every existing tool
 * works on it with no changes at all: colour tracing, manual drawing, the
 * vertex editor, control points, regularisation, snapping, topology checks,
 * quality scoring and all seven export formats.
 *
 * That is the entire design argument for having an adapter layer. Adding
 * support for a completely different kind of source is one new adapter, not a
 * special case threaded through the application.
 *
 * WHERE THE IMAGE COMES FROM
 *
 *  1. A file the user picks — a scanned cadastral sheet, a photograph.
 *  2. An image already on the page.
 *  3. A capture of the visible tab.
 *
 * Case 3 is how PDFs are supported, and the reasoning is worth stating.
 * Chrome renders PDFs in an internal PDFium viewer that extensions cannot read
 * pixels from — there is no canvas to sample and no DOM to inspect. Bundling a
 * PDF renderer would mean shipping about a megabyte of third-party code that
 * cannot be tested here. Capturing the rendered tab sidesteps both problems: the
 * browser has already done the rasterising, and the same mechanism rescues any
 * cross-origin-tainted map canvas that colour tracing could not otherwise read.
 *
 * The honest limitation of a capture is that it is screen resolution, not source
 * resolution. Zoom the PDF up before capturing, and capture in sections for a
 * large sheet.
 *
 * COORDINATES
 *
 * Workspace coordinates are image pixels, y downward. An image is honestly just
 * pixels until control points say otherwise, so georeferencing is a separate,
 * explicit step handled by the caller — the same least-squares machinery used to
 * correct a live map, with typed real-world coordinates as the targets.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Raster = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONTAINER_ID = 'bnd15-raster-workspace';
  const isFn = (v) => typeof v === 'function';
  const safe = (fn, fb) => { try { return fn(); } catch (e) { return fb === undefined ? null : fb; } };

  /* Build the workspace. `deps` is injected so this is testable without a
   * browser: { doc, win, Viewport, image: {width, height, drawable} }.
   *
   * `drawable` is anything canvas drawImage accepts — an HTMLImageElement, an
   * ImageBitmap, or a canvas. In tests it is a stub.
   */
  function createRasterWorkspace(deps) {
    const doc = deps.doc;
    const win = deps.win;
    const Viewport = deps.Viewport || (win && win.BND_Viewport);
    const image = deps.image;
    if (!Viewport || !isFn(Viewport.createViewport)) {
      return { ok: false, error: 'lib/viewport.js is not loaded.' };
    }
    if (!image || !(image.width > 0) || !(image.height > 0)) {
      return { ok: false, error: 'The image has no usable dimensions.' };
    }

    const sourceName = deps.sourceName || 'image';
    const sourceKind = deps.sourceKind || 'file';
    const listeners = [];
    let destroyed = false;

    /* ---- DOM shell ---------------------------------------------------- */
    const container = doc.createElement('div');
    container.id = CONTAINER_ID;
    // Sits above the page but below the widget, and takes pointer events so the
    // page underneath is fully inert while a workspace is open.
    container.setAttribute('style',
      'position:fixed;inset:0;z-index:2147483640;background:#0b1220;overflow:hidden;cursor:grab;');

    const canvas = doc.createElement('canvas');
    canvas.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;display:block;');
    container.appendChild(canvas);

    const badge = doc.createElement('div');
    badge.setAttribute('style',
      'position:absolute;left:10px;top:10px;padding:5px 9px;border-radius:7px;' +
      'background:rgba(2,6,23,.82);color:#cbd5e1;font:600 11px/1.4 "Segoe UI",Arial,sans-serif;' +
      'pointer-events:none;white-space:pre;');
    container.appendChild(badge);

    if (doc.body) doc.body.appendChild(container);

    const viewW = () => (container.clientWidth || (win && win.innerWidth) || 1200);
    const viewH = () => (container.clientHeight || (win && win.innerHeight) || 800);

    const viewport = Viewport.createViewport({
      imageWidth: image.width,
      imageHeight: image.height,
      viewWidth: viewW(),
      viewHeight: viewH(),
      padding: 0.06,
    });

    /* ---- Full-resolution offscreen copy, for tracing ------------------
     * Tracing reads this, not the on-screen canvas, so the pixels sampled are
     * always the image's native resolution regardless of display zoom. A live
     * map has to zoom in to gain resolution; a raster already has all of it.
     */
    let full = null;
    function fullResCanvas() {
      if (full) return full;
      full = doc.createElement('canvas');
      full.width = image.width;
      full.height = image.height;
      const fctx = full.getContext('2d', { willReadFrequently: true });
      if (fctx && image.drawable) {
        safe(() => fctx.drawImage(image.drawable, 0, 0, image.width, image.height));
      }
      return full;
    }

    /* ---- Rendering ---------------------------------------------------- */
    let dpr = 1;
    function resize() {
      dpr = (win && win.devicePixelRatio) || 1;
      const w = Math.max(1, Math.round(viewW() * dpr));
      const h = Math.max(1, Math.round(viewH() * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      viewport.setViewSize(viewW(), viewH());
    }

    function render() {
      if (destroyed) return;
      resize();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const tl = viewport.toScreen(0, 0);
      const s = viewport.scale;
      // Crisp pixels when magnifying: a smoothed image invites clicking on
      // interpolated colour that does not exist in the source.
      ctx.imageSmoothingEnabled = s < 1;
      if (image.drawable) {
        safe(() => ctx.drawImage(
          image.drawable,
          0, 0, image.width, image.height,
          tl[0] * dpr, tl[1] * dpr, image.width * s * dpr, image.height * s * dpr));
      }
      updateBadge();
      for (const cb of listeners.slice()) safe(() => cb());
    }

    function updateBadge() {
      const ipsp = viewport.imagePixelsPerScreenPixel();
      const accuracy = ipsp <= 1
        ? `1 screen px = ${ipsp.toFixed(2)} image px`
        : `⚠ 1 screen px = ${ipsp.toFixed(1)} image px — zoom in for pixel-accurate clicks`;
      badge.textContent =
        `${sourceName}  ·  ${image.width}×${image.height} px  ·  zoom ${viewport.getZoom().toFixed(2)}\n${accuracy}`;
    }

    /* ---- Pan and zoom -------------------------------------------------
     * Attached in the BUBBLE phase deliberately. The digitizer's gesture layer
     * listens in the capture phase and stops propagation only when a drag grabs
     * a handle, so a handle drag never pans the sheet, while a drag on empty
     * space does.
     */
    let dragging = null;
    /* A locked sheet cannot be panned or zoomed, so a calibrated and
     * georeferenced drawing cannot be nudged out of place by a stray drag.
     * Locking stops the SHEET moving; it does not stop digitizing on it, which
     * is why it gates these handlers rather than the container's pointer
     * events. */
    let locked = false;
    function onWheel(e) {
      if (locked) return;
      e.preventDefault();
      const r = container.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      viewport.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
      render();
    }
    function onDown(e) {
      if (locked || e.button !== 0) return;
      dragging = { x: e.clientX, y: e.clientY };
      container.style.cursor = 'grabbing';
    }
    function onMove(e) {
      if (!dragging || locked) return;
      viewport.panByScreen(e.clientX - dragging.x, e.clientY - dragging.y);
      dragging = { x: e.clientX, y: e.clientY };
      render();
    }
    function onUp() {
      dragging = null;
      container.style.cursor = 'grab';
    }
    function onResize() { render(); }

    if (isFn(container.addEventListener)) {
      container.addEventListener('wheel', onWheel, { passive: false });
      container.addEventListener('pointerdown', onDown);
    }
    if (win && isFn(win.addEventListener)) {
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', onUp);
      win.addEventListener('resize', onResize);
    }

    render();

    /* ---- Adapter surface ---------------------------------------------- */
    const rect = () => (isFn(container.getBoundingClientRect)
      ? container.getBoundingClientRect()
      : { left: 0, top: 0, width: viewW(), height: viewH() });

    const adapter = {
      id: 'raster',
      label: `Image workspace (${sourceKind})`,
      isRaster: true,
      sourceName,
      sourceKind,
      imageWidth: image.width,
      imageHeight: image.height,
      mapObject: null,
      // Pixels, not longitude and latitude. Saying otherwise would let the CRS
      // layer conclude something false about them.
      coordsAreLonLat: false,

      getContainer: () => container,
      getCanvas: () => fullResCanvas(),

      // Workspace "map coordinates" are image pixels.
      clientToMapCoord(clientX, clientY) {
        const r = rect();
        return viewport.toImage(clientX - r.left, clientY - r.top);
      },
      mapCoordToClient(x, y) {
        const r = rect();
        const s = viewport.toScreen(x, y);
        return [s[0] + r.left, s[1] + r.top];
      },

      // Canvas-pixel mapping is the identity on image coordinates here, because
      // getCanvas() is the image at native resolution.
      clientToCanvasPixel(clientX, clientY) {
        return adapter.clientToMapCoord(clientX, clientY);
      },
      canvasPixelToClient(px, py) {
        return adapter.mapCoordToClient(px, py);
      },

      getZoom: () => viewport.getZoom(),
      setZoom: (z) => { viewport.setZoom(z); render(); },
      getCenter: () => viewport.centre,
      setCenter: (c) => { viewport.setCentre(c); render(); },
      getMaxZoom: () => Math.log2(Viewport.MAX_SCALE),
      getMinZoom: () => Math.log2(Viewport.MIN_SCALE),
      setZoomRange() {},
      getResolution: () => viewport.imagePixelsPerScreenPixel(),
      fitToView() { viewport.fitToView(0.06); render(); },

      // No projection is claimed. An image is pixels until told otherwise.
      getProjectionCode: () => null,
      getTileUrls: () => [],

      onRender(cb) {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      // Nothing to wait for: the raster is already fully present.
      waitForRender: () => Promise.resolve(),

      redraw: render,
      viewport,

      /* Lock the sheet in place. Digitizing, tracing and every tool keep
       * working; only panning and zooming the underlay stop. */
      setLocked(v) {
        locked = !!v;
        container.style.cursor = locked ? 'default' : 'grab';
        return locked;
      },
      isLocked: () => locked,

      /* Display-only presentation of the underlay: how strongly it is drawn,
       * and how it is turned on screen. Neither touches a coordinate — a
       * rotation here moves no digitized vertex, which is why it is applied to
       * the canvas element and not to the viewport. */
      setDisplayStyle(opts) {
        const o = opts || {};
        if (o.opacity != null) canvas.style.opacity = String(o.opacity);
        if (o.rotationDeg != null) {
          const r = Number(o.rotationDeg) || 0;
          canvas.style.transform = r ? `rotate(${r}deg)` : '';
        }
        return true;
      },

      portal: { id: 'raster', label: 'Image / PDF workspace', plotCapture: 'none' },

      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (isFn(container.removeEventListener)) {
          container.removeEventListener('wheel', onWheel);
          container.removeEventListener('pointerdown', onDown);
        }
        if (win && isFn(win.removeEventListener)) {
          win.removeEventListener('pointermove', onMove);
          win.removeEventListener('pointerup', onUp);
          win.removeEventListener('resize', onResize);
        }
        if (container.parentNode) container.parentNode.removeChild(container);
        listeners.length = 0;
        full = null;
      },
    };

    return { ok: true, adapter };
  }

  /* =====================================================================
   * IMAGE DISCOVERY on the current page.
   *
   * A directly-opened image is the common case and is the easy one: the
   * document URL IS the image URL, so it is same-origin and its pixels are
   * readable. Images embedded from another origin are not, and are reported as
   * such rather than failing mysteriously at trace time.
   * =================================================================== */
  function findPageImages(doc, win) {
    const out = [];
    const imgs = safe(() => Array.prototype.slice.call(doc.images || []), []) || [];
    for (const img of imgs) {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 64 || h < 64) continue; // icons and spacers
      let sameOrigin = true;
      const src = String(img.currentSrc || img.src || '');
      if (/^https?:/i.test(src)) {
        const pageOrigin = safe(() => win.location.origin, '');
        sameOrigin = src.indexOf(pageOrigin) === 0;
      }
      out.push({
        element: img, width: w, height: h, src,
        sameOrigin,
        area: w * h,
        note: sameOrigin ? null
          : 'Loaded from another origin, so the browser will not let its pixels be read. Use Capture tab instead.',
      });
    }
    out.sort((a, b) => b.area - a.area);
    return out;
  }

  // Is this document just a single image the browser opened directly?
  function isStandaloneImageDocument(doc) {
    const t = String(safe(() => doc.contentType, '') || '');
    if (/^image\//i.test(t)) return true;
    const imgs = safe(() => doc.images, null);
    return !!(imgs && imgs.length === 1 &&
      safe(() => doc.body && doc.body.children.length === 1, false));
  }

  function looksLikePdf(doc, win) {
    const url = String(safe(() => win.location.href, '') || '');
    if (/\.pdf(\?|#|$)/i.test(url)) return true;
    const t = String(safe(() => doc.contentType, '') || '');
    if (/pdf/i.test(t)) return true;
    return !!safe(() => doc.querySelector('embed[type="application/pdf"], object[type="application/pdf"]'), null);
  }

  /* Load a data URL or blob URL into something drawable, with its dimensions.
   * Kept here so both the file picker and the tab capture path share it.
   */
  function loadImageSource(doc, url) {
    return new Promise((resolve) => {
      const img = doc.createElement('img');
      img.onload = () => resolve({
        ok: true,
        image: { width: img.naturalWidth, height: img.naturalHeight, drawable: img },
      });
      img.onerror = () => resolve({ ok: false, error: 'The browser could not decode that image.' });
      img.src = url;
    });
  }

  /* Decode a user-picked image FILE into something drawable.
   * -----------------------------------------------------------------------
   * WHY THIS IS NOT JUST "MAKE A URL AND POINT AN <img> AT IT"
   *
   * That is what the import used to do, and it failed on real portals with a
   * decode error even though the file was a perfectly ordinary PNG. Two
   * separate reasons, both invisible from the message:
   *
   *  - The <img> is created in the PAGE's document, so the PAGE's
   *    Content-Security-Policy decides what it is allowed to load. A portal
   *    serving `img-src 'self' data:` blocks a blob: URL outright. The bytes
   *    are fine; the page simply refuses to load them, and the browser reports
   *    it as onerror — indistinguishable from a corrupt file.
   *  - A file:// path is not fetchable from a page context at all, so treating
   *    the picked file as a URL cannot work for a local image.
   *
   * createImageBitmap reads the File's BYTES. There is no URL, so no CSP
   * applies, nothing is fetched, and the local filesystem is never treated as
   * an ordinary HTTP source. It is also the only path that can decode a file
   * the page's own policy would refuse to load.
   *
   * The object-URL <img> path is kept as a fallback for engines without
   * createImageBitmap, unchanged, and it returns the URL it minted so the
   * caller can keep owning its lifetime exactly as before — an object URL pins
   * the whole file in memory until it is revoked.
   */
  async function loadImageFile(doc, file, win) {
    if (!file) return { ok: false, error: 'No file was selected.', objectUrl: null };
    const name = String(file.name || 'that file');
    const type = String(file.type || '');
    // Type first, name second: a file that arrives by email or a messaging app
    // routinely has one of the two wrong, so neither alone may veto.
    if (type && !/^image\//i.test(type) && !/\.(png|jpe?g|webp|gif|bmp|avif|ico)$/i.test(name)) {
      return { ok: false, error: `${name} is not an image the browser can open.`, objectUrl: null };
    }

    const w = win || (typeof window !== 'undefined' ? window : null);
    if (w && isFn(w.createImageBitmap)) {
      const bmp = await (async () => {
        try { return await w.createImageBitmap(file); } catch (e) { return null; }
      })();
      // A zero-sized bitmap is a decode that technically resolved and produced
      // nothing usable; the workspace would mount an empty sheet.
      if (bmp && bmp.width > 0 && bmp.height > 0) {
        return { ok: true, image: { width: bmp.width, height: bmp.height, drawable: bmp }, objectUrl: null };
      }
    }

    const url = safe(() => w && w.URL && w.URL.createObjectURL(file), null);
    if (!url) {
      return { ok: false, error: `${name} could not be opened — this browser gave no way to read the file.`, objectUrl: null };
    }
    const loaded = await loadImageSource(doc, url);
    if (!loaded.ok || !loaded.image || !(loaded.image.width > 0) || !(loaded.image.height > 0)) {
      // Nothing downstream ever saw this URL, so releasing it here is safe and
      // is the only chance to: a failed import must not pin the file.
      safe(() => w.URL.revokeObjectURL(url));
      return {
        ok: false,
        error: `${name} could not be decoded. The file may be damaged, or in a format this browser does not read.`,
        objectUrl: null,
      };
    }
    // Ownership passes to the caller with the image, still un-revoked: the
    // <img> is drawn from later, and the workspace releases it when the sheet
    // is replaced or closed.
    return { ok: true, image: loaded.image, objectUrl: url };
  }

  /* Turn a data: URL into a Blob without fetch().
   *
   * The capture path receives a data: URL from the extension worker and needs
   * it decoded. Going through fetch() or an <img> src would put it back under
   * the page's Content-Security-Policy — the same trap loadImageFile exists to
   * avoid — so the base64 is decoded here and handed to the same File path. */
  function dataUrlToBlob(dataUrl, win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    if (comma < 0 || !w || !isFn(w.atob) || typeof Blob === 'undefined') return null;
    const meta = s.slice(0, comma);
    if (!/;base64/i.test(meta)) return null;
    const mime = (meta.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
    return safe(() => {
      const bin = w.atob(s.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }, null);
  }

  return {
    CONTAINER_ID,
    createRasterWorkspace,
    findPageImages,
    isStandaloneImageDocument,
    looksLikePdf,
    loadImageSource,
    loadImageFile,
    dataUrlToBlob,
  };
});
