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

juce::String textAt(juce::AudioProcessorParameter& p, float v) { return p.getText(v, 128); }

double numAt(juce::AudioProcessorParameter& p, const ParamMeta& m, float v) {
  const double x = canon(parse(textAt(p, v)), m.unit);
  return std::isfinite(x) ? x : (x < 0 ? -1e300 : x > 0 ? 1e300 : NaN);
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
    const int steps = p.getNumSteps();
    const bool discrete = p.isDiscrete() || p.isBoolean();
    m.steps = discrete && steps > 1 && steps < 0x7fffffff ? steps : 0;
    if (p.isBoolean() && m.steps == 0) m.steps = 2;

    // the canonical unit, from a spread of texts
    juce::StringArray units;
    for (int s = 0; s <= 10; ++s) {
      const auto r = parse(textAt(p, (float) s / 10.0f));
      if (r.ok && r.unit.isNotEmpty()) units.addIfNotAlreadyThere(r.unit.toLowerCase());
    }
    if (units.contains("hz") || units.contains("khz")) m.unit = "Hz";
    else if (units.contains("ms") || units.contains("msec")) m.unit = "ms";
    else m.unit = units.isEmpty() ? p.getLabel().trim() : parse(textAt(p, 0.5f)).unit;
    if (m.unit.isEmpty()) m.unit = p.getLabel().trim();

    if (m.steps > 0 && m.steps <= 128) {
      m.numericChoices = true;
      for (int s = 0; s < m.steps; ++s) {
        const auto t = textAt(p, (float) s / (float) (m.steps - 1));
        m.choices.add(t);
        m.numericChoices &= parse(t).ok;
      }
    }
    if (m.steps > 0 && !m.numericChoices) {
      m.numeric = false;
      m.min = 0;
      m.max = m.steps - 1;
      m.def = std::round(p.getDefaultValue() * (m.steps - 1));
    } else {
      const auto at = [&](float v) {
        double x = numAt(p, m, v);
        if (std::abs(x) >= 1e299) { // -inf dB and the like: report the nearest finite value
          const float in = v < 0.5f ? v + 0.001f : v - 0.001f;
          x = numAt(p, m, in);
        }
        return x;
      };
      const double a = at(0), b = at(1);
      m.numeric = std::isfinite(a) && std::isfinite(b) && std::abs(a) < 1e299 && std::abs(b) < 1e299;
      if (m.numeric) {
        m.min = std::min(a, b);
        m.max = std::max(a, b);
        const double d = numAt(p, m, p.getDefaultValue());
        m.def = std::isfinite(d) && std::abs(d) < 1e299 ? d : a;
      } else {
        m.min = 0;
        m.max = 1;
        m.def = p.getDefaultValue();
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
    const int idx = juce::jlimit(0, m.steps - 1, (int) std::lround(x));
    out = m.steps > 1 ? (float) idx / (float) (m.steps - 1) : 0.0f;
    return true;
  }
  if (m.steps > 0 && m.numericChoices) {
    int best = 0;
    double be = 1e300;
    for (int s = 0; s < m.choices.size(); ++s) {
      const double e = std::abs(canon(parse(m.choices[s]), m.unit) - x);
      if (e < be) { be = e; best = s; }
    }
    out = m.steps > 1 ? (float) best / (float) (m.steps - 1) : 0.0f;
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
  const float v = juce::jlimit(0.0f, 1.0f, p.getValueForText(juce::String(x)));
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
        out = m.steps > 1 ? (float) i / (float) (m.steps - 1) : 0.0f;
        return true;
      }
    const auto r = parse(s);
    if (r.ok && m.numeric) return fromNumber(p, m, canon(r, m.unit), out);
    if (r.ok && m.numericChoices) return fromNumber(p, m, canon(r, m.unit), out);
    const float v = juce::jlimit(0.0f, 1.0f, p.getValueForText(s));
    const auto t = textAt(p, v).trim();
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
  if (m.steps > 0 && !m.numericChoices) return std::round(v * (m.steps - 1));
  if (!m.numeric && !m.numericChoices) return v;
  const double x = numAt(p, m, v);
  if (std::isnan(x)) return m.min;
  return juce::jlimit(m.min, m.max, x);
}

} // namespace jelly
