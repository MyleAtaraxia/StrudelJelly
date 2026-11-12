import './style.css';
import { createEditor, allBuiltinUrls } from './strudel.js';
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
};
let prefs;
try {
  prefs = { ...EDITOR_DEFAULTS, ...JSON.parse(store.get('jelly-editor', '{}')) };
} catch {
  prefs = { ...EDITOR_DEFAULTS };
}
const savePrefs = () => store.set('jelly-editor', JSON.stringify(prefs));

// ---------- editor + transport ----------
const pill = $('state');
const errorBox = $('error');
function showError(err) {
  errorBox.hidden = !err;
  errorBox.textContent = err ? String(err.message || err) : '';
  if (err) {
    pill.textContent = 'Oops';
    pill.className = 'pill err';
  }
}

editor = createEditor({
  root: $('editor'),
  initialCode: store.get('jelly-code', DEFAULT_CODE),
  settings: { ...prefs, theme: isDark() ? 'jellyDark' : 'jellyLight' },
  onEvalError: showError,
  onUpdateState: (s) => {
    if (s.evalError) return;
    pill.textContent = s.started ? 'Playing' : 'Stopped';
    pill.className = 'pill' + (s.started ? ' playing' : '');
    $('play').querySelector('span').textContent = s.started ? 'Update' : 'Play';
  },
});
pill.textContent = 'Loading sounds';

let savedCode = editor.code;
const saveCode = () => {
  if (editor.code !== savedCode) store.set('jelly-code', (savedCode = editor.code));
};
setInterval(saveCode, 1500);
addEventListener('beforeunload', saveCode);

$('play').addEventListener('click', () => editor.evaluate());

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
$('stop').addEventListener('click', () => editor.stop());

// ---------- sounds sidebar ----------
const workspace = document.querySelector('.workspace');
let pane = null;
function showPane(name) {
  pane = name;
  workspace.classList.toggle('no-sidebar', !name);
  document.querySelectorAll('[data-pane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === name)));
  $('pane-sounds').hidden = name !== 'sounds';
  $('pane-settings').hidden = name !== 'settings';
  if (name === 'settings') refreshOffline();
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

editor.prebaked.then(() => {
  pill.textContent = 'Ready';
  urls = allBuiltinUrls();
  sounds.refresh();
  if (pane === 'settings') refreshOffline();
});
