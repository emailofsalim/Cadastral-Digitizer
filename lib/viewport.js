/* =========================================================================
 * Pan/zoom viewport model for a static raster (scanned sheet, photo, PDF page).
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_Viewport) or a CommonJS module. Pure:
 * no DOM, so the coordinate maths is testable headlessly.
 *
 * WHY THIS EXISTS
 *
 * The digitizer has always needed a live web map underneath it. But a great
 * deal of cadastral material is not a web map at all — it is a scanned sheet, a
 * photographed register page, or a PDF. Those have no OpenLayers instance to
 * talk to, so none of the tooling could touch them.
 *
 * The fix is not to special-case images throughout the app. It is to give a
 * static raster the SAME interface a live map exposes (screen pixel <-> world
 * coordinate, zoom, centre, a render signal), at which point every existing
 * tool — tracing, control points, regularisation, topology, all the exporters —
 * works on it unchanged. This module is the coordinate half of that; the DOM
 * shell is in raster_workspace.js.
 *
 * Coordinates here are IMAGE PIXELS, with y increasing downward as rasters do.
 * Georeferencing to a real CRS is a separate, later step: an image is honestly
 * just pixels until control points say otherwise.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_Viewport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const MIN_SCALE = 1 / 64;   // zoomed far out
  const MAX_SCALE = 64;       // 64 screen pixels per image pixel

  /* Create a viewport over an image of `imageWidth` x `imageHeight` pixels,
   * displayed in a view of `viewWidth` x `viewHeight` screen pixels.
   *
   * State is (centre, scale): the image coordinate sitting at the middle of the
   * view, and how many screen pixels one image pixel occupies. Centre-based
   * rather than corner-based because every operation that matters — zooming
   * about the cursor, resizing the window, fitting to view — is natural about a
   * centre and fiddly about a corner.
   */
  function createViewport(opts) {
    const o = opts || {};
    const state = {
      imageWidth: Math.max(1, o.imageWidth || 1),
      imageHeight: Math.max(1, o.imageHeight || 1),
      viewWidth: Math.max(1, o.viewWidth || 1),
      viewHeight: Math.max(1, o.viewHeight || 1),
      centre: null,
      scale: null,
      minScale: o.minScale || MIN_SCALE,
      maxScale: o.maxScale || MAX_SCALE,
    };

    const api = {
      get imageWidth() { return state.imageWidth; },
      get imageHeight() { return state.imageHeight; },
      get viewWidth() { return state.viewWidth; },
      get viewHeight() { return state.viewHeight; },
      get scale() { return state.scale; },
      get centre() { return state.centre.slice(); },

      /* Scale expressed the way a slippy map expresses zoom, so the raster
       * workspace can satisfy the same adapter contract as a live map: each
       * whole step is a factor of two.
       */
      getZoom() { return Math.log2(state.scale); },
      setZoom(z) { api.setScale(Math.pow(2, z)); return api; },

      setScale(s) {
        state.scale = clamp(s, state.minScale, state.maxScale);
        api.clampCentre();
        return api;
      },

      setCentre(c) {
        state.centre = [c[0], c[1]];
        api.clampCentre();
        return api;
      },

      setViewSize(w, h) {
        state.viewWidth = Math.max(1, w);
        state.viewHeight = Math.max(1, h);
        api.clampCentre();
        return api;
      },

      // Scale so the whole image is visible, centred, with optional padding.
      fitToView(padding) {
        const pad = padding == null ? 0.02 : padding;
        const sx = (state.viewWidth * (1 - pad)) / state.imageWidth;
        const sy = (state.viewHeight * (1 - pad)) / state.imageHeight;
        state.scale = clamp(Math.min(sx, sy), state.minScale, state.maxScale);
        state.centre = [state.imageWidth / 2, state.imageHeight / 2];
        return api;
      },

      /* Screen point (relative to the view's top-left) -> image pixel. */
      toImage(sx, sy) {
        return [
          (sx - state.viewWidth / 2) / state.scale + state.centre[0],
          (sy - state.viewHeight / 2) / state.scale + state.centre[1],
        ];
      },

      /* Image pixel -> screen point relative to the view's top-left. */
      toScreen(ix, iy) {
        return [
          (ix - state.centre[0]) * state.scale + state.viewWidth / 2,
          (iy - state.centre[1]) * state.scale + state.viewHeight / 2,
        ];
      },

      /* Zoom by `factor` while keeping the image point currently under
       * (sx, sy) pinned to that same screen position. This is what makes
       * wheel-zoom feel correct: the thing under the cursor stays under it.
       */
      zoomAt(sx, sy, factor) {
        const before = api.toImage(sx, sy);
        state.scale = clamp(state.scale * factor, state.minScale, state.maxScale);
        const after = api.toImage(sx, sy);
        state.centre = [
          state.centre[0] + (before[0] - after[0]),
          state.centre[1] + (before[1] - after[1]),
        ];
        api.clampCentre();
        return api;
      },

      /* Drag the image by a screen-pixel delta. */
      panByScreen(dx, dy) {
        state.centre = [
          state.centre[0] - dx / state.scale,
          state.centre[1] - dy / state.scale,
        ];
        api.clampCentre();
        return api;
      },

      /* Keep the image reachable. Once it is smaller than the view it is
       * pinned centred, otherwise the centre is bounded so at least a quarter
       * of the view is always covered — panning the sheet completely off screen
       * and losing it is a real and irritating failure.
       */
      clampCentre() {
        if (!state.centre) state.centre = [state.imageWidth / 2, state.imageHeight / 2];
        const halfViewW = state.viewWidth / (2 * state.scale);
        const halfViewH = state.viewHeight / (2 * state.scale);
        if (state.imageWidth * state.scale <= state.viewWidth) {
          state.centre[0] = state.imageWidth / 2;
        } else {
          state.centre[0] = clamp(state.centre[0], halfViewW * 0.5, state.imageWidth - halfViewW * 0.5);
        }
        if (state.imageHeight * state.scale <= state.viewHeight) {
          state.centre[1] = state.imageHeight / 2;
        } else {
          state.centre[1] = clamp(state.centre[1], halfViewH * 0.5, state.imageHeight - halfViewH * 0.5);
        }
        return api;
      },

      /* The image-space rectangle currently visible, clipped to the image. */
      visibleImageRect() {
        const tl = api.toImage(0, 0);
        const br = api.toImage(state.viewWidth, state.viewHeight);
        return {
          minX: clamp(Math.floor(tl[0]), 0, state.imageWidth),
          minY: clamp(Math.floor(tl[1]), 0, state.imageHeight),
          maxX: clamp(Math.ceil(br[0]), 0, state.imageWidth),
          maxY: clamp(Math.ceil(br[1]), 0, state.imageHeight),
        };
      },

      isVisible(ix, iy) {
        const s = api.toScreen(ix, iy);
        return s[0] >= 0 && s[1] >= 0 && s[0] <= state.viewWidth && s[1] <= state.viewHeight;
      },

      // Ground resolution equivalent: how many image pixels one screen pixel
      // covers. Below 1 you are magnifying, above 1 you are decimating and
      // clicking is no longer pixel-accurate.
      imagePixelsPerScreenPixel() { return 1 / state.scale; },
    };

    api.fitToView(o.padding);
    if (o.scale) api.setScale(o.scale);
    if (o.centre) api.setCentre(o.centre);
    return api;
  }

  return { createViewport, MIN_SCALE, MAX_SCALE };
});
