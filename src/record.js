// The Export pane: renders cycles `from` up to `to` (plus a tail for reverb and delay to ring out) to a WAV file.
// It plays the sketch in real time while recording, because plugins only run in real time.
// Timing is sample accurate: playback starts at `from` (the scheduler starts where its last query ended), notes that
// start at or after `to` are filtered out, and the recording window is set in AudioContext time from the scheduler's
// own clock, so the file starts on the first beat of `from` and ends `tail` seconds after `to` begins.
// With the audio engine, jelly-host writes its final mix (superdough and every plugin) itself (vst:recordStart);
// without it, a worklet records what Chromium plays and the page encodes the WAV.
import { getAudioContext } from '@strudel/webaudio';
import { captureMode, localOutputs } from './vst/engine/capture.js';
import workletUrl from './record-worklet.js?url';

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
const until = async (ok, ms) => {
  for (const end = performance.now() + ms; !ok(); ) {
    if (performance.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};

// 24-bit PCM stereo WAV from per-channel chunks
function encodeWav(chunks, rate) {
  const frames = chunks.reduce((n, c) => n + c.l.length, 0);
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
  for (const { l, r } of chunks) {
    for (let i = 0; i < l.length; i++) {
      for (const x of [l[i], r[i]]) {
        const s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607);
        out[o++] = s & 255; out[o++] = (s >> 8) & 255; out[o++] = (s >> 16) & 255;
      }
    }
  }
  return out;
}

// records Chromium's own output (no engine) between two AudioContext frames
let workletLoaded = null;
async function recordLocal(from) {
  const ac = getAudioContext();
  workletLoaded ??= ac.audioWorklet.addModule(workletUrl);
  await workletLoaded;
  const node = new AudioWorkletNode(ac, 'jelly-record', { numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
  const sources = localOutputs();
  for (const s of sources) s.connect(node);
  node.port.postMessage({ type: 'window', from });
  const chunks = [];
  let done;
  const finished = new Promise((r) => (done = r));
  node.port.onmessage = (e) => (e.data.type === 'done' ? done() : chunks.push(e.data));
  return {
    end: (to) => node.port.postMessage({ type: 'window', to }),
    async stop() {
      node.port.postMessage({ type: 'stop' });
      await finished;
      for (const s of sources) s.disconnect(node);
      return chunks.length ? encodeWav(chunks, ac.sampleRate) : null;
    },
  };
}

export function initExport({ container, editor, jelly, store, isLoaded, isPlaying, stop, play, getName }) {
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
        h('p', { class: 'set-note' }, 'Plays the sketch from one cycle to another and saves it as a WAV file, plugins included. It plays in real time, so it takes as long as the music.'),
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

  async function start() {
    if (run || !valid()) return;
    const { from, to, tail } = opts;
    const s = editor.repl.scheduler;
    const ac = getAudioContext();
    const host = captureMode() === 'host';
    saved = null;
    run = { phase: 'starting', timer: null, rec: null };
    const me = run;
    render();
    say('Starting…');
    fill.style.width = '0%';

    // notes that start at or after `to` never play, also if the pattern is swapped while exporting (hot reload)
    let inner = s.pattern;
    let filtered = null;
    const cut = (p) => p && p.filterHaps((hap) => !hap.whole || hap.whole.begin.valueOf() < to);
    filtered = cut(inner);
    Object.defineProperty(s, 'pattern', { configurable: true, get: () => filtered, set: (v) => { inner = v; filtered = cut(v); } });
    me.restore = () => {
      delete s.pattern;
      s.pattern = inner;
    };

    const fail = async (msg) => {
      if (run !== me) return;
      run = null;
      clearInterval(me.timer);
      me.restore();
      if (isPlaying()) stop();
      if (me.rec) await me.rec.discard().catch(() => {});
      say(msg, !!msg && msg !== 'Cancelled.');
      render();
    };
    me.cancel = () => fail('Cancelled.');

    try {
      if (isPlaying()) {
        stop();
        await until(() => !isPlaying(), 3000);
      }
      // the scheduler starts from where its last query ended
      s.lastEnd = from;
      s.seconds_at_cps_change = undefined;
      play();
      // plugins may need a while to load before playback starts
      if (!(await until(() => run !== me || (isPlaying() && s.seconds_at_cps_change !== undefined), 30000))) return fail('Playback did not start. Check the code for errors.');
      if (run !== me) return;
      const at = (c) => (c - s.num_cycles_at_cps_change) / s.cps + s.seconds_at_cps_change + s.latency; // AudioContext time of cycle c
      const fromFrame = at(from) * ac.sampleRate;
      if (host) {
        await jelly.vst.recordStart(fromFrame);
        me.rec = {
          end: (f) => jelly.vst.recordEnd(f),
          save: () => jelly.vst.recordStop(getName()),
          discard: () => jelly.vst.recordStop(getName(), true),
        };
      } else {
        const r = await recordLocal(fromFrame);
        me.rec = {
          end: (f) => r.end(f),
          save: async () => {
            const bytes = await r.stop();
            if (!bytes || bytes.length <= 44) throw new Error('nothing was recorded');
            return jelly.saveRecording(getName(), bytes);
          },
          discard: () => r.stop(),
        };
      }
      // the engine's output lags the AudioContext by its own latency; wait that long after the end before stopping
      const lag = host ? ((await jelly.vst.status())?.latencyMs ?? 100) / 1000 + 0.25 : 0.15;
      let endTime = null;
      me.phase = 'playing';
      me.timer = setInterval(() => {
        if (run !== me) return;
        const c = s.now();
        if (endTime == null && s.lastEnd >= to) {
          endTime = at(to) + tail;
          me.rec.end(endTime * ac.sampleRate);
        }
        if (endTime != null && c >= to) {
          const left = Math.max(0, endTime - ac.currentTime);
          fill.style.width = `${Math.min(100, 100 * (1 - left / Math.max(tail, 0.01)))}%`;
          say(tail > 0 ? `Tail · ${Math.ceil(left)} s left` : 'Finishing…');
          if (ac.currentTime >= endTime + lag) finish();
        } else {
          const p = Math.max(0, Math.min(1, (c - from) / (to - from)));
          fill.style.width = `${100 * p}%`;
          say(`Recording cycle ${Math.max(from, Math.floor(c))} · ${from} to ${to}`);
        }
      }, 100);
    } catch (e) {
      fail(`Export failed: ${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }

    async function finish() {
      if (me.phase !== 'playing') return;
      me.phase = 'saving';
      clearInterval(me.timer);
      me.restore();
      stop();
      say('Saving…');
      try {
        saved = await me.rec.save();
        say(saved ? `Saved ${saved.split(/[\\/]/).pop()}` : 'Not saved.');
      } catch (e) {
        say(`Export failed: ${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
      }
      run = null;
      render();
    }
  }

  go.addEventListener('click', start);
  cancel.addEventListener('click', () => run?.cancel());
  show.addEventListener('click', () => saved && jelly.revealRecording(saved));
  render();

  return {
    render,
    // Stop pressed while exporting cancels it (the export's own stop happens while saving)
    onPlaying(playing) {
      if (!playing && run && run.phase === 'playing') run.cancel();
    },
  };
}
