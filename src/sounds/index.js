import { loadLibrary, listSounds } from '../strudel.js';
import { audition, lengthOf, fmtLen } from './audio.js';
import { buildRows, buildPads, hasMine, TAB_LABELS } from './model.js';
import './sounds.css';

// Contract with main.js: initSounds({ editor, store, jelly, container, showSounds }) -> { refresh }
// editor = StrudelMirror (editor.editor is the CodeMirror view). refresh() is called once sounds are loaded.

const ROW_H = 32; // fixed row height, keep in sync with --sb-row in sounds.css
const OVER = 6; // rows rendered above and below the viewport
const TABS = [['mine', 'Mine', 'pink'], ['drums', 'Drums', 'butter'], ['samples', 'Samples', 'mint'], ['instruments', 'Synths', 'lilac']];
const PAD_COLORS = {
  mine: ['--j-pink', '--j-butter', '--j-mint', '--j-sky', '--j-lilac'],
  drums: ['--j-butter', '--j-oat', '--j-pink'],
  samples: ['--j-mint', '--j-sky', '--j-butter'],
  instruments: ['--j-lilac', '--j-sky', '--j-pink'],
};
const NOUN = { mine: 'sounds', drums: 'drum machines', samples: 'sample sets', instruments: 'instruments' };

const I = (d, extra = '') => `<svg aria-hidden="true" viewBox="0 0 24 24" ${extra}><path d="${d}"></path></svg>`;
const ICON = {
  search: I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'),
  star: I('M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z'),
  plus: I('M12 5v14M5 12h14'),
  back: I('M15 5l-7 7 7 7'),
  upload: I('M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15'),
  caret: I('M7 10l5 5 5-5'),
};

const MARKUP = `
<div class="sb" data-testid="sound-browser">
  <div class="sb-tabs" role="tablist" aria-label="Sound categories">
    ${TABS.map(([id, name, c]) => `<button type="button" role="tab" class="sb-tab" data-tab="${id}" data-testid="sound-tab-${id}" aria-selected="false" tabindex="-1">${name}</button>`).join('')}
  </div>
  <div class="sb-body" role="tabpanel" aria-label="Sounds">
    <div class="sb-toolbar">
      <label class="sb-search">${ICON.search}<input type="text" class="sb-q" data-testid="sound-search" aria-label="Search sounds" title="Search (/ or Ctrl+F)" placeholder="Search sounds" spellcheck="false" autocomplete="off"></label>
      <button type="button" class="btn btn-mint btn-sm sb-addbtn" data-testid="sound-add" title="Add sounds" aria-haspopup="menu" hidden>${ICON.plus}Add</button>
    </div>
    <div class="sb-crumb" hidden>
      <button type="button" class="icon-btn sb-sm sb-back" data-testid="sound-back" aria-label="Back" title="Back (Left, Backspace)">${ICON.back}</button>
      <span class="sb-crumb-name"></span><span class="sb-crumb-count"></span>
      <button type="button" class="icon-btn sb-sm sb-all" data-testid="sound-insert-all" aria-label="Insert into code" title="Insert into code (Enter on the list)">${ICON.plus}</button>
    </div>
    <div class="sb-list" role="listbox" tabindex="0" aria-label="Sounds" data-testid="sound-list"><div class="sb-spacer"></div></div>
    <div class="sb-padwrap" hidden><div class="sb-pads" role="group" data-testid="sound-pads"></div></div>
    <div class="sb-none" hidden></div>
    <div class="sb-drop" data-testid="sound-dropzone" hidden>
      ${ICON.upload}
      <b>Drop sounds or folders here</b>
      <span>Each folder becomes one sound. Loose files go into my_sounds.</span>
      <div class="sb-drop-btns">
        <button type="button" class="btn btn-mint btn-sm" data-testid="sound-add-files">Add files</button>
        <button type="button" class="btn btn-sky btn-sm" data-testid="sound-add-folder">Add folder</button>
      </div>
    </div>
  </div>
  <div class="sb-status" role="status" aria-live="polite" data-testid="sound-status"></div>
  <div class="sb-overlay" data-testid="sound-drop-overlay" aria-hidden="true"><div class="sb-overlay-in">${ICON.upload}<b>Drop to add to your sounds</b><span>Folders become sounds. Loose files go into my_sounds.</span></div></div>
  <div class="sb-menu" role="menu" hidden data-testid="sound-menu"></div>
</div>`;

export function initSounds({ editor, store, jelly, container, showSounds }) {
  container.innerHTML = MARKUP;
  // bounded flex column: .sb-list needs a real height to scroll (a block parent left .sb at content height, so it never overflowed)
  Object.assign(container.style, { display: 'flex', flexDirection: 'column', minHeight: '0', overflow: 'hidden' });
  const $ = (sel) => container.querySelector(sel);
  const root = $('.sb'), list = $('.sb-list'), spacer = $('.sb-spacer'), padwrap = $('.sb-padwrap'), padsEl = $('.sb-pads');
  const search = $('.sb-q'), addBtn = $('.sb-addbtn'), crumb = $('.sb-crumb'), none = $('.sb-none'), drop = $('.sb-drop');
  const statusEl = $('.sb-status'), overlay = $('.sb-overlay'), menu = $('.sb-menu');
  const tabEls = [...container.querySelectorAll('.sb-tab')];

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  // ---------- state ----------
  let all = [];
  let tab = 'drums';
  let query = '';
  let rows = [];
  let total = 0;
  let sel = -1;
  let drill = null; // { item, rowKey, pads, shown, idx, prevQuery, scroll }
  let renaming = null; // { key, name, input }
  const tabSel = {}; // tab -> selected row key
  const rowEls = new Map(); // row index -> element
  const padEls = new Map(); // shown index -> element
  const stState = new Map(); // aud -> 'loading' | 'failed'
  const hits = new Set();

  const loadFavs = () => {
    try {
      const a = JSON.parse(store.get('jelly-favs', '[]'));
      return new Set(Array.isArray(a) ? a : []);
    } catch {
      return new Set();
    }
  };
  let favs = loadFavs();
  const saveFavs = () => store.set('jelly-favs', JSON.stringify([...favs]));

  try {
    const t = store.get('jelly-sounds-tab', '');
    if (TABS.some((x) => x[0] === t)) tab = t;
  } catch {}

  // ---------- status line ----------
  let statusTimer;
  const baseStatus = () => {
    if (drill) return `${drill.shown.length} of ${drill.pads.length} pads`;
    if (tab === 'mine' && !hasMine(all)) return 'No sounds yet';
    return query ? `${total.toLocaleString()} of ${NOUN[tab]}` : `${total.toLocaleString()} ${NOUN[tab]}`;
  };
  function status(msg, ttl = 3500) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    statusTimer = setTimeout(() => (statusEl.textContent = baseStatus()), ttl);
  }
  const resetStatus = () => {
    clearTimeout(statusTimer);
    statusEl.textContent = baseStatus();
  };

  // ---------- element state (loading, failed, lit, length) ----------
  function paintEl(el) {
    const a = el.dataset.aud;
    const s = stState.get(a);
    el.classList.toggle('is-loading', s === 'loading');
    el.classList.toggle('is-failed', s === 'failed');
    el.classList.toggle('is-hit', hits.has(a));
    if (s === 'loading') el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
    if (el.dataset.len) {
      const len = el.querySelector('.sb-len');
      if (len) len.textContent = fmtLen(lengthOf(el.dataset.name, +el.dataset.n));
    }
  }
  const repaint = (aud) => {
    for (const el of rowEls.values()) if (el.dataset.aud === aud) paintEl(el);
    for (const el of padEls.values()) if (el.dataset.aud === aud) paintEl(el);
  };

  async function play(p) {
    if (stState.get(p.aud) === 'loading') return;
    hits.add(p.aud);
    stState.delete(p.aud);
    repaint(p.aud);
    setTimeout(() => {
      hits.delete(p.aud);
      repaint(p.aud);
    }, 220);
    const slow = setTimeout(() => {
      stState.set(p.aud, 'loading');
      repaint(p.aud);
    }, 120);
    try {
      await audition(p.name, { n: p.n, type: p.type });
    } catch (e) {
      console.warn(e);
      stState.set(p.aud, 'failed');
      setTimeout(() => {
        if (stState.get(p.aud) === 'failed') {
          stState.delete(p.aud);
          repaint(p.aud);
        }
      }, 1500);
    } finally {
      clearTimeout(slow);
      if (stState.get(p.aud) === 'loading') stState.delete(p.aud);
      repaint(p.aud);
    }
  }
  let auditionTimer;
  const playNow = (p) => {
    clearTimeout(auditionTimer);
    play(p);
  };
  const playSoon = (p) => {
    clearTimeout(auditionTimer);
    auditionTimer = setTimeout(() => play(p), 60);
  };

  // ---------- insert into code ----------
  function insertCode(ins) {
    const view = editor.editor;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    const inString = (before.match(/"/g) || []).length % 2 === 1;
    let text = inString ? (/[\s"[<{(,]$/.test(before) ? '' : ' ') + ins.bare : ins.full;
    let at = { from, to };
    // a whole new pattern never gets glued onto existing code: it goes on its own $: line
    if (!inString && !ins.full.startsWith('.') && from === to) {
      if (line.text.trim()) { at = { from: line.to, to: line.to }; text = '\n$: ' + text; }
      else text = '$: ' + text;
    }
    view.dispatch({ changes: { ...at, insert: text }, selection: { anchor: at.from + text.length } });
    view.focus();
    status(`Inserted ${text.trim()}`);
  }
  const onDragStart = (e, ins) => {
    e.dataTransfer.setData('text/plain', ins.full);
    e.dataTransfer.effectAllowed = 'copy';
  };

  // ---------- the virtual list ----------
  const selectable = (i) => rows[i]?.kind === 'item';
  function nearestSelectable(i) {
    if (!rows.length) return -1;
    i = Math.min(Math.max(i, 0), rows.length - 1);
    for (let j = i; j < rows.length; j++) if (selectable(j)) return j;
    for (let j = i; j >= 0; j--) if (selectable(j)) return j;
    return -1;
  }

  function buildRow(r, i) {
    const el = h('div', 'sb-row');
    el.id = `sb-opt-${i}`;
    el.dataset.i = i;
    el.style.top = `${i * ROW_H}px`;
    if (r.kind === 'header') {
      el.classList.add('sb-head');
      el.setAttribute('role', 'presentation');
      el.append(h('span', 'sb-head-name', r.label), h('span', 'sb-head-n', r.n));
      return el;
    }
    el.setAttribute('role', 'option');
    el.setAttribute('data-testid', 'sound-row');
    el.dataset.name = r.name;
    el.dataset.aud = r.play.aud;
    el.draggable = true;
    const isRenaming = renaming?.key === r.key;
    if (isRenaming) el.draggable = false;
    if (r.type === 'sample' && !r.bank) {
      el.dataset.len = '1';
      el.dataset.n = '0';
    }
    const star = h('button', 'sb-star');
    star.type = 'button';
    star.tabIndex = -1;
    star.setAttribute('data-testid', 'sound-fav');
    star.setAttribute('aria-pressed', String(favs.has(r.fid)));
    star.setAttribute('aria-label', `Favourite ${r.label}`);
    star.title = 'Favourite';
    star.innerHTML = ICON.star;
    const main = h('span', 'sb-main');
    if (isRenaming) {
      const input = h('input', 'sb-rename');
      input.type = 'text';
      input.value = r.name;
      input.spellcheck = false;
      input.setAttribute('aria-label', `Rename ${r.name}`);
      input.setAttribute('data-testid', 'sound-rename');
      renaming.input = input;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelRename();
        }
      });
      input.addEventListener('blur', () => renaming?.input === input && commitRename());
      main.append(input);
    } else {
      main.append(h('span', 'sb-name', r.label));
      if (r.code) main.append(h('span', 'sb-code', r.code));
    }
    const tail = [h('i', 'sb-spin')];
    if (el.dataset.len) tail.push(h('span', 'sb-len'));
    if (r.count) tail.push(h('span', 'sb-count', r.count));
    if (tab === 'instruments') tail.push(h('span', 'sb-badge', r.badge)); // other tabs already imply the type
    const add = h('button', 'sb-add');
    add.type = 'button';
    add.tabIndex = -1;
    add.setAttribute('data-testid', 'sound-insert');
    add.setAttribute('aria-label', `Insert ${r.label} into code`);
    add.title = 'Insert into code (Enter)';
    add.innerHTML = ICON.plus;
    el.append(star, main, ...tail, add);
    paintEl(el);
    return el;
  }

  function renderList(full) {
    if (full) {
      renaming = null;
      for (const el of rowEls.values()) el.remove();
      rowEls.clear();
      spacer.style.height = `${rows.length * ROW_H}px`;
    }
    const vh = list.clientHeight || 400;
    const top = list.scrollTop;
    const a = Math.max(0, Math.floor(top / ROW_H) - OVER);
    const b = Math.min(rows.length - 1, Math.ceil((top + vh) / ROW_H) + OVER);
    for (const [i, el] of rowEls) {
      if (i >= a && i <= b) continue;
      if (renaming && renaming.key === rows[i]?.key) renaming = null; // scrolled away: drop the edit
      el.remove();
      rowEls.delete(i);
    }
    for (let i = a; i <= b; i++) {
      if (rowEls.has(i)) continue;
      const el = buildRow(rows[i], i);
      spacer.append(el);
      rowEls.set(i, el);
    }
    paintSel();
  }

  function paintSel() {
    for (const [i, el] of rowEls) {
      const on = i === sel;
      el.classList.toggle('is-sel', on);
      if (el.getAttribute('role') === 'option') el.setAttribute('aria-selected', String(on));
    }
    const cur = rowEls.get(sel);
    if (cur) list.setAttribute('aria-activedescendant', cur.id);
    else list.removeAttribute('aria-activedescendant');
  }

  function reveal(i) {
    const first = rows[i - 1]?.kind === 'header' ? i - 1 : i; // keep a group header in view above its first row
    const top = first * ROW_H;
    const bottom = (i + 1) * ROW_H;
    const vh = list.clientHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + vh) list.scrollTop = bottom - vh;
    renderList(false);
  }

  function select(i, { scroll = true } = {}) {
    if (!selectable(i)) return;
    sel = i;
    tabSel[tab] = rows[i].key;
    if (scroll) reveal(i);
    else paintSel();
  }

  function move(delta) {
    if (sel < 0) return;
    let i = sel;
    for (let k = 0; k < Math.abs(delta); k++) {
      let j = i;
      do j += Math.sign(delta);
      while (j >= 0 && j < rows.length && !selectable(j));
      if (j < 0 || j >= rows.length) break;
      i = j;
    }
    if (i === sel) return;
    select(i);
    playSoon(rows[i].play);
  }

  let scrollQueued = false;
  list.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      renderList(false);
    });
  });
  new ResizeObserver(() => renderList(false)).observe(list);

  // ---------- layout of the three views ----------
  function layout() {
    const mineEmpty = tab === 'mine' && !hasMine(all);
    const showPads = !!drill;
    const noRows = !showPads && !mineEmpty && rows.length === 0;
    const noPads = showPads && drill.shown.length === 0;
    drop.hidden = !(mineEmpty && !showPads);
    list.hidden = showPads || mineEmpty || noRows;
    padwrap.hidden = !showPads || noPads;
    none.hidden = !(noRows || noPads);
    if (!none.hidden) none.textContent = 'Nothing matches that search.';
    crumb.hidden = !showPads;
    addBtn.hidden = !(tab === 'mine' && !mineEmpty);
    $('.sb-toolbar').hidden = mineEmpty && !showPads;
    root.dataset.tab = tab;
    resetStatus();
  }

  function rebuild({ selKey, first } = {}) {
    const prevIdx = sel;
    const prevKey = selKey ?? rows[sel]?.key;
    const r = buildRows(tab, all, favs, query);
    rows = r.rows;
    total = r.total;
    sel = -1;
    if (!first && prevKey) {
      sel = rows.findIndex((x) => x.key === prevKey);
      if (sel < 0 && prevKey.startsWith('fav|')) sel = rows.findIndex((x) => x.key === prevKey.slice(4));
      if (sel < 0 && !prevKey.startsWith('fav|')) sel = rows.findIndex((x) => x.key === 'fav|' + prevKey);
    }
    if (sel < 0) sel = nearestSelectable(first ? 0 : prevIdx);
    renderList(true);
    layout();
  }

  // ---------- pads (second level) ----------
  function renderPads() {
    for (const el of padEls.values()) el.remove();
    padEls.clear();
    padsEl.replaceChildren();
    const q = query.trim().toLowerCase();
    drill.shown = drill.pads.filter((p) => !q || p.label.toLowerCase().includes(q));
    drill.idx = Math.min(Math.max(drill.idx, 0), Math.max(drill.shown.length - 1, 0));
    const colors = PAD_COLORS[tab];
    drill.shown.forEach((p, i) => {
      const b = h('button', 'sb-pad');
      b.type = 'button';
      b.tabIndex = i === drill.idx ? 0 : -1;
      b.draggable = true;
      b.dataset.i = i;
      b.dataset.aud = p.play.aud;
      b.dataset.name = p.play.name;
      b.dataset.n = p.play.n;
      b.dataset.len = '1';
      b.setAttribute('data-testid', 'sound-pad');
      b.setAttribute('aria-label', p.aria);
      b.title = `${p.aria}. Click to play, Enter to insert`;
      b.style.setProperty('--pad', `var(${colors[i % colors.length]})`);
      b.append(h('span', 'sb-pad-label', p.label), h('span', 'sb-pad-sub', p.sub), h('span', 'sb-len'), h('i', 'sb-spin'));
      paintEl(b);
      padsEl.append(b);
      padEls.set(i, b);
    });
    layout();
  }

  function enterDrill(item, { focusPad = true } = {}) {
    if (!item?.drill) return;
    clearTimeout(auditionTimer);
    drill = { item, rowKey: rows[sel]?.key, pads: buildPads(item, all), shown: [], idx: 0, prevQuery: query, scroll: list.scrollTop };
    query = '';
    search.value = '';
    $('.sb-crumb-name').textContent = item.name;
    $('.sb-crumb-count').textContent = `${drill.pads.length} ${item.bank ? 'sounds' : 'variations'}`;
    renderPads();
    if (focusPad) padEls.get(0)?.focus();
  }

  function back() {
    if (!drill) return;
    const d = drill;
    drill = null;
    query = d.prevQuery;
    search.value = query;
    for (const el of padEls.values()) el.remove();
    padEls.clear();
    rebuild({ selKey: d.rowKey });
    list.scrollTop = d.scroll;
    renderList(false);
    if (sel >= 0) reveal(sel);
    list.focus();
  }

  function focusPad(i, audit = true) {
    if (!drill.shown.length) return;
    i = Math.min(Math.max(i, 0), drill.shown.length - 1);
    padEls.get(drill.idx)?.setAttribute('tabindex', '-1');
    drill.idx = i;
    const el = padEls.get(i);
    el.setAttribute('tabindex', '0');
    el.focus();
    if (audit) playSoon(drill.shown[i].play);
  }

  // ---------- tabs ----------
  function setTab(id, { focus = false } = {}) {
    if (!TABS.some((t) => t[0] === id)) return;
    if (drill) {
      drill = null;
      for (const el of padEls.values()) el.remove();
      padEls.clear();
    }
    tab = id;
    try {
      store.set('jelly-sounds-tab', id);
    } catch {}
    tabEls.forEach((b) => {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    list.scrollTop = 0;
    rebuild(tabSel[id] ? { selKey: tabSel[id] } : { first: true });
    if (sel >= 0) reveal(sel);
  }
  tabEls.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- search ----------
  function onSearch() {
    query = search.value;
    if (drill) {
      renderPads();
      return;
    }
    list.scrollTop = 0;
    rebuild({ first: true });
  }
  search.addEventListener('input', onSearch);
  function clearSearch() {
    if (!search.value) return false;
    search.value = '';
    onSearch();
    return true;
  }
  function focusSearch() {
    search.focus();
    search.select();
  }

  // ---------- favourites, insert helpers ----------
  function toggleFav(r) {
    if (favs.has(r.fid)) favs.delete(r.fid);
    else favs.add(r.fid);
    saveFavs();
    rebuild({ selKey: rows[sel]?.key });
  }
  const insertRow = (r) => r?.kind === 'item' && insertCode(r.ins);
  const insertPad = () => drill?.shown[drill.idx] && insertCode(drill.shown[drill.idx].ins);

  // ---------- list mouse handling ----------
  const rowAt = (e) => {
    const el = e.target.closest?.('.sb-row[role="option"]');
    return el ? { el, i: +el.dataset.i, r: rows[+el.dataset.i] } : null;
  };
  list.addEventListener('mousedown', (e) => {
    if (e.target.closest('.sb-star, .sb-add')) e.preventDefault(); // keep focus on the list
  });
  list.addEventListener('click', (e) => {
    const hit = rowAt(e);
    if (!hit || e.target.tagName === 'INPUT') return;
    if (e.target.closest('.sb-star')) return toggleFav(hit.r);
    if (e.target.closest('.sb-add')) {
      select(hit.i, { scroll: false });
      return insertRow(hit.r);
    }
    select(hit.i, { scroll: false });
    playNow(hit.r.play);
  });
  list.addEventListener('dblclick', (e) => {
    const hit = rowAt(e);
    if (!hit || e.target.closest('.sb-star, .sb-add') || e.target.tagName === 'INPUT') return;
    if (hit.r.drill) enterDrill(hit.r);
  });
  list.addEventListener('dragstart', (e) => {
    const hit = rowAt(e);
    if (!hit) return e.preventDefault();
    onDragStart(e, hit.r.ins);
  });
  list.addEventListener('contextmenu', (e) => {
    const hit = rowAt(e);
    if (!hit || hit.r.tab !== 'mine') return;
    e.preventDefault();
    select(hit.i, { scroll: false });
    openRowMenu(hit.r, e.clientX, e.clientY);
  });

  // ---------- pads mouse handling ----------
  padsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.sb-pad');
    if (!b) return;
    const i = +b.dataset.i;
    padEls.get(drill.idx)?.setAttribute('tabindex', '-1');
    drill.idx = i;
    b.setAttribute('tabindex', '0');
    playNow(drill.shown[i].play);
  });
  padsEl.addEventListener('dragstart', (e) => {
    const b = e.target.closest('.sb-pad');
    if (!b) return e.preventDefault();
    onDragStart(e, drill.shown[+b.dataset.i].ins);
  });
  $('.sb-back').addEventListener('click', back);
  $('.sb-all').addEventListener('click', () => drill && insertCode(drill.item.ins));

  // ---------- keyboard ----------
  const gridCols = () => Math.max(1, getComputedStyle(padsEl).gridTemplateColumns.split(' ').length);

  function onListKey(e) {
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_H) - 1);
    const r = rows[sel];
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'PageDown': move(page); break;
      case 'PageUp': move(-page); break;
      case 'Home': { const i = nearestSelectable(0); if (i >= 0) { select(i); playSoon(rows[i].play); } break; }
      case 'End': { const i = nearestSelectable(rows.length - 1); if (i >= 0) { select(i); playSoon(rows[i].play); } break; }
      case 'ArrowRight': if (r?.drill) enterDrill(r); break;
      case 'Enter': insertRow(r); break;
      case ' ': if (r?.kind === 'item') playNow(r.play); break;
      case 'F2': if (r?.tab === 'mine') startRename(sel); break;
      case 'ContextMenu': openMenuAtSel(); break;
      case 'F10': if (!e.shiftKey) return; openMenuAtSel(); break;
      case 'Escape': if (!clearSearch()) return; break;
      default: return;
    }
    e.preventDefault();
  }
  function onPadKey(e) {
    if (!drill) return;
    const cols = gridCols();
    const i = drill.idx;
    switch (e.key) {
      case 'ArrowRight': focusPad(i + 1); break;
      case 'ArrowLeft': if (i % cols === 0) back(); else focusPad(i - 1); break;
      case 'ArrowDown': focusPad(Math.min(i + cols, drill.shown.length - 1)); break;
      case 'ArrowUp': focusPad(i - cols >= 0 ? i - cols : i); break;
      case 'Home': focusPad(0); break;
      case 'End': focusPad(drill.shown.length - 1); break;
      case 'Enter': insertPad(); break;
      case 'Backspace': back(); break;
      case 'Escape': if (!clearSearch()) return; break;
      default: return;
    }
    e.preventDefault();
  }

  function onSearchKey(e) {
    if (e.key === 'Escape') {
      if (!clearSearch()) (drill ? padEls.get(drill.idx) : list).focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      (drill ? padEls.get(drill.idx) : list).focus();
    } else if (e.key === 'Enter') {
      if (drill) insertPad();
      else insertRow(rows[sel]);
    } else return;
    e.preventDefault();
  }

  function onTabKey(e) {
    const i = TABS.findIndex((t) => t[0] === tab);
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (n == null) return;
    e.preventDefault();
    setTab(TABS[(n + TABS.length) % TABS.length][0], { focus: true });
  }

  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.closest('.sb-menu') || t.classList.contains('sb-rename')) return;
    if (t === search) onSearchKey(e);
    else if (t.closest('.sb-tabs')) onTabKey(e);
    else if (t === list) onListKey(e);
    else if (t.closest('.sb-pad')) onPadKey(e);
    else if (drill && e.key === 'Backspace' && t.closest('.sb-crumb')) {
      e.preventDefault();
      back();
    }
  });

  // "/" and Ctrl+F jump to the search while the sidebar is open and the editor isn't focused
  document.addEventListener('keydown', (e) => {
    if (!container.getClientRects().length) return;
    const ae = document.activeElement;
    if (editor.editor?.hasFocus || ae?.closest?.('.cm-editor')) return;
    const typing = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
    const ctrlF = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f';
    const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
    if (!ctrlF && !slash) return;
    e.preventDefault();
    focusSearch();
  });

  // ---------- context menu (also used by the Add button) ----------
  let menuReturn = null;
  function closeMenu(restore = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (restore) (menuReturn?.isConnected ? menuReturn : list).focus();
    menuReturn = null;
  }
  function openMenu(x, y, items, ret) {
    closeMenu(false);
    menuReturn = ret;
    for (const it of items) {
      if (it.title) {
        menu.append(h('div', 'sb-menu-title', it.title));
        continue;
      }
      const b = h('button', `sb-menuitem${it.danger ? ' is-danger' : ''}`, it.label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-testid', 'sound-menu-item');
      b.dataset.action = it.action || it.label;
      b.addEventListener('click', () => {
        closeMenu(true);
        it.run?.();
      });
      menu.append(b);
    }
    menu.hidden = false;
    const r = root.getBoundingClientRect();
    const left = Math.max(6, Math.min(x - r.left, r.width - menu.offsetWidth - 6));
    let top = y - r.top;
    if (top + menu.offsetHeight > r.height - 6) top = Math.max(6, top - menu.offsetHeight);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('.sb-menuitem')?.focus();
  }
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('.sb-menuitem')];
    const i = btns.indexOf(document.activeElement);
    const go = (n) => {
      e.preventDefault();
      btns[(n + btns.length) % btns.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(btns.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu(true);
    }
    e.stopPropagation();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu(false);
  });
  list.addEventListener('scroll', () => closeMenu(false));

  function openRowMenu(r, x, y) {
    openMenu(x, y, [
      { label: 'Rename', action: 'rename', run: () => startRename(sel) },
      {
        label: 'Delete',
        action: 'delete',
        danger: true,
        run: () =>
          openMenu(x, y, [
            { title: `Delete “${r.name}”?` },
            { label: 'Delete', action: 'confirm-delete', danger: true, run: () => deleteSound(r.name) },
            { label: 'Cancel', action: 'cancel' },
          ], list),
      },
      { label: 'Show in Explorer', action: 'reveal', run: () => jelly.soundReveal(r.name) },
    ], list);
  }
  function openMenuAtSel() {
    const r = rows[sel];
    const el = rowEls.get(sel);
    if (r?.tab !== 'mine' || !el) return;
    const b = el.getBoundingClientRect();
    openRowMenu(r, b.left + 24, b.bottom);
  }

  addBtn.addEventListener('click', () => {
    if (!menu.hidden) return closeMenu(true);
    const b = addBtn.getBoundingClientRect();
    openMenu(b.left, b.bottom + 6, [
      { label: 'Add files', action: 'add-files', run: pickFiles },
      { label: 'Add folder', action: 'add-folder', run: pickFolder },
      { label: 'Open samples folder', action: 'open-folder', run: () => jelly.openLibrary() },
    ], addBtn);
  });
  // the pointerdown handler above closes the menu before this click, so swallow that case
  addBtn.addEventListener('pointerdown', (e) => {
    if (!menu.hidden) {
      e.stopPropagation();
    }
  });

  // ---------- rename / delete ----------
  function startRename(i) {
    const r = rows[i];
    if (r?.tab !== 'mine') return;
    if (renaming) cancelRename();
    select(i);
    renaming = { key: r.key, name: r.name, input: null };
    rowEls.get(i)?.remove();
    rowEls.delete(i);
    renderList(false);
    renaming.input?.focus();
    renaming.input?.select();
  }
  function endRename() {
    const r = renaming;
    renaming = null;
    renderList(true);
    if (sel >= 0) reveal(sel);
    list.focus();
    return r;
  }
  function cancelRename() {
    if (renaming) endRename();
  }
  async function commitRename() {
    if (!renaming) return;
    const val = renaming.input.value.trim();
    const { name } = renaming;
    const key = renaming.key;
    endRename();
    if (!val || val === name) return;
    try {
      const to = await jelly.soundRename(name, val);
      if (favs.delete(`mine:${name}`)) {
        favs.add(`mine:${to}`);
        saveFavs();
      }
      await reload(key.startsWith('fav|') ? `fav|mine:${to}` : `mine:${to}`);
      status(`Renamed to ${to}`);
    } catch (err) {
      console.warn(err);
      status('Could not rename that sound.');
    }
  }
  async function deleteSound(name) {
    try {
      await jelly.soundDelete(name);
      if (favs.delete(`mine:${name}`)) saveFavs();
      await reload();
      status(`Moved ${name} to the Recycle Bin`);
    } catch (err) {
      console.warn(err);
      status('Could not delete that sound.');
    }
  }

  // ---------- library ----------
  let chain = Promise.resolve();
  const reload = (selKey) =>
    (chain = chain.then(async () => {
      await loadLibrary().catch((e) => console.warn(e));
      all = listSounds();
      rebuild({ selKey });
      if (drill) {
        const item = rows.find((r) => r.kind === 'item' && !r.fav && r.name === drill.item.name);
        if (!item) back();
        else {
          drill.item = item;
          drill.pads = buildPads(item, all);
          renderPads();
        }
      }
    }));
  jelly.onLibraryChanged(() => reload());

  async function addPaths(paths) {
    if (!paths?.length) return;
    try {
      const n = await jelly.add(paths, 'my_sounds');
      await reload();
      status(n ? `Added ${n} sound file${n === 1 ? '' : 's'}.` : 'No audio files found in that.', 4500);
    } catch (e) {
      console.warn(e);
      status('Could not add those files.');
    }
  }
  const pickFiles = async () => addPaths(await jelly.pick(false));
  const pickFolder = async () => addPaths(await jelly.pick(true));
  $('[data-testid="sound-add-files"]').addEventListener('click', pickFiles);
  $('[data-testid="sound-add-folder"]').addEventListener('click', pickFolder);

  // ---------- dropping files onto the window ----------
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  const hideOverlay = () => overlay.classList.remove('is-on');
  addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    if (!overlay.classList.contains('is-on')) {
      showSounds();
      if (tab !== 'mine') setTab('mine');
      overlay.classList.add('is-on');
    }
  });
  addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) hideOverlay();
  });
  addEventListener('dragend', hideOverlay);
  // capture phase, so CodeMirror never reads a dropped file as text
  addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, true);
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hideOverlay();
    addPaths([...e.dataTransfer.files].map((f) => jelly.pathForFile(f)).filter(Boolean));
  }, true);

  // ---------- go ----------
  all = listSounds();
  setTab(tab);
  return {
    refresh() {
      all = listSounds();
      rebuild({ selKey: rows[sel]?.key });
    },
  };
}
