// The rack manager: between the renderer's rack (src/vst/runtime.js) and the host's (host/src/Rack.cpp).
//
// The renderer sends the whole rack on every evaluate. Here it is
//   - resolved against the plugin scan (names -> files; unknown names stay in the rack as 'missing'),
//   - diffed by entry name against the previous one: renames are detected by plugin list and position, deleted
//     entries are kept restorable for 10 minutes,
//   - sent to the host (applyRack), with saved state only for instances the host has to create,
//   - answered with a RackStatus (CONTRACT.md).
// Plugin state lives in a `.rack` file next to the sketch: { version, entries: { name: [{ plugin, uid, state,
// base }] }, deleted: [...] }, saved a moment after changes, every 30 s and on quit. A slot that is not loaded (plugin
// missing, crashed, turned off) keeps the state it had in the file. `base` holds the values parameters return to
// when .set() automation stops, so automation never ends up in the file.
// When the host restarts, the rack is applied again from the last saved state.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const VERSION = 1;
const DELETED_TTL = 10 * 60 * 1000;
const SAVE_DELAY = 2000;
const SAVE_EVERY = 30000;

const sigOf = (plugins) => plugins.map((p) => p.name).join('|');

class RackManager extends EventEmitter {
  constructor({ host, scanner, sketchesDir }) {
    super();
    this.host = host;
    this.scanner = scanner;
    this.dir = sketchesDir;
    this.sketch = null;
    this.file = { version: VERSION, entries: {}, deleted: [] };
    this.fileText = null;
    this.spec = null; // last renderer spec applied
    this.prev = []; // [{ name, sig, index }] of the last applied entries
    this.live = new Map(); // group id -> slot plugin names the host has loaded
    this.slotStatus = new Map(); // `${group}\t${slot}` -> status
    this.status = { sketch: '', entries: [], errors: [] };
    this.restoring = new Map(); // entry name -> saved slots, for the next apply that brings the entry back
    this.quarantined = []; // { group, slot, plugin }
    this.reloading = new Set();
    this.wanted = null;
    this.running = null;
    this.saving = null;
    this.saveTimer = null;
    this.dirty = false;
    setInterval(() => this.save().catch(() => {}), SAVE_EVERY).unref();
    host.on('ready', () => this.spec && this.reapply());
    host.on('event', (m) => this.onHostEvent(m));
    host.on('quarantine', (c) => this.quarantine(c));
  }

  rackFile(name) {
    return path.join(this.dir, `${name}.rack`);
  }

  readFile(name) {
    try {
      const f = JSON.parse(fs.readFileSync(this.rackFile(name), 'utf8'));
      if (f && typeof f.entries === 'object') {
        const deleted = (Array.isArray(f.deleted) ? f.deleted : []).filter((d) => Date.now() - d.deletedAt < DELETED_TTL);
        return { version: VERSION, entries: f.entries, deleted };
      }
    } catch {}
    return { version: VERSION, entries: {}, deleted: [] };
  }

  // ---------- apply ----------
  apply(spec) {
    if (!spec || typeof spec !== 'object') return Promise.resolve(this.status);
    this.wanted = spec;
    if (!this.running) this.running = this.loop();
    return this.running.then(() => this.status);
  }

  async loop() {
    try {
      while (this.wanted) {
        const s = this.wanted;
        this.wanted = null;
        await this.applyNow(s).catch((e) => console.warn('[vst] rack', e));
      }
    } finally {
      this.running = null;
    }
  }

  reapply() {
    this.live.clear();
    return this.apply({ ...this.spec, _reset: true });
  }

  async switchSketch(name) {
    if (this.sketch != null) await this.save();
    this.sketch = name;
    this.file = this.readFile(name);
    this.fileText = null;
    this.prev = [];
    this.live.clear();
    this.slotStatus.clear();
    this.restoring.clear();
  }

  // the sketch was renamed in the app: the .rack file moved with it (main.cjs)
  renamed(from, to) {
    if (this.sketch === from) this.sketch = to;
    if (this.spec?.sketch === from) this.spec = { ...this.spec, sketch: to };
  }

  isOff(group, slot, plugin) {
    return this.quarantined.some((q) => (q.group === group && q.slot === slot) || (q.group === 'load' && q.plugin === plugin));
  }

  savedSlots(id) {
    return this.restoring.get(id) || this.file.entries[id] || [];
  }

  groupSpec(id, plugins, auto) {
    const had = this.live.get(id) || [];
    const reload = this.reloading.has(id);
    const saved = this.savedSlots(id);
    const usedSaved = new Set();
    const slots = plugins.map((p, i) => {
      const info = p.missing ? null : this.scanner.find(p.name);
      const name = info?.name ?? p.name;
      const s = { name, uid: info?.uid ?? '', path: info?.path ?? '', bypass: !!p.bypass, off: this.isOff(id, i, name), params: p.params || {} };
      if (reload || !had.includes(name)) {
        let k = saved[i]?.plugin === name && !usedSaved.has(i) ? i : saved.findIndex((x, j) => x?.plugin === name && !usedSaved.has(j));
        if (k >= 0) {
          usedSaved.add(k);
          if (saved[k].state) s.state = saved[k].state;
          if (saved[k].base) s.base = saved[k].base;
        }
      }
      return s;
    });
    return { id, slots, reload, auto: auto || [] };
  }

  detectRenames(entries) {
    const newNames = new Set(entries.map((e) => e.name));
    const oldNames = new Set(this.prev.map((e) => e.name));
    const renames = [];
    entries.forEach((e, i) => {
      if (oldNames.has(e.name)) return;
      const sig = sigOf(e.plugins);
      const cand = this.prev.filter((o) => !newNames.has(o.name) && o.sig === sig && !renames.some((r) => r.from === o.name));
      const pick = cand.find((o) => o.index === i) || (cand.length === 1 ? cand[0] : null);
      if (pick) renames.push({ from: pick.name, to: e.name });
    });
    return renames;
  }

  async applyNow(spec) {
    const reset = !!spec._reset;
    const sketch = String(spec.sketch || '');
    let switched = false;
    if (sketch !== this.sketch) {
      await this.switchSketch(sketch);
      switched = true;
    }
    const entries = Array.isArray(spec.entries) ? spec.entries : [];
    const inline = Array.isArray(spec.inline) ? spec.inline : [];
    const renames = switched || reset ? [] : this.detectRenames(entries);
    for (const r of renames) {
      if (this.file.entries[r.from]) {
        this.file.entries[r.to] = this.file.entries[r.from];
        delete this.file.entries[r.from];
      }
      if (this.live.has(r.from)) {
        this.live.set(r.to, this.live.get(r.from));
        this.live.delete(r.from);
      }
      for (const q of this.quarantined) if (q.group === r.from) q.group = r.to;
      for (const [k, v] of [...this.slotStatus]) {
        const [g, s] = k.split('\t');
        if (g === r.from) {
          this.slotStatus.delete(k);
          this.slotStatus.set(`${r.to}\t${s}`, v);
        }
      }
    }
    const auto = spec.auto || {};
    const groups = [
      ...entries.map((e) => this.groupSpec(e.name, e.plugins, auto[e.name])),
      ...inline.map((g) => this.groupSpec(g.id, g.plugins, auto[g.id])),
    ];
    const msg = { reset: reset || switched, renames, groups, nodes: spec.nodes || [], streams: spec.streams || {} };

    // show the new entries as loading while the host works
    this.spec = spec;
    this.renamedLast = renames;
    if (groups.some((g) => !this.live.has(g.id))) this.publish(null, true);

    let reply = null;
    if (this.host.ready) {
      try {
        reply = await this.host.request('applyRack', msg);
      } catch {}
    }
    for (const id of this.reloading) this.reloading.delete(id);
    if (reply?.groups) {
      // entries the code no longer has: restorable for a while
      if (!switched && !reset) {
        const renamedFrom = new Set(renames.map((r) => r.from));
        for (const [id, slots] of Object.entries(reply.removed || {})) {
          const old = this.prev.find((o) => o.name === id);
          if (!old || renamedFrom.has(id)) continue;
          const plugins = slots.map((s) => s.plugin);
          const saved = this.file.entries[id] || [];
          const keep = slots.map((s, i) => (s.state ? { plugin: s.plugin, state: s.state, base: s.base } : saved[i] || { plugin: s.plugin }));
          this.file.deleted = this.file.deleted.filter((d) => d.name !== id);
          // its neighbours in the old code, so Restore can put it back in the same place
          const at = this.prev.findIndex((o) => o.name === id);
          const after = this.prev.slice(0, at).reverse().find((o) => !reply.removed[o.name])?.name ?? null;
          const before = this.prev.slice(at + 1).find((o) => !reply.removed[o.name])?.name ?? null;
          this.file.deleted.push({ name: id, plugins, deletedAt: Date.now(), slots: keep, after, before });
          delete this.file.entries[id];
        }
      }
      this.live.clear();
      for (const [id, g] of Object.entries(reply.groups)) {
        const gs = groups.find((x) => x.id === id);
        this.live.set(id, (g.slots || []).map((s, i) => (s.status === 'loaded' || s.status === 'crashed' ? gs?.slots[i]?.name : null)).filter(Boolean));
        (g.slots || []).forEach((s, i) => this.slotStatus.set(`${id}\t${i}`, s.status));
        if (this.restoring.has(id)) this.restoring.delete(id);
      }
    }
    this.prev = entries.map((e, i) => ({ name: e.name, sig: sigOf(e.plugins), index: i }));
    this.publish(reply, false);
    this.scheduleSave();
  }

  // ---------- status ----------
  publish(reply, loading) {
    const spec = this.spec || { entries: [], inline: [], nodes: [], feeders: {} };
    const errors = [];
    const nodes = spec.nodes || [];
    const groupOfKey = new Map(nodes.map((n) => [n.key, n.group]));
    const slotInfo = (id, plugins, line) =>
      plugins.map((p, i) => {
        const info = p.missing ? null : this.scanner.find(p.name);
        const r = reply?.groups?.[id]?.slots?.[i];
        let status = r?.status || (loading && !this.live.has(id) ? 'loading' : this.slotStatus.get(`${id}\t${i}`) || 'loading');
        if (!info) status = 'missing';
        const where = p.line ?? line;
        if (!info) errors.push({ line: where, message: `"${p.name}" is not an installed plugin` });
        else if (r?.error) errors.push({ line: where, message: r.error });
        for (const e of r?.paramErrors || []) errors.push({ line: where, message: e });
        return { plugin: info?.name ?? p.name, slot: i, bypass: !!p.bypass, status };
      });
    const entries = (spec.entries || []).map((e) => {
      const chain = slotInfo(e.name, e.plugins, e.line);
      const first = e.plugins[0] && !e.plugins[0].missing ? this.scanner.find(e.plugins[0].name) : null;
      const kind = reply?.groups?.[e.name]?.synth ? 'synth' : first?.kind || e.kind || 'effect';
      return {
        name: e.name,
        line: e.line,
        kind,
        chain,
        next: e.next ?? null,
        routes: nodes.filter((n) => n.group === e.name).map((n) => ({ to: n.next ? groupOfKey.get(n.next) ?? null : null })),
        feeders: (spec.feeders?.[e.name] || []).filter((f) => f.line != null),
      };
    });
    for (const g of spec.inline || []) slotInfo(g.id, g.plugins, g.line);
    // parameters named in .set() that the entry's plugins do not have
    for (const [entry, keys] of Object.entries(spec.auto || {})) {
      const e = (spec.entries || []).find((x) => x.name === entry);
      if (!e) continue;
      const all = e.plugins.flatMap((p) => this.scanner.params(p.name));
      if (!all.length) continue;
      for (const k of keys)
        if (!all.some((m) => m.key === k || m.name === k || m.name.toLowerCase() === String(k).toLowerCase()))
          errors.push({ line: spec.autoLines?.[`${entry}\t${k}`] ?? e.line, message: `.set("${entry}"): ${e.plugins.map((p) => p.name).join(', ')} has no parameter "${k}"` });
    }
    this.status = { sketch: this.sketch || '', entries, errors };
    if (this.renamedLast?.length) this.status.renamed = this.renamedLast;
    this.emit('rack', this.status);
  }

  // ---------- host events ----------
  onHostEvent(m) {
    if (m.event === 'param') {
      this.emit('param', { entry: m.group, slot: m.slot, key: m.key, value: m.value, text: m.text, gesture: m.gesture });
      if (m.gesture === 'end') this.scheduleSave();
    } else if (m.event === 'meters') {
      const names = new Set((this.spec?.entries || []).map((e) => e.name));
      const out = {};
      for (const [k, v] of Object.entries(m.m || {})) if (names.has(k)) out[k] = v;
      this.emit('meters', out);
    } else if (m.event === 'crashed') {
      this.slotStatus.set(`${m.group}\t${m.slot}`, 'crashed');
      this.publish(null, false);
    }
  }

  // the host kept crashing in this plugin: turn it off until reload()
  quarantine(label) {
    let [group, slot, plugin] = String(label).split('\t');
    if (!plugin) return null;
    if (group === 'scan') group = 'load'; // crashed while opening the file: every use of the plugin is off
    this.quarantined.push({ group, slot: Number(slot) || 0, plugin });
    if (group !== 'load') this.slotStatus.set(`${group}\t${slot}`, 'crashed');
    return plugin;
  }

  reload(entry) {
    this.quarantined = this.quarantined.filter((q) => q.group !== entry && !(q.group === 'load' && this.entryPlugins(entry).includes(q.plugin)));
    this.reloading.add(entry);
    if (this.spec) return this.apply({ ...this.spec, _reset: false });
  }

  entryPlugins(entry) {
    const e = (this.spec?.entries || []).find((x) => x.name === entry) || (this.spec?.inline || []).find((x) => x.id === entry);
    return e ? e.plugins.map((p) => p.name) : [];
  }

  deleted() {
    const now = Date.now();
    this.file.deleted = this.file.deleted.filter((d) => now - d.deletedAt < DELETED_TTL);
    return this.file.deleted.map(({ name, plugins, deletedAt, after, before }) => ({ name, plugins, deletedAt, after: after ?? null, before: before ?? null }));
  }

  // the next apply that has an entry by this name gets the deleted entry's state back
  restore(name) {
    this.deleted();
    const d = this.file.deleted.find((x) => x.name === name);
    if (!d) return null;
    this.file.deleted = this.file.deleted.filter((x) => x !== d);
    this.restoring.set(name, d.slots);
    this.file.entries[name] = d.slots;
    this.scheduleSave();
    return { name, plugins: d.plugins };
  }

  // ---------- saving ----------
  scheduleSave() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(() => {}), SAVE_DELAY);
  }

  save() {
    // one at a time; a save asked for during one runs after it
    const run = async () => {
      if (!this.sketch || !this.spec) return;
      let states = {};
      if (this.host.ready) {
        try {
          states = (await this.host.request('getState', {})) || {};
        } catch {}
      }
      const entries = {};
      const groups = [...(this.spec.entries || []).map((e) => [e.name, e.plugins]), ...(this.spec.inline || []).map((g) => [g.id, g.plugins])];
      for (const [id, plugins] of groups) {
        const st = Array.isArray(states[id]) ? states[id] : [];
        const old = this.file.entries[id] || [];
        entries[id] = plugins.map((p, i) => {
          const info = p.missing ? null : this.scanner.find(p.name);
          const name = info?.name ?? p.name;
          const cur = st[i];
          if (cur?.state) {
            const out = { plugin: name, uid: info?.uid ?? '', state: cur.state };
            if (cur.base && Object.keys(cur.base).length) out.base = cur.base;
            return out;
          }
          // not loaded (missing, crashed, off, engine down): keep what the file had
          const prev = old[i]?.plugin === name ? old[i] : old.find((o) => o?.plugin === name);
          return prev || { plugin: name, uid: info?.uid ?? '' };
        });
      }
      // a missing plugin's entry that the code dropped keeps its state too
      for (const [id, slots] of Object.entries(this.file.entries))
        if (!entries[id] && !id.startsWith('inline:') && slots.some((s) => s?.state) && !this.file.deleted.some((d) => d.name === id) &&
          slots.some((s) => !this.scanner.find(s.plugin))) entries[id] = slots;
      this.file.entries = entries;
      this.deleted();
      const text = JSON.stringify({ version: VERSION, entries, deleted: this.file.deleted });
      const file = this.rackFile(this.sketch);
      if (text === this.fileText) return;
      if (!Object.keys(entries).length && !this.file.deleted.length && !fs.existsSync(file)) {
        this.fileText = text;
        return;
      }
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `.${this.sketch}.rack.${process.pid}.tmp`);
      await fsp.writeFile(tmp, text);
      await fsp.rename(tmp, file);
      this.fileText = text;
      this.dirty = false;
    };
    this.saving = (this.saving || Promise.resolve()).then(run, run);
    return this.saving;
  }

  // ---------- queries ----------
  async paramValues(entry, slot) {
    if (!this.host.ready) return {};
    try {
      return (await this.host.request('paramValues', { group: String(entry), slot: Number(slot) || 0 })) || {};
    } catch {
      return {};
    }
  }

  async openEditor(entry, slot) {
    if (!this.host.ready) return 'the audio engine is not running';
    try {
      const r = await this.host.request('openEditor', { group: String(entry), slot: Number(slot) || 0 });
      return r?.error || null;
    } catch (e) {
      return e.message;
    }
  }
}

module.exports = { RackManager };
