// Starts jelly-host, keeps it running and bridges it to the renderer (window.jelly.vst in preload.cjs).
// Audio from the capture worklet arrives on a MessagePort (see 'vst:capture') already framed, and goes straight to
// the host's stdin. If the host is missing or keeps crashing, state is 'down' and the renderer plays through
// Chromium as before.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { encodeJson, Decoder } = require('./protocol.cjs');
const { Scanner } = require('./scanner.cjs');
const { RackManager } = require('./rack.cjs');

const EXE = process.platform === 'win32' ? 'jelly-host.exe' : 'jelly-host';
const HELLO_TIMEOUT = 5000;
const CRASH_WINDOW = 60000;
const MAX_CRASHES = 3; // in CRASH_WINDOW: the plugin that was running is turned off, or if none is known, give up ('down')
const MAX_QUEUED = 1 << 20; // bytes waiting for the host's stdin before audio is dropped

class Host extends EventEmitter {
  constructor({ exe, settingsFile }) {
    super();
    this.exe = exe;
    this.settingsFile = settingsFile;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.crashes = [];
    this.stopping = false;
    this.ready = false;
    this.stats = null;
    this.dropped = 0;
    this.settings = this.loadSettings();
    this.state = { state: 'starting', cpu: 0, sampleRate: 0, blockSize: 0, latencyMs: 0 };
  }

  loadSettings() {
    try {
      return { driver: '', device: '', buffer: 0, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      return { driver: '', device: '', buffer: 0 };
    }
  }

  saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch {}
  }

  setState(patch) {
    const next = { ...this.state, ...patch };
    if (patch.error === undefined && 'error' in patch) delete next.error;
    this.state = next;
    this.emit('status', next);
  }

  start() {
    this.stopping = false;
    if (!fs.existsSync(this.exe)) {
      this.setState({ state: 'down', error: `audio engine not found: ${this.exe}` });
      return;
    }
    let proc;
    try {
      proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.setState({ state: 'down', error: `audio engine failed to start: ${e.message}` });
      return;
    }
    this.proc = proc;
    this.ready = false;
    let stderr = '';
    const decoder = new Decoder((m) => this.onMessage(m));
    proc.stdout.on('data', (d) => decoder.feed(d));
    let culprit = null; // what was running when the host faulted (host/src/platform_win.cpp)
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
      const m = /JELLY-CRASH-IN: ([^\r\n]*)/.exec(stderr);
      if (m) culprit = m[1];
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => {
      stderr += e.message;
      // a process that never started emits no 'exit'
      if (proc.pid === undefined) proc.emit('exit', null, null);
    });
    const helloTimer = setTimeout(() => {
      if (!this.ready && this.proc === proc) {
        stderr += 'no reply from the audio engine';
        proc.kill();
      }
    }, HELLO_TIMEOUT);
    proc.on('exit', (code, signal) => {
      clearTimeout(helloTimer);
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(new Error('audio engine exited'));
      this.pending.clear();
      if (this.stopping) return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW), now];
      const why = `audio engine exited (${signal || 'code ' + code})${stderr.trim() ? ': ' + stderr.trim().slice(-300) : ''}`;
      if (culprit && culprit.includes('\t')) this.lastCulprit = culprit;
      if (this.crashes.length >= MAX_CRASHES && this.lastCulprit) {
        const label = this.lastCulprit;
        this.lastCulprit = null;
        this.crashes = [];
        const plugin = this.quarantineHandler?.(label) || label.split('\t')[2];
        this.pendingBanner = { kind: 'quarantined', text: `${plugin} kept crashing the audio engine and was turned off. Reload it to try again.` };
      } else if (this.crashes.length >= MAX_CRASHES) {
        this.setState({ state: 'down', error: why, cpu: 0 });
        return;
      }
      this.setState({ state: 'restarting', error: why });
      setTimeout(() => this.start(), 500);
    });
  }

  async onHello() {
    try {
      const r = await this.request('setAudio', this.settings);
      this.ready = true;
      const wasRestart = this.state.state === 'restarting';
      this.setState({ state: 'ready', error: r.error || undefined });
      if (wasRestart) this.emit('banner', { kind: 'restarted', text: 'The audio engine stopped and was restarted. Plugins were reloaded from their last saved state.' });
      if (this.pendingBanner) this.emit('banner', this.pendingBanner);
      this.pendingBanner = null;
      this.emit('ready', { restarted: wasRestart });
    } catch (e) {
      this.proc?.kill();
    }
  }

  onMessage(m) {
    if (m.id != null) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.resolve({ ...(m.result && typeof m.result === 'object' ? m.result : {}), error: m.error });
      return;
    }
    if (m.event === 'hello') this.onHello();
    else if (m.event === 'stats') {
      this.stats = { ...m, dropped: this.dropped, at: Date.now() };
      if (!this.ready) return;
      this.setState({ cpu: m.cpu, sampleRate: m.sampleRate, blockSize: m.blockSize, latencyMs: Math.round(m.latencyMs * 10) / 10 });
    } else if (m.event === 'audio') this.emit('audio', m.settings);
    else if (m.event === 'param' || m.event === 'meters' || m.event === 'crashed') this.emit('event', m);
    else if (m.event === 'scope') this.emit('scope', m);
  }

  request(cmd, args = {}) {
    if (!this.proc) return Promise.reject(new Error('audio engine is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(encodeJson({ ...args, id, cmd }));
    });
  }

  // timed events for the rack (MIDI, parameter values, panic): [[copyKey | entry, type, frame, ...], ...]
  sendEvents(list) {
    const stdin = this.ready && this.proc?.stdin;
    if (!stdin || !Array.isArray(list) || !list.length) return;
    stdin.write(encodeJson({ cmd: 'ev', e: list }));
  }

  // one or more ready-made AUDIO frames
  sendAudio(buf) {
    const stdin = this.ready && this.proc?.stdin;
    if (!stdin || stdin.writableLength > MAX_QUEUED) {
      this.dropped++;
      return;
    }
    stdin.write(buf);
  }

  async setAudio(patch) {
    for (const k of ['driver', 'device', 'buffer']) if (patch?.[k] !== undefined) this.settings[k] = patch[k];
    this.saveSettings();
    if (!this.ready) return this.settings;
    const r = await this.request('setAudio', this.settings);
    this.setState({ error: r.error || undefined });
    return r;
  }

  stop() {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.write(encodeJson({ cmd: 'quit' }));
      proc.stdin.end();
    } catch {}
    setTimeout(() => proc.exitCode === null && proc.kill(), 1000).unref();
  }
}

const toBuffer = (d) =>
  Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null;

// Wires the host into the app. getWin returns the main window (for pushing events).
function setupVst({ app, ipcMain, getWin, sketchesDir }) {
  const exe =
    process.env.JELLY_HOST ||
    (app.isPackaged ? path.join(process.resourcesPath, 'host', EXE) : path.join(__dirname, '..', '..', 'host', 'bin', EXE));
  const host = new Host({ exe, settingsFile: path.join(app.getPath('userData'), 'vst-audio.json') });
  const send = (ch, v) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(ch, v);
  };
  host.on('status', (s) => send('vst:status', s));
  host.on('banner', (b) => send('vst:banner', b));

  const scanner = new Scanner({ exe, cacheFile: path.join(app.getPath('userData'), 'vst-plugins.json') });
  const racks = new RackManager({ host, scanner, sketchesDir });
  host.quarantineHandler = (label) => racks.quarantine(label);
  scanner.on('scan', (info) => send('vst:scan', info));
  scanner.on('changed', () => racks.spec && racks.apply({ ...racks.spec, _reset: false }));
  racks.on('rack', (r) => send('vst:rack', r));
  racks.on('param', (e) => send('vst:paramChange', e));
  racks.on('meters', (m) => send('vst:meters', m));
  // _scope() on plugin audio: the renderer names the nodes it draws, the host streams their latest samples
  let scopes = {};
  const sendScopes = () => host.ready && host.request('scope', { keys: scopes }).catch(() => {});
  host.on('ready', sendScopes);
  host.on('scope', (m) => send('vst:scope', { key: m.key, data: m.data }));
  ipcMain.on('vst:scopes', (_, keys) => {
    scopes = keys && typeof keys === 'object' ? keys : {};
    sendScopes();
  });

  ipcMain.handle('vst:plugins', () => scanner.plugins());
  ipcMain.handle('vst:scanInfo', () => scanner.info());
  ipcMain.handle('vst:rescan', () => {
    scanner.scan(true);
  });
  ipcMain.handle('vst:setFolders', (_, folders) => {
    scanner.setFolders(folders);
  });
  ipcMain.handle('vst:params', (_, name) => scanner.params(String(name)));
  ipcMain.handle('vst:paramValues', (_, entry, slot) => racks.paramValues(entry, slot));
  ipcMain.handle('vst:openEditor', async (_, entry, slot) => {
    const err = await racks.openEditor(entry, slot);
    if (err) console.warn('[vst] openEditor:', err);
  });
  ipcMain.handle('vst:saveState', () => racks.save().then(() => {}));
  ipcMain.handle('vst:reload', (_, entry) => racks.reload(String(entry)));
  ipcMain.handle('vst:rackStatus', () => racks.status);
  ipcMain.handle('vst:deleted', () => racks.deleted());
  ipcMain.handle('vst:restore', (_, name) => racks.restore(String(name)));
  ipcMain.handle('vst:apply', (_, spec) => racks.apply(spec));
  ipcMain.on('vst:events', (_, list) => host.sendEvents(list));
  // tests only: the host answers these when started with JELLY_HOST_DEBUG=1 (debugCrash, debugRecord, debugRecordGet)
  ipcMain.handle('vst:debug', (_, cmd, args) =>
    /^debug[A-Z]\w*$/.test(String(cmd)) ? host.request(String(cmd), args && typeof args === 'object' ? args : {}).catch((e) => ({ error: e.message })) : null);

  ipcMain.handle('vst:status', () => host.state);
  ipcMain.handle('vst:stats', () => host.stats); // raw engine stats, for diagnostics and tests
  ipcMain.handle('vst:audioDevices', async () => {
    try {
      return await host.request('audioDevices');
    } catch {
      return { drivers: [], devices: {} };
    }
  });
  ipcMain.handle('vst:audioSettings', async () => {
    try {
      const r = await host.request('audioSettings');
      return { driver: r.driver, device: r.device, buffer: r.buffer };
    } catch {
      const { driver, device, buffer } = host.settings;
      return { driver, device, buffer };
    }
  });
  ipcMain.handle('vst:setAudio', async (_, s) => {
    await host.setAudio(s && typeof s === 'object' ? s : {});
  });
  ipcMain.handle('vst:setStreamLatency', (_, ms) => host.request('setStreamLatency', { ms: Number(ms) }).catch(() => false));
  // the capture worklet's port: every message is an ArrayBuffer of AUDIO frames
  ipcMain.on('vst:capture', (e) => {
    const port = e.ports[0];
    if (!port) return;
    port.on('message', (m) => {
      const buf = toBuffer(m.data);
      if (buf) host.sendAudio(buf);
    });
    port.start();
  });

  host.start();
  scanner.scan().catch((e) => console.warn('[vst] scan', e));
  // save the rack before the host goes away
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    const done = () => app.quit();
    Promise.race([racks.save().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]).then(done, done);
  });
  app.on('will-quit', () => host.stop());
  return { host, scanner, racks };
}

module.exports = { setupVst, Host };
