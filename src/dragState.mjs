// Tracks whether a file drag is over the window. WebKit does not always send
// `drop` or `dragleave` (the Mac app consumes the drop natively), so the overlay
// also clears on a native end event and when `dragover` stops arriving.
export const DRAG_IDLE_MS = 2000;

export function createDragTracker(setDragging, timers = { setTimeout, clearTimeout }) {
  let depth = 0;
  let timer;
  const stop = () => {
    timers.clearTimeout(timer);
    timer = undefined;
    depth = 0;
    setDragging(false);
  };
  const hold = () => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(stop, DRAG_IDLE_MS);
  };
  return {
    enter() {
      depth++;
      setDragging(true);
      hold();
    },
    over() {
      setDragging(true);
      hold();
    },
    leave() {
      depth--;
      if (depth <= 0) stop();
    },
    end: stop,
  };
}
