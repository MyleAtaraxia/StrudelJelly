// AudioWorklet that captures the app's audio for jelly-host: one stereo stream per input (one input per route, up
// to 8). Every `batch` render quanta it posts one ArrayBuffer holding a ready-made AUDIO frame per active stream
// (layout in host/src/Protocol.h) on a MessagePort that leads straight to Electron's main process, so audio never
// waits on the renderer's main thread.
//
// Its output goes to Chromium's speakers and is inaudible but never exactly zero. If it were zero, Chromium would swap
// the sound card for a timer-driven fake sink after a few seconds of silence, and on Windows that fake sink runs at
// about 2/3 speed, starving the stream. setSinkId({ type: 'none' }) uses the same fake sink, so it is not used.
const HEADER = 24; // u32 length + 20 header bytes; samples start here (4-byte aligned)
const KEEP_ALIVE = 1e-20; // ~ -400 dBFS, far below the last bit of any output format

class JellyCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batch = options.processorOptions?.batch || 2;
    this.streams = options.numberOfInputs;
    this.out = null; // MessagePort to Electron main
    this.on = false;
    this.mask = 1; // streams to send, bit i = stream i; stream 0 always (it carries the clock)
    this.n = 0; // quanta in the current batch
    this.start = 0; // AudioContext frame of the batch's first sample
    this.stage = []; // per stream: planar [L..., R...] for a whole batch
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m?.type === 'port') this.out = m.port;
      else if (m?.type === 'streams') this.mask = m.mask | 1;
      else if (m?.type === 'enable') {
        this.on = !!m.on;
        this.n = 0;
        for (const st of this.stage) st?.fill(0);
      }
    };
  }

  flush(quantum) {
    const frames = this.n * quantum;
    const frameBytes = HEADER + frames * 2 * 4;
    let count = 0;
    for (let s = 0; s < this.streams; s++) if (this.mask & (1 << s)) count++;
    const ab = new ArrayBuffer(frameBytes * count);
    const dv = new DataView(ab);
    let at = 0;
    for (let s = 0; s < this.streams; s++) {
      if (!(this.mask & (1 << s))) continue;
      dv.setUint32(at, frameBytes - 4, true);
      dv.setUint8(at + 4, 2); // AUDIO
      dv.setUint8(at + 5, s);
      dv.setUint8(at + 6, 2); // channels
      dv.setUint32(at + 8, frames, true);
      dv.setUint32(at + 12, sampleRate, true);
      dv.setFloat64(at + 16, this.start, true);
      const st = this.stage[s];
      const half = st.length / 2;
      const out = new Float32Array(ab, at + HEADER, frames * 2);
      out.set(st.subarray(0, frames), 0);
      out.set(st.subarray(half, half + frames), frames);
      st.fill(0);
      at += frameBytes;
    }
    this.n = 0;
    // no transfer list: Electron hands transferred ArrayBuffers to the main process as null
    this.out.postMessage(ab);
  }

  process(inputs, outputs) {
    if (!this.on || !this.out) return true; // output stays zero: Chromium plays superdough itself (fallback)
    const o = outputs[0];
    for (let c = 0; c < o.length; c++) o[c].fill(c & 1 ? -KEEP_ALIVE : KEEP_ALIVE);
    const quantum = o[0]?.length || 128;
    // a block must be contiguous: Chromium occasionally skips or repeats a quantum, so close the batch there
    if (this.n > 0 && currentFrame !== this.start + this.n * quantum) this.flush(quantum);
    if (this.n === 0) this.start = currentFrame;
    for (let s = 0; s < this.streams; s++) {
      if (!(this.mask & (1 << s))) continue;
      let st = this.stage[s];
      if (st?.length !== quantum * this.batch * 2) st = this.stage[s] = new Float32Array(quantum * this.batch * 2);
      const input = inputs[s];
      if (!input?.length) continue; // nothing playing into it: Chromium passes no channels, the stage stays zero
      const half = st.length / 2;
      st.set(input[0], this.n * quantum);
      st.set(input[1] || input[0], half + this.n * quantum);
    }
    if (++this.n >= this.batch) this.flush(quantum);
    return true;
  }
}

registerProcessor('jelly-capture', JellyCapture);
