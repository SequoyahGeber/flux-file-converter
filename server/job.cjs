const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { inspectFile, convert, catalog, run } = require('../electron/engine.cjs');
const { compress, compressionOptions } = require('../electron/compression.cjs');
const { archiveFiles } = require('../electron/archives.cjs');
const { LIMITS, safeMetadata, options } = require('./security.cjs');
async function main() {
  const root = process.argv[2]; const spec = JSON.parse(await fs.readFile(path.join(root, 'job.json'), 'utf8'));
  const engines = JSON.parse(await fs.readFile('/app/server/engines.json', 'utf8')); catalog.extend(engines.registry);
  const resources = '/app/resources', output = path.join(root, 'output'); await fs.mkdir(output);
  const files = [];
  for (const input of spec.files) {
    const file = await inspectFile(path.join(root, 'input', input.name), engines, resources);
    if (file.family === 'image') {
      try { const m = await sharp(file.path).metadata(); if (m.width * m.height > 40_000_000 || m.pages > 100) throw new Error('Image exceeds the server pixel or frame limit.'); } catch (e) { if (/server pixel/.test(e.message)) throw e; }
    }
    if (file.duration > 3600) throw new Error('Media exceeds the one hour server limit.');
    files.push(file);
  }
  if (spec.operation === 'inspect') {
    const f = files[0]; f.compressionOptions = compressionOptions(f, engines); f.notes = Object.fromEntries(f.targets.map(t => [t, catalog.note(f, t)]));
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(safeMetadata(f))); return;
  }
  let result;
  if (spec.operation === 'convert') result = await convert(files[0], spec.target, output, options(spec.options), engines, resources);
  else if (spec.operation === 'compress') result = await compress(files[0], spec.compression, output, options(spec.options), engines, resources);
  else if (spec.operation === 'pack') result = await archiveFiles(files, 'pack', output, engines, resources);
  else if (spec.operation === 'extract') {
    const extracted = await archiveFiles(files, 'extract', output, engines, resources);
    // A browser downloads an extraction as a ZIP with validated entries, never a
    // server filesystem path. It can then be opened locally by the user.
    const zip = path.join(output, 'extracted-files.zip'); await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', extracted.path, zip]);
    result = { ...extracted, path: zip, name: 'extracted-files.zip', target: 'zip' };
  } else throw new Error('Unsupported operation.');
  const stat = await fs.lstat(result.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.output) throw new Error('Output exceeds the 5 GB download limit.');
  const relative = path.relative(root, result.path); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid engine output path.');
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ ...result, path: relative, size: stat.size }));
}
main().catch(e => { process.stderr.write(String(e.message).slice(0, 2000)); process.exitCode = 1; });
