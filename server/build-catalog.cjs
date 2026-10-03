const fs = require('node:fs/promises');
const { detectEngines, catalog } = require('../electron/engine.cjs');
async function main() {
  const e = await detectEngines('/app/resources');
  e.registry = { images: e.imageRead || [], media: [], documents: e.documentInputs || [], office: e.officeInputs || {} };
  const families = catalog.families;
  const engineNames = Object.fromEntries(['images', 'ffmpeg', 'office', 'pandoc', 'pdf', 'archive', 'python', 'calibre', 'blender', 'data', 'qpdf', 'ghostscript', 'tesseract'].map(k => [k, Boolean(e[k])]));
  const formats = families.flatMap(f => f.formats.map(ext => { const file = { ext, family: f.id }; return { input: ext, family: f.id, targets: catalog.targets(file, e), notes: Object.fromEntries(catalog.targets(file, e).map(t => [t, catalog.note(file, t)])) }; }));
  await fs.writeFile('/app/server/engines.json', JSON.stringify(e));
  await fs.writeFile('/app/server/capabilities.json', JSON.stringify({ families, engines: engineNames, formats, limits: require('./security.cjs').LIMITS }));
}
main().catch(e => { console.error(e); process.exit(1); });
