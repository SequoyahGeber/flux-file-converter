const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const SYNTHETIC = 'flux-startup-test-public-synthetic-value';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function frame(value = SYNTHETIC) {
  const body = Buffer.from(value);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
async function fixture(t, mode = 'reader', { missing = false, legacy = false } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flux-worker-startup-')));
  let child;
  let exited = false;
  let exit;
  t.after(async () => {
    if (child && !exited) child.kill('SIGKILL');
    if (exit) await exit;
    // Only our own base is ever removed, after the subprocess has stopped.
    await fs.rm(base, { recursive: true, force: true });
  });
  if (mode === 'worker') {
    await fs.mkdir(path.join(base, 'work'));
    await fs.mkdir(path.join(base, 'decoy', path.basename(base) + '-scratch'), { recursive: true });
    await fs.writeFile(path.join(base, 'decoy', 'cleanup-guard'), 'keep');
    await fs.writeFile(path.join(base, 'decoy', 'old-worker-temp'), 'remove');
    await fs.writeFile(
      path.join(base, 'decoy', path.basename(base) + '-scratch', 'old-temp'),
      'remove',
    );
    await fs.writeFile(path.join(base, 'work', 'old-job'), 'remove');
    await fs.writeFile(path.join(base, 'outside-cleanup'), 'must survive');
  }
  const messages = [];
  let errors = '';
  // Explicit environment: no parent credentials, preload flags or cleanup paths.
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base };
  if (legacy) env.WORKER_SECRET = SYNTHETIC;
  child = spawn(process.execPath, [path.join(__dirname, 'worker-startup-child.cjs'), mode, base], {
    env,
    stdio: ['ignore', 'ignore', 'pipe', missing ? 'ignore' : 'pipe', 'ipc'],
  });
  child.on('message', (message) => messages.push(message));
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  child.stdio[3]?.on('error', () => {}); // Invalid delivery may close its reader early.
  exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const waitFor = async (type) => {
    const deadline = Date.now() + 8000;
    while (!messages.some((message) => message.type === type)) {
      assert.equal(exited, false, 'Startup child exited before ' + type);
      assert.ok(Date.now() < deadline, 'Startup child timed out before ' + type);
      await delay(10);
    }
    return messages.find((message) => message.type === type);
  };
  await waitFor(mode === 'reader' ? 'started' : 'guarded');
  return {
    child,
    base,
    messages,
    waitFor,
    exit,
    errors: () => errors,
    send: (bytes, end = true) => {
      if (end) child.stdio[3].end(bytes);
      else child.stdio[3].write(bytes);
    },
  };
}

test('startup reader accepts fragmented bounded frames, then closes its descriptor', async (t) => {
  for (const length of [32, 4096]) {
    await t.test('payload bytes ' + length, async (t) => {
      const f = await fixture(t);
      const bytes = frame('s'.repeat(length));
      f.send(bytes.subarray(0, 2), false);
      await delay(20);
      f.send(bytes.subarray(2, 17), false);
      await delay(20);
      f.send(bytes.subarray(17));
      assert.deepEqual(await f.waitFor('result'), {
        type: 'result',
        ok: true,
        length,
        closed: true,
      });
      assert.deepEqual(await f.exit, { code: 0, signal: null });
      assert.equal(f.errors(), '');
    });
  }
});

test('startup reader fails closed with a fixed error and closes invalid channels', async (t) => {
  const invalidUTF8 = frame();
  invalidUTF8[4] = 0xff;
  const nul = frame();
  nul[4] = 0;
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(4097);
  const cases = [
    ['missing', null, { missing: true }],
    ['empty', Buffer.alloc(0)],
    ['short header', Buffer.from([0, 0])],
    ['short credential', frame('short')],
    ['incomplete payload', frame().subarray(0, 12)],
    ['oversized header', oversized],
    ['oversized payload', Buffer.concat([frame('s'.repeat(4096)), Buffer.from([1])])],
    ['trailing bytes', Buffer.concat([frame(), Buffer.from([1])])],
    ['invalid UTF-8', invalidUTF8],
    ['embedded NUL', nul],
  ];
  for (const [name, bytes, options] of cases)
    await t.test(name, async (t) => {
      const f = await fixture(t, 'reader', options);
      if (bytes) f.send(bytes);
      assert.deepEqual(await f.waitFor('result'), {
        type: 'result',
        ok: false,
        fixedError: true,
        closed: true,
      });
      assert.deepEqual(await f.exit, { code: 0, signal: null });
    });
});

test('startup deadline closes a stalled or unclosed channel', async (t) => {
  for (const bytes of [Buffer.from([0]), frame()])
    await t.test('held channel with ' + bytes.length + ' bytes', async (t) => {
      const f = await fixture(t);
      f.send(bytes, false);
      assert.deepEqual(await f.waitFor('result'), {
        type: 'result',
        ok: false,
        fixedError: true,
        closed: true,
      });
      assert.deepEqual(await f.exit, { code: 0, signal: null });
    });
});

test(
  'real worker waits for EOF and closes startup before guarded cleanup and authenticated RPC',
  async (t) => {
    const f = await fixture(t, 'worker');
    const bytes = frame();
    f.send(bytes.subarray(0, 11), false);
    await delay(100);
    assert.deepEqual(f.messages.map((message) => message.type), ['guarded']);
    f.send(bytes.subarray(11), false);
    await delay(100);
    assert.deepEqual(f.messages.map((message) => message.type), ['guarded']);
    f.child.stdio[3].end();
    const ready = await f.waitFor('ready');
    assert.equal(ready.closed, true);
    assert.deepEqual(f.messages.find((message) => message.type === 'cleanup'), {
      type: 'cleanup',
      closed: true,
      guarded: true,
    });
    const request = (url, secret) =>
      new Promise((resolve, reject) => {
        const req = http.get(
          {
            host: '127.0.0.1',
            port: ready.port,
            path: url,
            headers: secret ? { authorization: 'Bearer ' + secret } : {},
            agent: false,
          },
          (res) => {
            res.resume();
            res.once('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('Test request timed out.')));
      });
    assert.equal(await request('/health'), 200);
    assert.equal(await request('/unknown', SYNTHETIC), 404);
    assert.equal(await request('/unknown', 'wrong-public-synthetic-value-000000'), 401);
    assert.equal(await request('/unknown'), 401);
    assert.equal(await fs.readFile(path.join(f.base, 'outside-cleanup'), 'utf8'), 'must survive');
    assert.equal(await fs.readFile(path.join(f.base, 'decoy', 'cleanup-guard'), 'utf8'), 'keep');
    assert.equal(f.errors(), '');
  },
);

test(
  'real worker rejects the old environment-only startup before cleanup or listening',
  async (t) => {
    const f = await fixture(t, 'worker', { missing: true, legacy: true });
    assert.deepEqual(await f.exit, { code: 1, signal: null });
    assert.deepEqual(f.messages.map((message) => message.type), ['guarded']);
    assert.equal(f.errors(), 'Worker startup failed.\n');
    assert.equal(await fs.readFile(path.join(f.base, 'work', 'old-job'), 'utf8'), 'remove');
    assert.equal(await fs.readFile(path.join(f.base, 'outside-cleanup'), 'utf8'), 'must survive');
  },
);

test('real worker rejects truncated startup before any cleanup', async (t) => {
  const f = await fixture(t, 'worker');
  f.send(frame().subarray(0, 12));
  assert.deepEqual(await f.exit, { code: 1, signal: null });
  assert.deepEqual(f.messages.map((message) => message.type), ['guarded']);
  assert.equal(f.errors(), 'Worker startup failed.\n');
  assert.equal(await fs.readFile(path.join(f.base, 'work', 'old-job'), 'utf8'), 'remove');
});

test(
  'job execution retains its credential-free environment and only three standard descriptors',
  async () => {
    const { execute } = require('../server/worker-io.cjs');
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    const controller = new AbortController();
    let options;
    const run = execute('/synthetic-job-root', controller.signal, (command, args, config) => {
      assert.equal(command, '/usr/local/bin/flux-sandbox');
      assert.deepEqual(args, ['/usr/local/bin/node', '/app/server/job.cjs', '/synthetic-job-root']);
      options = config;
      return child;
    });
    child.emit('close', 0);
    await run;
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe']);
    assert.deepEqual(Object.keys(options.env).sort(), [
      'FLUX_ARCHIVE_MAX_BYTES',
      'FLUX_ARCHIVE_MAX_FILES',
      'FLUX_SERVER',
      'HOME',
      'MAGICK_THREAD_LIMIT',
      'NODE_OPTIONS',
      'OMP_NUM_THREADS',
      'OPENBLAS_NUM_THREADS',
      'PATH',
      'PYTHONDONTWRITEBYTECODE',
      'QT_QPA_PLATFORM',
      'TMPDIR',
      'XDG_RUNTIME_DIR',
    ]);
  },
);
