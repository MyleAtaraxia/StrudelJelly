const { app, BrowserWindow, ipcMain, dialog, shell, session, net, nativeTheme, protocol } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setupVst } = require('./vst/host.cjs');

const ORIGIN = 'jelly://app';
const DIST = path.join(__dirname, '..', 'dist');
const LIB = path.join(app.getPath('documents'), 'Strudel Jelly', 'samples');
const SKETCHES = process.env.JELLY_SKETCHES || path.join(app.getPath('documents'), 'Strudel Jelly', 'sketches');
const CACHE =path.join(app.getPath('userData'), 'sound-cache');
const AUDIO = /\.(wav|mp3|ogg|flac|aiff?|m4a|opus|webm)$/i;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.webm': 'audio/webm',
};

let win;

// ---------- sample library (Documents\Strudel Jelly\samples) ----------

const soundName = (s) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'sound';

async function walk(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (AUDIO.test(e.name)) out.push(p);
  }
  return out;
}

async function libraryMap() {
  await fsp.mkdir(LIB, { recursive: true });
  const map = { _base: `${ORIGIN}/lib/` };
  const rel = (p) => path.relative(LIB, p).split(path.sep).map(encodeURIComponent).join('/');
  for (const e of await fsp.readdir(LIB, { withFileTypes: true })) {
    const p = path.join(LIB, e.name);
    if (e.isDirectory()) {
      const files = (await walk(p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (files.length) map[soundName(e.name)] = files.map(rel);
    } else if (AUDIO.test(e.name)) {
      map[soundName(e.name)] = [rel(p)];
    }
  }
  return map;
}

async function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  const { name: stem, ext } = path.parse(name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${stem} ${i}${ext}`);
  return dest;
}

// paths: files and/or folders. Folders become banks; loose files go into `bank`.
async function addToLibrary(paths, bank) {
  let added = 0;
  for (const src of paths) {
    const st = await fsp.stat(src).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const files = await walk(src);
      if (!files.length) continue;
      const dest = path.join(LIB, path.basename(src));
      for (const f of files) {
        const to = path.join(dest, path.relative(src, f));
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(f, to);
        added++;
      }
    } else if (AUDIO.test(src)) {
      const dir = path.join(LIB, soundName(bank || 'my_sounds'));
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(src, await uniqueDest(dir, path.basename(src)));
      added++;
    }
  }
  return added;
}

// ---------- offline cache for every https request (samples, soundfonts, github:...) ----------

function cachePath(url) {
  const u = new URL(url);
  const clean = decodeURIComponent(u.pathname).split('/').map((s) => s.replace(/[<>:"|?*\\]/g, '_')).join(path.sep);
  const q = u.search ? '~' + crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 10) : '';
  return path.join(CACHE, u.host, clean + q);
}

const corsHeaders = (type) => ({ 'content-type': type, 'access-control-allow-origin': '*' });

async function fetchCached(url) {
  const file = cachePath(url);
  try {
    const buf = await fsp.readFile(file);
    return { buf, type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', cached: true };
  } catch {}
  const res = await net.fetch(url, { bypassCustomProtocolHandlers: true });
  if (!res.ok) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'text/plain' };
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file + '.part', buf);
  await fsp.rename(file + '.part', file);
  return { buf, type: res.headers.get('content-type') || 'application/octet-stream', cached: false };
}

function interceptHttps() {
  session.defaultSession.protocol.handle('https', async (req) => {
    if (req.method !== 'GET') return net.fetch(req, { bypassCustomProtocolHandlers: true });
    try {
      const r = await fetchCached(req.url);
      return new Response(r.buf, { status: r.status || 200, headers: corsHeaders(r.type) });
    } catch (e) {
      return new Response(`offline and not cached: ${req.url}`, { status: 504, headers: corsHeaders('text/plain') });
    }
  });
}

let prefetching = false;
async function prefetchAll(urls) {
  if (prefetching) return;
  prefetching = true;
  const todo = [...new Set(urls)].filter((u) => u.startsWith('https://') && !fs.existsSync(cachePath(u)));
  const total = todo.length;
  let done = 0, failed = 0, bytes = 0;
  const send = (finished = false) => win?.webContents.send('prefetch-progress', { done, total, failed, bytes, finished });
  send();
  const worker = async () => {
    while (todo.length) {
      const u = todo.pop();
      try {
        const r = await fetchCached(u);
        if (r.status) failed++;
        else bytes += r.buf.length;
      } catch {
        failed++;
      }
      done++;
      if (done % 10 === 0) send();
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  prefetching = false;
  send(true);
}

async function cacheSize(dir = CACHE) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await cacheSize(p) : (await fsp.stat(p)).size;
  }
  return total;
}

// ---------- jelly:// serves the app UI and the library files ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'jelly', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function inside(root, rel) {
  const p = path.join(root, rel);
  return p.startsWith(root + path.sep) ? p : null;
}

async function fileResponse(file) {
  try {
    const buf = await fsp.readFile(file);
    return new Response(buf, { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function serveApp() {
  protocol.handle('jelly', async (req) => {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    if (pathname === '/library.json') {
      return new Response(JSON.stringify(await libraryMap()), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const file = pathname.startsWith('/lib/') ? inside(LIB, pathname.slice(5)) : inside(DIST, pathname === '/' ? 'index.html' : pathname.slice(1));
    return file ? fileResponse(file) : new Response('forbidden', { status: 403 });
  });
}

// ---------- window ----------

const bg = () => (nativeTheme.shouldUseDarkColors ? '#141015' : '#FBE4E6');
const ink = () => (nativeTheme.shouldUseDarkColors ? '#FFF4E6' : '#5C4037');

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    title: 'Strudel Jelly',
    backgroundColor: bg(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: bg(), symbolColor: ink(), height: 57 },
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // The scheduler must keep time while the window is hidden. Chromium only exempts audible pages from timer
    // throttling, and with the audio engine running the page itself is silent (jelly-host plays the sound).
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  });
  win.removeMenu();
  win.loadURL(`${ORIGIN}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

// ---------- sketches (Documents\Strudel Jelly\sketches) ----------

const str = (v, what = 'argument') => {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`);
  return v;
};

// Windows-safe sketch/file name: strip illegal and control chars, trim, max 80, never empty.
function cleanName(raw) {
  let n = str(raw, 'name').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 80).replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n += '_';
  return n || 'untitled';
}

// Path of an existing sketch by its exact name; null if the name could escape the folder.
function sketchFile(name) {
  str(name, 'name');
  if (!name || /[/\\\u0000]/.test(name)) return null;
  return inside(SKETCHES, name + '.js');
}
const mustSketch = (name) => {
  const f = sketchFile(name);
  if (!f) throw new Error('invalid sketch name');
  return f;
};

let vst = null; // { host, scanner, racks } (electron/vst/host.cjs)
let lastWrite = 0; // when the app last changed the sketches folder itself
const touched = () => { lastWrite = Date.now(); };
const sketchOf = (file) => path.basename(file, '.js');

async function newSketch(name, code) {
  const dir = SKETCHES;
  await fsp.mkdir(dir, { recursive: true });
  touched();
  for (;;) {
    const dest = await uniqueDest(dir, cleanName(name) + '.js');
    try {
      await fsp.writeFile(dest, code, { flag: 'wx' });
      return sketchOf(dest);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      touched();
    }
  }
}

async function sketchList() {
  const out = [];
  for (const e of await fsp.readdir(SKETCHES, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !/\.js$/i.test(e.name)) continue;
    const st = await fsp.stat(path.join(SKETCHES, e.name)).catch(() => null);
    if (st) out.push({ name: e.name.slice(0, -3), modified: Math.round(st.mtimeMs) });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

async function sketchWrite(name, code) {
  str(code, 'code');
  const raw = str(name, 'name');
  const exact = sketchFile(raw);
  const file = exact && fs.existsSync(exact) ? exact : path.join(SKETCHES, cleanName(raw) + '.js');
  await fsp.mkdir(SKETCHES, { recursive: true });
  const tmp = path.join(SKETCHES, `.${path.basename(file)}.${process.pid}.tmp`);
  touched();
  try {
    await fsp.writeFile(tmp, code);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  } finally {
    touched();
  }
}

async function sketchRename(name, newName) {
  const from = mustSketch(name);
  const clean = cleanName(newName);
  if (clean === name) return name;
  touched();
  try {
    // case-only change (same file on Windows) renames in place; otherwise pick a free name
    const to = clean.toLowerCase() === name.toLowerCase() ? path.join(SKETCHES, clean + '.js') : await uniqueDest(SKETCHES, clean + '.js');
    await fsp.rename(from, to);
    // the plugin state (.rack) goes with its sketch
    const rack = from.slice(0, -3) + '.rack';
    if (fs.existsSync(rack)) await fsp.rename(rack, to.slice(0, -3) + '.rack').catch((e) => console.warn('rack rename', e));
    vst?.racks.renamed(name, sketchOf(to));
    return sketchOf(to);
  } finally {
    touched();
  }
}

async function sketchDuplicate(name) {
  const file = mustSketch(name);
  const code = await fsp.readFile(file, 'utf8');
  const copy = await newSketch(cleanName(name) + ' copy', code);
  const rack = file.slice(0, -3) + '.rack';
  if (fs.existsSync(rack)) await fsp.copyFile(rack, path.join(SKETCHES, copy + '.rack')).catch((e) => console.warn('rack copy', e));
  return copy;
}

async function sketchDelete(name) {
  touched();
  try {
    const file = mustSketch(name);
    await shell.trashItem(file);
    const rack = file.slice(0, -3) + '.rack';
    if (fs.existsSync(rack)) await shell.trashItem(rack).catch((e) => console.warn('rack delete', e));
  } finally {
    touched();
  }
}

// ---------- user sounds: rename / delete / reveal ----------

// Finds the library entry a sound name maps to, the way libraryMap does: later entries win,
// folders without audio are skipped, loose audio files in the root are sounds of their own.
async function findSound(name) {
  str(name, 'name');
  let found = null;
  const names = new Set();
  for (const e of await fsp.readdir(LIB, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(LIB, e.name);
    if (e.isDirectory()) {
      if (!(await walk(p)).length) continue;
    } else if (!AUDIO.test(e.name)) continue;
    const n = soundName(e.name);
    names.add(n);
    if (n === name) found = { path: p, dir: e.isDirectory() };
  }
  return { found, names };
}

async function mustSound(name) {
  const { found, names } = await findSound(name);
  if (!found || !inside(LIB, path.basename(found.path))) throw new Error(`no such sound: ${name}`);
  return { ...found, names };
}

async function soundRename(name, newName) {
  const s = await mustSound(name);
  const base = soundName(str(newName, 'newName'));
  if (base === name) return name;
  let final = base;
  for (let i = 2; s.names.has(final); i++) final = `${base}_${i}`;
  const ext = s.dir ? '' : path.extname(s.path); // loose file keeps its extension
  const to = inside(LIB, final + ext);
  if (!to) throw new Error('invalid name');
  await fsp.rename(s.path, to);
  return final;
}

async function soundDelete(name) {
  await shell.trashItem((await mustSound(name)).path);
}

async function soundReveal(name) {
  const s = await mustSound(name);
  if (s.dir) await shell.openPath(s.path);
  else shell.showItemInFolder(s.path); // loose file: show it selected in the library root
}

let sketchTimer;
function watchSketches() {
  fs.mkdirSync(SKETCHES, { recursive: true });
  fs.watch(SKETCHES, (_, file) => {
    if (file && !/\.js$/i.test(file)) return;
    if (Date.now() - lastWrite < 1000) return;
    clearTimeout(sketchTimer);
    sketchTimer = setTimeout(() => {
      if (Date.now() - lastWrite >= 1000) win?.webContents.send('sketches-changed');
    }, 300);
  });
}

let watchTimer;
function watchLibrary() {
  fs.mkdirSync(LIB, { recursive: true });
  fs.watch(LIB, { recursive: true }, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => win?.webContents.send('library-changed'), 400);
  });
}

ipcMain.handle('library:path', () => LIB);
ipcMain.handle('library:open', () => shell.openPath(LIB));
ipcMain.handle('library:add', (_, paths, bank) => addToLibrary(paths, bank));
ipcMain.handle('library:pick', async (_, folders) => {
  const r = await dialog.showOpenDialog(win, {
    title: folders ? 'Add sample folders (each folder becomes a sound)' : 'Add sample files',
    properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: folders ? undefined : [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'm4a', 'opus', 'webm'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('cache:status', async (_, urls) => ({
  cached: urls.filter((u) => fs.existsSync(cachePath(u))).length,
  total: urls.length,
  bytes: await cacheSize(),
}));
ipcMain.handle('cache:prefetch', (_, urls) => prefetchAll(urls));
ipcMain.handle('cache:open', async () => {
  await fsp.mkdir(CACHE, { recursive: true });
  return shell.openPath(CACHE);
});
ipcMain.handle('sketch:list', () => sketchList());
ipcMain.handle('sketch:read', (_, name) => fsp.readFile(mustSketch(name), 'utf8'));
ipcMain.handle('sketch:write', (_, name, code) => sketchWrite(name, code));
ipcMain.handle('sketch:create', (_, name, code) => newSketch(name, str(code ?? '', 'code')));
ipcMain.handle('sketch:rename', (_, name, newName) => sketchRename(name, newName));
ipcMain.handle('sketch:duplicate', (_, name) => sketchDuplicate(name));
ipcMain.handle('sketch:delete', (_, name) => sketchDelete(name));
ipcMain.handle('sketch:open', async () => {
  await fsp.mkdir(SKETCHES, { recursive: true });
  return shell.openPath(SKETCHES);
});
ipcMain.handle('sound:rename', (_, name, newName) => soundRename(name, newName));
ipcMain.handle('sound:delete', (_, name) => soundDelete(name));
ipcMain.handle('sound:reveal', (_, name) => soundReveal(name));
ipcMain.handle('theme:titlebar', (_, color, symbolColor) => win?.setTitleBarOverlay({ color, symbolColor }));

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  if (!primary) return;
  interceptHttps();
  serveApp();
  watchLibrary();
  watchSketches();
  vst = setupVst({ app, ipcMain, getWin: () => win, sketchesDir: SKETCHES });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
