// Test-only Electron entry point. Instrument the real process and persist paths
// before main.cjs imports them; nothing is exposed to the renderer.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const metrics = (globalThis.__fluxPerformance = {
  recording: false,
  probes: 0,
  activeProbes: 0,
  peakProbes: 0,
  inspections: 0,
  activeInspections: 0,
  peakInspections: 0,
  renames: 0,
});
const spawn = childProcess.spawn;
childProcess.spawn = function (command, ...args) {
  const counted = metrics.recording && path.basename(command) === 'ffprobe';
  if (counted) {
    metrics.probes++;
    metrics.peakProbes = Math.max(metrics.peakProbes, ++metrics.activeProbes);
  }
  const child = spawn.call(this, command, ...args);
  if (counted) child.once('close', () => metrics.activeProbes--);
  return child;
};
const rename = fsp.rename;
fsp.rename = async function (from, to) {
  const result = await rename.call(this, from, to);
  if (metrics.recording && to === path.join(process.env.FLUX_TEST_DATA_DIR, 'state.json'))
    metrics.renames++;
  return result;
};
const engine = require('../../electron/engine.cjs');
const inspectFile = engine.inspectFile;
engine.inspectFile = async (...args) => {
  const counted = metrics.recording;
  if (counted) {
    metrics.inspections++;
    metrics.peakInspections = Math.max(metrics.peakInspections, ++metrics.activeInspections);
  }
  try {
    return await inspectFile(...args);
  } finally {
    if (counted) metrics.activeInspections--;
  }
};
const filename = path.resolve(__dirname, '../../electron/main.cjs');
let source = fs.readFileSync(filename, 'utf8');
if (process.env.FLUX_TEST_SERIAL_INSPECTION === '1') {
  // Same real IPC and fixtures, with a one-worker serial reference baseline.
  const pool = 'Array.from({ length: 3 }, worker)';
  if (!source.includes(pool))
    throw new Error('Inspection pool changed; update the reference baseline.');
  source = source.replace(pool, 'Array.from({ length: 1 }, worker)');
}
const main = new Module(filename, module);
main.filename = filename;
main.paths = Module._nodeModulePaths(path.dirname(filename));
main._compile(source, filename);
