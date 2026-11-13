// The 64-bit side of the 32-bit plugin bridge (see Bridge.h). BridgeFormat is a juce::AudioPluginFormat like VST3
// or VST2, so Rack and the scan use bridged plugins the same way as any other; each instance owns one
// jelly-bridge32.exe. Its parameters, state and audio are forwarded to that process. Its editor is a window of the
// bridge shown inside the host's editor window.
#include "Bridge.h"
#include "Params.h"
#include "platform.h"

#if JUCE_WINDOWS
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstring>

namespace jelly {
using namespace bridge;

bool needsBridge(const juce::String& path) {
  if (!path.endsWithIgnoreCase(".dll")) return false;
  juce::FileInputStream in { juce::File(path) };
  if (!in.openedOk()) return false;
  uint8_t head[64];
  if (in.read(head, 64) != 64 || head[0] != 'M' || head[1] != 'Z') return false;
  uint32_t pe = 0;
  std::memcpy(&pe, head + 0x3c, 4);
  uint8_t sig[6];
  if (!in.setPosition(pe) || in.read(sig, 6) != 6 || std::memcmp(sig, "PE\0\0", 4) != 0) return false;
  return (sig[4] | (sig[5] << 8)) == 0x14c; // IMAGE_FILE_MACHINE_I386
}

namespace {

// a fault reported to the guard() around the call (Rack marks the plugin crashed)
[[noreturn]] void fail() {
  RaiseException(0xE0004A42, EXCEPTION_NONCONTINUABLE, 0, nullptr);
  std::abort();
}

// one jelly-bridge32.exe and the shared memory it works in
class Link {
public:
  ~Link() { stop(); }

  bool start(juce::String& err, bool scanning) {
    const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getSiblingFile("jelly-bridge32.exe");
    if (!exe.existsAsFile()) {
      err = "32-bit plugins need jelly-bridge32.exe next to jelly-host.exe";
      return false;
    }
    static std::atomic<int> counter { 0 };
    id = juce::String((int) GetCurrentProcessId()) + "-" + juce::String(++counter) + "-" + juce::String(juce::Random::getSystemRandom().nextInt());
    char n[160];
    name(n, sizeof n, id.toRawUTF8(), "shm");
    map = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, (DWORD) sizeof(Shm), n);
    if (map) shm = static_cast<Shm*>(MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shm)));
    if (!shm) {
      err = "could not set up the 32-bit bridge";
      return false;
    }
    shm->magic = kMagic;
    const char* evs[] = { "ctl-req", "ctl-rep", "audio-req", "audio-rep" };
    for (int i = 0; i < 4; ++i) {
      name(n, sizeof n, id.toRawUTF8(), evs[i]);
      ev[i] = CreateEventA(nullptr, FALSE, FALSE, n);
      if (!ev[i]) {
        err = "could not set up the 32-bit bridge";
        return false;
      }
    }
    const juce::String cmd = "\"" + exe.getFullPathName() + "\" --bridge " + id + " " + juce::String((int) GetCurrentProcessId()) +
                             (scanning ? " --scan" : "");
    std::wstring line(cmd.toWideCharPointer());
    STARTUPINFOW si {};
    si.cb = sizeof si;
    PROCESS_INFORMATION pi {};
    if (!CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
      err = "could not start jelly-bridge32.exe";
      return false;
    }
    CloseHandle(pi.hThread);
    proc = pi.hProcess;
    return true;
  }

  // ---- control (message thread) ----
  bool call(int32_t op, const void* data, uint32_t len, DWORD ms, juce::String& err) {
    const juce::ScopedLock l(ctlLock);
    if (dead) {
      err = "the plugin crashed";
      return false;
    }
    shm->ctl.op = op;
    shm->ctl.status = 0;
    len = std::min(len, kCtlBytes);
    if (len) std::memcpy(shm->ctl.data, data, len);
    shm->ctl.len = len;
    SetEvent(ev[0]);
    const DWORD r = waitControl(ms);
    if (r != WAIT_OBJECT_0) {
      err = r == WAIT_TIMEOUT ? "the plugin stopped responding" : "the plugin crashed";
      kill();
      return false;
    }
    if (shm->ctl.status != 0) {
      err = text();
      return false;
    }
    return true;
  }
  bool json(int32_t op, const juce::var& in, juce::var* out, DWORD ms, juce::String& err) {
    const auto s = juce::JSON::toString(in, true).toStdString();
    if (!call(op, s.data(), (uint32_t) s.size(), ms, err)) return false;
    if (out) *out = juce::JSON::parse(text());
    return true;
  }
  juce::String text() const { return juce::String::fromUTF8((const char*) shm->ctl.data, (int) shm->ctl.len); }

  // ---- audio (audio thread) ----
  bool process() {
    if (dead) return false;
    SetEvent(ev[2]);
    const HANDLE w[] = { ev[3], proc };
    if (WaitForMultipleObjects(2, w, FALSE, 2000) != WAIT_OBJECT_0) {
      kill();
      return false;
    }
    return true;
  }

  void kill() {
    dead = true;
    if (proc) TerminateProcess(proc, 1);
  }

  void stop() {
    if (proc) {
      juce::String e;
      if (!dead) call(opQuit, nullptr, 0, 2000, e);
      if (WaitForSingleObject(proc, 2000) != WAIT_OBJECT_0) TerminateProcess(proc, 0);
      CloseHandle(proc);
      proc = nullptr;
    }
    dead = true;
    for (auto& e : ev) if (e) { CloseHandle(e); e = nullptr; }
    if (shm) UnmapViewOfFile(shm);
    if (map) CloseHandle(map);
    shm = nullptr;
    map = nullptr;
  }

  Shm* shm = nullptr;
  std::atomic<bool> dead { false };

private:
  // waits for the control reply. The bridge's editor is a child of one of our windows, and Windows delivers some
  // messages between parent and child synchronously, so messages sent to this thread are handled while waiting
  // (posted ones are left for later).
  DWORD waitControl(DWORD ms) {
    const HANDLE w[] = { ev[1], proc };
    const auto until = GetTickCount64() + ms;
    for (;;) {
      const auto now = GetTickCount64();
      if (now >= until) return WAIT_TIMEOUT;
      const DWORD r = MsgWaitForMultipleObjects(2, w, FALSE, (DWORD) (until - now), QS_SENDMESSAGE);
      if (r == WAIT_OBJECT_0 + 2) {
        MSG m;
        PeekMessageW(&m, nullptr, 0, 0, PM_NOREMOVE | PM_QS_SENDMESSAGE);
        continue;
      }
      return r;
    }
  }

  juce::String id;
  HANDLE map = nullptr, proc = nullptr;
  HANDLE ev[4] {};
  juce::CriticalSection ctlLock;
};

class BridgedInstance;

class BridgedParam final : public juce::HostedAudioProcessorParameter, public TextTableSource {
public:
  BridgedParam(BridgedInstance& o, int i, const juce::var& v)
      : owner(o), index(i), name(v["name"].toString()), label(v["label"].toString()), steps((int) v["steps"]),
        discrete((bool) v["discrete"]), boolean((bool) v["boolean"]), automatable((bool) v["automatable"]),
        def((float) (double) v["def"]), value((float) (double) v["value"]) {}

  float getValue() const override { return value.load(std::memory_order_relaxed); }
  void setValue(float v) override;
  float getDefaultValue() const override { return def; }
  juce::String getName(int n) const override { return name.substring(0, n); }
  juce::String getLabel() const override { return label; }
  int getNumSteps() const override { return steps; }
  bool isDiscrete() const override { return discrete; }
  bool isBoolean() const override { return boolean; }
  bool isAutomatable() const override { return automatable; }
  juce::String getText(float v, int n) const override;
  float getValueForText(const juce::String& t) const override { return juce::jlimit(0.0f, 1.0f, t.getFloatValue()); }
  juce::String getParameterID() const override { return juce::String(index); }
  juce::StringArray textTable(int points) override;

  void fromBridge(float v) {
    value.store(v, std::memory_order_relaxed);
    sendValueChangedMessageToListeners(v);
  }

private:
  BridgedInstance& owner;
  const int index;
  const juce::String name, label;
  const int steps;
  const bool discrete, boolean, automatable;
  const float def;
  std::atomic<float> value;
};

class BridgedEditor;

class BridgedInstance final : public juce::AudioPluginInstance, private juce::Timer {
public:
  BridgedInstance(std::unique_ptr<Link> l, const juce::PluginDescription& d, const juce::var& info)
      : AudioPluginInstance(buses(info)), link(std::move(l)), desc(d) {
    ins = juce::jlimit(0, kMaxCh, (int) info["ins"]);
    outs = juce::jlimit(0, kMaxCh, (int) info["outs"]);
    int i = 0;
    if (auto* ps = info["params"].getArray())
      for (auto& p : *ps) addHostedParameter(std::make_unique<BridgedParam>(*this, i++, p));
    setLatencySamples((int) info["latency"]);
    if (auto* w = info["warnings"].getArray()) for (auto& t : *w) warnings.add(t.toString());
    startTimerHz(30);
  }
  juce::StringArray warnings;
  ~BridgedInstance() override {
    stopTimer();
    link.reset();
  }

  // ---- parameters ----
  void setFromHost(int index, float v) {
    if (juce::MessageManager::existsAndIsCurrentThread()) {
      juce::String err;
      link->json(opSet, obj({ { "index", index }, { "value", v } }), nullptr, 5000, err);
    } else if (pending < kMaxChanges) {
      changes[pending++] = { index, v }; // the audio thread: sent with the next block
    }
  }
  juce::String textOf(int index, float v) {
    if (!juce::MessageManager::existsAndIsCurrentThread()) return juce::String(v, 3);
    juce::String err;
    return link->json(opText, obj({ { "index", index } }), nullptr, 5000, err) ? link->text() : juce::String();
  }
  juce::StringArray tableOf(int index, int points) {
    juce::var out;
    juce::String err;
    juce::StringArray texts;
    if (link->json(opTable, obj({ { "index", index }, { "points", points } }), &out, 30000, err))
      if (auto* a = out.getArray()) for (auto& t : *a) texts.add(t.toString());
    return texts;
  }

  // ---- editor ----
  bool attachEditor(juce::int64 hwnd, int x, int y) {
    juce::String err;
    return link->json(opEditorAttach, obj({ { "hwnd", hwnd }, { "x", x }, { "y", y } }), nullptr, 10000, err);
  }
  void editorGone() {
    editor = nullptr;
    juce::String err;
    link->call(opEditorClose, nullptr, 0, 5000, err);
  }

  // ---- AudioPluginInstance ----
  void fillInPluginDescription(juce::PluginDescription& d) const override { d = desc; }
  const juce::String getName() const override { return desc.name; }
  void prepareToPlay(double rate, int block) override {
    juce::var out;
    juce::String err;
    if (link->json(opPrepare, obj({ { "rate", rate }, { "block", block } }), &out, 10000, err)) setLatencySamples((int) out["latency"]);
  }
  void releaseResources() override {
    juce::String err;
    link->call(opRelease, nullptr, 0, 5000, err);
  }
  bool isBusesLayoutSupported(const BusesLayout& l) const override {
    return l.getMainInputChannels() == ins && l.getMainOutputChannels() == outs;
  }

  void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer& midi) override {
    auto& a = link->shm->audio;
    const int total = buf.getNumSamples();
    for (int start = 0; start < total; start += kMaxBlock) {
      const int n = std::min(kMaxBlock, total - start);
      for (int c = 0; c < ins && c < buf.getNumChannels(); ++c) std::memcpy(a.in[c], buf.getReadPointer(c, start), sizeof(float) * (size_t) n);
      int ne = 0, pos = 0;
      for (const auto m : midi) {
        if (m.samplePosition < start || m.samplePosition >= start + n) continue;
        if (ne >= kMaxEvents || pos + m.numBytes > kMidiPool) break;
        std::memcpy(a.pool + pos, m.data, (size_t) m.numBytes);
        a.events[ne++] = { m.samplePosition - start, m.numBytes, pos, 0 };
        pos += m.numBytes;
      }
      a.nEvents = ne;
      std::memcpy(a.changes, changes, sizeof(Change) * (size_t) pending);
      a.nChanges = pending;
      pending = 0;
      a.n = n;
      a.ins = ins;
      a.outs = outs;
      if (!link->process()) fail();
      for (int c = 0; c < outs && c < buf.getNumChannels(); ++c) std::memcpy(buf.getWritePointer(c, start), a.out[c], sizeof(float) * (size_t) n);
    }
  }
  using AudioPluginInstance::processBlock;

  void getStateInformation(juce::MemoryBlock& mb) override {
    juce::var out;
    juce::String err;
    if (!link->json(opStateBegin, juce::var(), &out, 30000, err)) fail();
    const auto size = (size_t) (juce::int64) out["size"];
    mb.reset();
    while (mb.getSize() < size) {
      if (!link->json(opStatePart, obj({ { "offset", (juce::int64) mb.getSize() } }), nullptr, 30000, err) || link->shm->ctl.len == 0) fail();
      mb.append(link->shm->ctl.data, link->shm->ctl.len);
    }
  }
  void setStateInformation(const void* data, int size) override {
    juce::String err;
    if (!link->json(opSetBegin, obj({ { "size", size } }), nullptr, 10000, err)) fail();
    for (int off = 0; off < size; off += (int) kCtlBytes)
      if (!link->call(opSetPart, (const char*) data + off, (uint32_t) std::min<int>(size - off, (int) kCtlBytes), 30000, err)) fail();
    if (!link->call(opSetEnd, nullptr, 0, 30000, err)) fail();
  }

  juce::AudioProcessorEditor* createEditor() override;
  bool hasEditor() const override { return true; }
  double getTailLengthSeconds() const override { return 0; }
  bool acceptsMidi() const override { return desc.isInstrument; }
  bool producesMidi() const override { return false; }
  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return {}; }
  void changeProgramName(int, const juce::String&) override {}

private:
  static juce::var obj(std::initializer_list<std::pair<const char*, juce::var>> kv) {
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : kv) o->setProperty(k, v);
    return juce::var(o);
  }
  static juce::AudioChannelSet set(int n) {
    return n == 1 ? juce::AudioChannelSet::mono() : n == 2 ? juce::AudioChannelSet::stereo() : juce::AudioChannelSet::discreteChannels(n);
  }
  static BusesProperties buses(const juce::var& info) {
    BusesProperties b;
    if ((int) info["ins"] > 0) b = b.withInput("Input", set(juce::jmin(kMaxCh, (int) info["ins"])), true);
    if ((int) info["outs"] > 0) b = b.withOutput("Output", set(juce::jmin(kMaxCh, (int) info["outs"])), true);
    return b;
  }

  void timerCallback() override;

  std::unique_ptr<Link> link;
  juce::PluginDescription desc;
  int ins = 0, outs = 0;
  Change changes[kMaxChanges] {};
  int pending = 0; // audio thread only
  BridgedEditor* editor = nullptr;
  friend class BridgedEditor;
};

void BridgedParam::setValue(float v) {
  value.store(v, std::memory_order_relaxed);
  owner.setFromHost(index, v);
}
juce::String BridgedParam::getText(float v, int n) const { return owner.textOf(index, v).substring(0, n); }
juce::StringArray BridgedParam::textTable(int points) { return owner.tableOf(index, points); }

// a black box the size of the plugin's editor; the bridge puts its editor window on top, as a child window
class BridgedEditor final : public juce::AudioProcessorEditor, private juce::Timer {
public:
  BridgedEditor(BridgedInstance& o, int w, int h) : AudioProcessorEditor(o), owner(o) {
    setOpaque(true);
    setSize(std::max(w, 50), std::max(h, 50));
    owner.editor = this;
    startTimerHz(20);
  }
  ~BridgedEditor() override { owner.editorGone(); } // before our window (its parent) goes
  void paint(juce::Graphics& g) override { g.fillAll(juce::Colours::black); }

private:
  void timerCallback() override {
    auto* peer = getPeer();
    if (!isShowing() || peer == nullptr) return;
    stopTimer();
    const auto at = peer->getComponent().getLocalPoint(this, juce::Point<int>());
    owner.attachEditor((juce::int64) (juce::pointer_sized_int) peer->getNativeHandle(), at.x, at.y);
  }
  BridgedInstance& owner;
};

juce::AudioProcessorEditor* BridgedInstance::createEditor() {
  juce::var out;
  juce::String err;
  if (!link->json(opEditorOpen, juce::var(), &out, 30000, err) || !(bool) out["ok"]) return nullptr;
  return new BridgedEditor(*this, (int) out["w"], (int) out["h"]);
}

void BridgedInstance::timerCallback() {
  if (!link->shm) return;
  auto& r = link->shm->ring;
  auto& ps = getParameters();
  while (r.read != r.write) {
    MemoryBarrier();
    const auto it = r.items[r.read];
    r.read = (r.read + 1) % kNotes;
    auto* p = it.index >= 0 && it.index < ps.size() ? static_cast<BridgedParam*>(ps[it.index]) : nullptr;
    switch (it.type) {
      case noteParam: if (p) p->fromBridge(it.value); break;
      case noteGestureBegin: if (p) p->beginChangeGesture(); break;
      case noteGestureEnd: if (p) p->endChangeGesture(); break;
      case noteLatency: setLatencySamples(it.index); break;
      case noteEditorSize: if (editor) editor->setSize((int) it.value, (int) it.extra); break;
      default: break;
    }
  }
}

class BridgeFormat final : public juce::AudioPluginFormat {
public:
  explicit BridgeFormat(bool s) : scanning(s) {}
  juce::String getName() const override { return "VST (32-bit bridge)"; }
  bool fileMightContainThisPluginType(const juce::String& path) override { return needsBridge(path); }
  void findAllTypesForFile(juce::OwnedArray<juce::PluginDescription>& results, const juce::String& path) override {
    Link l;
    juce::String err;
    juce::var out;
    if (!l.start(err, scanning) || !l.json(opDescribe, obj("path", path), &out, 60000, err)) return;
    if (auto* a = out.getArray())
      for (auto& x : *a)
        if (auto xml = juce::parseXML(x.toString())) {
          auto d = std::make_unique<juce::PluginDescription>();
          if (d->loadFromXml(*xml)) results.add(d.release());
        }
  }
  juce::String getNameOfPluginFromIdentifier(const juce::String& id) override { return juce::File(id).getFileNameWithoutExtension(); }
  bool pluginNeedsRescanning(const juce::PluginDescription&) override { return false; }
  bool doesPluginStillExist(const juce::PluginDescription& d) override { return juce::File(d.fileOrIdentifier).existsAsFile(); }
  bool canScanForPlugins() const override { return true; }
  bool isTrivialToScan() const override { return false; }
  juce::StringArray searchPathsForPlugins(const juce::FileSearchPath&, bool, bool) override { return {}; }
  juce::FileSearchPath getDefaultLocationsToSearch() override { return {}; }
  bool requiresUnblockedMessageThreadDuringCreation(const juce::PluginDescription&) const override { return false; }

protected:
  void createPluginInstance(const juce::PluginDescription& d, double rate, int block, PluginCreationCallback done) override {
    auto l = std::make_unique<Link>();
    juce::String err;
    juce::var info;
    auto* o = new juce::DynamicObject();
    o->setProperty("description", d.createXml()->toString());
    o->setProperty("rate", rate);
    o->setProperty("block", block);
    if (!l->start(err, scanning) || !l->json(opOpen, juce::var(o), &info, 60000, err)) return done(nullptr, err.isEmpty() ? "could not load the plugin" : err);
    juce::PluginDescription full = d;
    if (auto xml = juce::parseXML(info["description"].toString())) full.loadFromXml(*xml);
    done(std::make_unique<BridgedInstance>(std::move(l), full, info), {});
  }

private:
  const bool scanning;
  static juce::var obj(const char* k, const juce::var& v) {
    auto* o = new juce::DynamicObject();
    o->setProperty(k, v);
    return juce::var(o);
  }
};

} // namespace

std::unique_ptr<juce::AudioPluginFormat> makeBridgeFormat(bool scanning) { return std::make_unique<BridgeFormat>(scanning); }
juce::StringArray bridgeWarnings(juce::AudioPluginInstance& i) {
  auto* b = dynamic_cast<BridgedInstance*>(&i);
  return b ? b->warnings : juce::StringArray();
}

} // namespace jelly

#else

namespace jelly {
bool needsBridge(const juce::String&) { return false; }
std::unique_ptr<juce::AudioPluginFormat> makeBridgeFormat(bool) { return nullptr; }
juce::StringArray bridgeWarnings(juce::AudioPluginInstance&) { return {}; }
} // namespace jelly

#endif
