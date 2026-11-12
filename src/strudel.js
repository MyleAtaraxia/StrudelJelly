import * as core from '@strudel/core';
import { evalScope, noteToMidi, valueToMidi, Pattern, silence } from '@strudel/core';
import { aliasBank, registerSynthSounds, registerZZFXSounds, samples, getAudioContext, webaudioOutput, initAudioOnFirstClick, soundMap, superdough } from '@strudel/webaudio';
import { StrudelMirror, themes, settings as themeSettings } from '@strudel/codemirror';
import { transpiler } from '@strudel/transpiler';
import { getDrawContext } from '@strudel/draw';
import { EditorView } from '@codemirror/view';
import { StateEffect, Transaction } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import gm from '@strudel/soundfonts/gm.mjs';

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
    ? { fg: '#F6EADB', soft: '#CDBFC4', fn: '#AC9BD8', str: '#9FC792', num: '#DCC381', prop: '#D9A0AA', kw: '#93B5DB', line: '#3A313F', sel: '#4A3F52' }
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

export function createEditor({ root, initialCode, onUpdateState, onEvalError, onEval, onFrame, settings }) {
  initAudioOnFirstClick();
  const editor = new StrudelMirror({
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
    afterEval: () => {
      onEvalError?.(null);
      onEval?.();
    },
    onEvalError: (err) => onEvalError?.(err),
  });
  editor.updateSettings({
    fontFamily: '"Cascadia Code", Consolas, monospace',
    isTooltipEnabled: true,
    isFlashEnabled: true,
    isBracketMatchingEnabled: true,
    isBracketClosingEnabled: true,
    isActiveLineHighlighted: true,
    ...settings,
  });
  return editor;
}

// call fn on every document change (typing and programmatic replacement alike)
export function onDocChange(editor, fn) {
  editor.editor.dispatch({
    effects: StateEffect.appendConfig.of(EditorView.updateListener.of((v) => v.docChanged && fn(v))),
  });
}

// swap the whole document (opening another sketch) without making it an undo step
export function replaceDoc(editor, code) {
  const view = editor.editor;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: code },
    selection: { anchor: 0 },
    annotations: Transaction.addToHistory.of(false),
    scrollIntoView: true,
  });
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

export { soundMap };
