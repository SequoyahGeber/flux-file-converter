const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A manual clock stands in for setTimeout so idle expiry is deterministic.
function harness(createDragTracker, DRAG_IDLE_MS) {
  let now = 0;
  let pending;
  const states = [];
  const timers = {
    setTimeout: (fn, ms) => (pending = { fn, at: now + ms }),
    clearTimeout: (t) => {
      if (pending === t) pending = undefined;
    },
  };
  const tracker = createDragTracker((v) => states.push(v), timers);
  return {
    tracker,
    get showing() {
      return states.at(-1) === true;
    },
    advance(ms) {
      now += ms;
      if (pending && pending.at <= now) {
        const { fn } = pending;
        pending = undefined;
        fn();
      }
    },
    DRAG_IDLE_MS,
  };
}

test('drag overlay clears on drop, native end, window exit, idle and repeated drags', async () => {
  const { createDragTracker, DRAG_IDLE_MS } = await import('../src/dragState.mjs');

  // Drop (or a native drop that never sends drop/dragleave): end() clears it.
  let h = harness(createDragTracker, DRAG_IDLE_MS);
  h.tracker.enter();
  h.tracker.over();
  assert.equal(h.showing, true);
  h.tracker.end();
  assert.equal(h.showing, false);

  // Nested enter/leave pairs only clear once the pointer has left everything.
  h = harness(createDragTracker, DRAG_IDLE_MS);
  h.tracker.enter();
  h.tracker.enter();
  h.tracker.leave();
  assert.equal(h.showing, true);
  h.tracker.leave();
  assert.equal(h.showing, false);

  // Window exit and re-entry shows the overlay again, then drop clears it.
  h.tracker.enter();
  assert.equal(h.showing, true);
  h.tracker.end();
  assert.equal(h.showing, false);

  // A missed dragleave/drop is cleared once dragover stops arriving.
  h = harness(createDragTracker, DRAG_IDLE_MS);
  h.tracker.enter();
  h.advance(DRAG_IDLE_MS - 1);
  h.tracker.over();
  h.advance(DRAG_IDLE_MS - 1);
  assert.equal(h.showing, true);
  h.advance(1);
  assert.equal(h.showing, false);

  // Repeated drops: stale depth from an unmatched enter does not leak into the next drag.
  h = harness(createDragTracker, DRAG_IDLE_MS);
  h.tracker.enter();
  h.tracker.enter();
  h.tracker.end();
  h.tracker.enter();
  h.tracker.leave();
  assert.equal(h.showing, false);
});

test('the Mac web view tells the page when a drag ends and reports a rejected drop', () => {
  const swift = fs.readFileSync(path.join(__dirname, '../mac/Flux/DesktopBridge.swift'), 'utf8');
  const view = swift.slice(swift.indexOf('final class LocalDesktopWebView'));
  for (const hook of ['draggingExited', 'draggingEnded', 'performDragOperation'])
    assert.match(view, new RegExp(`func ${hook}\\b`));
  assert.match(view, /performDragOperation[\s\S]*onDragEnd\?\(\)[\s\S]*onFiles\?\(urls\)/);
  assert.match(swift, /\["dragEnded": true\]/);
  assert.match(swift, /guard !self\.busy else \{ self\.emit\("update", \["bridgeError"/);
  const page = fs.readFileSync(path.join(__dirname, '../src/main.jsx'), 'utf8');
  assert.match(page, /job\.dragEnded/);
});
