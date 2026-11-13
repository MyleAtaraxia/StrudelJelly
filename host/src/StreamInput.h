// One captured stereo stream from the app (one per route). The pipe thread writes blocks stamped with their
// AudioContext frame. The audio thread reads them back through an adaptive resampler that holds the buffer at a fixed
// fill (the stream latency). That absorbs pipe jitter, any AudioContext/device rate difference, and clock drift.
#pragma once
#include <atomic>
#include <cstdint>
#include <vector>

namespace jelly {

class StreamInput {
public:
  static constexpr int kChannels = 2;
  static constexpr int kCapacity = 1 << 17; // frames per channel, ~2.7 s at 48 kHz
  static constexpr int kMask = kCapacity - 1;

  StreamInput();

  // ---- pipe thread ----
  void write(double startFrame, int frames, int channels, int sampleRate, const float* planar);

  // ---- audio thread ----
  void prepare(double deviceRate);
  // Adds n device frames of this stream into out[0] and out[1]. hostStart is the engine's host sample of out[0][0].
  void render(float* const* out, int n, int64_t hostStart);
  // Source frame (AudioContext frame) that the next rendered device frame plays, and the current rate ratio
  // (source frames per device frame). Valid while playing().
  double readPos() const { return pos; }
  double currentRatio() const { return ratio; }
  bool isPlaying() const { return playing; }

  // ---- any thread ----
  void setTargetMs(double ms) { targetMs.store(ms); }
  double targetFrames() const;
  struct Stats {
    bool active = false, playing = false;
    int sampleRate = 0;
    double readPos = 0, writeEnd = 0, fill = 0, fillMin = 0, fillMax = 0, target = 0, ratio = 0, peak = 0;
    double arrivalGapMaxMs = 0; // longest wait between two blocks this period (pipe + renderer jitter)
    int64_t underruns = 0, overruns = 0, gaps = 0, received = 0, resets = 0, rewinds = 0;
  };
  Stats takeStats(); // also resets the per-period min, max and peak

  // Diagnostics for timing tests: the last onsets (a click after >= 50 ms of quiet), as the source frame where the
  // click starts and the host sample it was played at.
  struct Onset { double src; int64_t host; };
  static constexpr int kOnsets = 32;
  std::vector<Onset> recentOnsets() const;

private:
  std::vector<float> ring[kChannels];

  // written by the pipe thread
  std::atomic<int64_t> writeEnd { -1 };  // absolute source frame after the last written one
  std::atomic<int64_t> epochStart { 0 }; // first frame of the current run
  std::atomic<uint32_t> epoch { 0 };     // bumped when a new run starts (new AudioContext, new rate, long pause)
  std::atomic<int> srcRate { 0 };
  std::atomic<int64_t> gaps { 0 }, received { 0 }, resets { 0 }, rewinds { 0 };
  double lastArrival = 0;
  std::atomic<double> arrivalGapMax { 0 };
  std::atomic<double> targetMs { 30 };

  // audio thread state
  double devRate = 48000;
  uint32_t seenEpoch = 0xffffffff;
  bool playing = false;
  double pos = 0, fillAvg = 0, integ = 0, ratio = 1;
  int quiet = 0;
  Onset onsets[kOnsets] {};
  std::atomic<uint32_t> onsetCount { 0 };

  // published by the audio thread
  std::atomic<double> pubReadPos { 0 }, pubFill { 0 }, pubRatio { 1 };
  std::atomic<double> pubFillMin { 1e18 }, pubFillMax { 0 }, pubPeak { 0 };
  std::atomic<bool> pubPlaying { false };
  std::atomic<int64_t> underruns { 0 }, overruns { 0 }, prepares { 0 };
public:
  int64_t prepareCount() const { return prepares.load(); }
};

} // namespace jelly
