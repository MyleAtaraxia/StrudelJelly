import { noteToMidi, freqToMidi, midi2note } from '@strudel/core';

// Piano roll panel. While playing it is driven by StrudelMirror's draw loop (frame() once per animation frame).
// While stopped it shows the pattern from cycle 0 as a still picture, redrawn only when the pattern, size, theme or
// view changes. Nothing runs while it is hidden.
//
// The view follows the playhead until the user pans it (drag, or Shift+wheel); follow() snaps back. The plain wheel
// scrolls the rows when they don't all fit. Rows are collected from everything seen since the pattern last changed,
// so they don't come and go as notes scroll in and out of view.
//
// Every note is traced back to the code that made it: Strudel records the source positions of each event
// (hap.context.locations), so each note is assigned to its `$:` block (one colour per block, matching the bars in the
// editor gutter), rows are labelled, and hovering or clicking a note points at its code.
export const ZOOM_LEVELS = [0.5, 1, 2, 4, 8, 16, 32]; // cycles on screen
export const ROW_ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3]; // row height, times the fitted height
export const BLOCK_COLORS = ['--j-pink', '--j-sky', '--j-mint', '--j-lilac', '--j-butter', '--j-oat'];
const PLAYHEAD = 0.25; // playhead position while playing, 0..1 across the note area
const LABEL_W = 58; // css px
const RULER_H = 18; // css px, cycle numbers along the top
const MIN_LANE = 16; // css px; below this the rows scroll instead of shrinking
const MAX_LANE = 26; // css px
const SCROLL_W = 12; // css px, the scrollbar's own strip on the right (only while the rows scroll)
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

export function createViz({ panel, strip, canvas, scheduler, onHover, onPick, onFollowChange }) {
  const ctx = canvas.getContext('2d');
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  tip.dataset.testid = 'viz-tip';
  strip.append(tip);

  let visible = false;
  let CYCLES = 4;
  let rowZoom = 1;
  let playing = false;
  let colors = {};
  let w = 0;
  let h = 0;
  let src = { blocks: [{ start: 0, fromLine: 1, toLine: 1, label: '', color: BLOCK_COLORS[0] }], labelled: false, lineStarts: [0], code: '' };
  let rects = []; // drawn notes in css px, for hovering
  let mouse = null; // last pointer position over the canvas, css px
  let hovered = null;
  let hoverKey = '';
  let follow = true; // keep the playhead in view (playing) or show from cycle 0 (stopped)
  let viewFrom = 0; // left edge in cycles while not following
  let shownFrom = 0; // left edge of the last drawn frame
  let scrollY = 0; // css px the rows are scrolled down by
  let maxScroll = 0;
  let seen = new Map(); // rows seen since the pattern changed: key -> { b, lane }
  let rowsStale = true;
  let drag = null;
  let dragged = false; // the last press was a drag, not a click on a note

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

  // ---------- view ----------
  function setFollow(on) {
    if (follow === on) return;
    follow = on;
    onFollowChange?.(on);
  }
  // stop following and keep the current view where it is
  function detach() {
    if (!follow) return;
    viewFrom = shownFrom;
    setFollow(false);
  }
  const noteWidthCss = () => Math.max(1, canvas.clientWidth - LABEL_W - (maxScroll > 0 ? SCROLL_W : 0));
  function panBy(px) {
    detach();
    viewFrom = Math.max(0, viewFrom + (px / noteWidthCss()) * CYCLES);
    if (!playing) still();
  }
  function scrollBy(px) {
    const next = Math.min(maxScroll, Math.max(0, Math.min(scrollY, maxScroll) + px));
    if (next === scrollY) return;
    scrollY = next;
    if (!playing) still();
  }

  // ---------- drawing ----------
  // stopped: from cycle 0 (or wherever the user panned to), playhead resting at cycle 0
  function still() {
    draw(follow ? 0 : viewFrom, -Infinity, 0, 0.35);
  }
  function frame() {
    if (!visible || !playing) return;
    const now = scheduler().now();
    // the playhead starts at the left edge and moves right until it reaches PLAYHEAD, then the notes scroll under it
    draw(follow ? Math.max(0, now - CYCLES * PLAYHEAD) : viewFrom, now, now, 1);
  }

  const query = (a, b) => {
    try {
      return (scheduler().pattern?.queryArc(a, b) ?? []).filter((x) => x.whole);
    } catch (e) {
      console.warn('viz', e);
      return [];
    }
  };
  function addRows(haps) {
    for (const hap of haps) {
      hap._b = blockOf(hap);
      hap._lane = laneOf(hap.value);
      const key = hap._b + '|' + hap._lane;
      if (!seen.has(key)) seen.set(key, { b: hap._b, lane: hap._lane });
    }
  }
  // rows: blocks in code order from the top; inside a block high notes on top, then unpitched sounds by name
  function sortedRows() {
    const byLane = (x, y) =>
      typeof x === typeof y ? (typeof x === 'number' ? y - x : String(x).localeCompare(String(y))) : typeof x === 'number' ? -1 : 1;
    const byBlock = (x, y) => (x === -1 ? 1 : y === -1 ? -1 : x - y);
    return [...seen.values()].sort((p, q) => (p.b !== q.b ? byBlock(p.b, q.b) : byLane(p.lane, q.lane)));
  }

  function draw(from, now, head, headAlpha) {
    measure();
    if (w < 4 || h < 16) return; // not laid out yet; the ResizeObserver draws again once it is
    const r = window.devicePixelRatio || 1;
    shownFrom = from;
    if (rowsStale) {
      // a new pattern: collect its rows from a longer stretch than is on screen, so they don't keep appearing
      seen = new Map();
      addRows(query(from, from + Math.max(8, CYCLES * 3)));
      rowsStale = seen.size === 0; // the new pattern may not be in place yet; try again next frame
    }
    const haps = query(from, from + CYCLES);
    addRows(haps);
    ctx.clearRect(0, 0, w, h);

    const rows = sortedRows();
    const rowIndex = new Map(rows.map((row, i) => [row.b + '|' + row.lane, i]));
    const gaps = new Set(rows.map((row, i) => (i && rows[i - 1].b !== row.b ? i : -1)).filter((i) => i > 0));
    const gapH = 6 * r;
    const rulerH = RULER_H * r;
    const avail = h - rulerH - 8 * r;
    const fit = (avail - gaps.size * gapH) / Math.max(rows.length, 1);
    const laneH = Math.min(MAX_LANE * r, Math.max(MIN_LANE * r, fit)) * rowZoom;
    const used = laneH * rows.length + gaps.size * gapH;
    maxScroll = Math.max(0, (used - avail) / r);
    // scrollY is only clamped by user scrolling, so a moment without rows (while a pattern swaps) doesn't reset it
    const sy = Math.min(scrollY, maxScroll);
    const top = rulerH + 4 * r + (used < avail ? (avail - used) / 2 : 0) - sy * r;
    const rowY = [];
    let y = top;
    rows.forEach((_, i) => {
      if (gaps.has(i)) y += gapH;
      rowY.push(y);
      y += laneH;
    });
    const lw = LABEL_W * r;
    const sw = maxScroll > 0 ? SCROLL_W * r : 0; // scrollbar strip
    const W = w - lw - sw;
    const xOf = (c) => lw + ((c - from) / CYCLES) * W;
    const colorOf = (b) => colors[b === -1 ? '--j-oat' : src.blocks[b]?.color] || colors['--j-pink'];
    // cycle numbers: every cycle, or every 2nd/4th/... when zoomed far out; quarter-cycle ticks when zoomed in
    const step = CYCLES <= 1 ? 0.25 : 2 ** Math.max(0, Math.ceil(Math.log2(CYCLES / 8)));
    const firstTick = Math.ceil(from / step - 1e-9) * step;

    // everything below the ruler is clipped to the note area, so scrolled rows slide under it
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rulerH, w, h - rulerH);
    ctx.clip();

    // grid: a faint line at each tick
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = colors['--j-edge'];
    ctx.lineWidth = r;
    for (let c = firstTick; c <= from + CYCLES; c += step) {
      ctx.beginPath();
      ctx.moveTo(Math.round(xOf(c)) + 0.5 * r, rulerH);
      ctx.lineTo(Math.round(xOf(c)) + 0.5 * r, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // notes
    rects = [];
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = colors['--j-edge'];
    for (const hap of haps) {
      const i = rowIndex.get(hap._b + '|' + hap._lane);
      const x = xOf(hap.whole.begin);
      const bw = Math.max(3 * r, (hap.duration / CYCLES) * W - 2 * r);
      const ny = rowY[i] + r;
      const nh = Math.max(2 * r, laneH - 2 * r);
      if (x + bw < lw || x > w - sw || ny + nh < rulerH || ny > h) continue;
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
      ctx.lineTo(w - sw, gy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // the scrollbar's strip: notes end at its edge instead of running under the scrollbar
    if (sw) {
      ctx.fillStyle = colors['--j-panel'];
      ctx.fillRect(w - sw, 0, sw, h);
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = colors['--j-soft'];
      ctx.lineWidth = r;
      ctx.beginPath();
      ctx.moveTo(w - sw + 0.5 * r, rulerH);
      ctx.lineTo(w - sw + 0.5 * r, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ruler
    ctx.fillStyle = colors['--j-panel'];
    ctx.fillRect(0, 0, w, rulerH);
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = colors['--j-soft'];
    ctx.lineWidth = r;
    ctx.beginPath();
    ctx.moveTo(0, rulerH - 0.5 * r);
    ctx.lineTo(w, rulerH - 0.5 * r);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors['--j-soft'];
    ctx.font = `700 ${10 * r}px Nunito, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (let c = firstTick; c <= from + CYCLES; c += step) {
      const x = Math.round(xOf(c));
      if (x < lw - 0.5 || x > w - sw - 2 * r) continue;
      const whole = Math.abs(c - Math.round(c)) < 1e-9;
      ctx.fillRect(x, whole ? 3 * r : rulerH - 5 * r, r, whole ? rulerH - 3 * r : 5 * r);
      if (whole) ctx.fillText(String(Math.round(c)), x + 4 * r, rulerH / 2);
    }

    // playhead (only when it is in view)
    const hx = xOf(head);
    if (hx >= lw - r && hx <= w - sw + r) {
      ctx.globalAlpha = headAlpha;
      ctx.strokeStyle = colors['--j-edge'];
      ctx.lineWidth = 2.5 * r;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // vertical scrollbar when the rows don't fit, styled like the app's scrollbars
    if (maxScroll > 0) {
      const trackH = h - rulerH - 4 * r;
      const thumbH = Math.max(20 * r, (trackH * avail) / used);
      const ty = rulerH + 2 * r + ((trackH - thumbH) * sy) / maxScroll;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = colors['--j-edge'];
      ctx.beginPath();
      ctx.roundRect(w - sw + 3.5 * r, ty, 5 * r, thumbH, 2.5 * r);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

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
    canvas.style.cursor = drag?.moved ? 'grabbing' : hovered ? 'pointer' : 'grab';
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
  // drag: sideways pans through time, up/down scrolls the rows
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, from: follow ? shownFrom : viewFrom, scroll: Math.min(scrollY, maxScroll), panning: false, moved: false };
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const box = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - box.left, y: e.clientY - box.top };
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = dragged = true;
        canvas.style.cursor = 'grabbing';
        tip.hidden = true;
      }
      if (!drag.moved) return;
      if (!drag.panning && Math.abs(dx) > 4) {
        drag.panning = true;
        detach();
      }
      if (drag.panning) viewFrom = Math.max(0, drag.from - (dx / noteWidthCss()) * CYCLES);
      scrollY = Math.min(maxScroll, Math.max(0, drag.scroll - dy));
      if (!playing) still();
      return;
    }
    hitTest();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = '';
    hitTest();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    mouse = null;
    hitTest();
  });
  canvas.addEventListener('click', () => {
    if (hovered && !dragged) onPick?.(firstLoc(hovered.hap), src.code);
  });
  // wheel scrolls the rows; Shift+wheel or a sideways touchpad swipe pans; Ctrl+wheel (zoom) is handled by the app
  canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.altKey) return; // zoom, handled by the app
    e.preventDefault();
    const px = e.deltaMode === 1 ? 16 : 1;
    const dx = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) * px;
    const dy = (e.shiftKey ? 0 : e.deltaY) * px;
    if (Math.abs(dx) > Math.abs(dy)) panBy(dx);
    else if (dy) scrollBy(dy);
  }, { passive: false });

  return {
    frame,
    refreshColors,
    // the code the current pattern was evaluated from (for blocks, colours and line numbers)
    setSource(code) {
      src = { ...patternBlocks(code), code };
      rowsStale = true;
      return src;
    },
    // follow the playhead again (stopped: back to cycle 0)
    follow() {
      setFollow(true);
      if (visible && !playing) still();
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
      // starting or stopping always goes back to following
      setFollow(true);
      strip.classList.toggle('playing', p);
      if (visible && !p) still();
    },
    // row height; anchorY (css px from the canvas top) keeps the row under the mouse in place
    setRowZoom(z, anchorY) {
      if (anchorY != null && rowZoom) {
        const off = Math.max(0, anchorY - RULER_H - 4);
        scrollY = Math.max(0, (Math.min(scrollY, maxScroll) + off) * (z / rowZoom) - off);
      }
      rowZoom = z;
      if (visible && !playing) still();
    },
    setCycles(n) {
      CYCLES = n;
      if (visible && !playing) still();
    },
    // the pattern changed (evaluated while stopped)
    redraw() {
      rowsStale = true;
      if (visible && !playing) still();
    },
  };
}
