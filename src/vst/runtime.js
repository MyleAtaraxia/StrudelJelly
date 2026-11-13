// Strudel side of VST support (see CONTRACT.md and vst-plan.md).
//
// Code declares a rack with rack({...}) and plugins with vst(name, params). Patterns use rack entries with
// .s("synth"), .fx("effect") / .fx(vst(...)) and .set("entry", { param: pattern }).
//
// Every evaluate:
//   beforeEval   resets what this evaluate declares and tags each $: pattern with its label
//   transpile    (jellyTranspiler) keeps names in vst()/rack()/.set() plain strings and records where they are
//   editPattern  queries a few cycles of the final pattern to find every route a sound takes, turns routes into
//                copies (one per distinct onward route), assigns each superdough route its own capture stream,
//                and sends the whole rack to Electron (rack.cjs), which diffs it against what runs.
//                Wrong usage (.fx on a synth, .s on an effect, loops, too many routes) throws "line N: ...",
//                which lands in the editor's error pill.
//   output       (wrapOutput) turns haps on synth entries into timestamped MIDI, .set values into parameter
//                events, and sends routed superdough sounds to their stream (via the orbit, see capture.js).
// Timestamps are AudioContext frames (t * sampleRate): the host maps them onto its own clock the same way it
// places the captured audio, so plugins and superdough stay in time.
import { Pattern, reify, stack, valueToMidi, evalScope } from '@strudel/core';
import { getAudioContext } from '@strudel/webaudio';
import { parse } from 'acorn';
import { MAX_STREAMS, setActiveStreams } from './engine/capture.js';
import { noteScope } from './scope.js';

const api = window.jelly?.vst;
const QUERY_CYCLES = 4;
const MAX_QUERY_HAPS = 20000;

// ---------- the rack status, for the UI ----------
let last = null;
const listeners = new Set();
const setLast = (r) => {
  if (!r) return;
  last = r;
  listeners.forEach((fn) => fn(r));
};
api?.onRack?.(setLast);

export const lastRack = () => last;
export function onRack(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// code value vs plugin value per entry/slot/key
const codeValues = new Map(); // `${entry}\t${slot}` -> { key: code value }
const pluginValues = new Map(); // `${entry}\t${slot}` -> { key: natural value or text }
api?.onParamChange?.((e) => {
  const k = `${e.entry}\t${e.slot}`;
  if (!pluginValues.has(k)) pluginValues.set(k, {});
  pluginValues.get(k)[e.key] = { value: e.value, text: e.text };
});
export function paramDiffs(entry, slot) {
  const code = codeValues.get(`${entry}\t${slot}`) || {};
  const plugin = pluginValues.get(`${entry}\t${slot}`) || {};
  const out = [];
  for (const [key, c] of Object.entries(code)) {
    const p = plugin[key];
    if (p === undefined) continue;
    const num = typeof c === 'number' ? c : typeof c === 'boolean' ? Number(c) : parseFloat(c) * (/khz/i.test(c) ? 1000 : 1);
    const t = String(p.text ?? '').trim().toLowerCase();
    const same = Number.isFinite(num) && (typeof c !== 'string' || /^[-+\d.]/.test(c.trim()))
      ? Math.abs(num - p.value) <= Math.max(1e-6, Math.abs(num) * 0.005)
      : t === String(c).trim().toLowerCase() || t.startsWith(String(c).trim().toLowerCase());
    if (!same) out.push({ key, code: c, plugin: typeof c === 'string' && !/^[-+\d.]/.test(c.trim()) ? p.text : p.value });
  }
  return out;
}

// ---------- plugin catalogue (cached; vst() needs it synchronously) ----------
let plugins = [];
let pluginsReady = null;
const refreshPlugins = () =>
  (pluginsReady = (api ? api.plugins() : Promise.resolve([])).then((l) => (plugins = l || [])).catch(() => plugins));
api?.onScan?.((info) => {
  if (!info?.scanning) refreshPlugins();
});
// by name, ignoring case, also with the vendor in front ("FabFilter One" for One)
const findPlugin = (name) => {
  const n = String(name).toLowerCase();
  return plugins.find((p) => p.name === name) || plugins.find((p) => p.name.toLowerCase() === n) ||
    plugins.find((p) => `${p.vendor} ${p.name}`.toLowerCase() === n) || null;
};

// ---------- source positions ----------
let src = { code: '', rack: {}, vstAt: [] };
const lineOf = (pos) => {
  if (pos == null || pos < 0) return undefined;
  let n = 1;
  const c = src.code;
  for (let i = 0; i < pos && i < c.length; i++) if (c.charCodeAt(i) === 10) n++;
  return n;
};
class LineError extends Error {
  constructor(line, message) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k in node) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && walk(x, fn));
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, fn);
  }
}
const isStr = (n) => n?.type === 'Literal' && typeof n.value === 'string';

// Strudel turns every double-quoted string into mini-notation. Plugin names, parameter values and entry names are
// plain text, so those strings become single-quoted (same length, so every position stays valid).
function prepass(code) {
  const info = { code, rack: {}, vstAt: [] };
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
  } catch {
    return { code, info };
  }
  const chars = code.split('');
  const plain = (n) => {
    if (!isStr(n) || code[n.start] !== '"') return;
    const inner = code.slice(n.start + 1, n.end - 1);
    if (inner.includes("'")) return;
    chars[n.start] = "'";
    chars[n.end - 1] = "'";
  };
  const plainObject = (o, values) => {
    if (o?.type !== 'ObjectExpression') return;
    for (const p of o.properties) {
      if (p.type !== 'Property') continue;
      plain(p.key);
      if (values) plain(p.value);
    }
  };
  walk(ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c.type === 'Identifier' && c.name === 'vst') {
      info.vstAt.push(n.start);
      plain(n.arguments[0]);
      plainObject(n.arguments[1], true);
    } else if (c.type === 'Identifier' && c.name === 'rack' && n.arguments[0]?.type === 'ObjectExpression') {
      for (const p of n.arguments[0].properties) {
        if (p.type !== 'Property') continue;
        const name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
        info.rack[name] = p.key.start;
        plain(p.key);
        plain(p.value);
        if (p.value.type === 'ArrayExpression') p.value.elements.forEach(plain);
      }
    } else if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'set' && n.arguments.length === 2 &&
      isStr(n.arguments[0]) && n.arguments[1].type === 'ObjectExpression') {
      plain(n.arguments[0]);
      plainObject(n.arguments[1], false);
      // Strudel's own .set (pattern alignment) cannot be wrapped, so this form calls .$st (same length)
      chars.splice(c.property.start, 3, '$', 's', 't');
    } else if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'fx' && n.arguments[0]?.type === 'ArrayExpression') {
      n.arguments[0].elements.forEach(plain);
    }
  });
  return { code: chars.join(''), info };
}

// vst(...) calls in the transpiled code get their source position: vst( -> __jvstAt(pos)(
function postpass(out, at) {
  if (!at.length) return out;
  let ast;
  try {
    ast = parse(out, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, sourceType: 'script' });
  } catch {
    return out;
  }
  const calls = [];
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'vst') calls.push(n.callee);
  });
  if (calls.length !== at.length) return out;
  calls.sort((a, b) => a.start - b.start);
  for (let i = calls.length - 1; i >= 0; i--) out = out.slice(0, calls[i].start) + `__jvstAt(${at[i]})` + out.slice(calls[i].end);
  return out;
}

export function wrapTranspiler(transpiler) {
  return (code, options) => {
    const { code: pre, info } = prepass(code);
    const r = transpiler(pre, options);
    if (r && typeof r.output === 'string') r.output = postpass(r.output, info.vstAt);
    src = info;
    return r;
  };
}

// ---------- what an evaluate declares ----------
let ev = null;
const fresh = () => ({ rack: null, rackPos: undefined, inline: new Map(), byObj: new WeakMap(), sigCount: new Map(), usesFx: false });

function makeVst(pos, name, params) {
  if (name instanceof Pattern) name = name.__pure;
  if (typeof name !== 'string' || !name.trim()) throw new LineError(lineOf(pos), 'vst() needs the name of an installed plugin, e.g. vst("Pro-Q 3")');
  if (/[\\/]/.test(name) || /\.(vst3|vst|dll|so)$/i.test(name)) throw new LineError(lineOf(pos), `vst() takes an installed plugin's name, not a path: "${name}"`);
  const info = findPlugin(name);
  const out = {};
  let bypass = false;
  for (const [k, v0] of Object.entries(params && typeof params === 'object' ? params : {})) {
    let v = v0 instanceof Pattern ? v0.__pure : v0;
    if (v === undefined) throw new LineError(lineOf(pos), `${name}: "${k}" needs a plain value here; use .set("entry", { ${k}: pattern }) to change it over time`);
    if (k === 'bypass') bypass = !!v;
    else out[k] = v;
  }
  return { __jellyVst: true, name: info?.name ?? name, kind: info?.kind ?? 'effect', missing: !info, params: out, bypass, pos };
}
const vst = (name, params) => makeVst(undefined, name, params);
const __jvstAt = (pos) => (name, params) => makeVst(pos, name, params);
const isVst = (x) => x && x.__jellyVst === true;

function rack(spec) {
  if (!ev) ev = fresh();
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('rack() takes an object: rack({ name: vst("Plugin"), ... })');
  const entries = new Map();
  for (const [name, val0] of Object.entries(spec)) {
    const line = lineOf(src.rack[name]);
    const items = Array.isArray(val0) ? [...val0] : [val0];
    let next = null;
    const tail = items.at(-1);
    if (items.length > 1 && (typeof tail === 'string' || tail instanceof Pattern)) {
      next = typeof tail === 'string' ? tail : tail.__pure;
      items.pop();
    }
    if (!items.length || !items.every(isVst))
      throw new LineError(line, `rack entry "${name}" must be vst("Plugin") or a [ ... ] chain of them, optionally ending in an entry name`);
    entries.set(name, { name, line, plugins: items, next, kind: items[0].kind });
  }
  for (const e of entries.values()) {
    if (e.next == null) continue;
    if (!entries.has(e.next)) throw new LineError(e.line, `"${e.name}" routes to "${e.next}", which is not a rack entry`);
    if (entries.get(e.next).kind === 'synth') throw new LineError(e.line, `"${e.name}" routes into "${e.next}", which is a synth; route into effects only`);
    const seen = [e.name];
    for (let at = e.next; at != null; at = entries.get(at)?.next) {
      if (seen.includes(at)) throw new LineError(e.line, `rack routes loop: ${[...seen, at].join(' -> ')}`);
      seen.push(at);
    }
  }
  ev.rack = entries;
  return spec;
}

// inline effect chains: one group per chain object, numbered per plugin list in code order
function inlineGroup(items) {
  const obj = items.length === 1 ? items[0] : items;
  let id = ev.byObj.get(obj);
  if (id) return id;
  const sig = items.map((p) => p.name).join('+');
  const k = (ev.sigCount.get(sig) || 0) + 1;
  ev.sigCount.set(sig, k);
  id = `inline:${sig}:${k}`;
  ev.byObj.set(obj, id);
  ev.inline.set(id, { id, plugins: items, line: lineOf(items[0].pos), kind: items[0].kind });
  return id;
}

const addHop = (hop) => (v) => (v && typeof v === 'object' ? { ...v, _jfx: [...(v._jfx || []), hop] } : v);

function fx(target) {
  if (!ev) ev = fresh();
  ev.usesFx = true;
  if (isVst(target) || (Array.isArray(target) && target.length && isVst(target[0]))) {
    const items = Array.isArray(target) ? [...target] : [target];
    let tailName = null;
    if (items.length > 1 && typeof items.at(-1) === 'string') tailName = items.pop();
    if (!items.every(isVst)) throw new LineError(lineOf(items.find(isVst)?.pos), '.fx([...]) takes vst(...) plugins, optionally ending in an entry name');
    if (items.some((p) => p.kind === 'synth')) throw new LineError(lineOf(items[0].pos), `.fx(vst("${items.find((p) => p.kind === 'synth').name}")): that plugin is a synth; put it in the rack and play it with .s("name")`);
    let pat = this.withValue(addHop({ g: inlineGroup(items), at: items[0].pos }));
    if (tailName) pat = pat.withValue(addHop({ n: tailName }));
    return pat;
  }
  if (typeof target === 'string' || target instanceof Pattern) {
    const names = reify(target).withHap((h) => h.withValue((n) => ({ n: String(n), at: h.context?.locations?.[0]?.start })));
    return this.fmap((v) => (hop) => addHop(hop)(v)).appLeft(names);
  }
  throw new Error('.fx() takes a rack entry name, vst("Plugin") or [vst(...), ...]');
}

function cc(n, v) {
  return this.ccn(n).ccv(v);
}

// .set("entry", { param: pattern }): timed parameter changes, never saved. The transpiler pass turns that call into
// .$st(...); a .set() that is not of this form is Strudel's own.
const isPlainObject = (o) => o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof Pattern) && Object.getPrototypeOf(o) === Object.prototype;
function jellySet(pat, entry, params) {
  if (!ev) ev = fresh();
  const parts = Object.entries(params).map(([key, val]) => {
    let p = reify(val);
    let continuous = false;
    try {
      continuous = p.queryArc(0, 1).some((h) => !h.whole);
    } catch {}
    if (continuous) p = p.segment(32);
    return p.withValue((v) => ({ _jset: { e: entry, k: key, v } }));
  });
  return stack(pat, ...parts);
}
// ---------- routes ----------
let cur = null; // the analysed evaluate: { rack, inline, nodes, streams, ... }
let curStreamOf = new Map(); // route key -> stream (superdough)
let lastSpec = null;
let reportError = () => {};

const hapLine = (hap, word) => {
  const locs = hap.context?.locations || [];
  const hit = word != null ? locs.find((l) => src.code.slice(l.start, l.end) === String(word)) : null;
  return lineOf((hit || locs[0])?.start);
};

// the groups a hap's sound passes through, in order, ending at the speakers
function pathOf(state, v, hap) {
  const entries = state.rack || new Map();
  const path = [];
  const s = v.s;
  const own = typeof s === 'string' ? entries.get(s) : null;
  if (own) {
    if (own.kind !== 'synth') throw new LineError(hapLine(hap, s), `.s("${s}"): "${s}" is an effect; route audio into it with .fx("${s}")`);
    path.push(s);
  }
  const hops = Array.isArray(v._jfx) ? v._jfx : [];
  if (!own && !hops.length) return path;
  for (const h of hops) {
    let g = h.g;
    if (!g) {
      const e = entries.get(h.n);
      const line = lineOf(h.at) ?? hapLine(hap, h.n);
      if (!e) throw new LineError(line, `.fx("${h.n}"): there is no rack entry "${h.n}"`);
      if (e.kind === 'synth') throw new LineError(line, `.fx("${h.n}"): "${h.n}" is a synth; play it with .s("${h.n}")`);
      g = h.n;
    }
    if (path.at(-1) === g) continue;
    if (path.includes(g)) throw new LineError(lineOf(h.at) ?? hapLine(hap), `this route loops back into "${g}": ${[...path, g].join(' -> ')}`);
    path.push(g);
  }
  for (let at = path.at(-1); at != null && entries.get(at)?.next != null; ) {
    const n = entries.get(at).next;
    if (path.includes(n)) throw new LineError(hapLine(hap), `this route loops back into "${n}": ${[...path, n].join(' -> ')}`);
    path.push(n);
    at = n;
  }
  return path;
}
const keyAt = (path, i) => path.slice(i).join('>');

function addPath(state, path, feeder) {
  for (let i = 0; i < path.length; i++) {
    const key = keyAt(path, i);
    if (!state.nodes.has(key)) state.nodes.set(key, { group: path[i], key, next: i + 1 < path.length ? keyAt(path, i + 1) : null });
    if (feeder) {
      const f = state.feeders.get(path[i]) || new Map();
      if (!f.has(feeder.label)) f.set(feeder.label, feeder);
      state.feeders.set(path[i], f);
    }
  }
}

function analyse(pattern, cycle, declared) {
  const state = {
    rack: declared.rack,
    inline: declared.inline,
    nodes: new Map(),
    streams: new Map(), // route key -> stream
    feeders: new Map(), // group -> label -> { label, line }
    auto: new Map(), // entry -> Set(keys)
    autoLines: new Map(),
  };
  const entries = state.rack || new Map();
  let haps = [];
  const from = Math.max(0, Math.floor(cycle || 0));
  try {
    haps = pattern.queryArc(from, from + QUERY_CYCLES);
    if (from > 0) haps = haps.concat(pattern.queryArc(0, Math.min(from, QUERY_CYCLES)));
  } catch {}
  if (haps.length > MAX_QUERY_HAPS) haps = haps.slice(0, MAX_QUERY_HAPS);
  for (const hap of haps) {
    const v = hap.value;
    if (!v || typeof v !== 'object') continue;
    if (v._jset) {
      const { e, k } = v._jset;
      if (!entries.has(e)) throw new LineError(hapLine(hap) ?? lineOf(0), `.set("${e}", ...): there is no rack entry "${e}"`);
      if (!state.auto.has(e)) state.auto.set(e, new Set());
      state.auto.get(e).add(k);
      if (!state.autoLines.has(`${e}\t${k}`)) state.autoLines.set(`${e}\t${k}`, hapLine(hap));
      continue;
    }
    const path = pathOf(state, v, hap);
    if (!path.length) continue;
    const label = hap.context?.jlabel;
    addPath(state, path, label ? { label, line: hapLine(hap) } : null);
    if (!(typeof v.s === 'string' && entries.has(v.s)) && !state.streams.has(keyAt(path, 0))) {
      if (state.streams.size >= MAX_STREAMS - 1)
        throw new LineError(hapLine(hap), `too many different effect routes for superdough sounds (at most ${MAX_STREAMS - 1}); route more patterns the same way`);
      state.streams.set(keyAt(path, 0), state.streams.size + 1);
    }
  }
  // every group gets at least its default copy, so it exists (editor, state) even while nothing plays it
  const used = new Set([...state.nodes.values()].map((n) => n.group));
  const defaults = [...entries.keys(), ...state.inline.keys()];
  for (const g of defaults) {
    if (used.has(g)) continue;
    const path = [g];
    for (let at = g; entries.get(at)?.next != null; at = entries.get(at).next) path.push(entries.get(at).next);
    addPath(state, path, null);
  }
  return state;
}

function specOf(state) {
  const plug = (p) => ({ name: p.name, params: p.params, bypass: p.bypass, line: lineOf(p.pos), missing: p.missing });
  const entries = [...(state.rack?.values() || [])].map((e) => ({ name: e.name, line: e.line, kind: e.kind, next: e.next, plugins: e.plugins.map(plug) }));
  const inline = [...state.inline.values()].map((g) => ({ id: g.id, line: g.line, kind: g.kind, plugins: g.plugins.map(plug) }));
  const feeders = {};
  for (const [g, f] of state.feeders) feeders[g] = [...f.values()];
  const auto = {};
  for (const [e, ks] of state.auto) auto[e] = [...ks];
  const autoLines = {};
  for (const [k, l] of state.autoLines) autoLines[k] = l;
  const streams = {};
  for (const [key, i] of state.streams) streams[i] = key;
  return {
    sketch: currentSketch(),
    entries,
    inline,
    nodes: [...state.nodes.values()],
    streams,
    feeders,
    auto,
    autoLines,
  };
}

function currentSketch() {
  try {
    return localStorage.getItem('jelly-sketch') || '';
  } catch {
    return '';
  }
}

function remember(spec) {
  codeValues.clear();
  for (const e of spec.entries) e.plugins.forEach((p, i) => codeValues.set(`${e.name}\t${i}`, { ...p.params }));
}

async function send(spec) {
  if (!api?._apply) return;
  lastSpec = spec;
  let status;
  try {
    status = await api._apply(spec);
  } catch (e) {
    reportError(new Error(`rack: ${e.message}`));
    return;
  }
  if (!status) return;
  setLast(status);
  if (status.errors?.length && spec === lastSpec) {
    const e = status.errors[0];
    const more = status.errors.length > 1 ? ` (+${status.errors.length - 1} more)` : '';
    reportError(new LineError(e.line, e.message + more));
  }
}

function applyStreams(state) {
  curStreamOf = new Map(state.streams);
  let mask = 1;
  for (const i of state.streams.values()) mask |= 1 << i;
  setActiveStreams(mask);
}

// routes the evaluate-time query missed (patterns that change slowly): a rolling lookahead queries the cycle
// QUERY_CYCLES ahead as playback moves, so their copies load before the first note; addDynamic at play time is the
// fallback (that note plays dry)
let dynTimer = null;
let curPattern = null;
let horizon = 0;
let lookTimer = null;
function lookahead() {
  if (!cur || !curPattern) return;
  const now = Math.floor(getCycle() || 0);
  if (now + QUERY_CYCLES <= horizon) return;
  const from = Math.max(horizon, now);
  horizon = now + QUERY_CYCLES;
  let haps = [];
  try {
    haps = curPattern.queryArc(from, horizon);
  } catch {}
  if (haps.length > MAX_QUERY_HAPS) haps = haps.slice(0, MAX_QUERY_HAPS);
  for (const hap of haps) {
    const v = hap.value;
    if (!v || typeof v !== 'object' || v._jset) continue;
    let path;
    try {
      path = pathOf(cur, v, hap);
    } catch {
      continue; // wrong usage is reported when the hap plays
    }
    if (path.length && unprepared(path)) addDynamic(path);
  }
}

// a route that still needs its copy, or (superdough sounds) its capture stream: an entry's default copy exists
// from the evaluate on, but nothing streams into it until a pattern routes there
const unprepared = (path) => {
  const key = keyAt(path, 0);
  return !cur.nodes.has(key) || (!cur.streams.has(key) && !cur.capped?.has(key) && cur.rack?.get(path[0])?.kind !== 'synth');
};

function addDynamic(path) {
  if (!cur) return null;
  addPath(cur, path, null);
  let stream = null;
  if (!cur.streams.has(keyAt(path, 0)) && !(typeof path[0] === 'string' && cur.rack?.get(path[0])?.kind === 'synth')) {
    if (cur.streams.size >= MAX_STREAMS - 1) {
      (cur.capped ??= new Set()).add(keyAt(path, 0)); // reported once, then it plays dry
      reportError(new Error(`too many different effect routes for superdough sounds (at most ${MAX_STREAMS - 1})`));
    } else {
      cur.streams.set(keyAt(path, 0), (stream = cur.streams.size + 1));
    }
  }
  clearTimeout(dynTimer);
  dynTimer = setTimeout(() => {
    const spec = specOf(cur);
    applyStreams(cur);
    send(spec);
  }, 0);
  return stream;
}

// ---------- repl hooks ----------
let getCycle = () => 0;
let anon = 0;
export async function beforeEval() {
  ev = fresh();
  anon = 0;
  await (pluginsReady || refreshPlugins());
  refreshPlugins();
  // tag every $: / name: pattern with its label (the repl re-injects .p on every evaluate)
  const p = Pattern.prototype.p;
  if (p && !p.__jelly) {
    const w = function (id) {
      if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) return p.call(this, id);
      const label = typeof id === 'string' && id.includes('$') ? `${id}${anon++}` : String(id);
      return p.call(this.withContext((c) => ({ ...c, jlabel: label })), id);
    };
    w.__jelly = true;
    Pattern.prototype.p = w;
  }
}

export function editPattern(pattern) {
  const declared = ev || fresh();
  ev = null;
  const state = analyse(pattern, getCycle(), declared);
  cur = state;
  curPattern = pattern;
  horizon = Math.max(0, Math.floor(getCycle() || 0)) + QUERY_CYCLES;
  lookTimer ??= setInterval(lookahead, 250);
  applyStreams(state);
  const spec = specOf(state);
  remember(spec);
  if (!spec.entries.length && !spec.inline.length && !lastSpec?.entries.length && !lastSpec?.inline.length && lastSpec?.sketch === spec.sketch) {
    lastSpec = spec;
    return pattern;
  }
  send(spec);
  return pattern;
}

// ---------- output ----------
let pending = [];
const flushEvents = () => {
  const e = pending;
  pending = [];
  if (e.length) api?._events?.(e);
};
const push = (e) => {
  if (!pending.length) queueMicrotask(flushEvents);
  pending.push(e);
};
export function panic() {
  push(['', 'panic', 0, 0, 0]);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
function sendMidi(key, v, duration, t) {
  const sr = getAudioContext().sampleRate;
  const at = t * sr;
  const hasCc = v.ccn != null && v.ccv != null;
  if (hasCc) {
    const val = Number(v.ccv);
    push([key, 'cc', at, Math.round(Number(v.ccn)), Math.round(val <= 1 ? val * 127 : val)]);
  }
  const hasNote = v.note != null || v.freq != null || typeof v.n === 'number';
  if (hasCc && !hasNote) return;
  let note = 60;
  try {
    if (v.note != null || v.freq != null) note = valueToMidi(v, 60);
    else if (typeof v.n === 'number') note = 60 + v.n;
  } catch {}
  note = Math.max(0, Math.min(127, Math.round(note)));
  const vel = Math.max(1, Math.round(127 * clamp01((v.velocity ?? 0.9) * (v.gain ?? 1))));
  const len = Math.max(0.005, duration * (v.clip ?? v.legato ?? 1));
  push([key, 'on', at, note, vel]);
  push([key, 'off', at + Math.max(1, len * sr - 1), note, 0]);
}

function sendParams(set, t) {
  const sr = getAudioContext().sampleRate;
  push([set.e, 'p', t * sr, -1, set.k, set.v instanceof Object ? String(set.v) : set.v]);
}

export function wrapOutput(output) {
  return (hap, deadline, duration, cps, t) => {
    const v = hap.value;
    if (!cur || !v || typeof v !== 'object') return output(hap, deadline, duration, cps, t);
    if (v._jset) return sendParams(v._jset, t);
    const entries = cur.rack;
    const synth = typeof v.s === 'string' && entries?.get(v.s)?.kind === 'synth';
    if (!synth && !v._jfx) return output(hap, deadline, duration, cps, t);
    let path;
    try {
      path = pathOf(cur, v, hap);
    } catch (e) {
      reportError(e);
      return;
    }
    const key = keyAt(path, 0);
    if (unprepared(path)) addDynamic(path);
    const stream = synth ? null : curStreamOf.get(key) ?? cur.streams.get(key);
    // _scope() and friends: the sound is heard where the route leaves the plugins, so draw it from there
    const scoped = v.analyze != null && path.length && (synth || stream);
    if (scoped) noteScope(v.analyze, path.at(-1), v.fft);
    if (synth) return sendMidi(key, v, duration, t);
    const { _jfx, ...rest } = v;
    if (scoped) delete rest.analyze;
    if (path.length && stream) hap.value = { ...rest, orbit: 1000 * stream + (Number(rest.orbit) || 1) };
    else hap.value = rest;
    return output(hap, deadline, duration, cps, t);
  };
}

// ---------- install ----------
let installed = false;
export function installRuntime({ cycle, onError } = {}) {
  if (cycle) getCycle = cycle;
  if (onError) reportError = onError;
  if (installed) return;
  installed = true;
  refreshPlugins();
  Pattern.prototype.fx = fx;
  Pattern.prototype.cc = cc;
  Pattern.prototype.$st = function (entry, params) {
    const name = entry instanceof Pattern ? entry.__pure : entry;
    if (typeof name !== 'string' || !isPlainObject(params)) throw new Error('.set("entry", { param: value }) takes a rack entry name and an object');
    return jellySet(this, name, params);
  };
  evalScope({ rack, vst, __jvstAt });
}
