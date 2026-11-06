const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharp = require('sharp');
const { run } = require('../electron/process.cjs');
const resources = path.resolve(__dirname, '../resources');

async function scratch(t) {
  const parent = path.resolve('.test-output');
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'flux-bl-023-inspection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function tool(name) {
  for (const prefix of [
    '/opt/homebrew/opt/ffmpeg-full/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]) {
    const candidate = path.join(prefix, name);
    try {
      await fs.access(candidate, require('node:fs').constants.X_OK);
      return candidate;
    } catch {}
  }
}
async function isolatedEngine(runProbe = run) {
  const filename = path.resolve(__dirname, '../electron/engine.cjs');
  const localRequire = createRequire(filename);
  const calls = { metadata: 0, probes: [] };
  function countedSharp(...args) {
    const image = sharp(...args);
    const metadata = image.metadata;
    image.metadata = function (...options) {
      calls.metadata++;
      return metadata.apply(this, options);
    };
    return image;
  }
  countedSharp.concurrency = () => {};
  countedSharp.cache = () => {};
  const module = { exports: {} };
  vm.runInNewContext(
    await fs.readFile(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      __dirname: path.dirname(filename),
      process,
      Buffer,
      TextDecoder,
      console,
      require(id) {
        if (id === 'sharp') return countedSharp;
        if (id === './process.cjs')
          return {
            ...localRequire(id),
            run(command, args, options) {
              calls.probes.push({ command, args, options });
              return runProbe(command, args, options);
            },
          };
        return localRequire(id);
      },
    },
    { filename },
  );
  return { engine: module.exports, calls };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('extensionless MP4 reuses one real probe', async (t) => {
  if (process.platform === 'win32') return t.skip('The counting executable uses a POSIX shebang.');
  const ffmpeg = await tool('ffmpeg'),
    ffprobe = await tool('ffprobe');
  if (!ffmpeg || !ffprobe)
    return t.skip('Real FFmpeg and FFprobe are required for synthetic MP4 proof.');
  const dir = await scratch(t);
  const clip = path.join(dir, 'clip.mp4'),
    unknown = path.join(dir, 'clip');
  await run(ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=size=32x24:rate=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '0.4',
    '-c:v',
    'mpeg4',
    '-c:a',
    'aac',
    clip,
  ]);
  await fs.copyFile(clip, unknown);
  const log = path.join(dir, 'calls.jsonl'),
    stub = path.join(dir, 'ffprobe');
  const script = [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const result = spawnSync(${JSON.stringify(ffprobe)}, process.argv.slice(2), {`,
    "  stdio: 'inherit', shell: false,",
    '});',
    'process.exit(result.status ?? 1);',
  ];
  await fs.writeFile(stub, '#!' + process.execPath + '\n' + script.join('\n'), { mode: 0o755 });
  const { engine, calls } = await isolatedEngine();
  const engines = { ffmpeg, ffprobe: stub };
  const actual = await engine.inspectFile(unknown, engines, resources);
  const invocations = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 1, 'extensionless MP4 needs one probe, previously two');
  assert.ok(invocations[0].includes('-show_format'));
  assert.ok(invocations[0].includes('-show_streams'));
  assert.ok(invocations[0].includes('-protocol_whitelist'));
  assert.equal(actual.family, 'video');
  assert.equal(actual.warning, '');
  assert.equal(actual.hasVideo, true);
  assert.equal(actual.hasAudio, true);
  assert.ok(actual.duration > 0);
  assert.equal(actual.details, '32 × 24');
  assert.ok(actual.targets.includes('mkv'));
  assert.ok(actual.targets.includes('mp3'));
  assert.equal(calls.probes[0].options.timeout, 8000);
  const known = await engine.inspectFile(clip, engines, resources);
  for (const key of ['duration', 'hasVideo', 'hasAudio', 'pixelFormat', 'details', 'warning'])
    assert.equal(actual[key], known[key], key);
  assert.deepEqual(
    plain(actual.targets).filter((target) => target !== 'mp4'),
    plain(known.targets),
  );
  assert.equal(
    (await fs.readFile(log, 'utf8')).trim().split('\n').length,
    2,
    'known extension also probes once',
  );
  t.diagnostic('Extensionless MP4: 1 FFprobe invocation (baseline 2), format and streams retained.');
});

test('extensionless PNG reuses one metadata read', async (t) => {
  const dir = await scratch(t);
  const unknown = path.join(dir, 'picture'),
    known = path.join(dir, 'picture.png');
  await sharp({ create: { width: 17, height: 11, channels: 4, background: '#abcdef' } })
    .png()
    .toFile(known);
  await fs.copyFile(known, unknown);
  const { engine, calls } = await isolatedEngine();
  const actual = await engine.inspectFile(unknown, {}, resources);
  assert.equal(calls.metadata, 1, 'extensionless PNG needs one metadata read, previously two');
  assert.equal(actual.detected, 'png');
  assert.equal(actual.details, '17 × 11');
  assert.equal(actual.warning, '');
  assert.equal(calls.probes.length, 0);
  const expected = await engine.inspectFile(known, {}, resources);
  assert.equal(calls.metadata, 2, 'known PNG still reads metadata once');
  assert.deepEqual(plain(actual.targets), plain(expected.targets));
  t.diagnostic('Extensionless PNG: 1 sharp metadata call (baseline 2).');
});

test('cached probes reject manifests and exclude attached artwork', async (t) => {
  const dir = await scratch(t),
    unknown = path.join(dir, 'media');
  await fs.writeFile(unknown, Buffer.from([0, 255, 0, 255]));
  for (const format of ['hls', 'applehttp', 'concat', 'ffconcat', 'dash', 'webm_dash_manifest']) {
    const { engine, calls } = await isolatedEngine(async () => ({
      stdout: JSON.stringify({
        format: { format_name: format },
        streams: [{ codec_type: 'video' }],
      }),
    }));
    const info = await engine.inspectFile(
      unknown,
      { ffprobe: '/stub/ffprobe', ffmpeg: '/stub/ffmpeg' },
      resources,
    );
    assert.match(info.warning, /Playlists and manifests/);
    assert.deepEqual(plain(info.targets), []);
    assert.equal(calls.probes.length, 1);
  }
  const { engine, calls } = await isolatedEngine(async () => ({
    stdout: JSON.stringify({
      format: { format_name: 'mp3', duration: '3.2' },
      streams: [
        { codec_type: 'video', disposition: { attached_pic: 1 } },
        { codec_type: 'audio' },
      ],
    }),
  }));
  const info = await engine.inspectFile(
    unknown,
    { ffprobe: '/stub/ffprobe', ffmpeg: '/stub/ffmpeg' },
    resources,
  );
  assert.equal(info.hasVideo, false);
  assert.equal(info.hasAudio, true);
  assert.equal(info.details, '3 seconds');
  assert.equal(info.targets.includes('mp4'), false);
  assert.equal(calls.probes.length, 1);
});

test('corrupt and absent-engine inputs retain warnings and fallback', async (t) => {
  const dir = await scratch(t),
    unknown = path.join(dir, 'unknown'),
    corrupt = path.join(dir, 'bad.png');
  await fs.writeFile(unknown, Buffer.from([0, 255, 0, 255, 0, 255]));
  await fs.copyFile(unknown, corrupt);
  const { engine } = await isolatedEngine();
  const bad = await engine.inspectFile(corrupt, {}, resources);
  assert.ok(bad.warning);
  assert.deepEqual(plain(bad.targets), []);
  const unsupported = await engine.inspectFile(unknown, {}, resources);
  assert.equal(unsupported.family, 'unsupported');
  assert.match(unsupported.warning, /No installed engine/);
  const known = path.join(dir, 'no-engine.mp4');
  await fs.copyFile(unknown, known);
  const missing = await engine.inspectFile(known, {}, resources);
  assert.match(missing.warning, /engine.*unavailable/);
  const malformed = await isolatedEngine(async () => ({ stdout: '{broken' }));
  const info = await malformed.engine.inspectFile(unknown, { ffprobe: '/stub/ffprobe' }, resources);
  assert.equal(info.family, 'unsupported');
  assert.equal(malformed.calls.probes.length, 2, 'malformed media falls back to MIME detection');
});

test('unknown-extension probing receives cancellation and a bounded timeout', async (t) => {
  const dir = await scratch(t),
    unknown = path.join(dir, 'unknown');
  await fs.writeFile(unknown, Buffer.from([0, 255, 0, 255]));
  const controller = new AbortController();
  const { engine, calls } = await isolatedEngine(async (command, args, options) => {
    if (command !== '/stub/ffprobe') return run(command, args, options);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeout, 8000);
    controller.abort();
    throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  });
  await assert.rejects(engine.inspectFile(unknown, { ffprobe: '/stub/ffprobe' }, resources, {
    signal: controller.signal,
  }), (error) => error.code === 'CANCELLED');
  assert.equal(calls.probes[0].options.signal, controller.signal);
  const before = calls.metadata;
  await assert.rejects(engine.inspectFile(unknown, {}, resources, {
    signal: controller.signal,
  }), (error) => error.code === 'CANCELLED');
  assert.equal(calls.metadata, before, 'pre-aborted inspection does no metadata work');
});
