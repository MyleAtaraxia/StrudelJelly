import * as core from '@strudel/core';
import { evalScope, noteToMidi, valueToMidi, Pattern, silence, repl, setTime, setCpsFunc, setTriggerFunc, getTriggerFunc, setIsStarted, setPattern as exposePattern } from '@strudel/core';
import { aliasBank, registerSynthSounds, registerZZFXSounds, samples, getAudioContext, webaudioOutput, initAudioOnFirstClick, soundMap, superdough } from '@strudel/webaudio';
import { StrudelMirror, themes, settings as themeSettings } from '@strudel/codemirror';
import { transpiler } from '@strudel/transpiler';
import { getDrawContext } from '@strudel/draw';
import { EditorView, Decoration, gutter, GutterMarker, drawSelection, keymap } from '@codemirror/view';
import { selectNextOccurrence } from '@codemirror/search';
import { EditorState, StateField, StateEffect, RangeSet, Prec } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import gm from '@strudel/soundfonts/gm.mjs';
import { installCapture } from './vst/engine/capture.js';

const DS = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const TS = 'https://raw.githubusercontent.com/todepond/samples/main';
const TC = 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main';
const BUILTIN_MAPS = [
  `${DS}/tidal-drum-machines.json`,
  `${DS}/piano.json`,
  `${DS}/Dirt-Samples.json`,
  `${DS}/vcsl.json`,
  `${DS}/mridangam.json`,
  `${TC}/strudel.json`,
];
const SOUNDFONT_URL = 'https://felixroos.github.io/webaudiofontdata/sound';

function jellyTheme(dark) {
  const c = dark
    ? { fg: '#FFF4E6', soft: '#C4B6BC', fn: '#D3C4F3', str: '#C3E5B5', num: '#FBE4A4', prop: '#F6B8C1', kw: '#B9D6F5', line: '#2C2330', sel: '#463A4C' }
    : { fg: '#5C4037', soft: '#9A7E72', fn: '#7556B8', str: '#3F7A2E', num: '#A8651A', prop: '#B4475A', kw: '#2F6BA8', line: '#FBE4E6', sel: '#F6D3D9' };
  const settings = {
    background: 'transparent', lineBackground: 'transparent', foreground: c.fg, caret: c.fg,
    selection: c.sel, selectionMatch: c.sel, gutterBackground: 'transparent', gutterForeground: c.soft,
    gutterBorder: 'transparent', lineHighlight: c.line, light: !dark,
  };
  const view = EditorView.theme(
    {
      '&': { color: c.fg, backgroundColor: 'transparent' },
      '.cm-gutters': { backgroundColor: 'transparent', color: c.soft, border: 'none' },
      '.cm-content': { caretColor: c.fg },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.fg, borderLeftWidth: '2.5px' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: c.line + '99', borderRadius: '8px' },
      '&.cm-focused .cm-selectionBackground, & .cm-line::selection, & .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection':
        { background: c.sel + ' !important' },
    },
    { dark },
  );
  const hl = HighlightStyle.define([
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.url, t.processingInstruction], color: c.fn, fontWeight: '700' },
    { tag: t.comment, color: c.soft, fontStyle: 'italic' },
    { tag: [t.variableName, t.propertyName, t.labelName], color: c.prop },
    { tag: [t.attributeName, t.number, t.bool], color: c.num },
    { tag: [t.keyword, t.operator], color: c.kw },
    { tag: [t.string, t.regexp, t.special(t.propertyName)], color: c.str },
  ]);
  return { ext: [view, syntaxHighlighting(hl)], settings };
}

for (const [name, dark] of [['jellyLight', false], ['jellyDark', true]]) {
  const th = jellyTheme(dark);
  themes[name] = th.ext;
  themeSettings[name] = th.settings;
}

const maxPan = noteToMidi('C8');
const panwidth = (pan, width) => pan * width + (1 - width) / 2;
Pattern.prototype.piano = function () {
  return this.fmap((v) => ({ ...v, clip: v.clip ?? 1 }))
    .s('piano')
    .release(0.1)
    .fmap((value) => {
      const midi = valueToMidi(value);
      const pan = panwidth(Math.min(Math.round(midi) / maxPan, 1), 0.5);
      return { ...value, pan: (value.pan || 1) * pan };
    });
};

export async function loadLibrary() {
  const { _base, ...map } = await fetch('/library.json').then((r) => r.json());
  for (const [key, v] of Object.entries(soundMap.get())) {
    if (v?.data?.tag === 'mine' && !(key in map)) soundMap.setKey(key, undefined);
  }
  await samples(map, _base, { tag: 'mine' });
}

async function prebake() {
  await Promise.all([
    evalScope(
      core,
      import('@strudel/draw'),
      import('@strudel/mini'),
      import('@strudel/tonal'),
      import('@strudel/webaudio'),
      import('@strudel/codemirror'),
      import('@strudel/hydra'),
      import('@strudel/soundfonts'),
      import('@strudel/midi'),
    ),
    registerSynthSounds(),
    registerZZFXSounds(),
    import('@strudel/soundfonts').then(({ registerSoundfonts }) => registerSoundfonts()),
    ...BUILTIN_MAPS.map((m) => samples(m).catch((e) => console.warn('could not load', m, e))),
  ]);
  await aliasBank(`${TS}/tidal-drum-machines-alias.json`).catch(() => {});
  await loadLibrary().catch((e) => console.warn('library', e));
}

// One update listener feeds every onDocChange subscriber. It is part of the base extensions, so it survives
// openDoc() swapping in a fresh EditorState for another sketch.
const docListeners = new Set();
const selListeners = new Set();
const docListenerExt = EditorView.updateListener.of((v) => {
  if (v.docChanged) docListeners.forEach((fn) => fn(v));
  if (v.docChanged || v.selectionSet) selListeners.forEach((fn) => fn(v));
});
let baseExtensions = null;

// Gutter bars that colour each `$:` block like its notes in the piano roll.
const setPatternMarksEffect = StateEffect.define();
class PatternMark extends GutterMarker {
  constructor(color, first, last) {
    super();
    this.color = color;
    this.first = first;
    this.last = last;
  }
  eq(o) {
    return o.color === this.color && o.first === this.first && o.last === this.last;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-pat-mark' + (this.first ? ' first' : '') + (this.last ? ' last' : '');
    el.style.background = `var(${this.color})`;
    return el;
  }
}
const patternMarks = StateField.define({
  create: () => RangeSet.empty,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) if (e.is(setPatternMarksEffect)) marks = e.value;
    return marks;
  },
});
// The code behind a hovered piano-roll note.
const setSourceHighlight = StateEffect.define();
const sourceMark = Decoration.mark({ class: 'cm-src-hover' });
const sourceHighlight = StateField.define({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) if (e.is(setSourceHighlight)) decos = e.value;
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const sourceExtensions = [patternMarks, gutter({ class: 'cm-pat-gutter', markers: (v) => v.state.field(patternMarks) }), sourceHighlight];
// Multiple cursors: Ctrl+click adds one, Alt+drag makes a column of them, Ctrl+Alt+Up/Down adds one above/below,
// Ctrl+D selects the next match. drawSelection is needed to show more than one cursor (Strudel's setup leaves it out).
const multiCursorExtensions = [drawSelection(), Prec.high(keymap.of([{ key: 'Mod-d', run: selectNextOccurrence, preventDefault: true }]))];
const BASE_SETTINGS = {
  fontFamily: '"Cascadia Code", Consolas, monospace',
  isTooltipEnabled: false, // replaced by the Docs hover card (src/docs)
  isFlashEnabled: true,
  isBracketMatchingEnabled: true,
  isBracketClosingEnabled: true,
  isActiveLineHighlighted: true,
  isTabIndentationEnabled: true, // Tab indents; Esc then Tab leaves the editor
  isMultiCursorEnabled: true,
};

export function createEditor({ root, initialCode, onUpdateState, onEvalError, onEval, onFrame, settings }) {
  initAudioOnFirstClick();
  // play through jelly-host when it runs (falls back to Chromium's output on its own)
  installCapture().catch((e) => console.warn('[vst] capture', e));
  // StrudelMirror builds its EditorState internally; borrow its extension list so every sketch can get its own
  // state (and so its own undo history) with exactly the same setup.
  const create = EditorState.create;
  EditorState.create = (config = {}) => {
    if (!baseExtensions) {
      baseExtensions = [config.extensions ?? [], docListenerExt, sourceExtensions, multiCursorExtensions];
      config = { ...config, extensions: baseExtensions };
    }
    return create.call(EditorState, config);
  };
  let editor;
  try {
    editor = new StrudelMirror({
    defaultOutput: webaudioOutput,
    getTime: () => getAudioContext().currentTime,
    transpiler,
    root,
    initialCode,
    pattern: silence,
    drawTime: [-2, 2],
    drawContext: getDrawContext(),
    prebake,
    bgFill: false,
    onUpdateState,
    // the default painter loop (user .onPaint / punchcard calls draw to #test-canvas), plus a per-frame tick for the visual strip
    onDraw: (haps, time, painters) => {
      painters?.forEach((painter) => painter(editor.drawContext, time, haps, editor.drawTime));
      onFrame?.();
    },
    afterEval: (options) => {
      onEvalError?.(null);
      onEval?.(options?.code);
    },
    onEvalError: (err) => onEvalError?.(err),
  });
  } finally {
    EditorState.create = create;
  }
  editor.updateSettings({ ...BASE_SETTINGS, ...settings });
  return editor;
}

// Show another sketch. Each sketch keeps its own EditorState (text, cursor, undo history) in `cached`; a cached state
// is reused only if it still matches the file. Settings are re-applied because they may have changed meanwhile.
export function openDoc(editor, code, cached, settings) {
  const state = cached && cached.doc.toString() === code ? cached : EditorState.create({ doc: code, extensions: baseExtensions });
  editor.editor.setState(state);
  editor.code = code;
  editor.repl.setCode?.(code);
  editor.updateSettings({ ...BASE_SETTINGS, ...settings });
  editor.editor.dispatch({ scrollIntoView: true });
}

// Colour bars in the gutter: blocks = [{ fromLine, toLine, color: '--j-token' }]. Pass [] to clear.
export function setPatternMarks(editor, blocks) {
  const doc = editor.editor.state.doc;
  const marks = [];
  for (const b of blocks) {
    const to = Math.min(b.toLine, doc.lines);
    for (let n = b.fromLine; n <= to; n++) marks.push(new PatternMark(b.color, n === b.fromLine, n === to).range(doc.line(n).from));
  }
  editor.editor.dispatch({ effects: setPatternMarksEffect.of(RangeSet.of(marks, true)) });
}

// Light up source ranges ([{ start, end }]) in the editor; null clears.
export function highlightSource(editor, ranges) {
  const len = editor.editor.state.doc.length;
  const decos = (ranges || [])
    .filter((r) => r.start < r.end && r.end <= len)
    .sort((a, b) => a.start - b.start)
    .map((r) => sourceMark.range(r.start, r.end));
  editor.editor.dispatch({ effects: setSourceHighlight.of(Decoration.set(decos, true)) });
}

// Put the cursor at a source position and show it.
export function revealSource(editor, pos) {
  const view = editor.editor;
  const at = Math.min(pos, view.state.doc.length);
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  view.focus();
}

// Evaluate the code without starting playback (hot reload, and the piano roll while stopped). Code that does not
// parse yet (half-typed) is skipped silently and the last good pattern stays.
export async function softEvaluate(editor) {
  const code = editor.code;
  if (!code.trim()) return false;
  try {
    transpiler(code); // also parses the mini-notation strings
  } catch {
    return false;
  }
  await editor.repl.evaluate(code, false);
  return true;
}

// call fn on every document change (typing and programmatic replacement alike)
export function onDocChange(editor, fn) {
  docListeners.add(fn);
}

// call fn when the cursor or selection moves (and on edits). A sketch switch replaces the state without an update: read cursorPos() then
export function onSelectionChange(editor, fn) {
  selListeners.add(fn);
}

export function cursorPos(editor) {
  const st = editor.editor.state;
  const head = st.selection.main.head;
  const line = st.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
}

// replace the whole document as a normal (undoable) edit, e.g. when the file changed on disk
export function replaceDoc(editor, code) {
  const view = editor.editor;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
}

// every url the built-in sounds can fetch, for "save all sounds offline"
export function allBuiltinUrls() {
  const urls = [...BUILTIN_MAPS, `${TS}/tidal-drum-machines-alias.json`];
  for (const sound of Object.values(soundMap.get())) {
    const d = sound?.data;
    if (d?.type !== 'sample' || d.tag === 'mine') continue;
    const s = d.samples;
    for (const u of Array.isArray(s) ? s : Object.values(s || {}).flat()) {
      if (typeof u === 'string' && u.startsWith('https://')) urls.push(u);
    }
  }
  for (const fonts of Object.values(gm)) for (const f of fonts) urls.push(`${SOUNDFONT_URL}/${f}.js`);
  return [...new Set(urls)];
}

export function listSounds() {
  return Object.entries(soundMap.get())
    .filter(([name, v]) => v && !name.startsWith('_'))
    .map(([name, v]) => {
      const d = v.data || {};
      const s = d.samples;
      const count = Array.isArray(s) ? s.length : s ? Object.keys(s).length : 0;
      return { name, type: d.type || 'synth', tag: d.tag, count, baseUrl: d.baseUrl };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function preview(name, type) {
  const ac = getAudioContext();
  if (ac.state !== 'running') await ac.resume();
  const isSample = type === 'sample';
  const value = { s: name, n: 0, note: isSample ? undefined : 'c4', clip: isSample ? undefined : 1 };
  const dur = isSample ? 1.5 : 0.6;
  // a silent hit first waits for the sound to download, so the audible one starts on time
  await superdough({ ...value, gain: 0 }, ac.currentTime + 0.02, 0.01);
  await superdough({ ...value, gain: 0.8 }, ac.currentTime + 0.03, dur);
}

// ---------- doc examples ----------
// Examples play on a second, private repl, so the sketch's code and pattern stay as they are. Only one thing plays at
// a time: an example stops the sketch, and the sketch starting stops the example (main.js). Creating or running a repl
// points Strudel's global time/cps/trigger hooks at it, so they are pointed back at the sketch's repl afterwards.
let exRepl = null;
let mainTrigger = null;
let exTrigger = null;
const exListeners = new Set();
let exPlaying = null; // code of the example that is playing
function pointAtSketch(editor) {
  const r = editor.repl;
  setTime(() => r.scheduler.now());
  setCpsFunc(() => r.scheduler.cps);
  if (mainTrigger) setTriggerFunc(mainTrigger);
  exposePattern(r.state.pattern);
  setIsStarted(r.state.started);
}
const tellExample = (err) => exListeners.forEach((fn) => fn(exPlaying, err));
export async function playExample(editor, code) {
  if (!exRepl) {
    mainTrigger = getTriggerFunc();
    exRepl = repl({
      defaultOutput: webaudioOutput,
      getTime: () => getAudioContext().currentTime,
      transpiler,
      onUpdateState: (st) => {
        if (st.started || !exPlaying) return;
        exPlaying = null;
        pointAtSketch(editor);
        tellExample(null);
      },
    });
    exTrigger = getTriggerFunc();
    pointAtSketch(editor);
  }
  if (editor.repl.state.started) editor.stop();
  const ac = getAudioContext();
  if (ac.state !== 'running') await ac.resume();
  // evaluate() catches its own errors and returns no pattern then
  const pattern = await exRepl.evaluate(code);
  const err = pattern ? null : exRepl.state.evalError || new Error('example did not run');
  exPlaying = err ? null : code;
  if (err) { exRepl.stop(); pointAtSketch(editor); }
  else { setCpsFunc(() => exRepl.scheduler.cps); setTriggerFunc(exTrigger); }
  tellExample(err);
  return !err;
}
export function stopExample() {
  if (!exRepl || !exPlaying) return;
  exRepl.stop(); // onUpdateState above clears exPlaying and repoints the hooks
}
export const playingExample = () => exPlaying;
export function onExampleChange(fn) {
  exListeners.add(fn);
}

export { soundMap };
