const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  canReveal: true,
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  prepare: (file) => ipcRenderer.invoke('prepare', file),
  release: (id) => ipcRenderer.invoke('release', id),
  exportVideo: (opts) => ipcRenderer.invoke('export', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('export-progress', (_e, fraction) => cb(fraction)),
});
