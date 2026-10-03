const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('flux', {
  getState: () => ipcRenderer.invoke('state'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  addPaths: paths => ipcRenderer.invoke('add-paths', paths),
  pathForFile: file => webUtils.getPathForFile(file),
  selectOutput: () => ipcRenderer.invoke('select-output'),
  start: jobs => ipcRenderer.invoke('start-jobs', jobs),
  cancel: () => ipcRenderer.invoke('cancel-jobs'),
  reveal: id => ipcRenderer.invoke('reveal', id),
  openOutput: () => ipcRenderer.invoke('open-output'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  refreshEngines: () => ipcRenderer.invoke('refresh-engines'),
  openFormatList: () => ipcRenderer.invoke('open-format-list'),
  describeFormat: ext => ipcRenderer.invoke('describe-format', ext),
  onUpdate: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('job-update', listener); return () => ipcRenderer.removeListener('job-update', listener); },
  onFiles: callback => { const listener = (_event, files) => callback(files); ipcRenderer.on('files-added', listener); return () => ipcRenderer.removeListener('files-added', listener); },
});
