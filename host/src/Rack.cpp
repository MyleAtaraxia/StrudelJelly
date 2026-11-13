#include "Rack.h"
#include "Bridge.h"
#include "Pipe.h"
#include <algorithm>
#include <cmath>
#include <set>

namespace jelly {

static juce::var obj(std::initializer_list<std::pair<const char*, juce::var>> kv) {
  auto* o = new juce::DynamicObject();
  for (auto& [k, v] : kv) o->setProperty(k, v);
  return juce::var(o);
}

// ---------- editor windows ----------
class Rack::EditorWindow : public juce::DocumentWindow {
public:
  EditorWindow(const juce::String& title, juce::AudioProcessorEditor* ed, Inst* i, std::function<void(EditorWindow*)> close)
      : DocumentWindow(title, juce::Colours::black, DocumentWindow::closeButton | DocumentWindow::minimiseButton), inst(i), onClose(std::move(close)) {
    setUsingNativeTitleBar(true);
    setContentOwned(ed, true);
    setResizable(ed->isResizable(), false);
    centreWithSize(getWidth(), getHeight());
    setVisible(true);
    toFront(true);
  }
  void closeButtonPressed() override { if (onClose) onClose(this); }
  Inst* inst;

private:
  std::function<void(EditorWindow*)> onClose;
};

Rack::Rack(Engine& e, Pipe& p) : engine(e), pipe(p) {
  formats.addFormat(std::make_unique<juce::VST3PluginFormat>());
#if JUCE_PLUGINHOST_VST
  if (auto bridge = makeBridgeFormat()) formats.addFormat(std::move(bridge)); // 32-bit .dll, ahead of VST2 (any .dll)
  formats.addFormat(std::make_unique<juce::VSTPluginFormat>());
#endif
  startTimerHz(20);
}

Rack::~Rack() {
  stopTimer();
  editors.clear();
  engine.setPlan(nullptr);
  groups.clear();
}

// ---------- loading ----------
std::unique_ptr<juce::AudioPluginInstance> Rack::load(const Slot& s, bool& synth, juce::String& err) {
  // .vst3 is VST3, a 32-bit .dll goes through the bridge, anything else (.dll / .so) is VST2
  auto* fmt = formats.getFormat(0);
  for (auto* f : formats.getFormats()) if (f->fileMightContainThisPluginType(s.path)) { fmt = f; break; }
  auto& descs = descCache[s.path];
  if (descs.isEmpty()) {
    Busy b(("scan\t0\t" + s.name).toRawUTF8());
    guard([&] { fmt->findAllTypesForFile(descs, s.path); });
  }
  const juce::PluginDescription* d = nullptr;
  for (auto* x : descs) if (x->createIdentifierString() == s.uid) d = x;
  if (d == nullptr) for (auto* x : descs) if (x->name == s.name) d = x;
  if (d == nullptr && !descs.isEmpty()) d = descs[0];
  if (d == nullptr) {
    err = "could not open " + s.path;
    return nullptr;
  }
  synth = d->isInstrument;
  std::unique_ptr<juce::AudioPluginInstance> inst;
  const auto rate = engine.sampleRate() > 0 ? engine.sampleRate() : 48000.0;
  const juce::String label = "load\t0\t" + s.name;
  Busy b(label.toRawUTF8());
  const bool ok = guard([&] { inst = fmt->createInstanceFromDescription(*d, rate, Inst::kMaxBlock, err); });
  if (!ok) {
    inst.release();
    err = s.name + " crashed while loading";
    return nullptr;
  }
  if (inst == nullptr && err.isEmpty()) err = "could not load " + s.name;
  return inst;
}

bool Rack::getStateOf(Inst& i, juce::MemoryBlock& mb) {
  Busy b(i.label());
  return guard([&] { i.plugin().getStateInformation(mb); });
}

void Rack::setStateOf(Inst& i, const juce::MemoryBlock& mb) {
  Busy b(i.label());
  if (!guard([&] { i.plugin().setStateInformation(mb.getData(), (int) mb.getSize()); })) i.crashed.store(true);
}

std::unique_ptr<Inst> Rack::make(Group& g, int slot, const juce::MemoryBlock* state, juce::String& err) {
  auto& s = g.slots[(size_t) slot];
  bool synth = false;
  auto p = load(s, synth, err);
  if (!p) return nullptr;
  if (slot == 0) g.synth = synth;
  auto inst = std::make_unique<Inst>(std::move(p), synth);
  inst->setLabel(g.id, slot, s.name);
  inst->prepare(engine.sampleRate() > 0 ? engine.sampleRate() : 48000.0);
  if (state != nullptr && state->getSize() > 0) setStateOf(*inst, *state);
  return inst;
}

Inst* Rack::primary(Group& g, int slot) {
  for (auto& c : g.copies)
    if ((size_t) slot < c->insts.size() && c->insts[(size_t) slot]) return c->insts[(size_t) slot].get();
  return nullptr;
}

void Rack::wire(Group& g, int slot, Inst& inst) {
  inst.setLabel(g.id, slot, g.slots[(size_t) slot].name);
  Inst* ip = &inst;
  inst.onParam = [this, ip](int idx, float v) {
    const juce::SpinLock::ScopedLockType l(noteLock);
    if (notes.size() < 4096) notes.push_back({ nullptr, ip, idx, v, 0 });
  };
  inst.onGesture = [this, ip](int idx, bool start) {
    const juce::SpinLock::ScopedLockType l(noteLock);
    if (notes.size() < 4096) notes.push_back({ nullptr, ip, idx, 0, start ? 1 : 2 });
  };
  inst.onLatency = [this] {
    juce::MessageManager::callAsync([this] {
      if (rebuildQueued) return;
      rebuildQueued = true;
      juce::Timer::callAfterDelay(30, [this] { rebuildQueued = false; rebuild(); });
    });
  };
}

void Rack::applyParams(Group& g, int slot, const juce::var& params) {
  auto& s = g.slots[(size_t) slot];
  s.paramErrors.clear();
  auto* applied = new juce::DynamicObject();
  s.applied = juce::var(applied);
  Inst* src = primary(g, slot);
  auto* o = params.getDynamicObject();
  if (src == nullptr || o == nullptr) return;
  auto& prms = src->plugin().getParameters();
  for (auto& kv : o->getProperties()) {
    const auto key = kv.name.toString();
    const auto* m = findParam(s.meta, key);
    if (m == nullptr) {
      s.paramErrors.add(s.name + " has no parameter \"" + key + "\"");
      continue;
    }
    float v = 0;
    juce::String err;
    auto* prm = prms[m->index];
    if (!toNormalized(*prm, *m, kv.value, v, err)) {
      s.paramErrors.add(err);
      continue;
    }
    for (auto& c : g.copies)
      if ((size_t) slot < c->insts.size() && c->insts[(size_t) slot]) c->insts[(size_t) slot]->plugin().getParameters()[m->index]->setValue(v);
    if (auto b = s.autoBase.find(m->index); b != s.autoBase.end()) b->second = v;
    applied->setProperty(m->key, obj({ { "value", naturalValue(*prm, *m, v) }, { "text", paramText(*prm, *m, v) } }));
  }
}

void Rack::closeEditorsFor(Inst* i) {
  editors.erase(std::remove_if(editors.begin(), editors.end(), [i](auto& w) { return w->inst == i; }), editors.end());
}

// ---------- apply ----------
juce::var Rack::apply(const juce::var& msg) {
  auto* removed = new juce::DynamicObject();
  juce::var removedVar(removed);
  auto bury = [&](Group& g) {
    juce::Array<juce::var> states;
    for (size_t i = 0; i < g.slots.size(); ++i) {
      juce::MemoryBlock mb;
      Inst* p = primary(g, (int) i);
      const bool ok = p != nullptr && !p->crashed.load() && getStateOf(*p, mb);
      auto* base = new juce::DynamicObject();
      for (auto& [k, v] : g.slots[i].autoBase) base->setProperty(juce::String(k), v);
      states.add(obj({ { "plugin", g.slots[i].name }, { "state", ok ? juce::var(mb.toBase64Encoding()) : juce::var() }, { "base", juce::var(base) } }));
    }
    removed->setProperty(g.id, states);
    for (auto& c : g.copies)
      for (auto& i : c->insts) if (i) graveyard.push_back(std::move(i));
  };

  if ((bool) msg["reset"]) {
    for (auto& [id, g] : groups) bury(*g);
    groups.clear();
  }
  // renames first, so the diff below sees the new names
  if (auto* rn = msg["renames"].getArray())
    for (auto& r : *rn) {
      const auto from = r["from"].toString(), to = r["to"].toString();
      if (groups.count(from) && !groups.count(to)) {
        auto g = std::move(groups[from]);
        groups.erase(from);
        g->id = to;
        groups[to] = std::move(g);
      }
    }

  std::set<juce::String> wanted;
  const auto* specs = msg["groups"].getArray();
  if (specs != nullptr) for (auto& gs : *specs) wanted.insert(gs["id"].toString());
  for (auto it = groups.begin(); it != groups.end();) {
    if (!wanted.count(it->first)) {
      bury(*it->second);
      it = groups.erase(it);
    } else {
      ++it;
    }
  }

  // node keys per group
  std::map<juce::String, std::vector<std::pair<juce::String, juce::String>>> nodesOf; // group -> (key, next)
  if (auto* ns = msg["nodes"].getArray())
    for (auto& n : *ns) nodesOf[n["group"].toString()].push_back({ n["key"].toString(), n["next"].isString() ? n["next"].toString() : juce::String() });

  auto* result = new juce::DynamicObject();
  juce::var resultGroups(result);
  order.clear();
  if (specs != nullptr)
    for (auto& gs : *specs) {
      const auto id = gs["id"].toString();
      order.push_back(id);
      auto& gp = groups[id];
      if (!gp) {
        gp = std::make_unique<Group>();
        gp->id = id;
      }
      Group& g = *gp;
      const bool reload = (bool) gs["reload"];
      const auto* slotSpecs = gs["slots"].getArray();
      const int ns = slotSpecs ? slotSpecs->size() : 0;

      // match slots by plugin, in order
      std::vector<int> match((size_t) ns, -1);
      std::vector<bool> used(g.slots.size(), false);
      for (int i = 0; i < ns; ++i) {
        const auto& sp = (*slotSpecs)[i];
        for (size_t j = 0; j < g.slots.size() && !reload; ++j)
          if (!used[j] && g.slots[j].uid == sp["uid"].toString() && g.slots[j].name == sp["name"].toString() && !g.slots[j].missing) {
            match[(size_t) i] = (int) j;
            used[j] = true;
            break;
          }
      }
      std::vector<Slot> newSlots((size_t) ns);
      for (int i = 0; i < ns; ++i) {
        const auto& sp = (*slotSpecs)[i];
        if (match[(size_t) i] >= 0) newSlots[(size_t) i] = std::move(g.slots[(size_t) match[(size_t) i]]);
        auto& s = newSlots[(size_t) i];
        s.name = sp["name"].toString();
        s.path = sp["path"].toString();
        s.uid = sp["uid"].toString();
        s.bypass = (bool) sp["bypass"];
        s.off = (bool) sp["off"];
        s.missing = s.path.isEmpty();
        s.error = {};
        if (match[(size_t) i] < 0) s.meta.clear();
      }
      // copies: same key keeps its copy, a changed route reuses a leftover one, the rest are new
      auto old = std::move(g.copies);
      g.copies.clear();
      const auto& keys = nodesOf[id];
      std::vector<bool> taken(old.size(), false);
      std::vector<std::unique_ptr<Copy>> fresh(keys.size());
      for (size_t k = 0; k < keys.size(); ++k)
        for (size_t j = 0; j < old.size(); ++j)
          if (!taken[j] && old[j]->key == keys[k].first) { fresh[k] = std::move(old[j]); taken[j] = true; break; }
      for (size_t k = 0; k < keys.size(); ++k) {
        if (fresh[k]) continue;
        for (size_t j = 0; j < old.size(); ++j)
          if (!taken[j]) { fresh[k] = std::move(old[j]); taken[j] = true; break; }
        if (!fresh[k]) { fresh[k] = std::make_unique<Copy>(); fresh[k]->id = nextCopyId++; }
      }
      for (size_t j = 0; j < old.size(); ++j)
        if (!taken[j]) for (auto& i : old[j]->insts) if (i) graveyard.push_back(std::move(i));
      // re-seat each copy's instances on the new slot order
      for (size_t k = 0; k < keys.size(); ++k) {
        auto& c = *fresh[k];
        c.key = keys[k].first;
        c.next = keys[k].second;
        std::vector<std::unique_ptr<Inst>> insts((size_t) ns);
        for (int i = 0; i < ns; ++i)
          if (const int j = match[(size_t) i]; j >= 0 && (size_t) j < c.insts.size()) insts[(size_t) i] = std::move(c.insts[(size_t) j]);
        for (auto& i : c.insts) if (i) graveyard.push_back(std::move(i));
        c.insts = std::move(insts);
        g.copies.push_back(std::move(fresh[k]));
      }
      g.slots = std::move(newSlots);

      // create what is missing: the first instance from the saved state, the other copies as clones of it
      for (int i = 0; i < ns; ++i) {
        auto& s = g.slots[(size_t) i];
        const auto& sp = (*slotSpecs)[i];
        if (s.off || s.missing) {
          for (auto& c : g.copies) if (c->insts[(size_t) i]) graveyard.push_back(std::move(c->insts[(size_t) i]));
          continue;
        }
        Inst* src = primary(g, i);
        juce::MemoryBlock state;
        bool haveState = false;
        if (src != nullptr) haveState = getStateOf(*src, state);
        else if (sp["state"].isString()) haveState = state.fromBase64Encoding(sp["state"].toString());
        for (auto& c : g.copies) {
          if (c->insts[(size_t) i]) continue;
          juce::String err;
          auto inst = make(g, i, haveState ? &state : nullptr, err);
          if (!inst) {
            s.missing = true;
            s.error = err;
            break;
          }
          if (!haveState && src == nullptr) haveState = getStateOf(*inst, state);
          c->insts[(size_t) i] = std::move(inst);
        }
        if (s.missing) {
          for (auto& c : g.copies) if (c->insts[(size_t) i]) graveyard.push_back(std::move(c->insts[(size_t) i]));
          continue;
        }
        if (s.meta.empty()) if (auto* p = primary(g, i)) s.meta = describeParams(p->plugin());
        for (auto& c : g.copies) wire(g, i, *c->insts[(size_t) i]);
        auto setAll = [&](int index, float v) {
          for (auto& c : g.copies)
            if (auto* in = c->insts[(size_t) i].get(); in && index >= 0 && index < in->plugin().getParameters().size())
              in->plugin().getParameters()[index]->setValue(v);
        };
        if (src == nullptr)
          if (auto* bo = sp["base"].getDynamicObject())
            for (auto& kv : bo->getProperties()) setAll(kv.name.toString().getIntValue(), (float) (double) kv.value);
        {
          std::set<int> still;
          if (auto* keys = gs["auto"].getArray())
            for (auto& k : *keys) if (auto* m = findParam(s.meta, k.toString())) still.insert(m->index);
          for (auto it = s.autoBase.begin(); it != s.autoBase.end();) {
            if (still.count(it->first)) { ++it; continue; }
            setAll(it->first, it->second);
            it = s.autoBase.erase(it);
          }
        }
        if (slotSpecs) applyParams(g, i, sp["params"]);
      }

      juce::Array<juce::var> slotResults;
      for (int i = 0; i < ns; ++i) {
        auto& s = g.slots[(size_t) i];
        Inst* p = primary(g, i);
        const juce::String status = s.off ? "crashed" : s.missing ? "missing" : (p && p->crashed.load()) ? "crashed" : "loaded";
        juce::Array<juce::var> perrs;
        for (auto& e : s.paramErrors) perrs.add(e);
        slotResults.add(obj({ { "status", status }, { "error", s.error }, { "latency", p ? p->latency() : 0 },
                              { "synth", i == 0 ? g.synth : false }, { "paramErrors", perrs }, { "applied", s.applied } }));
      }
      result->setProperty(id, obj({ { "slots", slotResults }, { "synth", g.synth }, { "copies", (int) g.copies.size() } }));
    }

  streams.clear();
  if (auto* so = msg["streams"].getDynamicObject())
    for (auto& kv : so->getProperties()) streams[kv.name.toString().getIntValue()] = kv.value.toString();

  rebuild();
  publishKeys();
  // nothing plays the buried instances any more
  for (auto& i : graveyard) {
    closeEditorsFor(i.get());
    reportedCrash.erase(i.get());
  }
  {
    const juce::SpinLock::ScopedLockType l(noteLock);
    notes.erase(std::remove_if(notes.begin(), notes.end(), [this](const Note& n) {
      return std::any_of(graveyard.begin(), graveyard.end(), [&](auto& g) { return g.get() == n.inst; });
    }), notes.end());
  }
  graveyard.clear();
  return obj({ { "groups", resultGroups }, { "removed", removedVar }, { "latency", engine.planLatency() } });
}

void Rack::publishKeys() {
  std::unordered_map<std::string, int> m;
  for (auto& [id, g] : groups)
    for (auto& c : g->copies) m[c->key.toStdString()] = c->id;
  std::lock_guard<std::mutex> l(keyLock);
  keyToId = std::move(m);
}

void Rack::rebuild() {
  struct N { Group* g; Copy* c; int next = -1, lat = 0, d = -1, depth = -1; };
  std::vector<N> all;
  std::map<juce::String, int> byKey;
  for (auto& id : order) {
    auto it = groups.find(id);
    if (it == groups.end()) continue;
    for (auto& c : it->second->copies) {
      byKey[c->key] = (int) all.size();
      all.push_back({ it->second.get(), c.get() });
    }
  }
  for (auto& n : all) {
    if (n.c->next.isNotEmpty() && byKey.count(n.c->next)) n.next = byKey[n.c->next];
    for (size_t s = 0; s < n.c->insts.size(); ++s) {
      auto* i = n.c->insts[s].get();
      if (i && !n.g->slots[s].bypass && !i->crashed.load()) n.lat += i->latency();
    }
  }
  // D and depth along the route to the speakers (routes are loop-free; the guard only stops a bad message)
  for (size_t k = 0; k < all.size(); ++k) {
    int d = 0, depth = 0;
    for (int at = (int) k, hops = 0; at >= 0 && hops <= (int) all.size(); at = all[(size_t) at].next, ++hops) {
      d += all[(size_t) at].lat;
      depth = hops;
    }
    all[k].d = d;
    all[k].depth = depth;
  }
  auto plan = std::make_unique<Plan>();
  for (auto& n : all) plan->lmax = std::max(plan->lmax, n.d);
  std::vector<int> idx(all.size());
  for (size_t k = 0; k < idx.size(); ++k) idx[k] = (int) k;
  std::stable_sort(idx.begin(), idx.end(), [&](int a, int b) { return all[(size_t) a].depth > all[(size_t) b].depth; });
  std::vector<int> pos(all.size());
  for (size_t k = 0; k < idx.size(); ++k) pos[(size_t) idx[k]] = (int) k;
  plan->nodes.resize(all.size());
  plan->byCopy.assign((size_t) nextCopyId + 1, -1);
  for (size_t k = 0; k < idx.size(); ++k) {
    auto& n = all[(size_t) idx[k]];
    auto& pn = plan->nodes[k];
    pn.copy = n.c->id;
    pn.next = n.next >= 0 ? pos[(size_t) n.next] : -1;
    pn.delay = plan->lmax - n.d;
    pn.synth = n.g->synth;
    pn.peak = n.c->peak;
    int pre = 0;
    for (size_t s = 0; s < n.c->insts.size(); ++s) {
      auto* i = n.c->insts[s].get();
      const bool bypass = n.g->slots[s].bypass;
      pn.slots.push_back({ i, bypass, pre });
      if (i && !bypass && !i->crashed.load()) pre += i->latency();
    }
    pn.in.setSize(2, Inst::kMaxBlock);
    pn.in.clear();
    pn.midi.ensureSize(8192);
    pn.changes.resize(1024);
    plan->byCopy[(size_t) n.c->id] = (int) k;
  }
  plan->streamNode.fill(-1);
  plan->streamDelay.fill(0);
  for (auto& [i, key] : streams)
    if (i > 0 && i < proto::kMaxStreams && byKey.count(key)) {
      const int k = byKey[key];
      plan->streamNode[(size_t) i] = pos[(size_t) k];
      plan->streamDelay[(size_t) i] = plan->lmax - all[(size_t) k].d;
    }
  engine.setPlan(std::move(plan));
}

void Rack::onRateChanged() {
  const double r = engine.sampleRate();
  bool any = false;
  for (auto& [id, g] : groups)
    for (auto& c : g->copies)
      for (auto& i : c->insts) any |= i && i->preparedRate() != r;
  if (!any) return;
  auto old = engine.setPlan(nullptr);
  for (auto& [id, g] : groups)
    for (auto& c : g->copies)
      for (auto& i : c->insts) if (i && i->preparedRate() != r) i->prepare(r);
  rebuild();
}

// ---------- queries ----------
juce::var Rack::getState(const juce::var& msg) {
  auto* out = new juce::DynamicObject();
  juce::var res(out);
  const auto* only = msg["groups"].getArray();
  for (auto& [id, g] : groups) {
    if (only != nullptr && !only->contains(id)) continue;
    juce::Array<juce::var> states;
    for (size_t i = 0; i < g->slots.size(); ++i) {
      juce::MemoryBlock mb;
      Inst* p = primary(*g, (int) i);
      const bool ok = p != nullptr && !p->crashed.load() && getStateOf(*p, mb);
      auto* base = new juce::DynamicObject();
      for (auto& [k, v] : g->slots[i].autoBase) base->setProperty(juce::String(k), v);
      states.add(obj({ { "state", ok ? juce::var(mb.toBase64Encoding()) : juce::var() }, { "base", juce::var(base) } }));
    }
    out->setProperty(id, states);
  }
  return res;
}

juce::var Rack::paramValues(const juce::String& group, int slot) {
  auto* out = new juce::DynamicObject();
  juce::var res(out);
  auto it = groups.find(group);
  if (it == groups.end() || slot < 0 || (size_t) slot >= it->second->slots.size()) return res;
  Inst* p = primary(*it->second, slot);
  if (p == nullptr || p->crashed.load()) return res;
  auto& prms = p->plugin().getParameters();
  for (auto& m : it->second->slots[(size_t) slot].meta) {
    auto* prm = prms[m.index];
    const float v = prm->getValue();
    out->setProperty(m.key, obj({ { "value", naturalValue(*prm, m, v) }, { "text", paramText(*prm, m, v) } }));
  }
  return res;
}

juce::var Rack::params(const juce::String& group, int slot) {
  auto it = groups.find(group);
  if (it == groups.end() || slot < 0 || (size_t) slot >= it->second->slots.size()) return juce::Array<juce::var>();
  return paramsToVar(it->second->slots[(size_t) slot].meta);
}

juce::String Rack::openEditor(const juce::String& group, int slot) {
  auto it = groups.find(group);
  if (it == groups.end() || slot < 0 || (size_t) slot >= it->second->slots.size()) return "no such rack entry: " + group;
  Inst* p = primary(*it->second, slot);
  if (p == nullptr) return it->second->slots[(size_t) slot].name + " is not loaded";
  if (p->crashed.load()) return it->second->slots[(size_t) slot].name + " crashed";
  for (auto& w : editors)
    if (w->inst == p) {
      w->setMinimised(false);
      w->toFront(true);
      return {};
    }
  juce::AudioProcessorEditor* ed = nullptr;
  {
    Busy b(p->label());
    if (!guard([&] { ed = p->plugin().createEditorAndMakeActive(); })) return "the editor crashed";
  }
  if (ed == nullptr) ed = new juce::GenericAudioProcessorEditor(p->plugin());
  Group* g = it->second.get();
  const auto title = group + " - " + g->slots[(size_t) slot].name;
  editors.push_back(std::make_unique<EditorWindow>(title, ed, p, [this, g](EditorWindow* w) {
    juce::MessageManager::callAsync([this, w, g] {
      // hand the final state to the other copies, then close
      for (auto& [id, gp] : groups) {
        if (gp.get() != g) continue;
        for (size_t s = 0; s < g->slots.size(); ++s) {
          Inst* src = primary(*g, (int) s);
          if (src != w->inst) continue;
          juce::MemoryBlock mb;
          if (getStateOf(*src, mb))
            for (auto& c : g->copies)
              if (c->insts[s] && c->insts[s].get() != src) setStateOf(*c->insts[s], mb);
        }
      }
      editors.erase(std::remove_if(editors.begin(), editors.end(), [w](auto& e) { return e.get() == w; }), editors.end());
    });
  }));
  return {};
}

juce::String Rack::debugCrash(const juce::String& group, int slot, int mode) {
  auto it = groups.find(group);
  if (it == groups.end()) return "no such group";
  Inst* p = primary(*it->second, slot);
  if (p == nullptr) return "not loaded";
  p->debugCrash.store(mode);
  return {};
}

juce::String Rack::debugTouch(const juce::String& group, int slot, const juce::String& key, float v) {
  auto it = groups.find(group);
  if (it == groups.end() || slot < 0 || (size_t) slot >= it->second->slots.size()) return "no such slot";
  Inst* p = primary(*it->second, slot);
  const auto* m = findParam(it->second->slots[(size_t) slot].meta, key);
  if (p == nullptr || m == nullptr) return "no such parameter";
  auto* prm = p->plugin().getParameters()[m->index];
  prm->beginChangeGesture();
  prm->setValueNotifyingHost(v);
  prm->endChangeGesture();
  return {};
}

juce::var Rack::debugCopies(const juce::String& group, int slot, const juce::String& key) {
  juce::Array<juce::var> out;
  auto it = groups.find(group);
  if (it == groups.end() || slot < 0 || (size_t) slot >= it->second->slots.size()) return out;
  const auto* m = findParam(it->second->slots[(size_t) slot].meta, key);
  if (m == nullptr) return out;
  for (auto& c : it->second->copies)
    if (auto* i = c->insts[(size_t) slot].get()) out.add(i->plugin().getParameters()[m->index]->getValue());
  return out;
}

// ---------- events ----------
void Rack::events(const juce::var& list) {
  const auto* arr = list.getArray();
  if (arr == nullptr) return;
  std::vector<Event> out;
  out.reserve((size_t) arr->size());
  juce::Array<juce::var> params;
  {
    std::lock_guard<std::mutex> l(keyLock);
    for (auto& e : *arr) {
      const auto type = e[1].toString();
      if (type == "p") { params.add(e); continue; }
      if (type == "panic") { out.push_back({ -1, evPanic, 0, 0, 0, 0, 0, 0 }); continue; }
      auto it = keyToId.find(e[0].toString().toStdString());
      if (it == keyToId.end()) continue;
      Event ev { it->second, 0, 0, 0, 0, 0, 0, (double) e[2] };
      ev.a = (uint8_t) juce::jlimit(0, 127, (int) e[3]);
      ev.b = (uint8_t) juce::jlimit(0, 127, (int) e[4]);
      if (type == "on") ev.type = evNoteOn;
      else if (type == "off") ev.type = evNoteOff;
      else if (type == "cc") ev.type = evCC;
      else if (type == "bend") { ev.type = evBend; ev.value = (float) (double) e[4]; }
      else continue;
      out.push_back(ev);
    }
  }
  if (!out.empty()) engine.push(out.data(), (int) out.size());
  if (!params.isEmpty())
    juce::MessageManager::callAsync([this, params] {
      for (auto& e : params) setParamFromEvent(e[0].toString(), (int) e[3], e[4].toString(), e[5], (double) e[2]);
    });
}

void Rack::setParamFromEvent(const juce::String& group, int slot, const juce::String& key, const juce::var& value, double src) {
  auto it = groups.find(group);
  if (it == groups.end()) return;
  Group& g = *it->second;
  const ParamMeta* m = nullptr;
  for (int s = slot >= 0 ? slot : 0; s < (int) g.slots.size() && m == nullptr; ++s) {
    m = findParam(g.slots[(size_t) s].meta, key);
    if (m != nullptr) slot = s;
    if (slot >= 0 && m == nullptr && s == slot) break;
  }
  if (m == nullptr) return;
  Inst* p = primary(g, slot);
  if (p == nullptr) return;
  auto& sl = g.slots[(size_t) slot];
  if (!sl.autoBase.count(m->index)) sl.autoBase[m->index] = p->plugin().getParameters()[m->index]->getValue();
  const auto ck = group + "|" + juce::String(slot) + "|" + juce::String(m->index) + "|" + value.toString();
  float v = 0;
  if (auto c = convCache.find(ck); c != convCache.end()) v = c->second;
  else {
    juce::String err;
    if (!toNormalized(*p->plugin().getParameters()[m->index], *m, value, v, err)) return;
    if (convCache.size() > 8192) convCache.clear();
    convCache[ck] = v;
  }
  std::vector<Event> out;
  for (auto& c : g.copies) out.push_back({ c->id, evParam, 0, 0, slot, m->index, v, src });
  engine.push(out.data(), (int) out.size());
}

// ---------- timer: parameter notes, meters, crashes ----------
void Rack::timerCallback() {
  std::vector<Note> batch;
  {
    const juce::SpinLock::ScopedLockType l(noteLock);
    batch.swap(notes);
  }
  // where each instance sits now
  std::map<Inst*, std::pair<Group*, int>> where;
  if (!batch.empty())
    for (auto& [id, g] : groups)
      for (auto& c : g->copies)
        for (size_t s = 0; s < c->insts.size(); ++s)
          if (c->insts[s]) where[c->insts[s].get()] = { g.get(), (int) s };
  std::vector<Note> outs;
  for (auto& n : batch) {
    auto w = where.find(n.inst);
    if (w == where.end()) continue;
    auto [g, slot] = w->second;
    if (n.gesture == 0) {
      // mirror to the other copies
      for (auto& c : g->copies) {
        auto* other = c->insts[(size_t) slot].get();
        if (other && other != n.inst) {
          auto& ps = other->plugin().getParameters();
          if (n.index < ps.size()) ps[n.index]->setValue(n.value);
        }
      }
      if (!outs.empty() && outs.back().inst == n.inst && outs.back().index == n.index && outs.back().gesture == 0) {
        outs.back().value = n.value;
        continue;
      }
    }
    n.g = g;
    outs.push_back(n);
  }
  for (auto& n : outs) {
    auto w = where.find(n.inst);
    const int slot = w->second.second;
    const ParamMeta* m = nullptr;
    for (auto& x : n.g->slots[(size_t) slot].meta) if (x.index == n.index) m = &x;
    if (m == nullptr) continue;
    auto* prm = n.inst->plugin().getParameters()[n.index];
    const float v = n.gesture == 0 ? n.value : prm->getValue();
    // a knob turned by hand moves the value automation returns to
    if (n.gesture == 2)
      if (auto b = n.g->slots[(size_t) slot].autoBase.find(n.index); b != n.g->slots[(size_t) slot].autoBase.end()) b->second = v;
    pipe.send(obj({ { "event", "param" }, { "group", n.g->id }, { "slot", slot }, { "key", m->key },
                    { "value", naturalValue(*prm, *m, v) }, { "text", paramText(*prm, *m, v) },
                    { "gesture", n.gesture == 1 ? "begin" : n.gesture == 2 ? "end" : "change" } }));
  }

  // meters: peak per copy, summed per entry
  auto* m = new juce::DynamicObject();
  juce::var mv(m);
  bool any = false;
  for (auto& [id, g] : groups) {
    float l = 0, r = 0;
    for (auto& c : g->copies) {
      l += c->peak[0].exchange(0);
      r += c->peak[1].exchange(0);
    }
    m->setProperty(id, juce::Array<juce::var> { juce::jmin(1.0f, l), juce::jmin(1.0f, r) });
    any = true;
    // crashes the audio thread caught
    for (size_t s = 0; s < g->slots.size(); ++s)
      for (auto& c : g->copies) {
        auto* i = c->insts[s].get();
        if (i && i->crashed.load() && !reportedCrash.count(i)) {
          reportedCrash.insert(i);
          pipe.send(obj({ { "event", "crashed" }, { "group", id }, { "slot", (int) s }, { "plugin", g->slots[s].name } }));
          for (auto& c2 : g->copies) // the copies go with it
            if (c2->insts[s]) { c2->insts[s]->crashed.store(true); reportedCrash.insert(c2->insts[s].get()); }
        }
      }
  }
  if (any) pipe.send(obj({ { "event", "meters" }, { "m", mv } }));
}

} // namespace jelly
