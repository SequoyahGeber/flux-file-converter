// Probe: emulate a browser without AbortSignal.any (Safari < 17.4, Chrome < 116, Firefox < 124).
const R = '/Users/sequoyahgeber/dev/File converter';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { chromium, webkit } = require(R + '/node_modules/playwright');
const { createApp } = require(R + '/server/app.cjs');
(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-any-'));
  const app = await createApp({ storage }, {
    auth: async () => ({ id: 'synthetic-any', email: 'any@example.com' }), scan: async () => 'full',
    capabilities: { formats: [], families: [] },
    rpc: async (spec, files) => ({ family: 'image', ext: 'png', targets: ['jpg'], size: files[0].size }),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  for (const removeAny of [false, true]) {
    const page = await browser.newPage();
    if (removeAny) await page.addInitScript(() => { delete AbortSignal.any; });
    await page.goto('http://127.0.0.1:' + app.server.address().port);
    await page.getByText('any@example.com').waitFor();
    await page.locator('#files').setInputFiles({ name: 'a' + removeAny + '.png', mimeType: 'image/png', buffer: Buffer.alloc(1000, 1) });
    const outcome = await Promise.race([
      page.locator('#error').waitFor({ state: 'visible', timeout: 15000 }).then(async () => 'ERROR: ' + (await page.locator('#error').textContent())),
      page.locator('#rows').getByText('a' + removeAny + '.png').waitFor({ timeout: 15000 }).then(() => 'UPLOADED'),
    ]);
    console.log(JSON.stringify({ abortSignalAnyRemoved: removeAny, outcome }));
    await page.close();
  }
  await browser.close(); await app.close(); await fs.rm(storage, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
