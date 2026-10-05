const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { createApp } = require('../server/app.cjs');

async function main() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-reconnect-'));
  let release,
    conversions = 0;
  const app = await createApp(
    { storage },
    {
      auth: async () => ({ id: 'synthetic-reconnect', email: 'reconnect@example.com' }),
      scan: async () => 'full',
      capabilities: { formats: [], families: [] },
      rpc: async (spec, files, output) => {
        if (spec.operation === 'inspect')
          return { family: 'presentation', ext: 'pptx', targets: ['pdf'], size: files[0].size };
        conversions++;
        await new Promise((resolve) => {
          release = resolve;
        });
        await fs.writeFile(output, 'Synthetic result');
        return { name: 'presentation.pdf', target: 'pdf', size: 16, completedAt: Date.now() };
      },
    },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + app.server.address().port);
    await page.getByText('reconnect@example.com').waitFor();
    await page.locator('#files').setInputFiles({
      name: 'presentation.pptx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('Synthetic input'),
    });
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    let outage = true;
    await page.route('**/api/status', async (route) => {
      if (outage)
        await route.fulfill({ status: 502, contentType: 'text/html', body: 'Unavailable' });
      else await route.continue();
    });
    await page.locator('#run').click();
    await page.getByText('Connection lost. Checking the server again…', { exact: true }).waitFor();
    assert.equal(await page.locator('#run').isDisabled(), true);
    // The server may finish during the outage. Reconnection observes that
    // result rather than launching another conversion.
    while (!release) await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    outage = false;
    await page.locator('#reconnect').click();
    await page.locator('#rows .download').waitFor();
    assert.equal(conversions, 1);
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.equal(await page.locator('#run').isDisabled(), false);
    await page.locator('#quality').selectOption('high');
    await page.locator('#run').click();
    await page.waitForFunction(
      () => document.querySelector('#rows .job-state')?.textContent === 'running',
    );
    await page.reload();
    await page.getByText('reconnect@example.com').waitFor();
    assert.equal(await page.locator('#run').isDisabled(), true);
    release();
    await page.locator('#rows .download').waitFor({ timeout: 15000 });
    assert.equal(conversions, 2);
    assert.equal(await page.locator('#run').isDisabled(), false);
    console.log(
      'Transient server outage recovers without duplicate jobs; reloaded running jobs finish and unlock controls. Real API, synthetic scanner/converter.',
    );
  } finally {
    release?.();
    await browser.close();
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
