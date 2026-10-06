const R = '/Users/sequoyahgeber/dev/File converter';
const { detectEngines, inspectFile, convert } = require(R + '/electron/engine.cjs');
const fs = require('node:fs');
(async () => {
  const P = process.argv[2], resources = R + '/resources', engines = await detectEngines(resources);
  const file = await inspectFile(P + '/in.png', engines, resources);
  try { const r = await convert(file, 'jpg', P + '/mnt/out', {}, engines, resources); console.log(JSON.stringify({ success: true, r })); }
  catch (e) { console.log(JSON.stringify({ success: false, code: e.code, error: String(e.message).slice(0, 140) })); }
  console.log('left on volume:', JSON.stringify(fs.readdirSync(P + '/mnt/out')));
})();
