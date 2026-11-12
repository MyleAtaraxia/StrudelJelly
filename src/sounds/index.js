import { loadLibrary, listSounds, preview } from '../strudel.js';

// Contract with main.js: initSounds({ editor, store, jelly, container, showSounds }) -> { refresh }
// editor = StrudelMirror (editor.editor is the CodeMirror view). refresh() is called once sounds are loaded.
const MARKUP = `
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab tab-pink" data-tab="mine" aria-selected="true">Mine</button>
        <button type="button" role="tab" class="tab tab-butter" data-tab="drums" aria-selected="false">Drums</button>
        <button type="button" role="tab" class="tab tab-mint" data-tab="samples" aria-selected="false">Samples</button>
        <button type="button" role="tab" class="tab tab-lilac" data-tab="instruments" aria-selected="false">Synths</button>
      </div>
      <div class="tab-body" id="tab-body">
        <div class="search">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"></path></svg>
          <input type="search" id="search" aria-label="Search sounds" placeholder="Search sounds">
        </div>

        <div class="mine-tools" id="mine-tools">
          <div class="dropzone" id="dropzone">
            <svg class="drop-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"></path></svg>
            <div class="dropzone-text"><b>Drop sounds or folders here</b><span>Each folder becomes one sound. Loose files go into the name below.</span></div>
          </div>
          <label class="field-label" for="bank-name">Name for loose files</label>
          <input class="field" id="bank-name" type="text" value="my_sounds" spellcheck="false">
          <div class="row">
            <button type="button" class="btn btn-mint btn-sm" id="add-files">Add files</button>
            <button type="button" class="btn btn-sky btn-sm" id="add-folder">Add folders</button>
            <button type="button" class="btn btn-cream btn-sm" id="open-folder">Open folder</button>
          </div>
        </div>

        <p class="hint" id="hint"></p>
        <div class="chips" id="chips"></div>
      </div>
      `;

export function initSounds({ editor, store, jelly, container, showSounds }) {
container.innerHTML = MARKUP;
const $ = (id) => container.querySelector('#' + id);
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
    showSounds();
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


return { refresh: renderSounds };
}
