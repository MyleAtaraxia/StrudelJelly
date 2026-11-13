#include "Plugin.h"
#include <algorithm>
#include <cstring>

namespace jelly {

Inst::Inst(std::unique_ptr<juce::AudioPluginInstance> plugin, bool isSynth) : p(std::move(plugin)), synth(isSynth) {
  for (auto* prm : p->getParameters()) prm->addListener(this);
  p->addListener(this);
}

Inst::~Inst() {
  for (auto* prm : p->getParameters()) prm->removeListener(this);
  p->removeListener(this);
  Busy b(labelText);
  guard([this] { p->releaseResources(); });
  guard([this] { p.reset(); });
  p.release(); // if deleting it faulted, leak what is left rather than touch it again
}

void Inst::setLabel(const juce::String& group, int slot, const juce::String& name) {
  const auto s = (group + "\t" + juce::String(slot) + "\t" + name).toStdString();
  const size_t n = std::min(s.size(), sizeof labelText - 1);
  std::memcpy(labelText, s.data(), n);
  labelText[n] = 0;
}

void Inst::prepare(double r) {
  rate = r;
  Busy b(labelText);
  guard([this] {
    p->disableNonMainBuses();
    auto layout = p->getBusesLayout();
    if (layout.inputBuses.size() > 0) layout.inputBuses.getReference(0) = juce::AudioChannelSet::stereo();
    if (layout.outputBuses.size() > 0) layout.outputBuses.getReference(0) = juce::AudioChannelSet::stereo();
    if (p->checkBusesLayoutSupported(layout)) p->setBusesLayout(layout);
    p->setNonRealtime(false);
    p->prepareToPlay(rate, kMaxBlock);
  });
  channels = std::max({ 2, p->getTotalNumInputChannels(), p->getTotalNumOutputChannels() });
  work.setSize(channels, kMaxBlock, false, true, false);
  seg.ensureSize(8192);
  lat.store(p->getLatencySamples());
}

bool Inst::runSegment(int start, int len, juce::MidiBuffer* midi) {
  juce::AudioBuffer<float> view(work.getArrayOfWritePointers(), channels, start, len);
  juce::MidiBuffer* m = &seg;
  seg.clear();
  if (midi != nullptr) {
    for (const auto meta : *midi)
      if (meta.samplePosition >= start && meta.samplePosition < start + len)
        seg.addEvent(meta.data, meta.numBytes, meta.samplePosition - start);
  }
  auto* proc = p.get();
  const int crash = debugCrash.load(std::memory_order_relaxed);
  if (crash == 2) *(volatile int*) nullptr = 1; // tests: an unguarded fault
  return guard([&] {
    if (crash == 1) *(volatile int*) nullptr = 1; // tests: a fault inside the plugin call
    proc->processBlock(view, *m);
  });
}

void Inst::process(juce::AudioBuffer<float>& stereo, int n, juce::MidiBuffer* midi, ParamChange* changes, int count, int slot) {
  if (crashed.load(std::memory_order_relaxed)) {
    stereo.clear(0, n);
    return;
  }
  Busy b(labelText);
  const int inCh = p->getTotalNumInputChannels();
  for (int c = 0; c < channels; ++c) {
    if (c < 2 && c < inCh) work.copyFrom(c, 0, stereo, c, 0, n);
    else work.clear(c, 0, n);
  }
  // split the block where this slot's parameters change, so each change lands on its sample
  std::sort(changes, changes + count, [](const ParamChange& a, const ParamChange& b) { return a.offset < b.offset; });
  auto& params = p->getParameters();
  int pos = 0;
  bool ok = true;
  for (int i = 0; i < count && ok; ++i) {
    if (changes[i].slot != slot) continue;
    const int at = juce::jlimit(0, n - 1, changes[i].offset);
    if (at - pos >= 16) { // shorter pieces are not worth a separate call
      ok = runSegment(pos, at - pos, midi);
      pos = at;
    }
    if (changes[i].param >= 0 && changes[i].param < params.size()) params[changes[i].param]->setValue(changes[i].value);
  }
  if (ok && pos < n) ok = runSegment(pos, n - pos, midi);
  if (!ok) {
    crashed.store(true);
    stereo.clear(0, n);
    return;
  }
  const int outCh = p->getTotalNumOutputChannels();
  if (outCh <= 0) return; // nothing comes out: pass through
  stereo.copyFrom(0, 0, work, 0, 0, n);
  stereo.copyFrom(1, 0, work, outCh > 1 ? 1 : 0, 0, n);
}

} // namespace jelly
