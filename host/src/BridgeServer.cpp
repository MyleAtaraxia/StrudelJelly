// jelly-bridge32: runs one 32-bit VST2 plugin for the 64-bit jelly-host (see Bridge.h for the protocol).
// Usage (jelly-host starts it): jelly-bridge32 --bridge <id> <parent pid> [--scan]
// Message boxes the plugin opens (a SynthEdit plugin missing a module, say) never show: the Windows message box
// functions are replaced in this process by ones that answer at once, and their text is passed back as warnings.
// With --scan, any other dialog the plugin opens is closed too, so a scan never waits on someone clicking OK.
// The control calls run on this program's message thread (VST2 plugins expect their GUI thread there), the audio on
// a thread of its own. When jelly-host goes away the bridge ends at once; a plugin fault ends it too, quietly
// (platform::init), and jelly-host marks the plugin crashed.
#define JELLY_BRIDGE_SERVER 1
#include "Bridge.h"
#include "platform.h"
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <cstring>
#include <thread>

namespace jelly::bridge {

// ---------- the plugin's message boxes: answered without showing, kept as warnings ----------
static juce::CriticalSection warningLock;
static juce::StringArray warnings;

static void addWarning(const juce::String& text) {
  const auto t = text.trim();
  const juce::ScopedLock l(warningLock);
  if (t.isNotEmpty()) warnings.addIfNotAlreadyThere(t);
}

// what a person would most likely click: OK, Yes, Ignore; Cancel where the choice is Retry (so nothing loops)
static int answer(UINT type) {
  switch (type & MB_TYPEMASK) {
    case MB_ABORTRETRYIGNORE: return IDIGNORE;
    case MB_YESNO:
    case MB_YESNOCANCEL: return IDYES;
    case MB_RETRYCANCEL:
    case MB_CANCELTRYCONTINUE: return IDCANCEL;
    default: return IDOK;
  }
}

static int WINAPI boxA(HWND, LPCSTR t, LPCSTR, UINT type) { addWarning(juce::String(t)); return answer(type); }
static int WINAPI boxW(HWND, LPCWSTR t, LPCWSTR, UINT type) { addWarning(juce::String(t)); return answer(type); }
static int WINAPI boxExA(HWND, LPCSTR t, LPCSTR, UINT type, WORD) { addWarning(juce::String(t)); return answer(type); }
static int WINAPI boxExW(HWND, LPCWSTR t, LPCWSTR, UINT type, WORD) { addWarning(juce::String(t)); return answer(type); }
static int WINAPI boxTimeoutA(HWND, LPCSTR t, LPCSTR, UINT type, WORD, DWORD) { addWarning(juce::String(t)); return answer(type); }
static int WINAPI boxTimeoutW(HWND, LPCWSTR t, LPCWSTR, UINT type, WORD, DWORD) { addWarning(juce::String(t)); return answer(type); }
static int WINAPI boxIndirectA(const MSGBOXPARAMSA* p) {
  if (!IS_INTRESOURCE(p->lpszText)) addWarning(juce::String(p->lpszText));
  return answer(p->dwStyle);
}
static int WINAPI boxIndirectW(const MSGBOXPARAMSW* p) {
  if (!IS_INTRESOURCE(p->lpszText)) addWarning(juce::String(p->lpszText));
  return answer(p->dwStyle);
}

// overwrites the start of a user32 function with a jump to `to` (the original is never called again)
static void replace(HMODULE user32, const char* name, void* to) {
  auto* at = reinterpret_cast<uint8_t*>(GetProcAddress(user32, name));
  if (!at) return;
  DWORD old = 0;
  if (!VirtualProtect(at, 5, PAGE_EXECUTE_READWRITE, &old)) return;
  const auto rel = (int32_t) (reinterpret_cast<uint8_t*>(to) - (at + 5));
  at[0] = 0xE9;
  std::memcpy(at + 1, &rel, 4);
  VirtualProtect(at, 5, old, &old);
  FlushInstructionCache(GetCurrentProcess(), at, 5);
}

static void silenceMessageBoxes() {
  const HMODULE u = LoadLibraryA("user32.dll");
  replace(u, "MessageBoxA", (void*) &boxA);
  replace(u, "MessageBoxW", (void*) &boxW);
  replace(u, "MessageBoxExA", (void*) &boxExA);
  replace(u, "MessageBoxExW", (void*) &boxExW);
  replace(u, "MessageBoxTimeoutA", (void*) &boxTimeoutA);
  replace(u, "MessageBoxTimeoutW", (void*) &boxTimeoutW);
  replace(u, "MessageBoxIndirectA", (void*) &boxIndirectA);
  replace(u, "MessageBoxIndirectW", (void*) &boxIndirectW);
}

class Server : private juce::AudioProcessorParameter::Listener, private juce::AudioProcessorListener, private juce::ComponentListener {
public:
  bool start(const juce::String& id, DWORD parentPid, bool scanning) {
    char n[128];
    name(n, sizeof n, id.toRawUTF8(), "shm");
    map = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, n);
    if (!map) return false;
    shm = static_cast<Shm*>(MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shm)));
    if (!shm || shm->magic != kMagic) return false;
    const char* evs[] = { "ctl-req", "ctl-rep", "audio-req", "audio-rep" };
    for (int i = 0; i < 4; ++i) {
      name(n, sizeof n, id.toRawUTF8(), evs[i]);
      ev[i] = OpenEventA(EVENT_ALL_ACCESS, FALSE, n);
      if (!ev[i]) return false;
    }
    parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (!parent) return false;
    ctlThread = std::thread([this] { ctlLoop(); });
    audioThread = std::thread([this] { audioLoop(); });
    if (scanning) dialogThread = std::thread([this] { dialogLoop(); });
    return true;
  }

private:
  // ---------- control: wait here, run on the message thread ----------
  void ctlLoop() {
    const HANDLE w[] = { ev[0], parent };
    for (;;) {
      const DWORD r = WaitForMultipleObjects(2, w, FALSE, INFINITE);
      if (r != WAIT_OBJECT_0) ExitProcess(0); // jelly-host is gone
      juce::MessageManager::callAsync([this] {
        handle();
        SetEvent(ev[1]);
      });
    }
  }

  void reply(const juce::String& s, int32_t status = 0) {
    const auto u = s.toStdString();
    const uint32_t n = (uint32_t) std::min<size_t>(u.size(), kCtlBytes);
    std::memcpy(shm->ctl.data, u.data(), n);
    shm->ctl.len = n;
    shm->ctl.status = status;
  }
  void replyJson(const juce::var& v) { reply(juce::JSON::toString(v, true)); }
  juce::var request() const { return juce::JSON::parse(juce::String::fromUTF8((const char*) shm->ctl.data, (int) shm->ctl.len)); }
  juce::AudioProcessorParameter* param(int i) const {
    auto& ps = inst->getParameters();
    return i >= 0 && i < ps.size() ? ps[i] : nullptr;
  }

  static juce::var obj(std::initializer_list<std::pair<const char*, juce::var>> kv) {
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : kv) o->setProperty(k, v);
    return juce::var(o);
  }

  void handle() {
    const int op = shm->ctl.op;
    if (op == opQuit) {
      editor.reset();
      if (inst) inst->releaseResources();
      reply({});
      SetEvent(ev[1]);
      ExitProcess(0); // the plugin's own teardown is not worth waiting on
    }
    if (op == opDescribe) {
      const auto path = request()["path"].toString();
      juce::OwnedArray<juce::PluginDescription> descs;
      fmt.findAllTypesForFile(descs, path);
      juce::Array<juce::var> out;
      for (auto* d : descs) out.add(d->createXml()->toString());
      return replyJson(out);
    }
    if (op == opOpen) return open();
    if (!inst) return reply("no plugin loaded", 1);
    const auto req = op == opSetPart ? juce::var() : request();
    switch (op) {
      case opPrepare: {
        const double rate = req["rate"];
        const int block = req["block"];
        inst->setRateAndBufferSizeDetails(rate, block);
        inst->prepareToPlay(rate, block);
        prepared = true;
        return replyJson(obj({ { "latency", inst->getLatencySamples() } }));
      }
      case opRelease: inst->releaseResources(); prepared = false; return reply({});
      case opSet:
        if (auto* p = param(req["index"])) {
          quiet = true;
          p->setValue((float) (double) req["value"]);
          quiet = false;
        }
        return reply({});
      case opText:
        if (auto* p = param(req["index"])) return reply(p->getCurrentValueAsText());
        return reply({});
      case opTable: {
        juce::Array<juce::var> out;
        if (auto* p = param(req["index"])) {
          const int points = juce::jlimit(2, 4096, (int) req["points"]);
          const float was = p->getValue();
          quiet = true;
          for (int k = 0; k < points; ++k) {
            p->setValue((float) k / (float) (points - 1));
            out.add(p->getCurrentValueAsText());
          }
          p->setValue(was);
          quiet = false;
        }
        return replyJson(out);
      }
      case opStateBegin:
        state.reset();
        inst->getStateInformation(state);
        return replyJson(obj({ { "size", (juce::int64) state.getSize() } }));
      case opStatePart: {
        const size_t off = (size_t) (juce::int64) req["offset"];
        const size_t n = off < state.getSize() ? std::min<size_t>(state.getSize() - off, kCtlBytes) : 0;
        if (n) std::memcpy(shm->ctl.data, (const char*) state.getData() + off, n);
        shm->ctl.len = (uint32_t) n;
        shm->ctl.status = 0;
        return;
      }
      case opSetBegin: incoming.reset(); incoming.ensureSize((size_t) (juce::int64) req["size"]); incoming.setSize(0); return reply({});
      case opSetPart: incoming.append(shm->ctl.data, shm->ctl.len); return reply({});
      case opSetEnd:
        quiet = true;
        inst->setStateInformation(incoming.getData(), (int) incoming.getSize());
        quiet = false;
        incoming.reset();
        return reply({});
      case opEditorOpen: {
        if (!editor) editor.reset(inst->createEditorAndMakeActive());
        if (!editor) return replyJson(obj({ { "ok", false } }));
        editor->addComponentListener(this);
        return replyJson(obj({ { "ok", true }, { "w", editor->getWidth() }, { "h", editor->getHeight() } }));
      }
      case opEditorAttach: {
        if (!editor) return reply("no editor", 1);
        const auto hwnd = (void*) (intptr_t) (juce::int64) req["hwnd"];
        editor->setVisible(false);
        editor->addToDesktop(0, hwnd);
        editor->setTopLeftPosition((int) req["x"], (int) req["y"]);
        editor->setVisible(true);
        return reply({});
      }
      case opEditorClose:
        if (editor) {
          editor->removeComponentListener(this);
          editor.reset();
        }
        return reply({});
      default: return reply("unknown request", 1);
    }
  }

  void open() {
    const auto req = request();
    juce::PluginDescription d;
    if (auto xml = juce::parseXML(req["description"].toString())) d.loadFromXml(*xml);
    juce::String err;
    const double rate = req["rate"];
    const int block = req["block"];
    inst = fmt.createInstanceFromDescription(d, rate, block, err);
    if (!inst) return reply(err.isEmpty() ? "could not load the plugin" : err, 1);
    // the same layout jelly-host asks of every plugin: main buses only, stereo where it can
    inst->disableNonMainBuses();
    auto layout = inst->getBusesLayout();
    if (layout.inputBuses.size() > 0) layout.inputBuses.getReference(0) = juce::AudioChannelSet::stereo();
    if (layout.outputBuses.size() > 0) layout.outputBuses.getReference(0) = juce::AudioChannelSet::stereo();
    if (inst->checkBusesLayoutSupported(layout)) inst->setBusesLayout(layout);
    work.setSize(std::max({ 2, inst->getTotalNumInputChannels(), inst->getTotalNumOutputChannels() }), kMaxBlock);
    midi.ensureSize(8192);

    juce::Array<juce::var> params;
    for (auto* p : inst->getParameters()) {
      params.add(obj({ { "name", p->getName(128) }, { "label", p->getLabel() }, { "steps", p->getNumSteps() },
                       { "discrete", p->isDiscrete() }, { "boolean", p->isBoolean() }, { "automatable", p->isAutomatable() },
                       { "value", p->getValue() }, { "def", p->getDefaultValue() } }));
      p->addListener(this);
    }
    inst->addListener(this);
    replyJson(obj({ { "description", inst->getPluginDescription().createXml()->toString() },
                    { "ins", juce::jmin(kMaxCh, inst->getTotalNumInputChannels()) },
                    { "outs", juce::jmin(kMaxCh, inst->getTotalNumOutputChannels()) },
                    { "latency", inst->getLatencySamples() }, { "params", params }, { "warnings", warningList() } }));
  }

  // ---------- scans: the plugin's dialogs ----------
  void dialogLoop() {
    for (;;) {
      Sleep(50);
      EnumWindows([](HWND h, LPARAM self) -> BOOL { reinterpret_cast<Server*>(self)->closeDialog(h); return TRUE; }, (LPARAM) this);
    }
  }
  void closeDialog(HWND h) {
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    char cls[16] {};
    if (pid != GetCurrentProcessId() || !IsWindowVisible(h) || !GetClassNameA(h, cls, sizeof cls) || std::strcmp(cls, "#32770") != 0) return;
    juce::String text; // every text in the dialog (a message box has one)
    EnumChildWindows(h, [](HWND c, LPARAM out) -> BOOL {
      char cl[16] {};
      wchar_t t[1024] {};
      if (GetClassNameA(c, cl, sizeof cl) && _stricmp(cl, "Static") == 0 && GetWindowTextW(c, t, 1024) > 0) {
        auto& s = *reinterpret_cast<juce::String*>(out);
        s << (s.isEmpty() ? "" : " ") << juce::String(t).trim();
      }
      return TRUE;
    }, (LPARAM) &text);
    addWarning(text);
    PostMessageW(h, WM_COMMAND, IDOK, 0);
    PostMessageW(h, WM_CLOSE, 0, 0);
  }
  juce::var warningList() {
    const juce::ScopedLock l(warningLock);
    juce::Array<juce::var> out;
    for (auto& w : warnings) out.add(w);
    return out;
  }

  // ---------- what the plugin does on its own ----------
  void note(int32_t type, int32_t index, float value, float extra = 0) {
    const juce::ScopedLock l(ringLock);
    auto& r = shm->ring;
    const int32_t w = r.write;
    if ((w + 1) % kNotes == r.read) return; // full: drop
    r.items[w] = { type, index, value, extra };
    MemoryBarrier();
    r.write = (w + 1) % kNotes;
  }
  void parameterValueChanged(int index, float value) override { if (!quiet) note(noteParam, index, value); }
  void parameterGestureChanged(int index, bool starting) override { note(starting ? noteGestureBegin : noteGestureEnd, index, 0); }
  void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override {}
  void audioProcessorChanged(juce::AudioProcessor* p, const ChangeDetails& d) override {
    if (d.latencyChanged) note(noteLatency, p->getLatencySamples(), 0);
  }
  void componentMovedOrResized(juce::Component& c, bool, bool resized) override {
    if (resized) note(noteEditorSize, 0, (float) c.getWidth(), (float) c.getHeight());
  }

  // ---------- audio ----------
  void audioLoop() {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    const HANDLE w[] = { ev[2], parent };
    for (;;) {
      if (WaitForMultipleObjects(2, w, FALSE, INFINITE) != WAIT_OBJECT_0) ExitProcess(0);
      process();
      SetEvent(ev[3]);
    }
  }

  void process() {
    auto& a = shm->audio;
    const int n = juce::jlimit(0, kMaxBlock, a.n);
    if (!inst || !prepared || n == 0) {
      for (int c = 0; c < kMaxCh; ++c) std::fill(a.out[c], a.out[c] + n, 0.0f);
      return;
    }
    juce::ScopedNoDenormals noDenormals;
    auto& ps = inst->getParameters();
    quiet = true;
    for (int i = 0; i < std::min(a.nChanges, kMaxChanges); ++i)
      if (a.changes[i].index >= 0 && a.changes[i].index < ps.size()) ps[a.changes[i].index]->setValue(a.changes[i].value);
    quiet = false;
    midi.clear();
    for (int i = 0; i < std::min(a.nEvents, kMaxEvents); ++i) {
      const auto& e = a.events[i];
      if (e.size > 0 && e.pos >= 0 && e.pos + e.size <= kMidiPool) midi.addEvent(a.pool + e.pos, e.size, juce::jlimit(0, n - 1, e.offset));
    }
    const int ins = inst->getTotalNumInputChannels(), outs = inst->getTotalNumOutputChannels();
    for (int c = 0; c < work.getNumChannels(); ++c) {
      if (c < ins && c < kMaxCh) work.copyFrom(c, 0, a.in[c], n);
      else work.clear(c, 0, n);
    }
    juce::AudioBuffer<float> view(work.getArrayOfWritePointers(), work.getNumChannels(), n);
    inst->processBlock(view, midi);
    for (int c = 0; c < std::min(outs, kMaxCh); ++c) std::memcpy(a.out[c], work.getReadPointer(c), sizeof(float) * (size_t) n);
    a.latency = inst->getLatencySamples();
  }

  juce::VSTPluginFormat fmt;
  std::unique_ptr<juce::AudioPluginInstance> inst;
  std::unique_ptr<juce::AudioProcessorEditor> editor;
  juce::AudioBuffer<float> work;
  juce::MidiBuffer midi;
  juce::MemoryBlock state, incoming;
  juce::CriticalSection ringLock;
  std::atomic<bool> prepared { false };
  static inline thread_local bool quiet = false; // host-made changes are not echoed back
  HANDLE map = nullptr, parent = nullptr;
  HANDLE ev[4] {};
  Shm* shm = nullptr;
  std::thread ctlThread, audioThread, dialogThread;
};

class BridgeApp : public juce::JUCEApplication {
public:
  const juce::String getApplicationName() override { return "jelly-bridge32"; }
  const juce::String getApplicationVersion() override { return "1"; }
  bool moreThanOneInstanceAllowed() override { return true; }
  void initialise(const juce::String& commandLine) override {
    platform::init();
    silenceMessageBoxes();
    auto args = juce::StringArray::fromTokens(commandLine, true);
    if (args.size() < 3 || args[0] != "--bridge" || !server.start(args[1], (DWORD) args[2].getLargeIntValue(), args.contains("--scan"))) {
      setApplicationReturnValue(1);
      quit();
    }
  }
  void shutdown() override { ExitProcess(0); }
  void systemRequestedQuit() override {} // only jelly-host ends it

private:
  Server server;
};

} // namespace jelly::bridge

START_JUCE_APPLICATION(jelly::bridge::BridgeApp)
