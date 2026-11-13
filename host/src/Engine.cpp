#include "Engine.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace jelly {

void StereoDelay::process(float* l, float* r, int n, int delay) {
  delay = juce::jlimit(0, kSize - Inst::kMaxBlock - 1, delay);
  if (delay == 0) {
    // keep the line current so a later delay starts from real audio
    for (int i = 0; i < n; ++i) {
      const auto at = (size_t) ((w + i) & kMask);
      buf[0][at] = l[i];
      buf[1][at] = r[i];
    }
    w += n;
    return;
  }
  for (int i = 0; i < n; ++i) {
    const auto at = (size_t) ((w + i) & kMask);
    const auto from = (size_t) ((w + i - delay) & kMask);
    buf[0][at] = l[i];
    buf[1][at] = r[i];
    l[i] = buf[0][from];
    r[i] = buf[1][from];
  }
  w += n;
}

Engine::Engine() {
  for (auto& s : streams) s = std::make_unique<StreamInput>();
  setStreamLatencyMs(latencyMs.load());
  pending.reserve(1 << 15);
}

void Engine::prepare(double sampleRate, int) {
  rate = sampleRate;
  for (auto& s : streams) s->prepare(sampleRate);
}

void Engine::setStreamLatencyMs(double ms) {
  latencyMs.store(ms);
  for (auto& s : streams) s->setTargetMs(ms);
}

std::unique_ptr<Plan> Engine::setPlan(std::unique_ptr<Plan> p) {
  const int l = p ? p->lmax : 0;
  {
    const juce::SpinLock::ScopedLockType lock(planLock);
    std::swap(plan, p);
  }
  lmax.store(l);
  return p;
}

void Engine::push(const Event* e, int count) {
  std::lock_guard<std::mutex> lock(pushLock);
  const auto w = fifo.write(count);
  for (int i = 0; i < w.blockSize1; ++i) ring[(size_t) (w.startIndex1 + i)] = e[i];
  for (int i = 0; i < w.blockSize2; ++i) ring[(size_t) (w.startIndex2 + i)] = e[w.blockSize1 + i];
}

void Engine::render(float* const* out, int numOut, int n) {
  for (int c = 0; c < numOut; ++c)
    if (out[c] != nullptr) std::memset(out[c], 0, sizeof(float) * (size_t) n);
  if (numOut < 1 || out[0] == nullptr) return;
  float* stereo[2] = { out[0], numOut > 1 && out[1] != nullptr ? out[1] : out[0] };
  for (int done = 0; done < n;) {
    const int len = std::min(n - done, Inst::kMaxBlock);
    float* part[2] = { stereo[0] + done, stereo[1] + done };
    renderChunk(part, len);
    done += len;
  }
}

void Engine::writeRecording(float* const* out, int n, double src, double ratio, bool valid, int delay) {
  const juce::SpinLock::ScopedTryLockType lock(recorderLock);
  if (!lock.isLocked() || writing == nullptr) return;
  const double from = recFrom.load(std::memory_order_relaxed), to = recTo.load(std::memory_order_relaxed);
  auto at = [&](double F) {
    if (F <= -kOpen) return 0;
    if (F >= kOpen) return n;
    if (!valid) return F < src ? 0 : n; // no clock yet: all or nothing
    return juce::jlimit(0, n, (int) std::ceil(sourceToBlockOffset(F, src, ratio) + delay));
  };
  const int a = at(from), b = at(to);
  if (b <= a) return;
  const float* in[2] = { out[0] + a, out[1] + a };
  if (writing->write(in, b - a)) recorded += b - a; // false only if the writer's buffer is full (the disk is far behind)
}

juce::String Engine::startRecording(const juce::File& file, double from) {
  stopRecording();
  file.deleteFile();
  std::unique_ptr<juce::OutputStream> os = std::make_unique<juce::FileOutputStream>(file);
  if (static_cast<juce::FileOutputStream*>(os.get())->failedToOpen()) return "could not write " + file.getFullPathName();
  juce::WavAudioFormat wav;
  const auto opts = juce::AudioFormatWriterOptions{}.withSampleRate(rate).withNumChannels(2).withBitsPerSample(24);
  auto w = wav.createWriterFor(os, opts);
  if (w == nullptr) return "could not write " + file.getFullPathName();
  writerThread.startThread();
  // ~10 s of slack before blocks are dropped
  recorder = std::make_unique<juce::AudioFormatWriter::ThreadedWriter>(w.release(), writerThread, (int) (rate * 10));
  const juce::SpinLock::ScopedLockType lock(recorderLock);
  recorded = 0;
  recFrom.store(from);
  recTo.store(kOpen);
  writing = recorder.get();
  return {};
}

double Engine::stopRecording() {
  int64_t frames = 0;
  {
    const juce::SpinLock::ScopedLockType lock(recorderLock);
    if (writing == nullptr) return 0;
    writing = nullptr;
    frames = recorded;
  }
  recorder.reset(); // flushes what is left and closes the file
  return (double) frames / rate;
}

void Engine::dispatch(Plan& p, int n, double src, double ratio, bool valid) {
  // drain the FIFO
  const auto rd = fifo.read(fifo.getNumReady());
  for (int i = 0; i < rd.blockSize1; ++i) if (pending.size() < pending.capacity()) pending.push_back(ring[(size_t) (rd.startIndex1 + i)]);
  for (int i = 0; i < rd.blockSize2; ++i) if (pending.size() < pending.capacity()) pending.push_back(ring[(size_t) (rd.startIndex2 + i)]);

  // a panic (stop) silences every synth now and drops the note-ons queued before it
  size_t lastPanic = SIZE_MAX;
  for (size_t i = 0; i < pending.size(); ++i) if (pending[i].type == evPanic) lastPanic = i;
  if (lastPanic != SIZE_MAX) {
    for (auto& node : p.nodes) {
      if (!node.synth) continue;
      for (int k = 0; k < 128; ++k) node.midi.addEvent(juce::MidiMessage::noteOff(1, k), 0);
      node.midi.addEvent(juce::MidiMessage::allNotesOff(1), 0);
      node.midi.addEvent(juce::MidiMessage::allSoundOff(1), 0);
    }
    size_t j = 0;
    for (size_t k = 0; k < pending.size(); ++k) {
      const auto t = pending[k].type;
      if (t == evPanic || (t == evNoteOn && k < lastPanic)) continue;
      pending[j++] = pending[k];
    }
    pending.resize(j);
  }

  size_t keep = 0;
  for (size_t i = 0; i < pending.size(); ++i) {
    Event& e = pending[i];
    const int ni = e.copy >= 0 && e.copy < (int) p.byCopy.size() ? p.byCopy[(size_t) e.copy] : -1;
    double off = valid ? sourceToBlockOffset(e.src, src, ratio) : 0.0;
    if (ni < 0) {
      // not in this plan (yet, or any more): keep it a while in case the plan catching up adds it
      if (off > -rate * 2) pending[keep++] = e;
      continue;
    }
    PlanNode& node = p.nodes[(size_t) ni];
    off += node.delay;
    if (e.type == evParam && e.slot >= 0 && e.slot < (int) node.slots.size()) off += node.slots[(size_t) e.slot].pre;
    if (off >= n) {
      pending[keep++] = e;
      continue;
    }
    const int at = juce::jlimit(0, n - 1, (int) std::floor(off));
    switch (e.type) {
      case evNoteOn: node.midi.addEvent(juce::MidiMessage::noteOn(1, e.a, (juce::uint8) std::max<int>(1, e.b)), at); break;
      case evNoteOff: node.midi.addEvent(juce::MidiMessage::noteOff(1, e.a), at); break;
      case evCC: node.midi.addEvent(juce::MidiMessage::controllerEvent(1, e.a, e.b), at); break;
      case evBend: node.midi.addEvent(juce::MidiMessage::pitchWheel(1, juce::jlimit(0, 16383, (int) e.value)), at); break;
      case evParam:
        if (node.numChanges < (int) node.changes.size()) node.changes[(size_t) node.numChanges++] = { at, e.slot, e.param, e.value };
        break;
      default: break;
    }
  }
  if (keep < pending.size()) pending.resize(keep);
}

static void storeMax(std::atomic<float>& a, float v) {
  float cur = a.load(std::memory_order_relaxed);
  while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}

void Engine::runNode(Plan& p, PlanNode& node, int n, float* const* out) {
  auto& buf = node.in;
  for (size_t s = 0; s < node.slots.size(); ++s) {
    auto& ps = node.slots[s];
    if (ps.inst == nullptr) {
      if (s == 0 && node.synth) buf.clear(0, n);
      continue;
    }
    if (ps.bypass) {
      // still take the parameter changes, so the plugin is where the pattern says when it comes back
      for (int i = 0; i < node.numChanges; ++i) {
        auto& c = node.changes[(size_t) i];
        if (c.slot != (int) s) continue;
        auto& prm = ps.inst->plugin().getParameters();
        if (c.param >= 0 && c.param < prm.size()) prm[c.param]->setValue(c.value);
      }
      if (s == 0 && node.synth) buf.clear(0, n);
      continue;
    }
    ps.inst->process(buf, n, s == 0 ? &node.midi : nullptr, node.changes.data(), node.numChanges, (int) s);
  }
  node.midi.clear();
  node.numChanges = 0;
  const float pl = buf.getMagnitude(0, 0, n), pr = buf.getMagnitude(1, 0, n);
  if (node.peak) {
    storeMax(node.peak[0], pl);
    storeMax(node.peak[1], pr);
  }
  if (node.tap && node.tap->load(std::memory_order_relaxed)) {
    const float* l = buf.getReadPointer(0);
    const float* r = buf.getReadPointer(1);
    int w = node.wavePos->load(std::memory_order_relaxed);
    for (int i = 0; i < n; ++i, w = (w + 1) & (PlanNode::kWave - 1)) node.wave[w] = 0.5f * (l[i] + r[i]);
    node.wavePos->store(w, std::memory_order_release);
  }
  if (node.next >= 0) {
    auto& dst = p.nodes[(size_t) node.next].in;
    dst.addFrom(0, 0, buf, 0, 0, n);
    dst.addFrom(1, 0, buf, 1, 0, n);
  } else {
    juce::FloatVectorOperations::add(out[0], buf.getReadPointer(0), n);
    if (out[1] != out[0]) juce::FloatVectorOperations::add(out[1], buf.getReadPointer(1), n);
  }
  buf.clear(0, n);
}

void Engine::debugRecord(int frames) {
  recOn.store(false);
  const juce::SpinLock::ScopedLockType lock(planLock);
  for (auto& r : rec) r.assign((size_t) std::max(0, frames), 0.0f);
  recPos = 0;
  recOn.store(frames > 0);
}

void Engine::renderChunk(float* const* out, int n) {
  const int64_t h = samples.load(std::memory_order_relaxed);
  StreamInput& s0 = *streams[0];
  const bool was = s0.isPlaying();
  const double src = s0.readPos();
  const double ratio = s0.currentRatio() > 0 ? s0.currentRatio() : 1.0;

  int delay0 = 0; // stream 0's delay: the rack's latency, which everything played is aligned to
  {
    const juce::SpinLock::ScopedLockType lock(planLock);
    Plan* p = plan.get();
    if (p != nullptr) delay0 = p->lmax;
    if (p != nullptr) dispatch(*p, n, src, ratio, was);
    else {
      // no rack: nothing to play the events
      const auto rd = fifo.read(fifo.getNumReady());
      (void) rd;
      pending.clear();
    }
    for (int i = 0; i < proto::kMaxStreams; ++i) {
      auto& st = *streams[(size_t) i];
      scratch.clear(0, n);
      float* sc[2] = { scratch.getWritePointer(0), scratch.getWritePointer(1) };
      st.render(sc, n, h);
      const int node = p != nullptr ? p->streamNode[(size_t) i] : -1;
      const int delay = p == nullptr ? 0 : node >= 0 ? p->streamDelay[(size_t) i] : p->lmax;
      if (p != nullptr && (i == 0 || node >= 0 || delay > 0)) delays[(size_t) i].process(sc[0], sc[1], n, delay);
      if (node >= 0) {
        auto& in = p->nodes[(size_t) node].in;
        in.addFrom(0, 0, scratch, 0, 0, n);
        in.addFrom(1, 0, scratch, 1, 0, n);
      } else {
        juce::FloatVectorOperations::add(out[0], sc[0], n);
        if (out[1] != out[0]) juce::FloatVectorOperations::add(out[1], sc[1], n);
        if (recOn.load(std::memory_order_relaxed))
          for (int k = 0; k < n && recPos + k < (int) rec[0].size(); ++k) rec[0][(size_t) (recPos + k)] += sc[0][k];
      }
    }
    if (p != nullptr) {
      const bool r = recOn.load(std::memory_order_relaxed);
      std::vector<float> before;
      if (r) before.assign(out[0], out[0] + n); // debug only: allocation is fine here
      for (auto& node : p->nodes) runNode(*p, node, n, out);
      if (r)
        for (int k = 0; k < n && recPos + k < (int) rec[1].size(); ++k) rec[1][(size_t) (recPos + k)] += out[0][k] - before[(size_t) k];
    }
    if (recOn.load(std::memory_order_relaxed)) {
      recPos += n;
      if (recPos >= (int) rec[0].size()) recOn.store(false);
    }
  }

  writeRecording(out, n, src, ratio, was, delay0);

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
