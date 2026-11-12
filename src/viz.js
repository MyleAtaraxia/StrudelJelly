import { noteToMidi, freqToMidi, midi2note } from '@strudel/core';

// Piano roll panel. While playing it is driven by StrudelMirror's draw loop (frame() once per animation frame).
// While stopped it shows the first cycles of the current pattern as a still picture, redrawn only when the pattern,
// size or theme changes. Nothing runs while it is hidden.
//
// Every note is traced back to the code that made it: Strudel records the source positions of each event
// (hap.context.locations), so each note is assigned to its `$:` block (one colour per block, matching the bars in the
// editor gutter), rows are labelled, and hovering or clicking a note points at its code.
export const ZOOM_LEVELS = [0.5, 1, 2, 4, 8, 16, 32]; // cycles on screen
export const BLOCK_COLORS = ['--j-pink', '--j-sky', '--j-mint', '--j-lilac', '--j-butter', '--j-oat'];
const PLAYHEAD = 0.25; // playhead position while playing, 0..1 across the note area
const LABEL_W = 58; // css px
const VARS = [...BLOCK_COLORS, '--j-ink', '--j-edge', '--j-ground', '--j-panel', '--j-soft'];
const LABEL_RE = /^\s*([A-Za-z_$][\w$]*)\s*:(?!:)/; // `$:`, `bass:`, `_$:` ...

// lane key of a note: a midi number for pitched notes, '_' + sound name otherwise
function laneOf(value) {
  if (value === null || typeof value !== 'object') return typeof value === 'number' ? value : '_' + value;
  const { note, n, freq, s } = value;
  if (freq) return freqToMidi(freq);
  const x = note ?? (s ? undefined : n);
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    try { return noteToMidi(x); } catch { /* fall through to the sound name */ }
  }
  return s ? '_' + s : '_';
}
const laneLabel = (lane) => (typeof lane === 'number' ? midi2note(Math.round(lane)).toLowerCase() : lane.slice(1) || '?');

// Split evaluated code into pattern blocks. A block starts at a labelled line (`$:` or `name:`) and runs to the line
// before the next one, without trailing blank lines. Code without labels is one block.
export function patternBlocks(code) {
  const lines = code.split('\n');
  const starts = [];
  let off = 0;
  const blocks = [];
  lines.forEach((text, i) => {
    starts.push(off);
    if (LABEL_RE.test(text)) blocks.push({ start: off, fromLine: i + 1, label: text.match(LABEL_RE)[1] });
    off += text.length + 1;
  });
  const labelled = blocks.length > 0;
  if (!labelled) blocks.push({ start: 0, fromLine: 1, label: '' });
  blocks.forEach((b, i) => {
    let to = i + 1 < blocks.length ? blocks[i + 1].fromLine - 1 : lines.length;
    // trailing blank lines and comments (usually the title of the next block) are not part of it
    while (to > b.fromLine && (!lines[to - 1].trim() || /^\s*\/\//.test(lines[to - 1]))) to--;
    b.toLine = to;
    b.color = BLOCK_COLORS[i % BLOCK_COLORS.length];
  });
  return { blocks, labelled, lineStarts: starts };
}

export function createViz({ panel, strip, canvas, scheduler, onHover, onPick }) {
  const ctx = canvas.getContext('2d');
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  tip.dataset.testid = 'viz-tip';
  strip.append(tip);

  let visible = false;
  let CYCLES = 4;
  let playing = false;
  let colors = {};
  let w = 0;
  let h = 0;
  let src = { blocks: [{ start: 0, fromLine: 1, toLine: 1, label: '', color: BLOCK_COLORS[0] }], labelled: false, lineStarts: [0], code: '' };
  let rects = []; // drawn notes in css px, for hovering
  let mouse = null; // last pointer position over the canvas, css px
  let hovered = null;
  let hoverKey = '';

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

  // ---------- source mapping ----------
  const firstLoc = (hap) => {
    const locs = hap.context?.locations;
    if (!locs?.length) return null;
    return locs.reduce((a, b) => (b.start < a.start ? b : a));
  };
  function blockOf(hap) {
    const loc = firstLoc(hap);
    if (!loc) return src.labelled ? -1 : 0;
    let idx = 0;
    for (let i = 0; i < src.blocks.length; i++) if (src.blocks[i].start <= loc.start) idx = i;
    return idx;
  }
  function lineOf(offset) {
    let lo = 0;
    let hi = src.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (src.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  // ---------- drawing ----------
  // stopped: cycles 0..CYCLES from the left of the note area, playhead resting at the start
  function still() {
    draw(0, -Infinity, 0, 0.35);
  }
  function frame() {
    if (!visible || !playing) return;
    const now = scheduler().now();
    draw(now - CYCLES * PLAYHEAD, now, PLAYHEAD, 1);
  }

  function draw(from, now, headAt, headAlpha) {
    measure();
    if (w < 4 || h < 16) return; // not laid out yet; the ResizeObserver draws again once it is
    const r = window.devicePixelRatio || 1;
    let haps = [];
    try {
      haps = (scheduler().pattern?.queryArc(from, from + CYCLES) ?? []).filter((x) => x.whole);
    } catch (e) {
      console.warn('viz', e);
    }
    ctx.clearRect(0, 0, w, h);

    // rows: blocks in code order from the top; inside a block high notes on top, then unpitched sounds by name
    const byBlock = new Map();
    for (const hap of haps) {
      const b = blockOf(hap);
      const lane = laneOf(hap.value);
      hap._b = b;
      hap._lane = lane;
      if (!byBlock.has(b)) byBlock.set(b, new Set());
      byBlock.get(b).add(lane);
    }
    const rows = [];
    for (const b of [...byBlock.keys()].sort((x, y) => (x === -1 ? 1 : y === -1 ? -1 : x - y))) {
      const lanes = [...byBlock.get(b)].sort((x, y) =>
        typeof x === typeof y ? (typeof x === 'number' ? y - x : String(x).localeCompare(String(y))) : typeof x === 'number' ? -1 : 1,
      );
      for (const lane of lanes) rows.push({ b, lane });
    }
    const rowIndex = new Map(rows.map((row, i) => [row.b + '|' + row.lane, i]));
    const gaps = new Set(rows.map((row, i) => (i && rows[i - 1].b !== row.b ? i : -1)).filter((i) => i > 0));
    const gapH = 6 * r;
    const laneH = Math.min(26 * r, (h - 8 * r - gaps.size * gapH) / Math.max(rows.length, 1));
    const used = laneH * rows.length + gaps.size * gapH;
    const top = Math.max(4 * r, (h - used) / 2);
    const rowY = [];
    let y = top;
    rows.forEach((_, i) => {
      if (gaps.has(i)) y += gapH;
      rowY.push(y);
      y += laneH;
    });
    const lw = LABEL_W * r;
    const W = w - lw;
    const colorOf = (b) => colors[b === -1 ? '--j-oat' : src.blocks[b]?.color] || colors['--j-pink'];

    // notes
    rects = [];
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = colors['--j-edge'];
    for (const hap of haps) {
      const i = rowIndex.get(hap._b + '|' + hap._lane);
      const x = lw + ((hap.whole.begin - from) / CYCLES) * W;
      const bw = Math.max(3 * r, (hap.duration / CYCLES) * W - 2 * r);
      const ny = rowY[i] + r;
      const nh = Math.max(2 * r, laneH - 2 * r);
      if (x + bw < lw) continue;
      const active = hap.whole.begin <= now && hap.endClipped > now;
      const isHover = hoverKey !== '' && hoverKey === `${hap.whole.begin}|${hap._b}|${laneLabel(hap._lane)}`;
      ctx.globalAlpha = isHover ? 1 : (active ? 1 : 0.75) * Math.min(1, Math.max(0.4, (hap.value?.gain ?? 1) * (hap.value?.velocity ?? 1)));
      ctx.fillStyle = colorOf(hap._b);
      ctx.beginPath();
      ctx.roundRect(x, ny, bw, nh, Math.max(0, Math.min(4 * r, nh / 2)));
      ctx.fill();
      ctx.lineWidth = (isHover ? 3 : 1.5) * r;
      ctx.stroke();
      rects.push({ x: x / r, y: ny / r, w: bw / r, h: nh / r, hap, label: laneLabel(hap._lane), pitched: typeof hap._lane === 'number' });
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5 * r;

    // label column: a colour bar per block, and the row names
    ctx.fillStyle = colors['--j-panel'];
    ctx.fillRect(0, 0, lw, h);
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = colors['--j-soft'];
    ctx.beginPath();
    ctx.moveTo(lw - 0.5 * r, 0);
    ctx.lineTo(lw - 0.5 * r, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const fontPx = Math.min(12, laneH / r - 2);
    rows.forEach((row, i) => {
      const first = i === 0 || rows[i - 1].b !== row.b;
      const last = i === rows.length - 1 || rows[i + 1].b !== row.b;
      ctx.fillStyle = colorOf(row.b);
      ctx.beginPath();
      ctx.roundRect(8 * r, rowY[i] + (first ? r : 0), 5 * r, laneH - (first ? r : 0) - (last ? r : 0), [first ? 3 * r : 0, first ? 3 * r : 0, last ? 3 * r : 0, last ? 3 * r : 0]);
      ctx.fill();
      if (fontPx >= 7) {
        ctx.fillStyle = colors['--j-ink'];
        ctx.font = `800 ${fontPx * r}px Nunito, system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        let text = laneLabel(row.lane);
        while (text.length > 1 && ctx.measureText(text).width > lw - 22 * r) text = text.slice(0, -1);
        ctx.fillText(text, 18 * r, rowY[i] + laneH / 2);
      }
    });

    // dividers between blocks
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = colors['--j-edge'];
    for (const i of gaps) {
      const gy = rowY[i] - gapH / 2;
      ctx.beginPath();
      ctx.moveTo(lw, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // playhead
    ctx.globalAlpha = headAlpha;
    ctx.strokeStyle = colors['--j-edge'];
    ctx.lineWidth = 2.5 * r;
    ctx.beginPath();
    ctx.moveTo(lw + headAt * W, 0);
    ctx.lineTo(lw + headAt * W, h);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (mouse) hitTest();
  }

  // ---------- hover and click ----------
  function hitTest() {
    const hit = (mouse && rects.findLast((q) => mouse.x >= q.x && mouse.x <= q.x + q.w && mouse.y >= q.y && mouse.y <= q.y + q.h)) || null;
    const key = (q) => (q ? `${q.hap.whole.begin}|${q.hap._b}|${q.label}` : '');
    if (key(hit) !== key(hovered)) {
      // redraw once to outline the hovered note (only needed while stopped; playing redraws every frame anyway)
      hovered = hit;
      hoverKey = key(hit);
      onHover?.(hovered ? hovered.hap.context?.locations ?? [] : null, src.code);
      if (!playing) setTimeout(() => visible && !playing && still());
    } else {
      hovered = hit;
    }
    canvas.style.cursor = hovered ? 'pointer' : '';
    if (!hovered) {
      tip.hidden = true;
      return;
    }
    const v = hovered.hap.value ?? {};
    const loc = firstLoc(hovered.hap);
    const parts = [];
    if (loc) parts.push(`line ${lineOf(loc.start)}`);
    if (typeof v === 'object') {
      if (v.s) parts.push(v.bank ? `${v.s} (${v.bank})` : v.s);
      if (hovered.pitched) parts.push(hovered.label);
      else if (v.n !== undefined) parts.push(`n ${v.n}`);
    } else parts.push(String(v));
    tip.textContent = parts.join(' · ') || 'note';
    tip.hidden = false;
    const box = canvas.getBoundingClientRect();
    const sbox = strip.getBoundingClientRect();
    const tx = Math.min(box.left - sbox.left + mouse.x + 12, sbox.width - tip.offsetWidth - 8);
    const ty = box.top - sbox.top + mouse.y - tip.offsetHeight - 10;
    tip.style.left = Math.max(8, tx) + 'px';
    tip.style.top = (ty < 4 ? box.top - sbox.top + mouse.y + 16 : ty) + 'px';
  }
  canvas.addEventListener('pointermove', (e) => {
    const box = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - box.left, y: e.clientY - box.top };
    hitTest();
  });
  canvas.addEventListener('pointerleave', () => {
    mouse = null;
    hitTest();
  });
  canvas.addEventListener('click', () => {
    if (hovered) onPick?.(firstLoc(hovered.hap), src.code);
  });

  return {
    frame,
    refreshColors,
    // the code the current pattern was evaluated from (for blocks, colours and line numbers)
    setSource(code) {
      src = { ...patternBlocks(code), code };
      return src;
    },
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
