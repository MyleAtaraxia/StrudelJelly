// _scope() / _spectrum() on plugin audio. Those visuals read superdough's analysers[id], which only ever hear
// superdough's own output; sounds routed through plugins are played by the host. So for every analyze id seen on a
// routed hap, the host is asked to stream the waveform of the route's last node (where it reaches the speakers),
// and analysers[id] becomes a stand-in that answers from those samples.
import * as sd from 'superdough';
import { getAudioContext } from '@strudel/webaudio';

const api = window.jelly?.vst;
const EXPIRE_MS = 4000;
const taps = new Map(); // analyze id -> { key, size (fftSize), seen }
const latest = new Map(); // node key -> Float32Array (newest sample last)
let sent = '{}';

function sync() {
  const now = performance.now();
  const keys = {};
  for (const [id, t] of taps) {
    if (now - t.seen > EXPIRE_MS) {
      taps.delete(id);
      if (sd.analysers[id]?._jelly) delete sd.analysers[id];
      continue;
    }
    keys[t.key] = Math.max(keys[t.key] || 0, t.size);
  }
  const s = JSON.stringify(keys);
  if (s !== sent) {
    sent = s;
    api?._scopes?.(keys);
  }
}
if (api) setInterval(() => taps.size && sync(), 1000);

// a routed hap with .analyze(id) whose sound leaves the plugins at node `key`
export function noteScope(id, key, fft) {
  const size = 2 ** (Math.max(0, Math.min(10, Number(fft ?? 8) || 0)) + 5);
  const t = taps.get(id);
  if (t && t.key === key && t.size === size) {
    t.seen = performance.now();
    return;
  }
  taps.set(id, { key, size, seen: performance.now() });
  sync();
}

api?.onScope?.(({ key, data }) => {
  const bin = atob(data);
  const n = bin.length >> 1;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    f[i] = (v & 0x8000 ? v - 0x10000 : v) / 32767;
  }
  latest.set(key, f);
  for (const [id, t] of taps) if (t.key === key) install(id, t);
});

// (re)placed on every snapshot: superdough's resetGlobalEffects swaps the analysers object out
function install(id, t) {
  let a = sd.analysers[id];
  if (!a?._jelly || a.fftSize !== t.size) {
    a = new Stand(t.size);
    sd.analysers[id] = a;
    sd.analysersData[id] = new Float32Array(a.frequencyBinCount);
  }
  a.key = t.key;
}

class Stand {
  constructor(size) {
    this._jelly = true;
    this.context = getAudioContext();
    this.fftSize = size;
    this.frequencyBinCount = size / 2;
    this.smoothingTimeConstant = 0.5;
    this.key = null;
    this.spectrumOf = null;
    this.mag = new Float32Array(size / 2);
    this.db = new Float32Array(size / 2).fill(-Infinity);
  }
  samples() {
    return latest.get(this.key);
  }
  getFloatTimeDomainData(arr) {
    const src = this.samples();
    if (!src) return arr.fill(0);
    const n = Math.min(arr.length, src.length);
    arr.fill(0, 0, arr.length - n);
    arr.set(src.subarray(src.length - n), arr.length - n);
  }
  // as an AnalyserNode does it: Blackman window, magnitude / N, smoothed over time, in dB
  getFloatFrequencyData(arr) {
    const src = this.samples();
    if (src && src !== this.spectrumOf) {
      this.spectrumOf = src;
      const N = this.fftSize;
      const re = new Float32Array(N), im = new Float32Array(N);
      const off = src.length - N;
      for (let i = 0; i < N; i++) {
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N);
        re[i] = (off + i >= 0 ? src[off + i] : 0) * w;
      }
      fft(re, im);
      const k = this.smoothingTimeConstant;
      for (let i = 0; i < N / 2; i++) {
        this.mag[i] = k * this.mag[i] + (1 - k) * (Math.hypot(re[i], im[i]) / N);
        this.db[i] = 20 * Math.log10(this.mag[i]);
      }
    }
    arr.set(this.db.subarray(0, arr.length));
  }
}

// in-place radix-2 FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const p = i + j, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr;
        im[q] = im[p] - ti;
        re[p] += tr;
        im[p] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
