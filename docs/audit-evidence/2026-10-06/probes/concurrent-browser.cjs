// Probe: browser upload while two other users hold the server's chunk slots.
const R = '/Users/sequoyahgeber/dev/File converter';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(R + '/node_modules/playwright');
const { createApp } = require(R + '/server/app.cjs');
(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-concb-'));
  const app = await createApp({ storage }, {
    auth: async (req) => { const u = req.headers['x-test-user'] || 'browser'; return { id: u.padEnd(64, '0').slice(0, 64), email: u + '@example.com' }; },
    scan: async () => 'full', capabilities: { formats: [], families: [] },
    rpc: async (spec, files) => ({ family: 'video', ext: 'mp4', targets: ['mov'], size: files[0].size }),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port, size = 1024 * 1024;
  const post = (u) => new Promise((res) => { const q = http.request({ port, method: 'POST', path: '/api/uploads', headers: { 'x-test-user': u, 'content-type': 'application/json' } }, (r) => { let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => res(JSON.parse(t).id)); }); q.end(JSON.stringify({ name: 'a.bin', size })); });
  const slow = [];
  for (const u of ['aa', 'bb']) { const id = await post(u); const q = http.request({ port, method: 'PUT', path: '/api/uploads/' + id, headers: { 'x-test-user': u, 'content-type': 'application/octet-stream', 'content-length': size, 'x-flux-offset': '0' } }); q.on('error', () => {}); q.write(Buffer.alloc(1)); slow.push(q); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + port);
  await page.getByText('browser@example.com').waitFor();
  await page.locator('#files').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(200000, 1) });
  await page.locator('#error').waitFor({ state: 'visible', timeout: 15000 });
  const status = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
  console.log(JSON.stringify({ error: await page.locator('#error').textContent(), filesAfter: status.files.length }));
  slow.forEach((q) => q.destroy()); await browser.close(); await app.close(); await fs.rm(storage, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
