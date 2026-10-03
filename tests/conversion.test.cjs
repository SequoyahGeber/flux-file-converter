const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { detectEngines, inspectFile, convert, run, catalog } = require('../electron/engine.cjs');
const { compressionOptions, compress } = require('../electron/compression.cjs');
const { archiveFiles } = require('../electron/archives.cjs');
const resources = path.resolve('resources');
let root, output, engines, png, jpg, pdf, docx, mp4, wav, xlsx, pptx;
const inspect = (p) => inspectFile(p, engines, resources);
const convertTo = async (p, t, options = {}) =>
  convert(await inspect(p), t, output, options, engines, resources);
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-test-'));
  output = path.join(root, 'out');
  await fs.mkdir(output);
  engines = await detectEngines(resources);
  assert.ok(
    engines.ffmpeg &&
      engines.office &&
      engines.pandoc &&
      engines.pdf &&
      engines.archive &&
      engines.oxipng &&
      engines.qpdf &&
      engines.ghostscript,
    'Required installed engines must be available for the acceptance tests',
  );
  png = path.join(root, '透明 image.png');
  jpg = path.join(root, 'photo.jpg');
  await sharp({
    create: {
      width: 128,
      height: 96,
      channels: 4,
      background: { r: 112, g: 75, b: 186, alpha: 0.3 },
    },
  })
    .png({ compressionLevel: 0 })
    .toFile(png);
  await sharp(png)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, optimiseCoding: false })
    .toFile(jpg);
  pdf = path.join(root, 'two pages.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of ['Flux acceptance page one', 'Second page is retained']) {
    const p = doc.addPage([300, 200]);
    p.drawText(text, { x: 20, y: 100, size: 15, font });
  }
  await fs.writeFile(pdf, await doc.save({ useObjectStreams: false }));
  const md = path.join(root, 'document.md');
  await fs.writeFile(
    md,
    '# Flux document\n\nThis is a real document with a table.\n\n| Name | Value |\n|---|---|\n| Test | 42 |\n',
  );
  docx = (await convertTo(md, 'docx')).path;
  mp4 = path.join(root, 'movie.mp4');
  await run(engines.ffmpeg, [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=128x96:rate=12',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-crf',
    '16',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    mp4,
  ]);
  wav = path.join(root, 'voice.wav');
  await run(engines.ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=700:duration=2',
    wav,
  ]);
  const csv = path.join(root, 'sheet.csv');
  await fs.writeFile(csv, 'Name,Amount\n"Tokyo, Japan",42\nSeoul,99\n');
  xlsx = (await convertTo(csv, 'xlsx')).path;
  pptx = path.join(root, 'slides.pptx');
  await fs.copyFile(path.resolve('tests/fixtures/slides.pptx'), pptx);
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
test('Image formats are real outputs; JPG flattens alpha; existing names are preserved', async () => {
  const original = await fs.readFile(png);
  const results = [];
  for (const target of ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf']) {
    const source = target === 'png' ? jpg : png;
    const result = await convertTo(source, target);
    results.push(result);
    assert.ok(result.size > 0);
    if (['jpg', 'png', 'webp', 'avif', 'tiff', 'gif'].includes(target))
      assert.equal(
        (await sharp(result.path).metadata()).format,
        target === 'jpg' ? 'jpeg' : target === 'avif' ? 'heif' : target,
      );
    if (target === 'bmp')
      assert.equal((await fs.readFile(result.path)).subarray(0, 2).toString(), 'BM');
    if (target === 'ico') {
      const h = await fs.readFile(result.path);
      assert.equal(h.readUInt16LE(2), 1);
      assert.equal(h.readUInt16LE(4), 1);
    }
    if (target === 'pdf')
      assert.equal((await PDFDocument.load(await fs.readFile(result.path))).getPageCount(), 1);
  }
  const again = await convertTo(png, 'jpg');
  assert.notEqual(again.path, results[0].path);
  assert.match(again.name, /\(1\)/);
  assert.deepEqual(await fs.readFile(png), original);
  const meta = await sharp(results[0].path).metadata();
  assert.equal(meta.hasAlpha, false);
});
test('Video converts into actual media containers, stills, GIF, and extracted audio', async () => {
  for (const target of [
    'mkv',
    'mov',
    'webm',
    'avi',
    'mpeg',
    'flv',
    'ts',
    'wmv',
    'gif',
    'jpg',
    'png',
    'mp3',
  ]) {
    const result = await convertTo(mp4, target);
    if (['gif', 'jpg', 'png'].includes(target))
      assert.ok((await sharp(result.path).metadata()).width > 0);
    else {
      const meta = JSON.parse(
        (await run(engines.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', result.path]))
          .stdout,
      );
      assert.ok(meta.streams.some((s) => s.codec_type === (target === 'mp3' ? 'audio' : 'video')));
    }
  }
});
test('Every advertised audio destination decodes successfully', async () => {
  for (const target of catalog.audioTargets.filter((t) => t !== 'wav')) {
    const result = await convertTo(wav, target);
    const meta = JSON.parse(
      (await run(engines.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', result.path]))
        .stdout,
    );
    assert.equal(meta.streams[0].codec_type, 'audio');
  }
});
test('DOCX converts to PDF, text, HTML and EPUB; PDF text and all pages survive', async () => {
  const result = await convertTo(docx, 'pdf');
  const extracted = await convertTo(result.path, 'txt');
  assert.match(await fs.readFile(extracted.path, 'utf8'), /real document/);
  for (const target of ['txt', 'html', 'epub', 'odt', 'rtf', 'md'])
    assert.ok((await convertTo(docx, target)).size > 0);
  const pages = await convertTo(pdf, 'png');
  assert.equal(pages.target, 'png');
  assert.match(pages.name, /pages.zip$/);
  const extraction = await archiveFiles(
    [await inspect(pages.path)],
    'extract',
    output,
    engines,
    resources,
  );
  const pageNames = await fs.readdir(extraction.path);
  assert.equal(pageNames.length, 2);
  const meta = await sharp(path.join(extraction.path, pageNames[0])).metadata();
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 400);
  const text = await convertTo(pdf, 'txt');
  assert.match(await fs.readFile(text.path, 'utf8'), /Second page is retained/);
  const rebuilt = await convertTo(pdf, 'docx');
  assert.ok(rebuilt.size > 0);
});
test('Spreadsheet and presentation conversions preserve meaningful content', async () => {
  const csv = await convertTo(xlsx, 'csv');
  assert.match(await fs.readFile(csv.path, 'utf8'), /Tokyo, Japan/);
  const tsv = await convertTo(xlsx, 'tsv');
  assert.match(await fs.readFile(tsv.path, 'utf8'), /"Name"\t"Amount"/);
  assert.ok((await convertTo(xlsx, 'pdf')).size > 0);
  assert.ok((await convertTo(xlsx, 'ods')).size > 0);
  const slides = await convertTo(pptx, 'pdf');
  const text = await convertTo(slides.path, 'txt');
  assert.match(await fs.readFile(text.path, 'utf8'), /presentation acceptance/);
  assert.ok((await convertTo(pptx, 'odp')).size > 0);
});
test('Data conversions validate tables, escape spreadsheet formulas, and reject dangerous XML', async () => {
  const file = path.join(root, 'data.json');
  await fs.writeFile(
    file,
    JSON.stringify([
      { name: '=1+1', amount: 4 },
      { name: 'hello, world', amount: 5 },
    ]),
  );
  const yaml = await convertTo(file, 'yaml');
  assert.match(await fs.readFile(yaml.path, 'utf8'), /amount: 4/);
  const csv = await convertTo(file, 'csv');
  assert.match(await fs.readFile(csv.path, 'utf8'), /'=1\+1/);
  const xml = await convertTo(file, 'xml');
  assert.match(await fs.readFile(xml.path, 'utf8'), /<record>/);
  await fs.writeFile(file, '{"nested":{"value":1}}');
  await assert.rejects(convertTo(file, 'csv'), /array of flat records/);
  const evil = path.join(root, 'evil.xml');
  await fs.writeFile(
    evil,
    '<!DOCTYPE data [<!ENTITY x SYSTEM "file:///etc/passwd">]><data>&x;</data>',
  );
  await assert.rejects(convertTo(evil, 'json'), /DOCTYPE/);
});
test('Lossless PNG and JPEG compression preserves decoded image bytes', async () => {
  for (const source of [png, jpg]) {
    const file = await inspect(source);
    const result = await compress(file, 'lossless', output, {}, engines, resources);
    assert.ok(result.size <= file.size);
    const original = await sharp(source).raw().toBuffer();
    const converted = await sharp(result.path).raw().toBuffer();
    assert.deepEqual(converted, original);
  }
  const lossless = await compress(await inspect(pdf), 'lossless', output, {}, engines, resources);
  const text = await convertTo(lossless.path, 'txt');
  assert.match(await fs.readFile(text.path, 'utf8'), /Second page/);
});
test('Lossy compression produces valid image, PDF, video, and audio outputs', async () => {
  for (const source of [png, pdf, mp4, wav]) {
    const result = await compress(
      await inspect(source),
      'lossy',
      output,
      { quality: 'small' },
      engines,
      resources,
    );
    assert.ok(result.size > 0);
    if (source === png) assert.equal((await sharp(result.path).metadata()).format, 'webp');
    if (source === pdf)
      assert.equal((await PDFDocument.load(await fs.readFile(result.path))).getPageCount(), 2);
    if ([mp4, wav].includes(source))
      assert.ok(
        JSON.parse(
          (await run(engines.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', result.path]))
            .stdout,
        ).streams.length,
      );
  }
});
test('Lossless video preserves decoded frame hashes', async () => {
  const result = await compress(await inspect(mp4), 'frames', output, {}, engines, resources);
  const hash = async (p) =>
    (
      await run(engines.ffmpeg, [
        '-nostdin',
        '-v',
        'error',
        '-i',
        p,
        '-map',
        '0:v:0',
        '-f',
        'framemd5',
        '-',
      ])
    ).stdout
      .split('\n')
      .filter((x) => x && !x.startsWith('#'))
      .map((x) => x.split(',').pop().trim());
  assert.deepEqual(await hash(result.path), await hash(mp4));
});
test('ZIP files and folders round-trip; archive repacking preserves contents', async () => {
  const folder = path.join(root, 'folder');
  await fs.mkdir(path.join(folder, 'empty'), { recursive: true });
  await fs.writeFile(path.join(folder, '日本語.txt'), 'こんにちは');
  const zipped = await archiveFiles(
    [{ path: folder, name: 'folder' }, await inspect(png)],
    'pack',
    output,
    engines,
    resources,
  );
  const unzipped = await archiveFiles(
    [await inspect(zipped.path)],
    'extract',
    output,
    engines,
    resources,
  );
  assert.equal(
    await fs.readFile(path.join(unzipped.path, 'folder', '日本語.txt'), 'utf8'),
    'こんにちは',
  );
  assert.deepEqual(
    await fs.readFile(path.join(unzipped.path, path.basename(png))),
    await fs.readFile(png),
  );
  assert.ok((await fs.stat(path.join(unzipped.path, 'folder', 'empty'))).isDirectory());
  for (const target of ['tar', 'tgz', 'tbz2', 'txz']) {
    const packed = await convertTo(zipped.path, target);
    const result = await archiveFiles(
      [await inspect(packed.path)],
      'extract',
      output,
      engines,
      resources,
    );
    assert.equal(
      await fs.readFile(path.join(result.path, 'folder', '日本語.txt'), 'utf8'),
      'こんにちは',
    );
  }
});
test('Unsafe archive paths and symlinks are rejected without publishing partial outputs', async () => {
  const evil = path.join(root, 'traversal.zip');
  await run(engines.archive, [
    '-c',
    "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escape.txt','bad'); z.close()",
    evil,
  ]);
  await assert.rejects(
    archiveFiles([await inspect(evil)], 'extract', output, engines, resources),
    /unsafe path/,
  );
  await assert.rejects(fs.access(path.join(root, 'escape.txt')));
  const symlink = path.join(root, 'link.zip');
  await run(engines.archive, [
    '-c',
    "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo('link'); i.external_attr=(0o120777 << 16); z.writestr(i,'/etc/passwd'); z.close()",
    symlink,
  ]);
  await assert.rejects(
    archiveFiles([await inspect(symlink)], 'extract', output, engines, resources),
    /Symlinks/,
  );
  assert.equal(
    (await fs.readdir(output)).some((f) => f.startsWith('.flux-')),
    false,
  );
});
test('Cancellation produces no result and cleans temporary conversion files', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    convert(await inspect(png), 'jpg', output, {}, engines, resources, {
      signal: controller.signal,
    }),
    /cancelled/i,
  );
  assert.equal(
    (await fs.readdir(output)).some((f) => f.startsWith('.flux-')),
    false,
  );
});
