#include "Engine.h"
#include <cstring>

namespace jelly {

Engine::Engine() {
  for (auto& s : streams) s = std::make_unique<StreamInput>();
  setStreamLatencyMs(latencyMs.load());
}

void Engine::prepare(double sampleRate, int) {
  rate = sampleRate;
  for (auto& s : streams) s->prepare(sampleRate);
}

void Engine::setStreamLatencyMs(double ms) {
  latencyMs.store(ms);
  for (auto& s : streams) s->setTargetMs(ms);
}

void Engine::render(float* const* out, int numOut, int n) {
  for (int c = 0; c < numOut; ++c)
    if (out[c] != nullptr) std::memset(out[c], 0, sizeof(float) * (size_t) n);
  if (numOut < 1 || out[0] == nullptr) return;
  float* stereo[2] = { out[0], numOut > 1 && out[1] != nullptr ? out[1] : out[0] };

  const int64_t h = samples.load(std::memory_order_relaxed);
  StreamInput& s0 = *streams[0];
  const bool was = s0.isPlaying();
  const double src = s0.readPos();
  for (auto& s : streams) s->render(stereo, n, h);
  // the clock reference is where stream 0 read from at the start of this block
  refSeq.fetch_add(1, std::memory_order_acq_rel); // odd: writing
  if (was && s0.isPlaying()) {
    refHost.store(h, std::memory_order_relaxed);
    refSrc.store(src, std::memory_order_relaxed);
    refRatio.store(s0.currentRatio(), std::memory_order_relaxed);
  }
  refValid.store(s0.isPlaying(), std::memory_order_relaxed);
  refSeq.fetch_add(1, std::memory_order_release); // even: stable
  samples.store(h + n, std::memory_order_relaxed);
}

Engine::ClockRef Engine::clockRef() const {
  for (;;) {
    const uint32_t a = refSeq.load(std::memory_order_acquire);
    ClockRef r { refHost.load(std::memory_order_relaxed), refSrc.load(std::memory_order_relaxed),
                 refRatio.load(std::memory_order_relaxed), refValid.load(std::memory_order_relaxed) };
    std::atomic_thread_fence(std::memory_order_acquire);
    if (!(a & 1) && refSeq.load(std::memory_order_relaxed) == a) return r;
  }
}

} // namespace jelly
