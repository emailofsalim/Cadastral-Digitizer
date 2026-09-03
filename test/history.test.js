/* =========================================================================
 * Tests for lib/history.js
 *
 * The thing worth testing here is not that a stack pops. It is that undo
 * genuinely detaches from the live document — the classic bug in a snapshot
 * history is storing a reference, so the "old" state mutates along with the new
 * one and undo restores nothing.
 * ========================================================================= */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('../lib/history.js');

/* A stand-in for the session document: shapes with coordinate rings. */
function makeDoc() {
  return {
    shapes: [{ id: 1, points: [[0, 0], [10, 0], [10, 10]] }],
    gcps: [],
    nextShapeId: 2,
  };
}

/* Wire a history to a mutable document, the way page_inject.js does. */
function harness(limit) {
  const state = { doc: makeDoc() };
  const hist = H.createHistory({
    read: () => state.doc,
    write: (d) => { state.doc = d; },
    limit,
  });
  return { state, hist };
}

test('createHistory refuses to be built without read and write', () => {
  assert.throws(() => H.createHistory({}), /read\(\) and write\(\)/);
  assert.throws(() => H.createHistory({ read: () => 1 }), /read\(\) and write\(\)/);
});

test('a fresh history has nothing to undo or redo', () => {
  const { hist } = harness();
  assert.strictEqual(hist.canUndo(), false);
  assert.strictEqual(hist.canRedo(), false);
  assert.strictEqual(hist.undo(), null);
  assert.strictEqual(hist.redo(), null);
  assert.strictEqual(hist.undoLabel(), null);
});

test('undo restores the document as it was before the operation', () => {
  const { state, hist } = harness();
  hist.commit('delete shape');
  state.doc.shapes = [];
  assert.strictEqual(state.doc.shapes.length, 0);

  assert.strictEqual(hist.undo(), 'delete shape');
  assert.strictEqual(state.doc.shapes.length, 1);
  assert.deepStrictEqual(state.doc.shapes[0].points[1], [10, 0]);
});

test('the snapshot is detached: mutating the live document in place cannot corrupt it', () => {
  // This is the bug the module exists to be immune to. A history that stored
  // `read()` by reference would see this in-place edit apply to its own copy,
  // and undo would restore the edited coordinates.
  const { state, hist } = harness();
  hist.commit('drag vertex');
  state.doc.shapes[0].points[0][0] = 999;   // mutate deep, in place
  state.doc.shapes[0].points.push([0, 10]);

  hist.undo();
  assert.strictEqual(state.doc.shapes[0].points[0][0], 0,
    'the original coordinate must come back, not the mutated one');
  assert.strictEqual(state.doc.shapes[0].points.length, 3,
    'and the appended vertex must be gone');
});

test('redo reapplies what undo reversed', () => {
  const { state, hist } = harness();
  hist.commit('regularise');
  state.doc.shapes[0].points = [[1, 1]];

  hist.undo();
  assert.strictEqual(state.doc.shapes[0].points.length, 3);
  assert.strictEqual(hist.canRedo(), true);

  assert.strictEqual(hist.redo(), 'regularise');
  assert.deepStrictEqual(state.doc.shapes[0].points, [[1, 1]]);
});

test('a new operation abandons the redo branch', () => {
  // Undoing then doing something else must not leave a stale redo pointing at a
  // future that no longer follows from the present.
  const { state, hist } = harness();
  hist.commit('a');
  state.doc.nextShapeId = 3;
  hist.undo();
  assert.strictEqual(hist.canRedo(), true);

  hist.commit('b');
  assert.strictEqual(hist.canRedo(), false, 'the old redo branch must be dropped');
});

test('several operations undo and redo in order, all the way back', () => {
  const { state, hist } = harness();
  const seen = [];
  for (const label of ['one', 'two', 'three']) {
    hist.commit(label);
    state.doc.shapes.push({ id: state.doc.nextShapeId++, points: [], tag: label });
  }
  assert.strictEqual(state.doc.shapes.length, 4);

  while (hist.canUndo()) seen.push(hist.undo());
  assert.deepStrictEqual(seen, ['three', 'two', 'one'], 'undo runs newest first');
  assert.strictEqual(state.doc.shapes.length, 1, 'and lands on the original document');

  while (hist.canRedo()) hist.redo();
  assert.strictEqual(state.doc.shapes.length, 4, 'redo replays all the way forward');
  assert.deepStrictEqual(state.doc.shapes.map((s) => s.tag),
    [undefined, 'one', 'two', 'three']);
});

test('labels tell the operator what undo would reverse', () => {
  const { hist } = harness();
  hist.commit('apply translation to 12 shape(s)');
  assert.strictEqual(hist.undoLabel(), 'apply translation to 12 shape(s)');
  hist.undo();
  assert.strictEqual(hist.redoLabel(), 'apply translation to 12 shape(s)');
  assert.strictEqual(hist.undoLabel(), null);
});

test('the stack is bounded, and it discards the oldest step', () => {
  const { state, hist } = harness(3);
  for (const label of ['a', 'b', 'c', 'd', 'e']) {
    hist.commit(label);
    state.doc.nextShapeId++;
  }
  assert.strictEqual(hist.stats().undoDepth, 3, 'the limit must be respected');
  const labels = [];
  while (hist.canUndo()) labels.push(hist.undo());
  assert.deepStrictEqual(labels, ['e', 'd', 'c'], 'the oldest steps are the ones dropped');
});

test('drop removes a committed step for an operation that then bailed out', () => {
  const { state, hist } = harness();
  hist.commit('snap to neighbours');
  // ...operation finds nothing to snap and returns without touching anything.
  assert.strictEqual(hist.drop(), true);
  assert.strictEqual(hist.canUndo(), false,
    'an aborted operation must not leave a phantom undo step');
  assert.strictEqual(hist.drop(), false, 'and dropping an empty stack is a no-op');
  assert.strictEqual(state.doc.shapes.length, 1, 'drop must never alter the document');
});

test('clear forgets both directions', () => {
  const { state, hist } = harness();
  hist.commit('x');
  state.doc.shapes = [];
  hist.undo();
  hist.clear();
  assert.strictEqual(hist.canUndo(), false);
  assert.strictEqual(hist.canRedo(), false);
});

test('stats report memory honestly rather than pretending it is free', () => {
  const { state, hist } = harness();
  assert.strictEqual(hist.stats().approxBytes, 0);
  hist.commit('big');
  const s = hist.stats();
  assert.ok(s.approxBytes > 0, 'a snapshot costs bytes and must say so');
  assert.strictEqual(s.limit, H.DEFAULT_LIMIT);
  assert.strictEqual(s.undoDepth, 1);
  assert.strictEqual(s.redoDepth, 0);
  state.doc.shapes = [];
  hist.undo();
  assert.strictEqual(hist.stats().redoDepth, 1);
});

test('a document that JSON cannot represent is rejected at commit, not silently mangled', () => {
  // Enforcing "the session document is plain data" is a feature: it is what
  // makes autosave, project export and undo all agree on what a session is.
  const state = { doc: {} };
  state.doc.self = state.doc;   // circular
  const hist = H.createHistory({ read: () => state.doc, write: (d) => { state.doc = d; } });
  assert.throws(() => hist.commit('circular'), /circular|convert/i);
});
