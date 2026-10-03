const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { detectEngines, inspectFile, convert, catalog } = require('./engine.cjs');
const { compress, compressionOptions } = require('./compression.cjs');
const { archiveFiles } = require('./archives.cjs');
if (process.env.FLUX_TEST_DATA_DIR) app.setPath('userData', process.env.FLUX_TEST_DATA_DIR);
let win, engines, resources, outputDir, history = [], running = false, controller, quitting = false;
const files = new Map(), jobs = new Map(); let pendingOpen = [];
const userState = () => path.join(app.getPath('userData'), 'state.json');
async function persist() {
  const temp = userState() + '.tmp'; await fs.writeFile(temp, JSON.stringify({ outputDir, history }, null, 2)); await fs.rename(temp, userState());
}
let saving = Promise.resolve();
function save() { saving = saving.catch(() => {}).then(persist); return saving; }
function state() { return { engines: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, Boolean(v)])), enginePaths: engines, outputDir, history, running, jobs: [...jobs.values()], families: catalog.families, version: app.getVersion() }; }
function emit(job) { jobs.set(job.id, job); if (win && !win.isDestroyed()) win.webContents.send('job-update', job); }
async function addPaths(paths) {
  if (!Array.isArray(paths) || paths.length > 300 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Choose up to 300 files at a time.');
  const result = [];
  for (const input of [...new Set(paths)]) {
    try {
      const existing = [...files.values()].find(f => f.path === input);
      if (existing) { result.push(existing); continue; }
      const stat = await fs.stat(input);
      const info = stat.isDirectory() ? { path: input, name: path.basename(input), ext: '', family: 'folder', size: 0, targets: [], details: 'Folder', warning: '' } : await inspectFile(input, engines, resources); const id = randomUUID();
      const file = { ...info, id, notes: Object.fromEntries(info.targets.map(t => [t, catalog.note(info, t)])), compressionOptions: info.family === 'folder' ? [] : compressionOptions(info, engines) };
      if (info.warning && info.family !== 'unsupported') file.compressionOptions = file.compressionOptions.filter(o => o.id === 'archive');
      files.set(id, file); result.push(file);
    } catch (error) { result.push({ id: randomUUID(), name: path.basename(input), path: input, ext: catalog.extension(input), size: 0, family: 'unsupported', targets: [], compressionOptions: [], warning: error.message }); }
  }
  return result;
}
function handler(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid sender.');
    return callback(...args);
  });
}
async function createWindow() {
  win = new BrowserWindow({ width: 1260, height: 850, minWidth: 960, minHeight: 680, title: 'Flux', backgroundColor: '#f8f9fb', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }, show: false });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.on('did-finish-load', async () => {
    if (pendingOpen.length) { const results = await addPaths(pendingOpen); pendingOpen = []; win.webContents.send('files-added', results); }
  });
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')); win.show();
}
app.on('open-file', (event, filePath) => { event.preventDefault(); if (win && engines) addPaths([filePath]).then(f => win.webContents.send('files-added', f)); else pendingOpen.push(filePath); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
app.on('second-instance', (_event, argv) => { if (win) { win.show(); win.focus(); } });
app.whenReady().then(async () => {
  resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources'); engines = await detectEngines(resources);
  outputDir = path.join(app.getPath('downloads'), 'Flux');
  try { const saved = JSON.parse(await fs.readFile(userState(), 'utf8')); outputDir = typeof saved.outputDir === 'string' && path.isAbsolute(saved.outputDir) ? saved.outputDir : outputDir; history = Array.isArray(saved.history) ? saved.history.slice(0, 100) : []; } catch {}
  handler('state', state);
  handler('select-files', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Add files to Flux', buttonLabel: 'Add files' }); return result.canceled ? [] : addPaths(result.filePaths); });
  handler('select-folder', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Add a folder to your ZIP', buttonLabel: 'Add folder' }); return result.canceled ? [] : addPaths(result.filePaths); });
  handler('add-paths', addPaths);
  handler('select-output', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose output folder', defaultPath: outputDir, buttonLabel: 'Choose folder' });
    if (!result.canceled) { outputDir = result.filePaths[0]; await save(); } return outputDir;
  });
  handler('refresh-engines', async () => { engines = await detectEngines(resources); return state(); });
  handler('open-format-list', async () => {
    const reference = app.isPackaged ? path.join(resources, 'reference') : path.join(__dirname, '..', 'reference');
    const error = await shell.openPath(path.join(reference, 'Conversion matrix.html')); if (error) throw new Error(error);
  });
  handler('describe-format', ext => {
    if (typeof ext !== 'string') throw new Error('Choose a valid format.');
    const family = catalog.family(ext); if (!family) throw new Error('This format is unknown.');
    const file = { ext, family: family.id, name: 'input.' + ext, hasAudio: true, hasVideo: true, outline: ext === 'otf' ? 'otf' : 'ttf' };
    const targets = catalog.targets(file, engines);
    if (family.id === 'font' && ['woff', 'woff2', 'ttc'].includes(ext) && !targets.includes('otf')) targets.push('otf');
    return targets;
  });
  handler('reveal', async id => {
    const item = history.find(h => h.id === id) || jobs.get(id)?.result;
    if (!item) throw new Error('This result is unavailable.');
    try { await fs.access(item.path); } catch { throw new Error('This output has been moved or deleted.'); }
    shell.showItemInFolder(item.path);
  });
  handler('open-output', async () => { await fs.mkdir(outputDir, { recursive: true }); const error = await shell.openPath(outputDir); if (error) throw new Error(error); });
  handler('clear-history', async () => { history = []; await save(); return history; });
  handler('cancel-jobs', () => { controller?.abort(); return true; });
  handler('start-jobs', requests => {
    if (running) throw new Error('A batch is already running.');
    if (!Array.isArray(requests) || !requests.length || requests.length > 300) throw new Error('Choose between 1 and 300 files.');
    const batch = requests.map(r => {
      const file = files.get(r.id); if (!file) throw new Error('Add this file again before converting.');
      const operation = ['compress', 'pack', 'extract'].includes(r.operation) ? r.operation : 'convert';
      if (operation === 'convert' && !file.targets.includes(r.target)) throw new Error('Choose a valid output format.');
      if (operation === 'compress' && !file.compressionOptions.some(o => o.id === r.compression)) throw new Error('Choose a valid compression option.');
      if (operation === 'extract' && file.family !== 'archive') throw new Error('Choose a supported archive to extract.');
      const includeFiles = operation === 'pack' ? r.includeIds?.map(id => files.get(id)) : [file];
      if (!includeFiles?.length || includeFiles.some(f => !f) || includeFiles.length > 300) throw new Error('Choose valid files for your ZIP.');
      return { id: file.id, file, includeFiles, target: r.target, compression: r.compression, operation, options: r.options || {}, status: 'queued', progress: 0 };
    });
    if (new Set(batch.map(j => j.id)).size !== batch.length) throw new Error('A file can only appear once per batch.');
    const destination = outputDir; running = true; controller = new AbortController(); jobs.clear(); batch.forEach(emit);
    (async () => {
      try {
        for (const job of batch) {
          if (controller.signal.aborted) { emit({ ...job, status: 'cancelled' }); continue; }
          emit({ ...job, status: 'running', progress: 1 });
          let last = 0;
          try {
            const context = { signal: controller.signal, onProgress: p => { if (Date.now() - last > 120 || p >= 98) { last = Date.now(); emit({ ...job, status: 'running', progress: Math.round(p) }); } } };
            const result = ['pack', 'extract'].includes(job.operation) ? await archiveFiles(job.includeFiles, job.operation, destination, engines, resources, context) : job.operation === 'compress' ? await compress(job.file, job.compression, destination, job.options, engines, resources, context) : await convert(job.file, job.target, destination, job.options, engines, resources, context);
            result.id = randomUUID(); result.originalSize ??= job.file.size;
            history.unshift(result); history = history.slice(0, 100); await save();
            emit({ ...job, status: 'done', progress: 100, result });
          } catch (error) { emit({ ...job, status: error.code === 'CANCELLED' ? 'cancelled' : 'error', progress: 0, error: error.message }); }
        }
      } finally {
        running = false;
        if (win && !win.isDestroyed()) win.webContents.send('job-update', { batchComplete: true, history });
        if (quitting) app.quit();
      }
    })();
    return { started: true };
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Flux', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Add Files…', accelerator: 'CmdOrCtrl+O', click: async () => { const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); if (!r.canceled) win.webContents.send('files-added', await addPaths(r.filePaths)); } }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
  app.setAboutPanelOptions({ applicationName: 'Flux', applicationVersion: app.getVersion(), copyright: 'Local file conversion. Your files stay on your Mac.' });
  if (process.platform === 'darwin') app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'icon.png')));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', event => {
  if (running) { event.preventDefault(); quitting = true; controller?.abort(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
