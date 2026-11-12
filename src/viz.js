import { noteToMidi, freqToMidi } from '@strudel/core';

// Pianoroll strip under the code. It is driven by StrudelMirror's draw loop (frame() is called once per animation
// frame while playing) and does nothing at all while hidden or stopped.
const CYCLES = 4; // cycles on screen
const PLAYHEAD = 0.25; // playhead position, 0..1 from the left
const VARS = ['--j-pink', '--j-lilac', '--j-sky', '--j-ink', '--j-ground'];

function laneOf(value) {
  if (value === null || typeof value !== 'object') return value;
  const { note, n, freq, s } = value;
  if (freq) return freqToMidi(freq);
  const x = note ?? n;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    try { return noteToMidi(x); } catch { /* fall through to the sound name */ }
  }
  return s ? '_' + s : '_';
}

const hash = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

export function createViz({ panel, strip, canvas, scheduler }) {
  const ctx = canvas.getContext('2d');
  let visible = false;
  let playing = false;
  let colors = {};
  let w = 0;
  let h = 0;
  const ro = new ResizeObserver(() => {
    const r = window.devicePixelRatio || 1;
    w = Math.max(1, Math.round(canvas.clientWidth * r));
    h = Math.max(1, Math.round(canvas.clientHeight * r));
    canvas.width = w;
    canvas.height = h;
    if (visible) idle();
  });

  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const v of VARS) colors[v] = cs.getPropertyValue(v).trim();
    if (visible && !playing) idle();
  }

  function idle() {
    ctx.clearRect(0, 0, w, h);
    line(PLAYHEAD * w, 0.35);
  }
  function line(x, alpha = 1) {
    const r = window.devicePixelRatio || 1;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colors['--j-ink'];
    ctx.lineWidth = 2.5 * r;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function frame() {
    if (!visible || !playing) return;
    const now = scheduler().now();
    const from = now - CYCLES * PLAYHEAD;
    const to = now + CYCLES * (1 - PLAYHEAD);
    const haps = scheduler().pattern.queryArc(from, to).filter((x) => x.whole);
    const r = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    // lanes: sounds without a pitch at the bottom, notes above them, low to high
    const lanes = [...new Set(haps.map((x) => laneOf(x.value)))].sort((a, b) =>
      typeof a === typeof b ? (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))) : typeof a === 'number' ? 1 : -1,
    );
    const laneH = Math.min(14 * r, (h - 8 * r) / Math.max(lanes.length, 1));
    const used = laneH * lanes.length;
    const top = (h - used) / 2;
    const palette = [colors['--j-pink'], colors['--j-lilac'], colors['--j-sky']];
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = colors['--j-ink'];
    for (const hap of haps) {
      const lane = lanes.indexOf(laneOf(hap.value));
      const x = ((hap.whole.begin - from) / CYCLES) * w;
      const bw = Math.max(3 * r, (hap.duration / CYCLES) * w - 2 * r);
      const y = top + (lanes.length - 1 - lane) * laneH;
      const active = hap.whole.begin <= now && hap.endClipped > now;
      const key = typeof hap.value === 'object' ? (hap.value?.s ?? hap.value?.note ?? '') : hap.value;
      ctx.globalAlpha = (active ? 1 : 0.7) * Math.min(1, Math.max(0.35, (hap.value?.gain ?? 1) * (hap.value?.velocity ?? 1)));
      ctx.fillStyle = palette[Math.abs(hash(key)) % 3];
      ctx.beginPath();
      ctx.roundRect(x, y + r, bw, Math.max(2 * r, laneH - 2 * r), Math.min(4 * r, laneH / 2));
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    line(PLAYHEAD * w);
  }

  return {
    frame,
    refreshColors,
    setVisible(v) {
      visible = v;
      panel.classList.toggle('has-viz', v);
      strip.hidden = !v;
      if (v) {
        ro.observe(canvas);
        refreshColors();
        if (!playing) idle();
      } else {
        ro.disconnect();
      }
    },
    setPlaying(p) {
      playing = p;
      strip.classList.toggle('playing', p);
      if (visible && !p) idle();
    },
  };
}
