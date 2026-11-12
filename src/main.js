import './style.css';
import { createEditor, allBuiltinUrls, onDocChange, softEvaluate, setPatternMarks, highlightSource, revealSource } from './strudel.js';
import { createSketches } from './sketches.js';
import { createViz, ZOOM_LEVELS } from './viz.js';
import { initSounds } from './sounds/index.js';

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
  jelly?.setTitlebar(dark ? '#2B2430' : '#FBE4E6', dark ? '#F6EADB' : '#5C4037');
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
  vizHeight: 170,
  hotReload: true,
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
let evalCode = '';
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
  $('update-hint').hidden = !(started && editor && editor.code !== evalCode);
}
function renderTempo() {
  const cps = editor?.repl.scheduler.cps;
  if (!cps) return;
  // 4 beats per cycle (see the tooltip in index.html)
  $('tempo').textContent = `${num(cps * 240)} BPM · ${num(cps * 60)} cpm`;
}
function showError(err) {
  evalError = err || null;
  errorBox.hidden = !err;
  errorBox.textContent = err ? String(err.message || err) : '';
  renderTransport();
}
const evaluate = () => editor.evaluate().catch(showError);
const toggle = () => (started ? editor.stop() : evaluate());

editor = createEditor({
  root: $('editor'),
  initialCode: '',
  settings: { ...prefs, theme: isDark() ? 'jellyDark' : 'jellyLight' },
  onEvalError: showError,
  onEval: (code = editor.code) => {
    evalCode = code;
    // tie notes to their code: colour bars per `$:` block (only while the text still matches what was evaluated)
    const src = viz?.setSource(code);
    if (src && editor.code === code) setPatternMarks(editor, src.labelled && src.blocks.length > 1 ? src.blocks : []);
    try { viz?.redraw(); } catch (e) { console.warn('viz', e); }
    renderTransport();
    renderTempo();
  },
  onFrame: () => viz.frame(),
  onUpdateState: (s) => {
    if (!!s.started === started) return;
    started = !!s.started;
    viz?.setPlaying(started);
    clearInterval(tempoTimer);
    tempoTimer = started ? setInterval(renderTempo, 400) : null;
    renderTempo();
    renderTransport();
  },
});
viz = createViz({
  panel: $('main-col'), strip: $('viz'), canvas: $('viz-canvas'), scheduler: () => editor.repl.scheduler,
  // hovering a note lights up the code that made it, clicking jumps there (positions are only valid for unchanged code)
  onHover: (ranges, code) => highlightSource(editor, ranges && editor.code === code ? ranges : null),
  onPick: (loc, code) => loc && editor.code === code && revealSource(editor, loc.start),
});
viz.setVisible(prefs.visualStrip);
renderTempo();
renderTransport();
onDocChange(editor, renderTransport);

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

const vizToggle = $('viz-toggle');
const vizSetting = $('viz-setting');
function setViz(on) {
  prefs.visualStrip = on;
  viz.setVisible(on);
  vizToggle.setAttribute('aria-pressed', String(on));
  vizToggle.title = on ? 'Hide piano roll' : 'Show piano roll';
  vizSetting.checked = on;
  savePrefs();
}
setViz(prefs.visualStrip);
vizToggle.addEventListener('click', () => setViz(!prefs.visualStrip));
vizSetting.addEventListener('change', () => setViz(vizSetting.checked));

// piano roll zoom: buttons, or the mouse wheel over the roll
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
let wheelAcc = 0;
$('viz-canvas').addEventListener('wheel', (e) => {
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) >= 60) { zoomBy(wheelAcc < 0 ? -1 : 1); wheelAcc = 0; }
}, { passive: false });
setZoom(prefs.vizCycles);

// piano roll height: drag the handle between the two capsules (arrow keys work too, double-click resets)
const mainCol = $('main-col');
const splitter = $('viz-splitter');
const MIN_VIZ = 90;
function setVizHeight(px, save = true) {
  const max = Math.max(MIN_VIZ, mainCol.clientHeight - 14 - 140); // leave the code at least 140px
  prefs.vizHeight = Math.round(Math.min(max, Math.max(MIN_VIZ, px)));
  mainCol.style.setProperty('--viz-h', prefs.vizHeight + 'px');
  splitter.setAttribute('aria-valuenow', String(prefs.vizHeight));
  if (save) savePrefs();
}
splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const startH = $('viz').offsetHeight;
  const move = (ev) => setVizHeight(startH + startY - ev.clientY, false);
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
  if (e.key === 'ArrowUp') setVizHeight(prefs.vizHeight + 20);
  else if (e.key === 'ArrowDown') setVizHeight(prefs.vizHeight - 20);
  else return;
  e.preventDefault();
});
splitter.addEventListener('dblclick', () => setVizHeight(EDITOR_DEFAULTS.vizHeight));
setVizHeight(prefs.vizHeight, false);
addEventListener('resize', () => setVizHeight(prefs.vizHeight, false));

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
    evalCode = editor.code;
    if (loaded) refreshPattern();
    renderTransport();
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
  $('pane-sounds').hidden = name !== 'sounds';
  $('pane-settings').hidden = name !== 'settings';
  if (name === 'settings') refreshOffline();
  if (name === 'sketches') sketches.refresh();
  store.set('jelly-pane', name || '');
}
document.querySelectorAll('[data-pane]').forEach((b) =>
  b.addEventListener('click', () => showPane(pane === b.dataset.pane ? null : b.dataset.pane)),
);

const sounds = initSounds({ editor, store, jelly, container: $('pane-sounds'), showSounds: () => pane !== 'sounds' && showPane('sounds') });

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
