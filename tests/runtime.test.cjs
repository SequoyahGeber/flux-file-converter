const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run, engineEnvironment } = require('../electron/process.cjs');
const { assetPath, jobView } = require('../electron/desktop-policy.cjs');
const { writeAll } = require('../electron/io.cjs');
const { FileScopes } = require('../electron/file-scopes.cjs');
const { validateProfile, allowedLoader } = require('../scripts/mas.cjs');
const { bundledEngines, REQUIRED_ENGINES } = require('../electron/bundled-engines.cjs');

test('conversion tools receive a minimal environment without app credentials or code injection variables', () => {
  const env = engineEnvironment({
    HOME: '/safe',
    FLUX_SERVER: '1',
    FLUX_WORKER_SECRET: 'private',
    TUNNEL_TOKEN: 'private',
    AWS_SECRET_ACCESS_KEY: 'private',
    NODE_OPTIONS: '--require=/evil',
    PYTHONPATH: '/evil',
    DYLD_INSERT_LIBRARIES: '/evil',
    PATH: '/evil',
  });
  assert.equal(env.HOME, '/safe');
  assert.equal(env.OMP_NUM_THREADS, '1');
  for (const key of [
    'FLUX_WORKER_SECRET',
    'TUNNEL_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'NODE_OPTIONS',
    'PYTHONPATH',
    'DYLD_INSERT_LIBRARIES',
  ])
    assert.equal(env[key], undefined);
  assert.ok(!env.PATH.includes('evil'));
});

test('tool output is bounded and UTF-8 survives fragmented chunks', async () => {
  const lines = [];
  const result = await run(
    process.execPath,
    [
      '-e',
      "process.stdout.write('x'.repeat(2000000)); process.stderr.write('y'.repeat(200000)); const b=Buffer.from('日本語'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>{process.stdout.write(b.subarray(1));process.stdout.write('\\n')},10)",
    ],
    { onLine: (line) => lines.push(line) },
  );
  assert.equal(result.stdout.length, 1000000);
  assert.equal(result.stderr.length, 100000);
  assert.ok(result.stdout.endsWith('日本語\n'));
  assert.equal(lines.length, 1);
  assert.ok(lines.every((line) => line.length <= 8192));
});

test('media inspection rejects network input before contacting a remote endpoint', async (t) => {
  const http = require('node:http');
  let probe;
  for (const candidate of [
    '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
    '/usr/bin/ffprobe',
  ]) {
    try {
      await fs.access(candidate);
      probe = candidate;
      break;
    } catch {}
  }
  if (!probe) return t.skip('FFprobe is not installed on this test runner.');
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.end('untrusted');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      run(probe, ['-v', 'error', `http://127.0.0.1:${server.address().port}/file`], {
        timeout: 2000,
      }),
      /whitelist/,
    );
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('deadline and cancellation terminate a conversion process and its descendants', async () => {
  if (process.platform === 'win32') return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-process-test-'));
  try {
    const marker = path.join(directory, 'unexpected');
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),700)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    await assert.rejects(run(process.execPath, ['-e', parent], { timeout: 100 }), /time limit/);
    const controller = new AbortController();
    const operation = run(process.execPath, ['-e', parent], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(operation, (error) => error.code === 'CANCELLED');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    await assert.rejects(run('/missing/flux-tool', [], { timeout: 10 }), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('desktop resources cannot read traversal paths, symlinks or non-assets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-assets-test-'));
  try {
    const root = path.join(directory, 'dist');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'index.html'), '<html></html>');
    await fs.writeFile(path.join(directory, 'outside.html'), 'secret');
    await fs.writeFile(path.join(root, 'secret.json'), 'secret');
    await fs.symlink(path.join(directory, 'outside.html'), path.join(root, 'link.html'));
    assert.equal(
      await assetPath('app://flux/index.html', root),
      await fs.realpath(path.join(root, 'index.html')),
    );
    for (const url of [
      'file:///etc/passwd',
      'app://other/index.html',
      'app://flux/..%2foutside.html',
      'app://flux/link.html',
      'app://flux/secret.json',
      'app://flux/%00.html',
      'app://flux/%zz.html',
    ])
      await assert.rejects(assetPath(url, root));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('progress messages omit large inspection records and retain archive membership', () => {
  const file = { id: 'input', notes: { png: 'x'.repeat(100000) }, path: '/private/input' };
  const payload = jobView({
    id: 'job',
    operation: 'pack',
    status: 'running',
    progress: 20,
    includeFiles: [file],
    file,
  });
  assert.deepEqual(payload.includeIds, ['input']);
  assert.equal(payload.file, undefined);
  assert.ok(JSON.stringify(payload).length < 200);
});

test('streaming writes preserve all bytes after partial filesystem writes', async () => {
  const input = Buffer.from('all uploaded bytes must survive');
  const output = Buffer.alloc(input.length + 10);
  let cursor = 0;
  const handle = {
    write: async (buffer, offset, length, position) => {
      const count = Math.min(3, length);
      buffer.copy(output, position ?? cursor, offset, offset + count);
      cursor += count;
      return { bytesWritten: count };
    },
  };
  await writeAll(handle, input, 10);
  assert.deepEqual(output.subarray(10), input);
  output.fill(0);
  cursor = 0;
  await writeAll(handle, input);
  assert.deepEqual(output.subarray(0, input.length), input);
  await assert.rejects(
    writeAll({ write: async () => ({ bytesWritten: 0 }) }, input),
    /fully written/,
  );
});

test('security scopes are balanced when files are replaced, removed, and the app quits', () => {
  const active = new Set();
  let started = 0,
    stopped = 0;
  const scopes = new FileScopes((bookmark) => {
    const scope = ++started;
    active.add(scope);
    return () => {
      assert.ok(active.delete(scope));
      stopped++;
    };
  });
  scopes.acquire('file', 'first');
  scopes.acquire('file', 'second');
  scopes.acquire('output', 'folder');
  assert.equal(active.size, 2);
  scopes.release('file');
  scopes.release('file');
  assert.equal(active.size, 1);
  scopes.releaseAll();
  assert.equal(active.size, 0);
  assert.equal(started, stopped);
});

test('reopening an archive batch retains distinct file identities', async () => {
  const { mergeJob } = await import('../src/queue.mjs');
  const queue = [
    { id: 'a', target: 'jpg' },
    { id: 'b', target: 'pdf' },
    { id: 'c', target: 'zip' },
  ];
  const result = mergeJob(queue, {
    id: 'a',
    includeIds: ['a', 'b'],
    operation: 'pack',
    status: 'done',
    progress: 100,
    result: { name: 'files.zip' },
  });
  assert.deepEqual(
    result.map((file) => file.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    result.map((file) => file.target),
    ['jpg', 'pdf', 'zip'],
  );
  assert.equal(result[1].result.name, 'files.zip');
  assert.equal(result[2], queue[2]);
});

test('MAS builds cannot fall back to host tools or accept an escaping engine manifest', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-bundle-test-'));
  try {
    await assert.rejects(bundledEngines(directory), { code: 'ENOENT' });
    const tool = path.join(directory, 'tool');
    await fs.writeFile(tool, 'tool', { mode: 0o755 });
    const engines = Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, 'tool']));
    const manifest = path.join(directory, 'engines.json');
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, engines }));
    assert.equal(Object.keys(await bundledEngines(directory)).length, REQUIRED_ENGINES.length);
    const personal = { ...engines };
    delete personal.blender;
    await fs.writeFile(
      manifest,
      JSON.stringify({ schemaVersion: 1, engines: personal, excludedEngines: ['blender'] }),
    );
    assert.equal((await bundledEngines(directory)).blender, undefined);
    delete personal.ffmpeg;
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        engines: personal,
        excludedEngines: ['blender', 'ffmpeg'],
      }),
    );
    await assert.rejects(bundledEngines(directory), /ffmpeg engine is missing/);
    engines.ffmpeg = process.execPath;
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, engines }));
    await assert.rejects(bundledEngines(directory), /missing/);
    await fs.symlink(process.execPath, path.join(directory, 'external'));
    engines.ffmpeg = 'external';
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, engines }));
    await assert.rejects(bundledEngines(directory), /invalid/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('TestFlight signing rejects mismatched, expired, development or unprovisioned identities', () => {
  const profile = {
    team: '8MLN9FH4F9',
    identifier: '8MLN9FH4F9.com.sequoyah.flux.mac',
    expires: '2099-01-01T00:00:00Z',
    development: false,
    certificates: ['certificate'],
  };
  const options = {
    bundleId: 'com.sequoyah.flux.mac',
    team: '8MLN9FH4F9',
    development: false,
    certificate: 'certificate',
  };
  validateProfile(profile, options);
  for (const change of [
    { identifier: '8MLN9FH4F9.com.other.app' },
    { expires: '2000-01-01T00:00:00Z' },
    { development: true },
    { allDevices: true },
    { certificates: [] },
  ])
    assert.throws(() => validateProfile({ ...profile, ...change }, options));
  assert.ok(allowedLoader('@loader_path/../lib/libexample.dylib'));
  assert.ok(!allowedLoader('/opt/homebrew/lib/libexample.dylib'));
});
