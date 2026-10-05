const fs = require('fs/promises'),
  path = require('path'),
  cp = require('child_process'),
  util = require('util'),
  assert = require('assert/strict');
if (!process.argv[2]) throw new Error('Pass the ConversionEngine resource folder to test.');
const exec = util.promisify(cp.execFile),
  root = process.argv[2],
  node = path.join(root, 'bin/node'),
  worker = path.join(root, 'scripts/mac-engine.cjs');
(async () => {
  const base = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'flux-parity-'));
  async function job(input, target, operation = 'convert', compression) {
    const dir = await fs.mkdtemp(path.join(base, 'job-'));
    const out = path.join(dir, 'output');
    await fs.mkdir(out);
    const request = path.join(dir, 'request.json'),
      reply = path.join(dir, 'reply.json');
    await fs.writeFile(
      request,
      JSON.stringify({
        inputs: Array.isArray(input) ? input : [input],
        target,
        operation,
        compression,
        options: {},
        output: out,
        filename: 'result',
        reply,
      }),
    );
    await exec(node, ['--jitless', worker, request], {
      env: { HOME: dir, TMPDIR: dir, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      timeout: 150000,
    });
    const r = JSON.parse(await fs.readFile(reply));
    assert.ok((await fs.stat(r.path)).size > 0 || r.directory);
    console.log(
      'PASS',
      path.extname(Array.isArray(input) ? input[0] : input),
      operation,
      compression || target,
    );
    return r.path;
  }
  const png = path.join(base, 'image.png');
  await require(path.join(root, 'node_modules/sharp'))({
    create: { width: 60, height: 40, channels: 4, background: '#8264ca' },
  })
    .png()
    .toFile(png);
  await job(png, 'jpg');
  await job(png, 'webp', 'compress', 'lossy');
  await job(png, 'png', 'compress', 'lossless');
  const csv = path.join(base, 'sheet.csv');
  await fs.writeFile(csv, 'name,value\nSynthetic,42\n');
  await job(csv, 'xlsx');
  const md = path.join(base, 'note.md');
  await fs.writeFile(md, '# Synthetic parity check\n\nFlux local engines.');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'engines.json')));
  const slides = path.join(base, 'slides.pptx');
  await fs.copyFile(path.join(__dirname, 'fixtures/powerpoint-regression.pptx'), slides);
  await job(slides, 'pdf');
  const pdf = await job(md, 'pdf');
  await job(pdf, 'txt');
  await job(pdf, 'docx');
  await job(pdf, 'pdf', 'compress', 'lossless');
  const epub = await job(md, 'epub');
  await job(epub, 'txt');
  const mobi = await job(epub, 'mobi');
  await job(mobi, 'pdf');
  const table = path.join(base, 'records.json');
  await fs.writeFile(table, JSON.stringify([{ name: 'Synthetic', value: 42 }]));
  const parquet = await job(table, 'parquet');
  await job(parquet, 'json');
  const font = path.join(base, 'font.ttf');
  await fs.copyFile('/System/Library/Fonts/Supplemental/Arial.ttf', font);
  await job(font, 'woff2');
  if (manifest.engines.blender) {
    const obj = path.join(base, 'triangle.obj');
    await fs.writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    await job(obj, 'ply');
  }
  const zip = await job([png, md], 'zip', 'pack');
  await job(zip, 'unzip', 'extract');
  const ffmpeg = path.join(root, manifest.engines.ffmpeg);
  const mp4 = path.join(base, 'movie.mp4');
  await exec(
    ffmpeg,
    ['-f', 'lavfi', '-i', 'color=c=purple:s=64x48:d=1', '-c:v', 'libx264', '-y', mp4],
    { timeout: 30000 },
  );
  await job(mp4, 'mov');
  console.log('Representative bundled conversion checks passed; fixtures:', base);
})().catch((e) => {
  console.error(e.stderr || e);
  process.exitCode = 1;
});
