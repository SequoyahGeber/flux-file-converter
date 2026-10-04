const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/app.cjs');

async function main() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-batch-ui-'));
  let now = 0,
    failOnce = true;
  const app = await createApp(
    { storage },
    {
      now: () => now,
      auth: async () => ({ id: 'synthetic-batch', email: 'batch@example.com' }),
      scan: async () => 'full',
      capabilities: { formats: [], families: [] },
      rpc: async (spec, files, output) => {
        if (spec.operation === 'inspect')
          return {
            family: 'image',
            ext: 'png',
            size: files[0].size,
            targets: ['jpg', 'png'],
            notes: { jpg: 'JPEG loses transparency.', png: 'PNG preserves pixels.' },
          };
        if (files[0].name === 'file-7.png' && failOnce) {
          failOnce = false;
          throw new Error('Synthetic conversion failure.');
        }
        await fs.writeFile(output, 'synthetic result');
        return {
          name: files[0].name + '.' + spec.target,
          target: spec.target,
          completedAt: Date.now(),
        };
      },
    },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(),
      base = 'http://127.0.0.1:' + app.server.address().port;
    const retries = [],
      observed = [],
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() === 429) {
        const seconds = Number(response.headers()['retry-after']);
        assert(seconds > 0, 'Quota responses must expose the remaining window.');
        retries.push(seconds);
        observed.push(response.url());
      }
    });
    await page.clock.install();
    await page.goto(base);
    await page.getByText('batch@example.com').waitFor();
    // Advance both clocks rather than weakening server limits or waiting hours.
    async function drive(predicate, stopBeforeQuota = false) {
      for (let i = 0; i < 500; i++) {
        if (await page.evaluate(predicate)) return;
        if (!stopBeforeQuota && retries.length) {
          const milliseconds = retries.shift() * 1000 + 1;
          now += milliseconds;
          await page.clock.runFor(milliseconds);
        } else {
          now += 2000;
          await page.clock.runFor(2000);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        'Batch did not reach its expected state: ' + (await page.locator('body').innerText()),
      );
    }
    const inputs = (count, prefix = 'file-') =>
      Array.from({ length: count }, (_, index) => ({
        name: prefix + index + '.png',
        mimeType: 'image/png',
        buffer: Buffer.from('synthetic file ' + index),
      }));
    const status = async () => (await page.request.get(base + '/api/status')).json();
    await page.locator('#files').setInputFiles(inputs(20));
    await drive(
      () =>
        document.querySelectorAll('#rows .row').length === 20 &&
        !document.querySelector('#run').disabled,
    );
    assert(
      observed.some((url) => url.endsWith('/uploads')),
      'Twenty-file uploads must exercise the real upload quota.',
    );
    const select = page.locator('#rows select').first();
    await select.focus();
    await select.selectOption('png');
    assert.equal(await page.locator('#rows .note').first().innerText(), 'PNG preserves pixels.');
    assert.equal(await select.evaluate((el) => el === document.activeElement), true);
    await select.selectOption('jpg');
    assert.equal(await page.locator('#rows .note').first().innerText(), 'JPEG loses transparency.');
    await select.selectOption('png');
    await page.locator('#quality').selectOption('high');
    await page.locator('#run').click();
    await drive(
      () => document.querySelector('#status').textContent.includes('Waiting for server quota'),
      true,
    );
    assert.equal(
      (await status()).jobs.filter((job) => job.operation === 'convert' && job.status === 'done')
        .length,
      6,
    );
    await page.locator('#cancel').click();
    await drive(() => document.querySelector('#cancel').hidden);
    await page.reload();
    await page.getByText('batch@example.com').waitFor();
    assert.equal(await page.locator('#rows select').first().inputValue(), 'png');
    assert.equal(await page.locator('#quality').inputValue(), 'high');
    await page.locator('#run').click();
    await drive(() => !document.querySelector('#run').disabled);
    let state = await status();
    assert.equal(
      state.jobs.filter((job) => job.operation === 'convert' && job.status === 'done').length,
      7,
    );
    assert.equal(
      state.jobs.filter((job) => job.operation === 'convert' && job.status === 'error').length,
      1,
    );
    await page.locator('#run').click();
    await drive(() => !document.querySelector('#run').disabled);
    state = await status();
    const done = state.jobs.filter((job) => job.operation === 'convert' && job.status === 'done');
    assert.equal(done.length, 20);
    assert.equal(
      new Set(done.map((job) => job.fileId)).size,
      20,
      'Resume must not redo completed files.',
    );
    await page.locator('#run').click();
    await drive(() => !document.querySelector('#run').disabled);
    assert.equal(
      (await status()).jobs.length,
      state.jobs.length,
      'Completed work must survive repeat submission.',
    );
    await page.locator('#clear').click();
    await page.waitForFunction(() => document.querySelector('#dropzone').hidden === false);
    now += 3600000;
    await page.locator('#files').setInputFiles(inputs(8, 'eight-'));
    await drive(
      () =>
        document.querySelectorAll('#rows .row').length === 8 &&
        !document.querySelector('#run').disabled,
    );
    await page.locator('#run').click();
    await drive(() => !document.querySelector('#run').disabled);
    assert.equal(
      (await status()).jobs.filter((job) => job.operation === 'convert' && job.status === 'done')
        .length,
      8,
    );
    assert(observed.some((url) => url.endsWith('/jobs')));
    assert.deepEqual(errors, []);
    await fs.mkdir('.test-output', { recursive: true });
    await page.screenshot({ path: '.test-output/batch-resume.png' });
    console.log(
      'Real API quotas: 20-file upload/conversion, waiting cancellation, reload, failed-job retry without duplicate successes, 8-file batch, immediate format notes and preserved focus passed (controlled clocks; stub codecs/scanner).',
    );
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
