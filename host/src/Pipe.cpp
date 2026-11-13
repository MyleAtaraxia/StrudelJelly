#include "Pipe.h"
#include "Protocol.h"
#include "platform.h"
#include <cstring>
#include <vector>

namespace jelly {

void Pipe::start() {
  reader = std::thread([this] { readLoop(); });
}

Pipe::~Pipe() {
  if (reader.joinable()) reader.detach(); // blocked in a read; the process is ending anyway
}

template <typename T> static T get(const uint8_t* p) {
  T v;
  std::memcpy(&v, p, sizeof v);
  return v;
}

void Pipe::readLoop() {
  std::vector<uint8_t> body;
  std::vector<float> samples;
  for (;;) {
    uint8_t len[4];
    if (!platform::readStdin(len, 4)) break;
    const uint32_t n = get<uint32_t>(len);
    if (n == 0 || n > proto::kMaxFrame) break; // corrupt stream: give up, Electron restarts us
    body.resize(n);
    if (!platform::readStdin(body.data(), n)) break;
    const uint8_t kind = body[0];
    if (kind == proto::kJson) {
      if (onJson) onJson(juce::String::fromUTF8((const char*) body.data() + 1, (int) n - 1));
    } else if (kind == proto::kAudio && n >= proto::kAudioHeader) {
      Audio a;
      a.stream = body[1];
      a.channels = body[2];
      a.frames = (int) get<uint32_t>(&body[4]);
      a.sampleRate = (int) get<uint32_t>(&body[8]);
      a.startFrame = get<double>(&body[12]);
      const size_t count = (size_t) a.channels * (size_t) a.frames;
      if (a.stream >= proto::kMaxStreams || n != proto::kAudioHeader + count * sizeof(float)) continue;
      samples.resize(count);
      std::memcpy(samples.data(), &body[proto::kAudioHeader], count * sizeof(float));
      a.planar = samples.data();
      if (onAudio) onAudio(a);
    }
  }
  if (onClosed) onClosed();
}

void Pipe::send(const juce::var& message) {
  const auto text = juce::JSON::toString(message, true).toStdString();
  const uint32_t n = (uint32_t) text.size() + 1;
  std::vector<uint8_t> frame(4 + n);
  std::memcpy(frame.data(), &n, 4);
  frame[4] = proto::kJson;
  std::memcpy(frame.data() + 5, text.data(), text.size());
  std::lock_guard<std::mutex> lock(writeLock);
  platform::writeStdout(frame.data(), frame.size());
}

} // namespace jelly
