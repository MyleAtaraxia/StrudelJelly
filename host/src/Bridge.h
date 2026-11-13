// The 32-bit plugin bridge (Windows). A 64-bit process cannot load a 32-bit plugin, so jelly-host runs each one in
// its own jelly-bridge32.exe and talks to it through one block of shared memory and a few named events:
//
//   ctl    message-thread calls (load, parameter texts, state, editor), one at a time, request -> reply
//   audio  one processBlock per request: audio, MIDI and parameter changes in, audio out
//   ring   what the plugin does on its own (a knob turned in its editor, latency, editor size), polled by the host
//
// The layout below only uses fixed-size types so it is the same in both processes. BridgeClient.cpp is the 64-bit
// side (a juce::AudioPluginFormat whose instances forward to the bridge), BridgeServer.cpp the 32-bit program. If the
// bridge dies or stops answering, the host sees a crashed plugin, not a crashed host.
#pragma once
#include <cstdint>
#include <initializer_list>

namespace jelly::bridge {

constexpr uint32_t kMagic = 0x4a425231; // "JBR1"
constexpr int kMaxCh = 16;
constexpr int kMaxBlock = 2048;
constexpr int kMaxEvents = 2048;
constexpr int kMidiPool = 65536;
constexpr int kMaxChanges = 2048;
constexpr int kNotes = 4096;
constexpr uint32_t kCtlBytes = 1u << 22; // larger payloads (plugin state) go in parts

enum Op : int32_t {
  opDescribe = 1, // {path} -> [descriptions]
  opOpen,         // {description, rate, block} -> {description, ins, outs, latency, params: [...], warnings: [...]}
  opPrepare,      // {rate, block}
  opRelease,
  opSet,          // {index, value}
  opText,         // {index} -> the text of its current value
  opTable,        // {index, points} -> the text at each of `points` evenly spaced values (value put back after)
  opStateBegin,   // -> {size}: the state is taken and kept for opStatePart
  opStatePart,    // {offset} -> raw bytes
  opSetBegin,     // {size}
  opSetPart,      // raw bytes, appended
  opSetEnd,       // applies the state
  opEditorOpen,   // -> {ok, w, h}
  opEditorAttach, // {hwnd, x, y}: shows the editor as a child of that window
  opEditorClose,
  opQuit,
};

enum Note : int32_t { noteParam = 1, noteGestureBegin, noteGestureEnd, noteLatency, noteEditorSize };

struct Event { int32_t offset, size, pos, pad; };
struct Change { int32_t index; float value; };
struct NoteItem { int32_t type, index; float value, extra; };

struct Ring {
  volatile int32_t write, read, pad[2];
  NoteItem items[kNotes];
};

struct Ctl {
  int32_t op, status; // status: 0 ok, else failed (data holds the error text)
  uint32_t len, pad;
  uint8_t data[kCtlBytes];
};

struct Audio {
  int32_t n, ins, outs, nEvents, nChanges, latency, pad[2];
  Change changes[kMaxChanges];
  Event events[kMaxEvents];
  uint8_t pool[kMidiPool];
  float in[kMaxCh][kMaxBlock];
  float out[kMaxCh][kMaxBlock];
};

struct Shm {
  uint32_t magic, version;
  Ring ring;
  Ctl ctl;
  Audio audio;
};

// names of the shared memory and events for bridge `id` (Local\jelly-bridge-<id>-...)
inline void name(char* out, int size, const char* id, const char* what) {
  int i = 0;
  for (const char* s : { "Local\\jelly-bridge-", id, "-", what })
    for (; *s && i < size - 1; ++s) out[i++] = *s;
  out[i] = 0;
}

} // namespace jelly::bridge

#ifndef JELLY_BRIDGE_SERVER
#include <juce_audio_processors/juce_audio_processors.h>
namespace jelly {
// true for a plugin file the 64-bit host can only load through the bridge (a 32-bit Windows DLL)
bool needsBridge(const juce::String& path);
// a format for 32-bit plugins, or nullptr where there is no bridge (not Windows). scanning: dialogs the plugin opens
// (a missing file, say) are closed at once and kept as warnings, so a scan never waits on someone clicking OK
std::unique_ptr<juce::AudioPluginFormat> makeBridgeFormat(bool scanning = false);
// the text of the dialogs a bridged plugin opened while loading in a scan (empty for any other plugin)
juce::StringArray bridgeWarnings(juce::AudioPluginInstance&);
} // namespace jelly
#endif
