// Autocomplete for the VST side of the language, merged into Strudel's own completion source:
//   vst("|")                 installed plugin names, with a synth / effect chip and the vendor
//   vst("X", { | })          that plugin's parameter keys, with range and current value
//   .set("entry", { | })     parameter keys of that entry's plugins
//   .s("|") .fx("|") .set("|") rack entry names (next to the sound names for .s)
import { syntaxTree } from '@codemirror/language';
import { findRack, findVstCalls, unq } from '../rack-source.js';
import { api, getPlugins, findPlugin, paramsOf, fmtNum, lastRack, rackEntry, kindOf, h } from './state.js';

// syntax nodes are not unique objects (buffer nodes are made on demand): compare positions
const same = (a, b) => !!a && !!b && a.from === b.from && a.to === b.to && a.name === b.name;

const parentOf = (n, ...names) => {
  for (let p = n.parent; p; p = p.parent) if (names.includes(p.name)) return p;
  return null;
};

// which call is `argList` an argument list of? -> { name, method: bool, first: String node | null }
function callInfo(state, argList) {
  const call = argList?.parent;
  if (call?.name !== 'CallExpression') return null;
  const callee = call.firstChild;
  let name = null;
  let method = false;
  if (callee?.name === 'VariableName') name = state.sliceDoc(callee.from, callee.to);
  else if (callee?.name === 'MemberExpression' && callee.lastChild?.name === 'PropertyName') {
    name = state.sliceDoc(callee.lastChild.from, callee.lastChild.to);
    method = true;
  }
  if (!name) return null;
  let first = null;
  for (let c = argList.firstChild; c; c = c.nextSibling) {
    if (c.name === '(' || c.name === ',' || c.name === ')') continue;
    first = c;
    break;
  }
  return { call, name, method, first };
}

// where is the cursor? Returns one of
//   { kind: 'plugin', from, to }                      inside vst("...")
//   { kind: 'entry', method, from, to }               inside .s/.fx/.set("...") (or s("..."))
//   { kind: 'key', plugin | entry, call, from, to, have }  at a key position of a parameter object
export function contextAt(state, pos) {
  const tree = syntaxTree(state);
  let n = tree.resolve(pos, -1); // not resolveInner: Strudel mounts a mini-notation parser inside strings
  // ----- strings
  if (n.name === 'String' && pos > n.from) {
    const text = state.sliceDoc(n.from, n.to);
    const closed = text.length >= 2 && text.at(-1) === text[0] && n.to > n.from + 1;
    if (!closed || pos < n.to) {
      const to = closed ? n.to - 1 : n.to;
      const holder = n.parent?.name === 'ArrayExpression' ? n.parent : n;
      const argList = holder.parent?.name === 'ArgList' ? holder.parent : null;
      const info = argList && callInfo(state, argList);
      if (info) {
        if (info.name === 'vst' && !info.method && same(info.first, n)) return { kind: 'plugin', from: n.from + 1, to };
        if (['s', 'sound', 'fx', 'set'].includes(info.name) && (holder === n ? same(info.first, n) : info.name === 'fx')) {
          return { kind: 'entry', method: info.name === 'sound' ? 's' : info.name, from: n.from + 1, to, inArray: holder !== n };
        }
      }
      return null;
    }
  }
  // ----- parameter objects
  for (let x = n; x; x = x.parent) {
    if (x.name === 'ArgList' || x.name === 'Script') break;
    if (x.name !== 'ObjectExpression' && x.name !== 'ObjectPattern') continue;
    const argList = x.name === 'ObjectPattern' ? x.parent?.parent : x.parent;
    if (argList?.name !== 'ArgList') return null;
    const info = callInfo(state, argList);
    if (!info || pos <= x.from) return null;
    const isVst = info.name === 'vst' && !info.method;
    const isSet = info.name === 'set' && info.method;
    if ((!isVst && !isSet) || info.first?.name !== 'String' || same(info.first, x)) return null;
    // only a key position: no ':' in the current segment
    const closed = state.sliceDoc(x.to - 1, x.to) === '}';
    const inner = state.sliceDoc(x.from + 1, closed && pos <= x.to - 1 ? pos : pos);
    if (pos > x.to - (closed ? 1 : 0)) return null;
    const seg = inner.split(',').pop();
    if (seg.includes(':')) return null;
    const frag = /["']?[\w$]*$/.exec(seg)[0];
    if (frag.startsWith('"') || frag.startsWith("'")) return null;
    const name = unq(state.sliceDoc(info.first.from, info.first.to));
    const have = new Set();
    // keys already written (not the one being typed)
    for (let c = x.firstChild; c; c = c.nextSibling) {
      if ((c.name === 'Property' || c.name === 'PatternProperty') && c.from < pos - frag.length) {
        const k = c.firstChild;
        if (k && c.lastChild !== k) have.add(unq(state.sliceDoc(k.from, k.to)));
      }
    }
    return { kind: 'key', isVst, name, call: info.call, from: pos - frag.length, to: pos, have };
  }
  return null;
}

const range = (p) => {
  if (p.choices?.length) return p.choices.slice(0, 3).join(' | ') + (p.choices.length > 3 ? ' ...' : '');
  if (p.steps === 2 || (p.min === 0 && p.max === 1 && p.steps === 1)) return 'off | on';
  return `${fmtNum(p.min)} to ${fmtNum(p.max)}${p.unit ? ' ' + p.unit : ''}`;
};

async function keyOptions(state, c) {
  const options = [];
  const seen = new Set();
  const add = (p, live, plugin) => {
    if (seen.has(p.key) || c.have.has(p.key)) return;
    seen.add(p.key);
    const now = live?.[p.key];
    options.push({
      label: p.key,
      detail: `${range(p)}${now ? ' · now ' + now.text : ''}`,
      info: p.name !== p.key || p.choices?.length ? () => info(p, plugin) : undefined,
      type: 'property',
      apply: `${p.key}: `,
      boost: 5,
    });
  };
  if (c.isVst) {
    const call = findVstCalls(state).find((v) => v.from === c.call.from);
    const live = call?.entry && api ? await api.paramValues(call.entry, call.slot).catch(() => null) : null;
    for (const p of await paramsOf(c.name)) add(p, live, c.name);
    if (!seen.has('bypass') && !c.have.has('bypass')) options.push({ label: 'bypass', detail: 'true | false', type: 'property', apply: 'bypass: ', boost: 1 });
  } else {
    const entry = findRack(state)?.entries.find((e) => e.name === c.name);
    if (entry && api) {
      for (let slot = 0; slot < entry.plugins.length; slot++) {
        const live = await api.paramValues(entry.name, slot).catch(() => null);
        for (const p of await paramsOf(entry.plugins[slot].name)) add(p, live, entry.plugins[slot].name);
      }
    }
  }
  return options;
}
function info(p, plugin) {
  const d = h('div', 'vst-ac-info');
  d.append(h('b', null, p.name), h('div', null, `${plugin} · ${range(p)}`));
  if (p.choices?.length) d.append(h('div', 'vst-ac-choices', p.choices.join(', ')));
  return d;
}

function entryOptions(state, c) {
  const rack = findRack(state);
  if (!rack) return [];
  const status = lastRack();
  const out = [];
  for (const e of rack.entries) {
    const kind = status?.entries.find((x) => x.name === e.name)?.kind || (e.plugins[0] ? kindOf(e.plugins[0].name) : 'effect');
    if (c.method === 's' && kind !== 'synth') continue;
    if (c.method === 'fx' && kind === 'synth') continue;
    out.push({ label: e.name, detail: e.plugins.map((p) => p.name).join(' > ') || undefined, type: 'text', vstKind: kind, boost: 20 });
  }
  return out;
}

function pluginOptions() {
  return getPlugins().map((p) => ({ label: p.name, detail: p.vendor, type: 'class', vstKind: p.kind, boost: 5 }));
}

// the fragment typed so far inside a mini-notation string: \w characters after the last separator
const fragmentFrom = (state, c, pos) => {
  const before = state.sliceDoc(c.from, pos);
  return pos - /[\w$-]*$/.exec(before)[0].length;
};

// returns a CompletionResult (maybe a promise) or null; `exclusive` results must not be mixed with Strudel's
export function vstSource(context) {
  const state = context.state;
  const c = contextAt(state, context.pos);
  if (!c) return null;
  if (c.kind === 'plugin') {
    // match what is typed against "Vendor Name" as well as the name, since "FabFilter One" is a valid way to write it
    const typed = state.sliceDoc(c.from, context.pos).trim().toLowerCase();
    const options = pluginOptions().filter((o) => !typed || `${o.detail || ''} ${o.label}`.toLowerCase().includes(typed) || o.label.toLowerCase().includes(typed));
    options.sort((a, b) => Number(b.label.toLowerCase().startsWith(typed)) - Number(a.label.toLowerCase().startsWith(typed)));
    return { exclusive: true, from: c.from, to: c.to, options, filter: false };
  }
  if (c.kind === 'entry') {
    const from = c.method === 'set' || c.method === 'fx' ? c.from : fragmentFrom(state, c, context.pos);
    const options = entryOptions(state, c);
    if (c.method === 'fx' || c.method === 'set') return options.length ? { exclusive: true, from: c.from, to: c.to, options } : { exclusive: true, from: c.from, options: [] };
    return options.length ? { merge: true, from, options } : null;
  }
  return keyOptions(state, c).then((options) => (options.length ? { exclusive: true, from: c.from, to: c.to, options, filter: true } : { exclusive: true, from: c.from, options: [] }));
}

// Strudel's completion source, wrapped so ours runs first and (for .s) sits next to the sound names
export function mergeSources(strudel) {
  return async (context) => {
    const mine = await vstSource(context);
    if (mine?.exclusive) {
      const { exclusive, ...r } = mine;
      return r.options.length ? r : null;
    }
    const base = strudel ? await strudel(context) : null;
    if (!mine) return base;
    const { merge, ...r } = mine;
    if (!base) return r;
    if (base.from !== r.from) return { ...base, options: [...r.options, ...base.options.filter((o) => !r.options.some((m) => m.label === o.label))], from: Math.min(base.from, r.from) };
    return { ...base, options: [...r.options, ...base.options] };
  };
}

// the chip in front of the label for plugins and rack entries
export const chipOption = {
  render(completion) {
    if (!completion.vstKind) return null;
    const el = h('span', `vst-chip ${completion.vstKind === 'synth' ? 'syn' : 'fx'}`, completion.vstKind === 'synth' ? 'synth' : 'effect');
    return el;
  },
  position: 25,
};

// findPlugin is re-exported for the hover card
export { findPlugin };
