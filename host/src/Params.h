// Plugin parameters as code sees them: a camelCase key, the plugin's own name, and values in the parameter's own
// range as the plugin displays it ("-18 dB" is -18, "1.20 kHz" is 1200), not VST3's normalized 0..1.
//
// VST3 only reports normalized values plus a text for each, so the natural range is read back from the texts:
// min/max/default are the parsed texts at 0, 1 and the default. A code number is turned into a normalized value by
// the plugin's own text-to-value conversion when that round-trips, and otherwise by bisection over the texts
// (parameters are monotonic). Discrete parameters with non-numeric texts take an index or one of their choices.
// All of this calls into the plugin, so it runs on the message thread.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <vector>

namespace jelly {

struct ParamMeta {
  int index = 0;           // into AudioProcessor::getParameters()
  juce::String key, name;  // camelCase key, original name
  juce::String unit;       // canonical unit of min/max/def (Hz for kHz texts, ms for s/ms texts)
  double min = 0, max = 1, def = 0;
  int steps = 0;           // 0 = continuous
  juce::StringArray choices;
  bool numeric = false;    // texts parse as numbers
  bool numericChoices = false;
};

std::vector<ParamMeta> describeParams(juce::AudioPluginInstance&);
juce::var paramsToVar(const std::vector<ParamMeta>&);
const ParamMeta* findParam(const std::vector<ParamMeta>&, const juce::String& keyOrName);
juce::String camelKey(const juce::String& name);

// a code value (number, numeric string with unit, choice name, bool) -> normalized; false + err if not understood
bool toNormalized(juce::AudioProcessorParameter&, const ParamMeta&, const juce::var& value, float& out, juce::String& err);
// normalized -> the natural value code would write
double naturalValue(juce::AudioProcessorParameter&, const ParamMeta&, float normalized);

} // namespace jelly
