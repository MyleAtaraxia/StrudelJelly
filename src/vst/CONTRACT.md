# VST interface contract

This file is shared by the **engine** work (host, Electron bridge, Strudel runtime) and the **UI** work (editor features, Mixer pane, Settings). Both sides code against it. Design source: `vst-plan.md` at the repo root.

## Ownership (files each side may edit)

| Side | Owns |
| -- | -- |
| Engine | `host/**` (C++ JUCE host, CMake), `electron/main.cjs`, `electron/preload.cjs`, `electron/vst/**`, `src/strudel.js`, `src/vst/runtime.js`, `src/vst/engine/**`, `package.json` build scripts, `vite.config.js` |
| UI | `src/vst/ui/**` (editor extensions, hover card, pills, autocomplete), `src/vst/rack-source.js`, `src/mixer/**`, `src/main.js`, `index.html`, `src/style.css`, `src/docs/**`, `src/vst/mock.js` |

Edits outside your column go through the integrator (the main session), not directly.

## Preload API: `window.jelly.vst`

All calls return promises. Events take a listener and return an unsubscribe function.

```ts
type EngineState = 'starting' | 'ready' | 'restarting' | 'down';
status(): { state: EngineState, cpu: number /* 0..1 */, sampleRate: number, blockSize: number, latencyMs: number, error?: string }
onStatus(fn: (s) => void): () => void
onBanner(fn: (b: { kind: 'restarted' | 'quarantined', text: string }) => void): () => void

// plugin catalogue (from the scan cache)
plugins(): Array<{ uid: string, name: string, vendor: string, kind: 'synth' | 'effect', format: 'VST3' | 'VST2', path: string }>   // VST2 copies of VST3 plugins are left out
scanInfo(): { found: number, skipped: Array<{ path: string, reason: string }>, warnings: Array<{ name: string, warnings: string[] }>, scanning: boolean, folders: string[], defaults: string[] /* the standard folders */ }
rescan(): void
onScan(fn: (info) => void): () => void
setFolders(folders: string[]): void
params(pluginName: string): Array<{ index: number, key: string /* camelCase */, name: string, min: number, max: number,
  def: number, unit: string, steps: number /* 0 = continuous */, choices?: string[] }>

// a live entry's plugins
paramValues(entry: string, slot: number): Record<string /* key */, { value: number, text: string }>
onParamChange(fn: (e: { entry: string, slot: number, key: string, value: number, text: string,
  gesture: 'begin' | 'change' | 'end' }) => void): () => void
openEditor(entry: string, slot: number): void
saveState(): void            // write the current sketch's .rack now
reload(entry: string): void  // reload a crashed entry

// rack status, sent after every applied rack and on crash/missing changes
onRack(fn: (r: RackStatus) => void): () => void
rackStatus(): RackStatus
deleted(): Array<{ name: string, plugins: string[], deletedAt: number, after: string | null, before: string | null }>   // restorable for 10 minutes; after/before = its neighbours when deleted
restore(name: string): { name: string, plugins: string[] } | null  // the next evaluate that has this entry gets its state back

// meters, ~20 Hz: peak per entry copy summed per entry, 0..1 linear (rack entries only)
onMeters(fn: (m: Record<string /* entry */, [number, number]>) => void): () => void

// _scope() / _spectrum() on plugin audio (src/vst/scope.js): name the node keys to tap and how many samples each
// snapshot holds; the host then sends the latest mono samples of each, ~20 Hz, as base64 16-bit little-endian
_scopes(keys: Record<string /* node key */, number>): void
onScope(fn: (s: { key: string, data: string }) => void): () => void

// audio export (src/record.js), faster than real time: superdough's sounds are rendered offline first, one buffer
// per capture stream (index 0 = the main mix); events are the timed events the app would send, in frames from the
// start of the export. The host runs the rack over them as fast as the CPU allows (the sound card plays silence
// meanwhile), asks where to save the WAV (named after `name`) and resolves to the path, or null if not saved.
// renderCancel makes a running render reject with 'cancelled'.
render(job: { srcRate: number, frames: number, streams: Array<{ index: number, l: Float32Array, r: Float32Array }>, events: any[] }, name: string): string | null
renderCancel(): void
onRenderProgress(fn: (p: number /* 0..1 */) => void): () => void

// audio settings
audioDevices(): { drivers: string[], devices: Record<string /* driver */, string[]> }
audioSettings(): { driver: string, device: string, buffer: number }
setAudio(s: Partial<{ driver: string, device: string, buffer: number }>): void
```

```ts
type RackStatus = {
  sketch: string,
  entries: Array<{
    name: string,
    line?: number,                       // 1-based line of the entry in the sketch code, when known
    kind: 'synth' | 'effect',            // first plugin's kind
    chain: Array<{ plugin: string, slot: number, bypass: boolean,
                   status: 'loaded' | 'loading' | 'missing' | 'crashed' }>,
    next: string | null,                 // default route (entry name), null = speakers
    routes: Array<{ to: string | null }>,// one per live copy
    feeders: Array<{ label: string, line: number }>,   // patterns feeding this entry
  }>,
  errors: Array<{ line?: number, message: string }>,
  renamed?: Array<{ from: string, to: string }>,
}
```

## Strudel runtime: `src/vst/runtime.js` (engine)

Registers in the eval scope: `rack(spec)`, `vst(name, params?)`, `Pattern.prototype.fx(target)`, `Pattern.prototype.set(entry, params)`, and makes `.s("entry")` play rack synths. Semantics are in `vst-plan.md`.

Exports for the UI:

```ts
lastRack(): RackStatus | null          // same as window.jelly.vst.rackStatus(), cached in the renderer
onRack(fn): () => void
paramDiffs(entry: string, slot: number): Array<{ key: string, code: number | string, plugin: number | string }>
```

### Engine notes

- **Plugin names** are the VST3 / VST2 names without the vendor (`"One"`, `"Pro-L 2"`, as `plugins()` lists them). `vst()` and `params()` also accept the vendor in front (`"FabFilter One"`) and ignore case. RackStatus `chain[].plugin` is the listed name.
- **Inline chains** (`.fx(vst(...))`, `.fx([...])`) are groups named `inline:<plugin+plugin>:<k>` (k counts chains with the same plugins in code order). `openEditor`, `paramValues` and `reload` take that name like an entry name; RackStatus `entries` and `onMeters` list rack entries only.
- `renamed` is set only on the status of the evaluate that did the rename; listen with `onRack`.
- `.set("entry", { ... })` is recognised when written in that form (a string and an object literal); the transpiler pass turns it into `.$st(...)`. Any other `.set(...)` is Strudel's own. Its values are never saved: the `.rack` file keeps the value each parameter returns to (`base`).
- `.cc(n, v)` sends a MIDI CC to a synth entry (`v` 0..1 is scaled to 0..127). A hap with a CC and no note sends only the CC.
- `openEditor` errors (entry not loaded, crashed) go to the console; the call resolves either way.
- Engine internals on `window.jelly.vst` (not for the UI): `_apply(spec)`, `_events(list)`, `_debug(cmd, args)` (tests, needs `JELLY_HOST_DEBUG=1`), `_openCapture`, `_stats`, `_setStreamLatency`.
- `paramDiffs(entry, slot)` compares the values written in code with the last value each knob reported through `onParamChange` (natural units, or text for choices).

## Rack source helpers: `src/vst/rack-source.js` (UI)

Reads and rewrites the `rack({...})` block through the CodeMirror syntax tree. The Mixer pane, the bypass dot, "Update code" and "Plugin knobs update code" all go through it, and every change is a single editor transaction (one undo step).

```ts
findRack(state): { from, to, entries: Array<{ name, from, to, plugins: Array<{ name, from, to, params: Record<string, { from, to, text }> }>, next?: string }> } | null
addPlugin(view, entry, pluginName, atSlot?)
removePlugin(view, entry, slot)
movePlugin(view, entry, fromSlot, toSlot)
setParam(view, entry, slot, key, valueText)   // inserts or replaces; removes when valueText is null
addEntry(view, name, pluginName)
renameEntry(view, from, to)                    // also renames .s("x") / .fx("x") / .set("x") uses
```

## Mock: `src/vst/mock.js` (UI)

Installs a fake `window.jelly.vst` when the real one is missing or `localStorage.vstMock === '1'`: a few fake plugins (synth and effect), statuses derived from a naive parse of the code's `rack({...})`, random meters, and fake parameter lists. It lets the UI be built and tested before the engine exists. The real engine must make it unnecessary.
