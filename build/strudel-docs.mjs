// Vite plugin: `import docs from 'virtual:strudel-docs'` gives Strudel's function reference, trimmed for the Docs pane.
// Strudel ships its jsdoc output inlined in @strudel/codemirror (for its own hover tooltips); we read it from there
// at build time, so the docs always match the installed Strudel and work offline.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ID = 'virtual:strudel-docs';

const GROUPS = [
  ['Patterns', /^core\/(pattern|repl)\.mjs$/],
  ['Sound & effects', /^core\/controls\.mjs$/],
  ['Signals & random', /^core\/signal\.mjs$/],
  ['Rhythm', /^core\/euclid\.mjs$/],
  ['Pick & select', /^core\/pick\.mjs$/],
  ['Notes & scales', /^tonal\//],
  ['Samples & setup', /^superdough\/(sampler|superdough|wavetable|util)\.mjs$/],
  ['Visuals', /^(draw\/|webaudio\/(scope|spectrum)|core\/drawLine|codemirror\/slider)/],
  ['MIDI & OSC', /^(midi|osc|csound)\//],
  ['Device motion', /^motion\//],
  ['Helpers', /^core\/util\.mjs$/],
];

const clean = (html = '') =>
  html
    .replace(/<a\b[^>]*>/g, '') // links would leave the app; keep their text
    .replace(/<\/a>/g, '')
    .trim();

export function extractDocs(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const file = path.join(path.dirname(req.resolve('@strudel/codemirror/package.json')), 'dist', 'index.mjs');
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/JSON\.parse\(`(\[\{"comment":[\s\S]*?\])`\)/);
  if (!m) throw new Error('strudel-docs: doc data not found in ' + file);
  const raw = JSON.parse(new Function('return `' + m[1] + '`')());
  const byName = new Map();
  for (const d of raw) {
    const where = `${(d.meta?.path || '').split(/packages[\/]/).pop()}/${d.meta?.filename}`;
    const group = GROUPS.find(([, re]) => re.test(where))?.[0];
    const examples = (d.examples || []).filter((e) => e.trim());
    if (!group || !d.name || d.name.startsWith('_') || d.access === 'private' || d.deprecated) continue;
    if (d.memberof && !['Pattern', 'repl'].includes(d.memberof)) continue;
    if (JSON.stringify(d.tags || '').includes('superdirtOnly')) continue;
    if (!d.description && !examples.length) continue;
    if (group === 'Patterns' && !examples.length) continue; // pattern.mjs internals (fmap, queryArc, ...)
    const entry = {
      name: d.name,
      group,
      desc: clean(d.description),
      params: (d.params || []).map((p) => ({ name: p.name || '', type: (p.type?.names || []).join(' | '), desc: clean(p.description) })),
      examples,
      synonyms: (d.synonyms || []).filter((s) => s && s !== d.name),
    };
    const old = byName.get(d.name);
    const score = (e) => e.examples.length * 1000 + e.desc.length;
    if (!old || score(entry) > score(old)) byName.set(d.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export default function strudelDocs() {
  let root = process.cwd();
  return {
    name: 'strudel-docs',
    configResolved(c) { root = c.root; },
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    load(id) {
      if (id !== '\0' + ID) return null;
      return `export default ${JSON.stringify({ groups: GROUPS.map(([g]) => g), entries: extractDocs(root) })};`;
    },
  };
}
