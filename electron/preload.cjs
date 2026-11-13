const { contextBridge, ipcRenderer, webUtils } = require('electron');

// window.jelly.vst: see src/vst/CONTRACT.md. Parts that need plugin hosting (step 2+) are neutral stubs for now.
const on = (channel) => (fn) => {
  const h = (_, v) => fn(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};
const never = () => () => {};
const vst = {
  status: () => ipcRenderer.invoke('vst:status'),
  onStatus: on('vst:status'),
  onBanner: on('vst:banner'),
  plugins: async () => [],
  scanInfo: async () => ({ found: 0, skipped: [], scanning: false, folders: [] }),
  rescan: async () => {},
  onScan: never,
  setFolders: async () => {},
  params: async () => [],
  paramValues: async () => ({}),
  onParamChange: never,
  openEditor: async () => {},
  saveState: async () => {},
  reload: async () => {},
  onRack: never,
  rackStatus: async () => ({ sketch: '', entries: [], errors: [] }),
  deleted: async () => [],
  restore: async () => {},
  onMeters: never,
  audioDevices: () => ipcRenderer.invoke('vst:audioDevices'),
  audioSettings: () => ipcRenderer.invoke('vst:audioSettings'),
  setAudio: (s) => ipcRenderer.invoke('vst:setAudio', s),
  // engine internals (src/vst/engine), not part of the contract
  _openCapture: () => {
    // one end to main, the other to the page, which moves it into the capture worklet
    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage('vst:capture', null, [port1]);
    window.postMessage('jelly-vst-capture-port', '*', [port2]);
  },
  _stats: () => ipcRenderer.invoke('vst:stats'),
  _setStreamLatency: (ms) => ipcRenderer.invoke('vst:setStreamLatency', ms),
};

contextBridge.exposeInMainWorld('jelly', {
  libraryPath: () => ipcRenderer.invoke('library:path'),
  openLibrary: () => ipcRenderer.invoke('library:open'),
  pick: (folders) => ipcRenderer.invoke('library:pick', folders),
  add: (paths, bank) => ipcRenderer.invoke('library:add', paths, bank),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onLibraryChanged: (fn) => ipcRenderer.on('library-changed', () => fn()),
  cacheStatus: (urls) => ipcRenderer.invoke('cache:status', urls),
  prefetch: (urls) => ipcRenderer.invoke('cache:prefetch', urls),
  openCache: () => ipcRenderer.invoke('cache:open'),
  onPrefetch: (fn) => ipcRenderer.on('prefetch-progress', (_, p) => fn(p)),
  sketchList: () => ipcRenderer.invoke('sketch:list'),
  sketchRead: (name) => ipcRenderer.invoke('sketch:read', name),
  sketchWrite: (name, code) => ipcRenderer.invoke('sketch:write', name, code),
  sketchCreate: (name, code) => ipcRenderer.invoke('sketch:create', name, code),
  sketchRename: (name, newName) => ipcRenderer.invoke('sketch:rename', name, newName),
  sketchDuplicate: (name) => ipcRenderer.invoke('sketch:duplicate', name),
  sketchDelete: (name) => ipcRenderer.invoke('sketch:delete', name),
  openSketches: () => ipcRenderer.invoke('sketch:open'),
  onSketchesChanged: (fn) => ipcRenderer.on('sketches-changed', () => fn()),
  soundRename: (name, newName) => ipcRenderer.invoke('sound:rename', name, newName),
  soundDelete: (name) => ipcRenderer.invoke('sound:delete', name),
  soundReveal: (name) => ipcRenderer.invoke('sound:reveal', name),
  setTitlebar: (color, symbolColor) => ipcRenderer.invoke('theme:titlebar', color, symbolColor),
  vst,
});
