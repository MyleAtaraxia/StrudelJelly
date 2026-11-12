import docs from 'virtual:strudel-docs';
import { syntaxTree } from '@codemirror/language';
import { playExample, stopExample, playingExample, onExampleChange } from '../strudel.js';
import './docs.css';

// In-app reference for every Strudel function, built from Strudel's own jsdoc (build/strudel-docs.mjs), in four places:
//   Docs pane      the sidebar: search, grouped list, one function per page with examples
//   hover card     hover a function in the code, or press F1 on it
//   signature tip  while typing a call: the parameters and a one-liner, More opens the pane
//   palette        Ctrl+K: functions, sounds, sketches and app commands in one search
// Contract with main.js: initDocs({ editor, container, showDocs, commands, sounds, sketches }) -> { open(name), palette }
//   commands() -> [{ label, hint, run }]; sounds = { names(), insert(name) }; sketches = { list(), open(name) }

const ENTRIES = docs.entries;
const byName = new Map(ENTRIES.map((e) => [e.name, e]));
for (const e of ENTRIES) for (const s of e.synonyms) if (!byName.has(s)) byName.set(s, e);
export const lookup = (name) => byName.get(name);

const scratch = document.createElement('div');
const textOf = new Map();
function plainText(e) {
  if (!textOf.has(e)) {
    scratch.innerHTML = e.desc;
    textOf.set(e, scratch.textContent.replace(/\s+/g, ' ').trim());
  }
  return textOf.get(e);
}
function summary(e) {
  const t = plainText(e);
  const m = t.match(/^.*?[.!?](\s|$)/);
  const s = (m ? m[0] : t).trim();
  return s.length > 140 ? s.slice(0, 137) + '…' : s || 'No description yet.';
}
const paramNames = (e) => e.params.map((p) => p.name).filter((n) => n && !n.includes('.'));

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const I = (d) => `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${d}"></path></svg>`;
const ICON = {
  search: I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'),
  back: I('M15 5l-7 7 7 7'),
  play: I('M7 5l12 7-12 7z'),
  stop: I('M7 7h10v10H7z'),
  plus: I('M12 5v14M5 12h14'),
  more: I('M9 5l7 7-7 7'),
};
const button = (cls, html, title) => {
  const b = h('button', cls);
  b.type = 'button';
  b.innerHTML = html;
  if (title) b.title = title;
  return b;
};

// match a query against a name: 0 exact, 1 prefix, 2 contains, -1 no match
function nameScore(name, q) {
  const n = name.toLowerCase();
  return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1;
}
function searchEntries(q) {
  const out = [];
  for (const e of ENTRIES) {
    let s = nameScore(e.name, q);
    if (s < 0) { const syn = Math.min(...e.synonyms.map((x) => nameScore(x, q)).filter((x) => x >= 0)); if (syn < 9) s = syn + 0.5; }
    if (s < 0 && q.length > 2 && plainText(e).toLowerCase().includes(q)) s = 3;
    if (s >= 0) out.push([s, e]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([s, e]) => ({ score: s, e }));
}

// The cursor is inside this call: { name, arg (0-based argument index) }, or null. Uses the parse tree, so strings and
// comments never count.
function callAt(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name !== 'ArgList' || n.parent?.name !== 'CallExpression') continue;
    const closed = n.lastChild?.name === ')' && n.lastChild.to === n.to;
    if (pos <= n.from || (closed ? pos >= n.to : pos > n.to)) continue;
    const callee = n.parent.firstChild;
    const id = callee?.name === 'MemberExpression' ? callee.lastChild : callee;
    if (!id || !/^(VariableName|PropertyName)$/.test(id.name)) return null;
    let arg = 0;
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === ',' && c.to <= pos) arg++;
    return { name: state.sliceDoc(id.from, id.to), arg };
  }
  return null;
}
// the function name at pos: { name, from, to }, or null
function wordAt(state, pos) {
  for (const side of [1, -1]) {
    const n = syntaxTree(state).resolveInner(pos, side);
    if (/^(VariableName|PropertyName)$/.test(n.name)) return { name: state.sliceDoc(n.from, n.to), from: n.from, to: n.to };
  }
  return null;
}

export function initDocs({ editor, container, showDocs, commands, sounds, sketches }) {
  const view = () => editor.editor;

  // ---------- inserting ----------
  // a function call goes in at the cursor: `.fast()` after a value, `fast()` elsewhere, with the cursor between the parens
  function insertCall(e) {
    const v = view();
    const { from, to } = v.state.selection.main;
    const method = /[\w)\]"'`]/.test(v.state.sliceDoc(Math.max(0, from - 1), from));
    const text = `${method ? '.' : ''}${e.name}()`;
    v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length - 1 }, scrollIntoView: true, userEvent: 'input' });
    v.focus();
  }
  // an example goes on its own line after the cursor's line, as a new `$:` pattern when it is a single expression
  function insertExample(code) {
    const v = view();
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    let text = !code.includes('\n') && !/^\s*(\$|\w+\s*:|setc|samples|await|let |const )/.test(code) ? `$: ${code}` : code;
    const empty = !line.text.trim();
    if (!empty) text = '\n' + text;
    const from = empty ? line.from : line.to;
    v.dispatch({ changes: { from, to: line.to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: 'input' });
    v.focus();
  }

  // ---------- example play buttons (all of them follow the one example that plays) ----------
  const exErrors = new Map(); // example code -> error message
  function syncPlay() {
    const now = playingExample();
    for (const b of document.querySelectorAll('.dc-play')) {
      const on = b._code === now;
      b.classList.toggle('is-playing', on);
      b.innerHTML = (on ? ICON.stop : ICON.play) + (on ? 'Stop' : 'Play');
      b.title = on ? 'Stop the example' : 'Hear this example (your sketch stays as it is)';
      const err = b.closest('.dc-ex')?.querySelector('.dc-ex-err');
      if (err) { err.textContent = exErrors.get(b._code) || ''; err.hidden = !exErrors.has(b._code); }
    }
  }
  onExampleChange((code, err) => {
    if (err) exErrors.set(code ?? lastTried, String(err.message || err));
    syncPlay();
  });
  let lastTried = null;
  async function toggleExample(code) {
    if (playingExample() === code) return stopExample();
    lastTried = code;
    exErrors.delete(code);
    await playExample(editor, code).catch((err) => { exErrors.set(code, String(err.message || err)); syncPlay(); });
  }

  // ---------- one function, as a page (pane, palette) or a card (hover) ----------
  function renderEntry(e, { compact = false } = {}) {
    const root = h('div', 'dc-entry' + (compact ? ' is-compact' : ''));
    const head = h('div', 'dc-ehead');
    const sig = h('code', 'dc-sig');
    sig.append(h('b', null, e.name), `(${paramNames(e).join(', ')})`);
    head.append(sig, h('span', 'dc-chip', e.group));
    root.append(head);
    if (e.synonyms.length) root.append(h('div', 'dc-also', `Also called ${e.synonyms.join(', ')}`));
    const desc = h('div', 'dc-desc');
    desc.innerHTML = e.desc || '<p>No description yet.</p>';
    root.append(desc);
    if (e.params.length) {
      const list = h('dl', 'dc-params');
      for (const p of compact ? e.params.slice(0, 4) : e.params) {
        const dt = h('dt');
        dt.append(h('code', null, p.name), p.type ? h('span', 'dc-type', p.type) : '');
        const dd = h('dd');
        dd.innerHTML = p.desc;
        list.append(dt, dd);
      }
      root.append(list);
    }
    for (const code of compact ? e.examples.slice(0, 1) : e.examples) {
      const ex = h('div', 'dc-ex');
      ex.append(h('pre', 'dc-code', code));
      const btns = h('div', 'dc-ex-btns');
      const play = button('head-btn btn-sky dc-play', '');
      play._code = code;
      play.addEventListener('click', () => toggleExample(code));
      const ins = button('head-btn btn-mint', ICON.plus + 'Insert', 'Add this example to your code, below the cursor line');
      ins.addEventListener('click', () => { insertExample(code); hideCard(); });
      btns.append(play, ins);
      const err = h('div', 'dc-ex-err');
      err.hidden = true;
      ex.append(btns, err);
      root.append(ex);
    }
    if (!compact) {
      const ins = button('head-btn btn-mint dc-insert-call', ICON.plus + `Insert ${e.name}()`, 'Add a call at the cursor');
      ins.addEventListener('click', () => insertCall(e));
      head.append(ins);
    } else {
      const more = button('dc-more', `${e.examples.length > 1 ? `All ${e.examples.length} examples` : 'Open in Docs'}${ICON.more}`);
      more.addEventListener('click', () => { hideCard(); open(e.name); });
      root.append(more);
    }
    queueMicrotask(syncPlay);
    return root;
  }

  // ---------- A: the Docs pane ----------
  container.innerHTML = `
    <div class="panel-head"><span class="panel-title">Docs</span><span class="head-spacer"></span><span class="dc-count">${ENTRIES.length} functions</span></div>
    <div class="pane-body dc" data-testid="docs">
      <div class="dc-browse">
        <div class="dc-toolbar"><label class="dc-search">${ICON.search}<input type="text" data-testid="docs-search" aria-label="Search functions" placeholder="Search functions" title="Ctrl+K searches everything" spellcheck="false" autocomplete="off"></label></div>
        <div class="dc-list" role="listbox" aria-label="Functions" data-testid="docs-list"></div>
      </div>
      <div class="dc-view" hidden>
        <div class="dc-crumb"><button type="button" class="head-btn sq dc-back" data-testid="docs-back" aria-label="Back" title="Back (Esc)">${ICON.back}</button><span class="dc-crumb-name"></span></div>
        <div class="dc-page" tabindex="-1" data-testid="docs-page"></div>
      </div>
    </div>`;
  const q = (s) => container.querySelector(s);
  const browse = q('.dc-browse'), listEl = q('.dc-list'), input = q('.dc-search input'), pageView = q('.dc-view'), page = q('.dc-page');
  let rows = [];
  let sel = -1;
  function renderList() {
    const query = input.value.trim().toLowerCase();
    listEl.replaceChildren();
    rows = [];
    const addRow = (e) => {
      const r = button('dc-row', '');
      r.setAttribute('role', 'option');
      r.tabIndex = -1;
      r.append(h('code', 'dc-name', e.name), h('span', 'dc-sum', summary(e)));
      r.addEventListener('click', () => open(e.name));
      r._entry = e;
      rows.push(r);
      listEl.append(r);
    };
    if (query) {
      const found = searchEntries(query);
      if (!found.length) listEl.append(h('div', 'dc-none', `Nothing called “${input.value.trim()}”`));
      found.forEach(({ e }) => addRow(e));
    } else {
      for (const g of docs.groups) {
        const items = ENTRIES.filter((e) => e.group === g);
        if (!items.length) continue;
        const head = h('div', 'dc-head');
        head.append(h('span', null, g), h('span', 'dc-head-n', items.length));
        listEl.append(head);
        items.forEach(addRow);
      }
    }
    setSel(query && rows.length ? 0 : -1);
  }
  function setSel(i) {
    rows[sel]?.classList.remove('is-sel');
    sel = i;
    rows[sel]?.classList.add('is-sel');
    rows[sel]?.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('input', renderList);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n) setSel(sel < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' && rows[sel]) open(rows[sel]._entry.name);
    else if (e.key === 'Escape' && input.value) { input.value = ''; renderList(); }
  });
  function back() {
    pageView.hidden = true;
    browse.hidden = false;
    input.focus({ preventScroll: true });
  }
  q('.dc-back').addEventListener('click', back);
  pageView.addEventListener('keydown', (e) => { if (e.key === 'Escape') back(); });
  function open(name) {
    const e = lookup(name);
    if (!e) return;
    showDocs();
    q('.dc-crumb-name').textContent = e.group;
    page.replaceChildren(renderEntry(e));
    page.scrollTop = 0;
    browse.hidden = true;
    pageView.hidden = false;
    page.focus({ preventScroll: true }); // so Esc goes back
  }
  renderList();

  // ---------- C: hover card (and F1) ----------
  const card = h('div', 'dc-card');
  card.hidden = true;
  card.dataset.testid = 'docs-card';
  document.body.append(card);
  let cardFor = null; // { name, from } the card is about
  let hoverTimer = 0;
  let hideTimer = 0;
  function placeNear(el, rect, { above = false } = {}) {
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth, ht = el.offsetHeight, pad = 8;
    const x = Math.min(Math.max(pad, rect.left), innerWidth - w - pad);
    let y = above ? rect.top - ht - 6 : rect.bottom + 6;
    if (!above && y + ht > innerHeight - pad) y = rect.top - ht - 6;
    if (above && y < pad) y = rect.bottom + 6;
    el.style.left = `${x}px`;
    el.style.top = `${Math.max(pad, y)}px`;
  }
  function showCard(word) {
    const e = lookup(word.name);
    if (!e) return false;
    clearTimeout(hideTimer);
    if (cardFor?.name === word.name && cardFor.from === word.from && !card.hidden) return true;
    const a = view().coordsAtPos(word.from), b = view().coordsAtPos(word.to);
    if (!a || !b) return false;
    cardFor = word;
    card.replaceChildren(renderEntry(e, { compact: true }));
    card.hidden = false;
    hideSig();
    placeNear(card, { left: a.left, top: a.top, bottom: b.bottom });
    return true;
  }
  function hideCard() {
    clearTimeout(hideTimer);
    card.hidden = true;
    cardFor = null;
  }
  const hideCardSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hideCard, 300); };
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', hideCardSoon);
  const cm = () => view().contentDOM;
  // the editor's view object survives sketch switches (only its state changes), so these listeners stay valid
  view().dom.addEventListener('mousemove', (ev) => {
    clearTimeout(hoverTimer);
    const { clientX: x, clientY: y } = ev;
    hoverTimer = setTimeout(() => {
      const v = view();
      const pos = v.posAtCoords({ x, y });
      const word = pos == null ? null : wordAt(v.state, pos);
      // posAtCoords snaps to the nearest character, so check the mouse is really over the word
      const a = word && v.coordsAtPos(word.from), b = word && v.coordsAtPos(word.to);
      const over = a && b && x >= a.left - 1 && x <= b.right + 1 && y >= a.top && y <= b.bottom;
      if (!over || !showCard(word)) { if (!card.hidden) hideCardSoon(); }
    }, 380);
  });
  view().dom.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); if (!card.hidden) hideCardSoon(); });
  view().scrollDOM.addEventListener('scroll', () => { hideCard(); placeSig(); });
  document.addEventListener('mousedown', (e) => { if (!card.hidden && !card.contains(e.target)) hideCard(); }, true);

  // ---------- B: signature tip while typing a call ----------
  const sig = h('div', 'dc-sigtip');
  sig.hidden = true;
  sig.dataset.testid = 'docs-sigtip';
  document.body.append(sig);
  sig.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor focused
  let sigOn = false; // switched on by typing ( or , and off when the cursor leaves the call
  let sigKey = '';
  function hideSig() {
    sigOn = false;
    sig.hidden = true;
    sigKey = '';
  }
  function placeSig() {
    if (sig.hidden) return;
    const c = view().coordsAtPos(view().state.selection.main.head);
    if (!c) return hideSig();
    placeNear(sig, c, { above: true });
  }
  function updateSig() {
    if (!sigOn) return;
    const v = view();
    const st = v.state;
    const call = st.selection.main.empty ? callAt(st, st.selection.main.head) : null;
    const e = call && lookup(call.name);
    if (!e) return hideSig();
    const key = `${e.name}:${call.arg}`;
    if (key !== sigKey) {
      sigKey = key;
      const names = paramNames(e);
      const line = h('code', 'dc-sigtip-sig');
      line.append(h('b', null, e.name), '(');
      names.forEach((n, i) => line.append(i ? ', ' : '', i === Math.min(call.arg, names.length - 1) ? h('em', null, n) : n));
      line.append(')');
      const more = button('dc-more', `More${ICON.more}`, 'Open in Docs (F1)');
      more.addEventListener('click', () => { hideSig(); open(e.name); });
      const top = h('div', 'dc-sigtip-top');
      top.append(line, more);
      const p = e.params[Math.min(call.arg, e.params.length - 1)];
      sig.replaceChildren(top, h('div', 'dc-sigtip-sum', summary(e)));
      if (p?.desc) {
        const pd = h('div', 'dc-sigtip-param');
        pd.innerHTML = `<code>${p.name}</code> ` + p.desc.replace(/<\/?p>/g, '');
        sig.append(pd);
      }
    }
    sig.hidden = false;
    placeSig();
  }
  editor.editor.dom.addEventListener('focusout', () => hideSig());

  // the editor tells us about edits and cursor moves through these (see main.js)
  function onEditorUpdate(u) {
    if (u.docChanged) {
      hideCard();
      let typed = '';
      for (const tr of u.transactions) if (tr.isUserEvent('input.type')) tr.changes.iterChanges((a, b, c, d, ins) => (typed += ins.toString()));
      if (/[(,]/.test(typed)) sigOn = true;
    }
    if (sigOn) updateSig();
  }
  // F1: card for the word at the cursor (or the Docs pane); Ctrl+Shift+Space: the signature tip; Esc closes them
  view().dom.addEventListener('keydown', (ev) => {
    if (ev.key === 'F1') {
      ev.preventDefault();
      const st = view().state;
      const head = st.selection.main.head;
      const word = wordAt(st, head) || (callAt(st, head) && { name: callAt(st, head).name });
      if (word?.from != null && showCard(word)) return;
      if (word && lookup(word.name)) open(word.name);
      else { showDocs(); input.focus(); }
    } else if (ev.key === ' ' && ev.ctrlKey && ev.shiftKey) {
      ev.preventDefault();
      sigOn = true;
      sigKey = '';
      updateSig();
    } else if (ev.key === 'Escape' && (!card.hidden || !sig.hidden)) {
      // closes the popups and still reaches the editor (Vim mode needs Esc to leave insert mode)
      hideCard();
      hideSig();
    }
  }, true);
  addEventListener('resize', () => { hideCard(); placeSig(); });

  // ---------- E: Ctrl+K palette ----------
  const pal = h('div', 'pal-backdrop');
  pal.hidden = true;
  pal.innerHTML = `
    <div class="pal" role="dialog" aria-label="Search everything" data-testid="palette">
      <label class="dc-search pal-search">${ICON.search}<input type="text" data-testid="palette-input" aria-label="Search functions, sounds, sketches and commands" placeholder="Search functions, sounds, sketches, commands" spellcheck="false" autocomplete="off"></label>
      <div class="pal-body">
        <div class="pal-list" role="listbox" data-testid="palette-list"></div>
        <div class="pal-preview" data-testid="palette-preview"></div>
      </div>
      <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> insert or run</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> play example</span><span><kbd>Esc</kbd> close</span></div>
    </div>`;
  document.body.append(pal);
  const palInput = pal.querySelector('input'), palList = pal.querySelector('.pal-list'), palPrev = pal.querySelector('.pal-preview');
  const KIND = { cmd: ['Command', 'butter'], fn: ['Function', 'lilac'], sound: ['Sound', 'mint'], sketch: ['Sketch', 'sky'] };
  let pool = [];
  let items = [];
  let pSel = 0;
  let restoreFocus = null;
  async function openPalette() {
    hideCard();
    hideSig();
    restoreFocus = document.activeElement;
    const sk = await sketches.list().catch(() => []);
    pool = [
      ...commands().map((c) => ({ kind: 'cmd', label: c.label, hint: c.hint || '', run: c.run })),
      ...sk.map((s) => ({ kind: 'sketch', label: s.name, hint: '', run: () => sketches.open(s.name) })),
      ...ENTRIES.map((e) => ({ kind: 'fn', label: e.name, hint: summary(e), e, run: () => insertCall(e) })),
      ...sounds.names().map((n) => ({ kind: 'sound', label: n, hint: `s("${n}")`, run: () => sounds.insert(n) })),
    ];
    palInput.value = '';
    pal.hidden = false;
    palInput.focus();
    renderPalette();
  }
  function closePalette({ refocus = true } = {}) {
    if (pal.hidden) return;
    pal.hidden = true;
    if (refocus && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }
  function renderPalette() {
    const query = palInput.value.trim().toLowerCase();
    if (!query) items = pool.filter((i) => i.kind === 'cmd' || i.kind === 'sketch').slice(0, 40);
    else {
      const LIMIT = { cmd: 20, sketch: 10, fn: 40, sound: 20 };
      const ORDER = { cmd: 0, fn: 1, sound: 2, sketch: 3 };
      const seen = { cmd: 0, sketch: 0, fn: 0, sound: 0 };
      const fnScore = new Map(searchEntries(query).map((r) => [r.e, r.score]));
      items = pool
        .map((i) => [i.e ? fnScore.get(i.e) ?? -1 : nameScore(i.label, query), i])
        .filter(([s]) => s >= 0)
        .sort((a, b) => a[0] - b[0] || ORDER[a[1].kind] - ORDER[b[1].kind] || a[1].label.localeCompare(b[1].label))
        .filter(([, i]) => seen[i.kind]++ < LIMIT[i.kind])
        .map(([, i]) => i);
    }
    palList.replaceChildren(
      ...items.map((it, idx) => {
        const r = h('div', 'pal-row');
        r.setAttribute('role', 'option');
        const [kname, color] = KIND[it.kind];
        r.append(h('span', `pal-kind k-${color}`, kname), h(it.kind === 'fn' || it.kind === 'sound' ? 'code' : 'span', 'pal-label', it.label), h('span', 'pal-hint', it.hint));
        r.addEventListener('mousemove', () => idx !== pSel && setPSel(idx, false));
        r.addEventListener('click', () => runItem(it));
        return r;
      }),
    );
    if (!items.length) palList.append(h('div', 'dc-none', 'No matches'));
    setPSel(0);
  }
  function setPSel(i, scroll = true) {
    palList.children[pSel]?.classList.remove('is-sel');
    pSel = i;
    const row = palList.children[pSel];
    row?.classList.add('is-sel');
    if (scroll) row?.scrollIntoView({ block: 'nearest' });
    const it = items[pSel];
    palPrev.replaceChildren();
    if (!it) return;
    if (it.e) palPrev.append(renderEntry(it.e));
    else {
      const box = h('div', 'pal-about');
      box.append(h('b', null, it.label), h('p', null, {
        cmd: it.hint ? `Shortcut: ${it.hint}` : 'Press Enter to run.',
        sketch: 'Press Enter to open this sketch.',
        sound: `Press Enter to add s("${it.label}") to your code.`,
      }[it.kind]));
      palPrev.append(box);
    }
  }
  function runItem(it) {
    closePalette({ refocus: it.kind !== 'fn' && it.kind !== 'sound' });
    it.run();
  }
  palInput.addEventListener('input', renderPalette);
  palInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setPSel((pSel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation(); // Ctrl+Enter here plays the example, not the sketch
      const it = items[pSel];
      if (!it) return;
      if (e.ctrlKey || e.metaKey) { if (it.e?.examples[0]) toggleExample(it.e.examples[0]); }
      else runItem(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) closePalette(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      if (pal.hidden) openPalette();
      else closePalette();
    }
  }, true);

  return { open, onEditorUpdate, openPalette, focusSearch: () => input.focus() };
}
