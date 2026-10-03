const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { detectEngines, inspectFile, convert, run, catalog } = require('../electron/engine.cjs');
const { archiveFiles } = require('../electron/archives.cjs');
const resources = path.resolve('resources');
let root, out, engines;
const inspect = (p) => inspectFile(p, engines, resources);
const to = async (p, target) => convert(await inspect(p), target, out, {}, engines, resources);
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-extended-'));
  out = path.join(root, 'out');
  engines = await detectEngines(resources);
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
test('Engine discovery expands the catalog; unknown extensions are identified from contents', async () => {
  assert.ok(catalog.families.reduce((n, f) => n + f.formats.length, 0) > 650);
  const disguised = path.join(root, 'photo.unknown');
  await sharp({ create: { width: 64, height: 32, channels: 3, background: '#8060ba' } })
    .png()
    .toFile(disguised);
  const info = await inspect(disguised);
  assert.equal(info.family, 'image');
  const converted = await to(disguised, 'jpg');
  assert.equal((await sharp(converted.path).metadata()).format, 'jpeg');
});
test('Less common images and raster-embedded SVG are actual formats', async () => {
  const input = path.join(root, 'original.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#7c5aba' } })
    .png()
    .toFile(input);
  for (const target of ['psd', 'qoi', 'exr', 'tga', 'jp2', 'heic', 'svg']) {
    assert.ok(
      catalog.targets(await inspect(input), engines).includes(target),
      `Engine advertises ${target}`,
    );
    const result = await to(input, target);
    const back = await to(result.path, 'png');
    assert.equal((await sharp(back.path).metadata()).width, 40);
  }
});
test('Unencrypted ebooks convert to and from Kindle formats', async () => {
  const text = path.join(root, 'book.md');
  await fs.writeFile(text, '# Flux ebook\n\nThis text should survive ebook conversion.');
  const epub = await to(text, 'epub');
  for (const target of ['mobi', 'azw3']) {
    const result = await to(epub.path, target);
    const plain = await to(result.path, 'txt');
    assert.match(await fs.readFile(plain.path, 'utf8'), /survive ebook conversion/);
  }
});
test('Font containers round-trip without changing glyph outlines', async () => {
  const font = path.join(root, 'fixture.ttf');
  await run(engines.python, [
    '-c',
    "from fontTools.fontBuilder import FontBuilder; from fontTools.pens.ttGlyphPen import TTGlyphPen; import sys; f=FontBuilder(1000,isTTF=True); f.setupGlyphOrder(['.notdef','A']); p=TTGlyphPen(None); p.moveTo((100,0)); p.lineTo((500,800)); p.lineTo((900,0)); p.closePath(); g=p.glyph(); f.setupGlyf({'.notdef':TTGlyphPen(None).glyph(),'A':g}); f.setupHorizontalMetrics({'.notdef':(1000,0),'A':(1000,100)}); f.setupHorizontalHeader(ascent=900,descent=-100); f.setupCharacterMap({65:'A'}); f.setupNameTable({'familyName':'Flux Fixture','styleName':'Regular'}); f.setupOS2(sTypoAscender=900,sTypoDescender=-100,usWinAscent=900,usWinDescent=100); f.setupPost(); f.setupMaxp(); f.save(sys.argv[1])",
    font,
  ]);
  for (const target of ['woff', 'woff2']) {
    const converted = await to(font, target);
    const restored = await to(converted.path, 'ttf');
    await run(engines.python, [
      '-c',
      "from fontTools.ttLib import TTFont; import sys; a,b=map(TTFont,sys.argv[1:]); assert a.getGlyphOrder()==b.getGlyphOrder(); assert a['glyf']['A'].coordinates==b['glyf']['A'].coordinates",
      font,
      restored.path,
    ]);
  }
});
test('Parquet, Feather, NDJSON, and SQLite exports retain records', async () => {
  const json = path.join(root, 'records.json');
  await fs.writeFile(
    json,
    JSON.stringify([
      { city: 'Tokyo', amount: 42 },
      { city: 'Seoul', amount: 99 },
    ]),
  );
  for (const target of ['parquet', 'feather', 'ndjson']) {
    const converted = await to(json, target);
    const restored = await to(converted.path, 'json');
    assert.deepEqual(JSON.parse(await fs.readFile(restored.path, 'utf8')), [
      { city: 'Tokyo', amount: 42 },
      { city: 'Seoul', amount: 99 },
    ]);
  }
  const db = path.join(root, 'records.sqlite');
  await run(engines.python, [
    '-c',
    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE records(city TEXT,amount INTEGER)'); c.execute(\"INSERT INTO records VALUES ('Tokyo',42)\"); c.commit(); c.close()",
    db,
  ]);
  const exported = await to(db, 'json');
  assert.equal(JSON.parse(await fs.readFile(exported.path, 'utf8')).records[0].amount, 42);
});
test('Subtitle timing and text survive conversion', async () => {
  const srt = path.join(root, 'captions.srt');
  await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:03,000\nFlux subtitle acceptance\n');
  const vtt = await to(srt, 'vtt');
  assert.match(await fs.readFile(vtt.path, 'utf8'), /WEBVTT/);
  assert.match(await fs.readFile(vtt.path, 'utf8'), /Flux subtitle acceptance/);
  const restored = await to(vtt.path, 'srt');
  assert.match(await fs.readFile(restored.path, 'utf8'), /00:00:01,000/);
});
test('3D meshes convert to GLB, STL, PLY, Blender, and OBJ with bundled assets', async () => {
  const obj = path.join(root, 'triangle.obj');
  await fs.writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  for (const target of ['glb', 'stl', 'ply', 'blend', 'gltf', 'fbx']) {
    const result = await to(obj, target);
    assert.ok(result.size > 0);
    if (target === 'glb')
      assert.equal((await fs.readFile(result.path)).subarray(0, 4).toString(), 'glTF');
    if (target === 'gltf') assert.match(result.name, /assets.zip$/);
  }
});
test('7Z round-trip uses safe streaming extraction', async () => {
  const txt = path.join(root, 'original.txt');
  await fs.writeFile(txt, 'A safe 7Z round trip.');
  const zipped = await archiveFiles([await inspect(txt)], 'pack', out, engines, resources);
  const seven = await to(zipped.path, '7z');
  const extracted = await archiveFiles(
    [await inspect(seven.path)],
    'extract',
    out,
    engines,
    resources,
  );
  assert.equal(
    await fs.readFile(path.join(extracted.path, 'original.txt'), 'utf8'),
    'A safe 7Z round trip.',
  );
});
test('Scanned PDF pages can become text with local OCR', async () => {
  const png = await sharp(
    Buffer.from(
      '<svg width="1200" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="300" fill="white"/><text x="80" y="160" font-family="Arial" font-size="56" fill="black">Flux scanned page acceptance</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(png);
  pdf.addPage([600, 150]).drawImage(embedded, { x: 0, y: 0, width: 600, height: 150 });
  const input = path.join(root, 'scan.pdf');
  await fs.writeFile(input, await pdf.save());
  const text = await to(input, 'txt');
  assert.match(await fs.readFile(text.path, 'utf8'), /scanned page acceptance/i);
});
