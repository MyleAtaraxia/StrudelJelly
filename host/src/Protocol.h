// Wire format between Electron (electron/vst/host.cjs) and jelly-host, over the host's stdin/stdout.
//
// Every frame:  u32 length (little endian, bytes after this field) | u8 kind | payload
//   kind 1  JSON  UTF-8 JSON object.
//               Electron -> host: commands  { "id": n, "cmd": "...", ... }
//               host -> Electron: replies   { "id": n, "ok": true, "result": ... } or { "id": n, "ok": false, "error": "..." }
//                                 events    { "event": "hello" | "stats" | "audio" | "log", ... }
//   kind 2  AUDIO (Electron -> host) one block of one capture stream:
//               u8 stream (0..7) | u8 channels | u8 flags (0) | u32 frames | u32 sampleRate | f64 startFrame
//               | f32 samples[channels * frames], planar (all of channel 0, then channel 1, ...)
//           startFrame is the AudioContext frame (currentFrame in the capture worklet) of the first sample, so
//           startFrame / sampleRate is AudioContext time. It is the shared clock: see Engine.h.
#pragma once
#include <cstdint>

namespace jelly::proto {
constexpr uint8_t kJson = 1;
constexpr uint8_t kAudio = 2;
constexpr uint32_t kAudioHeader = 20; // bytes from `kind` up to the first sample
constexpr uint32_t kMaxFrame = 16u << 20;
constexpr int kMaxStreams = 8;
} // namespace jelly::proto
