const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const engine = require('../electron/engine.cjs');
const { engineEnvironment, run } = require('../electron/process.cjs');
const { outputStem, baseStem } = require('../electron/io.cjs');
const resources = path.resolve('resources');

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-audit-1006-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const solid = (file, background) =>
  sharp({ create: { width: 8, height: 8, channels: 3, background } }).toFile(file);
async function centre(file) {
  const { data } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

test('output names strip extensions case-insensitively and keep combining marks', () => {
  assert.equal(baseStem('Photo.JPG', 'jpg'), 'Photo');
  assert.equal(baseStem('Backup.TAR.GZ', 'tar.gz'), 'Backup');
  assert.equal(outputStem('café'), 'café');
  assert.equal(outputStem('हिन्दी'), 'हिन्दी');
  assert.equal(outputStem('scan%03d[1]'), 'scan_03d_1_');
});

test('publishing falls back to an exclusive copy where hard links are unsupported', async (t) => {
  const dir = await scratch(t);
  const stage = path.join(dir, 'stage.txt');
  await fs.writeFile(stage, 'result');
  await fs.mkdir(path.join(dir, 'out'));
  await fs.writeFile(path.join(dir, 'out', 'stage.txt'), 'existing');
  const link = fss.promises.link;
  fss.promises.link = async () => {
    throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
  };
  t.after(() => (fss.promises.link = link));
  const published = await engine.publish(stage, path.join(dir, 'out'));
  assert.equal(path.basename(published), 'stage (1).txt');
  assert.equal(await fs.readFile(published, 'utf8'), 'result');
  assert.equal(await fs.readFile(path.join(dir, 'out', 'stage.txt'), 'utf8'), 'existing');
});

test('a % pattern in the source name or output folder converts the selected file', async (t) => {
  const engines = await engine.detectEngines(resources);
  if (!engines.magick) return t.skip('ImageMagick is not installed.');
  const dir = await scratch(t);
  await solid(path.join(dir, 'red.png'), '#ff0000');
  await solid(path.join(dir, 'scan000.png'), '#00ff00');
  await fs.rename(path.join(dir, 'red.png'), path.join(dir, 'scan%03d.png'));
  const output = path.join(dir, 'Q3%done 100%');
  const file = await engine.inspectFile(path.join(dir, 'scan%03d.png'), engines, resources);
  assert.equal(file.name, 'scan%03d.png');
  // The first is written by ImageMagick (non-sharp route); WebP uses sharp.
  const magickTarget = ['ppm', 'jxl', 'jp2'].find((t) => file.targets.includes(t));
  assert.ok(magickTarget, 'an ImageMagick-only output format is available');
  for (const target of [magickTarget, 'webp'].filter((t) => t && file.targets.includes(t))) {
    const result = await engine.convert(file, target, output, {}, engines, resources);
    assert.equal(path.dirname(result.path), output);
    // Read back from a pattern-free copy: ImageMagick would expand %d here too.
    const copy = path.join(dir, 'check.' + target),
      png = path.join(dir, 'check-' + target + '.png');
    await fs.copyFile(result.path, copy);
    await run(engines.magick, [copy, png]);
    const [r, g] = await centre(png);
    assert.ok(r > 200 && g < 50, `${target} converted the wrong file`);
  }
});

test('desktop ImageMagick runs under Flux policy; SVG references cannot embed local files', async (t) => {
  const engines = await engine.detectEngines(resources);
  if (!engines.magick) return t.skip('ImageMagick is not installed.');
  assert.match(engineEnvironment().MAGICK_CONFIGURE_PATH, /resources\/imagemagick/);
  const dir = await scratch(t);
  await solid(path.join(dir, 'private.png'), '#ff0000');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><rect width="8" height="8" fill="#0000ff"/><image width="8" height="8" xlink:href="private.png"/><image width="8" height="8" xlink:href="file://${dir}/private.png"/></svg>`;
  await fs.writeFile(path.join(dir, 'drawing.svg'), svg);
  await fs.writeFile(path.join(dir, 'disguised.tiff'), svg);
  // ImageMagick itself refuses SVG content (it would otherwise embed the image).
  await assert.rejects(
    run(engines.magick, [path.join(dir, 'disguised.tiff[0]'), path.join(dir, 'x.png')]),
    /not authorized|security policy/,
  );
  for (const name of ['drawing.svg', 'disguised.tiff']) {
    const file = await engine.inspectFile(path.join(dir, name), engines, resources);
    const result = await engine.convert(file, 'png', path.join(dir, 'out'), {}, engines, resources);
    const [r, , b] = await centre(result.path);
    assert.ok(b > 200 && r < 50, `${name} embedded a neighbouring file`);
  }
});

test('media playlists that name other local files are rejected', async (t) => {
  const engines = await engine.detectEngines(resources);
  if (!engines.ffmpeg || !engines.ffprobe) return t.skip('FFmpeg is not installed.');
  const dir = await scratch(t);
  await run(engines.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:rate=5',
    '-t',
    '1',
    path.join(dir, 'private.ts'),
  ]);
  await fs.writeFile(
    path.join(dir, 'list.m3u8'),
    '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nprivate.ts\n#EXT-X-ENDLIST\n',
  );
  const file = await engine.inspectFile(path.join(dir, 'list.m3u8'), engines, resources);
  assert.equal(file.targets.length, 0);
  assert.match(file.warning, /Playlists and manifests/);
});

test('Calibre HTML conversion does not add linked local pages', async (t) => {
  const engines = await engine.detectEngines(resources);
  if (!engines.calibre) return t.skip('Calibre is not installed.');
  const dir = await scratch(t);
  await fs.mkdir(path.join(dir, 'doc'));
  await fs.mkdir(path.join(dir, 'elsewhere'));
  await fs.writeFile(
    path.join(dir, 'elsewhere', 'private.html'),
    '<html><body><p>LINKED-HTML-CANARY</p></body></html>',
  );
  await fs.writeFile(
    path.join(dir, 'doc', 'doc.html'),
    `<html><body><h1>Doc</h1><a href="${dir}/elsewhere/private.html">more</a></body></html>`,
  );
  const file = await engine.inspectFile(path.join(dir, 'doc', 'doc.html'), engines, resources);
  const result = await engine.convert(file, 'mobi', path.join(dir, 'out'), {}, engines, resources);
  assert.equal((await fs.readFile(result.path)).includes('LINKED-HTML-CANARY'), false);
});

test('3D conversion rejects files referenced outside the model folder', async (t) => {
  const engines = await engine.detectEngines(resources);
  if (!engines.blender) return t.skip('Blender is not installed.');
  const dir = await scratch(t);
  await fs.mkdir(path.join(dir, 'Downloads'));
  await fs.mkdir(path.join(dir, 'private'));
  await fs.writeFile(path.join(dir, 'private', 'notes.txt'), 'LOCAL-FILE-CANARY');
  await solid(path.join(dir, 'Downloads', 'texture.png'), '#13579b');
  const script = path.join(dir, 'make.py');
  await fs.writeFile(
    script,
    `import bpy, sys
out, reference = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add()
mat = bpy.data.materials.new('m'); mat.use_nodes = True
node = mat.node_tree.nodes.new('ShaderNodeTexImage')
image = bpy.data.images.new('ref', 4, 4); image.source = 'FILE'; image.filepath = reference
node.image = image
bpy.context.active_object.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=out, relative_remap=False)
`,
  );
  const make = (name, reference) =>
    run(engines.blender, [
      '-b',
      '--factory-startup',
      '--python',
      script,
      '--',
      path.join(dir, 'Downloads', name),
      reference,
    ]);
  await make('attack.blend', '//../private/notes.txt');
  await make('textured.blend', '//texture.png');
  const attack = await engine.inspectFile(
    path.join(dir, 'Downloads', 'attack.blend'),
    engines,
    resources,
  );
  await assert.rejects(
    engine.convert(attack, 'fbx', path.join(dir, 'out'), {}, engines, resources),
    /outside its folder/,
  );
  const textured = await engine.inspectFile(
    path.join(dir, 'Downloads', 'textured.blend'),
    engines,
    resources,
  );
  const result = await engine.convert(
    textured,
    'fbx',
    path.join(dir, 'out'),
    {},
    engines,
    resources,
  );
  assert.equal((await fs.readFile(result.path)).includes('LOCAL-FILE-CANARY'), false);
});

test('native and desktop helper scripts stay byte-identical', async () => {
  for (const name of ['models.py', 'archive.py', 'advanced.py'])
    assert.deepEqual(
      await fs.readFile(path.join('native', name)),
      await fs.readFile(path.join('resources', name)),
      name,
    );
});

test('chunk uploads report busy server streams with Retry-After and expose the confirmed offset', async (t) => {
  const { createApp } = require('../server/app.cjs');
  const { LIMITS } = require('../server/security.cjs');
  const storage = await scratch(t);
  const app = await createApp(
    { storage },
    {
      auth: async (req) => ({
        id: String(req.headers['x-test-user']).padEnd(64, '0'),
        email: req.headers['x-test-user'] + '@example.com',
      }),
      scan: async () => 'full',
      capabilities: { formats: [], families: [] },
      rpc: async () => ({}),
    },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const http = require('node:http');
  const port = app.server.address().port;
  const call = (user, method, url, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { port, method, path: url, headers: { 'x-test-user': user, ...headers } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ res, body: text ? JSON.parse(text) : {} }));
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  const start = async (user) =>
    (
      await call(user, 'POST', '/api/uploads', JSON.stringify({ name: 'a.bin', size: 1024 }), {
        'content-type': 'application/json',
      })
    ).body.id;
  const held = [];
  t.after(() => held.forEach((request) => request.destroy()));
  for (let i = 0; i < LIMITS.uploadStreams; i++) {
    const user = 'held' + i,
      id = await start(user);
    const request = http.request({
      port,
      method: 'PUT',
      path: '/api/uploads/' + id,
      headers: {
        'x-test-user': user,
        'content-type': 'application/octet-stream',
        'content-length': 1024,
        'x-flux-offset': '0',
      },
    });
    request.on('error', () => {});
    request.write(Buffer.alloc(1));
    held.push(request);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const id = await start('waiting');
  const chunk = { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' };
  const busy = await call('waiting', 'PUT', '/api/uploads/' + id, Buffer.alloc(1024), chunk);
  assert.equal(busy.res.statusCode, 429);
  assert.equal(busy.res.headers['retry-after'], '2');
  held.splice(0).forEach((request) => request.destroy());
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stored = await call('waiting', 'PUT', '/api/uploads/' + id, Buffer.alloc(1024), chunk);
  assert.equal(stored.res.statusCode, 200);
  const confirmed = await call('waiting', 'GET', '/api/uploads/' + id);
  assert.deepEqual(confirmed.body, { offset: 1024, size: 1024, busy: false });
  assert.equal((await call('other', 'GET', '/api/uploads/' + id)).res.statusCode, 404);
});
