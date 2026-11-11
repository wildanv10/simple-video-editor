const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  prepare: (file) => ipcRenderer.invoke('prepare', file),
  trim: (opts) => ipcRenderer.invoke('trim', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('trim-progress', (_e, seconds) => cb(seconds)),
});
