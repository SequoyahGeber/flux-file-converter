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
      auth: async () => ({ id: 'audit', email: 'synthetic@example.com' }),
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
  const request = async (url, method = 'GET', body) => {
    const res = await fetch(base + '/api/' + url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const upload = async (name) => {
    const response = await request('uploads', 'POST', { name, size: 4 });
    assert.equal(response.status, 201);
    const id = response.body.id;
    const written = await fetch(base + '/api/uploads/' + id, {
      method: 'PUT',
      body: 'test',
      headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' },
    });
    assert.equal(written.status, 200);
    return id;
  };
  const wait = async (id) => {
    for (let n = 0; n < 200; n++) {
      const { body } = await request('status');
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
