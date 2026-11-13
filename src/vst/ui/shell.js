// The app-level VST pieces: Settings > Audio and Plugins, the CPU meter in the transport pill and the engine banner
// under the code panel's header. The markup is in index.html; this only fills it in and wires it.
import { api, getScan, getStatus, onCatalogue, onStatus, startState, h } from './state.js';

const BUFFERS = [128, 256, 512, 1024];

export function initShell({ getKnobs, setKnobs }) {
  const $ = (id) => document.getElementById(id);
  const audio = $('set-audio'), plugins = $('set-plugins'), cpu = $('vst-cpu'), banner = $('vst-banner');
  if (!api) {
    // no engine bridge (plain browser): hide everything VST
    for (const el of [audio, plugins, cpu, banner]) if (el) el.hidden = true;
    return;
  }
  startState();

  // ---------- CPU meter ----------
  const cpuBar = cpu.querySelector('i'), cpuVal = cpu.querySelector('.vst-cpu-val');
  function renderCpu(s) {
    const live = s && (s.state === 'ready' || s.state === 'restarting');
    cpu.hidden = !live;
    if (!live) return;
    const pct = Math.round(Math.max(0, Math.min(1, s.cpu || 0)) * 100);
    cpuBar.style.setProperty('--cpu', `${pct}%`);
    cpuVal.textContent = `${pct}%`;
    cpu.dataset.level = pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : 'ok';
    cpu.title = `Audio engine CPU load \u00b7 ${s.sampleRate ? Math.round(s.sampleRate / 100) / 10 + ' kHz' : ''}${s.latencyMs ? ` \u00b7 ${Math.round(s.latencyMs * 10) / 10} ms delay` : ''}`;
  }

  // ---------- banner ----------
  const bannerText = banner.querySelector('.vst-banner-text');
  api.onBanner?.((b) => {
    if (!b?.text) return;
    banner.dataset.kind = b.kind || 'restarted';
    const [lead, ...rest] = String(b.text).split(' \u00b7 ');
    bannerText.replaceChildren(lead);
    if (rest.length) bannerText.append(' ', h('small', null, `\u00b7 ${rest.join(' \u00b7 ')}`));
    banner.hidden = false;
  });
  banner.querySelector('button').addEventListener('click', () => (banner.hidden = true));

  // ---------- Settings > Audio ----------
  const device = $('audio-device'), driverBox = $('audio-driver'), bufferBox = $('audio-buffer'), delay = $('buf-delay'), down = $('audio-down');
  let devices = { drivers: [], devices: {} };
  let settings = { driver: '', device: '', buffer: 0 };
  const status = () => getStatus();

  const seg = (box, options, current, onPick) => {
    box.replaceChildren();
    for (const [value, label] of options) {
      const b = h('button', null, label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(String(value) === String(current)));
      b.dataset.value = String(value);
      b.addEventListener('click', () => onPick(value));
      box.append(b);
    }
  };
  function renderAudio() {
    const s = status();
    const unavailable = !s || s.state === 'down';
    down.hidden = !(s && s.state === 'down');
    down.textContent = s?.state === 'down' ? `The audio engine is not running${s.error ? `: ${s.error}` : '.'}` : '';
    // output
    const names = devices.devices[settings.driver] || [];
    device.replaceChildren(h('option', null, 'System default'));
    device.firstChild.value = '';
    for (const n of names) { const o = h('option', null, n); o.value = n; device.append(o); }
    if (settings.device && !names.includes(settings.device)) { const o = h('option', null, settings.device); o.value = settings.device; device.append(o); }
    device.value = settings.device || '';
    // driver: a segmented control when there are few, a select when there are many
    const drivers = devices.drivers || [];
    const few = drivers.length <= 3 && drivers.every((d) => d.length <= 12);
    driverBox.replaceChildren();
    driverBox.className = '';
    if (few) {
      driverBox.className = 'segmented';
      driverBox.setAttribute('role', 'radiogroup');
      seg(driverBox, drivers.map((d) => [d, d]), settings.driver, (d) => setAudio({ driver: d }));
    } else {
      const sel = h('select', 'select');
      sel.dataset.testid = 'audio-driver-select';
      sel.setAttribute('aria-labelledby', 'drv-label');
      for (const d of drivers) { const o = h('option', null, d); o.value = d; sel.append(o); }
      sel.value = settings.driver;
      sel.addEventListener('change', () => setAudio({ driver: sel.value }));
      sel.disabled = unavailable;
      driverBox.append(sel);
    }
    // buffer + the delay it causes
    const cur = settings.buffer || s?.blockSize || 0;
    const opts = [...new Set([...BUFFERS, ...(cur ? [cur] : [])])].sort((a, b) => a - b);
    seg(bufferBox, opts.map((n) => [n, String(n)]), cur, (n) => setAudio({ buffer: n }));
    const sr = s?.sampleRate || 48000;
    delay.textContent = cur ? `\u2248 ${Math.round((cur / sr) * 1000 * 10) / 10} ms delay` : 'Set by the sound card';
    for (const el of audio.querySelectorAll('button, select')) el.disabled = unavailable;
  }
  async function loadAudio() {
    try {
      [devices, settings] = await Promise.all([api.audioDevices(), api.audioSettings()]);
    } catch {}
    renderAudio();
  }
  async function setAudio(patch) {
    await api.setAudio(patch);
    await loadAudio();
  }
  device.addEventListener('change', () => setAudio({ device: device.value }));

  // ---------- Settings > Plugins ----------
  const found = $('plug-found'), skipped = $('plug-skipped'), rescan = $('plug-rescan'), knobs = $('knobs-setting');
  const foldersBtn = $('plug-folders-edit'), foldersBox = $('plug-folders');
  function renderPlugins() {
    const sc = getScan();
    const s = status();
    found.textContent = sc ? `${sc.found} ${sc.found === 1 ? 'plugin' : 'plugins'} found` : 'Looking for plugins...';
    const sk = sc?.skipped || [], warn = sc?.warnings || [];
    skipped.hidden = !sk.length && !warn.length && !sc?.scanning;
    skipped.textContent = sc?.scanning ? 'Scanning...'
      : [sk.length && `${sk.length} skipped`, warn.length && `${warn.length} with warnings`].filter(Boolean).join(', ');
    skipped.title = sc?.scanning ? '' : [
      ...sk.map((x) => `${x.path.split(/[\\/]/).pop()}: ${x.reason}`),
      ...warn.map((x) => `${x.name}: ${x.warnings.join('; ')}`),
    ].join('\n');
    rescan.disabled = !!sc?.scanning || !s || s.state === 'down';
    rescan.textContent = sc?.scanning ? 'Scanning' : 'Rescan';
    foldersBtn.disabled = !s || s.state === 'down';
    knobs.disabled = !s || s.state === 'down';
    if (!foldersBox.hidden) renderFolders();
  }
  rescan.addEventListener('click', () => api.rescan());
  knobs.checked = !!getKnobs();
  knobs.addEventListener('change', () => setKnobs(knobs.checked));

  let folders = [];
  const saveFolders = (list) => {
    folders = list;
    api.setFolders(list);
    renderFolders();
  };
  function renderFolders() {
    const sc = getScan();
    folders = sc?.folders || folders;
    foldersBox.replaceChildren();
    for (const f of folders) {
      const row = h('div', 'plug-folder');
      row.append(h('code', null, f));
      if (sc?.defaults?.some((d) => d.toLowerCase() === f.toLowerCase())) row.append(h('small', null, 'standard'));
      else {
        const x = h('button', 'head-btn sq', '\u00d7');
        x.type = 'button';
        x.title = 'Stop scanning this folder';
        x.setAttribute('aria-label', `Remove ${f}`);
        x.addEventListener('click', () => saveFolders(folders.filter((y) => y !== f)));
        row.append(x);
      }
      foldersBox.append(row);
    }
    const add = h('div', 'plug-folder-add');
    const input = h('input');
    input.type = 'text';
    input.placeholder = 'C:\\Path\\to\\plugin folder';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Plugin folder to add');
    const go = h('button', 'head-btn', 'Add');
    go.type = 'button';
    const commit = () => {
      const v = input.value.trim().replace(/^"|"$/g, '');
      if (v && !folders.includes(v)) saveFolders([...folders, v]);
    };
    go.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); });
    add.append(input, go);
    foldersBox.append(add);
  }
  foldersBtn.addEventListener('click', () => {
    foldersBox.hidden = !foldersBox.hidden;
    foldersBtn.textContent = foldersBox.hidden ? 'Edit' : 'Done';
    if (!foldersBox.hidden) renderFolders();
  });

  const all = () => {
    renderCpu(status());
    renderAudio();
    renderPlugins();
  };
  onStatus((s) => {
    const was = lastState;
    lastState = s?.state;
    renderCpu(s);
    if (was !== lastState) {
      all();
      if (lastState === 'ready') loadAudio();
    }
  });
  let lastState = null;
  onCatalogue(renderPlugins);
  api.status().then((s) => { lastState = s?.state; all(); if (s?.state === 'ready') loadAudio(); });
  loadAudio();
  return { refresh: () => { loadAudio(); renderPlugins(); }, setKnobsChecked: (v) => (knobs.checked = v) };
}
