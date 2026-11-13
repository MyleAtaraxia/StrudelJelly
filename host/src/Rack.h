// The rack as the host keeps it (message thread). Electron sends the whole desired rack on every evaluate
// (applyRack) and the rack diffs it against what is running:
//   group  = a rack entry (or an inline .fx(vst(...)) chain): its slots (plugins) and their shared state/params
//   copy   = one live copy of a group's chain per distinct onward route (node key); all copies of a group mirror
//            each other's parameter changes, so they behave as one plugin
// Unchanged groups and copies keep their instances. Slots are matched by plugin, copies by key, so inserting a
// plugin or changing a route does not reload the others. Renames (detected in Electron) move instances over.
#pragma once
#include "Engine.h"
#include "Params.h"
#include <juce_audio_utils/juce_audio_utils.h>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <unordered_map>

namespace jelly {

class Pipe;

class Rack : private juce::Timer {
public:
  Rack(Engine&, Pipe&);
  ~Rack() override;

  juce::var apply(const juce::var& msg);
  juce::var getState(const juce::var& msg);
  juce::var paramValues(const juce::String& group, int slot);
  juce::var params(const juce::String& group, int slot);
  juce::String openEditor(const juce::String& group, int slot);
  juce::String debugCrash(const juce::String& group, int slot, int mode);
  // tests: turn a knob as the plugin's own window would (gesture + notifying change) and read every copy's value
  juce::String debugTouch(const juce::String& group, int slot, const juce::String& key, float normalized);
  juce::var debugCopies(const juce::String& group, int slot, const juce::String& key);
  void onRateChanged();
  // _scope(): node keys to send waveforms of (key -> samples per snapshot); replaces the previous set
  void setScopes(const juce::var& keys);

  // pipe reader thread: timed events (MIDI goes straight to the engine, parameter values via the message thread)
  void events(const juce::var& list);
  // message thread: the same list as engine events, parameter values included (offline export), sorted by time
  std::vector<Event> toEvents(const juce::var& list);

private:
  struct Copy {
    int id = 0;
    juce::String key, next;
    std::vector<std::unique_ptr<Inst>> insts; // per slot
    std::atomic<float> peak[2] {};
    std::vector<float> wave = std::vector<float>((size_t) PlanNode::kWave);
    std::atomic<int> wavePos { 0 };
    std::atomic<bool> tap { false };
  };
  struct Slot {
    juce::String name, path, uid, kind; // kind: "synth" or "effect", from the scan
    bool bypass = false, missing = false, off = false;
    juce::String error;
    std::vector<ParamMeta> meta;
    juce::StringArray paramErrors;
    juce::var applied;
    std::map<int, float> autoBase; // .set automation: param index -> the value it returns to (and is saved with)
  };
  struct Group {
    juce::String id;
    bool synth = false;
    std::vector<Slot> slots;
    std::vector<std::unique_ptr<Copy>> copies;
  };
  class EditorWindow;

  std::unique_ptr<juce::AudioPluginInstance> load(const Slot&, bool& synth, juce::String& err);
  std::unique_ptr<Inst> make(Group&, int slot, const juce::MemoryBlock* state, juce::String& err);
  void wire(Group&, int slot, Inst&);
  Inst* primary(Group&, int slot);
  bool getStateOf(Inst&, juce::MemoryBlock&);
  void setStateOf(Inst&, const juce::MemoryBlock&);
  void applyParams(Group&, int slot, const juce::var& params);
  void closeEditorsFor(Inst*);
  void rebuild();
  void publishKeys();
  void timerCallback() override;
  void setParamFromEvent(const juce::String& group, int slot, const juce::String& key, const juce::var& value, double src);
  void paramEvents(const juce::String& group, int slot, const juce::String& key, const juce::var& value, double src, std::vector<Event>& out);

  Engine& engine;
  Pipe& pipe;
  juce::AudioPluginFormatManager formats;
  std::map<juce::String, std::unique_ptr<Group>> groups;
  std::vector<juce::String> order;
  std::map<int, juce::String> streams; // stream index -> node key
  std::vector<std::unique_ptr<Inst>> graveyard;
  std::vector<std::unique_ptr<EditorWindow>> editors;
  std::map<juce::String, juce::OwnedArray<juce::PluginDescription>> descCache;
  int nextCopyId = 1;
  bool rebuildQueued = false;
  std::map<juce::String, float> convCache;
  std::map<juce::String, int> scopes;

  // copy key -> id, for the pipe reader thread
  std::mutex keyLock;
  std::unordered_map<std::string, int> keyToId;

  // parameter notifications from plugins (any thread), sent out by the timer
  struct Note { Group* g; Inst* inst; int index; float value; int gesture; }; // gesture 0 change, 1 begin, 2 end
  juce::SpinLock noteLock;
  std::vector<Note> notes;
  std::set<Inst*> reportedCrash;
};

} // namespace jelly
