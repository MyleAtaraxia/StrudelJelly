// Turns listSounds() into the rows and pads the browser shows. No DOM in here.
const isDrum = (s) => s.baseUrl?.includes('tidal-drum-machines');

const DRUM_ORDER = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'cl', 'sh', 'tb', 'perc', 'misc'];

// General MIDI families in program order (names are the soundfont keys from @strudel/soundfonts)
const GM_FAMILIES = [
  ['Piano', 'piano epiano1 epiano2 harpsichord clavinet'],
  ['Chromatic Percussion', 'celesta glockenspiel music_box vibraphone marimba xylophone tubular_bells dulcimer'],
  ['Organ', 'drawbar_organ percussive_organ rock_organ church_organ reed_organ accordion harmonica bandoneon'],
  ['Guitar', 'acoustic_guitar_nylon acoustic_guitar_steel electric_guitar_jazz electric_guitar_clean electric_guitar_muted overdriven_guitar distortion_guitar guitar_harmonics'],
  ['Bass', 'acoustic_bass electric_bass_finger electric_bass_pick fretless_bass slap_bass_1 slap_bass_2 synth_bass_1 synth_bass_2'],
  ['Strings', 'violin viola cello contrabass tremolo_strings pizzicato_strings orchestral_harp timpani'],
  ['Ensemble & Choir', 'string_ensemble_1 string_ensemble_2 synth_strings_1 synth_strings_2 choir_aahs voice_oohs synth_choir orchestra_hit'],
  ['Brass', 'trumpet trombone tuba muted_trumpet french_horn brass_section synth_brass_1 synth_brass_2'],
  ['Reed', 'soprano_sax alto_sax tenor_sax baritone_sax oboe english_horn bassoon clarinet'],
  ['Pipe', 'piccolo flute recorder pan_flute blown_bottle shakuhachi whistle ocarina'],
  ['Synth Lead', 'lead_1_square lead_2_sawtooth lead_3_calliope lead_4_chiff lead_5_charang lead_6_voice lead_7_fifths lead_8_bass_lead'],
  ['Synth Pad', 'pad_new_age pad_warm pad_poly pad_choir pad_bowed pad_metallic pad_halo pad_sweep'],
  ['Synth FX', 'fx_rain fx_soundtrack fx_crystal fx_atmosphere fx_brightness fx_goblins fx_echoes fx_sci_fi'],
  ['Ethnic', 'sitar banjo shamisen koto kalimba bagpipe fiddle shanai'],
  ['Percussive', 'tinkle_bell agogo steel_drums woodblock taiko_drum melodic_tom synth_drum reverse_cymbal'],
  ['Sound FX', 'guitar_fret_noise breath_noise seashore bird_tweet telephone helicopter applause gunshot'],
];
const GM = new Map();
GM_FAMILIES.forEach(([fam, keys], f) => keys.split(' ').forEach((k, i) => GM.set('gm_' + k, { fam, order: f * 1000 + i })));

const BASIC = ['sine', 'sawtooth', 'square', 'triangle', 'supersaw', 'pulse', 'white', 'pink', 'brown', 'crackle'];
const GM_NAMES = { gm_piano: 'Acoustic Grand Piano', gm_epiano1: 'Electric Piano 1', gm_epiano2: 'Electric Piano 2' };
const titleCase = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export function friendlyName(name) {
  if (GM_NAMES[name]) return GM_NAMES[name];
  if (name.startsWith('gm_')) {
    const w = name.slice(3).split('_');
    if (w[0] === 'lead') return `Lead ${w[1]} (${titleCase(w.slice(2).join('_'))})`;
    if (w[0] === 'pad') return `Pad (${titleCase(w.slice(1).join('_'))})`;
    if (w[0] === 'fx') return `FX (${titleCase(w.slice(1).join('_'))})`;
    return titleCase(name.slice(3));
  }
  return name;
}

const BADGES = { sample: 'smp', synth: 'syn', soundfont: 'sf', wavetable: 'wt' };
export const TAB_LABELS = { mine: 'My sounds', drums: 'Drum machines', samples: 'Sample sets', instruments: 'Instruments' };

function groupOf(s) {
  if (BASIC.includes(s.name)) return ['Basic synths', BASIC.indexOf(s.name)];
  const gm = GM.get(s.name);
  if (gm) return [gm.fam, gm.order];
  if (s.name === 'zzfx' || s.name.startsWith('z_')) return ['ZZFX', 0];
  if (s.name.startsWith('wt_')) return ['Wavetables', 0];
  return ['Other', 0];
}
const GROUP_ORDER = ['Basic synths', ...GM_FAMILIES.map((f) => f[0]), 'Wavetables', 'ZZFX', 'Other'];

const quote = (s) => s.replace(/"/g, '\\"');

function setItem(tab, s) {
  return {
    kind: 'item', tab, key: `${tab}:${s.name}`, fid: `${tab}:${s.name}`, name: s.name, label: s.name,
    type: s.type, badge: BADGES[s.type] || s.type, count: s.count, drill: s.count > 1 ? 'variations' : null,
    play: { aud: `${s.name}#0`, name: s.name, n: 0, type: 'sample' },
    ins: { bare: s.name, full: `s("${quote(s.name)}")` },
  };
}

// every top-level item of a tab (groups are added in buildRows)
function tabItems(tab, all) {
  if (tab === 'mine') return all.filter((s) => s.tag === 'mine').map((s) => setItem(tab, s));
  if (tab === 'samples') return all.filter((s) => s.type === 'sample' && s.tag !== 'mine' && !isDrum(s)).map((s) => setItem(tab, s));
  if (tab === 'drums') {
    const banks = new Map();
    for (const s of all.filter(isDrum)) {
      const bank = s.name.split('_')[0];
      const b = banks.get(bank) || { bank, count: 0, first: s.name, bd: null };
      b.count++;
      if (s.name.endsWith('_bd')) b.bd = s.name;
      banks.set(bank, b);
    }
    return [...banks.values()].map((b) => {
      const play = b.bd || b.first;
      return {
        kind: 'item', tab, key: `drums:${b.bank}`, fid: `drums:${b.bank}`, name: b.bank, label: b.bank, type: 'sample', badge: 'kit',
        count: b.count, bank: true, drill: 'instruments',
        play: { aud: `${play}#0`, name: play, n: 0, type: 'sample' },
        ins: { bare: b.bank, full: `.bank("${quote(b.bank)}")` },
      };
    });
  }
  return all.filter((s) => s.type !== 'sample').map((s) => {
    const [group, order] = groupOf(s);
    const friendly = friendlyName(s.name);
    return {
      kind: 'item', tab, key: `instruments:${s.name}`, fid: `instruments:${s.name}`, name: s.name,
      label: friendly, code: friendly !== s.name ? s.name : '', type: s.type, badge: BADGES[s.type] || s.type, count: 0,
      group, order, play: { aud: `${s.name}#0`, name: s.name, n: 0, type: s.type },
      ins: { bare: s.name, full: `s("${quote(s.name)}")` },
    };
  });
}

export function hasMine(all) {
  return all.some((s) => s.tag === 'mine');
}

// flat virtual-list rows: headers and items. favs is a Set of fids.
export function buildRows(tab, all, favs, query) {
  const q = query.trim().toLowerCase();
  let items = tabItems(tab, all);
  if (q) items = items.filter((it) => (it.name + ' ' + it.label).toLowerCase().includes(q));
  const rows = [];
  const header = (label, n) => rows.push({ kind: 'header', key: 'h|' + label, label, n });
  const favItems = items.filter((it) => favs.has(it.fid));
  if (favItems.length) {
    header('Favourites', favItems.length);
    for (const it of favItems) rows.push({ ...it, key: 'fav|' + it.key, fav: true });
  }
  if (tab === 'instruments') {
    const byGroup = new Map();
    for (const it of items) {
      if (!byGroup.has(it.group)) byGroup.set(it.group, []);
      byGroup.get(it.group).push(it);
    }
    for (const g of GROUP_ORDER) {
      const list = byGroup.get(g);
      if (!list) continue;
      list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
      header(g, list.length);
      rows.push(...list);
    }
  } else if (items.length) {
    if (favItems.length) header(TAB_LABELS[tab], items.length);
    rows.push(...items);
  }
  return { rows, total: items.length };
}

// the second level: pads for a drum machine's instruments or a sample set's variations
export function buildPads(item, all) {
  if (item.bank) {
    const pre = item.name + '_';
    const pads = all.filter((s) => isDrum(s) && s.name.startsWith(pre)).map((s) => {
      const inst = s.name.slice(pre.length);
      return {
        key: 'pad|' + s.name, label: inst, sub: s.count > 1 ? String(s.count) : '',
        aria: `${inst}${s.count > 1 ? `, ${s.count} variations` : ''}`,
        play: { aud: `${s.name}#0`, name: s.name, n: 0, type: 'sample' },
        ins: { bare: inst, full: `s("${quote(inst)}").bank("${quote(item.name)}")` },
      };
    });
    const rank = (l) => (DRUM_ORDER.includes(l) ? DRUM_ORDER.indexOf(l) : 999);
    return pads.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
  }
  return Array.from({ length: Math.max(item.count, 1) }, (_, n) => ({
    key: `pad|${item.name}:${n}`, label: String(n), sub: '',
    aria: `Variation ${n} of ${item.name}`,
    play: { aud: `${item.name}#${n}`, name: item.name, n, type: 'sample' },
    ins: { bare: `${item.name}:${n}`, full: `s("${quote(item.name)}:${n}")` },
  }));
}
