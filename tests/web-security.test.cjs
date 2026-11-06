const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAuth } = require('../server/auth.cjs');
const { createApp } = require('../server/app.cjs');
const { filename, RateLimit, Queue, LIMITS, sameSecret } = require('../server/security.cjs');
const { scan } = require('../server/clamav.cjs');
test('Cloudflare login verifies signatures, issuer, audience, expiry and request origin', async () => {
  const { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } = await import('jose');
  const keys = await generateKeyPair('RS256'),
    jwk = await exportJWK(keys.publicKey);
  jwk.kid = 'test';
  const config = {
    issuer: 'https://test.cloudflareaccess.com',
    audience: 'app-id',
    origin: 'https://flux.example.com',
  };
  const auth = await createAuth(config, createLocalJWKSet({ keys: [jwk] }));
  const token = async (overrides = {}) =>
    new SignJWT({ email: 'a@example.com', type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(overrides.issuer || config.issuer)
      .setAudience(overrides.audience || config.audience)
      .setSubject('user-a')
      .setIssuedAt()
      .setExpirationTime(overrides.expiry || '1h')
      .sign(keys.privateKey);
  const req = {
    method: 'GET',
    url: '/',
    headers: { host: 'flux.example.com', 'cf-access-jwt-assertion': await token() },
  };
  assert.equal((await auth(req)).email, 'a@example.com');
  for (const bad of [
    await token({ issuer: 'https://wrong.cloudflareaccess.com' }),
    await token({ audience: 'other-app' }),
    await token({ expiry: Math.floor(Date.now() / 1000) - 10 }),
    req.headers['cf-access-jwt-assertion'].slice(0, -4) + 'aaaa',
  ])
    await assert.rejects(
      auth({ ...req, headers: { ...req.headers, 'cf-access-jwt-assertion': bad } }),
    );
  await assert.rejects(
    auth({
      ...req,
      headers: { host: 'flux.example.com', 'cf-access-authenticated-user-email': 'a@example.com' },
    }),
  );
  await assert.rejects(
    auth({
      ...req,
      method: 'POST',
      headers: { ...req.headers, origin: 'https://attacker.example', 'x-flux-request': '1' },
    }),
  );
  await assert.rejects(auth({ ...req, headers: { ...req.headers, host: '127.0.0.1' } }));
  assert.ok(
    await auth({
      ...req,
      method: 'POST',
      headers: { ...req.headers, origin: config.origin, 'x-flux-request': '1' },
    }),
  );
  // The browser retains cross-site metadata after the identity-provider
  // redirect. Only a top-level GET of the static landing page may pass.
  const redirected = {
    ...req,
    headers: {
      ...req.headers,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  };
  for (const url of ['/', '/?invite=synthetic-invitation'])
    assert.equal((await auth({ ...redirected, url })).email, 'a@example.com');
  for (const url of ['/api/state', '/api/status', '/api/download/test', '/app.js'])
    await assert.rejects(auth({ ...redirected, url }), /Cross-site requests are blocked/);
  for (const headers of [
    { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-mode': undefined, 'sec-fetch-dest': 'document' },
    { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': undefined },
  ])
    await assert.rejects(
      auth({ ...redirected, headers: { ...redirected.headers, ...headers } }),
      /Cross-site requests are blocked/,
    );
  await assert.rejects(
    auth({
      ...redirected,
      method: 'POST',
      headers: { ...redirected.headers, origin: config.origin, 'x-flux-request': '1' },
    }),
    /Cross-site requests are blocked/,
  );
  await assert.rejects(
    auth({
      ...redirected,
      headers: { ...redirected.headers, 'cf-access-jwt-assertion': undefined },
    }),
    /Sign in through Cloudflare Access/,
  );
  await assert.rejects(
    auth({ ...redirected, headers: { ...redirected.headers, host: 'attacker.example' } }),
    /Invalid application host/,
  );
});
test('Cloudflare login lasts up to 30 days and still requires a valid unexpired token', async () => {
  const { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } = await import('jose');
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = 'month-test';
  const config = {
    issuer: 'https://test.cloudflareaccess.com',
    audience: 'app-id',
    origin: 'https://flux.example.com',
  };
  const auth = await createAuth(config, createLocalJWKSet({ keys: [jwk] }));
  const now = Math.floor(Date.now() / 1000);
  const day = 24 * 60 * 60;
  const token = async (age, expiry = now + day, issuedAt = true) => {
    let jwt = new SignJWT({ email: 'a@example.com', type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('user-a');
    if (issuedAt) jwt = jwt.setIssuedAt(now - age);
    if (expiry !== null) jwt = jwt.setExpirationTime(expiry);
    return jwt.sign(keys.privateKey);
  };
  const request = (jwt) => ({
    method: 'GET',
    url: '/api/state',
    headers: { host: 'flux.example.com', 'cf-access-jwt-assertion': jwt },
  });
  for (const age of [9 * 60 * 60, day, 29 * day, 30 * day - 60])
    assert.equal((await auth(request(await token(age)))).email, 'a@example.com');
  for (const jwt of [
    await token(30 * day + 60),
    await token(day, now - 60),
    await token(day, null),
    await token(day, now + day, false),
    await token(-60),
  ])
    await assert.rejects(auth(request(jwt)), /login has expired or is invalid/);
});
test('filenames reject traversal, injected options, devices and control characters', () => {
  for (const f of [
    '../../etc/passwd',
    '/etc/shadow',
    'a\\b',
    '-flag.mp4',
    '.secret',
    'x\n.svg',
    'C:drive',
    '',
    'a'.repeat(181),
  ])
    assert.throws(() => filename(f));
  assert.equal(filename('holiday 日本.mp4'), 'holiday 日本.mp4');
});
test('the complete engine catalog loads through the authenticated state endpoint', async (t) => {
  const http = require('node:http'),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-catalog-test-'));
  const catalog = {
    formats: [{ input: 'png', family: 'image', targets: ['jpg'] }],
    engineInfo: 'x'.repeat(600000),
  };
  const worker = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(catalog));
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  const app = await createApp(
    { storage: dir, worker: 'http://127.0.0.1:' + worker.address().port, secret: 'test-secret' },
    { auth: async () => ({ id: 'a', email: 'test@example.com' }) },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await new Promise((r) => worker.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.formats, catalog.formats);
  assert.equal(state.user, 'test@example.com');
});
test('the global queue is bounded and executes one job at a time', async () => {
  const queue = new Queue(2);
  let release,
    active = 0,
    peak = 0;
  const first = queue.add(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => (release = r));
    active--;
  });
  const second = queue.add(async () => {
    active++;
    peak = Math.max(peak, active);
    active--;
    return 2;
  });
  await assert.rejects(
    queue.add(async () => 3),
    /queue is full/,
  );
  release();
  await first;
  assert.equal(await second, 2);
  assert.equal(peak, 1);
});
test('aborting a pending queue entry drops it at once and frees its capacity', async () => {
  const queue = new Queue(3);
  const ran = [];
  let release;
  const first = queue.add(() => new Promise((r) => (release = r)));
  const cancel = new AbortController();
  const dropped = queue.add(async () => ran.push('dropped'), cancel.signal);
  const kept = queue.add(async () => ran.push('kept'));
  assert.equal(queue.full, true);
  cancel.abort();
  await assert.rejects(
    Promise.race([
      dropped,
      new Promise((r) => setTimeout(r, 100)).then(() => 'still pending'),
    ]).then((value) => assert.fail(value)),
    /Cancelled/,
  );
  assert.equal(queue.full, false);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    queue.add(async () => ran.push('pre-aborted'), aborted.signal),
    /Cancelled/,
  );
  assert.equal(queue.pending.length, 1);
  // A started entry is cancelled by its own job, never removed by the queue.
  const running = new AbortController();
  const next = queue.add(async () => {
    running.abort();
    return 'finished';
  }, running.signal);
  release();
  await first;
  await kept;
  assert.equal(await next, 'finished');
  assert.deepEqual(ran, ['kept']);
  assert.equal(queue.pending.length, 0);
});
test('rate limits stop floods and recover only after the window expires', () => {
  let time = 10;
  const limiter = new RateLimit(() => time);
  limiter.check('user', 2, 100);
  limiter.check('user', 2, 100);
  assert.throws(
    () => limiter.check('user', 2, 100),
    (error) => error.status === 429 && error.retryAfter === 1,
  );
  time = 111;
  limiter.check('user', 2, 100);
  for (let i = 0; i < 30; i++) limiter.check('hour', 30, 3600000);
  assert.throws(
    () => limiter.check('hour', 30, 3600000),
    (error) => error.status === 429 && error.retryAfter === 3600,
  );
});
test('uploads, jobs and downloads are owner-scoped; scan failure cannot publish a result', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-web-test-'));
  let rejectScan = false;
  const app = await createApp(
    { storage: dir },
    {
      auth: async (req) => ({
        id: req.headers['x-test-user'] === 'b' ? 'b' : 'a',
        email: 'test@example.com',
      }),
      scan: async () => {
        if (rejectScan) throw Object.assign(new Error('Malware detected.'), { status: 422 });
        return 'full';
      },
      rpc: async (spec, files, out) => {
        if (spec.operation === 'inspect')
          return {
            name: files[0].name,
            ext: 'txt',
            family: 'document',
            targets: ['html'],
            compressionOptions: [{ id: 'archive' }],
          };
        await fs.writeFile(out, '<script>alert(1)</script>');
        return { name: 'output.html', size: 25, target: 'html', completedAt: Date.now() };
      },
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const request = async (url, options = {}) => {
    const res = await fetch(base + url, options);
    return { res, body: await res.json() };
  };
  assert.equal((await request('/api/files', { method: 'POST', body: 'test' })).res.status, 410);
  let u = await request('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: 'safe.txt', size: 4 }),
  });
  assert.equal(u.res.status, 201);
  const uploadId = u.body.id;
  const wrongOffset = await request('/api/uploads/' + uploadId, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '2' },
    body: 'test',
  });
  assert.equal(wrongOffset.res.status, 409);
  const other = await request('/api/uploads/' + uploadId, {
    method: 'PUT',
    headers: {
      'x-test-user': 'b',
      'content-type': 'application/octet-stream',
      'x-flux-offset': '0',
    },
    body: 'test',
  });
  assert.equal(other.res.status, 404);
  assert.equal(
    (
      await request('/api/uploads/' + uploadId, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' },
        body: 'test',
      })
    ).res.status,
    200,
  );
  const completed = await request('/api/uploads/' + uploadId + '/complete', { method: 'POST' });
  assert.equal(completed.res.status, 202);
  async function wait(id) {
    for (let i = 0; i < 100; i++) {
      const status = (await request('/api/status')).body;
      const job = status.jobs.find((j) => j.id === id);
      if (job && !['running', 'queued'].includes(job.status)) return { status, job };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('Job did not finish');
  }
  const inspected = await wait(completed.body.id);
  assert.equal(inspected.job.status, 'done');
  assert.equal(inspected.status.files.length, 1);
  assert.equal(inspected.status.files[0].path, undefined);
  assert.equal(
    (
      await request('/api/jobs', {
        method: 'POST',
        headers: { 'x-test-user': 'b' },
        body: JSON.stringify({ id: uploadId, operation: 'convert', target: 'html' }),
      })
    ).res.status,
    404,
  );
  const job = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ id: uploadId, operation: 'convert', target: 'html' }),
  });
  const done = await wait(job.body.id);
  assert.equal(done.job.status, 'done');
  const download = await fetch(base + '/api/download/' + job.body.id);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  await download.text();
  assert.equal(
    (await request('/api/download/' + job.body.id, { headers: { 'x-test-user': 'b' } })).res.status,
    404,
  );
  rejectScan = true;
  const infected = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ id: uploadId, operation: 'convert', target: 'html' }),
  });
  const blocked = await wait(infected.body.id);
  assert.equal(blocked.job.status, 'error');
  assert.equal((await request('/api/download/' + infected.body.id)).res.status, 404);
  const state = (await request('/api/status')).body;
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].path, undefined);
  assert.equal((await request('/api/files', { method: 'DELETE' })).res.status, 200);
  assert.equal((await request('/api/download/' + job.body.id)).res.status, 404);
});
test('a missing scratch file releases upload capacity after a failed chunk write', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-write-failure-'));
  const app = await createApp(
    { storage: dir },
    { auth: async () => ({ id: 'a', email: 'test@example.com' }) },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const begin = async (name) =>
    (
      await fetch(base + '/api/uploads', {
        method: 'POST',
        body: JSON.stringify({ name, size: 4 }),
      })
    ).json();
  const first = await begin('missing.txt');
  const root = (await fs.readdir(dir))[0];
  const target = path.join(dir, root, 'a', first.id);
  await fs.rm(target);
  const chunk = (id) =>
    fetch(base + '/api/uploads/' + id, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' },
      body: 'test',
    });
  assert.equal((await chunk(first.id)).status, 500);
  await fs.writeFile(target, '');
  assert.equal((await chunk(first.id)).status, 200);
  const second = await begin('next.txt');
  assert.equal((await chunk(second.id)).status, 200);
});
test('the overall job deadline aborts scanning and publishes no file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-deadline-'));
  let aborted = false;
  const app = await createApp(
    { storage: dir },
    {
      jobTimeout: 50,
      auth: async () => ({ id: 'a', email: 'test@example.com' }),
      scan: async (_, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('Aborted'));
            },
            { once: true },
          );
        }),
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const first = await (
    await fetch(base + '/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: 'slow.txt', size: 4 }),
    })
  ).json();
  const written = await fetch(base + '/api/uploads/' + first.id, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' },
    body: 'test',
  });
  assert.equal(written.status, 200);
  const response = await fetch(base + '/api/uploads/' + first.id + '/complete', { method: 'POST' });
  assert.equal(response.status, 202);
  const queued = await response.json();
  let state, job;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(base + '/api/status')).json();
    job = state.jobs.find((j) => j.id === queued.id);
    if (job?.status === 'error') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(aborted, true);
  assert.equal(job.status, 'error');
  assert.match(job.error, /ten-minute limit/);
  assert.equal(state.files.length, 0);
  assert.equal(state.history.length, 0);
});
test('the single container retains hard limits, gVisor and no published ports', async () => {
  const YAML = require('yaml');
  const doc = YAML.parse(await fs.readFile(path.join(__dirname, '../compose.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(doc.services), ['flux']);
  const s = doc.services.flux;
  assert.equal(s.cpus, 2);
  assert.equal(s.mem_limit, '5700m');
  assert.equal(s.memswap_limit, s.mem_limit);
  assert.equal(s.read_only, true);
  assert.deepEqual(s.cap_drop, ['ALL']);
  assert.deepEqual(s.cap_add, ['CHOWN', 'SETUID', 'SETGID', 'SETPCAP']);
  assert.ok(s.security_opt.includes('no-new-privileges:true'));
  assert.equal(s.runtime, 'runsc');
  assert.equal(s.pids_limit, 256);
  assert.equal(s.ports, undefined);
  assert.equal(s.privileged, undefined);
  assert.equal(s.network_mode, undefined);
  assert.ok(!s.volumes.some((v) => v.includes('/var/run/docker') || v.startsWith('/mnt/')));
  assert.equal(LIMITS.file, 5_000_000_000);
  assert.equal(LIMITS.job, 600000);
});

test('the worker bearer check needs a matching secret of at least 32 characters', () => {
  const secret = 's'.repeat(32);
  assert.equal(sameSecret(undefined, secret), false);
  assert.equal(sameSecret('', ''), false);
  assert.equal(sameSecret('a'.repeat(31), 'a'.repeat(31)), false);
  assert.equal(sameSecret('a'.repeat(32), 'a'.repeat(33)), false);
  assert.equal(sameSecret('a'.repeat(31) + 'x', 'a'.repeat(31) + 'y'), false);
  assert.equal(sameSecret(secret, secret), true);
});

// A fake clamd that decodes zINSTREAM\0, the 4-byte big-endian chunk lengths and
// the zero terminator, then hands the decoded bytes to reply(socket, bytes).
async function fakeClamd(t, reply) {
  const net = require('node:net');
  const seen = { streams: [], frames: [], errors: [] };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0),
      started = false;
    const parts = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!started) {
        if (buffer.length < 10) return;
        if (buffer.subarray(0, 10).toString('latin1') !== 'zINSTREAM\0') {
          seen.errors.push('bad command');
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(10);
        started = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          seen.streams.push(Buffer.concat(parts));
          buffer = Buffer.alloc(0);
          reply(socket, seen.streams.at(-1));
          return;
        }
        if (buffer.length < 4 + length) return;
        parts.push(buffer.subarray(4, 4 + length));
        seen.frames.push(length);
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: server.address().port, seen };
}

async function scratchFile(t, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-clamd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.bin');
  await fs.writeFile(file, bytes);
  return file;
}

test('the scanner client speaks INSTREAM and accepts only an exact "stream: OK" verdict', async (t) => {
  const data = require('node:crypto').randomBytes(200 * 1024);
  const file = await scratchFile(t, data);
  const ok = await fakeClamd(t, (socket) => socket.end('stream: OK\0'));
  assert.equal(await scan(file, { host: '127.0.0.1', port: ok.port, timeout: 5000 }), 'full');
  assert.deepEqual(ok.seen.errors, []);
  assert.equal(ok.seen.streams.length, 1);
  assert.ok(ok.seen.frames.length > 1, 'the file should span several frames');
  assert.ok(ok.seen.streams[0].equals(data), 'clamd must receive the file bytes unchanged');

  const found = await fakeClamd(t, (socket) => socket.end('stream: Eicar-Test-Signature FOUND\0'));
  await assert.rejects(scan(file, { host: '127.0.0.1', port: found.port, timeout: 5000 }), {
    status: 422,
    message: /rejected by the malware scanner/,
  });
  const junk = await fakeClamd(t, (socket) => socket.end('INSTREAM size limit exceeded. ERROR\0'));
  await assert.rejects(scan(file, { host: '127.0.0.1', port: junk.port, timeout: 5000 }), {
    status: 422,
    message: /could not complete/,
  });
  // A "FOUND" prefix or a trailing suffix must not pass for a clean verdict.
  const padded = await fakeClamd(t, (socket) => socket.end('stream: OK FOUND\0'));
  await assert.rejects(scan(file, { host: '127.0.0.1', port: padded.port, timeout: 5000 }), {
    status: 422,
  });
});

test('the scanner client fails closed on truncated, oversized, silent or unreachable scanners', async (t) => {
  const net = require('node:net');
  const file = await scratchFile(t, Buffer.from('hello'));
  const truncated = await fakeClamd(t, (socket) => socket.end('stream: OK'));
  await assert.rejects(scan(file, { host: '127.0.0.1', port: truncated.port, timeout: 5000 }), {
    status: 503,
    message: /Incomplete/,
  });
  // No NUL and the socket stays open, so only the 4096-byte cap can stop this.
  const oversized = await fakeClamd(t, (socket) => socket.write('x'.repeat(5000)));
  await assert.rejects(scan(file, { host: '127.0.0.1', port: oversized.port, timeout: 30000 }), {
    status: 503,
    message: /unavailable/,
  });
  const silent = await fakeClamd(t, () => {});
  await assert.rejects(scan(file, { host: '127.0.0.1', port: silent.port, timeout: 50 }), {
    status: 503,
    message: /timed out/,
  });
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(scan(file, { host: '127.0.0.1', port, timeout: 5000 }), {
    status: 503,
    message: /unavailable/,
  });
});

test('files over the full-scan limit are scanned in overlapping windows that cover every byte', async (t) => {
  const file = await scratchFile(t, Buffer.from('x'));
  const size = LIMITS.scanFull + 1,
    window = 64 * 1024 ** 2,
    overlap = 1024 ** 2,
    step = window - overlap;
  const clamd = await fakeClamd(t, (socket) => socket.end('stream: OK\0'));
  const nodeFs = require('node:fs');
  const { Readable } = require('node:stream');
  const realStat = nodeFs.promises.stat,
    realCreateReadStream = nodeFs.createReadStream;
  const windows = [];
  nodeFs.promises.stat = async (target, ...rest) => {
    const stat = await realStat.call(nodeFs.promises, target, ...rest);
    return target === file ? { size } : stat;
  };
  nodeFs.createReadStream = (target, options, ...rest) => {
    if (target !== file) return realCreateReadStream.call(nodeFs, target, options, ...rest);
    windows.push({ start: options.start, end: options.end });
    return Readable.from([Buffer.from('x')]);
  };
  try {
    const config = { host: '127.0.0.1', port: clamd.port, timeout: 5000 };
    assert.equal(await scan(file, config), 'chunked');
    assert.equal(windows.length, Math.ceil(size / step));
    assert.equal(windows[0].start, 0);
    windows.forEach((w, i) => {
      assert.equal(w.end, Math.min(size - 1, w.start + window - 1));
      if (i) {
        assert.equal(w.start, windows[i - 1].start + step);
        assert.equal(windows[i - 1].end - w.start + 1, overlap);
      }
    });
    assert.equal(windows.at(-1).end, size - 1);

    windows.length = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(scan(file, { ...config, signal: controller.signal }), {
      status: 422,
      message: 'Scan cancelled.',
    });
    assert.equal(windows.length, 0);
  } finally {
    nodeFs.promises.stat = realStat;
    nodeFs.createReadStream = realCreateReadStream;
  }
});

test('container installs both ImageMagick policies and verifies active executables before catalog generation', async () => {
  const docker = await fs.readFile(path.join(__dirname, '../Dockerfile'), 'utf8');
  for (const major of [6, 7])
    assert.ok(
      docker.includes(
        'COPY deploy/imagemagick-policy.xml /etc/ImageMagick-' + major + '/policy.xml',
      ),
    );
  const verify = docker.indexOf('RUN node server/imagemagick-policy.cjs');
  assert.ok(verify > docker.indexOf('/etc/ImageMagick-7/policy.xml'));
  assert.ok(verify < docker.indexOf('RUN node server/build-catalog.cjs'));
  const compat = await fs.readFile(path.join(__dirname, '../server/compat.py'), 'utf8');
  assert.ok(compat.includes("else '/usr/bin/convert'"));
  const verifier = await fs.readFile(path.join(__dirname, '../server/imagemagick-policy.cjs'), 'utf8');
  assert.ok(verifier.includes("['/usr/bin/convert', '/usr/local/bin/magick']"));
  assert.ok(verifier.includes("['-list', 'policy']"));
});

test('active ImageMagick policy verifier rejects missing, permissive and unrelated policy entries', async () => {
  const { XMLParser } = require('fast-xml-parser');
  const { verifyPolicy } = require('../server/imagemagick-policy.cjs');
  const xml = await fs.readFile(path.join(__dirname, '../deploy/imagemagick-policy.xml'), 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const entries = parser.parse(xml).policymap.policy;
  const listing = (policies, major = 7) => {
    const body = policies.map(({ domain, ...fields }) => {
      const attributes = Object.entries(fields).map(([name, value]) => '    ' + name + ': ' + value);
      return '  Policy: ' + domain + '\n' + attributes.join('\n') + '\n';
    });
    return 'Path: /etc/ImageMagick-' + major + '/policy.xml\n' + body.join('');
  };
  const rejects = (policies, message) =>
    assert.throws(() => verifyPolicy(listing(policies)), message);
  for (const major of [6, 7]) assert.doesNotThrow(() => verifyPolicy(listing(entries, major)));
  assert.throws(() => verifyPolicy(''), /No active policies/);
  assert.throws(() => verifyPolicy(listing(entries).replace('/etc/ImageMagick-7/', '/unused/')));
  assert.doesNotThrow(() =>
    verifyPolicy(listing(entries) + 'Path: [built-in]\n  Policy: Undefined\n    rights: None\n'),
  );
  for (const coder of ['MSL', 'TEXT', 'URL']) {
    const changed = entries.map((p) =>
      p.domain === 'coder' ? { ...p, pattern: p.pattern.replace(coder + ',', '') } : p,
    );
    rejects(changed, /Missing coder denial/);
  }
  for (const domain of ['coder', 'module', 'path', 'delegate', 'filter']) {
    rejects(entries.filter((p) => p.domain !== domain));
    const granting = entries.map((p) => (p.domain === domain ? { ...p, rights: 'Read Write' } : p));
    rejects(granting, /granting/);
    rejects(entries.concat({ domain, rights: 'Write', pattern: '*' }), /granting/);
  }
  const wrongPath = entries.map((p) =>
    p.domain === 'path' ? { ...p, pattern: '@unrelated' } : p,
  );
  rejects(wrongPath, /Missing path denial/);
  for (const name of ['memory', 'map', 'disk', 'area', 'width', 'height', 'time', 'thread']) {
    rejects(entries.filter((p) => p.name !== name));
    const excessive = entries.map((p) => (p.name === name ? { ...p, value: '999GiB' } : p));
    rejects(excessive, /Excessive resource/);
  }
  rejects(entries.map((p) => (p.domain === 'coder' ? { ...p, domain: 'unrelated' } : p)));
  assert.throws(
    () => verifyPolicy(listing(entries) + '  Policy: Coder\n    rights: None\n    rights: Write\n'),
    /Duplicate policy field/,
  );
});

test('sandbox requires all process-isolation syscalls to resolve and installs EPERM denials', async () => {
  const sandbox = await fs.readFile(path.join(__dirname, '../server/sandbox.c'), 'utf8');
  for (const name of ['pidfd_open', 'pidfd_getfd', 'process_madvise'])
    assert.ok(sandbox.includes('"' + name + '"'));
  assert.match(sandbox, /number == __NR_SCMP_ERROR/);
  assert.ok(sandbox.includes('cannot resolve required syscall'));
  assert.ok(sandbox.includes('seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), number, 0)'));
});
