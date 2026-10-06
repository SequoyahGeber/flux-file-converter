// Probe: does a browser on a ~0.8 Mbit/s uplink finish a 20 MiB upload?
const R = '/Users/sequoyahgeber/dev/File converter';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { chromium } = require(R + '/node_modules/playwright');
const { createApp } = require(R + '/server/app.cjs');
(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-slow-'));
  let putBytes = 0, puts = 0;
  const app = await createApp({ storage }, {
    auth: async () => ({ id: 'synthetic-slow', email: 'slow@example.com' }),
    scan: async () => 'full',
    capabilities: { formats: [], families: [] },
    rpc: async (spec, files) => ({ family: 'video', ext: 'mp4', targets: ['mov'], size: files[0].size }),
  });
  app.server.on('request', (req) => { if (req.method === 'PUT') { puts++; req.on('data', (c) => (putBytes += c.length)); } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page.getByText('slow@example.com').waitFor();
  const kbps = Number(process.env.KBPS || 100);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 5e6, uploadThroughput: kbps * 1024 });
  const t0 = Date.now();
  await page.locator('#files').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(20 * 1024 * 1024, 7) });
  const outcome = await Promise.race([
    page.locator('#error').waitFor({ state: 'visible', timeout: 400000 }).then(async () => 'ERROR: ' + (await page.locator('#error').textContent())),
    page.waitForFunction(() => !document.querySelector('#run').disabled, null, { timeout: 400000 }).then(() => 'UPLOADED'),
  ]);
  console.log(JSON.stringify({ uplinkKBps: kbps, outcome, seconds: Math.round((Date.now() - t0) / 1000), puts, serverBytesReceived: putBytes, fileBytes: 20 * 1024 * 1024 }));
  await browser.close(); await app.close(); await fs.rm(storage, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
