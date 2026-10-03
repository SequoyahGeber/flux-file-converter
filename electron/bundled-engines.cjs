const fs = require('node:fs/promises');
const path = require('node:path');
const REQUIRED_ENGINES = [
  'ffmpeg',
  'ffprobe',
  'office',
  'pandoc',
  'pdf',
  'python',
  'qpdf',
  'ghostscript',
  'jpegtran',
  'oxipng',
  'cwebp',
  'magick',
  'sevenzip',
  'tesseract',
  'calibre',
  'blender',
];

async function bundledEngines(resources) {
  const root = await fs.realpath(resources);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'engines.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.engines || typeof manifest.engines !== 'object')
    throw new Error('The bundled conversion engines need to be rebuilt.');
  const engines = {};
  for (const name of REQUIRED_ENGINES) {
    const relative = manifest.engines[name];
    if (typeof relative !== 'string' || path.isAbsolute(relative))
      throw new Error(`The bundled ${name} engine is missing.`);
    const file = await fs.realpath(path.resolve(root, relative));
    if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile())
      throw new Error(`The bundled ${name} engine is invalid.`);
    await fs.access(file, fs.constants.X_OK);
    engines[name] = file;
  }
  return engines;
}
module.exports = { bundledEngines, REQUIRED_ENGINES };
