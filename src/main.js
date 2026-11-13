import './style.css';
import { createEditor, allBuiltinUrls, onDocChange, onSelectionChange, cursorPos, softEvaluate, setPatternMarks, highlightSource, revealSource, stopExample, playingExample } from './strudel.js';
import { createSketches } from './sketches.js';
import { createViz, ZOOM_LEVELS, ROW_ZOOM_LEVELS } from './viz.js';
import { initSounds } from './sounds/index.js';
import { initDocs } from './docs/index.js';
import { initVstUi } from './vst/ui/index.js';
import { initShell } from './vst/ui/shell.js';
import { initMixer } from './mixer/index.js';
import { getCM } from '@replit/codemirror-vim';

const $ = (id) => document.getElementById(id);
const jelly = window.jelly;
const store = {
  get(k, d) {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

const DEFAULT_CODE = `// strudel jelly
// Ctrl+Enter plays or updates, Ctrl+. stops.
// Click a sound on the right to drop it into your code.

setcps(0.5)

$: s("bd*2, ~ sd, [~ hh]*4").bank("RolandTR909")

$: note("<c2 eb2 g2 bb1>*2").s("sawtooth")
  .lpf(sine.range(300, 1400).slow(4)).decay(.15).sustain(0)

$: n("0 2 4 <6 7>").scale("C4:minor").s("gm_epiano1")
  .room(.6).slow(2)
`;

// ---------- sound loading indicator (status bar) ----------
// Count in-flight audio/sample downloads by wrapping fetch.
const AUDIO_URL = /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff|opus)([?#]|$)|webaudiofontdata/i;
let loadingCount = 0;
function renderLoading() {
  const el = document.querySelector('[data-testid=status-loading]');
  el.hidden = loadingCount === 0;
  $('status-loading-text').textContent = `Loading sounds… (${loadingCount})`;
}
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!AUDIO_URL.test(url)) return nativeFetch(input, init);
  loadingCount++;
  renderLoading();
  return nativeFetch(input, init).finally(() => {
    loadingCount--;
    renderLoading();
  });
};

// ---------- theme ----------
const mq = matchMedia('(prefers-color-scheme: dark)');
let editor;
let viz;
const isDark = () => {
  const pref = store.get('jelly-theme', 'system');
  return pref === 'dark' || (pref === 'system' && mq.matches);
};
function applyTheme() {
  const dark = isDark();
  const pref = store.get('jelly-theme', 'system');
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === pref)));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  editor?.reconfigureExtension('theme', dark ? 'jellyDark' : 'jellyLight');
  viz?.refreshColors();
  jelly?.setTitlebar(dark ? '#12160F' : '#E3F5D6', dark ? '#F4F7E8' : '#3E3A25');
}
mq.addEventListener('change', applyTheme);
document.querySelectorAll('[data-theme-choice]').forEach((b) =>
  b.addEventListener('click', () => {
    store.set('jelly-theme', b.dataset.themeChoice);
    applyTheme();
  }),
);
applyTheme();

// ---------- editor settings (saved per user) ----------
const EDITOR_DEFAULTS = {
  fontSize: 17,
  isLineWrappingEnabled: true,
  isAutoCompletionEnabled: true,
  isPatternHighlightingEnabled: true,
  isLineNumbersDisplayed: true,
  visualStrip: true,
  vizCycles: 4,
  vizRowZoom: 1,
  vizHeight: 170,
  hotReload: true,
  keybindings: 'codemirror', // or 'vim'
  vstKnobsUpdateCode: false, // plugin knobs rewrite values already written in the rack
};
let prefs;
try {
  prefs = { ...EDITOR_DEFAULTS, ...JSON.parse(store.get('jelly-editor', '{}')) };
} catch {
  prefs = { ...EDITOR_DEFAULTS };
}
const savePrefs = () => store.set('jelly-editor', JSON.stringify(prefs));

// ---------- editor + transport ----------
const errorBox = $('error');
const playBtn = $('play');
let loaded = false;
let started = false;
let evalError = null;
let tempoTimer = null;

const num = (n) => String(Math.round(n * 10) / 10);
function renderTransport() {
  const state = !loaded ? 'loading' : evalError ? 'error' : started ? 'playing' : 'ready';
  document.body.dataset.state = state;
  playBtn.disabled = !loaded;
  playBtn.classList.toggle('loading', !loaded);
  playBtn.classList.toggle('is-playing', started);
  $('play-label').textContent = started ? 'Stop' : 'Play';
  playBtn.title = !loaded ? 'Loading sounds' : started ? 'Stop (Ctrl+.). Ctrl+Enter updates.' : 'Play (Ctrl+Enter)';
}
function renderTempo() {
  const cps = editor?.repl.scheduler.cps;
  if (!cps) return;
  // 4 beats per cycle (see the tooltip in index.html)
  $('tempo').innerHTML = `<b>${num(cps * 240)}</b> BPM · ${num(cps * 60)} cpm`;
}
// cycle counter: runs from the draw loop while playing, back to 0 when stopped
let shownCycle = -1;
function renderCycle() {
  const c = started ? Math.max(0, Math.floor(editor.repl.scheduler.now())) : 0;
  if (c === shownCycle) return;
  shownCycle = c;
  $('cycle').innerHTML = `cycle <b>${c}</b>`;
}
const renderCursor = () => {
  const { line, col } = cursorPos(editor);
  $('status-cursor').textContent = `Ln ${line}, Col ${col}`;
};
function showError(err) {
  evalError = err || null;
  errorBox.hidden = !err;
  errorBox.textContent = err ? String(err.message || err).replace(/\s+/g, ' ').trim() : '';
  errorBox.title = err ? String(err.message || err) : '';
  renderTransport();
}
const evaluate = () => editor.evaluate().catch(showError);
const toggle = () => (playingExample() ? stopExample() : started ? editor.stop() : evaluate());

editor = createEditor({
  root: $('editor'),
  initialCode: '',
  settings: { ...prefs, theme: isDark() ? 'jellyDark' : 'jellyLight' },
  onEvalError: showError,
  onEval: (code = editor.code) => {
    // tie notes to their code: colour bars per `$:` block (only while the text still matches what was evaluated)
    const src = viz?.setSource(code);
    if (src && editor.code === code) setPatternMarks(editor, src.labelled && src.blocks.length > 1 ? src.blocks : []);
    try { viz?.redraw(); } catch (e) { console.warn('viz', e); }
    renderTransport();
    renderTempo();
  },
  onFrame: () => {
    viz.frame();
    renderCycle();
  },
  onUpdateState: (s) => {
    if (!!s.started === started) return;
    started = !!s.started;
    if (started) stopExample(); // one thing plays at a time
    viz?.setPlaying(started);
    clearInterval(tempoTimer);
    tempoTimer = started ? setInterval(renderTempo, 400) : null;
    renderTempo();
    renderCycle();
    renderTransport();
  },
});
// VST: autocomplete, status pills, hover card, Ctrl+click and knobs-to-code (src/vst/ui); the Mixer pane is below
const vstUi = initVstUi({ editor, getKnobsPref: () => prefs.vstKnobsUpdateCode });
let mixer = null;
viz = createViz({
  panel: $('main-col'), strip: $('viz'), canvas: $('viz-canvas'), scheduler: () => editor.repl.scheduler,
  // hovering a note lights up the code that made it, clicking jumps there (positions are only valid for unchanged code)
  onHover: (ranges, code) => highlightSource(editor, ranges && editor.code === code ? ranges : null),
  onPick: (loc, code) => loc && editor.code === code && revealSource(editor, loc.start),
  // panning the roll stops it following the playhead; the Follow button brings it back
  onFollowChange: (following) => ($('viz-follow').hidden = following),
});
$('viz-follow').addEventListener('click', () => viz.follow());
viz.setVisible(prefs.visualStrip);
renderTempo();
renderTransport();
onDocChange(editor, () => { vstUi?.hide(); mixer?.onDocChange(); });
onSelectionChange(editor, renderCursor);
renderCursor();

// ---------- hot reload ----------
// Re-evaluate shortly after typing stops. While stopped this only refreshes the pattern (for the piano roll); it never
// starts playback. Code that does not parse yet is skipped, so the last good version keeps playing.
const HOT_DELAY = 450;
let hotTimer = null;
let hotRun = Promise.resolve();
const refreshPattern = () => {
  hotRun = hotRun.then(() => softEvaluate(editor)).catch(showError);
  return hotRun;
};
onDocChange(editor, () => {
  clearTimeout(hotTimer);
  if (loaded && prefs.hotReload) hotTimer = setTimeout(refreshPattern, HOT_DELAY);
});
const hotSetting = $('hot-setting');
hotSetting.checked = prefs.hotReload;
hotSetting.addEventListener('change', () => {
  prefs.hotReload = hotSetting.checked;
  savePrefs();
  if (prefs.hotReload && loaded) refreshPattern();
});

playBtn.addEventListener('click', toggle);
// the editor handles these itself while it has focus (and prevents default); this covers focus elsewhere
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); evaluate(); }
  else if (e.key === '.') { e.preventDefault(); editor.stop(); }
});
// Ctrl+. also stops a docs example (the editor's own Ctrl+. only knows about the sketch)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '.' && playingExample()) stopExample();
}, true);

const vizSetting = $('viz-setting');
function setViz(on) {
  prefs.visualStrip = on;
  viz.setVisible(on);
  vizSetting.checked = on;
  savePrefs();
}
setViz(prefs.visualStrip);
vizSetting.addEventListener('change', () => setViz(vizSetting.checked));

// piano roll zoom: buttons, or Ctrl+wheel (or a touchpad pinch) over the roll; plain wheel scrolls and pans it (viz.js)
function setZoom(cycles) {
  prefs.vizCycles = ZOOM_LEVELS.includes(cycles) ? cycles : 4;
  viz.setCycles(prefs.vizCycles);
  $('zoom-val').textContent = prefs.vizCycles === 1 ? '1 cycle' : `${prefs.vizCycles} cycles`;
  $('zoom-in').disabled = prefs.vizCycles === ZOOM_LEVELS[0];
  $('zoom-out').disabled = prefs.vizCycles === ZOOM_LEVELS.at(-1);
  savePrefs();
}
const zoomBy = (step) => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, ZOOM_LEVELS.indexOf(prefs.vizCycles) + step))]);
$('zoom-in').addEventListener('click', () => zoomBy(-1));
$('zoom-out').addEventListener('click', () => zoomBy(1));
// row height (vertical zoom): buttons, or Alt+wheel over the roll, which keeps the row under the mouse in place
function setRowZoom(z, anchorY) {
  prefs.vizRowZoom = ROW_ZOOM_LEVELS.includes(z) ? z : 1;
  viz.setRowZoom(prefs.vizRowZoom, anchorY);
  $('rows-val').textContent = `${prefs.vizRowZoom}\u00d7 rows`;
  $('rows-in').disabled = prefs.vizRowZoom === ROW_ZOOM_LEVELS.at(-1);
  $('rows-out').disabled = prefs.vizRowZoom === ROW_ZOOM_LEVELS[0];
  savePrefs();
}
const rowZoomBy = (step, anchorY) =>
  setRowZoom(ROW_ZOOM_LEVELS[Math.min(ROW_ZOOM_LEVELS.length - 1, Math.max(0, ROW_ZOOM_LEVELS.indexOf(prefs.vizRowZoom) + step))], anchorY);
$('rows-in').addEventListener('click', () => rowZoomBy(1));
$('rows-out').addEventListener('click', () => rowZoomBy(-1));

let wheelAcc = 0;
$('viz-canvas').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.altKey) return;
  e.preventDefault();
  wheelAcc += e.deltaY || e.deltaX; // some systems turn Alt+wheel into a sideways scroll
  if (Math.abs(wheelAcc) < 60) return;
  if (e.ctrlKey) zoomBy(wheelAcc < 0 ? -1 : 1);
  else rowZoomBy(wheelAcc < 0 ? 1 : -1, e.offsetY);
  wheelAcc = 0;
}, { passive: false });
setZoom(prefs.vizCycles);
setRowZoom(prefs.vizRowZoom);

// piano roll height: drag the handle between the two capsules (arrow keys work too, double-click resets)
const mainCol = $('main-col');
const splitter = $('viz-splitter');
const MIN_VIZ = 90;
// prefs.vizHeight is the height the user asked for; a small window only shrinks what is shown, never the pref
function setVizHeight(px, save = true) {
  prefs.vizHeight = Math.round(Math.max(MIN_VIZ, px));
  fitVizHeight();
  if (save) savePrefs();
}
function fitVizHeight() {
  const max = Math.max(MIN_VIZ, mainCol.clientHeight - 12 - 140); // leave the code at least 140px
  const h = Math.min(max, prefs.vizHeight);
  mainCol.style.setProperty('--viz-h', h + 'px');
  splitter.setAttribute('aria-valuenow', String(h));
}
splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = $('viz').offsetHeight;
  const maxH = Math.max(MIN_VIZ, mainCol.clientHeight - 12 - 140);
  const move = (ev) => setVizHeight(Math.min(maxH, startH + startY - ev.clientY), false);
  const up = () => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    splitter.removeEventListener('pointercancel', up);
    savePrefs();
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});
splitter.addEventListener('keydown', (e) => {
  const cur = $('viz').offsetHeight;
  if (e.key === 'ArrowUp') setVizHeight(Math.min(mainCol.clientHeight - 12 - 140, cur + 20));
  else if (e.key === 'ArrowDown') setVizHeight(cur - 20);
  else return;
  e.preventDefault();
});
splitter.addEventListener('dblclick', () => setVizHeight(EDITOR_DEFAULTS.vizHeight));
setVizHeight(prefs.vizHeight, false);
new ResizeObserver(fitVizHeight).observe(mainCol);

// ---------- sketches ----------
const nameBtn = $('sketch-name');
const sketches = createSketches({
  editor, store, jelly, container: $('pane-sketches'), defaultCode: DEFAULT_CODE,
  showPane: () => showPane('sketches'),
  onName: (name) => { nameBtn.textContent = name; },
  getSettings: () => ({ ...prefs, theme: isDark() ? 'jellyDark' : 'jellyLight' }),
  // a different sketch is open: stop the old one's music and show the new one's pattern
  onOpen: () => {
    clearTimeout(hotTimer);
    if (started) editor.stop();
    showError(null);
    renderCursor();
    if (loaded) refreshPattern();
    renderTransport();
    vstUi?.refresh();
    mixer?.refresh();
  },
  onSaveState: (st) => {
    const el = $('save-state');
    el.dataset.state = st;
    el.textContent = { saved: 'Saved', edited: 'Edited', error: 'Save failed' }[st];
  },
});
nameBtn.addEventListener('click', () => showPane('sketches'));
nameBtn.addEventListener('dblclick', () => {
  const input = document.createElement('input');
  input.className = 'sketch-rename';
  input.value = sketches.current() ?? '';
  input.maxLength = 80;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Sketch name');
  nameBtn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    input.replaceWith(nameBtn);
    if (commit) sketches.renameCurrent(input.value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});

const fontSize = $('font-size');
fontSize.value = prefs.fontSize;
$('font-size-val').textContent = prefs.fontSize;
fontSize.addEventListener('input', () => {
  prefs.fontSize = Number(fontSize.value);
  $('font-size-val').textContent = prefs.fontSize;
  editor.setFontSize(prefs.fontSize);
  savePrefs();
});
// keys: normal (CodeMirror) or Vim. In Vim mode the status bar shows the current mode.
const vimBadge = $('status-vim');
function renderVimMode() {
  const vim = prefs.keybindings === 'vim' ? getCM(editor.editor)?.state.vim : null;
  vimBadge.hidden = !vim;
  if (!vim) return;
  const mode = vim.insertMode ? 'insert' : vim.visualMode ? 'visual' : vim.mode === 'replace' ? 'replace' : 'normal';
  if (vimBadge.dataset.mode !== mode) {
    vimBadge.dataset.mode = mode;
    vimBadge.textContent = mode.toUpperCase();
  }
}
function setKeys(name) {
  prefs.keybindings = name === 'vim' ? 'vim' : 'codemirror';
  document.querySelectorAll('[data-keys-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.keysChoice === prefs.keybindings)));
  editor.reconfigureExtension('keybindings', prefs.keybindings);
  savePrefs();
  renderVimMode();
}
document.querySelectorAll('[data-keys-choice]').forEach((b) => b.addEventListener('click', () => setKeys(b.dataset.keysChoice)));
setKeys(prefs.keybindings);
// the mode changes on keys, clicks and selection changes; checking after each is cheap
for (const t of ['keyup', 'mouseup', 'focusin', 'focusout']) editor.editor.dom.addEventListener(t, () => setTimeout(renderVimMode));
onSelectionChange(editor, () => setTimeout(renderVimMode));

document.querySelectorAll('[data-setting]').forEach((box) => {
  const key = box.dataset.setting;
  box.checked = !!prefs[key];
  box.addEventListener('change', () => {
    prefs[key] = box.checked;
    editor.reconfigureExtension(key, box.checked);
    savePrefs();
  });
});

// ---------- sounds sidebar ----------
const workspace = document.querySelector('.workspace');
let pane = null;
function showPane(name) {
  pane = name;
  workspace.classList.toggle('no-sidebar', !name);
  document.querySelectorAll('[data-pane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === name)));
  $('pane-sketches').hidden = name !== 'sketches';
  $('pane-sounds-wrap').hidden = name !== 'sounds';
  $('pane-settings').hidden = name !== 'settings';
  $('pane-docs').hidden = name !== 'docs';
  $('pane-mixer').hidden = name !== 'mixer';
  if (name === 'settings') refreshOffline();
  if (name === 'sketches') sketches.refresh();
  if (name === 'mixer') mixer?.refresh();
  store.set('jelly-pane', name || '');
}
if (!jelly.vst) document.querySelector('[data-pane=mixer]').hidden = true;
document.querySelectorAll('[data-pane]').forEach((b) =>
  b.addEventListener('click', () => showPane(pane === b.dataset.pane ? null : b.dataset.pane)),
);

mixer = initMixer({ editor, container: $('pane-mixer'), showSettings: () => showPane('settings') });
const vstShell = initShell({
  getKnobs: () => prefs.vstKnobsUpdateCode,
  setKnobs: (on) => { prefs.vstKnobsUpdateCode = on; savePrefs(); },
});

const sounds = initSounds({ editor, store, jelly, container: $('pane-sounds'), showSounds: () => pane !== 'sounds' && showPane('sounds') });

// ---------- docs: sidebar pane, hover card / F1, signature tip, Ctrl+K palette ----------
const setTheme = (t) => { store.set('jelly-theme', t); applyTheme(); };
const docs = initDocs({
  editor,
  container: $('pane-docs'),
  showDocs: () => pane !== 'docs' && showPane('docs'),
  sounds,
  sketches: { list: () => jelly.sketchList(), open: (name) => sketches.open(name) },
  commands: () => [
    { label: started ? 'Stop' : 'Play', hint: started ? 'Ctrl+.' : 'Ctrl+Enter', run: toggle },
    { label: 'New sketch', hint: 'Ctrl+N', run: () => sketches.create() },
    { label: 'Save sketch', hint: 'Ctrl+S', run: () => sketches.save() },
    { label: 'Rename sketch', run: () => nameBtn.dispatchEvent(new MouseEvent('dblclick')) },
    { label: 'Duplicate sketch', run: () => sketches.duplicate() },
    { label: 'Show sketches', run: () => showPane('sketches') },
    { label: 'Show sounds', run: () => showPane('sounds') },
    { label: 'Show docs', hint: 'F1', run: () => { showPane('docs'); docs.focusSearch(); } },
    { label: 'Show mixer', run: () => showPane('mixer') },
    { label: 'Show settings', run: () => showPane('settings') },
    ...(jelly.vst ? [
      { label: 'Rescan plugins', run: () => jelly.vst.rescan() },
      ...mixer.cards().map((c) => ({ label: `Open plugin editor: ${c.name}`, hint: c.chain.map((p) => p.name).join(' > '), run: () => jelly.vst.openEditor(c.name, 0) })),
    ] : []),
    { label: 'Hide side panel', run: () => showPane(null) },
    { label: prefs.visualStrip ? 'Hide piano roll' : 'Show piano roll', run: () => setViz(!prefs.visualStrip) },
    { label: 'Piano roll: follow the playhead', run: () => viz.follow() },
    { label: prefs.hotReload ? 'Turn hot reload off' : 'Turn hot reload on', run: () => { hotSetting.checked = !prefs.hotReload; hotSetting.dispatchEvent(new Event('change')); } },
    { label: prefs.keybindings === 'vim' ? 'Keys: normal (turn Vim off)' : 'Keys: Vim', run: () => setKeys(prefs.keybindings === 'vim' ? 'codemirror' : 'vim') },
    { label: 'Theme: light', run: () => setTheme('light') },
    { label: 'Theme: dark', run: () => setTheme('dark') },
    { label: 'Theme: follow system', run: () => setTheme('system') },
    { label: 'Open sketches folder', run: () => jelly.openSketches() },
  ],
});
onSelectionChange(editor, docs.onEditorUpdate);

// ---------- offline sounds (in settings) ----------
const fill = $('fill');
const track = $('track');
const offlineLabel = $('offline-label');
const offlineBtn = $('offline');
let urls = [];

function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  fill.style.width = pct + '%';
  fill.classList.toggle('full', pct >= 100);
  track.setAttribute('aria-valuenow', String(pct));
}
const mb = (b) => (b / 1048576).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' MB';

let saving = false;
async function refreshOffline() {
  if (saving || !urls.length) return;
  const st = await jelly.cacheStatus(urls);
  setProgress(st.cached, st.total);
  const all = st.cached >= st.total;
  offlineLabel.textContent = all
    ? `Every built-in sound is on this computer (${mb(st.bytes)}).`
    : `${st.cached.toLocaleString()} of ${st.total.toLocaleString()} built-in sound files saved (${mb(st.bytes)}). Sounds also save themselves the first time they play.`;
  offlineBtn.disabled = all;
  offlineBtn.textContent = all ? 'All saved' : 'Save all sounds offline';
}

offlineBtn.addEventListener('click', () => {
  saving = true;
  offlineBtn.disabled = true;
  offlineBtn.textContent = 'Saving...';
  track.classList.add('working');
  jelly.prefetch(urls);
});
jelly.onPrefetch((p) => {
  setProgress(p.done, p.total);
  offlineLabel.textContent = p.finished
    ? p.failed ? `Done. ${p.failed} files could not be downloaded, try again later.` : 'Done!'
    : `Saving ${p.done.toLocaleString()} of ${p.total.toLocaleString()} (${mb(p.bytes)})`;
  if (p.finished) {
    saving = false;
    track.classList.remove('working');
    setTimeout(refreshOffline, 1500);
  }
});
$('open-cache').addEventListener('click', () => jelly.openCache());
showPane(store.get('jelly-pane', 'sounds') || null);

sketches.init().catch((e) => {
  console.warn('sketches', e);
  nameBtn.textContent = 'sketches unavailable';
});

editor.prebaked.catch(() => {}).then(() => {
  loaded = true;
  renderTransport();
  refreshPattern(); // draw the piano roll for the open sketch
  urls = allBuiltinUrls();
  sounds.refresh();
  if (pane === 'settings') refreshOffline();
});
