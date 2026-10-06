// Re-runs the Electron reproductions against the fixed engine.
const R = '/Users/sequoyahgeber/dev/File converter';
const { detectEngines, inspectFile, convert } = require(R + '/electron/engine.cjs');
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const pixel = (file) => {
  const png = file.endsWith('.jxl') ? file + '.png' : file;
  if (png !== file) execFileSync('/opt/homebrew/bin/djxl', [file, png], { stdio: 'ignore' });
  return execFileSync('/opt/homebrew/bin/magick', [png, '-format', '%[pixel:p{4,4}]', 'info:']).toString();
};
(async () => {
  const D = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-after-')), resources = R + '/resources';
  const engines = await detectEngines(resources);
  const result = {};
  const magick = (args) => execFileSync('/opt/homebrew/bin/magick', args);
  // 1. Percent-sign name next to a pattern match, and an output folder containing %.
  await fsp.mkdir(D + '/in'); await fsp.mkdir(D + '/Q3%done 100%');
  magick(['-size', '8x8', 'xc:red', D + '/in/red.jpg']); magick(['-size', '8x8', 'xc:lime', D + '/in/scan000.jpg']);
  await fsp.rename(D + '/in/red.jpg', D + '/in/scan%03d.jpg');
  const pct = await inspectFile(D + '/in/scan%03d.jpg', engines, resources);
  for (const target of ['jxl', 'png']) {
    const r = await convert(pct, target, D + '/Q3%done 100%', {}, engines, resources);
    result['percent-' + target] = { name: r.name, pixel: pixel(r.path) };
  }
  // 2. exFAT output folder.
  const img = D + '/exfat.dmg', mnt = D + '/mnt';
  execFileSync('hdiutil', ['create', '-quiet', '-size', '20m', '-fs', 'ExFAT', '-volname', 'FLUXAFTER', img]);
  execFileSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mnt, img]);
  try {
    const blue = D + '/in/blue.png'; magick(['-size', '8x8', 'xc:blue', blue]);
    const r = await convert(await inspectFile(blue, engines, resources), 'jpg', mnt + '/out', {}, engines, resources);
    const again = await convert(await inspectFile(blue, engines, resources), 'jpg', mnt + '/out', {}, engines, resources);
    result.exfat = { first: r.name, second: again.name, entries: fs.readdirSync(mnt + '/out') };
  } finally { execFileSync('hdiutil', ['detach', '-quiet', mnt]); }
  // 3. Names: uppercase extension and decomposed accents.
  magick(['-size', '8x8', 'xc:gray', D + '/in/Photo.JPG']);
  const nfd = 'café.png'; magick(['-size', '8x8', 'xc:gray', D + '/in/' + nfd]);
  result.names = [
    (await convert(await inspectFile(D + '/in/Photo.JPG', engines, resources), 'png', D + '/names', {}, engines, resources)).name,
    (await convert(await inspectFile(D + '/in/' + nfd, engines, resources), 'jpg', D + '/names', {}, engines, resources)).name,
  ];
  // 4. SVG disguised as TIFF, and a real SVG, referencing a neighbouring private image.
  magick(['-size', '8x8', 'xc:red', D + '/in/private.png']);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><rect width="8" height="8" fill="#00f"/><image width="8" height="8" xlink:href="private.png"/><image width="8" height="8" xlink:href="file://${D}/in/private.png"/></svg>`;
  await fsp.writeFile(D + '/in/drawing.svg', svg); await fsp.writeFile(D + '/in/disguised.tiff', svg);
  for (const name of ['drawing.svg', 'disguised.tiff'])
    for (const target of ['png', 'jxl']) {
      try {
        const r = await convert(await inspectFile(D + '/in/' + name, engines, resources), target, D + '/svg', {}, engines, resources);
        result[name + '->' + target] = { pixel: pixel(r.path), expected: 'blue, not red' };
      } catch (e) { result[name + '->' + target] = { rejected: e.message.slice(0, 100) }; }
    }
  // 5. HLS playlist naming another local media file.
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5', '-t', '1', D + '/in/private.ts']);
  await fsp.writeFile(D + '/in/evil.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nprivate.ts\n#EXT-X-ENDLIST\n');
  const hls = await inspectFile(D + '/in/evil.m3u8', engines, resources);
  result.hls = { family: hls.family, targets: hls.targets?.length || 0, warning: hls.warning };
  // 6. Calibre HTML linking a local page outside its folder.
  if (engines.calibre) {
    await fsp.mkdir(D + '/doc'); await fsp.mkdir(D + '/elsewhere');
    await fsp.writeFile(D + '/elsewhere/private.html', '<html><body><p>LINKED-HTML-CANARY-5678</p></body></html>');
    await fsp.writeFile(D + '/doc/doc.html', `<html><body><h1>Doc</h1><p><a href="${D}/elsewhere/private.html">more</a></p></body></html>`);
    const doc = await inspectFile(D + '/doc/doc.html', engines, resources);
    try {
      const r = await convert(doc, 'mobi', D + '/mobi', {}, engines, resources);
      result.calibre = { canary: fs.readFileSync(r.path).includes('LINKED-HTML-CANARY-5678') };
    } catch (e) { result.calibre = { error: e.message.slice(0, 160) }; }
  }
  console.log(JSON.stringify(result, null, 1));
  await fsp.rm(D, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
