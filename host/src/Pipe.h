// The link to Electron over stdin/stdout, framed as described in Protocol.h.
#pragma once
#include <juce_core/juce_core.h>
#include <functional>
#include <mutex>
#include <thread>

namespace jelly {

class Pipe {
public:
  struct Audio { int stream, channels, frames, sampleRate; double startFrame; const float* planar; };
  std::function<void(juce::String)> onJson;  // reader thread
  std::function<void(const Audio&)> onAudio; // reader thread
  std::function<void()> onClosed;            // reader thread, once, when stdin ends

  void start();
  void send(const juce::var& message); // any thread
  ~Pipe();

private:
  void readLoop();
  std::thread reader;
  std::mutex writeLock;
};

} // namespace jelly
