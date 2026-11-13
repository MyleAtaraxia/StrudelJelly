// Shared renderer-side state for the VST UI: the plugin catalogue, the scan, the engine status and the rack status.
// Everything here only listens (onRack / onScan / onStatus); nothing polls.
import { lastRack, onRack as onRackRuntime, paramDiffs } from '../runtime.js';

export const api = window.jelly?.vst || null;
export { lastRack, paramDiffs };
export const onRack = onRackRuntime;

let plugins = [];
let scan = null;
let status = null;
const catalogueListeners = new Set();
const statusListeners = new Set();

export const getPlugins = () => plugins;
export const getScan = () => scan;
export const getStatus = () => status;
export const onCatalogue = (fn) => (catalogueListeners.add(fn), () => catalogueListeners.delete(fn));
export const onStatus = (fn) => (statusListeners.add(fn), () => statusListeners.delete(fn));

// by name, ignoring case, also with the vendor in front (same rule as the engine)
export function findPlugin(name) {
  const n = String(name ?? '').toLowerCase();
  return plugins.find((p) => p.name === name) || plugins.find((p) => p.name.toLowerCase() === n) ||
    plugins.find((p) => `${p.vendor} ${p.name}`.toLowerCase() === n) || null;
}

const paramCache = new Map(); // plugin name -> Promise<params[]>
export function paramsOf(name) {
  const p = findPlugin(name);
  const key = p?.name ?? name;
  if (!paramCache.has(key)) paramCache.set(key, (api ? api.params(key) : Promise.resolve([])).then((l) => l || []).catch(() => []));
  return paramCache.get(key);
}

async function refreshCatalogue() {
  if (!api) return;
  try {
    plugins = (await api.plugins()) || [];
    scan = await api.scanInfo();
  } catch {}
  catalogueListeners.forEach((fn) => fn());
}

let started = false;
export function startState() {
  if (started || !api) return;
  started = true;
  refreshCatalogue();
  api.onScan?.((info) => {
    scan = info;
    if (!info?.scanning) {
      paramCache.clear();
      refreshCatalogue();
    } else catalogueListeners.forEach((fn) => fn());
  });
  api.status?.().then((s) => {
    status = s;
    statusListeners.forEach((fn) => fn(s));
  }).catch(() => {});
  api.onStatus?.((s) => {
    status = s;
    statusListeners.forEach((fn) => fn(s));
  });
}

// ---------- small helpers ----------
export const kindOf = (pluginName) => findPlugin(pluginName)?.kind || 'effect';
export const fmtNum = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  const r = a >= 100 ? Math.round(v * 10) / 10 : a >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000;
  return String(r);
};
export const rackEntry = (name) => lastRack()?.entries.find((e) => e.name === name) || null;
export const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
export const chip = (kind) => h('span', `vst-chip ${kind === 'synth' ? 'syn' : 'fx'}`, kind === 'synth' ? 'synth' : 'effect');
export const I = (d, extra = '') => `<svg aria-hidden="true" viewBox="0 0 24 24" ${extra}><path d="${d}"></path></svg>`;
export const ICON = {
  plus: I('M12 5v14M5 12h14'),
  close: I('M6 6l12 12M18 6L6 18'),
  window: I('M4 6h16v12H4zM4 10h16'),
  list: I('M4 6h16M4 12h16M4 18h10'),
  search: I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'),
  copy: I('M9 9h10v10H9zM5 15V5h10'),
  save: I('M5 4h12l3 3v13H5zM8 4v5h8V4M8 20v-6h8v6'),
  undo: I('M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12'),
};
