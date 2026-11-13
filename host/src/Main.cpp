// jelly-host: Strudel Jelly's audio engine process. Electron starts it and talks to it over stdin/stdout
// (Protocol.h). It owns the sound card and, from step 2 on, the VST3 plugins.
#include "Engine.h"
#include "Pipe.h"
#include "platform.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

namespace jelly {

// Drives the engine from the sound card. Another driver (offline export) would call Engine::render the same way.
class DeviceDriver : public juce::AudioIODeviceCallback {
public:
  explicit DeviceDriver(Engine& e) : engine(e) {}
  void audioDeviceIOCallbackWithContext(const float* const*, int, float* const* out, int numOut, int n,
                                        const juce::AudioIODeviceCallbackContext&) override {
    engine.render(out, numOut, n);
  }
  void audioDeviceAboutToStart(juce::AudioIODevice* d) override {
    engine.prepare(d->getCurrentSampleRate(), d->getCurrentBufferSizeSamples());
  }
  void audioDeviceStopped() override {}

private:
  Engine& engine;
};

static juce::var obj(std::initializer_list<std::pair<const char*, juce::var>> kv) {
  auto* o = new juce::DynamicObject();
  for (auto& [k, v] : kv) o->setProperty(k, v);
  return juce::var(o);
}

class HostApp : public juce::JUCEApplication, private juce::Timer, private juce::ChangeListener {
public:
  const juce::String getApplicationName() override { return "jelly-host"; }
  const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
  bool moreThanOneInstanceAllowed() override { return true; }
  void anotherInstanceStarted(const juce::String&) override {}
  void systemRequestedQuit() override { quit(); }

  void initialise(const juce::String&) override {
    platform::init();
    pipe.onJson = [this](juce::String text) {
      juce::MessageManager::callAsync([this, text] { handle(text); });
    };
    pipe.onAudio = [this](const Pipe::Audio& a) {
      engine.stream(a.stream).write(a.startFrame, a.frames, a.channels, a.sampleRate, a.planar);
    };
    pipe.onClosed = [] { juce::MessageManager::callAsync([] { juce::JUCEApplication::quit(); }); };
    devices.addChangeListener(this);
    pipe.start();
    pipe.send(obj({ { "event", "hello" }, { "version", getApplicationVersion() }, { "maxStreams", proto::kMaxStreams },
                    { "vst3", (bool) JUCE_PLUGINHOST_VST3 } }));
    startTimer(250);
  }

  void shutdown() override {
    stopTimer();
    devices.removeAudioCallback(&deviceDriver);
    devices.closeAudioDevice();
  }

private:
  Engine engine;
  DeviceDriver deviceDriver { engine };
  juce::AudioDeviceManager devices;
  Pipe pipe;
  bool opened = false;
  juce::String deviceError;

  void handle(const juce::String& text) {
    const juce::var msg = juce::JSON::parse(text);
    const juce::var id = msg["id"];
    const juce::String cmd = msg["cmd"].toString();
    juce::var result;
    juce::String error;
    if (cmd == "ping") result = true;
    else if (cmd == "audioDevices") result = listDevices();
    else if (cmd == "audioSettings") result = settings();
    else if (cmd == "setAudio") { error = setAudio(msg); result = settings(); }
    else if (cmd == "setStreamLatency") { engine.setStreamLatencyMs(juce::jlimit(5.0, 500.0, (double) msg["ms"])); result = true; }
    else if (cmd == "quit") { quit(); result = true; }
    else error = "unknown command: " + cmd;
    if (id.isVoid()) return;
    if (error.isEmpty()) pipe.send(obj({ { "id", id }, { "ok", true }, { "result", result } }));
    else pipe.send(obj({ { "id", id }, { "ok", false }, { "error", error }, { "result", result } }));
  }

  juce::var listDevices() {
    juce::Array<juce::var> drivers;
    auto* byDriver = new juce::DynamicObject();
    for (auto* type : devices.getAvailableDeviceTypes()) {
      type->scanForDevices();
      juce::Array<juce::var> names;
      for (auto& n : type->getDeviceNames(false)) names.add(n);
      drivers.add(type->getTypeName());
      byDriver->setProperty(type->getTypeName(), names);
    }
    return obj({ { "drivers", drivers }, { "devices", juce::var(byDriver) } });
  }

  juce::var settings() {
    auto setup = devices.getAudioDeviceSetup();
    return obj({ { "driver", devices.getCurrentAudioDeviceType() }, { "device", setup.outputDeviceName },
                 { "buffer", setup.bufferSize } });
  }

  // { driver?, device?, buffer? }: empty or missing values keep the current one (or the system default).
  juce::String setAudio(const juce::var& s) {
    const juce::String driver = s["driver"].toString(), device = s["device"].toString();
    const int buffer = (int) s["buffer"];
    devices.removeAudioCallback(&deviceDriver);
    juce::String err;
    if (!opened) {
      err = devices.initialise(0, 2, nullptr, true);
      opened = true;
    }
    if (driver.isNotEmpty() && driver != devices.getCurrentAudioDeviceType()) devices.setCurrentAudioDeviceType(driver, true);
    auto setup = devices.getAudioDeviceSetup();
    if (device.isNotEmpty()) setup.outputDeviceName = device;
    if (buffer > 0) setup.bufferSize = buffer;
    setup.inputDeviceName = {};
    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    setup.useDefaultOutputChannels = true;
    err = devices.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty() && device.isNotEmpty()) { // fall back to the driver's default device
      setup.outputDeviceName = {};
      const auto again = devices.setAudioDeviceSetup(setup, true);
      if (again.isEmpty()) err = "could not open \"" + device + "\" (" + err + "), using the default device";
    }
    if (devices.getCurrentAudioDevice() == nullptr && err.isEmpty()) err = "no audio output device";
    deviceError = err;
    devices.addAudioCallback(&deviceDriver);
    return err;
  }

  void changeListenerCallback(juce::ChangeBroadcaster*) override {
    pipe.send(obj({ { "event", "audio" }, { "settings", settings() } }));
  }

  // ~4 Hz: engine status and the per-stream buffer stats (used for the latency/drift measurements)
  void timerCallback() override {
    auto* dev = devices.getCurrentAudioDevice();
    const double sr = dev ? dev->getCurrentSampleRate() : 0;
    const int block = dev ? dev->getCurrentBufferSizeSamples() : 0;
    const int outLat = dev ? dev->getOutputLatencyInSamples() : 0;
    const double deviceMs = sr > 0 ? (outLat + block) * 1000.0 / sr : 0;
    juce::Array<juce::var> streams;
    for (int i = 0; i < proto::kMaxStreams; ++i) {
      const auto st = engine.stream(i).takeStats();
      if (!st.active) continue;
      const double r = st.sampleRate > 0 ? st.sampleRate : 48000;
      juce::Array<juce::var> onsets;
      for (auto& o : engine.stream(i).recentOnsets()) onsets.add(juce::Array<juce::var> { o.src, (juce::int64) o.host });
      streams.add(obj({ { "i", i }, { "playing", st.playing }, { "rate", st.sampleRate }, { "readPos", st.readPos },
                        { "writeEnd", st.writeEnd }, { "fillMs", st.fill * 1000 / r }, { "fillMinMs", st.fillMin * 1000 / r },
                        { "fillMaxMs", st.fillMax * 1000 / r }, { "targetMs", st.target * 1000 / r },
                        { "ratio", st.ratio }, { "peak", st.peak }, { "underruns", (juce::int64) st.underruns },
                        { "overruns", (juce::int64) st.overruns }, { "gaps", (juce::int64) st.gaps },
                        { "received", (juce::int64) st.received }, { "arrivalGapMaxMs", st.arrivalGapMaxMs }, { "onsets", onsets },
                        { "resets", (juce::int64) st.resets }, { "rewinds", (juce::int64) st.rewinds },
                        { "prepares", (juce::int64) engine.stream(i).prepareCount() } }));
    }
    const auto ref = engine.clockRef();
    pipe.send(obj({ { "event", "stats" }, { "cpu", devices.getCpuUsage() }, { "sampleRate", sr }, { "blockSize", block },
                    { "deviceLatencyMs", deviceMs }, { "streamLatencyMs", engine.streamLatencyMs() },
                    { "latencyMs", engine.streamLatencyMs() + deviceMs },
                    { "xruns", dev ? dev->getXRunCount() : 0 }, { "device", dev ? dev->getName() : juce::String() },
                    { "driver", devices.getCurrentAudioDeviceType() }, { "error", deviceError },
                    { "hostSample", (juce::int64) engine.hostSample() },
                    { "clock", obj({ { "hostSample", (juce::int64) ref.hostSample }, { "srcFrame", ref.srcFrame },
                                     { "ratio", ref.ratio }, { "valid", ref.valid } }) },
                    { "streams", streams } }));
  }
};

} // namespace jelly

START_JUCE_APPLICATION(jelly::HostApp)
