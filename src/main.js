import './style.css';
import { createEditor, loadLibrary, listSounds, preview, allBuiltinUrls } from './strudel.js';

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
$('toggle-sounds').addEventListener('click', (e) => {
  const on = workspace.classList.toggle('no-sounds');
  e.currentTarget.setAttribute('aria-pressed', String(!on));
});

const TAB_COLORS = {
  mine: ['--j-pink', '--j-butter', '--j-mint', '--j-sky', '--j-lilac'],
  drums: ['--j-butter', '--j-oat', '--j-pink'],
  samples: ['--j-mint', '--j-sky', '--j-butter'],
  instruments: ['--j-lilac', '--j-sky', '--j-pink'],
};
const LIMIT = 400;
let tab = 'mine';

const isDrum = (s) => s.baseUrl?.includes('tidal-drum-machines');

function soundsFor(which) {
  const all = listSounds();
  if (which === 'mine') return all.filter((s) => s.tag === 'mine').map((s) => ({ ...s, insert: s.name }));
  if (which === 'samples') return all.filter((s) => s.type === 'sample' && s.tag !== 'mine' && !isDrum(s)).map((s) => ({ ...s, insert: s.name }));
  if (which === 'instruments') return all.filter((s) => s.type !== 'sample').map((s) => ({ ...s, insert: s.name, count: 0 }));
  const banks = new Map();
  for (const s of all.filter(isDrum)) {
    const bank = s.name.split('_')[0];
    const b = banks.get(bank) || { name: bank, type: 'sample', count: 0, bank: true, play: s.name };
    b.count++;
    if (s.name.endsWith('_bd')) b.play = s.name;
    banks.set(bank, b);
  }
  return [...banks.values()];
}

function insertAtCursor(text) {
  const view = editor.editor;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

function insertSound(item) {
  const view = editor.editor;
  const pos = view.state.selection.main.from;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const inString = (before.match(/"/g) || []).length % 2 === 1;
  if (item.bank) return insertAtCursor(inString ? item.name : `.bank("${item.name}")`);
  if (inString) return insertAtCursor((/[\s"[<{(,]$/.test(before) ? '' : ' ') + item.name);
  insertAtCursor(`s("${item.name}")`);
}

const PLAY_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"></path></svg>';

function renderSounds() {
  const q = $('search').value.trim().toLowerCase();
  const items = soundsFor(tab).filter((s) => !q || s.name.toLowerCase().includes(q));
  const chips = $('chips');
  chips.replaceChildren();
  const colors = TAB_COLORS[tab];
  items.slice(0, LIMIT).forEach((item, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.setProperty('--chip', `var(${colors[i % colors.length]})`);
    chip.style.animationDelay = `${Math.min(i, 30) * 12}ms`;
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'chip-play';
    play.setAttribute('aria-label', `Hear ${item.name}`);
    play.innerHTML = PLAY_ICON;
    play.addEventListener('click', async () => {
      if (chip.classList.contains('loading')) return;
      chip.classList.remove('failed');
      const slow = setTimeout(() => chip.classList.add('loading'), 120);
      play.setAttribute('aria-busy', 'true');
      try {
        await preview(item.play || item.name, item.type);
        chip.classList.remove('loading');
      } catch (e) {
        console.warn(e);
        chip.classList.remove('loading');
        chip.classList.add('failed');
        setTimeout(() => chip.classList.remove('failed'), 1200);
      } finally {
        clearTimeout(slow);
        play.removeAttribute('aria-busy');
      }
    });
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'chip-name';
    name.title = item.bank ? `Insert .bank("${item.name}")` : `Insert ${item.name}`;
    name.textContent = item.name;
    if (item.count > 1) {
      const c = document.createElement('span');
      c.className = 'chip-count';
      c.textContent = item.count;
      name.append(c);
    }
    name.addEventListener('click', () => insertSound(item));
    chip.append(play, name);
    chips.append(chip);
  });
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = tab === 'mine' && !q ? 'No sounds yet. Drop some audio files or folders anywhere on the window.' : 'Nothing matches that search.';
    chips.append(empty);
  }
  const hints = {
    mine: 'Click a name to put it in your code. Press the triangle to hear it.',
    drums: 'Drum machines: use with s("bd sd hh") and .bank(...)',
    samples: 'Sample sets. Use n("0 1 2") to pick variations.',
    instruments: 'Synths, wavetables and General MIDI instruments. Play them with note(...)',
  };
  $('hint').textContent = items.length > LIMIT ? `Showing ${LIMIT} of ${items.length}. Search to narrow it down.` : hints[tab];
}

document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    $('mine-tools').hidden = tab !== 'mine';
    renderSounds();
  }),
);
$('search').addEventListener('input', renderSounds);

// ---------- adding samples ----------
const bankName = () => $('bank-name').value.trim() || 'my_sounds';
async function addPaths(paths) {
  if (!paths.length) return;
  const n = await jelly.add(paths, bankName());
  await refreshLibrary();
  $('hint').textContent = n ? `Added ${n} sound file${n === 1 ? '' : 's'}.` : 'No audio files found in that.';
}
async function refreshLibrary() {
  await loadLibrary().catch((e) => console.warn(e));
  renderSounds();
}

$('add-files').addEventListener('click', async () => addPaths(await jelly.pick(false)));
$('add-folder').addEventListener('click', async () => addPaths(await jelly.pick(true)));
$('open-folder').addEventListener('click', () => jelly.openLibrary());
jelly.onLibraryChanged(refreshLibrary);

const dropzone = $('dropzone');
let dragDepth = 0;
const showMineTab = () => tab !== 'mine' && document.querySelector('.tab[data-tab="mine"]').click();
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  if (dragDepth++ === 0) {
    workspace.classList.remove('no-sounds');
    showMineTab();
    dropzone.classList.add('over');
  }
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzone.classList.remove('over');
  }
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('over');
  addPaths([...(e.dataTransfer?.files || [])].map((f) => jelly.pathForFile(f)).filter(Boolean));
});

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
$('settings').addEventListener('toggle', (e) => e.newState === 'open' && refreshOffline());

editor.prebaked.then(() => {
  pill.textContent = 'Ready';
  urls = allBuiltinUrls();
  renderSounds();
});
