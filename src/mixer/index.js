// The Mixer pane: one card per rack entry, in code order. Every edit goes through src/vst/rack-source.js, so the code
// stays the source of truth (and every change is one undo step in the editor).
// initMixer({ editor, container, showSettings }) -> { refresh }
import {
  findRack, addPlugin, removePlugin, movePlugin, setBypass, isBypassed, addEntry, addEntries, removeEntry, restoreEntry, uniqueName,
} from '../vst/rack-source.js';
import {
  api, lastRack, onRack, getPlugins, getScan, getStatus, onCatalogue, onStatus, findPlugin, h, chip, I, ICON,
} from '../vst/ui/state.js';
import './mixer.css';

const AGAIN = 10 * 60 * 1000; // restorable for 10 minutes
const ICONS = {
  down: I('M6 9l6 6 6-6'),
  window: ICON.window,
};

// 0..1 linear peak -> bar width (a -60..0 dB scale)
const meterPct = (v) => (v <= 0.001 ? 0 : Math.max(0, Math.min(1, 1 + Math.log10(v) / 3)) * 100);

export function initMixer({ editor, container, showSettings }) {
  const view = () => editor.editor;
  if (!api) {
    container.innerHTML = '<div class="panel-head"><span class="panel-title">Mixer</span></div><div class="pane-body mx"><div class="mx-scroll"><div class="mx-empty"><b class="mx-empty-title">No audio engine here</b><p>Plugins need the Strudel Jelly desktop app.</p></div></div></div>';
    return { refresh() {}, onDocChange() {}, cards: () => [] };
  }
  container.innerHTML = `
    <div class="panel-head"><span class="panel-title">Mixer</span><span class="head-spacer"></span>
      <button type="button" class="head-btn btn-mint" data-testid="mixer-add" title="Add a rack entry">${ICON.plus}Add</button></div>
    <div class="pane-body mx" data-testid="mixer">
      <div class="mx-scroll">
        <div class="mx-notice" data-testid="mixer-notice" hidden></div>
        <div class="mx-list" data-testid="mixer-list"></div>
        <div class="mx-empty" data-testid="mixer-empty" hidden></div>
        <div class="mx-deleted" data-testid="mixer-deleted" hidden></div>
      </div>
    </div>`;
  const q = (s) => container.querySelector(s);
  const list = q('.mx-list'), empty = q('.mx-empty'), deletedEl = q('.mx-deleted'), notice = q('.mx-notice'), addBtn = q('[data-testid=mixer-add]');

  const removed = new Map(); // name -> { src, at } what this pane deleted, to restore it with its parameters
  let deleted = []; // from the engine
  let meters = new Map(); // entry -> [fillL, fillR]
  const levels = new Map(); // entry -> [l, r] smoothed

  // ---------- model: code (order, plugins, bypass) + engine status (kind, routes, feeders, plugin status) ----------
  function model() {
    const rack = findRack(view().state);
    const st = lastRack();
    if (!rack) return { rack: null, cards: [] };
    const cards = rack.entries.map((e) => {
      const s = st?.entries.find((x) => x.name === e.name);
      const kind = (e.plugins[0] && findPlugin(e.plugins[0].name)?.kind) || s?.kind || 'effect';
      return {
        name: e.name,
        line: view().state.doc.lineAt(e.from).number,
        kind,
        next: e.next ?? null,
        routes: s?.routes?.length || 0,
        feeders: s?.feeders || [],
        chain: e.plugins.map((p, slot) => {
          const c = s?.chain?.[slot];
          const known = findPlugin(p.name);
          const status = !known ? 'missing' : c && c.plugin.toLowerCase() === p.name.toLowerCase() ? c.status : 'loaded';
          return { name: known?.name || p.name, slot, bypass: isBypassed(p), status, kind: known?.kind || 'effect' };
        }),
      };
    });
    return { rack, cards };
  }

  // ---------- picker (shared by "+" on a card and "+ Add") ----------
  let picker = null;
  function closePicker() {
    picker?.remove();
    picker = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onPickKey, true);
  }
  const onDocDown = (e) => {
    if (picker && !picker.contains(e.target) && !e.target.closest?.('[data-picker-anchor]')) closePicker();
  };
  let pickState = null;
  const onPickKey = (e) => {
    if (!picker) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pickState.move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && e.target.closest?.('.mx-picker')) {
      e.preventDefault();
      pickState.choose();
    }
  };
  function openPicker(anchor, { title, kind, onPick }) {
    closePicker();
    const el = h('div', 'mx-picker');
    el.dataset.testid = 'mixer-picker';
    const input = h('input', 'mx-picker-q');
    input.type = 'text';
    input.placeholder = title;
    input.spellcheck = false;
    input.setAttribute('aria-label', title);
    const items = h('div', 'mx-picker-list');
    el.append(input, items);
    document.body.append(el);
    picker = el;
    let rows = [];
    let sel = 0;
    const draw = () => {
      const qy = input.value.trim().toLowerCase();
      items.replaceChildren();
      const all = getPlugins().filter((p) => (!kind || p.kind === kind) && (!qy || `${p.name} ${p.vendor}`.toLowerCase().includes(qy)));
      rows = all.slice(0, 200).map((p) => {
        const r = h('button', 'mx-picker-row');
        r.type = 'button';
        r.append(chip(p.kind), h('span', 'mx-picker-name', p.name), h('span', 'mx-picker-vendor', p.vendor));
        r.addEventListener('click', () => { closePicker(); onPick(p); });
        items.append(r);
        return { r, p };
      });
      if (!rows.length) {
        items.append(h('div', 'mx-picker-none', getPlugins().length ? 'No match' : 'No plugins found. Check the plugin folders in Settings, then Rescan.'));
      }
      sel = 0;
      mark();
    };
    const mark = () => rows.forEach((x, i) => x.r.classList.toggle('is-sel', i === sel));
    pickState = {
      move(d) { if (rows.length) { sel = (sel + d + rows.length) % rows.length; mark(); rows[sel].r.scrollIntoView({ block: 'nearest' }); } },
      choose() { const x = rows[sel]; if (x) { closePicker(); onPick(x.p); } },
    };
    input.addEventListener('input', draw);
    draw();
    const r = anchor.getBoundingClientRect();
    const w = 260;
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
    const below = r.bottom + 6;
    el.style.top = `${below + 320 > innerHeight ? Math.max(8, r.top - 6 - el.offsetHeight) : below}px`;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onPickKey, true);
    input.focus();
  }

  // ---------- context menu on a plugin sticker ----------
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener('mousedown', menuAway, true);
    document.removeEventListener('keydown', menuKey, true);
  }
  const menuAway = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
  const menuKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
  function openMenu(x, y, items) {
    closeMenu();
    menu = h('div', 'sk-menu mx-menu');
    menu.dataset.testid = 'mixer-menu';
    for (const [label, fn, cls] of items) {
      const b = h('button', cls || '', label);
      b.type = 'button';
      b.addEventListener('click', () => { closeMenu(); fn(); });
      menu.append(b);
    }
    document.body.append(menu);
    menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
    document.addEventListener('mousedown', menuAway, true);
    document.addEventListener('keydown', menuKey, true);
    menu.querySelector('button')?.focus();
  }

  // ---------- actions (all of them rewrite code) ----------
  const jumpToLine = (line) => {
    const v = view();
    const pos = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines)).from;
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
  };
  const guard = (fn) => {
    try { return fn(); } catch (e) { flash(String(e.message || e)); }
  };
  function flash(text) {
    notice.hidden = false;
    notice.textContent = text;
    notice.dataset.kind = 'info';
    setTimeout(() => render(true), 3500);
  }
  const doAddPlugin = (card, p) => guard(() => addPlugin(view(), card.name, p.name));
  const doRemoveEntry = (card) => guard(() => {
    const names = findRack(view().state)?.entries.map((e) => e.name) || [];
    const i = names.indexOf(card.name);
    const src = removeEntry(view(), card.name);
    removed.set(card.name, { src, at: Date.now(), plugins: card.chain.map((c) => c.name), after: names[i - 1] ?? null, before: names[i + 1] ?? null });
  });

  // ---------- cards ----------
  let dragging = null; // { entry, slot }
  function plugSticker(card, c) {
    const el = h('div', `mx-plug${c.kind === 'synth' && c.slot === 0 ? ' inst' : ''}${c.bypass ? ' off' : ''}${c.status === 'missing' ? ' miss' : ''}${c.status === 'crashed' ? ' crash' : ''}`);
    el.dataset.slot = String(c.slot);
    el.dataset.testid = 'mixer-plug';
    el.draggable = true;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const tip = { missing: 'Not installed on this computer', crashed: 'Crashed. Click to reload.', loading: 'Loading', loaded: 'Click to open the plugin window' }[c.status] || '';
    el.title = `${c.name}${c.bypass ? ' (bypassed)' : ''}: ${tip}. Right-click for more, drag to reorder.`;
    const dot = h('button', 'mx-dot');
    dot.type = 'button';
    dot.dataset.testid = 'mixer-dot';
    dot.setAttribute('aria-label', c.bypass ? 'Turn on' : 'Bypass');
    dot.title = c.bypass ? 'Bypassed. Click to turn it on.' : 'On. Click to bypass.';
    dot.addEventListener('click', (e) => { e.stopPropagation(); guard(() => setBypass(view(), card.name, c.slot, !c.bypass)); });
    el.append(dot, h('span', 'mx-pname', c.name));
    const open = () => (c.status === 'crashed' ? api.reload(card.name) : c.status === 'missing' ? flash(`${c.name} is not installed on this computer.`) : api.openEditor(card.name, c.slot));
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        ['Open editor', () => api.openEditor(card.name, c.slot)],
        [c.bypass ? 'Turn on' : 'Bypass', () => guard(() => setBypass(view(), card.name, c.slot, !c.bypass))],
        ...(card.chain.length > 1 ? [['Remove from chain', () => guard(() => removePlugin(view(), card.name, c.slot)), 'danger']] : [['Remove entry', () => doRemoveEntry(card), 'danger']]),
      ]);
    });
    // drag to reorder inside this card
    el.addEventListener('dragstart', (e) => {
      dragging = { entry: card.name, slot: c.slot };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${card.name}:${c.slot}`);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      dragging = null;
      el.classList.remove('dragging');
      list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      if (!dragging || dragging.entry !== card.name) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!dragging || dragging.entry !== card.name) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      const ins = before ? c.slot : c.slot + 1;
      const to = ins > dragging.slot ? ins - 1 : ins;
      const from = dragging.slot;
      dragging = null;
      guard(() => movePlugin(view(), card.name, from, to));
    });
    return el;
  }

  function cardEl(card) {
    const el = h('div', 'mx-card');
    el.dataset.entry = card.name;
    el.dataset.testid = 'mixer-card';
    const head = h('div', 'mx-head');
    const name = h('button', 'mx-name', card.name);
    name.type = 'button';
    name.title = 'Show in the code';
    name.addEventListener('click', () => jumpToLine(card.line));
    head.append(name, chip(card.kind));
    if (card.routes > 1) head.append(h('span', 'mx-tag', `${card.routes} routes`));
    head.append(h('span', 'head-spacer'));
    const x = h('button', 'mx-x');
    x.type = 'button';
    x.dataset.testid = 'mixer-remove';
    x.innerHTML = ICON.close;
    x.title = 'Remove from the rack (you can restore it below for 10 minutes)';
    x.setAttribute('aria-label', `Remove ${card.name}`);
    x.addEventListener('click', () => doRemoveEntry(card));
    head.append(x);
    el.append(head);

    const chain = h('div', 'mx-chain');
    card.chain.forEach((c, i) => {
      if (i) chain.append(h('span', 'mx-arr', '→'));
      chain.append(plugSticker(card, c));
    });
    chain.append(h('span', 'mx-arr', '→'));
    const dest = h('button', `mx-dest${card.next ? ' is-link' : ''}`, card.next || 'speakers');
    dest.type = 'button';
    if (card.next) {
      dest.title = `Goes on to ${card.next}`;
      dest.addEventListener('click', () => list.querySelector(`.mx-card[data-entry="${CSS.escape(card.next)}"]`)?.scrollIntoView({ block: 'nearest' }));
    } else dest.disabled = true;
    chain.append(dest);
    const add = h('button', 'mx-addp');
    add.type = 'button';
    add.dataset.testid = 'mixer-addplugin';
    add.dataset.pickerAnchor = '1';
    add.innerHTML = ICON.plus;
    add.title = 'Add a plugin to this chain';
    add.setAttribute('aria-label', `Add a plugin to ${card.name}`);
    add.addEventListener('click', () => openPicker(add, { title: 'Add an effect', kind: 'effect', onPick: (p) => doAddPlugin(card, p) }));
    chain.append(add);
    el.append(chain);

    const meter = h('div', 'mx-meter');
    const fills = [h('b'), h('b')];
    for (const f of fills) { const i = h('i'); i.append(f); meter.append(i); }
    meters.set(card.name, fills);
    const lv = levels.get(card.name);
    if (lv) fills.forEach((f, k) => f.style.setProperty('--v', `${meterPct(lv[k])}%`));
    el.append(meter);

    if (card.feeders.length) {
      const from = h('div', 'mx-from');
      from.append('from ');
      const shown = card.feeders.slice(0, 4);
      shown.forEach((f, i) => {
        if (i) from.append(', ');
        const b = h('button', 'mx-feed', f.label.startsWith('$') ? `line ${f.line}` : f.label);
        b.type = 'button';
        b.title = `Go to line ${f.line}`;
        b.addEventListener('click', () => jumpToLine(f.line));
        from.append(b);
      });
      if (card.feeders.length > shown.length) from.append(` +${card.feeders.length - shown.length} more`);
      el.append(from);
    }
    return el;
  }

  // ---------- empty state ----------
  function starterRack() {
    const ps = getPlugins();
    const synth = ps.find((p) => p.kind === 'synth');
    const fx = ps.find((p) => p.kind === 'effect');
    const rows = [];
    if (synth) rows.push([uniqueName(view().state, 'synth'), synth.name]);
    if (fx) rows.push([uniqueName(view().state, 'fx'), fx.name]);
    return rows;
  }
  function renderEmpty() {
    empty.replaceChildren();
    const ps = getPlugins();
    const code = h('pre', 'mx-code');
    code.innerHTML = `<b>rack</b>({\n  pad:  <b>vst</b>("Vital"),\n  verb: [<b>vst</b>("Valhalla Room"), "master"],\n})\n\n$: note("c3 eb3").<b>s</b>("pad").<b>fx</b>("verb")`;
    const s = starterRack();
    const btn = h('button', 'btn btn-mint btn-sm', 'Insert a starter rack');
    btn.type = 'button';
    btn.dataset.testid = 'mixer-starter';
    btn.disabled = !s.length;
    btn.addEventListener('click', () => guard(() => addEntries(view(), s)));
    empty.append(
      h('b', 'mx-empty-title', 'Plugins live in your code'),
      h('p', null, 'A rack({ ... }) block names your VST3 plugins. Play an instrument with .s("name"), or send sound through an effect with .fx("name"). This pane then shows each one, and edits the code for you.'),
      code,
      h('p', 'mx-empty-note', ps.length ? `${ps.length} plugins found on this computer.` : 'No plugins found yet. Add a folder or Rescan in Settings.'),
    );
    const row = h('div', 'row');
    row.append(btn);
    if (!ps.length) {
      const set = h('button', 'btn btn-cream btn-sm', 'Open settings');
      set.type = 'button';
      set.addEventListener('click', () => showSettings?.());
      row.append(set);
    }
    empty.append(row);
  }

  // ---------- recently deleted ----------
  function renderDeleted(inCode) {
    const now = Date.now();
    for (const [n, r] of removed) if (now - r.at > AGAIN) removed.delete(n);
    const seen = new Map();
    for (const d of deleted) if (!inCode.has(d.name)) seen.set(d.name, { name: d.name, plugins: d.plugins, at: d.deletedAt, after: d.after, before: d.before });
    for (const [n, r] of removed) if (!inCode.has(n) && !seen.has(n)) seen.set(n, { name: n, plugins: r.plugins, at: r.at, after: r.after, before: r.before });
    const items = [...seen.values()].sort((a, b) => b.at - a.at);
    deletedEl.hidden = !items.length;
    deletedEl.replaceChildren();
    if (!items.length) return;
    deletedEl.append(h('div', 'mx-sec', 'Recently deleted'));
    for (const d of items) {
      const row = h('div', 'mx-del');
      row.dataset.testid = 'mixer-deleted-row';
      row.append(h('code', 'mx-del-name', d.name), h('span', 'mx-del-plugs', d.plugins.join(' → ')), h('span', 'head-spacer'));
      const b = h('button', 'head-btn btn-sky', 'Restore');
      b.type = 'button';
      b.dataset.testid = 'mixer-restore';
      b.addEventListener('click', async () => {
        const local = removed.get(d.name);
        const r = await api.restore(d.name).catch(() => null);
        const plugins = r?.plugins || d.plugins;
        if (!plugins?.length && !local) return render(true);
        guard(() => {
          const name = findRack(view().state)?.entries.some((e) => e.name === d.name) ? uniqueName(view().state, d.name) : d.name;
          const at = local ? { after: local.after, before: local.before } : { after: d.after, before: d.before };
          restoreEntry(view(), name, local?.src ?? plugins, at);
          removed.delete(d.name);
        });
      });
      row.append(b);
      deletedEl.append(row);
    }
  }

  // ---------- render ----------
  let lastSig = '';
  function render(force = false) {
    if (!api) return;
    const m = model();
    const engine = getStatus();
    const down = engine && engine.state === 'down';
    const inCode = new Set(m.cards.map((c) => c.name));
    const sig = JSON.stringify([m.cards, !!m.rack, deleted.map((d) => d.name), [...removed.keys()], getPlugins().length, engine?.state, engine?.error]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const scroll = container.querySelector('.mx-scroll').scrollTop;
    meters = new Map();
    list.replaceChildren(...m.cards.map(cardEl));
    empty.hidden = !!m.rack;
    if (!m.rack) renderEmpty();
    renderDeleted(inCode);
    if (down) {
      notice.hidden = false;
      notice.dataset.kind = 'error';
      notice.textContent = `The audio engine is not running${engine.error ? `: ${engine.error}` : '.'} Plugins stay in your code and will load when it is back.`;
    } else if (engine?.state === 'restarting' || engine?.state === 'starting') {
      notice.hidden = false;
      notice.dataset.kind = 'info';
      notice.textContent = engine.state === 'starting' ? 'The audio engine is starting...' : 'The audio engine is restarting...';
    } else notice.hidden = true;
    container.querySelector('.mx-scroll').scrollTop = scroll;
  }
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => render(), 60); };

  addBtn.dataset.pickerAnchor = '1';
  addBtn.addEventListener('click', () =>
    openPicker(addBtn, {
      title: 'Add a plugin to the rack',
      onPick: (p) => guard(() => addEntry(view(), uniqueName(view().state, p.name), p.name)),
    }));

  if (api) {
    onRack(() => { refreshDeleted(); later(); });
    onCatalogue(later);
    onStatus(later);
    api.onMeters?.((mm) => {
      for (const [name, v] of Object.entries(mm)) {
        const f = meters.get(name);
        if (!f) continue;
        const prev = levels.get(name) || [0, 0];
        const next = [Math.max(v[0], prev[0] * 0.82), Math.max(v[1], prev[1] * 0.82)];
        levels.set(name, next);
        f[0].style.setProperty('--v', `${meterPct(next[0])}%`);
        f[1].style.setProperty('--v', `${meterPct(next[1])}%`);
      }
    });
  }
  async function refreshDeleted() {
    try { deleted = (await api.deleted()) || []; } catch { deleted = []; }
    later();
  }
  refreshDeleted();
  render(true);

  return {
    refresh: () => render(true), // after another sketch is opened
    onDocChange: later,
    cards: () => model().cards,
  };
}
