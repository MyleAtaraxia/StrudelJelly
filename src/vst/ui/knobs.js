// "Plugin knobs update code": when on, turning a knob in a plugin window rewrites the value already written in the
// rack({...}) code. Only keys that are already in code are touched; the whole begin -> end gesture is one undo step
// (applied once, at its end); nothing happens while the user is typing inside that entry.
import { findRack, setParams, quote } from '../rack-source.js';
import { api } from './state.js';

export function initKnobs({ view, isOn }) {
  if (!api?.onParamChange) return () => {};
  const active = new Map(); // gesture key -> latest event
  const timers = new Map();
  const keyOf = (e) => `${e.entry}\t${e.slot}\t${e.key}`;

  function apply(e) {
    const v = view();
    const entry = findRack(v.state)?.entries.find((x) => x.name === e.entry);
    const rec = entry?.plugins[e.slot]?.params[e.key];
    if (!rec) return; // not written in code: leave the code alone
    if (v.hasFocus) {
      const head = v.state.selection.main.head;
      if (head >= entry.from && head <= entry.to) return; // typing in that entry
    }
    const asText = /^["'`]/.test(rec.text);
    let text;
    if (asText) {
      if (rec.text.slice(1, -1).trim().toLowerCase() === String(e.text).trim().toLowerCase()) return;
      text = quote(e.text);
    } else {
      const cur = Number(rec.text);
      if (Number.isFinite(cur) && Math.abs(cur - e.value) < 5e-4 * Math.max(1, Math.abs(e.value))) return; // same value, do not reformat
      text = String(+Number(e.value).toFixed(4));
    }
    setParams(v, e.entry, e.slot, { [e.key]: text });
  }

  return api.onParamChange((e) => {
    if (!isOn()) return;
    const k = keyOf(e);
    if (e.gesture === 'begin') {
      active.set(k, e);
      clearTimeout(timers.get(k));
    } else if (e.gesture === 'change') {
      if (active.has(k)) active.set(k, e);
      else {
        // a change without a gesture (automation, a preset): settle, then write once
        clearTimeout(timers.get(k));
        timers.set(k, setTimeout(() => apply(e), 400));
      }
    } else if (e.gesture === 'end') {
      active.delete(k);
      apply(e);
    }
  });
}
