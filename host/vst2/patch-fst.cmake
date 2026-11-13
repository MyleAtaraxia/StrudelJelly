# Run on the fetched FST (cmake -P, in its source dir). FST ends three structs in an open array ([]), but JUCE sizes
# them like the classic VST2 layout, which holds 2 events, 8 speakers and a 64-char key name plus two ints. Without
# the room JUCE writes past the end (a synth crashes the scan). Same leading layout, so plugins see no difference.
file(READ fst/fst.h text)
string(REPLACE "t_fstEvent*events[];" "t_fstEvent*events[2];" text "${text}")
string(REPLACE "t_fstSpeakerProperties speakers[];" "t_fstSpeakerProperties speakers[8];" text "${text}")
string(REPLACE "char keyName[]; /* length: kVstMaxNameLen */" "char keyName[64]; /* length: kVstMaxNameLen */\n  t_fstInt32 reserved;\n  t_fstInt32 flags;" text "${text}")
file(WRITE fst/fst.h "${text}")
