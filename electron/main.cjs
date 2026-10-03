const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeImage,
  protocol,
  net,
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { APP_URL, CSP, assetPath, jobView } = require('./desktop-policy.cjs');
const { FileScopes } = require('./file-scopes.cjs');
const { detectEngines, inspectFile, convert, catalog } = require('./engine.cjs');
const { compress, compressionOptions } = require('./compression.cjs');
const { archiveFiles } = require('./archives.cjs');
if (process.env.FLUX_TEST_DATA_DIR) app.setPath('userData', process.env.FLUX_TEST_DATA_DIR);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let win,
  engines,
  resources,
  outputDir,
  outputBookmark,
  history = [],
  running = false,
  controller,
  quitting = false;
const scopes = new FileScopes((bookmark) => app.startAccessingSecurityScopedResource(bookmark));
const files = new Map(),
  filesByPath = new Map(),
  jobs = new Map();
let pendingOpen = [];
const userState = () => path.join(app.getPath('userData'), 'state.json');
async function persist() {
  const temp = userState() + '.tmp';
  await fs.writeFile(temp, JSON.stringify({ outputDir, outputBookmark, history }, null, 2), {
    mode: 0o600,
  });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, userState());
}
let saving = Promise.resolve();
function save() {
  saving = saving.catch(() => {}).then(persist);
  return saving;
}
function state() {
  return {
    engines: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, Boolean(v)])),
    enginePaths: engines,
    outputDir,
    history,
    running,
    files: [...files.values()],
    jobs: [...jobs.values()].map(jobView),
    families: catalog.families,
    version: app.getVersion(),
  };
}
function emit(job) {
  jobs.set(job.id, job);
  if (win && !win.isDestroyed()) win.webContents.send('job-update', jobView(job));
}
async function addPaths(paths) {
  if (
    !Array.isArray(paths) ||
    paths.length > 300 ||
    paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
  )
    throw new Error('Choose up to 300 files at a time.');
  if (files.size + [...new Set(paths)].filter((input) => !filesByPath.has(input)).length > 300)
    throw new Error('Remove files before adding more than 300.');
  const result = [];
  for (const input of [...new Set(paths)]) {
    try {
      const existing = files.get(filesByPath.get(input));
      if (existing) {
        result.push(existing);
        continue;
      }
      const stat = await fs.stat(input);
      const info = stat.isDirectory()
        ? {
            path: input,
            name: path.basename(input),
            ext: '',
            family: 'folder',
            size: 0,
            targets: [],
            details: 'Folder',
            warning: '',
          }
        : await inspectFile(input, engines, resources);
      const id = randomUUID();
      const file = {
        ...info,
        id,
        notes: Object.fromEntries(info.targets.map((t) => [t, catalog.note(info, t)])),
        compressionOptions: info.family === 'folder' ? [] : compressionOptions(info, engines),
      };
      if (info.warning && info.family !== 'unsupported')
        file.compressionOptions = file.compressionOptions.filter((o) => o.id === 'archive');
      if (files.size >= 300) throw new Error('Remove files before adding more than 300.');
      files.set(id, file);
      filesByPath.set(input, id);
      result.push(file);
    } catch (error) {
      result.push({
        id: randomUUID(),
        name: path.basename(input),
        path: input,
        ext: catalog.extension(input),
        size: 0,
        family: 'unsupported',
        targets: [],
        compressionOptions: [],
        warning: error.message,
      });
    }
  }
  return result;
}
async function chooseInputs(properties, title, buttonLabel) {
  const result = await dialog.showOpenDialog(win, {
    properties,
    title,
    buttonLabel,
    securityScopedBookmarks: Boolean(process.mas),
  });
  if (result.canceled) return [];
  try {
    result.filePaths.forEach((file, index) => scopes.acquire(file, result.bookmarks?.[index]));
    return await addPaths(result.filePaths);
  } finally {
    for (const file of result.filePaths) if (!filesByPath.has(file)) scopes.release(file);
  }
}
function handler(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== APP_URL
    )
      throw new Error('Invalid sender.');
    return callback(...args);
  });
}
async function createWindow() {
  win = new BrowserWindow({
    width: 1260,
    height: 850,
    minWidth: 960,
    minHeight: 680,
    title: 'Flux',
    backgroundColor: '#f8f9fb',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on('did-finish-load', async () => {
    if (pendingOpen.length) {
      const results = await addPaths(pendingOpen);
      pendingOpen = [];
      win.webContents.send('files-added', results);
    }
  });
  await win.loadURL(APP_URL);
  win.show();
}
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (win && engines) addPaths([filePath]).then((f) => win.webContents.send('files-added', f));
  else pendingOpen.push(filePath);
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    protocol.handle('app', async (request) => {
      try {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        const asset = await assetPath(request.url, path.join(__dirname, '..', 'dist'));
        const response = await net.fetch(pathToFileURL(asset).href);
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', CSP);
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(request.method === 'HEAD' ? null : response.body, {
          status: response.status,
          headers,
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
    engines = await detectEngines(resources);
    const defaultOutput = process.mas
      ? path.join(app.getPath('userData'), 'Converted Files')
      : path.join(app.getPath('downloads'), 'Flux');
    outputDir = defaultOutput;
    try {
      if ((await fs.stat(userState())).size > 2 * 1024 * 1024)
        throw new Error('Saved state is too large.');
      const saved = JSON.parse(await fs.readFile(userState(), 'utf8'));
      history = Array.isArray(saved.history)
        ? saved.history
            .filter(
              (item) =>
                item &&
                typeof item.id === 'string' &&
                typeof item.path === 'string' &&
                path.isAbsolute(item.path) &&
                typeof item.name === 'string' &&
                Number.isFinite(item.completedAt),
            )
            .slice(0, 100)
        : [];
      if (typeof saved.outputDir === 'string' && path.isAbsolute(saved.outputDir)) {
        if (process.mas && saved.outputDir !== defaultOutput) {
          if (typeof saved.outputBookmark !== 'string' || saved.outputBookmark.length > 65536)
            throw new Error('Choose the output folder again.');
          scopes.acquire('output', saved.outputBookmark);
          outputBookmark = saved.outputBookmark;
        }
        outputDir = saved.outputDir;
      }
    } catch {}
    handler('state', state);
    handler('select-files', () =>
      chooseInputs(['openFile', 'multiSelections'], 'Add files to Flux', 'Add files'),
    );
    handler('select-folder', () =>
      chooseInputs(['openDirectory'], 'Add a folder to your ZIP', 'Add folder'),
    );
    handler('add-paths', addPaths);
    handler('release-files', (ids) => {
      if (
        running ||
        !Array.isArray(ids) ||
        ids.length > 300 ||
        ids.some((id) => typeof id !== 'string')
      )
        throw new Error('Finish the batch before removing files.');
      for (const id of ids) {
        const file = files.get(id);
        if (file) {
          filesByPath.delete(file.path);
          scopes.release(file.path);
        }
        files.delete(id);
        jobs.delete(id);
      }
      return true;
    });
    handler('select-output', async () => {
      if (running) throw new Error('Finish the batch before changing the output folder.');
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose output folder',
        defaultPath: outputDir,
        buttonLabel: 'Choose folder',
        securityScopedBookmarks: Boolean(process.mas),
      });
      if (!result.canceled) {
        scopes.acquire('output', result.bookmarks?.[0]);
        outputDir = result.filePaths[0];
        outputBookmark = result.bookmarks?.[0];
        await save();
      }
      return outputDir;
    });
    handler('refresh-engines', async () => {
      engines = await detectEngines(resources);
      return state();
    });
    handler('open-format-list', async () => {
      const reference = app.isPackaged
        ? path.join(resources, 'reference')
        : path.join(__dirname, '..', 'reference');
      const error = await shell.openPath(path.join(reference, 'Conversion matrix.html'));
      if (error) throw new Error(error);
    });
    handler('describe-format', (ext) => {
      if (typeof ext !== 'string') throw new Error('Choose a valid format.');
      const family = catalog.family(ext);
      if (!family) throw new Error('This format is unknown.');
      const file = {
        ext,
        family: family.id,
        name: 'input.' + ext,
        hasAudio: true,
        hasVideo: true,
        outline: ext === 'otf' ? 'otf' : 'ttf',
      };
      const targets = catalog.targets(file, engines);
      if (
        family.id === 'font' &&
        ['woff', 'woff2', 'ttc'].includes(ext) &&
        !targets.includes('otf')
      )
        targets.push('otf');
      return targets;
    });
    handler('reveal', async (id) => {
      const item = history.find((h) => h.id === id) || jobs.get(id)?.result;
      if (!item) throw new Error('This result is unavailable.');
      try {
        await fs.access(item.path);
      } catch {
        throw new Error('This output has been moved or deleted.');
      }
      shell.showItemInFolder(item.path);
    });
    handler('open-output', async () => {
      await fs.mkdir(outputDir, { recursive: true });
      const error = await shell.openPath(outputDir);
      if (error) throw new Error(error);
    });
    handler('clear-history', async () => {
      history = [];
      await save();
      return history;
    });
    handler('cancel-jobs', () => {
      controller?.abort();
      return true;
    });
    handler('start-jobs', (requests) => {
      if (running) throw new Error('A batch is already running.');
      if (!Array.isArray(requests) || !requests.length || requests.length > 300)
        throw new Error('Choose between 1 and 300 files.');
      const batch = requests.map((r) => {
        const file = files.get(r.id);
        if (!file) throw new Error('Add this file again before converting.');
        const operation = ['compress', 'pack', 'extract'].includes(r.operation)
          ? r.operation
          : 'convert';
        if (operation === 'convert' && !file.targets.includes(r.target))
          throw new Error('Choose a valid output format.');
        if (
          operation === 'compress' &&
          !file.compressionOptions.some((o) => o.id === r.compression)
        )
          throw new Error('Choose a valid compression option.');
        if (operation === 'extract' && file.family !== 'archive')
          throw new Error('Choose a supported archive to extract.');
        const includeFiles =
          operation === 'pack' ? r.includeIds?.map((id) => files.get(id)) : [file];
        if (!includeFiles?.length || includeFiles.some((f) => !f) || includeFiles.length > 300)
          throw new Error('Choose valid files for your ZIP.');
        return {
          id: file.id,
          file,
          includeFiles,
          target: r.target,
          compression: r.compression,
          operation,
          options: r.options || {},
          status: 'queued',
          progress: 0,
        };
      });
      if (new Set(batch.map((j) => j.id)).size !== batch.length)
        throw new Error('A file can only appear once per batch.');
      const destination = outputDir;
      running = true;
      controller = new AbortController();
      jobs.clear();
      batch.forEach(emit);
      (async () => {
        try {
          for (const job of batch) {
            if (controller.signal.aborted) {
              emit({ ...job, status: 'cancelled' });
              continue;
            }
            emit({ ...job, status: 'running', progress: 1 });
            let last = 0;
            try {
              const context = {
                signal: controller.signal,
                onProgress: (p) => {
                  if (Date.now() - last > 120 || p >= 98) {
                    last = Date.now();
                    emit({ ...job, status: 'running', progress: Math.round(p) });
                  }
                },
              };
              const result = ['pack', 'extract'].includes(job.operation)
                ? await archiveFiles(
                    job.includeFiles,
                    job.operation,
                    destination,
                    engines,
                    resources,
                    context,
                  )
                : job.operation === 'compress'
                  ? await compress(
                      job.file,
                      job.compression,
                      destination,
                      job.options,
                      engines,
                      resources,
                      context,
                    )
                  : await convert(
                      job.file,
                      job.target,
                      destination,
                      job.options,
                      engines,
                      resources,
                      context,
                    );
              result.id = randomUUID();
              result.originalSize ??= job.file.size;
              history.unshift(result);
              history = history.slice(0, 100);
              await save();
              emit({ ...job, status: 'done', progress: 100, result });
            } catch (error) {
              emit({
                ...job,
                status: error.code === 'CANCELLED' ? 'cancelled' : 'error',
                progress: 0,
                error: error.message,
              });
            }
          }
        } finally {
          running = false;
          if (win && !win.isDestroyed())
            win.webContents.send('job-update', { batchComplete: true, history });
          if (quitting) app.quit();
        }
      })();
      return { started: true };
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Flux',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'File',
          submenu: [
            {
              label: 'Add Files…',
              accelerator: 'CmdOrCtrl+O',
              click: async () => {
                if (win && !win.isDestroyed())
                  win.webContents.send(
                    'files-added',
                    await chooseInputs(
                      ['openFile', 'multiSelections'],
                      'Add files to Flux',
                      'Add files',
                    ),
                  );
              },
            },
            { role: 'close' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
        { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
      ]),
    );
    app.setAboutPanelOptions({
      applicationName: 'Flux',
      applicationVersion: app.getVersion(),
      copyright: 'Local file conversion. Your files stay on your Mac.',
    });
    if (process.platform === 'darwin')
      app.dock.setIcon(
        nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'icon.png')),
      );
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('before-quit', (event) => {
    if (running) {
      event.preventDefault();
      quitting = true;
      controller?.abort();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => scopes.releaseAll());
}
