// Routes superdough's output either to jelly-host (captured by an AudioWorklet and streamed over the pipe) or,
// while the engine is not ready, straight to Chromium's own output as before.
//
// superdough mixes everything into controller.output.destinationGain -> ctx.destination. initializeAudio is
// replaced on that instance so destinationGain feeds `tap` instead, also after superdough rebuilds its graph.
// In host mode tap feeds capture stream 0 and nothing audible reaches ctx.destination, so audio is not heard twice.
// Chromium keeps its sound card sink on purpose (see capture-worklet.js): that also makes the AudioContext clock the
// sound card's clock, so there is little drift for the host to absorb.
// streamInput(i) is where a route's audio enters stream i (step 3 routes .fx patterns to their own streams).
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio';
import workletUrl from './capture-worklet.js?url';

export const MAX_STREAMS = 8;
const BATCH = 2; // render quanta per message: 256 frames, ~5 ms at 48 kHz

let ac = null;
let node = null;
let tap = null;
let inputs = [];
let host = false; // current mode
let mask = 1;

function setMode(toHost) {
  if (toHost === host || !node) return;
  host = toHost;
  tap.disconnect();
  tap.connect(host ? inputs[0] : ac.destination);
  node.port.postMessage({ type: 'enable', on: host });
}

export async function installCapture() {
  const vst = window.jelly?.vst;
  if (!vst || node) return;
  ac = getAudioContext();
  tap = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  tap.connect(ac.destination); // Chromium output until the engine is ready
  const out = getSuperdoughAudioController().output;
  const init = out.initializeAudio;
  out.initializeAudio = function () {
    init.call(this);
    this.destinationGain.disconnect();
    this.destinationGain.connect(tap);
  };
  out.reset();

  await ac.audioWorklet.addModule(workletUrl);
  node = new AudioWorkletNode(ac, 'jelly-capture', {
    numberOfInputs: MAX_STREAMS,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { batch: BATCH },
  });
  inputs = Array.from({ length: MAX_STREAMS }, (_, i) => {
    const g = new GainNode(ac, { channelCount: 2, channelCountMode: 'explicit' });
    g.connect(node, 0, i);
    return g;
  });
  node.connect(ac.destination); // inaudible in host mode, silent otherwise; keeps the worklet running

  // preload hands over a MessagePort whose other end is in Electron main; it goes on into the worklet
  window.addEventListener('message', (e) => {
    if (e.data === 'jelly-vst-capture-port' && e.ports?.[0]) node.port.postMessage({ type: 'port', port: e.ports[0] }, [e.ports[0]]);
  });
  vst._openCapture();
  node.port.postMessage({ type: 'streams', mask });

  vst.onStatus((s) => setMode(s.state === 'ready'));
  setMode((await vst.status()).state === 'ready');
}

// Where route i's audio enters the engine. Stream 0 also carries superdough's main mix.
export const streamInput = (i) => inputs[i] ?? null;
// Which streams carry a route (bit i = stream i). Stream 0 always does.
export function setActiveStreams(m) {
  mask = m | 1;
  node?.port.postMessage({ type: 'streams', mask });
}
export const captureMode = () => (host ? 'host' : 'local');

// diagnostics (devtools, tests)
globalThis.__jellyVstCapture = { mode: captureMode, ctx: () => ac };
