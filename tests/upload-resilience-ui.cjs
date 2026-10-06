const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const { createApp } = require('../server/app.cjs');
const { LIMITS } = require('../server/security.cjs');

async function main() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-resilience-'));
  const app = await createApp(
    { storage },
    {
      auth: async (req) => {
        const user = req.headers['x-test-user'] || 'browser';
        return { id: user.padEnd(64, '0').slice(0, 64), email: user + '@example.com' };
      },
      scan: async () => 'full',
      capabilities: { formats: [], families: [] },
      rpc: async (spec, files) => ({
        family: 'video',
        ext: 'mp4',
        targets: ['mov'],
        size: files[0].size,
      }),
    },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const held = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const open = async (init) => {
      const page = await browser.newPage();
      if (init) await page.addInitScript(init);
      await page.goto('http://127.0.0.1:' + port);
      await page.getByText('browser@example.com').waitFor();
      return page;
    };
    const uploaded = async (page, name, size = 4096) => {
      await page.locator('#files').setInputFiles({
        name,
        mimeType: 'video/mp4',
        buffer: Buffer.alloc(size, 1),
      });
      await page.locator('#rows').getByText(name).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('#error').isVisible(), false);
    };

    // Safari before 17.4 has no AbortSignal.any; Safari 15 has no AbortSignal.timeout.
    let page = await open(() => {
      delete AbortSignal.any;
      delete AbortSignal.timeout;
    });
    await uploaded(page, 'old-browser.mp4');
    await page.close();

    // Every server-wide chunk stream is held by other users: wait and retry.
    const post = (user) =>
      new Promise((resolve) => {
        const request = http.request(
          {
            port,
            method: 'POST',
            path: '/api/uploads',
            headers: { 'x-test-user': user, 'content-type': 'application/json' },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve(JSON.parse(text).id));
          },
        );
        request.end(JSON.stringify({ name: 'held.bin', size: 1024 }));
      });
    for (let i = 0; i < LIMITS.uploadStreams; i++) {
      const user = 'held' + i,
        id = await post(user);
      const request = http.request({
        port,
        method: 'PUT',
        path: '/api/uploads/' + id,
        headers: {
          'x-test-user': user,
          'content-type': 'application/octet-stream',
          'content-length': 1024,
          'x-flux-offset': '0',
        },
      });
      request.on('error', () => {});
      request.write(Buffer.alloc(1));
      held.push(request);
    }
    page = await open();
    let busy = 0;
    page.on('response', (response) => {
      if (response.request().method() === 'PUT' && response.status() === 429) busy++;
    });
    await page.locator('#files').setInputFiles({
      name: 'busy.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.alloc(4096, 1),
    });
    await page.waitForFunction(() =>
      /retrying/.test(document.querySelector('#status').textContent),
    );
    for (const request of held.splice(0)) request.destroy();
    await page.locator('#rows').getByText('busy.mp4').waitFor({ timeout: 30000 });
    assert.ok(busy >= 1, 'the busy server answered 429');
    assert.equal(await page.locator('#error').isVisible(), false);

    // A dropped connection mid-chunk resumes instead of discarding the upload.
    let dropped = false;
    await page.route('**/api/uploads/*', async (route) => {
      if (route.request().method() === 'PUT' && !dropped) {
        dropped = true;
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    await uploaded(page, 'dropped.mp4');
    assert.equal(dropped, true);
    await page.unroute('**/api/uploads/*');

    // The server stored the chunk but its response was lost: resync the offset.
    let lost = false;
    await page.route('**/api/uploads/*', async (route) => {
      if (route.request().method() === 'PUT' && !lost) {
        lost = true;
        await route.fetch();
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    await uploaded(page, 'lost-response.mp4');
    assert.equal(lost, true);
    const status = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
    assert.equal(status.files.length, 4);
    console.log(
      'Uploads succeed without AbortSignal.any/timeout, wait for busy server streams, and resume after dropped or lost chunk responses.',
    );
  } finally {
    for (const request of held) request.destroy();
    await browser.close();
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
