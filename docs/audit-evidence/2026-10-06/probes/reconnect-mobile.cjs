// Probe: connection-lost state at 390px width — layout, names, focus.
const R = '/Users/sequoyahgeber/dev/File converter';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { chromium } = require(R + '/node_modules/playwright');
const { createApp } = require(R + '/server/app.cjs');
(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-mob-'));
  let release;
  const app = await createApp({ storage }, {
    auth: async () => ({ id: 'synthetic-mobile', email: 'mobile@example.com' }), scan: async () => 'full',
    capabilities: { formats: [], families: [] },
    rpc: async (spec, files, output) => {
      if (spec.operation === 'inspect') return { family: 'presentation', ext: 'pptx', targets: ['pdf'], size: files[0].size };
      await new Promise((r) => (release = r)); await fs.writeFile(output, 'x');
      return { name: 'a-very-long-presentation-name-for-layout-checking-quarterly-review.pdf', target: 'pdf', size: 1, completedAt: Date.now() };
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page.getByText('mobile@example.com').waitFor();
  await page.locator('#files').setInputFiles({ name: 'a-very-long-presentation-name-for-layout-checking-quarterly-review.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await page.waitForFunction(() => !document.querySelector('#run').disabled);
  await page.route('**/api/status', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: 'down' }));
  await page.locator('#run').click();
  await page.locator('#reconnect').waitFor({ state: 'visible' });
  const info = await page.evaluate(() => {
    const b = document.querySelector('#reconnect'), r = b.getBoundingClientRect();
    return { name: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right),
      pageScrollWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      status: document.querySelector('#status').textContent, error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      rowState: document.querySelector('#rows .job-state')?.textContent };
  });
  await page.screenshot({ path: 'reconnect-mobile.png', fullPage: true });
  console.log(JSON.stringify(info));
  release?.(); await browser.close(); await app.close(); await fs.rm(storage, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
