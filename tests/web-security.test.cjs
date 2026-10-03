const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAuth } = require('../server/auth.cjs');
const { createApp } = require('../server/app.cjs');
const { filename, RateLimit, Queue, LIMITS } = require('../server/security.cjs');
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
test('rate limits stop floods and recover only after the window expires', () => {
  let time = 10;
  const limiter = new RateLimit(() => time);
  limiter.check('user', 2, 100);
  limiter.check('user', 2, 100);
  assert.throws(() => limiter.check('user', 2, 100));
  time = 111;
  limiter.check('user', 2, 100);
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
