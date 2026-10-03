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
  const keys = await generateKeyPair('RS256'), jwk = await exportJWK(keys.publicKey); jwk.kid = 'test';
  const config = { issuer: 'https://test.cloudflareaccess.com', audience: 'app-id', origin: 'https://flux.example.com' };
  const auth = await createAuth(config, createLocalJWKSet({ keys: [jwk] }));
  const token = async (overrides = {}) => new SignJWT({ email: 'a@example.com', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(overrides.issuer || config.issuer).setAudience(overrides.audience || config.audience).setSubject('user-a').setIssuedAt().setExpirationTime(overrides.expiry || '1h').sign(keys.privateKey);
  const req = { method: 'GET', headers: { host: 'flux.example.com', 'cf-access-jwt-assertion': await token() } }; assert.equal((await auth(req)).email, 'a@example.com');
  for (const bad of [await token({ issuer: 'https://wrong.cloudflareaccess.com' }), await token({ audience: 'other-app' }), await token({ expiry: Math.floor(Date.now()/1000)-10 }), req.headers['cf-access-jwt-assertion'].slice(0,-4)+'aaaa']) await assert.rejects(auth({ ...req, headers: { ...req.headers, 'cf-access-jwt-assertion': bad } }));
  await assert.rejects(auth({ ...req, headers: { host: 'flux.example.com', 'cf-access-authenticated-user-email': 'a@example.com' } }));
  await assert.rejects(auth({ ...req, method: 'POST', headers: { ...req.headers, origin: 'https://attacker.example', 'x-flux-request': '1' } }));
  await assert.rejects(auth({ ...req, headers: { ...req.headers, host: '127.0.0.1' } }));
  assert.ok(await auth({ ...req, method: 'POST', headers: { ...req.headers, origin: config.origin, 'x-flux-request': '1' } }));
});
test('filenames reject traversal, injected options, devices and control characters', () => {
  for (const f of ['../../etc/passwd', '/etc/shadow', 'a\\b', '-flag.mp4', '.secret', 'x\n.svg', 'C:drive', '', 'a'.repeat(181)]) assert.throws(() => filename(f));
  assert.equal(filename('holiday 日本.mp4'), 'holiday 日本.mp4');
});
test('the global queue is bounded and executes one job at a time', async () => {
  const queue = new Queue(2); let release, active = 0, peak = 0;
  const first = queue.add(async () => { active++; peak = Math.max(peak, active); await new Promise(r => release = r); active--; });
  const second = queue.add(async () => { active++; peak = Math.max(peak, active); active--; return 2; });
  await assert.rejects(queue.add(async () => 3), /queue is full/); release(); await first; assert.equal(await second, 2); assert.equal(peak, 1);
});
test('rate limits stop floods and recover only after the window expires', () => {
  let time = 10; const limiter = new RateLimit(() => time); limiter.check('user', 2, 100); limiter.check('user', 2, 100); assert.throws(() => limiter.check('user', 2, 100)); time = 111; limiter.check('user', 2, 100);
});
test('uploads, jobs and downloads are owner-scoped; scan failure cannot publish a result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-web-test-')); let rejectScan = false;
  const app = await createApp({ storage: dir }, { auth: async req => ({ id: req.headers['x-test-user'] === 'b' ? 'b' : 'a', email: 'test@example.com' }), scan: async () => { if (rejectScan) throw Object.assign(new Error('Malware detected.'), { status: 422 }); return 'full'; }, rpc: async (spec, files, out) => {
    if (spec.operation === 'inspect') return { name: files[0].name, ext: 'txt', family: 'document', targets: ['html'], compressionOptions: [{ id: 'archive' }] };
    await fs.writeFile(out, '<script>alert(1)</script>'); return { name: 'output.html', size: 25, target: 'html', completedAt: Date.now() };
  } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (url, options = {}) => { const res = await fetch(base + url, options); return { res, body: await res.json() }; };
  let u = await request('/api/uploads', { method: 'POST', body: JSON.stringify({ name: 'safe.txt', size: 4 }) }); assert.equal(u.res.status, 201);
  const uploadId = u.body.id;
  const wrongOffset = await request('/api/uploads/' + uploadId, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '2' }, body: 'test' }); assert.equal(wrongOffset.res.status, 409);
  const other = await request('/api/uploads/' + uploadId, { method: 'PUT', headers: { 'x-test-user': 'b', 'content-type': 'application/octet-stream', 'x-flux-offset': '0' }, body: 'test' }); assert.equal(other.res.status, 404);
  assert.equal((await request('/api/uploads/' + uploadId, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' }, body: 'test' })).res.status, 200);
  const completed = await request('/api/uploads/' + uploadId + '/complete', { method: 'POST' }); assert.equal(completed.res.status, 202);
  async function wait(id) { for (let i=0;i<100;i++) { const status = (await request('/api/status')).body; const job = status.jobs.find(j=>j.id===id); if (job && !['running','queued'].includes(job.status)) return { status, job }; await new Promise(r=>setTimeout(r,5)); } throw new Error('Job did not finish'); }
  const inspected = await wait(completed.body.id); assert.equal(inspected.job.status, 'done'); assert.equal(inspected.status.files.length,1); assert.equal(inspected.status.files[0].path,undefined);
  assert.equal((await request('/api/jobs', { method:'POST',headers:{'x-test-user':'b'},body:JSON.stringify({id:uploadId,operation:'convert',target:'html'}) })).res.status,404);
  const job = await request('/api/jobs',{method:'POST',body:JSON.stringify({id:uploadId,operation:'convert',target:'html'})}); const done = await wait(job.body.id); assert.equal(done.job.status,'done');
  const download = await fetch(base+'/api/download/'+job.body.id); assert.match(download.headers.get('content-disposition'),/^attachment/); assert.equal(download.headers.get('content-type'),'application/octet-stream'); assert.match(download.headers.get('content-security-policy'),/sandbox/); await download.text();
  assert.equal((await request('/api/download/'+job.body.id,{headers:{'x-test-user':'b'}})).res.status,404);
  rejectScan = true; const infected = await request('/api/jobs',{method:'POST',body:JSON.stringify({id:uploadId,operation:'convert',target:'html'})}); const blocked = await wait(infected.body.id); assert.equal(blocked.job.status,'error'); assert.equal((await request('/api/download/'+infected.body.id)).res.status,404);
  const state = (await request('/api/status')).body; assert.equal(state.history.length,1); assert.equal(state.history[0].path,undefined);
  assert.equal((await request('/api/files',{method:'DELETE'})).res.status,200); assert.equal((await request('/api/download/'+job.body.id)).res.status,404);
});
test('deployment keeps hard aggregate CPU/RAM limits, gVisor and no published ports', async () => {
  const YAML = require('yaml'); const doc = YAML.parse(await fs.readFile(path.join(__dirname,'../compose.yaml'),'utf8'));
  let cpu=0,memory=0; const parse = x => parseFloat(x) * (x.endsWith('g') ? 1024 : 1);
  for (const [name,s] of Object.entries(doc.services)) { cpu+=s.cpus; memory+=parse(s.mem_limit); assert.equal(s.mem_limit,s.memswap_limit); assert.equal(s.read_only,true); assert.deepEqual(s.cap_drop,['ALL']); assert.ok(s.security_opt.includes('no-new-privileges:true')); assert.ok(s.pids_limit); assert.equal(s.ports,undefined); assert.equal(s.privileged,undefined); assert.equal(s.network_mode,undefined); assert.ok(!(s.volumes||[]).some(v=>v.includes('/var/run/docker')||v.startsWith('/mnt/'))); if (['worker','scanner'].includes(name)) assert.equal(s.runtime,'runsc'); }
  assert.ok(cpu<=2.001); assert.ok(memory<=6144); assert.equal(doc.networks.jobs.internal,true); assert.equal(doc.networks.edge.internal,true); assert.equal(LIMITS.file,5_000_000_000); assert.equal(LIMITS.job,600000);
});
