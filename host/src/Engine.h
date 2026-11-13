// The audio engine: a pull-based graph. Whoever drives it calls render() for the next block of output and the
// engine pulls its sources. Today the only driver is the sound card callback (DeviceDriver in Main.cpp), but nothing
// here depends on device timing, so an offline driver can call render() in a loop to export faster than real time.
//
// Graph today: capture streams 0..7 (StreamInput) -> sum -> output. Step 2 puts plugin chains between the streams
// and the output (juce::AudioProcessorGraph), still pulled from render().
//
// ---- Timing: the shared clock ----
// Each capture stream is stamped with AudioContext frames (srcFrame = ctx.currentTime * ctx.sampleRate). The engine
// counts its own output in host samples (hostSample, from 0). Each stream holds its buffer at a fixed fill of
// `streamLatencyMs`, so AudioContext time t plays out of the engine streamLatencyMs after the app produced it, plus
// the device's own output latency. That total is the `latencyMs` the app sees.
//
// Mapping a VST event stamped in AudioContext time t (step 2): convert to srcFrame F = t * ctxRate. While rendering
// the block that starts at host sample h, stream 0 reads from source frame P = readPos() at rate r = ratio()
// (source frames per host sample). The event lands at block offset (F - P) / r. If that is >= the block length it
// waits for a later block; if it is < 0 it is late and plays at offset 0. Because superdough's own audio for time t
// is exactly source frame F of the stream, VST notes and superdough line up sample for sample, drift included,
// as long as events arrive within streamLatencyMs of their time (Strudel schedules ~100 ms ahead, so they do).
// Engine::sourceToBlockOffset() implements this.
#pragma once
#include "Protocol.h"
#include "StreamInput.h"
#include <array>
#include <atomic>
#include <memory>

namespace jelly {

class Engine {
public:
  Engine();

  // Called by a driver before rendering, and again if the rate or block size changes.
  void prepare(double sampleRate, int maxBlockSize);
  // Renders the next n frames into out (numOut channels, overwritten). Real-time safe.
  void render(float* const* out, int numOut, int n);

  StreamInput& stream(int i) { return *streams[(size_t) i]; }
  void setStreamLatencyMs(double ms);
  double streamLatencyMs() const { return latencyMs.load(); }

  // Host sample of the next block to render, and the clock reference taken at the start of the last block.
  int64_t hostSample() const { return samples.load(std::memory_order_relaxed); }
  struct ClockRef { int64_t hostSample; double srcFrame, ratio; bool valid; };
  ClockRef clockRef() const;
  // Offset into the block starting at blockSrc (stream read position) for an event at source frame F.
  static double sourceToBlockOffset(double F, double blockSrc, double ratio) { return (F - blockSrc) / ratio; }

private:
  std::array<std::unique_ptr<StreamInput>, proto::kMaxStreams> streams;
  std::atomic<double> latencyMs { 30 }; // default stream latency, measured safe on WASAPI shared (see host stats)
  std::atomic<int64_t> samples { 0 };
  // clock reference, published by the audio thread under a sequence lock so readers never see a torn triple
  std::atomic<uint32_t> refSeq { 0 };
  std::atomic<int64_t> refHost { 0 };
  std::atomic<double> refSrc { 0 }, refRatio { 0 };
  std::atomic<bool> refValid { false };
  double rate = 48000;
};

} // namespace jelly
