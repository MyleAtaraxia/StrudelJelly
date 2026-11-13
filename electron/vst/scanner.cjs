// The plugin scan. Every .vst3 in the plugin folders is described by its own `jelly-host --scan <path>` child with a
// timeout, so a plugin that hangs or crashes only takes that child down; it is then marked skipped and stays skipped
// until its file changes. Results are cached in userData (vst-plugins.json) and only new or changed files are
// scanned again, in the background.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SCAN_TIMEOUT = 45000;
const PARALLEL = 4;
const VERSION = 1;

function defaultFolders() {
  if (process.platform === 'win32') return [path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3')];
  if (process.platform === 'darwin') return ['/Library/Audio/Plug-Ins/VST3', path.join(require('node:os').homedir(), 'Library/Audio/Plug-Ins/VST3')];
  return [path.join(require('node:os').homedir(), '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3'];
}

async function findBundles(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (/\.vst3$/i.test(e.name)) out.push(p); // a bundle folder or a single-file plugin: do not look inside
    else if (e.isDirectory()) await findBundles(p, depth + 1, out);
  }
  return out;
}

class Scanner extends EventEmitter {
  constructor({ exe, cacheFile }) {
    super();
    this.exe = exe;
    this.cacheFile = cacheFile;
    this.scanning = false;
    this.again = false;
    this.cache = { version: VERSION, folders: [], files: {} };
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.version === VERSION) this.cache = { folders: [], files: {}, ...c };
    } catch {}
  }

  folders() {
    return [...new Set([...defaultFolders(), ...(this.cache.folders || [])])];
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile + '.tmp', JSON.stringify(this.cache));
      fs.renameSync(this.cacheFile + '.tmp', this.cacheFile);
    } catch {}
  }

  all() {
    const out = [];
    for (const f of Object.values(this.cache.files)) if (f.plugins) out.push(...f.plugins);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  plugins() {
    return this.all().map(({ uid, name, vendor, kind, format, path: p }) => ({ uid, name, vendor, kind, format, path: p }));
  }

  // by exact name, then ignoring case, then with the vendor in front ("FabFilter One" for One)
  find(name) {
    const all = this.all();
    const n = String(name).toLowerCase();
    return all.find((p) => p.name === name) || all.find((p) => p.name.toLowerCase() === n) ||
      all.find((p) => `${p.vendor} ${p.name}`.toLowerCase() === n) || null;
  }

  params(name) {
    return this.find(name)?.params || [];
  }

  info() {
    const skipped = Object.entries(this.cache.files)
      .filter(([, f]) => f.skipped)
      .map(([p, f]) => ({ path: p, reason: f.skipped }));
    return { found: this.all().length, skipped, scanning: this.scanning, folders: this.folders() };
  }

  setFolders(folders) {
    const defaults = new Set(defaultFolders().map((f) => f.toLowerCase()));
    this.cache.folders = [...new Set((Array.isArray(folders) ? folders : []).filter((f) => typeof f === 'string' && f.trim()))]
      .filter((f) => !defaults.has(f.toLowerCase()));
    this.save();
    this.scan();
  }

  // one child per file
  scanOne(file) {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      let child;
      try {
        child = spawn(this.exe, ['--scan', file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch (e) {
        resolve({ skipped: `could not start the scanner: ${e.message}` });
        return;
      }
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ skipped: `did not respond within ${SCAN_TIMEOUT / 1000} s` });
      }, SCAN_TIMEOUT);
      child.stdout.on('data', (d) => (out += d));
      child.on('error', (e) => finish({ skipped: `scanner failed: ${e.message}` }));
      child.on('exit', (code, signal) => {
        const line = out.trim().split('\n').filter(Boolean).at(-1);
        try {
          const r = JSON.parse(line);
          if (Array.isArray(r.plugins)) {
            const ok = r.plugins.filter((p) => !p.error || p.params?.length);
            if (!ok.length) return finish({ skipped: r.plugins[0]?.error || 'no VST3 plugin in this file' });
            return finish({ plugins: ok.map(({ error, ...p }) => p) });
          }
        } catch {}
        finish({ skipped: `crashed while scanning (${signal || 'exit code ' + code})` });
      });
    });
  }

  // force: rescan every file that is not skipped (skipped ones stay skipped until they change)
  async scan(force = false) {
    if (this.scanning) {
      this.again = true;
      return;
    }
    this.scanning = true;
    this.emit('scan', this.info());
    try {
      const files = [];
      for (const dir of this.folders()) await findBundles(dir, 0, files);
      const present = new Set(files);
      for (const p of Object.keys(this.cache.files)) if (!present.has(p)) delete this.cache.files[p];
      const todo = [];
      for (const f of files) {
        const st = await fsp.stat(f).catch(() => null);
        if (!st) continue;
        const stamp = `${Math.round(st.mtimeMs)}:${st.size}`;
        const c = this.cache.files[f];
        if (c && c.stamp === stamp && (c.skipped || !force)) continue;
        todo.push({ f, stamp });
      }
      let changed = false;
      const worker = async () => {
        while (todo.length) {
          const { f, stamp } = todo.shift();
          const r = await this.scanOne(f);
          this.cache.files[f] = { stamp, ...r };
          changed = true;
          this.save();
          this.emit('scan', { ...this.info(), scanning: true });
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (changed) this.emit('changed');
    } finally {
      this.scanning = false;
      this.save();
      this.emit('scan', this.info());
      if (this.again) {
        this.again = false;
        this.scan();
      }
    }
  }
}

module.exports = { Scanner, defaultFolders };
