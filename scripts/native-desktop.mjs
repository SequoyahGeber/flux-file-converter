import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'mac/Flux/DesktopUI');
execFileSync(resolve(root, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir'], {
  cwd: root,
  stdio: 'inherit',
});
const bridge = `
const call = (method, args) => window.webkit.messageHandlers.local.postMessage({method, args: args ?? null});
const updates = new Set(), files = new Set();
window.addEventListener('flux-native', event => {
  const payload = JSON.parse(event.detail);
  for (const listener of payload.event === 'files' ? files : updates) listener(payload.value);
});
window.flux = Object.freeze({
  getState: () => call('getState'), selectFiles: () => call('selectFiles'),
  selectFolder: () => Promise.reject(new Error('Select regular files to ZIP in this local beta.')),
  addDroppedFiles: () => Promise.reject(new Error('Use Choose files to grant access to these files.')),
  releaseFiles: ids => call('releaseFiles', ids), selectOutput: () => call('selectOutput'),
  start: jobs => call('start', jobs), cancel: () => call('cancel'), reveal: id => call('reveal', id),
  openOutput: () => call('openOutput'), clearHistory: () => call('clearHistory'),
  refreshEngines: () => call('refreshEngines'), openFormatList: () => call('openFormatList'),
  describeFormat: ext => call('describeFormat', ext),
  onUpdate: fn => { updates.add(fn); return () => updates.delete(fn); },
  onFiles: fn => { files.add(fn); return () => files.delete(fn); }
});`;
await writeFile(resolve(out, 'native-bridge.js'), bridge);
let html = await readFile(resolve(out, 'index.html'), 'utf8');
html = html.replace(
  /content="default-src[^\"]+"/,
  `content="default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"`,
);
html = html.replace('</head>', '<script src="./native-bridge.js"></script></head>');
await writeFile(resolve(out, 'index.html'), html);
