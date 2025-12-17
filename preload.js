const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // ... inside contextBridge ...
  calculateAllSizes: (versions) => ipcRenderer.invoke('calculate-all-sizes', versions),
  editorGetXml: () => ipcRenderer.invoke('editor-get-xml'),
  editorSaveXml: (xml) => ipcRenderer.invoke('editor-save-xml', xml),
  editorGetRaw: (instanceName, levelKey) => ipcRenderer.invoke('editor-get-raw', instanceName, levelKey),
  editorSaveAll: (instanceName, levelKey, updates) => ipcRenderer.invoke('editor-save-all', instanceName, levelKey, updates),
  handleFirstRunImport: () => ipcRenderer.invoke('handle-first-run-import'),
  // Add these to the existing exposeInMainWorld block
  editorUpdateDescription: (key, desc) => ipcRenderer.invoke('editor-update-description', key, desc),
  editorUpdateStarRequest: (key, stars) => ipcRenderer.invoke('editor-update-star-request', key, stars),
  editorUpdateSong: (key, songData) => ipcRenderer.invoke('editor-update-song', key, songData),
  // NEW EXPOSURE
  editorRenameLevel: (key, newName) => ipcRenderer.invoke('editor-rename-level', key, newName),
  getVersionDefaults: (versionPath) => ipcRenderer.invoke('get-version-defaults', versionPath),
  onLaunchStatus: (callback) => ipcRenderer.on('launch-status', (event, message) => callback(message)),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  getInstances: () => ipcRenderer.invoke('get-instances'),
  createInstance: (data) => ipcRenderer.invoke('create-instance', data),
  editInstance: (originalName, data) => ipcRenderer.invoke('edit-instance', originalName, data),
  deleteInstance: (name) => ipcRenderer.invoke('delete-instance', name),
  launchInstance: (name) => ipcRenderer.invoke('launch-instance', name),
  getVersions: () => ipcRenderer.invoke('get-versions'),
  fetchRemoteVersions: () => ipcRenderer.invoke('fetch-remote-versions'),
  downloadVersion: (version) => ipcRenderer.send('download-version', version),
  repairVersion: (version) => ipcRenderer.send('repair-version', version),
  deleteVersion: (versionPath) => ipcRenderer.invoke('delete-version', versionPath),
  openVersionFolder: (versionPath) => ipcRenderer.invoke('open-version-folder', versionPath),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  
  // --- EDITOR API ---
  editorInitSession: (instanceName) => ipcRenderer.invoke('editor-init-session', instanceName),
  editorPersist: () => ipcRenderer.invoke('editor-persist'),
  editorGetLevels: () => ipcRenderer.invoke('editor-get-levels'),
  editorExportLevel: (levelKey, format) => ipcRenderer.invoke('editor-export-level', levelKey, format),
  editorImportLevel: (levelKey) => ipcRenderer.invoke('editor-import-level', levelKey),
  editorSetSong: (levelKey, songId, isCustom) => ipcRenderer.invoke('editor-set-song', levelKey, songId, isCustom),
  editorGetXml: () => ipcRenderer.invoke('editor-get-xml'),
  editorSaveXml: (xml) => ipcRenderer.invoke('editor-save-xml', xml),
  editorGetRaw: (instanceName, levelKey) => ipcRenderer.invoke('editor-get-raw', instanceName, levelKey),
  editorSaveAll: (instanceName, levelKey, updates) => ipcRenderer.invoke('editor-save-all', instanceName, levelKey, updates),

  onLaunchStatus: (callback) => ipcRenderer.on('launch-status', (event, message) => callback(message)),
  onLaunchComplete: (callback) => ipcRenderer.on('launch-complete', () => callback()),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onDownloadComplete: (callback) => ipcRenderer.on('download-complete', (event, data) => callback(data)),
  onUpdateProgressStart: (callback) => ipcRenderer.on('update-progress-start', () => callback()),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, percentage) => callback(percentage)),
  onUpdateProgressComplete: (callback) => ipcRenderer.on('update-progress-complete', () => callback())
  
});