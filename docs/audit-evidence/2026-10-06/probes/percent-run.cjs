const R = '/Users/sequoyahgeber/dev/File converter';
const { detectEngines, inspectFile, convert } = require(R + '/electron/engine.cjs');
const { execFileSync } = require('node:child_process');
(async () => {
  const P = process.argv[2], resources = R + '/resources', engines = await detectEngines(resources);
  const file = await inspectFile(P + '/in/scan%03d.jpg', engines, resources);
  for (const target of ['jxl', 'png', 'webp']) {
    try {
      const r = await convert(file, target, P + '/out', {}, engines, resources);
      const p = r.path || r.output || r;
      const px = execFileSync('/opt/homebrew/bin/magick', [p, '-format', '%[pixel:p{16,16}]', 'info:']).toString();
      console.log(JSON.stringify({ target, success: true, centerPixel: px, expected: 'red (from scan%03d.jpg)' }));
    } catch (e) { console.log(JSON.stringify({ target, success: false, error: String(e.message).slice(0, 160) })); }
  }
})();
