// One hosted plugin instance (one slot of one copy of a rack entry). The message thread creates, prepares and
// destroys it (Rack); the audio thread only calls process(), which is guarded so a faulting plugin is marked crashed
// and goes silent instead of taking the host down.
#pragma once
#include "platform.h"
#include <juce_audio_processors/juce_audio_processors.h>
#include <atomic>
#include <functional>

namespace jelly {

struct ParamChange { int offset, slot, param; float value; };

class Inst : private juce::AudioProcessorParameter::Listener, private juce::AudioProcessorListener {
public:
  static constexpr int kMaxBlock = 2048;

  Inst(std::unique_ptr<juce::AudioPluginInstance> plugin, bool synth);
  ~Inst() override;

  juce::AudioPluginInstance& plugin() { return *p; }
  void prepare(double rate);
  double preparedRate() const { return rate; }
  void setLabel(const juce::String& group, int slot, const juce::String& name);
  const char* label() const { return labelText; }

  // ---- audio thread ----
  // Runs the plugin over n frames of `stereo` (in place), splitting the block at the parameter changes for `slot`
  // (changes[0..count), any order; sorted here). midi may be null.
  void process(juce::AudioBuffer<float>& stereo, int n, juce::MidiBuffer* midi, ParamChange* changes, int count, int slot);
  int latency() const { return lat.load(std::memory_order_relaxed); }

  std::atomic<bool> crashed { false };
  std::atomic<int> debugCrash { 0 }; // tests: 1 = fault inside the guard, 2 = fault outside it (kills the host)

  // set by Rack; may be called from any thread
  std::function<void(int index, float value)> onParam;
  std::function<void(int index, bool starting)> onGesture;
  std::function<void()> onLatency;

private:
  void parameterValueChanged(int index, float value) override { if (onParam) onParam(index, value); }
  void parameterGestureChanged(int index, bool starting) override { if (onGesture) onGesture(index, starting); }
  void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override {}
  void audioProcessorChanged(juce::AudioProcessor*, const ChangeDetails& d) override {
    if (d.latencyChanged) {
      lat.store(p->getLatencySamples());
      if (onLatency) onLatency();
    }
  }
  bool runSegment(int start, int len, juce::MidiBuffer* midi);

  std::unique_ptr<juce::AudioPluginInstance> p;
  [[maybe_unused]] bool synth;
  double rate = 0;
  int channels = 2;
  juce::AudioBuffer<float> work;
  juce::MidiBuffer seg;
  std::atomic<int> lat { 0 };
  char labelText[256] {};
};

} // namespace jelly
