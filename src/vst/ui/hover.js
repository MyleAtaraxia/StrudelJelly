// Hover card on a vst("...") call: what the plugin is, where it routes, Open editor / Parameters / Save state, and the
// "X is A in the plugin, B in code -> Update code" rows. Same look and placement as the docs hover card (.dc-card).
import { syntaxTree } from '@codemirror/language';
import { placeNear } from '../../docs/index.js';
import { findVstCalls, setParams, quote } from '../rack-source.js';
import { api, findPlugin, paramsOf, paramDiffs, rackEntry, fmtNum, h, chip, ICON } from './state.js';

const button = (cls, html, title) => {
  const b = h('button', cls);
  b.type = 'button';
  b.innerHTML = html;
  if (title) b.title = title;
  return b;
};

// the engine's name for each inline `.fx(vst(...))` chain: inline:<plugins>:<k> (k counts chains with the same plugins)
// -> Map(vst call position -> { name, slot })
export function inlineGroups(state) {
  const found = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== 'CallExpression') return;
      const callee = n.node.firstChild;
      if (callee?.name !== 'MemberExpression' || state.sliceDoc(callee.lastChild.from, callee.lastChild.to) !== 'fx') return;
      const args = n.node.getChild('ArgList');
      let first = args?.firstChild?.nextSibling;
      if (!first) return;
      const vsts = [];
      const isVst = (c) => c.name === 'CallExpression' && c.firstChild?.name === 'VariableName' && state.sliceDoc(c.firstChild.from, c.firstChild.to) === 'vst';
      if (isVst(first)) vsts.push(first);
      else if (first.name === 'ArrayExpression') for (let c = first.firstChild; c; c = c.nextSibling) if (isVst(c)) vsts.push(c);
      if (vsts.length) found.push({ at: first.from, vsts: vsts.map((c) => c.from) });
    },
  });
  found.sort((a, b) => a.at - b.at);
  const calls = new Map(findVstCalls(state).map((c) => [c.from, c]));
  const counts = new Map();
  const out = new Map();
  for (const g of found) {
    const sig = g.vsts.map((p) => {
      const n = calls.get(p)?.name ?? '';
      return findPlugin(n)?.name ?? n;
    }).join('+');
    const k = (counts.get(sig) || 0) + 1;
    counts.set(sig, k);
    g.vsts.forEach((p, slot) => out.set(p, { name: `inline:${sig}:${k}`, slot }));
  }
  return out;
}

// which engine group and slot is this vst() call? { group, slot, inline }
export function groupOf(state, call) {
  if (call.entry) return { group: call.entry, slot: call.slot, inline: false };
  const g = inlineGroups(state).get(call.from);
  return g ? { group: g.name, slot: g.slot, inline: true } : null;
}

export function initHover({ view }) {
  const card = h('div', 'dc-card vst-card');
  card.hidden = true;
  card.dataset.testid = 'vst-card';
  document.body.append(card);
  let shownFor = null;
  let hoverTimer = 0;
  let hideTimer = 0;
  let token = 0;

  const hide = () => {
    clearTimeout(hideTimer);
    card.hidden = true;
    shownFor = null;
    token++;
  };
  const hideSoon = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 300);
  };
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', hideSoon);

  const routesText = (st) => {
    const r = st?.routes || [];
    if (!r.length) return '';
    return r.length === 1 ? `→ ${r[0].to ?? 'speakers'}` : `${r.length} routes (${r.map((x) => `→ ${x.to ?? 'speakers'}`).join(', ')})`;
  };

  async function build(call, g) {
    const state = view().state;
    const info = findPlugin(call.name);
    const st = g?.inline ? null : rackEntry(g?.group);
    const root = h('div', 'vst-card-in');
    const top = h('div', 'vst-card-top');
    top.append(h('code', 'vst-card-name', info?.name || call.name));
    if (info) top.append(chip(info.kind));
    top.append(h('span', 'head-spacer'), h('span', 'vst-card-entry', g ? (g.inline ? 'on this pattern' : g.group) : ''));
    root.append(top);
    if (!info) {
      root.append(h('div', 'vst-card-sub', 'Not installed on this computer. Its saved state is kept for a PC that has it.'));
      return root;
    }
    const params = await paramsOf(info.name);
    const bits = [info.vendor, info.format || 'VST3', `${params.length} params`];
    const rt = routesText(st);
    if (rt) bits.push(rt);
    root.append(h('div', 'vst-card-sub', bits.filter(Boolean).join(' · ')));

    // code vs plugin differences (rack entries only: those are the ones with a live copy to compare against)
    if (g && !g.inline) {
      const diffs = paramDiffs(g.group, g.slot);
      if (diffs.length) {
        const box = h('div', 'vst-diffs');
        const apply = (list, row) => {
          const vals = {};
          for (const d of list) vals[d.key] = typeof d.plugin === 'string' ? quote(d.plugin) : String(+Number(d.plugin).toFixed(4));
          setParams(view(), g.group, g.slot, vals);
          row.remove();
          if (!box.children.length) box.remove();
        };
        for (const d of diffs.slice(0, 5)) {
          const row = h('div', 'vst-diff');
          const t = h('span');
          const b = (x) => h('b', null, x);
          t.append(b(d.key), ' is ', b(typeof d.plugin === 'number' ? fmtNum(d.plugin) : String(d.plugin)), ' in the plugin, ', b(String(d.code)), ' in code');
          const btn = button('head-btn btn-butter', 'Update code', 'Rewrite the value in your code');
          btn.addEventListener('click', () => apply([d], row));
          row.append(t, btn);
          box.append(row);
        }
        if (diffs.length > 1) {
          const all = button('head-btn btn-butter vst-diff-all', `Update all ${diffs.length}`);
          all.addEventListener('click', () => apply(diffs, box));
          box.append(all);
        }
        root.append(box);
      }
    }

    const btns = h('div', 'vst-card-btns');
    const open = button('head-btn btn-sky', `${ICON.window}Open editor`, "Open the plugin's own window");
    open.addEventListener('click', () => g && api.openEditor(g.group, g.slot));
    const list = button('head-btn', `${ICON.list}Parameters`, 'Every knob, to copy into your code');
    const save = button('head-btn', 'Save state', "Write this sketch's .rack file now");
    save.addEventListener('click', () => {
      api.saveState();
      save.textContent = 'Saved';
    });
    btns.append(open, list, save);
    root.append(btns);

    // Parameters: searchable, click a row to copy `key: value`
    const panel = h('div', 'vst-params');
    panel.hidden = true;
    const search = h('input', 'vst-params-q');
    search.type = 'text';
    search.placeholder = 'Search parameters';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Search parameters');
    const rows = h('div', 'vst-params-list');
    let live = {};
    const copied = h('span', 'vst-params-copied');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      rows.replaceChildren();
      let n = 0;
      for (const p of params) {
        if (q && !p.key.toLowerCase().includes(q) && !String(p.name).toLowerCase().includes(q)) continue;
        if (n++ >= 150) break;
        const cur = live[p.key];
        const row = button('vst-param', '');
        const val = p.choices?.length ? cur?.text ?? p.choices[0] : cur ? cur.value : p.def;
        const code = typeof val === 'number' ? String(+val.toFixed(4)) : quote(val);
        row.append(h('code', 'vst-param-key', p.key), h('span', 'vst-param-val', cur?.text ?? (typeof val === 'number' ? fmtNum(val) : String(val))));
        row.title = `${p.name} · click to copy ${p.key}: ${code}`;
        row.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(`${p.key}: ${code}`);
            copied.textContent = `Copied ${p.key}: ${code}`;
          } catch {
            copied.textContent = 'Could not copy';
          }
        });
        rows.append(row);
      }
      if (!n) rows.append(h('div', 'dc-none', 'No match'));
    };
    search.addEventListener('input', draw);
    panel.append(search, rows, copied);
    root.append(panel);
    list.addEventListener('click', async () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        if (g && api) live = (await api.paramValues(g.group, g.slot).catch(() => null)) || {};
        draw();
        search.focus();
        placeNear(card, card._rect);
      }
    });
    return root;
  }

  async function show(call, rect) {
    const state = view().state;
    const g = groupOf(state, call);
    const key = `${call.from}:${call.name}`;
    clearTimeout(hideTimer);
    if (shownFor === key && !card.hidden) return;
    const mine = ++token;
    const el = await build(call, g);
    if (mine !== token) return;
    shownFor = key;
    card._rect = rect;
    card.replaceChildren(el);
    card.hidden = false;
    placeNear(card, rect);
  }

  view().dom.addEventListener('mousemove', (ev) => {
    clearTimeout(hoverTimer);
    const { clientX: x, clientY: y } = ev;
    hoverTimer = setTimeout(() => {
      const v = view();
      const pos = v.posAtCoords({ x, y });
      const call = pos == null ? null : findVstCalls(v.state).find((c) => c.nameFrom >= 0 && pos >= c.nameFrom && pos <= c.nameTo);
      const a = call && v.coordsAtPos(call.nameFrom), b = call && v.coordsAtPos(call.nameTo);
      const over = a && b && x >= a.left - 1 && x <= b.right + 1 && y >= a.top && y <= b.bottom;
      if (!over) {
        if (!card.hidden) hideSoon();
        return;
      }
      show(call, { left: a.left, top: a.top, bottom: b.bottom });
    }, 380);
  });
  view().dom.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    if (!card.hidden) hideSoon();
  });
  view().scrollDOM.addEventListener('scroll', hide);
  document.addEventListener('mousedown', (e) => {
    if (!card.hidden && !card.contains(e.target)) hide();
  }, true);
  view().dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !card.hidden) hide();
  }, true);
  addEventListener('resize', hide);

  return { hide, show, element: card };
}
