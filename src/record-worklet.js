// Audio export without the engine (src/record.js): passes what it hears between two AudioContext frames (the window,
// open until set) to the page in ~85 ms stereo chunks.
const CHUNK = 4096;

class JellyRecord extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.from = Infinity; // nothing until the window opens
    this.to = Infinity;
    this.fill = 0;
    this.l = new Float32Array(CHUNK);
    this.r = new Float32Array(CHUNK);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'window') {
        if (m.from != null) this.from = m.from;
        if (m.to != null) this.to = m.to;
      } else if (m.type === 'stop') {
        this.flush();
        this.on = false;
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  flush() {
    if (!this.fill) return;
    const l = this.l.slice(0, this.fill), r = this.r.slice(0, this.fill);
    this.port.postMessage({ type: 'chunk', l, r }, [l.buffer, r.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0];
    const n = ch[0]?.length ?? 128; // no channels while nothing plays: count it as silence
    const a = Math.max(0, Math.min(n, Math.ceil(this.from - currentFrame)));
    const b = Math.max(0, Math.min(n, Math.ceil(this.to - currentFrame)));
    for (let i = a; i < b; i++) {
      this.l[this.fill] = ch[0] ? ch[0][i] : 0;
      this.r[this.fill] = ch[1] ? ch[1][i] : ch[0] ? ch[0][i] : 0;
      if (++this.fill === CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('jelly-record', JellyRecord);
