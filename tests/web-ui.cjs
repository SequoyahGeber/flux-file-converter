const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { chromium } = require('playwright');
const { createApp } = require('../server/app.cjs');
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-web-ui-'));
  const app = await createApp(
    { storage: dir },
    {
      auth: async () => ({ id: 'synthetic-user', email: 'demo@example.com' }),
      scan: async () => 'full',
      capabilities: {
        formats: [{ input: 'png', family: 'image', targets: ['jpg', 'webp'] }],
        families: [{ id: 'image', name: 'Images', formats: ['png'] }],
        engines: { images: true },
      },
      rpc: async (spec, files, out) => {
        if (spec.operation === 'inspect')
          return {
            name: files[0].name,
            family: 'image',
            ext: 'png',
            size: files[0].size,
            targets: ['jpg'],
            details: '40 × 30',
            compressionOptions: [
              { id: 'lossy', name: 'Smaller WebP', target: 'webp' },
              { id: 'archive', name: 'Lossless ZIP', target: 'zip' },
            ],
          };
        await sharp(files[0].path).jpeg().toFile(out);
        return {
          name: 'sample.jpg',
          size: (await fs.stat(out)).size,
          target: 'jpg',
          completedAt: Date.now(),
        };
      },
    },
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1380, height: 960 } });
    await page.addInitScript(() => {
      window.showSaveFilePicker = undefined;
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', async (r) => {
      if (r.status() >= 400) console.error(r.status(), r.url(), await r.text());
    });
    await page.goto('http://127.0.0.1:' + app.server.address().port);
    await page.getByText('demo@example.com').waitFor();
    const image = path.join(dir, 'sample.png');
    await sharp({ create: { width: 40, height: 30, channels: 4, background: '#9372c8' } })
      .png()
      .toFile(image);
    await page.locator('#files').setInputFiles(image);
    await page
      .getByText('40 × 30', { exact: false })
      .waitFor({ timeout: 10000 })
      .catch(async (e) => {
        console.error(await page.locator('body').innerText());
        throw e;
      });
    await page.locator('#run').click();
    await page.locator('#rows button.download').waitFor();
    await page.locator('#rows .save-control input').fill('My converted image.jpg');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#rows button.download').click(),
    ]);
    assert.equal(download.suggestedFilename(), 'My converted image.jpg');
    await download.saveAs(path.join(dir, 'download.jpg'));
    assert.equal((await sharp(path.join(dir, 'download.jpg')).metadata()).width, 40);
    await fs.mkdir('.test-output', { recursive: true });
    await page.screenshot({ path: '.test-output/web-converter.png', fullPage: true });
    await page.getByRole('button', { name: '▦ All formats' }).click();
    await page.locator('#search').fill('jpg');
    await page.locator('.format-row').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.getByRole('link', { name: 'Sign out ↗' }).isVisible());
    await page.getByRole('button', { name: '⇄ Convert files' }).click();
    await page.locator('#rows button.download').waitFor();
    const mobileBounds = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      save: document.querySelector('#rows button.download').getBoundingClientRect().height,
    }));
    assert(mobileBounds.content <= mobileBounds.width, JSON.stringify(mobileBounds));
    assert(mobileBounds.save >= 44, 'Mobile save controls need a usable touch target.');
    await page.screenshot({ path: '.test-output/web-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '◷ Recent results' }).click();
    await page.locator('#result-list button.download').waitFor();
    await page.locator('#delete-results').click();
    await page.getByText('Your completed downloads will appear here.').waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'Browser upload, conversion, custom save filename, download, format search, mobile layout and deletion passed.',
    );
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
