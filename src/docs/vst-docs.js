// Docs for the VST functions, written by hand: Strudel's own jsdoc knows nothing about them. Same shape as the entries
// from virtual:strudel-docs, plus `noPlay` (the examples need plugins and a rack, so the docs player skips them).
export const VST_GROUP = 'VST plugins';

const p = (name, type, desc) => ({ name, type, desc });

export const VST_ENTRIES = [
  {
    name: 'rack',
    group: VST_GROUP,
    noPlay: true,
    synonyms: [],
    desc: `<p>Declares your VST3 and VST2 plugins by name. Each entry is one plugin, or a <code>[...]</code> chain of plugins. A chain can end with another entry's name, which sets where it goes by default.</p>
<p>The first plugin decides how an entry is used: a synth is played with <code>.s("name")</code>, an effect receives audio through <code>.fx("name")</code>. There is no special master: <code>master</code> is an ordinary entry, and <code>all(x =&gt; x.fx("master"))</code> sends everything through it.</p>
<p>The Mixer pane shows the same rack and edits this code for you. Entries that keep the same name keep running when you re-run.</p>`,
    params: [p('spec', 'Object', 'Entry names as keys, <code>vst(...)</code> or a chain as values.')],
    examples: [
      `rack({
  pad:    vst("Vital"),
  verb:   [vst("ValhallaSupermassive", { mix: .4 }), "master"],
  master: [vst("Pro-Q 3"), vst("Pro-L 2", { ceiling: "-1 dB" })],
})

$: note("<c3 eb3 g3>").s("pad").fx("verb")
$: s("bd*4, hh*8").fx("master")`,
    ],
  },
  {
    name: 'vst',
    group: VST_GROUP,
    noPlay: true,
    synonyms: [],
    desc: `<p>An installed VST3 or VST2 plugin, by the name the scan found (<code>"One"</code>, <code>"Pro-L 2"</code>). Case is ignored and the vendor may come first (<code>"FabFilter One"</code>). File paths are not accepted. A plugin installed as both VST3 and VST2 is loaded as VST3.</p>
<p>Use it inside <code>rack({...})</code>, or as an effect for one pattern only: <code>.fx(vst("Saturn 2"))</code>.</p>
<p>Parameters are camelCase (<code>dryWet</code>) or the original name in quotes (<code>"Dry/Wet"</code>). Numbers use the parameter's own range, strings use the plugin's own units (<code>"-18 dB"</code>, <code>"1/8 D"</code>, <code>"Gemini"</code>). <code>bypass: true</code> turns the plugin off without removing it. Hover the plugin name for its card, Ctrl+click it to open the plugin window.</p>`,
    params: [
      p('name', 'string', 'The plugin name. Autocomplete lists what is installed.'),
      p('params', 'Object', 'Starting values for its parameters, e.g. <code>{ cutoff: .35 }</code>. Plain values only; use <code>.set()</code> to change them over time.'),
    ],
    examples: [
      `rack({
  bass: vst("Diva", { cutoff: .35 }),
  lead: vst("Pro-L 2", { ceiling: "-1 dB", bypass: true }),
})`,
      `$: s("bd*4, hh*8").fx(vst("Saturn 2", { drive: .3 }))`,
    ],
  },
  {
    name: 'fx',
    group: VST_GROUP,
    noPlay: true,
    synonyms: [],
    desc: `<p>Sends a pattern's sound through rack effects, in order. A name is a rack entry; <code>vst(...)</code> or an array of them is an effect for this pattern only.</p>
<p>It works on Strudel's own sounds and on rack synths. Using an entry the wrong way (an effect with <code>.s</code>, a synth with <code>.fx</code>) is an error on that line, with a hint. Loops between entries are rejected.</p>`,
    params: [p('target', 'string | vst | Array', 'A rack entry name, <code>vst("Plugin")</code>, or a list of those. A list of plugins may end with an entry name.')],
    examples: [
      `$: note("c1 [~ c2] eb1").s("bass").fx("master")`,
      `$: s("bd*4, hh*8").fx(vst("Saturn 2")).fx("master")`,
    ],
  },
  {
    name: 'set',
    group: VST_GROUP,
    noPlay: true,
    synonyms: [],
    desc: `<p><code>.set("entry", { param: pattern })</code> changes a rack entry's parameters from a pattern, for synths and effects alike. The changes are temporary and never saved: the value in <code>rack({...})</code> is what each knob returns to.</p>
<p>Autocomplete lists the rack names inside <code>.set("...")</code>, then that entry's parameters with range and current value inside <code>{ ... }</code>. Any other <code>.set(...)</code> call is Strudel's own.</p>`,
    params: [
      p('entry', 'string', 'A rack entry name.'),
      p('params', 'Object', 'Parameter names, each with a pattern or value.'),
    ],
    examples: [
      `$: note("c1 [~ c2] eb1").s("bass").set("bass", { cutoff: sine.range(.2, .6).slow(8) })`,
      `$: s("cp*2").fx("verb").set("verb", { mix: "<.2 .6>" })`,
    ],
  },
  {
    name: 'cc',
    group: VST_GROUP,
    noPlay: true,
    synonyms: [],
    desc: `<p>Sends a MIDI control change to a synth in the rack. The value runs from 0 to 1 and is scaled to 0 to 127. An event with a controller and no note sends only the controller.</p>`,
    params: [
      p('n', 'number', 'The controller number, e.g. 1 for the mod wheel.'),
      p('value', 'number', 'The value, 0 to 1.'),
    ],
    examples: [`$: note("c3 e3 g3").s("pad").cc(1, sine.range(0, 1).slow(4))`],
  },
];

// merge into the generated docs: { groups, entries }
export function withVstDocs(base) {
  const names = new Set(VST_ENTRIES.map((e) => e.name));
  return {
    groups: [...base.groups, VST_GROUP],
    entries: [...base.entries.filter((e) => !names.has(e.name) || e.group === VST_GROUP), ...VST_ENTRIES].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
