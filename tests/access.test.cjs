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
