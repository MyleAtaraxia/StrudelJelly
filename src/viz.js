import { noteToMidi, freqToMidi } from '@strudel/core';

// Pianoroll strip under the code. While playing it is driven by StrudelMirror's draw loop (frame() once per animation
// frame). While stopped it shows the first cycles of the current pattern as a still picture, redrawn only when the
// pattern, size or theme changes. Nothing runs while it is hidden.
export const ZOOM_LEVELS = [0.5, 1, 2, 4, 8, 16, 32]; // cycles on screen
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
  let CYCLES = 4;
  let playing = false;
  let colors = {};
  let w = 0;
  let h = 0;
  // size the backing store to the element; also run before every draw, since ResizeObserver callbacks are skipped
  // while the window is not on screen
  function measure() {
    const r = window.devicePixelRatio || 1;
    const nw = Math.max(1, Math.round(canvas.clientWidth * r));
    const nh = Math.max(1, Math.round(canvas.clientHeight * r));
    if (nw !== w || nh !== h) {
      w = canvas.width = nw;
      h = canvas.height = nh;
    }
  }
  const ro = new ResizeObserver(() => {
    measure();
    if (visible && !playing) still();
  });

  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const v of VARS) colors[v] = cs.getPropertyValue(v).trim();
    if (visible && !playing) still();
  }

  // stopped: cycles 0..CYCLES from the left edge, playhead resting at the start
  function still() {
    draw(0, -Infinity, 0, 0.35);
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
    draw(now - CYCLES * PLAYHEAD, now, PLAYHEAD, 1);
  }

  function draw(from, now, headAt, headAlpha) {
    measure();
    if (w < 4 || h < 16) return; // not laid out yet; the ResizeObserver draws again once it is
    const to = from + CYCLES;
    let haps = [];
    try {
      haps = (scheduler().pattern?.queryArc(from, to) ?? []).filter((x) => x.whole);
    } catch (e) {
      console.warn('viz', e);
    }
    const r = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    // lanes: sounds without a pitch at the bottom, notes above them, low to high
    const lanes = [...new Set(haps.map((x) => laneOf(x.value)))].sort((a, b) =>
      typeof a === typeof b ? (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))) : typeof a === 'number' ? 1 : -1,
    );
    const laneH = Math.min(26 * r, (h - 8 * r) / Math.max(lanes.length, 1));
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
      ctx.roundRect(x, y + r, bw, Math.max(2 * r, laneH - 2 * r), Math.max(0, Math.min(4 * r, laneH / 2 - r)));
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    line(headAt * w, headAlpha);
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
      } else {
        ro.disconnect();
      }
    },
    setPlaying(p) {
      playing = p;
      strip.classList.toggle('playing', p);
      if (visible && !p) still();
    },
    setCycles(n) {
      CYCLES = n;
      if (visible && !playing) still();
    },
    // the pattern changed (evaluated while stopped)
    redraw() {
      if (visible && !playing) still();
    },
  };
}
