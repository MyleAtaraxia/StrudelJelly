// The plugin scan. Every plugin file in the plugin folders (.vst3 for VST3; .dll on Windows, .so on Linux, .vst on
// macOS for VST2) is described by its own `jelly-host --scan <path>` child with a timeout, so a plugin that hangs or
// crashes only takes that child down; it is then marked skipped and stays skipped until its file changes. A VST2 file
// that holds no plugin (a helper library) is ignored quietly. Results are cached in userData (vst-plugins.json) and
// only new or changed files are scanned again, in the background.
//
// A plugin installed as both VST3 and VST2 is listed once, as VST3: the VST2 copy is hidden. VST2 names lose the
// vendor in front ("FabFilter Pro-L 2" is "Pro-L 2"), like VST3 names.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SCAN_TIMEOUT = 45000;
const PARALLEL = 4;
const VERSION = 2; // 2: VST2 and 32-bit plugins (files skipped before are scanned again)

function defaultFolders() {
  // tests: JELLY_PLUGIN_FOLDERS (separated by ; on Windows, : elsewhere) replaces the standard folders
  if (process.env.JELLY_PLUGIN_FOLDERS) return process.env.JELLY_PLUGIN_FOLDERS.split(path.delimiter).filter(Boolean);
  const home = require('node:os').homedir();
  if (process.platform === 'win32') {
    const common = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    // VST3, then the usual VST2 places (there is no single standard one)
    return [path.join(common, 'VST3'), path.join(pf, 'VSTPlugins'), path.join(pf, 'Steinberg', 'VSTPlugins'),
      path.join(common, 'VST2'), path.join(common, 'Steinberg', 'VST2')];
  }
  if (process.platform === 'darwin')
    return ['/Library/Audio/Plug-Ins/VST3', path.join(home, 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST', path.join(home, 'Library/Audio/Plug-Ins/VST')];
  return [path.join(home, '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3', path.join(home, '.vst'), '/usr/lib/vst', '/usr/local/lib/vst'];
}

const VST2_FILE = process.platform === 'win32' ? /\.dll$/i : process.platform === 'darwin' ? /\.vst$/i : /\.so$/i;
const isVst2File = (p) => !/\.vst3$/i.test(p) && VST2_FILE.test(p);

async function findBundles(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    // a plugin (bundle folder or single file): do not look inside
    if (/\.vst3$/i.test(e.name) || (isVst2File(e.name) && (e.isFile() || process.platform === 'darwin'))) out.push(p);
    else if (e.isDirectory()) await findBundles(p, depth + 1, out);
  }
  return out;
}

// the same folder written twice (case on Windows, links) is scanned once
async function realFolders(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const real = await fsp.realpath(f).catch(() => null);
    if (!real) continue;
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

// Windows: the CPU a .dll is built for, from its PE header (null when it is not a PE file)
function dllMachine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n < 64 || b.toString('ascii', 0, 2) !== 'MZ') return null;
    const pe = b.readUInt32LE(0x3c);
    if (pe + 6 > n || b.toString('ascii', pe, pe + 4) !== 'PE\0\0') return null;
    return b.readUInt16LE(pe + 4);
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}
const X86 = 0x14c;

// "FabFilter Pro-L 2" by FabFilter is "Pro-L 2"
const stripVendor = (name, vendor) => {
  const v = String(vendor || '').trim();
  return v && name.toLowerCase().startsWith(v.toLowerCase() + ' ') && name.length > v.length + 1 ? name.slice(v.length + 1) : name;
};
const vendorWord = (v) => String(v || '').trim().split(/\s+/)[0].toLowerCase();

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

  // every plugin found, VST2 copies of VST3 plugins left out
  all() {
    const out = [];
    for (const f of Object.values(this.cache.files)) if (f.plugins) out.push(...f.plugins);
    const vst3 = new Set(out.filter((p) => p.format !== 'VST2').map((p) => `${p.name.toLowerCase()}\t${vendorWord(p.vendor)}`));
    return out.filter((p) => p.format !== 'VST2' || !vst3.has(`${p.name.toLowerCase()}\t${vendorWord(p.vendor)}`))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.format === 'VST2') - (b.format === 'VST2'));
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
    // what a plugin reported while it was scanned (a 32-bit plugin's dialogs, closed by the bridge)
    const warnings = this.all().filter((p) => p.warnings?.length).map((p) => ({ name: p.name, warnings: p.warnings }));
    return { found: this.all().length, skipped, warnings, scanning: this.scanning, folders: this.folders(), defaults: defaultFolders() };
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
    // the host is 64-bit: a 32-bit plugin runs in jelly-bridge32.exe, which ships next to it
    if (process.platform === 'win32' && isVst2File(file) && dllMachine(file) === X86 &&
        !fs.existsSync(path.join(path.dirname(this.exe), 'jelly-bridge32.exe')))
      return Promise.resolve({ skipped: '32-bit plugin: jelly-bridge32.exe is missing' });
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
            // a VST2 folder also holds plain libraries: no plugin and no error is not worth a "skipped" line
            if (!r.plugins.length && isVst2File(file)) return finish({ ignored: true });
            if (!ok.length) return finish({ skipped: r.plugins[0]?.error || 'no plugin in this file' });
            return finish({ plugins: ok.map(({ error, ...p }) => (p.format === 'VST2' ? { ...p, name: stripVendor(p.name, p.vendor) } : p)) });
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
      for (const dir of await realFolders(this.folders())) await findBundles(dir, 0, files);
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
