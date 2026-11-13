// The audio engine: a pull-based graph. Whoever drives it calls render() for the next block of output and the
// engine pulls its sources. Today the only driver is the sound card callback (DeviceDriver in Main.cpp), but nothing
// here depends on device timing, so an offline driver can call render() in a loop to export faster than real time.
//
// Graph: capture streams 0..7 (StreamInput) and the rack's plugin chains (a Plan, built by Rack on the message
// thread and swapped in whole). Every rack entry copy is a node with exactly one destination (another node or the
// speakers), so the graph is a tree rooted at the speakers:
//   stream 0 (unrouted Strudel audio)         -> speakers
//   stream i (Strudel audio on one route)     -> its first node
//   synth nodes (MIDI from patterns)          -> their chain -> ... -> speakers
//
// ---- Timing: the shared clock ----
// Each capture stream is stamped with AudioContext frames (srcFrame = ctx.currentTime * ctx.sampleRate). The engine
// counts its own output in host samples (hostSample, from 0). Each stream holds its buffer at a fixed fill of
// `streamLatencyMs`, so AudioContext time t plays out of the engine streamLatencyMs after the app produced it, plus
// the device's own output latency (and the rack's plugin latency, below). That total is the `latencyMs` the app sees.
//
// Mapping an event stamped at source frame F: while rendering the block that starts at host sample h, stream 0
// reads from source frame P = readPos() at rate r = ratio() (source frames per host sample). The event lands at
// block offset (F - P) / r. If that is >= the block length it waits for a later block; if it is < 0 it is late and
// plays at offset 0. Because superdough's own audio for time t is exactly source frame F of the stream, VST notes
// and superdough line up sample for sample, drift included.
//
// ---- Latency compensation ----
// D(N) = plugin latency from node N's input to the speakers (its own chain plus every node after it). Lmax is the
// largest D. Whatever enters the tree at N (a stream's audio, a synth's MIDI) is delayed by Lmax - D(N), stream 0 by
// Lmax, so every path reaches the speakers Lmax samples late and they all stay aligned. A parameter change for
// slot s of node N is delayed the same way plus the latency of the slots before s, so it hits the audio it was
// timed against.
#pragma once
#include "Plugin.h"
#include "Protocol.h"
#include "StreamInput.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

namespace jelly {

enum EventType : uint8_t { evNoteOn = 1, evNoteOff, evCC, evParam, evPanic, evBend };
struct Event {
  int copy;       // Copy id (-1 = every synth node, for panic)
  uint8_t type;
  uint8_t a, b;   // note/velocity, cc/value
  int slot, param;
  float value;
  double src;     // source frame (AudioContext frame) it is timed at
};

struct PlanSlot {
  Inst* inst = nullptr; // null: plugin missing or off (passes audio through; a synth slot 0 is silent)
  bool bypass = false;
  int pre = 0;          // latency of the active slots before this one
};
struct PlanNode {
  int copy = -1;
  int next = -1;        // node index, -1 = speakers
  int delay = 0;        // Lmax - D(N): how much later than the clock things entering here are scheduled
  bool synth = false;
  std::vector<PlanSlot> slots;
  std::atomic<float>* peak = nullptr; // [2], owned by the Copy
  // waveform tap for _scope(), owned by the Copy: a mono ring the audio thread fills while tap is set
  static constexpr int kWave = 1 << 14;
  float* wave = nullptr;
  std::atomic<int>* wavePos = nullptr;
  std::atomic<bool>* tap = nullptr;
  juce::AudioBuffer<float> in;        // stereo, kMaxBlock
  juce::MidiBuffer midi;
  std::vector<ParamChange> changes;
  int numChanges = 0;
};
struct Plan {
  std::vector<PlanNode> nodes; // upstream nodes before downstream ones
  std::vector<int> byCopy;     // copy id -> node index or -1
  std::array<int, proto::kMaxStreams> streamNode {}; // -1: to the speakers
  std::array<int, proto::kMaxStreams> streamDelay {};
  int lmax = 0;
};

class StereoDelay {
public:
  static constexpr int kSize = 1 << 16, kMask = kSize - 1;
  StereoDelay() { for (auto& b : buf) b.assign(kSize, 0.0f); }
  void process(float* l, float* r, int n, int delay);
private:
  std::vector<float> buf[2];
  int64_t w = 0;
};

class Engine {
public:
  Engine();

  // Called by a driver before rendering, and again if the rate or block size changes.
  void prepare(double sampleRate, int maxBlockSize);
  double sampleRate() const { return rate; }
  // Renders the next n frames into out (numOut channels, overwritten). Real-time safe.
  void render(float* const* out, int numOut, int n);

  StreamInput& stream(int i) { return *streams[(size_t) i]; }
  void setStreamLatencyMs(double ms);
  double streamLatencyMs() const { return latencyMs.load(); }

  // Message thread: swap in a new plan; returns the old one, no longer in use by the audio thread.
  std::unique_ptr<Plan> setPlan(std::unique_ptr<Plan>);
  int planLatency() const { return lmax.load(); }
  // Any thread: queue timed events (MIDI, parameter changes) for the audio thread.
  void push(const Event* e, int count);

  // Host sample of the next block to render, and the clock reference taken at the start of the last block.
  int64_t hostSample() const { return samples.load(std::memory_order_relaxed); }
  struct ClockRef { int64_t hostSample; double srcFrame, ratio; bool valid; };
  ClockRef clockRef() const;
  // Offset into the block starting at blockSrc (stream read position) for an event at source frame F.
  static double sourceToBlockOffset(double F, double blockSrc, double ratio) { return (F - blockSrc) / ratio; }

private:
  void renderChunk(float* const* stereo, int n);
  void dispatch(Plan& plan, int n, double src, double ratio, bool valid);
  void runNode(Plan& plan, PlanNode& node, int n, float* const* out);

  std::array<std::unique_ptr<StreamInput>, proto::kMaxStreams> streams;
  std::array<StereoDelay, proto::kMaxStreams> delays;
  juce::AudioBuffer<float> scratch { 2, Inst::kMaxBlock };
  std::atomic<double> latencyMs { 30 }; // default stream latency, measured safe on WASAPI shared (see host stats)
  std::atomic<int64_t> samples { 0 };
  // clock reference, published by the audio thread under a sequence lock so readers never see a torn triple
  std::atomic<uint32_t> refSeq { 0 };
  std::atomic<int64_t> refHost { 0 };
  std::atomic<double> refSrc { 0 }, refRatio { 0 };
  std::atomic<bool> refValid { false };
  double rate = 48000;

  // plan: the audio thread holds planLock for a whole block; the message thread only to swap the pointer
  juce::SpinLock planLock;
  std::unique_ptr<Plan> plan;
  std::atomic<int> lmax { 0 };

  // events: producers serialize on pushLock, the audio thread reads the FIFO lock-free
  std::mutex pushLock;
  juce::AbstractFifo fifo { 1 << 14 };
  std::vector<Event> ring = std::vector<Event>(1 << 14);
  std::vector<Event> pending; // audio thread only

public:
  // Message thread: write the final stereo mix (what the speakers get) to a 24-bit WAV file until stopRecording.
  // Only audio inside the window [from, to) is written. Both ends are AudioContext frames, mapped to the output the
  // same way events are (stream 0's clock plus the rack's latency), so an export starts and ends on the exact sample
  // where a cycle does. The audio thread hands blocks to a background writer, so it never touches the disk.
  static constexpr double kOpen = 1e300;
  juce::String startRecording(const juce::File& file, double from = -kOpen);
  void setRecordingEnd(double to) { recTo.store(to); }
  double stopRecording(); // seconds written; 0 when not recording

private:
  juce::TimeSliceThread writerThread { "jelly-record" };
  std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> recorder; // message thread
  juce::SpinLock recorderLock;                                        // guards `writing` against the audio thread
  juce::AudioFormatWriter::ThreadedWriter* writing = nullptr;
  int64_t recorded = 0; // frames, under recorderLock
  std::atomic<double> recFrom { -kOpen }, recTo { kOpen };
  void writeRecording(float* const* out, int n, double src, double ratio, bool valid, int delay);

public:
  // tests (JELLY_HOST_DEBUG): record the output for a while, split into what superdough streams send to the
  // speakers directly (channel 0) and what plugin chains send (channel 1), left channel each
  void debugRecord(int frames);
  bool debugRecording() const { return recOn.load(); }
  std::vector<float> debugTake(int ch) { return rec[(size_t) ch]; }

private:
  std::atomic<bool> recOn { false };
  std::vector<float> rec[2];
  int recPos = 0;
};

} // namespace jelly
