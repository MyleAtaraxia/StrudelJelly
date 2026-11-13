#include "Params.h"
#include <cmath>
#include <limits>

namespace jelly {

namespace {

constexpr double NaN = std::numeric_limits<double>::quiet_NaN();

struct Parsed {
  bool ok = false;
  double v = 0;
  juce::String unit; // as written, trimmed
};

// "-18.0 dB", "1.20 kHz", "+3", "50 %", "-inf dB". Anything else ("1/8 D", "L 50", "Off") is not numeric.
Parsed parse(juce::String t) {
  Parsed r;
  t = t.trim().replace(juce::String::fromUTF8("\xe2\x88\x92"), "-"); // unicode minus
  auto rest = t;
  double sign = 1;
  if (rest.startsWithChar('-')) { sign = -1; rest = rest.substring(1).trimStart(); }
  else if (rest.startsWithChar('+')) rest = rest.substring(1).trimStart();
  if (rest.startsWithIgnoreCase("inf") || rest.startsWith(juce::String::fromUTF8("\xe2\x88\x9e"))) {
    r.ok = true;
    r.v = sign * std::numeric_limits<double>::infinity();
    r.unit = rest.fromFirstOccurrenceOf(rest.startsWithIgnoreCase("inf") ? "inf" : juce::String::fromUTF8("\xe2\x88\x9e"), false, true).trim();
    return r;
  }
  int i = 0;
  const int n = rest.length();
  bool digits = false;
  while (i < n && (juce::CharacterFunctions::isDigit(rest[i]) || rest[i] == '.')) { digits |= rest[i] != '.'; ++i; }
  if (!digits) return r;
  if (i < n && (rest[i] == 'e' || rest[i] == 'E') && i + 1 < n && (juce::CharacterFunctions::isDigit(rest[i + 1]) || rest[i + 1] == '-')) {
    int j = i + 1;
    if (rest[j] == '-') ++j;
    while (j < n && juce::CharacterFunctions::isDigit(rest[j])) ++j;
    i = j;
  }
  const auto unit = rest.substring(i).trim();
  for (auto c : unit) // a unit is letters, %, degrees and spaces only
    if (!(juce::CharacterFunctions::isLetter(c) || c == '%' || c == ' ' || c == 0xb0)) return r;
  r.ok = true;
  r.v = sign * rest.substring(0, i).getDoubleValue();
  r.unit = unit;
  return r;
}

// value in the parameter's canonical unit, or NaN
double canon(const Parsed& p, const juce::String& base) {
  if (!p.ok) return NaN;
  const auto u = p.unit.toLowerCase();
  if (u == "khz") return p.v * 1000;
  const bool sec = u == "s" || u == "sec" || u == "secs" || u == "seconds";
  const bool ms = u == "ms" || u == "msec" || u == "msecs";
  if (sec && base == "ms") return p.v * 1000;
  if (ms && base == "s") return p.v / 1000;
  return p.v;
}

int tableIndex(float v) { return juce::jlimit(0, kTable - 1, (int) std::lround(v * (kTable - 1))); }

juce::String textAt(juce::AudioProcessorParameter& p, const ParamMeta& m, float v) {
  if (!m.table.empty()) return m.table[(size_t) tableIndex(v)];
  return p.getText(v, 128);
}

double finiteOrBig(double x) { return std::isfinite(x) ? x : (x < 0 ? -1e300 : x > 0 ? 1e300 : NaN); }

double numAt(juce::AudioProcessorParameter& p, const ParamMeta& m, float v) {
  if (!m.table.empty()) {
    // between two table points: linear between their numbers, so bisection still lands between them
    const float x = juce::jlimit(0.0f, 1.0f, v) * (kTable - 1);
    const int i = juce::jlimit(0, kTable - 2, (int) std::floor(x));
    const double a = finiteOrBig(canon(parse(m.table[(size_t) i]), m.unit));
    const double b = finiteOrBig(canon(parse(m.table[(size_t) i + 1]), m.unit));
    const float f = x - (float) i;
    if (std::isnan(a) || std::isnan(b) || std::abs(a) >= 1e299 || std::abs(b) >= 1e299) return f < 0.5f ? a : b;
    return a + (b - a) * f;
  }
  return finiteOrBig(canon(parse(textAt(p, m, v)), m.unit));
}

// VST2: the plugin's display for each table point, read by moving the knob on a fresh instance and putting it back
void sampleTable(juce::AudioProcessorParameter& p, ParamMeta& m) {
  const float was = p.getValue();
  const auto label = p.getLabel().trim();
  m.table.resize(kTable);
  juce::StringArray bulk;
  if (auto* src = dynamic_cast<TextTableSource*>(&p)) bulk = src->textTable(kTable);
  if (bulk.size() == kTable) {
    for (int k = 0; k < kTable; ++k) {
      auto t = bulk[k].trim();
      if (label.isNotEmpty() && !t.endsWithIgnoreCase(label)) t << " " << label;
      m.table[(size_t) k] = t;
    }
    return;
  }
  for (int k = 0; k < kTable; ++k) {
    p.setValue((float) k / (float) (kTable - 1));
    auto t = p.getCurrentValueAsText().trim();
    if (label.isNotEmpty() && !t.endsWithIgnoreCase(label)) t << " " << label;
    m.table[(size_t) k] = t;
  }
  p.setValue(was);
}

// a choice's normalized value, and the choice a normalized value falls in
float choiceValue(const ParamMeta& m, int i) {
  if (!m.choiceAt.empty()) return m.choiceAt[(size_t) juce::jlimit(0, (int) m.choiceAt.size() - 1, i)];
  return m.steps > 1 ? (float) i / (float) (m.steps - 1) : 0.0f;
}
int choiceIndex(const ParamMeta& m, float v) {
  if (m.choiceAt.empty()) return (int) std::round(v * (m.steps - 1));
  int best = 0;
  for (int i = 1; i < (int) m.choiceAt.size(); ++i)
    if (std::abs(m.choiceAt[(size_t) i] - v) < std::abs(m.choiceAt[(size_t) best] - v)) best = i;
  return best;
}

// VST2 text lookup (there is no plugin text parser to call): the middle of the table points showing this text
float textSearch(const ParamMeta& m, const juce::String& s) {
  int a = -1, b = -1;
  for (int k = 0; k < kTable; ++k) {
    const auto t = m.table[(size_t) k].trim();
    if (t.equalsIgnoreCase(s) || t.startsWithIgnoreCase(s)) { if (a < 0) a = k; b = k; }
  }
  return a < 0 ? 0.0f : (float) (a + b) / 2.0f / (float) (kTable - 1);
}

float bisect(juce::AudioProcessorParameter& p, const ParamMeta& m, double x) {
  float lo = 0, hi = 1;
  const double a = numAt(p, m, 0), b = numAt(p, m, 1);
  const bool up = !(b < a);
  for (int it = 0; it < 28; ++it) {
    const float mid = 0.5f * (lo + hi);
    const double vm = numAt(p, m, mid);
    const bool below = std::isnan(vm) || (up ? vm < x : vm > x);
    (below ? lo : hi) = mid;
  }
  const double el = std::abs(numAt(p, m, lo) - x), eh = std::abs(numAt(p, m, hi) - x);
  return el < eh ? lo : hi;
}

} // namespace

juce::String camelKey(const juce::String& name) {
  juce::String out;
  bool up = false;
  for (auto c : name) {
    if (juce::CharacterFunctions::isLetterOrDigit(c) && c < 128) {
      if (out.isEmpty()) out << juce::String::charToString(juce::CharacterFunctions::toLowerCase(c));
      else out << juce::String::charToString(up ? juce::CharacterFunctions::toUpperCase(c) : c);
      up = false;
    } else {
      up = true;
    }
  }
  // an all-caps word ("LFO Rate") reads better as lfoRate
  if (out.length() > 1 && out.substring(0, 2).toUpperCase() == out.substring(0, 2) && juce::CharacterFunctions::isLetter(out[1])) {
    int i = 1;
    while (i < out.length() && juce::CharacterFunctions::isUpperCase(out[i]) && !(i + 1 < out.length() && juce::CharacterFunctions::isLowerCase(out[i + 1]))) ++i;
    out = out.substring(0, i).toLowerCase() + out.substring(i);
  }
  if (out.isEmpty()) out = "param";
  if (juce::CharacterFunctions::isDigit(out[0])) out = "p" + out;
  return out;
}

std::vector<ParamMeta> describeParams(juce::AudioPluginInstance& inst) {
  std::vector<ParamMeta> out;
  const bool vst2 = inst.getPluginDescription().pluginFormatName == "VST";
  const auto& ps = inst.getParameters();
  bool anyAutomatable = false;
  for (auto* p : ps) anyAutomatable |= p->isAutomatable();
  std::map<juce::String, int> used;
  for (int i = 0; i < ps.size(); ++i) {
    auto& p = *ps[i];
    const auto name = p.getName(128).trim();
    if ((anyAutomatable && !p.isAutomatable()) || name.startsWith("MIDI CC")) continue;
    ParamMeta m;
    m.index = i;
    m.name = name;
    auto key = camelKey(name);
    if (int k = ++used[key]; k > 1) key << k;
    m.key = key;
    // VST2 has no default of its own: where the knob sits on a freshly loaded plugin
    const float start = vst2 ? p.getValue() : p.getDefaultValue();
    if (vst2) sampleTable(p, m);
    const int steps = p.getNumSteps();
    const bool discrete = p.isDiscrete() || p.isBoolean();
    m.steps = discrete && steps > 1 && steps < 0x7fffffff ? steps : 0;
    if (p.isBoolean() && m.steps == 0) m.steps = 2;

    // the canonical unit, from a spread of texts
    juce::StringArray units;
    for (int s = 0; s <= 10; ++s) {
      const auto r = parse(textAt(p, m, (float) s / 10.0f));
      if (r.ok && r.unit.isNotEmpty()) units.addIfNotAlreadyThere(r.unit.toLowerCase());
    }
    if (units.contains("hz") || units.contains("khz")) m.unit = "Hz";
    else if (units.contains("ms") || units.contains("msec")) m.unit = "ms";
    else m.unit = units.isEmpty() ? p.getLabel().trim() : parse(textAt(p, m, 0.5f)).unit;
    if (m.unit.isEmpty()) m.unit = p.getLabel().trim();

    if (m.steps > 0 && m.steps <= 128) {
      m.numericChoices = true;
      for (int s = 0; s < m.steps; ++s) {
        const auto t = textAt(p, m, (float) s / (float) (m.steps - 1));
        m.choices.add(t);
        m.numericChoices &= parse(t).ok;
      }
    }
    if (vst2 && m.steps == 0) {
      // VST2 has no step count: a parameter whose texts are a few words ("Off", "16 bit") is a choice
      juce::StringArray seen;
      std::vector<std::pair<int, int>> span; // first and last table index of each text, in order
      bool allNumeric = true;
      for (int k = 0; k < kTable && seen.size() <= 64; ++k) {
        const auto& t = m.table[(size_t) k];
        allNumeric &= parse(t).ok;
        if (seen.isEmpty() || seen[seen.size() - 1] != t) { seen.add(t); span.push_back({ k, k }); }
        else span.back().second = k;
      }
      if (!allNumeric && seen.size() >= 2 && seen.size() <= 64) {
        m.steps = seen.size();
        m.choices = seen;
        for (auto& [a, b] : span) m.choiceAt.push_back((float) (a + b) / 2.0f / (float) (kTable - 1));
      }
    }
    if (m.steps > 0 && !m.numericChoices) {
      m.numeric = false;
      m.min = 0;
      m.max = m.steps - 1;
      m.def = choiceIndex(m, start);
    } else {
      const auto at = [&](float v) {
        double x = numAt(p, m, v);
        // -inf dB and the like: report the nearest finite value (a whole table point in, where there is a table)
        const float step = m.table.empty() ? 0.001f : 1.0f / (float) (kTable - 1);
        for (int k = 1; k <= 8 && std::abs(x) >= 1e299; ++k) x = numAt(p, m, v < 0.5f ? v + (float) k * step : v - (float) k * step);
        return x;
      };
      const double a = at(0), b = at(1);
      m.numeric = std::isfinite(a) && std::isfinite(b) && std::abs(a) < 1e299 && std::abs(b) < 1e299;
      if (m.numeric) {
        m.min = std::min(a, b);
        m.max = std::max(a, b);
        const double d = numAt(p, m, start);
        m.def = std::isfinite(d) && std::abs(d) < 1e299 ? d : a;
      } else {
        m.min = 0;
        m.max = 1;
        m.def = start;
        m.unit = {};
      }
    }
    out.push_back(std::move(m));
  }
  return out;
}

static juce::var num(double v) { return std::isfinite(v) ? juce::var(v) : juce::var(0.0); }

juce::var paramsToVar(const std::vector<ParamMeta>& ps) {
  juce::Array<juce::var> arr;
  for (auto& m : ps) {
    auto* o = new juce::DynamicObject();
    o->setProperty("index", m.index);
    o->setProperty("key", m.key);
    o->setProperty("name", m.name);
    o->setProperty("min", num(m.min));
    o->setProperty("max", num(m.max));
    o->setProperty("def", num(m.def));
    o->setProperty("unit", m.unit);
    o->setProperty("steps", m.steps);
    if (!m.choices.isEmpty()) {
      juce::Array<juce::var> c;
      for (auto& s : m.choices) c.add(s);
      o->setProperty("choices", c);
    }
    arr.add(juce::var(o));
  }
  return arr;
}

const ParamMeta* findParam(const std::vector<ParamMeta>& ps, const juce::String& k) {
  for (auto& m : ps) if (m.key == k) return &m;
  for (auto& m : ps) if (m.name == k) return &m;
  for (auto& m : ps) if (m.name.equalsIgnoreCase(k.trim())) return &m;
  const auto ck = camelKey(k);
  for (auto& m : ps) if (m.key.equalsIgnoreCase(ck)) return &m;
  return nullptr;
}

static bool fromNumber(juce::AudioProcessorParameter& p, const ParamMeta& m, double x, float& out) {
  if (m.steps > 0 && !m.numericChoices) {
    out = choiceValue(m, juce::jlimit(0, m.steps - 1, (int) std::lround(x)));
    return true;
  }
  if (m.steps > 0 && m.numericChoices) {
    int best = 0;
    double be = 1e300;
    for (int s = 0; s < m.choices.size(); ++s) {
      const double e = std::abs(canon(parse(m.choices[s]), m.unit) - x);
      if (e < be) { be = e; best = s; }
    }
    out = choiceValue(m, best);
    return true;
  }
  if (!m.numeric) {
    out = (float) juce::jlimit(0.0, 1.0, x);
    return true;
  }
  x = juce::jlimit(m.min, m.max, x);
  const float b = bisect(p, m, x);
  const double eb = std::abs(numAt(p, m, b) - x);
  // the plugin's own parser is exact where the texts are rounded; use it when it lands at least as close
  const float v = m.table.empty() ? juce::jlimit(0.0f, 1.0f, p.getValueForText(juce::String(x))) : b;
  const double ev = std::abs(numAt(p, m, v) - x);
  out = std::isfinite(ev) && ev <= eb + 1e-9 ? v : b;
  return true;
}

bool toNormalized(juce::AudioProcessorParameter& p, const ParamMeta& m, const juce::var& value, float& out, juce::String& err) {
  if (value.isBool()) {
    out = (bool) value ? 1.0f : 0.0f;
    return true;
  }
  if (value.isInt() || value.isDouble() || value.isInt64()) return fromNumber(p, m, (double) value, out);
  if (value.isString()) {
    const auto s = value.toString().trim();
    for (int i = 0; i < m.choices.size(); ++i)
      if (m.choices[i].trim().equalsIgnoreCase(s)) {
        out = choiceValue(m, i);
        return true;
      }
    const auto r = parse(s);
    if (r.ok && m.numeric) return fromNumber(p, m, canon(r, m.unit), out);
    if (r.ok && m.numericChoices) return fromNumber(p, m, canon(r, m.unit), out);
    const float v = m.table.empty() ? juce::jlimit(0.0f, 1.0f, p.getValueForText(s)) : textSearch(m, s);
    const auto t = textAt(p, m, v).trim();
    if (t.equalsIgnoreCase(s) || t.containsIgnoreCase(s) || (t.isNotEmpty() && s.containsIgnoreCase(t))) {
      out = v;
      return true;
    }
    err = "\"" + s + "\" is not a value of " + m.name + (m.choices.isEmpty() ? juce::String() : " (" + m.choices.joinIntoString(", ") + ")");
    return false;
  }
  err = "unsupported value for " + m.name;
  return false;
}

double naturalValue(juce::AudioProcessorParameter& p, const ParamMeta& m, float v) {
  if (m.steps > 0 && !m.numericChoices) return choiceIndex(m, v);
  if (!m.numeric && !m.numericChoices) return v;
  const double x = numAt(p, m, v);
  if (std::isnan(x)) return m.min;
  return juce::jlimit(m.min, m.max, x);
}

juce::String paramText(juce::AudioProcessorParameter& p, const ParamMeta& m, float v) { return textAt(p, m, v); }

} // namespace jelly
