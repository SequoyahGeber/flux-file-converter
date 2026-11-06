const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createAccess } = require('../server/access.cjs');
const { createApp } = require('../server/app.cjs');
const owner = { id: 'a'.repeat(64), email: 'owner@example.com' },
  one = { id: 'b'.repeat(64), email: 'one@example.com' },
  two = { id: 'c'.repeat(64), email: 'two@example.com' };
test('invites are owner-only, one-use, expire after 24 hours, and survive restart', async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-invites-'));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  let time = 1000;
  const config = {
    storage,
    ownerEmail: owner.email,
    origin: 'https://flux.example.com',
    now: () => time,
  };
  let access = await createAccess(config);
  assert.equal(access.allowed(owner), true);
  assert.equal(access.allowed(one), false);
  await assert.rejects(access.invite(one), { status: 403 });
  assert.throws(() => access.list(one), { status: 403 });
  const invite = await access.invite(owner),
    token = new URL(invite.url).searchParams.get('invite');
  assert.equal(invite.expiresAt - time, 86400000);
  assert.equal(
    (await fs.readFile(path.join(storage, 'access.json'), 'utf8')).includes(token),
    false,
  );
  const claims = await Promise.allSettled([access.claim(one, token), access.claim(two, token)]);
  assert.equal(claims.filter((c) => c.status === 'fulfilled').length, 1);
  const winner = access.allowed(one) ? one : two,
    loser = winner === one ? two : one;
  await assert.rejects(access.claim(loser, token), { status: 410 });
  access = await createAccess(config);
  assert.equal(access.allowed(winner), true);
  assert.equal(access.list(owner).invites[0].status, 'claimed');
  await access.revokeMember(owner, winner.id);
  assert.equal(access.allowed(winner), false);
  await assert.rejects(access.claim(winner, token), { status: 410 });
  const expired = await access.invite(owner);
  time = expired.expiresAt;
  await assert.rejects(access.claim(one, new URL(expired.url).searchParams.get('invite')), {
    status: 410,
  });
  const revoked = await access.invite(owner);
  await access.revokeInvite(owner, revoked.id);
  await assert.rejects(access.claim(one, new URL(revoked.url).searchParams.get('invite')), {
    status: 410,
  });
});
test('signed-in uninvited users cannot upload, inspect, run jobs or download; revocation is enforced per request', async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-member-gate-'));
  const app = await createApp(
    { storage, ownerEmail: owner.email, origin: 'https://flux.example.com' },
    {
      auth: async (req) => (req.headers['x-test-owner'] === '1' ? owner : one),
      capabilities: { formats: [] },
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = (url, method = 'GET', body, admin = false) =>
    fetch(base + '/api/' + url, {
      method,
      headers: admin ? { 'x-test-owner': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await (await call('state')).json()).canUse, false);
  for (const [route, method, body] of [
    ['uploads', 'POST', { name: 'x.txt', size: 4 }],
    ['status', 'GET'],
    ['jobs', 'POST', {}],
    ['download/' + crypto.randomUUID(), 'GET'],
    ['access', 'GET'],
    ['invites', 'POST', {}],
  ])
    assert.equal((await call(route, method, body)).status, 403);
  const invite = await (await call('invites', 'POST', {}, true)).json(),
    token = new URL(invite.url).searchParams.get('invite');
  assert.equal((await call('invites/claim', 'POST', { token })).status, 200);
  assert.equal((await (await call('state')).json()).canUse, true);
  assert.equal((await call('members/' + one.id, 'DELETE', undefined, true)).status, 200);
  assert.equal((await call('status')).status, 403);
});
const hex = (c) => c.repeat(64);
const validInvite = () => ({
  id: crypto.randomUUID(),
  createdAt: 1,
  expiresAt: 2,
  hash: hex('e'),
});
const validMember = (id, n = 0) => ({ id, email: 'm' + n + '@example.com', joinedAt: 1 });
async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('malformed access JSON is refused without exposing its contents or changing files', async (t) => {
  const storage = await tempDir(t, 'flux-invalid-json-'),
    file = path.join(storage, 'access.json'),
    email = ['sec08', 'example.invalid'].join('@'),
    malformed = '{"email":' + JSON.stringify(email) + '!}',
    bytes = Buffer.from(malformed);
  await fs.writeFile(file, bytes);
  const listing = (await fs.readdir(storage)).sort();
  await assert.rejects(
    createAccess({ storage, ownerEmail: owner.email, origin: 'https://flux.example.com' }),
    (error) => {
      assert.equal(error.message, 'Invalid access database.');
      assert.equal(String(error).includes(email), false);
      assert.equal(String(error).includes(malformed), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual((await fs.readdir(storage)).sort(), listing);
});
test('a damaged access database is refused without being changed', async (t) => {
  const valid = { version: 1, members: [validMember(one.id)], invites: [validInvite()] };
  const refuse = async (name, prepare) => {
    const storage = await tempDir(t, 'flux-damaged-'),
      file = path.join(storage, 'access.json'),
      watched = await prepare(storage, file),
      before = await Promise.all(watched.map((f) => fs.readFile(f))),
      listing = (await fs.readdir(storage)).sort();
    await assert.rejects(
      createAccess({ storage, ownerEmail: owner.email, origin: 'https://flux.example.com' }),
      undefined,
      name,
    );
    for (const [i, f] of watched.entries())
      assert.deepEqual(await fs.readFile(f), before[i], name + ': ' + path.basename(f));
    assert.deepEqual((await fs.readdir(storage)).sort(), listing, name + ': directory');
  };
  const write = (data) => async (_, file) => {
    await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
    return [file];
  };
  await refuse('invalid JSON', write('{"version":1,"members":['));
  await refuse('symlink', async (storage, file) => {
    const target = path.join(storage, 'elsewhere.json');
    await fs.writeFile(target, JSON.stringify(valid));
    await fs.symlink(target, file);
    return [target];
  });
  await refuse('oversize', write(JSON.stringify(valid).padEnd(1_000_001, ' ')));
  await refuse('version 2', write({ ...valid, version: 2 }));
  await refuse(
    '50 members',
    write({
      ...valid,
      members: Array.from({ length: 50 }, (_, n) =>
        validMember(n.toString(16).padStart(64, '0'), n),
      ),
    }),
  );
  await refuse('non-hex member id', write({ ...valid, members: [validMember('g'.repeat(64))] }));
  await refuse(
    'bad invite hash',
    write({ ...valid, invites: [{ ...validInvite(), hash: 'z'.repeat(64) }] }),
  );
  const storage = await tempDir(t, 'flux-missing-');
  const access = await createAccess({
    storage,
    ownerEmail: owner.email,
    origin: 'https://flux.example.com',
  });
  assert.deepEqual(access.list(owner), { members: [], invites: [] });
  assert.deepEqual(await fs.readdir(storage), []);
});
test('a failed save leaves memory, disk and later saves intact', async (t) => {
  const storage = await tempDir(t, 'flux-failed-save-'),
    file = path.join(storage, 'access.json'),
    config = {
      storage,
      ownerEmail: owner.email,
      origin: 'https://flux.example.com',
      now: () => 1000,
    },
    access = await createAccess(config);
  await access.invite(owner);
  const listed = structuredClone(access.list(owner)),
    bytes = await fs.readFile(file),
    original = fs.rename;
  let failures = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (!failures++) throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
    return original(...args);
  });
  await assert.rejects(access.invite(owner), { code: 'EIO' });
  assert.equal(failures, 1);
  assert.deepEqual(access.list(owner), listed);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(
    (await fs.readdir(storage)).filter((n) => n.endsWith('.tmp')),
    [],
  );
  const next = await access.invite(owner);
  assert.equal(access.list(owner).invites.length, 2);
  assert.equal(
    access.list(owner).invites.some((i) => i.id === next.id),
    true,
  );
  assert.deepEqual((await createAccess(config)).list(owner), access.list(owner));
  assert.deepEqual(
    (await fs.readdir(storage)).filter((n) => n.endsWith('.tmp')),
    [],
  );
});
test('concurrent invites and revocations persist exactly what memory shows', async (t) => {
  const storage = await tempDir(t, 'flux-concurrent-'),
    config = {
      storage,
      ownerEmail: owner.email,
      origin: 'https://flux.example.com',
      now: () => 1000,
    },
    access = await createAccess(config),
    members = ['d', 'e', 'f'].map((c, n) => ({ id: hex(c), email: 'member' + n + '@example.com' })),
    pending = [];
  for (const member of members)
    await access.claim(
      member,
      new URL((await access.invite(owner)).url).searchParams.get('invite'),
    );
  for (let n = 0; n < 4; n++) pending.push(await access.invite(owner));
  assert.equal(
    members.every((m) => access.allowed(m)),
    true,
  );
  const calls = [];
  for (let n = 0; n < 10; n++) {
    calls.push(access.invite(owner));
    if (pending[n]) calls.push(access.revokeInvite(owner, pending[n].id));
    if (members[n]) calls.push(access.revokeMember(owner, members[n].id));
  }
  assert.equal(
    (await Promise.allSettled(calls)).every((r) => r.status === 'fulfilled'),
    true,
  );
  assert.equal(
    members.some((m) => access.allowed(m)),
    false,
  );
  const listed = access.list(owner);
  assert.equal(listed.members.length, 0);
  assert.equal(listed.invites.filter((i) => i.status === 'pending').length, 10);
  // Later invites prune revoked ones, so only the revoked ids that survive are checked.
  assert.equal(
    listed.invites.some((i) => pending.some((p) => p.id === i.id) && i.status !== 'revoked'),
    false,
  );
  assert.deepEqual((await createAccess(config)).list(owner), listed);
  assert.deepEqual(
    (await fs.readdir(storage)).filter((n) => n.endsWith('.tmp')),
    [],
  );
});
test('revoking a member aborts their running job and nothing is committed', async (t) => {
  const storage = await tempDir(t, 'flux-revoke-job-');
  let entered, release, signal;
  const reached = new Promise((r) => (entered = r)),
    released = new Promise((r) => (release = r));
  t.after(() => release());
  const app = await createApp(
    { storage, ownerEmail: owner.email, origin: 'https://flux.example.com' },
    {
      auth: async (req) => (req.headers['x-test-owner'] === '1' ? owner : one),
      scan: async () => 'full',
      capabilities: { formats: [] },
      rpc: async (spec, files, out, _config, abortSignal) => {
        if (spec.operation === 'inspect')
          return { name: files[0].name, ext: 'txt', family: 'document', targets: ['html'] };
        signal = abortSignal;
        await fs.writeFile(out, 'converted');
        entered();
        await released;
        return { name: 'result.html', size: 9, target: 'html' };
      },
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port,
    call = async (url, method = 'GET', body, admin = false, extra = {}) => {
      const res = await fetch(base + '/api/' + url, {
        method,
        headers: { ...(admin ? { 'x-test-owner': '1' } : {}), ...extra },
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    admit = async () => {
      const invite = await call('invites', 'POST', {}, true);
      assert.equal(invite.status, 201);
      const token = new URL(invite.body.url).searchParams.get('invite');
      assert.equal((await call('invites/claim', 'POST', { token })).status, 200);
    },
    status = async (until) => {
      for (let n = 0; n < 400; n++) {
        const { body } = await call('status');
        if (until(body)) return body;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('Status did not settle.');
    };
  await admit();
  const upload = await call('uploads', 'POST', { name: 'x.txt', size: 4 });
  assert.equal(upload.status, 201);
  const put = await fetch(base + '/api/uploads/' + upload.body.id, {
    method: 'PUT',
    body: 'test',
    headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' },
  });
  assert.equal(put.status, 200);
  assert.equal((await call('uploads/' + upload.body.id + '/complete', 'POST')).status, 202);
  const file = (await status((s) => s.files.length === 1)).files[0],
    job = await call('jobs', 'POST', { operation: 'convert', id: file.id, target: 'html' });
  assert.equal(job.status, 202);
  await reached;
  assert.equal(signal.aborted, false);
  assert.equal((await call('members/' + one.id, 'DELETE', undefined, true)).status, 200);
  assert.equal(signal.aborted, true);
  assert.equal((await call('status')).status, 403);
  release();
  await admit();
  const settled = await status((s) => {
    const j = s.jobs.find((x) => x.id === job.body.id);
    return j && !['queued', 'running'].includes(j.status);
  });
  assert.equal(settled.jobs.find((x) => x.id === job.body.id).status, 'cancelled');
  assert.equal(settled.jobs.find((x) => x.id === job.body.id).result, undefined);
  assert.deepEqual(settled.history, []);
  const roots = (await fs.readdir(storage)).filter((n) => n.startsWith('flux-api-'));
  assert.equal(roots.length, 1);
  await assert.rejects(fs.lstat(path.join(storage, roots[0], one.id, job.body.id)), {
    code: 'ENOENT',
  });
});
