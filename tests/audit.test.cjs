const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createApp } = require('../server/app.cjs');
const { readBounded, outputStem } = require('../electron/io.cjs');
const { structured, sanitizeOptions, run } = require('../electron/engine.cjs');
const { options } = require('../server/security.cjs');

function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(t, deps = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-audit-'));
  const app = await createApp(
    { storage: dir },
    {
      auth: async (req) => ({
        id: req.headers['x-test-user'] || 'audit',
        email: 'synthetic@example.com',
      }),
      scan: async () => 'full',
      rpc: async (spec, files, out) => {
        if (spec.operation === 'inspect')
          return { name: files[0].name, ext: 'txt', family: 'document', targets: ['html'] };
        await fs.writeFile(out, 'converted');
        return { name: 'result.html', size: 9, target: 'html', completedAt: Date.now() };
      },
      ...deps,
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const as = (user) => (user ? { 'x-test-user': user } : {});
  const request = async (url, method = 'GET', body, user) => {
    const res = await fetch(base + '/api/' + url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: as(user),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const upload = async (name, user) => {
    const response = await request('uploads', 'POST', { name, size: 4 }, user);
    assert.equal(response.status, 201);
    const id = response.body.id;
    const written = await fetch(base + '/api/uploads/' + id, {
      method: 'PUT',
      body: 'test',
      headers: {
        'content-type': 'application/octet-stream',
        'x-flux-offset': '0',
        ...as(user),
      },
    });
    assert.equal(written.status, 200);
    return id;
  };
  const wait = async (id, user) => {
    for (let n = 0; n < 200; n++) {
      const { body } = await request('status', 'GET', undefined, user);
      const job = body.jobs.find((j) => j.id === id);
      if (job && !['queued', 'running'].includes(job.status)) return { state: body, job };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('Job did not settle.');
  };
  return { dir, app, base, request, upload, wait };
}

test('fragmented Japanese JSON stays intact and invalid request shapes are rejected', async (t) => {
  const f = await fixture(t);
  const body = Buffer.from(JSON.stringify({ name: '日本語.txt', size: 4 }));
  const split = body.indexOf(Buffer.from('日')) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/uploads', { method: 'POST' }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 20);
  });
  assert.equal(response.status, 201);
  const id = response.body.id;
  await fetch(f.base + '/api/uploads/' + id, {
    method: 'PUT',
    body: 'test',
    headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' },
  });
  const completed = await f.request('uploads/' + id + '/complete', 'POST');
  assert.equal((await f.wait(completed.body.id)).state.files[0].name, '日本語.txt');
  for (const body of [null, [], 42, 'text'])
    assert.equal((await f.request('uploads', 'POST', body)).status, 400);
});

test('cancelling an inspection cannot commit a file even when a worker finishes late', async (t) => {
  const entered = gate(),
    finish = gate();
  const f = await fixture(t, {
    rpc: async (_, files) => {
      entered.resolve();
      await finish.promise;
      return { name: files[0].name, family: 'document', targets: ['html'] };
    },
  });
  const id = await f.upload('cancel.txt');
  const completion = await f.request('uploads/' + id + '/complete', 'POST');
  await entered.promise;
  await f.request('cancel', 'POST', { id: completion.body.id });
  finish.resolve();
  const { state, job } = await f.wait(completion.body.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(state.files.length, 0);
  assert.equal(state.history.length, 0);
});

// Holds the worker until the gate opens or the job is aborted, so cleanup cannot hang.
const held = (hold, signal) =>
  Promise.race([
    hold.promise,
    new Promise((r) => signal.addEventListener('abort', r, { once: true })),
  ]);
const scratch = async (dir) =>
  path.join(
    dir,
    (await fs.readdir(dir)).find((name) => name.startsWith('flux-api-')),
  );

test('a full server queue refuses completion with 429 and keeps the upload resumable', async (t) => {
  const hold = gate();
  t.after(() => hold.resolve());
  const f = await fixture(t, {
    rpc: async (_, files, __, ___, signal) => {
      await held(hold, signal);
      return { name: files[0].name, ext: 'txt', family: 'document', targets: ['html'] };
    },
  });
  // Each user may hold two uploads or jobs, so four users fill the eight queue entries.
  let last;
  for (const user of ['queue0', 'queue1', 'queue2', 'queue3'])
    for (const name of ['a.txt', 'b.txt']) {
      const id = await f.upload(name, user);
      const completed = await f.request('uploads/' + id + '/complete', 'POST', undefined, user);
      assert.equal(completed.status, 202);
      last = { id: completed.body.id, user };
    }
  const id = await f.upload('late.txt', 'late');
  const refused = await f.request('uploads/' + id + '/complete', 'POST', undefined, 'late');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '5');
  assert.match(refused.body.error, /queue is full/);
  const resumable = await f.request('uploads/' + id, 'GET', undefined, 'late');
  assert.equal(resumable.status, 200);
  assert.deepEqual(resumable.body, { offset: 4, size: 4, busy: false });
  assert.equal(await fs.readFile(path.join(await scratch(f.dir), 'late', id), 'utf8'), 'test');
  assert.equal((await f.request('status', 'GET', undefined, 'late')).body.jobs.length, 0);
  hold.resolve();
  await f.wait(last.id, last.user);
  const retried = await f.request('uploads/' + id + '/complete', 'POST', undefined, 'late');
  assert.equal(retried.status, 202);
  const { state, job } = await f.wait(retried.body.id, 'late');
  assert.equal(job.status, 'done');
  assert.deepEqual(
    state.files.map((file) => file.name),
    ['late.txt'],
  );
});

test('cancelling queued uploads and jobs frees the slot so Delete my files works at once', async (t) => {
  const entered = gate(),
    hold = gate();
  t.after(() => hold.resolve());
  const f = await fixture(t, {
    rpc: async (spec, files, out, _, signal) => {
      if (spec.operation === 'inspect') {
        if (files[0].name === 'blocker.txt') {
          entered.resolve();
          await held(hold, signal);
        }
        return { name: files[0].name, ext: 'txt', family: 'document', targets: ['html'] };
      }
      await fs.writeFile(out, 'converted');
      return { name: 'result.html', size: 9, target: 'html' };
    },
  });
  const ready = await f.upload('ready.txt');
  await f.wait((await f.request('uploads/' + ready + '/complete', 'POST')).body.id);
  // Another user's job occupies the global queue, so this user's work stays queued.
  const blocker = await f.upload('blocker.txt', 'other');
  await f.request('uploads/' + blocker + '/complete', 'POST', undefined, 'other');
  await entered.promise;
  const queued = await f.upload('queued.txt');
  const completion = await f.request('uploads/' + queued + '/complete', 'POST');
  const conversion = await f.request('jobs', 'POST', {
    operation: 'convert',
    id: ready,
    target: 'html',
  });
  assert.equal(completion.status, 202);
  assert.equal(conversion.status, 202);
  const ids = [completion.body.id, conversion.body.id];
  const started = Date.now();
  for (const id of ids) await f.request('cancel', 'POST', { id });
  for (;;) {
    const { jobs } = (await f.request('status')).body;
    const statuses = ids.map((id) => jobs.find((job) => job.id === id).status);
    if (statuses.every((status) => status === 'cancelled')) break;
    assert.ok(Date.now() - started < 100, 'queued work still ' + statuses.join(', '));
    await new Promise((r) => setTimeout(r, 5));
  }
  await assert.rejects(fs.stat(path.join(await scratch(f.dir), 'audit', queued)), {
    code: 'ENOENT',
  });
  assert.equal((await f.request('files', 'DELETE')).status, 200);
});

test('concurrent streamed job requests recheck active capacity after reading their bodies', async (t) => {
  const entered = gate(),
    finish = gate();
  const f = await fixture(t, {
    rpc: async (spec, files, out) => {
      if (spec.operation === 'inspect') {
        if (files[0].name === 'hold.txt') {
          entered.resolve();
          await finish.promise;
        }
        return { name: files[0].name, family: 'document', targets: ['html'] };
      }
      await fs.writeFile(out, 'test');
      return { name: 'result.html', size: 4, target: 'html' };
    },
  });
  const id = await f.upload('ready.txt');
  const ready = await f.request('uploads/' + id + '/complete', 'POST');
  await f.wait(ready.body.id);
  const held = await f.upload('hold.txt');
  await f.request('uploads/' + held + '/complete', 'POST');
  await entered.promise;
  const ends = [];
  const responses = [0, 1].map(
    () =>
      new Promise((resolve, reject) => {
        const req = http.request(f.base + '/api/jobs', { method: 'POST' }, async (res) => {
          for await (const _ of res) {
            /* drain */
          }
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.write('{"operation":"convert",');
        ends.push(() => req.end('"id":"' + id + '","target":"html"}'));
      }),
  );
  await new Promise((r) => setTimeout(r, 30));
  ends.forEach((end) => end());
  try {
    assert.deepEqual((await Promise.all(responses)).sort(), [202, 429]);
  } finally {
    finish.resolve();
  }
});

test('pending request bodies prevent cleanup and abandoned uploads release their slots', async (t) => {
  const f = await fixture(t);
  const pending = gate();
  const response = new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/uploads', { method: 'POST' }, async (res) => {
      for await (const _ of res) {
        /* drain */
      }
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write('{"name":"pending.txt",');
    pending.resolve(req);
  });
  const req = await pending.promise;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.request('files', 'DELETE')).status, 409);
  req.end('"size":4}');
  assert.equal(await response, 201);
  assert.equal((await f.request('files', 'DELETE')).status, 200);
  const id = await f.upload('abandoned.txt');
  assert.equal((await f.request('uploads/' + id, 'DELETE')).status, 200);
  assert.equal((await f.request('uploads/' + id, 'DELETE')).status, 200);
  assert.equal((await f.request('uploads/' + id + '/complete', 'POST')).status, 409);
  assert.ok(await f.upload('next.txt'));
});

test('shutdown waits for cancelled background work before deleting scratch files', async (t) => {
  const entered = gate(),
    stopped = gate();
  const f = await fixture(t, {
    scan: async (_, { signal }) => {
      entered.resolve();
      await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
      await new Promise((r) => setTimeout(r, 30));
      stopped.resolve();
      throw new Error('Stopped');
    },
  });
  const id = await f.upload('shutdown.txt');
  await f.request('uploads/' + id + '/complete', 'POST');
  await entered.promise;
  await f.app.close();
  await stopped.promise;
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('CSV rejects duplicate/empty headers and stale sizes cannot bypass bounded reads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-data-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'input.csv'),
    out = path.join(root, 'out.json');
  for (const text of ['name,name\nfirst,second\n', ',name\nfirst,second\n']) {
    await fs.writeFile(file, text);
    await assert.rejects(structured({ path: file, size: 0, ext: 'csv' }, 'json', out), /headers/);
  }
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0xff]));
  await assert.rejects(structured({ path: file, size: 0, ext: 'csv' }, 'json', out));
  await fs.writeFile(file, '123456');
  await assert.rejects(readBounded(file, 5), /size limit/);
  assert.equal((await readBounded(file, 6)).toString(), '123456');
  assert.deepEqual(options(null), { quality: 'balanced', width: 0 });
  assert.deepEqual(sanitizeOptions(null), { quality: 'balanced', width: 0 });
});

test('output stems fit multibyte filesystems and bounded ZIP paths retain empty directories', async (t) => {
  const stem = outputStem('日本語'.repeat(50));
  assert.ok(Buffer.byteLength(stem) <= 160);
  assert.ok(!stem.includes('\ufffd'));
  assert.equal(outputStem('...'), 'converted');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-archive-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const python = '/usr/bin/python3';
  const folder = path.join(root, 'tree'),
    manifest = path.join(root, 'manifest.json');
  await fs.mkdir(path.join(folder, 'empty'), { recursive: true });
  await fs.writeFile(path.join(folder, 'data'), 'test');
  await fs.writeFile(manifest, JSON.stringify([folder]));
  const command = path.resolve('resources/archive.py');
  const out = path.join(root, 'packed.zip');
  await run(python, [command, manifest, 'zip', out, path.join(root, 'stage'), 'pack']);
  await run(python, [
    '-c',
    "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert 'tree/empty/' in z.namelist(); assert z.read('tree/data') == b'test'",
    out,
  ]);
  const compat = path.join(root, 'ditto');
  await fs.copyFile(path.resolve('server/compat.py'), compat);
  const compatibilityZip = path.join(root, 'compat.zip');
  await run(python, [compat, '-c', '-k', '--norsrc', folder, compatibilityZip]);
  await run(python, [
    '-c',
    "import zipfile,sys; assert 'empty/' in zipfile.ZipFile(sys.argv[1]).namelist()",
    compatibilityZip,
  ]);
});

test('worker transport preserves all empty files and rejects truncated input', async (t) => {
  const { Readable } = require('node:stream');
  const { receive } = require('../server/worker-io.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-worker-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const data of ['', 'data']) {
    const root = path.join(dir, data || 'empty');
    await fs.mkdir(root);
    const files = [
      { name: 'a.txt', size: Buffer.byteLength(data) },
      { name: 'b.txt', size: 0 },
      { name: 'c.txt', size: 0 },
    ];
    await receive(Readable.from(data ? [Buffer.from(data)] : []), files, root);
    for (const [i, file] of files.entries())
      assert.equal(
        await fs.readFile(path.join(root, 'input', file.name), 'utf8'),
        i === 0 ? data : '',
      );
  }
  const root = path.join(dir, 'short');
  await fs.mkdir(root);
  await assert.rejects(
    receive(Readable.from([Buffer.from('x')]), [{ name: 'short.txt', size: 2 }], root),
    /Incomplete/,
  );
});

test('a worker job cancelled before execution never starts a process', async () => {
  const { execute } = require('../server/worker-io.cjs');
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(
    execute('/unused', controller.signal, () => {
      spawned = true;
    }),
    /cancelled/,
  );
  assert.equal(spawned, false);
});
