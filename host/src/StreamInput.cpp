#include "StreamInput.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace jelly {

static void storeMin(std::atomic<double>& a, double v) {
  double cur = a.load(std::memory_order_relaxed);
  while (v < cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}
static void storeMax(std::atomic<double>& a, double v) {
  double cur = a.load(std::memory_order_relaxed);
  while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}

StreamInput::StreamInput() {
  for (auto& r : ring) r.assign(kCapacity, 0.0f);
}

void StreamInput::write(double startFrameD, int frames, int channels, int rate, const float* planar) {
  if (frames <= 0 || frames > kCapacity / 4 || rate <= 0 || channels <= 0) return;
  const int stride = frames; // planar: channel c starts at planar + c * stride
  auto start = (int64_t) std::llround(startFrameD);
  int64_t end = writeEnd.load(std::memory_order_relaxed);
  // frames we already have (Chromium sometimes renders a quantum twice): keep the timeline, drop the repeat
  int skip = 0;
  if (end >= 0 && start < end && end - start <= kCapacity / 4) {
    rewinds.fetch_add(1, std::memory_order_relaxed);
    if (end - start >= frames) return;
    skip = (int) (end - start);
    start = end;
    frames -= skip;
  }
  // a new AudioContext (frame counter went back), a new rate or a long pause: start a fresh run
  if (end < 0 || start < end || start - end > kCapacity / 2 || rate != srcRate.load(std::memory_order_relaxed)) {
    resets.fetch_add(1, std::memory_order_relaxed);
    srcRate.store(rate, std::memory_order_relaxed);
    epochStart.store(start, std::memory_order_relaxed);
    writeEnd.store(start, std::memory_order_relaxed);
    epoch.fetch_add(1, std::memory_order_release);
    end = start;
  }
  // frames Chromium skipped (it does, under load): silence, so the clock stays exact
  for (; end < start; ++end) {
    for (auto& r : ring) r[(size_t) (end & kMask)] = 0.0f;
    gaps.fetch_add(1, std::memory_order_relaxed);
  }
  for (int c = 0; c < kChannels; ++c) {
    const float* src = planar + (size_t) std::min(c, channels - 1) * (size_t) stride + skip;
    float* dst = ring[c].data();
    const auto at = (size_t) (start & kMask);
    const size_t first = std::min((size_t) frames, (size_t) kCapacity - at);
    std::memcpy(dst + at, src, first * sizeof(float));
    std::memcpy(dst, src + first, ((size_t) frames - first) * sizeof(float));
  }
  const double now = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
  if (lastArrival > 0) storeMax(arrivalGapMax, now - lastArrival);
  lastArrival = now;
  received.fetch_add(frames, std::memory_order_relaxed);
  writeEnd.store(start + frames, std::memory_order_release);
}

void StreamInput::prepare(double deviceRate) {
  prepares.fetch_add(1, std::memory_order_relaxed);
  devRate = deviceRate;
  playing = false; // re-buffer after a device change
  integ = 0;
}

double StreamInput::targetFrames() const {
  const int r = srcRate.load(std::memory_order_relaxed);
  return targetMs.load() * 0.001 * (r > 0 ? r : 48000);
}

void StreamInput::render(float* const* out, int n, int64_t hostStart) {
  const uint32_t ep = epoch.load(std::memory_order_acquire);
  const int64_t end = writeEnd.load(std::memory_order_acquire);
  if (end < 0) return;
  const int rate = srcRate.load(std::memory_order_relaxed);
  const double base = rate / devRate;
  const double target = targetFrames();

  if (ep != seenEpoch) {
    seenEpoch = ep;
    playing = false;
    pos = (double) epochStart.load(std::memory_order_relaxed);
    integ = 0;
  }

  double fill = (double) end - pos;
  if (!playing) {
    if (fill < target) { // still buffering
      pubPlaying.store(false, std::memory_order_relaxed);
      return;
    }
    if (fill > target * 1.5) pos = (double) end - target; // joined late: drop the excess instead of playing it fast
    fill = (double) end - pos;
    fillAvg = fill;
    playing = true;
  }
  if (fill > target * 4 + 8192 || fill > kCapacity / 2) { // far behind (device stalled): jump back to the target
    pos = (double) end - target;
    fill = target;
    fillAvg = fill;
    integ = 0;
    overruns.fetch_add(1, std::memory_order_relaxed);
  }

  // PI control of the playback rate, so the average fill sits at the target. The fill is a sawtooth (blocks arrive in
  // batches), so it is smoothed over ~1 s. Corrections stay within 0.5%, inaudible as pitch.
  const double dt = n / devRate;
  fillAvg += (fill - fillAvg) * (1.0 - std::exp(-dt / 1.0));
  const double err = (fillAvg - target) / rate; // seconds
  integ = std::clamp(integ + err * dt, -1.0, 1.0);
  const double corr = std::clamp(0.05 * err + 0.002 * integ, -0.005, 0.005);
  ratio = base * (1.0 + corr);

  // the 4-point interpolation reads up to frame pos + (n-1)*ratio + 2
  if (pos + (n - 1) * ratio + 2.0 >= (double) end) {
    playing = false;
    underruns.fetch_add(1, std::memory_order_relaxed);
    pubPlaying.store(false, std::memory_order_relaxed);
    return;
  }

  float peak = 0;
  const float* L = ring[0].data();
  const float* R = ring[1].data();
  double p = pos;
  for (int i = 0; i < n; ++i, p += ratio) {
    const auto i0 = (int64_t) std::floor(p);
    const float t = (float) (p - (double) i0);
    const auto a = (size_t) ((i0 - 1) & kMask), b = (size_t) (i0 & kMask);
    const auto c = (size_t) ((i0 + 1) & kMask), d = (size_t) ((i0 + 2) & kMask);
    auto herm = [t](float xm1, float x0, float x1, float x2) { // 4-point, 3rd-order Hermite
      const float c1 = 0.5f * (x1 - xm1);
      const float c2 = xm1 - 2.5f * x0 + 2.0f * x1 - 0.5f * x2;
      const float c3 = 0.5f * (x2 - xm1) + 1.5f * (x0 - x1);
      return ((c3 * t + c2) * t + c1) * t + x0;
    };
    const float l = herm(L[a], L[b], L[c], L[d]);
    const float r = herm(R[a], R[b], R[c], R[d]);
    out[0][i] += l;
    out[1][i] += r;
    const float amp = std::max(std::abs(l), std::abs(r));
    peak = std::max(peak, amp);
    if (amp > 0.02f) {
      if (quiet >= (int) (devRate * 0.05)) {
        const uint32_t k = onsetCount.load(std::memory_order_relaxed);
        onsets[k % kOnsets] = { p, hostStart + i };
        onsetCount.store(k + 1, std::memory_order_release);
      }
      quiet = 0;
    } else {
      ++quiet;
    }
  }
  pos += n * ratio;

  pubReadPos.store(pos, std::memory_order_relaxed);
  pubFill.store(fill, std::memory_order_relaxed);
  pubRatio.store(ratio, std::memory_order_relaxed);
  pubPlaying.store(true, std::memory_order_relaxed);
  storeMin(pubFillMin, fill);
  storeMax(pubFillMax, fill);
  storeMax(pubPeak, peak);
}

std::vector<StreamInput::Onset> StreamInput::recentOnsets() const {
  const uint32_t k = onsetCount.load(std::memory_order_acquire);
  std::vector<Onset> v;
  for (uint32_t i = k > (uint32_t) kOnsets ? k - kOnsets : 0; i < k; ++i) v.push_back(onsets[i % kOnsets]);
  return v;
}

StreamInput::Stats StreamInput::takeStats() {
  Stats s;
  const int64_t end = writeEnd.load(std::memory_order_acquire);
  s.active = end >= 0;
  s.playing = pubPlaying.load();
  s.sampleRate = srcRate.load();
  s.readPos = pubReadPos.load();
  s.writeEnd = (double) end;
  s.fill = pubFill.load();
  s.fillMin = pubFillMin.exchange(1e18);
  s.fillMax = pubFillMax.exchange(0);
  if (s.fillMin > 1e17) s.fillMin = 0;
  s.peak = pubPeak.exchange(0);
  s.target = targetFrames();
  s.ratio = pubRatio.load();
  s.underruns = underruns.load();
  s.overruns = overruns.load();
  s.gaps = gaps.load();
  s.received = received.load();
  s.resets = resets.load();
  s.rewinds = rewinds.load();
  s.arrivalGapMaxMs = arrivalGapMax.exchange(0);
  return s;
}

} // namespace jelly
