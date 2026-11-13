// Status pill at the end of each rack entry line: loaded / N routes / bypassed / not installed / crashed · reload.
// Part of the editor's state (a StateField), so it follows edits and survives sketch switches.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { findRack } from '../rack-source.js';
import { api, lastRack, h } from './state.js';

export const refreshPills = StateEffect.define();

// what to say about one rack entry (status from the engine), or null for nothing
export function pillFor(st) {
  if (!st) return null;
  const chain = st.chain || [];
  if (chain.some((c) => c.status === 'crashed')) return { cls: 'crash', text: 'crashed', action: 'reload', tip: 'This plugin crashed and is silent. Click to reload it.' };
  if (chain.some((c) => c.status === 'missing')) return { cls: 'miss', text: 'not installed', tip: 'This plugin was not found on this computer. Its saved state is kept.' };
  if (chain.some((c) => c.status === 'loading')) return { cls: 'lo', text: 'loading', tip: 'Loading the plugin' };
  if (chain.length && chain.every((c) => c.bypass)) return { cls: 'lo', text: 'bypassed', tip: 'Every plugin here is bypassed' };
  const n = st.routes?.length || 0;
  if (n > 1) return { cls: '', text: `${n} routes`, tip: `Plays through ${n} copies, one per place its sound goes` };
  return { cls: '', text: 'loaded', tip: 'Loaded' };
}

class PillWidget extends WidgetType {
  constructor(entry, pill) {
    super();
    this.entry = entry;
    this.pill = pill;
  }
  eq(o) {
    return o.entry === this.entry && o.pill.text === this.pill.text && o.pill.cls === this.pill.cls;
  }
  toDOM() {
    const p = this.pill;
    const el = h('span', `vst-pill ${p.cls}`.trim());
    el.dataset.entry = this.entry;
    el.title = p.tip;
    el.append(h('span', 'vst-pill-dot'), p.text);
    if (p.action === 'reload') {
      el.classList.add('is-action');
      el.append(h('span', 'vst-pill-act', p.action));
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        api?.reload(this.entry);
      });
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function build(state) {
  const rack = findRack(state);
  const status = lastRack();
  if (!rack || !status) return Decoration.none;
  const widgets = [];
  for (const e of rack.entries) {
    const pill = pillFor(status.entries.find((x) => x.name === e.name));
    if (!pill) continue;
    const doc = state.doc;
    const l0 = doc.lineAt(e.from);
    const l1 = doc.lineAt(e.to);
    // an entry that owns its line gets the pill at the end of the line (after the comma and any comment);
    // entries sharing a line get it right after their own comma
    const line = (p) => doc.lineAt(p).number;
    const shares = rack.entries.some((o) => o !== e && (line(o.from) === l1.number || line(o.to) === l0.number)) || line(rack.objTo) === l1.number;
    let at = l1.to;
    if (shares) at = e.to + /^[ 	]*,?/.exec(state.sliceDoc(e.to, l1.to))[0].length;
    widgets.push(Decoration.widget({ widget: new PillWidget(e.name, pill), side: 1 }).range(at));
  }
  return Decoration.set(widgets, true);
}

export const pillField = StateField.define({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(refreshPills))) return build(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
