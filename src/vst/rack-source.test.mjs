// node src/vst/rack-source.test.mjs
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { history, undo } from '@codemirror/commands';
import * as R from './rack-source.js';

// a fake view: enough of EditorView for the helpers, with real undo history
const make = (doc) => ({
  state: EditorState.create({ doc, extensions: [javascript(), history()] }),
  n: 0,
  dispatch(...specs) {
    this.state = this.state.update(...specs).state;
    this.n++;
  },
});
const text = (v) => v.state.doc.toString();
const undoOnce = (v) => {
  undo({ state: v.state, dispatch: (tr) => (v.state = tr.state) });
  return text(v);
};
let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log('ok', name);
};
// every edit is one transaction and one undo step; returns the edited text
const edit = (doc, fn) => {
  const v = make(doc);
  fn(v);
  assert.equal(v.n, 1, 'one transaction');
  assert.notEqual(text(v), doc);
  const after = text(v);
  assert.equal(undoOnce(v), doc, 'one undo restores');
  return after;
};

const BASIC = `rack({
  pad:    vst("Vital"),
  bass:   vst("Diva", { cutoff: .35 }),
  verb:   [vst("ValhallaSupermassive", { mix: .4 }), "master"],
  master: [vst("Pro-Q 3"), vst("Pro-L 2", { ceiling: "-1 dB" })],
})

$: note("c3").s("pad").fx("verb")
`;
const entries = (doc) => R.findRack(make(doc).state).entries;

t('findRack reads entries, plugins, params and next', () => {
  const e = entries(BASIC);
  assert.deepEqual(e.map((x) => x.name), ['pad', 'bass', 'verb', 'master']);
  assert.deepEqual(e[2].plugins.map((p) => p.name), ['ValhallaSupermassive']);
  assert.equal(e[2].next, 'master');
  assert.equal(e[2].isArray, true);
  assert.equal(e[1].plugins[0].params.cutoff.text, '.35');
  assert.equal(e[3].plugins[1].params.ceiling.text, '"-1 dB"');
  assert.equal(e[0].next, undefined);
  assert.equal(R.findRack(make('s("bd")').state), null);
});

t('odd formatting, comments, quoted keys', () => {
  const doc = `rack(  {pad:vst('Vital'),// c1
  /* c2 */ "my-bass" : [ vst( "Diva" ,{cutoff:.2,'Dry/Wet':1} ) , /* x */ vst("B") , "pad2" ] ,
  pad2:vst("C")
  })`;
  const e = entries(doc);
  assert.deepEqual(e.map((x) => x.name), ['pad', 'my-bass', 'pad2']);
  assert.deepEqual(e[1].plugins.map((p) => p.name), ['Diva', 'B']);
  assert.equal(e[1].next, 'pad2');
  assert.equal(e[1].plugins[0].params['Dry/Wet'].text, '1');
  assert.equal(e[0].plugins[0].name, 'Vital');
  // edits survive that formatting
  const out = edit(doc, (v) => R.setParam(v, 'my-bass', 0, 'cutoff', '0.9'));
  assert.match(out, /cutoff:0\.9,'Dry\/Wet':1/);
  assert.match(edit(doc, (v) => R.addPlugin(v, 'my-bass', 'Q')), /vst\("B"\), vst\("Q"\) , "pad2"/);
});

t('addPlugin: single becomes a chain, chain appends or inserts', () => {
  assert.match(edit(BASIC, (v) => R.addPlugin(v, 'pad', 'Pro-Q 3')), /pad: {4}\[vst\("Vital"\), vst\("Pro-Q 3"\)\],/);
  assert.match(edit(BASIC, (v) => R.addPlugin(v, 'pad', 'Pro-Q 3', 0)), /\[vst\("Pro-Q 3"\), vst\("Vital"\)\],/);
  // before an entry name at the end
  assert.match(edit(BASIC, (v) => R.addPlugin(v, 'verb', 'Saturn 2')), /\[vst\("ValhallaSupermassive", \{ mix: .4 \}\), vst\("Saturn 2"\), "master"\]/);
  assert.match(edit(BASIC, (v) => R.addPlugin(v, 'master', 'X', 1)), /\[vst\("Pro-Q 3"\), vst\("X"\), vst\("Pro-L 2"/);
  assert.equal(entries(edit(BASIC, (v) => R.addPlugin(v, 'master', 'Z')))[3].plugins.length, 3);
});

t('removePlugin: first, middle, last, before a name; the only plugin drops the entry', () => {
  const doc = `rack({ a: [vst("A"), vst("B"), vst("C"), "x"], x: vst("X") })`;
  assert.equal(edit(doc, (v) => R.removePlugin(v, 'a', 0)), `rack({ a: [vst("B"), vst("C"), "x"], x: vst("X") })`);
  assert.equal(edit(doc, (v) => R.removePlugin(v, 'a', 1)), `rack({ a: [vst("A"), vst("C"), "x"], x: vst("X") })`);
  assert.equal(edit(doc, (v) => R.removePlugin(v, 'a', 2)), `rack({ a: [vst("A"), vst("B"), "x"], x: vst("X") })`);
  assert.match(edit(BASIC, (v) => R.removePlugin(v, 'master', 1)), /master: \[vst\("Pro-Q 3"\)\],/);
  assert.deepEqual(entries(edit(BASIC, (v) => R.removePlugin(v, 'pad', 0))).map((x) => x.name), ['bass', 'verb', 'master']);
});

t('movePlugin keeps separators, comments and params', () => {
  const doc = `rack({ a: [vst("A", { x: 1 }), /* c */ vst("B"), vst("C", { y: 2 }), "x"], x: vst("X") })`;
  assert.equal(edit(doc, (v) => R.movePlugin(v, 'a', 0, 2)), `rack({ a: [vst("B"), /* c */ vst("C", { y: 2 }), vst("A", { x: 1 }), "x"], x: vst("X") })`);
  assert.equal(edit(doc, (v) => R.movePlugin(v, 'a', 2, 0)), `rack({ a: [vst("C", { y: 2 }), /* c */ vst("A", { x: 1 }), vst("B"), "x"], x: vst("X") })`);
  assert.equal(R.movePlugin(make(doc), 'a', 1, 1), false);
});

t('setParam: replace, insert, create object, remove, quoted keys, bypass', () => {
  assert.match(edit(BASIC, (v) => R.setParam(v, 'bass', 0, 'cutoff', '0.5')), /vst\("Diva", \{ cutoff: 0.5 \}\)/);
  assert.match(edit(BASIC, (v) => R.setParam(v, 'bass', 0, 'res', '0.1')), /vst\("Diva", \{ cutoff: .35, res: 0.1 \}\)/);
  assert.match(edit(BASIC, (v) => R.setParam(v, 'pad', 0, 'bypass', 'true')), /pad: {4}vst\("Vital", \{ bypass: true \}\),/);
  assert.match(edit(BASIC, (v) => R.setParam(v, 'pad', 0, 'Dry/Wet', '1')), /\{ "Dry\/Wet": 1 \}/);
  assert.match(edit(BASIC, (v) => R.setParam(v, 'bass', 0, 'cutoff', null)), /bass: {3}vst\("Diva"\),/);
  const three = `rack({ a: vst("A", { x: 1, y: 2, z: 3 }) })`;
  assert.equal(edit(three, (v) => R.setParam(v, 'a', 0, 'x', null)), `rack({ a: vst("A", { y: 2, z: 3 }) })`);
  assert.equal(edit(three, (v) => R.setParam(v, 'a', 0, 'z', null)), `rack({ a: vst("A", { x: 1, y: 2 }) })`);
  assert.equal(edit(three, (v) => R.setParam(v, 'a', 0, 'y', null)), `rack({ a: vst("A", { x: 1, z: 3 }) })`);
  assert.match(edit(BASIC, (v) => R.setParam(v, 'master', 1, 'bypass', 'true')), /vst\("Pro-L 2", \{ ceiling: "-1 dB", bypass: true \}\)/);
  assert.equal(edit(`rack({ a: vst("A", {}) })`, (v) => R.setParam(v, 'a', 0, 'x', '1')), `rack({ a: vst("A", { x: 1 }) })`);
  assert.equal(R.setParam(make(BASIC), 'bass', 0, 'cutoff', '.35'), false); // same value: nothing to do
  const b = make(BASIC);
  R.setBypass(b, 'master', 0, true);
  assert.equal(R.isBypassed(entries(text(b))[3].plugins[0]), true);
  R.setBypass(b, 'master', 0, false);
  assert.equal(R.isBypassed(entries(text(b))[3].plugins[0]), false);
  assert.equal(text(b), BASIC); // switching back removes what was written
});

t('addEntry: into the rack, with and without a trailing comma, or a new rack', () => {
  assert.match(edit(BASIC, (v) => R.addEntry(v, 'lead', 'Serum')), /master: \[.*\],\n  lead: vst\("Serum"\),\n\}\)/);
  assert.equal(edit(`rack({\n  a: vst("A"),\n  b: vst("B")\n})`, (v) => R.addEntry(v, 'c', 'C')), `rack({\n  a: vst("A"),\n  b: vst("B"),\n  c: vst("C")\n})`);
  assert.equal(edit(`rack({ a: vst("A") })`, (v) => R.addEntry(v, 'c', ['C', 'D'])), `rack({ a: vst("A"), c: [vst("C"), vst("D")] })`);
  assert.equal(edit(`rack({})`, (v) => R.addEntry(v, 'c', 'C')), `rack({
  c: vst("C"),
})`);
  assert.equal(edit(`// hi\nsetcps(.5)\n\n$: s("bd")\n`, (v) => R.addEntry(v, 'pad', 'Vital')), `// hi\nsetcps(.5)\n\nrack({\n  pad: vst("Vital"),\n})\n\n$: s("bd")\n`);
  assert.equal(edit(`s("bd")`, (v) => R.addEntry(v, 'a', 'A')), `s("bd")\nrack({\n  a: vst("A"),\n})\n\n`);
  assert.throws(() => R.addEntry(make(BASIC), 'pad', 'X'), /already/);
  assert.equal(R.uniqueName(make(BASIC).state, 'Pro-Q 3'), 'proQ3');
  assert.equal(R.uniqueName(make(BASIC).state, 'pad'), 'pad2');
});

t('removeEntry and restoreEntry round trip', () => {
  const v = make(BASIC);
  const src = R.removeEntry(v, 'verb');
  assert.equal(src, 'verb:   [vst("ValhallaSupermassive", { mix: .4 }), "master"]');
  assert.doesNotMatch(text(v), /verb:/);
  assert.deepEqual(entries(text(v)).map((e) => e.name), ['pad', 'bass', 'master']);
  R.restoreEntry(v, 'verb', src);
  const e = entries(text(v)).find((x) => x.name === 'verb');
  assert.equal(e.plugins[0].params.mix.text, '.4');
  assert.equal(e.next, 'master');
  const w = make(`rack({\n  a: vst("A"),\n  b: vst("B")\n})`);
  R.removeEntry(w, 'b');
  assert.equal(text(w), `rack({\n  a: vst("A"),\n})`);
  R.restoreEntry(w, 'q', ['X', 'Y']);
  assert.deepEqual(entries(text(w))[1].plugins.map((p) => p.name), ['X', 'Y']);
});

t('renameEntry also renames .s / .fx / .set uses and chain tails', () => {
  const doc = `rack({ verb: vst("V"), a: [vst("A"), "verb"] })\n$: s("x").fx("verb").fx(["verb", vst("Q")]).set("verb", { mix: .3 })\n$: s("verb")`;
  assert.equal(
    edit(doc, (v) => R.renameEntry(v, 'verb', 'space')),
    `rack({ space: vst("V"), a: [vst("A"), "space"] })\n$: s("x").fx("space").fx(["space", vst("Q")]).set("space", { mix: .3 })\n$: s("space")`,
  );
});

t('findVstCalls maps calls to entries and inline chains', () => {
  const doc = BASIC + `$: s("bd").fx(vst("Saturn 2")).fx("master")\n`;
  const calls = R.findVstCalls(make(doc).state);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.filter((c) => c.entry).map((c) => `${c.entry}:${c.slot}`), ['pad:0', 'bass:0', 'verb:0', 'master:0', 'master:1']);
  assert.equal(calls.find((c) => !c.entry).name, 'Saturn 2');
  assert.deepEqual(R.findNameUses(make(doc).state).map((u) => `${u.method}:${u.text}`), ['s:pad', 'fx:verb', 's:bd', 'fx:master']);
});

t('addEntries writes a starter rack in one step', () => {
  assert.equal(edit(`$: s("bd")
`, (v) => R.addEntries(v, [['synth', 'Vital'], ['fx', 'Pro-Q 3']])), `rack({
  synth: vst("Vital"),
  fx: vst("Pro-Q 3"),
})

$: s("bd")
`);
  assert.equal(edit(`rack({
  a: vst("A"),
})`, (v) => R.addEntries(v, [['b', 'B'], ['c', 'C']])), `rack({
  a: vst("A"),
  b: vst("B"),
  c: vst("C"),
})`);
});

console.log(`${passed} tests passed`);
