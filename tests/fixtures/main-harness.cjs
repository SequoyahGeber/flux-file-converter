// Isolated main-process harness: runs the real IPC handlers with fake Electron,
// storage and timers. No production exports or renderer bridge are added.
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function createMainHarness(options = {}) {
  const filename = path.resolve(__dirname, '../../electron/main.cjs');
  const localRequire = createRequire(filename);
  const handlers = new Map(),
    timers = new Map(),
    writes = [],
    actions = [],
    messages = [];
  const hooks = options.hooks || {};
  let now = 0,
    timerId = 0,
    window,
    quits = 0,
    released = 0;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    setPath() {},
    getPath: (key) =>
      key === 'userData' && options.userDataDir ? options.userDataDir : '/flux-test/' + key,
    getVersion: () => 'test',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    setAboutPanelOptions() {},
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault: () => (prevented = true) });
      if (!prevented) {
        quits++;
        app.emit('will-quit');
      }
    },
  });
  class BrowserWindow {
    constructor() {
      window = this;
      const webContents = new EventEmitter();
      Object.assign(webContents, {
        mainFrame: { url: localRequire('./desktop-policy.cjs').APP_URL },
        setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        send: (channel, data) => messages.push({ channel, data: plain(data) }),
      });
      this.webContents = webContents;
    }
    isDestroyed() {
      return false;
    }
    async loadURL() {}
    show() {}
    static getAllWindows() {
      return [window];
    }
  }
  const storage = {
    async stat(input) {
      if (input.endsWith('state.json'))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => input.endsWith('/folder') };
    },
    async open() {
      await hooks.open?.();
      let text;
      actions.push('open');
      return {
        async writeFile(value) {
          text = value;
          actions.push('write');
          await hooks.write?.();
        },
        async sync() {
          actions.push('sync');
        },
        async close() {
          actions.push('close');
          storage.pending = text;
        },
      };
    },
    async chmod() {
      actions.push('chmod');
    },
    async rename() {
      await hooks.rename?.();
      actions.push('rename');
      writes.push({ at: now, text: storage.pending, state: JSON.parse(storage.pending) });
    },
    ...options.fs,
  };
  const defaultInspect = async (input) => ({
    path: input,
    name: path.basename(input),
    ext: 'png',
    family: 'image',
    size: 10,
    targets: ['jpg'],
    warning: '',
  });
  const defaultConvert = async (file) => ({
    path: '/flux-test/results/' + file.name,
    name: file.name,
    size: 5,
    completedAt: now,
  });
  const electron = {
    app,
    BrowserWindow,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showErrorBox: (...args) => {
        throw new Error(args.join(': '));
      },
    },
    shell: {},
    Menu: { setApplicationMenu() {}, buildFromTemplate: (items) => items },
    nativeImage: {},
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    net: {},
  };
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return electron;
      if (id === 'node:fs/promises') return storage;
      if (id === './engine.cjs')
        return {
          detectEngines: async () => ({}),
          inspectFile: options.inspectFile || defaultInspect,
          convert: options.convert || defaultConvert,
          sweepStages: options.sweepStages || (async () => {}),
          catalog: localRequire('./catalog.cjs'),
        };
      if (id === './file-scopes.cjs')
        return {
          FileScopes: class {
            acquire() {}
            release() {}
            releaseAll() {
              released++;
            }
          },
        };
      if (id === './compression.cjs')
        return {
          compressionOptions: () => [{ id: 'archive' }, { id: 'smaller' }],
        };
      if (id === './archives.cjs') return {};
      return localRequire(id);
    },
    __dirname: path.dirname(filename),
    process: { env: { FLUX_TEST_DATA_DIR: '/flux-test/userData' }, platform: 'linux' },
    AbortController,
    URL,
    console,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(await fs.readFile(filename, 'utf8'), context, { filename });
  await settle();
  return {
    app,
    writes,
    actions,
    messages,
    timers,
    hooks,
    get quits() {
      return quits;
    },
    get released() {
      return released;
    },
    state: () => plain(vm.runInContext('state()', context)),
    evaluate: (code) => vm.runInContext(code, context),
    invoke: async (channel, ...args) =>
      plain(
        await handlers.get(channel)(
          {
            sender: window.webContents,
            senderFrame: window.webContents.mainFrame,
          },
          ...args,
        ),
      ),
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
module.exports = { createMainHarness, deferred, settle };
