import { onDocChange, replaceDoc, openDoc } from './strudel.js';

// Saved sketches: one .js file each, through window.jelly.sketch*.
// Every operation that touches the open sketch runs through one promise queue, so a debounced autosave, a switch,
// a rename and an external-change reload can never interleave.
const SAVE_DELAY = 800;
const NEW_CODE = '// new sketch\n\n';

const ICONS = {
  new: '<path d="M12 5v14M5 12h14"></path>',
  copy: '<path d="M9 9h10v10H9zM5 15V5h10"></path>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
  more: '<circle cx="5" cy="12" r="1.2"></circle><circle cx="12" cy="12" r="1.2"></circle><circle cx="19" cy="12" r="1.2"></circle>',
};
const svg = (k) => `<svg aria-hidden="true" viewBox="0 0 24 24">${ICONS[k]}</svg>`;

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

export function createSketches({ editor, store, jelly, container, defaultCode, showPane, onName, onSaveState, onOpen, getSettings }) {
  const states = new Map(); // sketch name -> its EditorState (text, cursor, undo history)
  let current = null;
  let list = [];
  let dirty = false;
  let loading = false; // true while we replace the document ourselves
  let timer = null;
  let queue = Promise.resolve();
  let menu = null;

  const enqueue = (fn) => {
    const run = queue.then(fn);
    queue = run.catch((e) => console.warn('sketch:', e));
    return run;
  };
  const state = (s) => onSaveState?.(s);

  // ---------- saving ----------
  function markDirty() {
    dirty = true;
    state('edited');
    clearTimeout(timer);
    timer = setTimeout(() => enqueue(flush), SAVE_DELAY);
  }
  async function flush() {
    clearTimeout(timer);
    if (!dirty || current == null) return;
    const name = current;
    const code = editor.code;
    dirty = false; // an edit while the write is in flight sets it again
    try {
      await jelly.sketchWrite(name, code);
      if (!dirty) state('saved');
    } catch (e) {
      console.warn('save failed', e);
      dirty = true;
      state('error');
    }
  }
  onDocChange(editor, () => {
    if (!loading) markDirty();
  });

  // ---------- opening ----------
  function setDoc(code) {
    loading = true;
    try { replaceDoc(editor, code); } finally { loading = false; }
  }
  function setCurrent(name) {
    current = name;
    store.set('jelly-sketch', name);
    onName?.(name);
    state('saved');
    render();
  }
  // flush, read, flush again (keys typed during the read), then swap. No await between the last flush and the swap.
  async function load(name) {
    await flush();
    const code = await jelly.sketchRead(name);
    await flush();
    if (current != null) states.set(current, editor.editor.state);
    loading = true;
    try { openDoc(editor, code, states.get(name), getSettings?.()); } finally { loading = false; }
    dirty = false;
    setCurrent(name);
    onOpen?.(name);
  }
  const open = (name) => (name === current ? Promise.resolve() : enqueue(() => load(name).catch(() => refresh())));

  async function refresh() {
    list = await jelly.sketchList();
    render();
  }

  async function openFirstOrNew() {
    await refresh();
    if (!list.length) {
      const name = await jelly.sketchCreate('untitled', NEW_CODE);
      await refresh();
      return load(name);
    }
    return load(list[0].name);
  }

  // ---------- commands ----------
  const create = () =>
    enqueue(async () => {
      await flush();
      const name = await jelly.sketchCreate('untitled', NEW_CODE);
      await refresh();
      await load(name);
      showPane?.();
      startRename(name);
    });
  const duplicate = (name = current, openIt = true) =>
    enqueue(async () => {
      if (name === current) await flush();
      const copy = await jelly.sketchDuplicate(name);
      await refresh();
      if (openIt) await load(copy);
    });
  const rename = (name, to) =>
    enqueue(async () => {
      to = (to || '').trim();
      if (!to || to === name) return;
      if (name === current) await flush();
      const final = await jelly.sketchRename(name, to);
      if (states.has(name)) { states.set(final, states.get(name)); states.delete(name); }
      await refresh();
      if (name === current) setCurrent(final);
    });
  const remove = (name) =>
    enqueue(async () => {
      if (name === current) {
        // nothing to save for a sketch that is going away
        clearTimeout(timer);
        dirty = false;
      }
      await jelly.sketchDelete(name);
      states.delete(name);
      await refresh();
      if (name === current) {
        current = null;
        await openFirstOrNew();
      }
    });
  const save = () => enqueue(flush);

  // ---------- external changes ----------
  const onExternal = () =>
    enqueue(async () => {
      await refresh();
      if (current == null) return;
      if (!list.some((s) => s.name === current)) {
        // deleted outside the app: its unsaved edits go with it
        clearTimeout(timer);
        dirty = false;
        current = null;
        return openFirstOrNew();
      }
      if (dirty) return;
      const code = await jelly.sketchRead(current).catch(() => null);
      if (code != null && !dirty && code !== editor.code) setDoc(code);
    });
  jelly.onSketchesChanged(onExternal);

  // ---------- list UI ----------
  container.innerHTML = `
    <div class="sk-head"><h2>Sketches</h2></div>
    <div class="sk-tools">
      <button type="button" class="btn btn-mint btn-sm" data-act="new" data-testid="sketch-new" title="New sketch (Ctrl+N)">${svg('new')}<span>New</span></button>
      <button type="button" class="btn btn-sky btn-sm" data-act="dup" data-testid="sketch-duplicate" title="Duplicate this sketch">${svg('copy')}<span>Duplicate</span></button>
      <button type="button" class="btn btn-cream btn-sm" data-act="folder" data-testid="sketch-folder" title="Open the sketches folder">${svg('folder')}<span>Open folder</span></button>
    </div>
    <div class="sk-list" role="list" data-testid="sketch-list"></div>`;
  const listEl = container.querySelector('.sk-list');
  container.querySelector('[data-act=new]').onclick = create;
  container.querySelector('[data-act=dup]').onclick = () => duplicate();
  container.querySelector('[data-act=folder]').onclick = () => jelly.openSketches();

  function render() {
    // never rebuild under an inline rename
    if (listEl.querySelector('.sk-rename')) return;
    listEl.textContent = '';
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'sk-row';
      row.setAttribute('role', 'listitem');
      row.dataset.testid = 'sketch-row';
      row.dataset.name = s.name;
      row.dataset.modified = s.modified;
      if (s.name === current) row.setAttribute('aria-current', 'true');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'sk-open';
      main.title = 'Open (F2 renames)';
      const nm = document.createElement('span');
      nm.className = 'sk-name';
      nm.textContent = s.name;
      const tm = document.createElement('span');
      tm.className = 'sk-time';
      tm.textContent = ago(s.modified);
      main.append(nm, tm);
      main.onclick = () => open(s.name);
      main.onkeydown = (e) => e.key === 'F2' && startRename(s.name);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'sk-more';
      more.setAttribute('aria-label', `Actions for ${s.name}`);
      more.title = 'Rename, duplicate, delete';
      more.innerHTML = svg('more');
      more.onclick = (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        openMenu(s.name, r.right, r.bottom + 4);
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        openMenu(s.name, e.clientX, e.clientY);
      };
      row.append(main, more);
      listEl.append(row);
    }
  }
  setInterval(() => {
    listEl.querySelectorAll('.sk-row').forEach((r) => {
      r.querySelector('.sk-time').textContent = ago(Number(r.dataset.modified));
    });
  }, 30000);

  function startRename(name) {
    const row = [...listEl.children].find((r) => r.dataset.name === name);
    const nm = row?.querySelector('.sk-name');
    if (!nm || row.querySelector('.sk-rename')) return;
    const input = document.createElement('input');
    input.className = 'sk-rename';
    input.value = name;
    input.maxLength = 80;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Sketch name');
    nm.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const to = input.value;
      input.replaceWith(nm);
      if (commit) rename(name, to);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation();
  }

  // ---------- row menu ----------
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  function openMenu(name, x, y) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'sk-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.testid = 'sketch-menu';
    const item = (label, id, fn, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = cls;
      b.dataset.testid = id;
      b.textContent = label;
      b.onclick = (e) => {
        e.stopPropagation();
        fn(b);
      };
      menu.append(b);
    };
    item('Rename', 'sketch-menu-rename', () => { closeMenu(); startRename(name); });
    item('Duplicate', 'sketch-menu-duplicate', () => { closeMenu(); duplicate(name, false); });
    item('Delete', 'sketch-menu-delete', (b) => {
      if (!b.classList.contains('confirm')) {
        b.classList.add('confirm');
        b.textContent = 'Click again to delete (Recycle Bin)';
        return;
      }
      closeMenu();
      remove(name);
    }, 'danger');
    document.body.append(menu);
    const m = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x - m.width, innerWidth - m.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - m.height - 8)) + 'px';
    menu.querySelector('button').focus();
  }
  document.addEventListener('pointerdown', (e) => menu && !menu.contains(e.target) && closeMenu(), true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && menu && closeMenu());
  addEventListener('blur', closeMenu);

  // ---------- shortcuts, lifecycle ----------
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); save(); }
    else if (k === 'n') { e.preventDefault(); create(); }
  });
  // best effort when the window closes: fire the write without awaiting
  addEventListener('beforeunload', () => {
    if (dirty && current != null) jelly.sketchWrite(current, editor.code);
  });

  async function init() {
    await refresh();
    if (!list.length) {
      // first run: bring the old localStorage autosave along
      const old = store.get('jelly-code', '');
      const name = await jelly.sketchCreate('my first sketch', old || defaultCode);
      store.set('jelly-code', '');
      await refresh();
      return load(name);
    }
    const last = store.get('jelly-sketch', '');
    return load(list.some((s) => s.name === last) ? last : list[0].name);
  }

  return {
    init: () => enqueue(init),
    create,
    duplicate: () => duplicate(),
    save,
    open,
    current: () => current,
    refresh: () => refresh().catch(() => {}),
    renameCurrent: (to) => rename(current, to),
    startRename,
  };
}
