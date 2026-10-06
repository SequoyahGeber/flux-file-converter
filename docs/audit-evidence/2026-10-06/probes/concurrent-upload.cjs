// Probe: are chunk-upload slots shared across different users?
const R = '/Users/sequoyahgeber/dev/File converter';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createApp } = require(R + '/server/app.cjs');
(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-conc-'));
  const app = await createApp({ storage }, {
    auth: async (req) => { const u = req.headers['x-test-user']; return { id: u.padEnd(64, '0'), email: u + '@example.com' }; },
    scan: async () => 'full', capabilities: { formats: [], families: [] },
    rpc: async () => ({}),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = (user, method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ port, method, path: url, headers: { 'x-test-user': user, ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: t }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else return req; // return open request for slow streaming
  });
  const size = 1024 * 1024;
  async function startUpload(user) {
    const r = await call(user, 'POST', '/api/uploads', JSON.stringify({ name: 'a.bin', size }), { 'content-type': 'application/json' });
    return JSON.parse(r.body).id;
  }
  const ids = {};
  for (const u of ['aa', 'bb', 'cc']) ids[u] = await startUpload(u);
  // Users aa and bb begin slow chunk uploads (headers + 1 byte, then pause).
  const slow = ['aa', 'bb'].map((u) => {
    const req = http.request({ port, method: 'PUT', path: '/api/uploads/' + ids[u], headers: { 'x-test-user': u, 'content-type': 'application/octet-stream', 'content-length': size, 'x-flux-offset': '0' } });
    req.on('error', () => {}); req.write(Buffer.alloc(1)); return req;
  });
  await new Promise((r) => setTimeout(r, 300));
  // Unrelated user cc sends a complete small chunk.
  const third = await call('cc', 'PUT', '/api/uploads/' + ids.cc, Buffer.alloc(size), { 'content-type': 'application/octet-stream', 'x-flux-offset': '0' });
  console.log(JSON.stringify({ thirdUserStatus: third.status, thirdUserBody: third.body }));
  slow.forEach((r) => r.destroy());
  await new Promise((r) => setTimeout(r, 200));
  await app.close(); await fs.rm(storage, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
