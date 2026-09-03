/* =========================================================================
 * lib/history.js — undo / redo over a whole digitising session
 * -------------------------------------------------------------------------
 * Loads as a browser script (window.BND_History) or a CommonJS module. Pure:
 * no DOM, so the stack behaviour is testable headlessly.
 *
 * WHY THIS EXISTS
 *
 * Up to v16.2 only one operation was undoable: placing corners while drawing a
 * polygon by hand. Everything else — deleting a shape, applying a GCP
 * correction, regularising, snapping to a neighbour, dragging a vertex — was
 * final. That is the wrong way round. Drawing a corner is the cheapest mistake
 * in the program to fix; applying a bad transform to forty parcels is the most
 * expensive, and it was the one with no way back.
 *
 * WHY SNAPSHOTS RATHER THAN INVERSE OPERATIONS
 *
 * The tempting design is a command pattern: each operation knows how to undo
 * itself. It is also how this sort of thing usually rots. Every new operation
 * has to remember to implement its own inverse, and the day someone adds one
 * that forgets — or implements the inverse subtly wrong — undo silently
 * corrupts the session instead of failing loudly.
 *
 * A whole-document snapshot cannot be forgotten in that way. There is one
 * function to call before mutating, it captures everything, and a new operation
 * that calls it is automatically undoable with no inverse to write. The cost is
 * memory, so the size is bounded and measurable (see `stats()`); a cadastral
 * session is a few hundred kilobytes of coordinates, which is nothing next to
 * the raster it was traced from.
 *
 * The snapshot is taken via JSON, which also enforces something useful: the
 * session document must stay plain data. Anything that would not survive a
 * round-trip through JSON does not belong in it.
 * ========================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BND_History = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_LIMIT = 50;

  /* Create a history over a document that `read()` returns and `write(doc)`
   * restores. Both operate on plain data; this module never inspects the shape
   * of the document, which is what keeps it decoupled from the app.
   *
   *   read()       -> the current document (any JSON-serialisable value)
   *   write(doc)   -> install a document previously returned by read()
   *   limit        -> how many undo steps to keep (default 50)
   */
  function createHistory(opts) {
    const o = opts || {};
    const read = o.read;
    const write = o.write;
    const limit = o.limit != null ? o.limit : DEFAULT_LIMIT;
    if (typeof read !== 'function' || typeof write !== 'function') {
      throw new Error('createHistory needs read() and write() functions');
    }

    // Each entry: { label, doc } where doc is a JSON string. Storing the
    // serialised form, not the live object, is the whole point: a live
    // reference would keep mutating along with the session and undo would
    // restore the very state it was supposed to escape.
    let past = [];
    let future = [];

    const capture = () => JSON.stringify(read());
    const restore = (json) => write(JSON.parse(json));

    return {
      /* Record the state BEFORE an operation, labelled with what the operation
       * is about to do. Call this at the top of any mutating action.
       *
       * Returns true if a step was recorded. A no-op operation still records —
       * this module cannot tell whether the caller went on to change anything,
       * and refusing to guess is safer than dropping a real step. Callers that
       * know an operation aborted can use `drop()`.
       */
      commit(label) {
        past.push({ label: label || 'change', doc: capture() });
        if (past.length > limit) past.shift();
        // A new action invalidates any redo branch: the future it led to no
        // longer follows from the present.
        future = [];
        return true;
      },

      /* Discard the most recent commit without touching the document. For an
       * operation that committed and then bailed out (nothing selected, user
       * cancelled a confirm), so a dead entry does not sit in the stack
       * pretending to be undoable work.
       */
      drop() {
        if (!past.length) return false;
        past.pop();
        return true;
      },

      canUndo() { return past.length > 0; },
      canRedo() { return future.length > 0; },

      /* What undo would reverse, and what redo would reapply — so the UI can
       * name the button ("Undo apply to 12 shapes") instead of leaving the
       * operator to find out by pressing it.
       */
      undoLabel() { return past.length ? past[past.length - 1].label : null; },
      redoLabel() { return future.length ? future[future.length - 1].label : null; },

      undo() {
        if (!past.length) return null;
        const entry = past.pop();
        // Before stepping back, record where we were so redo can return here.
        future.push({ label: entry.label, doc: capture() });
        restore(entry.doc);
        return entry.label;
      },

      redo() {
        if (!future.length) return null;
        const entry = future.pop();
        past.push({ label: entry.label, doc: capture() });
        restore(entry.doc);
        return entry.label;
      },

      /* Forget everything. Used by a full session reset: keeping undo across a
       * deliberate wipe would let a "clear everything" be silently half-undone.
       */
      clear() { past = []; future = []; },

      /* Honest reporting rather than a promise that memory is free. */
      stats() {
        const bytes = past.concat(future).reduce((n, e) => n + e.doc.length, 0);
        return {
          undoDepth: past.length,
          redoDepth: future.length,
          limit,
          approxBytes: bytes,
        };
      },
    };
  }

  return { createHistory, DEFAULT_LIMIT };
});
