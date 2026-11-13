// Framing for the jelly-host pipe (see host/src/Protocol.h for the full layout).
//   u32 length (LE, bytes after this field) | u8 kind | payload
//   kind 1 JSON: UTF-8 JSON. kind 2 AUDIO (to the host): u8 stream | u8 channels | u8 flags | u32 frames
//                | u32 sampleRate | f64 startFrame | f32 planar samples.
// Audio frames are built in the capture worklet (src/vst/engine/capture-worklet.js) and passed through untouched.
const JSON_KIND = 1;
const AUDIO_KIND = 2;
const AUDIO_HEADER = 20; // bytes from `kind` to the first sample

function encodeJson(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32LE(body.length + 1, 0);
  out[4] = JSON_KIND;
  body.copy(out, 5);
  return out;
}

// Streaming decoder: feed() chunks, get back complete JSON messages.
class Decoder {
  constructor(onJson) {
    this.onJson = onJson;
    this.buf = Buffer.alloc(0);
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) break;
      const kind = this.buf[4];
      const body = this.buf.subarray(5, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      if (kind === JSON_KIND) {
        try {
          this.onJson(JSON.parse(body.toString('utf8')));
        } catch {}
      }
    }
  }
}

module.exports = { JSON_KIND, AUDIO_KIND, AUDIO_HEADER, encodeJson, Decoder };
