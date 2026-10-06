const R = '/Users/sequoyahgeber/dev/File converter';
const { detectEngines, inspectFile, convert } = require(R + '/electron/engine.cjs');
const fs = require('node:fs');
(async () => {
  const P = process.argv[2], resources = R + '/resources';
  const engines = await detectEngines(resources);
  const file = await inspectFile(P + '/home/Downloads/model.blend', engines, resources);
  for (const target of ['fbx', 'blend', 'glb', 'obj']) {
    try {
      const r = await convert(file, target, P + '/out', {}, engines, resources);
      const p = r.path || r.output || r;
      const bytes = fs.readFileSync(typeof p === 'string' ? p : JSON.stringify(p));
      console.log(JSON.stringify({ target, success: true, containsCanary: bytes.includes('AUDIT-LOCAL-FILE-CANARY-7731') }));
    } catch (e) { console.log(JSON.stringify({ target, success: false, error: String(e.message).slice(0, 160) })); }
  }
})();
