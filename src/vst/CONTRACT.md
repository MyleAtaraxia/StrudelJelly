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
plugins(): Array<{ uid: string, name: string, vendor: string, kind: 'synth' | 'effect', format: 'VST3', path: string }>
scanInfo(): { found: number, skipped: Array<{ path: string, reason: string }>, scanning: boolean, folders: string[] }
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
deleted(): Array<{ name: string, plugins: string[], deletedAt: number }>   // restorable for 10 minutes
restore(name: string): void

// meters, ~20 Hz: peak per entry copy summed per entry, 0..1 linear
onMeters(fn: (m: Record<string /* entry */, [number, number]>) => void): () => void

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
