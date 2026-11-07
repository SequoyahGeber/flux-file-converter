const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createApp } = require('../server/app.cjs');
const { readBounded, outputStem } = require('../electron/io.cjs');
const { structured, sanitizeOptions, run } = require('../electron/engine.cjs');
const { LIMITS, options } = require('../server/security.cjs');
const { rpc } = require('../server/transport.cjs');

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
      signal: AbortSignal.timeout(5000),
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
      signal: AbortSignal.timeout(5000),
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

async function until(read, ready, message) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const trigger of ['cancel', 'timeout']) {
  test('A1: output lstat publication race: ' + trigger, async (t) => {
    const release = gate(),
      controls = gate();
    let output,
      signal,
      entered = false,
      scanned = false;
    const f = await fixture(t, {
      ...(trigger === 'timeout' ? { jobTimeout: 2000 } : {}),
      scan: async (file) => {
        if (file === output) scanned = true;
        return 'full';
      },
      rpc: async (spec, files, out, _, abortSignal) => {
        if (spec.operation === 'inspect')
          return { name: files[0].name, ext: 'txt', family: 'document', targets: ['html'] };
        if (!output) {
          output = out;
          signal = abortSignal;
        } else {
          await controls.promise;
        }
        await fs.writeFile(out, 'converted');
        return { name: 'result.html', size: 9, target: 'html' };
      },
    });
    const originalLstat = fs.lstat;
    fs.lstat = async (file, ...args) => {
      const stat = await originalLstat(file, ...args);
      if (file === output && !entered) {
        assert.equal(scanned, true);
        assert.equal(signal.aborted, false);
        entered = true;
        await release.promise;
      }
      return stat;
    };
    try {
      const input = await f.upload('ready.txt');
      const inspection = await f.request('uploads/' + input + '/complete', 'POST');
      assert.equal(inspection.status, 202);
      assert.equal((await f.wait(inspection.body.id)).job.status, 'done');
      const spec = { operation: 'convert', id: input, target: 'html' };
      const submitted = await f.request('jobs', 'POST', spec);
      assert.equal(submitted.status, 202);
      await until(async () => entered, Boolean, 'Output lstat was not reached.');
      assert.equal(signal.aborted, false);
      assert.equal(await fs.readFile(output, 'utf8'), 'converted');
      if (trigger === 'cancel')
        assert.equal((await f.request('cancel', 'POST', { id: submitted.body.id })).status, 200);
      await until(async () => signal.aborted, Boolean, 'Job signal was not aborted.');
      // The filesystem result is still held when the cancellation is acknowledged.
      release.resolve();
      const { state, job } = await f.wait(submitted.body.id);
      assert.equal(job.status, trigger === 'timeout' ? 'error' : 'cancelled');
      assert.equal(
        job.error,
        trigger === 'timeout' ? 'Job exceeded the ten-minute limit.' : 'Cancelled.',
      );
      assert.equal(job.result, undefined);
      assert.deepEqual(state.history, []);
      await assert.rejects(originalLstat(output), { code: 'ENOENT' });
      assert.equal((await f.request('download/' + job.id)).status, 404);

      // Keep both subsequent jobs active together. Together with this other
      // user's empty reservation they fill the byte pool exactly. A leaked
      // output reservation or active slot prevents their admission.
      const ballast = await f.request(
        'uploads',
        'POST',
        { name: 'capacity.bin', size: LIMITS.storage - 2 * LIMITS.output - 4 },
        'other',
      );
      assert.equal(ballast.status, 201);
      const first = await f.request('jobs', 'POST', spec);
      assert.equal(first.status, 202);
      const second = await f.request('jobs', 'POST', spec);
      assert.equal(second.status, 202);
      assert.equal(
        (await f.request('uploads', 'POST', { name: 'full.bin', size: 1 }, 'other')).status,
        503,
      );
      controls.resolve();
      for (const id of [first.body.id, second.body.id]) {
        const done = await f.wait(id);
        assert.equal(done.job.status, 'done');
        assert.ok(done.job.result);
      }
      assert.equal((await f.request('status')).body.history.length, 2);
      assert.equal(
        (await f.request('uploads/' + ballast.body.id, 'DELETE', undefined, 'other')).status,
        200,
      );
      const download = await fetch(f.base + '/api/download/' + first.body.id, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(download.status, 200);
      assert.equal(await download.text(), 'converted');
    } finally {
      release.resolve();
      controls.resolve();
      fs.lstat = originalLstat;
    }
  });
}

test('G10: invalid chunks and premature completion preserve the confirmed upload state', async (t) => {
  const f = await fixture(t);
  const created = await f.request('uploads', 'POST', { name: 'partial.txt', size: 4 });
  assert.equal(created.status, 201);
  const url = 'uploads/' + created.body.id;
  const put = async (body, offset, type = 'application/octet-stream') => {
    const res = await fetch(f.base + '/api/' + url, {
      method: 'PUT',
      body,
      headers: { 'content-type': type, 'x-flux-offset': String(offset) },
    });
    return { status: res.status, body: await res.json() };
  };
  for (const [body, type] of [
    ['12345', 'application/octet-stream'],
    ['test', 'text/plain'],
  ]) {
    assert.equal((await put(body, 0, type)).status, 409);
    const state = await f.request(url);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { offset: 0, size: 4, busy: false });
  }
  const first = await put('te', 0);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { offset: 2 });
  assert.equal((await f.request(url + '/complete', 'POST')).status, 409);
  const partial = await f.request(url);
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body, { offset: 2, size: 4, busy: false });
  assert.equal((await put('st', 2)).status, 200);
  assert.deepEqual((await f.request(url)).body, { offset: 4, size: 4, busy: false });
  const completed = await f.request(url + '/complete', 'POST');
  assert.equal(completed.status, 202);
  assert.equal((await f.wait(completed.body.id)).job.status, 'done');
});

test('G10: an interrupted chunk clears busy without advancing the offset and can be retried', async (t) => {
  const f = await fixture(t);
  const created = await f.request('uploads', 'POST', { name: 'interrupted.bin', size: 1024 });
  assert.equal(created.status, 201);
  const url = 'uploads/' + created.body.id;
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': '1024',
    'x-flux-offset': '0',
  };
  const req = http.request(f.base + '/api/' + url, { method: 'PUT', headers });
  req.on('error', () => {}); // Destroying an unfinished request may report ECONNRESET.
  req.on('response', (res) => res.resume());
  t.after(() => req.destroy());
  try {
    req.write('x');
    const read = async () => {
      const state = await f.request(url);
      assert.equal(state.status, 200);
      return state.body;
    };
    const busy = await until(
      read,
      (state) => state.busy,
      'Chunk never entered the streaming state.',
    );
    assert.deepEqual(busy, { offset: 0, size: 1024, busy: true });
    req.destroy();
    const stopped = await until(read, (state) => !state.busy, 'Interrupted chunk stayed busy.');
    assert.deepEqual(stopped, { offset: 0, size: 1024, busy: false });
    const bytes = Buffer.alloc(1024, 'r');
    const retry = await fetch(f.base + '/api/' + url, { method: 'PUT', headers, body: bytes });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { offset: 1024 });
    assert.deepEqual(await read(), { offset: 1024, size: 1024, busy: false });
    const stored = path.join(await scratch(f.dir), 'audit', created.body.id);
    assert.deepEqual(await fs.readFile(stored), bytes);
  } finally {
    req.destroy();
  }
});

test('G11: inspection failure becomes visible only after cleanup frees the deletion slot', async (t) => {
  let inspected = false;
  const f = await fixture(t, {
    rpc: async (spec) => {
      assert.equal(spec.operation, 'inspect');
      inspected = true;
      throw Object.assign(new Error('Synthetic inspection failure.'), { status: 422 });
    },
  });
  const id = await f.upload('failed.txt');
  const target = path.join(await scratch(f.dir), 'audit', id);
  const release = gate();
  const originalRm = fs.rm;
  let cleaning = false;
  // Top-level tests run sequentially; intercept only this upload's actual removal.
  fs.rm = async (file, ...args) => {
    if (file === target) {
      cleaning = true;
      await release.promise;
    }
    return originalRm(file, ...args);
  };
  try {
    const completed = await f.request('uploads/' + id + '/complete', 'POST');
    assert.equal(completed.status, 202);
    await until(async () => cleaning, Boolean, 'Failed inspection never reached upload cleanup.');
    assert.equal(inspected, true);
    const pending = await f.request('status');
    assert.equal(pending.status, 200);
    const job = pending.body.jobs.find((job) => job.id === completed.body.id);
    assert.ok(job);
    assert.equal(job.status, 'running');
    assert.equal(job.error, undefined);
    release.resolve();
    const failed = await f.wait(completed.body.id);
    assert.equal(failed.job.status, 'error');
    assert.equal(failed.job.error, 'Synthetic inspection failure.');
    assert.equal((await f.request('files', 'DELETE')).status, 200);
    assert.ok(await f.upload('after-failure.txt'));
  } finally {
    release.resolve();
    fs.rm = originalRm;
  }
});

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

test('G8: real rpc validates worker replies and sends the authenticated job and input', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-rpc-audit-'));
  const sockets = new Set();
  const controllers = new Set();
  const requests = [];
  const serverErrors = [];
  let response;
  const server = http.createServer((req, res) => {
    const respond = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      // Drain the entire input before replying, including intentionally invalid replies.
      res.writeHead(response.status || 200, response.headers || {});
      if (response.firstConsumed) {
        res.write(response.body.subarray(0, response.split));
        await response.firstConsumed.promise;
        res.end(response.body.subarray(response.split));
      } else res.end(response.body);
    };
    respond().catch((error) => {
      serverErrors.push(error);
      res.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    worker: 'http://127.0.0.1:' + server.address().port,
    secret: 'synthetic-worker-secret-for-audit-tests',
  };
  const files = [
    { path: path.join(dir, 'first.txt'), name: 'first.txt', size: 4 },
    { path: path.join(dir, 'second.txt'), name: 'second.txt', size: 5 },
  ];
  await fs.writeFile(files[0].path, 'test');
  await fs.writeFile(files[1].path, 'input');
  let sequence = 0;
  const invoke = async (spec, reply, out = path.join(dir, 'output-' + sequence++)) => {
    response = reply;
    const before = requests.length;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref();
    try {
      return await rpc(spec, files, out, config, controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      assert.deepEqual(serverErrors, []);
      assert.equal(
        requests.length,
        before + 1,
        'The fake worker must receive the complete request.',
      );
    }
  };
  const result = (info, body = 'converted') => ({
    headers: {
      'x-flux-result': Buffer.from(JSON.stringify(info)).toString('base64url'),
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
  const info = { name: 'result.html', size: 9, target: 'html', originalSize: 12, savedBytes: 3 };
  const spec = { operation: 'convert', target: 'html' };
  const assertRequest = (spec) => {
    const request = requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/run');
    assert.equal(request.headers.authorization, 'Bearer ' + config.secret);
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.equal(request.headers['content-length'], '9');
    assert.deepEqual(
      JSON.parse(Buffer.from(request.headers['x-flux-job'], 'base64url').toString()),
      { ...spec, files: files.map(({ name, size }) => ({ name, size })) },
    );
    assert.deepEqual(request.body, Buffer.from('testinput'));
  };

  await t.test('valid inspection at exactly 64000 ASCII bytes succeeds', async () => {
    const inspected = {
      padding: 'x'.repeat(64000 - Buffer.byteLength(JSON.stringify({ padding: '' }))),
    };
    const body = JSON.stringify(inspected);
    assert.equal(Buffer.byteLength(body), 64000);
    assert.deepEqual(await invoke({ operation: 'inspect' }, { body }), inspected);
    assertRequest({ operation: 'inspect' });
  });
  const inspected = {
    name: 'mixed-日本.txt',
    notes: ['ASCII and adjacent 語文 end'],
    warnings: ['emoji 😀🚀 end'],
  };
  const inspectionBody = Buffer.from(JSON.stringify(inspected));
  let offset = 0;
  for (const character of inspectionBody.toString('utf8')) {
    const width = Buffer.byteLength(character);
    for (let internal = 1; internal < width; internal++) {
      const split = offset + internal;
      await t.test('inspection preserves UTF-8 split at byte ' + split, async (t) => {
        const firstConsumed = gate();
        const request = http.request;
        // Observe raw parser input and acknowledge only after rpc consumes the
        // first iterator value. The worker cannot send the remainder earlier.
        t.mock.method(http, 'request', function (...args) {
          const req = request.apply(this, args);
          req.prependOnceListener('response', (res) => {
            const received = [];
            const push = res.push;
            t.mock.method(res, 'push', function (chunk, ...args) {
              if (Buffer.isBuffer(chunk)) received.push(Buffer.from(chunk));
              return push.call(this, chunk, ...args);
            });
            const iterate = res[Symbol.asyncIterator];
            t.mock.method(res, Symbol.asyncIterator, async function* () {
              let first = true;
              for await (const chunk of iterate.call(this)) {
                if (first) {
                  first = false;
                  assert.deepEqual(
                    Buffer.concat(received),
                    inspectionBody.subarray(0, split),
                    'The consumer must receive exactly the prefix ending inside UTF-8.',
                  );
                  yield chunk;
                  firstConsumed.resolve();
                } else yield chunk;
              }
            });
          });
          return req;
        });
        try {
          const reply = await invoke(
            { operation: 'inspect' },
            { body: inspectionBody, split, firstConsumed },
          );
          assert.equal(reply.name, inspected.name);
          assert.deepEqual(reply.notes, inspected.notes);
          assert.deepEqual(reply.warnings, inspected.warnings);
          assert.deepEqual(reply, inspected);
          assertRequest({ operation: 'inspect' });
        } finally {
          // Also release the worker on assertion failures or the invoke deadline.
          firstConsumed.resolve();
        }
      });
    }
    offset += width;
  }
  await t.test('valid conversion returns metadata and exact output bytes', async () => {
    const out = path.join(dir, 'valid-output');
    const reply = await invoke(spec, result(info), out);
    const { completedAt, ...metadata } = reply;
    assert.deepEqual(metadata, info);
    assert.ok(Number.isSafeInteger(completedAt));
    assert.deepEqual(await fs.readFile(out), Buffer.from('converted'));
    assertRequest(spec);
  });
  await t.test('binary conversion preserves non-UTF-8 bytes and metadata', async () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0xe6, 0x97, 0xf0, 0x9f]);
    const binaryInfo = { ...info, name: 'result.bin', size: body.length, target: 'bin' };
    const binarySpec = { operation: 'convert', target: 'bin' };
    const out = path.join(dir, 'binary-output');
    const { completedAt, ...metadata } = await invoke(
      binarySpec,
      result(binaryInfo, body),
      out,
    );
    assert.deepEqual(metadata, binaryInfo);
    assert.ok(Number.isSafeInteger(completedAt));
    assert.equal((await fs.stat(out)).size, body.length);
    assert.deepEqual(await fs.readFile(out), body);
    assertRequest(binarySpec);
  });
  for (const [workerStatus, status] of [
    [422, 422],
    [500, 503],
  ])
    await t.test('worker status ' + workerStatus + ' maps to ' + status, async () => {
      await assert.rejects(invoke(spec, { status: workerStatus, body: 'worker error' }), {
        status,
      });
    });
  await t.test('inspection metadata at 64001 ASCII bytes is refused', async () => {
    const body = JSON.stringify({
      padding: 'x'.repeat(64001 - Buffer.byteLength(JSON.stringify({ padding: '' }))),
    });
    assert.equal(Buffer.byteLength(body), 64001);
    await assert.rejects(invoke({ operation: 'inspect' }, { body }), {
      status: 502,
      message: 'Worker metadata exceeds its limit.',
    });
  });
  for (const [name, headers] of [
    ['missing', {}],
    ['garbled', { 'x-flux-result': Buffer.from('{invalid JSON').toString('base64url') }],
  ])
    await t.test(name + ' result metadata is refused by the JSON parser', async () => {
      await assert.rejects(invoke(spec, { headers, body: 'converted' }), SyntaxError);
    });
  for (const name of ['../escape.html', '.hidden'])
    await t.test('invalid result name ' + name + ' is refused independently', async () => {
      await assert.rejects(invoke(spec, result({ ...info, name })), {
        status: 400,
        message: 'Use an ordinary filename without paths or control characters.',
      });
    });
  for (const size of [-1, 1.5, LIMITS.output + 1])
    await t.test('invalid result size ' + size + ' is refused independently', async () => {
      await assert.rejects(invoke(spec, result({ ...info, size })), {
        status: 413,
        message: 'Output exceeds the download limit.',
      });
    });
  for (const [body, message] of [
    ['short', 'Worker output was incomplete.'],
    ['longer than nine', 'Worker returned an invalid output.'],
  ])
    await t.test(message, async () => {
      // res.end sends a complete HTTP body; only the declared result size is wrong.
      await assert.rejects(invoke(spec, result(info, body)), { status: 502, message });
    });
  await t.test('exclusive output creation preserves an existing file', async () => {
    const out = path.join(dir, 'existing-output');
    const sentinel = Buffer.from('keep these bytes');
    await fs.writeFile(out, sentinel);
    await assert.rejects(invoke(spec, result(info), out), { code: 'EEXIST' });
    assert.deepEqual(await fs.readFile(out), sentinel);
  });
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

test('the worker serves a result only when it is a regular file inside the job folder', async (t) => {
  const { checkResult } = require('../server/worker-io.cjs');
  const { LIMITS } = require('../server/security.cjs');
  // The macOS temp folder sits behind a symlink; the prefix check needs the real path.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flux-result-')));
  const root = path.join(base, 'job'),
    evil = root + '-evil';
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(root);
  await fs.mkdir(evil);
  const bytes = Buffer.from('converted');
  await fs.writeFile(path.join(root, 'out.bin'), bytes);
  await fs.writeFile(path.join(base, 'outside.bin'), bytes);
  await fs.writeFile(path.join(evil, 'out.bin'), bytes);
  await fs.symlink(path.join(base, 'outside.bin'), path.join(root, 'link.bin'));
  await fs.mkdir(path.join(root, 'folder'));
  const good = { name: 'out.bin', path: 'out.bin', size: bytes.length };

  assert.equal(await checkResult(root, good), path.join(root, 'out.bin'));
  await assert.rejects(checkResult(root, { ...good, name: '../x' }), { status: 400 });
  await assert.rejects(checkResult(root, { ...good, name: '.hidden' }), { status: 400 });
  await assert.rejects(checkResult(root, { ...good, size: LIMITS.output + 1 }), {
    status: 422,
    message: 'Invalid result.',
  });
  await assert.rejects(checkResult(root, { ...good, size: 1.5 }), { message: 'Invalid result.' });
  const escapes = [
    path.join(evil, 'out.bin'), // sibling whose name starts with the job folder's name
    path.join(base, 'outside.bin'),
    '../outside.bin',
    'link.bin', // symlink inside the job folder pointing outside
  ];
  for (const escape of escapes)
    await assert.rejects(checkResult(root, { ...good, path: escape }), {
      status: 422,
      message: 'Invalid result path.',
    });
  // The size matches the folder's own, so only the regular-file check can reject it.
  const folderSize = (await fs.lstat(path.join(root, 'folder'))).size;
  await assert.rejects(checkResult(root, { ...good, path: 'folder', size: folderSize }), {
    status: 422,
    message: 'Invalid output.',
  });
  await assert.rejects(checkResult(root, { ...good, size: bytes.length + 1 }), {
    status: 422,
    message: 'Invalid output.',
  });
});
