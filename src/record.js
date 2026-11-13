// The Export pane: renders cycles `from` up to `to` (plus a tail for reverb and delay to ring out) to a WAV file,
// faster than real time.
//
// 1. superdough renders the haps in an OfflineAudioContext (as fast as the CPU allows), one stereo pair of channels
//    per capture stream: stream 0 is the main mix, the others are sounds routed through plugins (vst/runtime.js).
//    MIDI and parameter events for plugins are collected instead of sent, timed in frames from the start.
// 2. With plugins in play, jelly-host runs the rack offline over those streams and events (Engine::renderOffline)
//    and writes the WAV. Without them (or without the engine) the streams are mixed here and the page encodes it.
// Times are exact: cycle c is at (c - from) / cps seconds, so the file starts on the first beat of `from`.
import { getAudioContext, setAudioContext, getSuperdoughAudioController, setSuperdoughAudioController, loadWorklets, webaudioOutput } from '@strudel/webaudio';
import { captureMode } from './vst/engine/capture.js';
import { wrapOutput, prepareExport, collectEvents } from './vst/runtime.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-')) el.setAttribute(k, v);
    else el[k] = v;
  }
  el.append(...kids);
  return el;
};

// 24-bit PCM stereo WAV
function encodeWav(l, r, rate) {
  const frames = l.length;
  const data = frames * 2 * 3;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, data, true);
  const out = new Uint8Array(buf);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (const x of [l[i], r[i]]) {
      const s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607);
      out[o++] = s & 255; out[o++] = (s >> 8) & 255; out[o++] = (s >> 16) & 255;
    }
  }
  return out;
}

const STEP = 1; // seconds of audio rendered between scheduling passes
const LEAD = 0.5; // haps are scheduled at least this far ahead of the render

// superdough's sounds for `haps`, offline. Returns one { index, l, r } per stream in `streams`, `frames` long, or
// null when cancelled. Events for plugins land in `events`.
async function renderSounds({ haps, from, cps, frames, rate, streams, events, onProgress, cancelled }) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2 * streams.length, length: frames, sampleRate: rate });
  const live = getAudioContext();
  const liveCtl = getSuperdoughAudioController();
  // superdough works on whatever context and controller are current: swap in the offline ones until it is rendered
  setAudioContext(ctx);
  setSuperdoughAudioController(null);
  try {
    const ctl = getSuperdoughAudioController(); // a fresh one on ctx
    await loadWorklets();
    // stream j of `streams` -> channels 2j, 2j+1
    ctx.destination.channelInterpretation = 'discrete';
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 * streams.length });
    merger.connect(ctx.destination);
    const ins = streams.map((_, j) => {
      const g = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      g.connect(split);
      split.connect(merger, 0, 2 * j);
      split.connect(merger, 1, 2 * j + 1);
      return g;
    });
    ctl.output.destinationGain.disconnect();
    ctl.output.destinationGain.connect(ins[0]);
    // routed sounds play on orbit 1000 * stream + orbit (vst/runtime.js); wire them as capture.js does live
    const getOrbit = ctl.getOrbit;
    ctl.getOrbit = function (n, channels) {
      const isNew = this.nodes[n] == null;
      const orbit = getOrbit.call(this, n, channels);
      const j = n >= 1000 ? streams.indexOf(Math.floor(n / 1000)) : -1;
      if (isNew && j > 0) {
        orbit.output.disconnect();
        orbit.output.connect(ins[j]);
      }
      return orbit;
    };

    // Scheduled just in time, like the live scheduler: the render pauses every STEP seconds and the haps of the next
    // stretch are added then. Scheduling everything up front makes the render crawl (every voice's envelope runs from
    // the start), and finished voices are only cleaned up (onended, on this thread) while the render pauses.
    // The same output the scheduler uses, called in onset order (cut groups depend on it).
    const output = wrapOutput(webaudioOutput);
    const duration = frames / rate;
    let next = 0;
    const scheduleUntil = async (end) => {
      for (; next < haps.length && !cancelled(); next++) {
        const hap = haps[next];
        const t = (hap.whole.begin.valueOf() - from) / cps;
        if (t >= end) break;
        try {
          if (!hap.context.onTrigger || !hap.context.dominantTrigger) await output(hap, t, hap.duration / cps, cps, t);
        } catch (e) {
          console.warn('[export]', e);
        }
      }
    };
    collectEvents(events);
    try {
      await scheduleUntil(STEP + LEAD);
      for (let at = STEP; at < duration; at += STEP) {
        const when = Math.floor((at * rate) / 128) * 128; // suspend times are render quantum boundaries
        ctx.suspend(when / rate).then(async () => {
          await scheduleUntil(at + STEP + LEAD);
          onProgress(at / duration);
          ctx.resume();
        });
      }
      // still on the offline context: voices clean up after themselves (onended) on whatever context is current
      const buf = await ctx.startRendering();
      if (cancelled()) return null;
      return streams.map((index, j) => ({ index, l: buf.getChannelData(2 * j), r: buf.getChannelData(2 * j + 1) }));
    } finally {
      collectEvents(null);
    }
  } finally {
    setAudioContext(live);
    setSuperdoughAudioController(liveCtl);
  }
}

export function initExport({ container, editor, jelly, store, isLoaded, isPlaying, stop, evaluate, getName }) {
  let opts = { from: 0, to: 8, tail: 2 };
  try { opts = { ...opts, ...JSON.parse(store.get('jelly-export', '{}')) }; } catch {}

  const num = (key, attrs) => {
    const el = h('input', { type: 'number', class: 'num-field', value: String(opts[key]), 'data-testid': `export-${key}`, ...attrs });
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (el.value !== '' && Number.isFinite(v)) { opts[key] = v; store.set('jelly-export', JSON.stringify(opts)); }
      render();
    });
    return el;
  };
  const fromIn = num('from', { min: 0, step: 1 });
  const toIn = num('to', { min: 1, step: 1 });
  const tailIn = num('tail', { min: 0, max: 30, step: 0.5 });
  const summary = h('p', { class: 'set-note export-sum', 'data-testid': 'export-summary' });
  const go = h('button', { type: 'button', class: 'btn btn-butter btn-sm', 'data-testid': 'export-go' }, 'Export WAV');
  const cancel = h('button', { type: 'button', class: 'btn btn-cream btn-sm', 'data-testid': 'export-cancel', hidden: true }, 'Cancel');
  const fill = h('div', { class: 'fill' });
  const track = h('div', { class: 'track', role: 'progressbar', 'aria-label': 'Export progress', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, fill);
  const status = h('p', { class: 'set-note export-status', 'data-testid': 'export-status', role: 'status' });
  const show = h('button', { type: 'button', class: 'head-btn', 'data-testid': 'export-show', hidden: true }, 'Show in folder');
  const label = (text, small) => h('span', { class: 'set-label' }, text, ...(small ? [h('small', {}, small)] : []));
  container.append(
    h('div', { class: 'panel-head' }, h('span', { class: 'panel-title' }, 'Export')),
    h('div', { class: 'pane-body pane-scroll' },
      h('section', { class: 'set-group' },
        h('h3', {}, 'Audio'),
        h('p', { class: 'set-note' }, 'Renders the sketch from one cycle to another and saves it as a WAV file, plugins included. It renders faster than real time, and stops playback first.'),
        h('label', { class: 'set-row' }, label('From cycle', 'The cycle counter starts at 0'), fromIn),
        h('label', { class: 'set-row' }, label('To cycle', 'Ends where this cycle begins'), toIn),
        h('label', { class: 'set-row' }, label('Tail', 'Seconds after the last cycle, so reverb and delay can ring out'), tailIn),
        summary,
        h('div', { class: 'row' }, go, cancel),
        track,
        h('div', { class: 'export-result' }, status, show),
      ),
    ),
  );

  let run = null; // the export in progress
  let saved = null;
  const valid = () => Number.isFinite(opts.from) && Number.isFinite(opts.to) && opts.from >= 0 && opts.to > opts.from && opts.tail >= 0 && opts.tail <= 30;
  const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s * 10) / 10} s`);
  const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function render() {
    const cps = editor.repl.scheduler.cps || 0.5;
    const cycles = opts.to - opts.from;
    summary.textContent = valid()
      ? `${cycles} cycle${cycles === 1 ? '' : 's'} · ${secs(cycles / cps + opts.tail)} at ${Math.round(cps * 2400) / 10} BPM`
      : 'To cycle has to be after From cycle, and the tail 0 to 30 seconds.';
    summary.classList.toggle('set-error', !valid());
    go.disabled = !!run || !valid() || !isLoaded();
    go.hidden = !!run;
    cancel.hidden = !run;
    track.hidden = !run;
    for (const el of [fromIn, toIn, tailIn]) el.disabled = !!run;
    show.hidden = !saved || !!run;
  }
  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('set-error', error);
  };
  const progress = (p) => {
    fill.style.width = `${Math.round(100 * Math.max(0, Math.min(1, p)))}%`;
  };

  async function start() {
    if (run || !valid()) return;
    const { from, to, tail } = opts;
    const me = (run = { cancelled: false, host: false });
    const cancelled = () => me.cancelled;
    saved = null;
    render();
    progress(0);
    say('Preparing…');
    const t0 = performance.now();
    try {
      if (isPlaying()) stop();
      const pattern = await evaluate();
      if (!pattern) throw new Error('the code has an error');
      if (cancelled()) return;
      const cps = editor.repl.scheduler.cps;
      const rate = getAudioContext().sampleRate;
      const frames = Math.max(1, Math.round(((to - from) / cps + tail) * rate));
      const haps = pattern
        .queryArc(from, to, { _cps: cps })
        .filter((hap) => hap.hasOnset() && hap.whole.begin.valueOf() >= from)
        .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());
      const host = captureMode() === 'host';
      // every route the haps take gets its plugins and stream before anything renders
      const streams = host ? await prepareExport(haps) : [0];
      if (cancelled()) return;

      say('Rendering sounds…');
      const events = [];
      const parts = await renderSounds({
        haps, from, cps, frames, rate, streams, events, cancelled,
        onProgress: (p) => !cancelled() && progress(p * (host ? 0.5 : 1)),
      });
      if (!parts || cancelled()) return;

      if (host && (events.length > 0 || streams.length > 1)) {
        // plugins in play: the engine runs the rack over it and writes the file
        say('Rendering plugins…');
        me.host = true;
        const off = jelly.vst.onRenderProgress((p) => !cancelled() && progress(0.5 + 0.5 * p));
        try {
          saved = await jelly.vst.render({ srcRate: rate, frames, streams: parts, events }, getName());
        } finally {
          off();
        }
      } else {
        say('Saving…');
        const l = new Float32Array(frames), r = new Float32Array(frames);
        for (const part of parts)
          for (let i = 0; i < frames; i++) {
            l[i] += part.l[i];
            r[i] += part.r[i];
          }
        saved = await jelly.saveRecording(getName(), encodeWav(l, r, rate));
      }
      if (cancelled()) return;
      say(saved ? `Saved ${saved.split(/[\\/]/).pop()} (took ${secs((performance.now() - t0) / 1000)})` : 'Not saved.');
    } catch (e) {
      const msg = cleanError(e);
      if (!cancelled()) say(/cancelled/.test(msg) ? 'Cancelled.' : `Export failed: ${msg}`, !/cancelled/.test(msg));
    } finally {
      if (run === me) {
        run = null;
        render();
      }
    }
  }

  go.addEventListener('click', start);
  cancel.addEventListener('click', () => {
    if (!run) return;
    run.cancelled = true;
    if (run.host) jelly.vst.renderCancel();
    run = null;
    saved = null;
    say('Cancelled.');
    render();
  });
  show.addEventListener('click', () => saved && jelly.revealRecording(saved));
  render();

  return { render };
}
