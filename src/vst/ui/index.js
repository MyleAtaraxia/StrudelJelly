import './vst.css';
// The VST side of the editor: autocomplete, status pills, hover card, Ctrl+click and "knobs update code".
//
// Importing this module patches the editor extension table of @strudel/codemirror BEFORE the editor is created:
//   isAutoCompletionEnabled  gets a completion source that runs ahead of Strudel's own (complete.js)
//   isTooltipEnabled         (always off in this app, Strudel's hover is replaced by the docs card) also carries the
//                            pill field and the Ctrl+click handler, so they are part of every sketch's EditorState
// Both are reapplied by StrudelMirror.updateSettings, which is what makes them survive switching sketches.
import { extensions } from '@strudel/codemirror';
import { autocompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { findRack, findVstCalls, findNameUses } from '../rack-source.js';
import { api, startState, onRack } from './state.js';
import { mergeSources, chipOption } from './complete.js';
import { pillField, refreshPills } from './pills.js';
import { initHover, groupOf } from './hover.js';
import { initKnobs } from './knobs.js';

const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : [x]);

// is the pointer really over [from, to]? posAtCoords snaps to the nearest character
function over(view, from, to, x, y) {
  const a = view.coordsAtPos(from);
  const b = view.coordsAtPos(to);
  return !!a && !!b && x >= a.left - 1 && x <= b.right + 1 && y >= a.top - 1 && y <= b.bottom + 1;
}

// what does Ctrl+click at this spot mean? -> { group, slot } | null
export function targetAt(view, x, y) {
  const state = view.state;
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  const rack = findRack(state);
  if (rack) {
    for (const e of rack.entries) if (pos >= e.nameFrom && pos <= e.nameTo && over(view, e.nameFrom, e.nameTo, x, y)) return e.plugins.length ? { group: e.name, slot: 0 } : null;
  }
  for (const c of findVstCalls(state)) {
    if (c.nameFrom >= 0 && pos >= c.nameFrom && pos <= c.nameTo && over(view, c.nameFrom, c.nameTo, x, y)) {
      const g = groupOf(state, c);
      return g ? { group: g.group, slot: g.slot } : null;
    }
  }
  if (rack) {
    for (const u of findNameUses(state)) {
      if (pos >= u.from && pos <= u.to && over(view, u.from, u.to, x, y) && rack.entries.some((e) => e.name === u.text)) return { group: u.text, slot: 0 };
    }
  }
  return null;
}

const ctrlClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
    const t = targetAt(view, e.clientX, e.clientY);
    if (!t) return false;
    e.preventDefault();
    api.openEditor(t.group, t.slot);
    return true;
  },
});

function install() {
  if (!api) return;
  const origAuto = extensions.isAutoCompletionEnabled;
  let strudelSource = null;
  extensions.isAutoCompletionEnabled = (on, ed) => {
    const base = origAuto(on, ed);
    if (!on) return base;
    // Strudel's own source sits inside its autocompletion() config; ours runs first and merges with it
    strudelSource ||= flat(base).map((x) => x?.value?.override?.[0]).find(Boolean) || null;
    if (!strudelSource) return base;
    return [autocompletion({ override: [mergeSources(strudelSource)], closeOnBlur: false, addToOptions: [chipOption] })];
  };
  const origTip = extensions.isTooltipEnabled;
  extensions.isTooltipEnabled = (on, ed) => [origTip ? origTip(on, ed) : [], pillField, ctrlClick];
}
install();

// ---------- wiring that needs the live editor ----------
// editor = StrudelMirror; getKnobsPref() -> boolean ("Plugin knobs update code")
export function initVstUi({ editor, getKnobsPref }) {
  if (!api) return null;
  startState();
  const view = () => editor.editor;
  const hover = initHover({ view });
  const stopKnobs = initKnobs({ view, isOn: getKnobsPref });
  const refresh = () => view().dispatch({ effects: refreshPills.of(null) });
  onRack(refresh);
  return {
    refresh,
    hide: hover.hide, // the hover card, e.g. when the document changes
    stop: () => stopKnobs?.(),
  };
}
