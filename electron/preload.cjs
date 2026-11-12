const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  setTitlebar: (color, symbolColor) => ipcRenderer.invoke('theme:titlebar', color, symbolColor),
});
