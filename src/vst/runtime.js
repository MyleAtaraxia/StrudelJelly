// Strudel side of VST support (see CONTRACT.md). Step 1 only streams superdough through the engine
// (src/vst/engine/capture.js); rack(), vst(), .fx() and .set() arrive in steps 2 and 3. These exports already
// have their final shape so the UI can use them.
let last = null;
const listeners = new Set();
window.jelly?.vst?.onRack?.((r) => {
  last = r;
  listeners.forEach((fn) => fn(r));
});

export const lastRack = () => last;
export function onRack(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const paramDiffs = (entry, slot) => [];
