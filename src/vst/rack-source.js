// Reads and rewrites the rack({...}) block of a sketch through the CodeMirror syntax tree (see CONTRACT.md).
// The Mixer, the bypass dot, "Update code" and "Plugin knobs update code" all edit code through these helpers, so
// the code stays the source of truth. Every rewrite is ONE editor transaction (one undo step).
//
// Reading is pure (state in, ranges out). Writing is split in two: plan*(state, ...) returns the changes, and the
// exported helpers dispatch them to a view. The node test (rack-source.test.mjs) drives the helpers through a tiny
// fake view.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';

const tree = (state) => ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const unq = (s) => {
  if (!s) return '';
  const q = s[0];
  if ((q === '"' || q === "'" || q === '`') && s.at(-1) === q && s.length >= 2) return s.slice(1, -1).replace(/\\(.)/g, '$1');
  return s;
};
const quote = (s) => JSON.stringify(String(s));
const keyText = (k) => (IDENT.test(k) ? k : quote(k));
const isTrivia = (n) => n.name === 'LineComment' || n.name === 'BlockComment';

// children of a node without comments
function kids(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (!isTrivia(c)) out.push(c);
  return out;
}

function readPlugin(state, call) {
  const args = call.getChild('ArgList');
  const parts = args ? kids(args).filter((n) => n.name !== '(' && n.name !== ')' && n.name !== ',') : [];
  const nameNode = parts[0]?.name === 'String' ? parts[0] : null;
  const objNode = parts.find((n) => n.name === 'ObjectExpression') || null;
  const params = {};
  const props = [];
  if (objNode) {
    for (const p of kids(objNode).filter((n) => n.name === 'Property')) {
      const k = p.firstChild;
      if (!k) continue;
      const key = k.name === 'String' ? unq(state.sliceDoc(k.from, k.to)) : state.sliceDoc(k.from, k.to);
      const v = p.lastChild;
      if (!v || v === k || v.name === ':') continue;
      const rec = { from: v.from, to: v.to, text: state.sliceDoc(v.from, v.to), propFrom: p.from, propTo: p.to };
      params[key] = rec;
      props.push({ key, ...rec });
    }
  }
  return {
    name: nameNode ? unq(state.sliceDoc(nameNode.from, nameNode.to)) : '',
    from: call.from,
    to: call.to,
    nameFrom: nameNode?.from ?? -1,
    nameTo: nameNode?.to ?? -1,
    objFrom: objNode?.from ?? -1,
    objTo: objNode?.to ?? -1,
    argsTo: args ? args.to - 1 : call.to, // position of the closing paren
    params,
    props,
  };
}
const isVstCall = (state, n) => n.name === 'CallExpression' && n.firstChild?.name === 'VariableName' && state.sliceDoc(n.firstChild.from, n.firstChild.to) === 'vst';

function readEntry(state, prop) {
  const k = prop.firstChild;
  const v = prop.lastChild;
  if (!k || !v || v === k) return null;
  const name = k.name === 'String' ? unq(state.sliceDoc(k.from, k.to)) : state.sliceDoc(k.from, k.to);
  const entry = { name, from: prop.from, to: prop.to, nameFrom: k.from, nameTo: k.to, valueFrom: v.from, valueTo: v.to, plugins: [], next: undefined, nextFrom: -1, nextTo: -1, isArray: false };
  if (isVstCall(state, v)) entry.plugins.push(readPlugin(state, v));
  else if (v.name === 'ArrayExpression') {
    entry.isArray = true;
    for (const c of kids(v)) {
      if (isVstCall(state, c)) entry.plugins.push(readPlugin(state, c));
      else if (c.name === 'String') {
        entry.next = unq(state.sliceDoc(c.from, c.to));
        entry.nextFrom = c.from;
        entry.nextTo = c.to;
      }
    }
  } else return null;
  return entry;
}

export function findRack(state) {
  let found = null;
  tree(state).iterate({
    enter(n) {
      if (found) return false;
      if (n.name !== 'CallExpression') return;
      const node = n.node;
      const callee = node.firstChild;
      if (callee?.name !== 'VariableName' || state.sliceDoc(callee.from, callee.to) !== 'rack') return;
      const args = node.getChild('ArgList');
      const obj = args && kids(args).find((c) => c.name === 'ObjectExpression');
      if (!obj) return;
      const entries = kids(obj).filter((c) => c.name === 'Property').map((p) => readEntry(state, p)).filter(Boolean);
      found = { from: node.from, to: node.to, objFrom: obj.from, objTo: obj.to, entries };
      return false;
    },
  });
  return found;
}

// every vst("...") call in the document, with the rack entry and slot it belongs to (or null for inline chains)
export function findVstCalls(state) {
  const rack = findRack(state);
  const inRack = new Map();
  rack?.entries.forEach((e) => e.plugins.forEach((p, slot) => inRack.set(p.from, { entry: e.name, slot })));
  const out = [];
  tree(state).iterate({
    enter(n) {
      if (n.name !== 'CallExpression' || !isVstCall(state, n.node)) return;
      const p = readPlugin(state, n.node);
      out.push({ ...p, ...(inRack.get(p.from) || { entry: null, slot: 0 }) });
    },
  });
  return out;
}

// string literals naming a rack entry in .s("x"), .fx("x") / .fx(["x", ...]) and .set("x", ...)
export function findNameUses(state) {
  const out = [];
  tree(state).iterate({
    enter(n) {
      if (n.name !== 'CallExpression') return;
      const callee = n.node.firstChild;
      // .s("x") on a pattern, or s("x") starting one
      const prop = callee?.name === 'MemberExpression' ? callee.lastChild : callee?.name === 'VariableName' ? callee : null;
      if (!prop || (prop.name !== 'PropertyName' && prop.name !== 'VariableName')) return;
      const method = state.sliceDoc(prop.from, prop.to);
      if (method !== 's' && method !== 'fx' && method !== 'set' && method !== 'sound') return;
      const args = n.node.getChild('ArgList');
      if (!args) return;
      const first = kids(args).find((c) => c.name !== '(' && c.name !== ')' && c.name !== ',');
      const strs = [];
      if (first?.name === 'String') strs.push(first);
      else if (method === 'fx' && first?.name === 'ArrayExpression') for (const c of kids(first)) if (c.name === 'String') strs.push(c);
      for (const s of strs) out.push({ method, from: s.from, to: s.to, text: unq(state.sliceDoc(s.from, s.to)) });
    },
  });
  return out.sort((a, b) => a.from - b.from);
}

// ---------- planning edits ----------
const getEntry = (state, name) => {
  const rack = findRack(state);
  const entry = rack?.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no rack entry "${name}"`);
  return { rack, entry };
};
const pluginText = (name) => `vst(${quote(name)})`;

// delete a list item together with one of its separating commas
function deleteItem(items, i) {
  const it = items[i];
  if (i + 1 < items.length) return { from: it.from, to: items[i + 1].from };
  if (i > 0) return { from: items[i - 1].to, to: it.to };
  return { from: it.from, to: it.to };
}

function planAddPlugin(state, entryName, pluginName, atSlot) {
  const { entry } = getEntry(state, entryName);
  const n = entry.plugins.length;
  const slot = atSlot == null ? n : Math.max(0, Math.min(n, atSlot));
  if (!entry.isArray) {
    const first = entry.plugins[0];
    return slot === 0
      ? [{ from: first.from, insert: `[${pluginText(pluginName)}, ` }, { from: first.to, insert: ']' }]
      : [{ from: first.from, insert: '[' }, { from: first.to, insert: `, ${pluginText(pluginName)}]` }];
  }
  if (slot < n) return [{ from: entry.plugins[slot].from, insert: `${pluginText(pluginName)}, ` }];
  const last = entry.plugins[n - 1];
  return [{ from: last.to, insert: `, ${pluginText(pluginName)}` }];
}

function planRemovePlugin(state, entryName, slot) {
  const { entry } = getEntry(state, entryName);
  if (slot < 0 || slot >= entry.plugins.length) throw new Error(`no plugin ${slot} in "${entryName}"`);
  if (entry.plugins.length === 1) return planRemoveEntry(state, entryName).changes;
  const items = entry.plugins.map((p) => ({ from: p.from, to: p.to }));
  if (entry.next != null) items.push({ from: entry.nextFrom, to: entry.nextTo });
  const d = deleteItem(items, slot);
  return [{ from: d.from, to: d.to, insert: '' }];
}

function planMovePlugin(state, entryName, fromSlot, toSlot) {
  const { entry } = getEntry(state, entryName);
  const n = entry.plugins.length;
  if (fromSlot < 0 || fromSlot >= n || toSlot < 0 || toSlot >= n) throw new Error('slot out of range');
  if (fromSlot === toSlot) return [];
  const texts = entry.plugins.map((p) => state.sliceDoc(p.from, p.to));
  const order = texts.map((_, i) => i);
  const [m] = order.splice(fromSlot, 1);
  order.splice(toSlot, 0, m);
  const changes = [];
  order.forEach((src, i) => {
    if (src !== i) changes.push({ from: entry.plugins[i].from, to: entry.plugins[i].to, insert: texts[src] });
  });
  return changes;
}

function planSetParam(state, entryName, slot, key, valueText) {
  const { entry } = getEntry(state, entryName);
  const p = entry.plugins[slot];
  if (!p) throw new Error(`no plugin ${slot} in "${entryName}"`);
  const existing = p.params[key];
  if (existing) {
    if (valueText != null) return existing.text === valueText ? [] : [{ from: existing.from, to: existing.to, insert: valueText }];
    const items = p.props.map((q) => ({ from: q.propFrom, to: q.propTo }));
    const i = p.props.findIndex((q) => q.key === key);
    if (items.length === 1) {
      // last parameter: drop the whole { ... } argument (and the comma before it)
      return [{ from: state.sliceDoc(p.nameTo, p.objFrom).includes(',') ? p.nameTo : p.objFrom, to: p.objTo, insert: '' }];
    }
    const d = deleteItem(items, i);
    return [{ from: d.from, to: d.to, insert: '' }];
  }
  if (valueText == null) return [];
  const prop = `${keyText(key)}: ${valueText}`;
  if (p.objFrom >= 0) {
    if (!p.props.length) return [{ from: p.objFrom, to: p.objTo, insert: `{ ${prop} }` }];
    return [{ from: p.props.at(-1).propTo, insert: `, ${prop}` }];
  }
  if (p.nameFrom < 0) throw new Error('vst() has no name');
  return [{ from: p.nameTo, insert: `, { ${prop} }` }];
}

function indentOf(state, pos) {
  const line = state.doc.lineAt(pos);
  return /^\s*/.exec(line.text)[0];
}

const valueOf = (plugins) => {
  if (typeof plugins === 'string' && /^\s*(vst\(|\[)/.test(plugins)) return plugins.trim();
  const list = [].concat(plugins);
  return list.length === 1 ? pluginText(list[0]) : `[${list.map(pluginText).join(', ')}]`;
};

// list: [[name, plugins]], plugins = a plugin name, an array of names, or source text like `vst("A")` / `[vst("A"), "x"]`
// at: { after, before } entry names to place the new entries between (the first one still in the rack wins); default end
function planAddEntries(state, list, at) {
  const rack = findRack(state);
  const props = list.map(([name, plugins]) => `${keyText(name)}: ${valueOf(plugins)}`);
  if (rack) {
    for (const [name] of list) if (rack.entries.some((e) => e.name === name)) throw new Error(`"${name}" is already in the rack`);
    const idx = (n) => (n == null ? -1 : rack.entries.findIndex((e) => e.name === n));
    const i = idx(at?.after) >= 0 ? idx(at.after) + 1 : idx(at?.before);
    if (i >= 0 && i < rack.entries.length) {
      // in front of entry i, with the same separator that already sits in front of it
      const ref = rack.entries[i];
      const lead = state.sliceDoc(i ? rack.entries[i - 1].to : rack.objFrom + 1, ref.from);
      const gap = /[,{]?(\s*)$/.exec(lead.replace(/^[^,]*,/, ''))[1] || ' ';
      return [{ from: ref.from, insert: props.map((p) => `${p},${gap}`).join('') }];
    }
    if (!rack.entries.length) {
      const inner = state.sliceDoc(rack.objFrom + 1, rack.objTo - 1);
      const multi = /\n/.test(inner) || !inner.trim();
      return [{ from: rack.objFrom, to: rack.objTo, insert: multi ? `{\n  ${props.join(',\n  ')},\n}` : `{ ${props.join(', ')} }` }];
    }
    const last = rack.entries.at(-1);
    const after = state.sliceDoc(last.to, rack.objTo);
    const comma = /^\s*,/.exec(after); // an existing trailing comma stays where it is
    const sameLine = state.doc.lineAt(last.from).number === state.doc.lineAt(rack.objTo - 1).number;
    const ind = indentOf(state, last.from);
    if (sameLine) return [{ from: last.to, insert: `, ${props.join(', ')}` }];
    if (comma) return [{ from: last.to + comma[0].length, insert: props.map((p) => `\n${ind}${p},`).join('') }];
    return [{ from: last.to, insert: props.map((p) => `,\n${ind}${p}`).join('') }];
  }
  // no rack yet: above the first pattern line (or at the end)
  const text = state.doc.toString();
  const m = /^[ \t]*(?:\$|[A-Za-z_]\w*)[ \t]*:/m.exec(text);
  const pos = m ? m.index : text.length;
  const lead = pos > 0 && text[pos - 1] !== '\n' ? '\n' : '';
  return [{ from: pos, insert: `${lead}rack({\n${props.map((p) => `  ${p},\n`).join('')}})\n\n` }];
}
const planAddEntry = (state, name, plugins) => planAddEntries(state, [[name, plugins]]);

function planRemoveEntry(state, entryName) {
  const { rack, entry } = getEntry(state, entryName);
  const text = state.sliceDoc(entry.from, entry.to);
  let from = entry.from;
  let to = entry.to;
  const after = /^[ \t]*,?/.exec(state.sliceDoc(to, rack.objTo));
  to += after[0].length;
  // when the entry is alone on its line(s), take the whole line
  const l0 = state.doc.lineAt(from);
  const l1 = state.doc.lineAt(to);
  if (!state.sliceDoc(l0.from, from).trim() && !state.sliceDoc(to, l1.to).trim()) {
    from = l0.from;
    to = l1.to < state.doc.length ? l1.to + 1 : l1.to;
  }
  return { changes: [{ from, to, insert: '' }], text };
}

function planRenameEntry(state, from, to) {
  const { rack, entry } = getEntry(state, from);
  if (rack.entries.some((e) => e.name === to)) throw new Error(`"${to}" is already in the rack`);
  const changes = [{ from: entry.nameFrom, to: entry.nameTo, insert: keyText(to) }];
  for (const e of rack.entries) if (e.next === from) changes.push({ from: e.nextFrom, to: e.nextTo, insert: quote(to) });
  for (const u of findNameUses(state)) if (u.text === from) changes.push({ from: u.from, to: u.to, insert: quote(to) });
  return changes;
}

// ---------- applying ----------
const run = (view, changes, extra = {}) => {
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'input.vst', annotations: isolateHistory.of('full'), ...extra });
  return true;
};

export const addPlugin = (view, entry, pluginName, atSlot) => run(view, planAddPlugin(view.state, entry, pluginName, atSlot));
export const removePlugin = (view, entry, slot) => run(view, planRemovePlugin(view.state, entry, slot));
export const movePlugin = (view, entry, fromSlot, toSlot) => run(view, planMovePlugin(view.state, entry, fromSlot, toSlot));
export const setParam = (view, entry, slot, key, valueText, extra) => run(view, planSetParam(view.state, entry, slot, key, valueText), extra);
// several parameters at once, still one transaction: values = { key: valueText | null }
export function setParams(view, entry, slot, values, extra) {
  const changes = Object.entries(values).flatMap(([k, v]) => planSetParam(view.state, entry, slot, k, v));
  return run(view, changes, extra);
}
export const addEntry = (view, name, plugins) => run(view, planAddEntry(view.state, name, plugins));
// several entries at once (one transaction), e.g. a starter rack
export const addEntries = (view, list) => run(view, planAddEntries(view.state, list));
export const renameEntry = (view, from, to) => run(view, planRenameEntry(view.state, from, to));
// returns the removed entry's source text, so it can be put back with its parameters
export function removeEntry(view, name) {
  const { changes, text } = planRemoveEntry(view.state, name);
  run(view, changes);
  return text;
}
// put a removed entry back from its source text (or its plugin names)
// at: { after, before } neighbour names from where it was, so it goes back in the same place
export function restoreEntry(view, name, sourceOrPlugins, at) {
  const src = typeof sourceOrPlugins === 'string' ? sourceOrPlugins : null;
  const m = src && /^(?:"[^"]*"|'[^']*'|[\w$]+)\s*:\s*([\s\S]*)$/.exec(src);
  return run(view, planAddEntries(view.state, [[name, m ? m[1] : sourceOrPlugins]], at));
}
// a free entry name based on `base`
export function uniqueName(state, base) {
  const taken = new Set(findRack(state)?.entries.map((e) => e.name));
  let b = String(base).replace(/[^A-Za-z0-9_$]+/g, ' ').trim().split(' ').filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('') || 'fx';
  if (/^\d/.test(b)) b = '_' + b;
  let name = b;
  for (let i = 2; taken.has(name); i++) name = `${b}${i}`;
  return name;
}
// is the plugin bypassed in code?
export const isBypassed = (plugin) => /^true$/.test(plugin?.params?.bypass?.text ?? '');
// toggle bypass: written as `bypass: true`, removed again when switched back on
export const setBypass = (view, entry, slot, on) => setParam(view, entry, slot, 'bypass', on ? 'true' : null);

export { unq, quote, keyText };
