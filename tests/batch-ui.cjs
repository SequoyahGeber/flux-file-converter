const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/app.cjs');

async function main() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-batch-ui-'));
  let now = 0,
    failOnce = true,
    releaseFocus;
  const focusHold = new Promise((resolve) => {
    releaseFocus = resolve;
  });
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
        if (files[0].name === 'focus-1.png') await focusHold;
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
    // Finish the first result while a later conversion remains deterministically
    // held. A third job submitted through the real API stays queued behind it.
    await page.locator('#files').setInputFiles(inputs(3, 'focus-'));
    await drive(
      () =>
        document.querySelectorAll('#rows .row').length === 3 &&
        !document.querySelector('#run').disabled,
    );
    assert.equal(await page.locator('#rows .job-state').first().innerText(), 'Ready');
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await drive(
      () =>
        document.querySelector('#rows .download') &&
        document.querySelectorAll('#rows .row')[1].querySelector('.job-state')?.textContent ===
          'Converting…',
    );
    const focusState = await status(),
      laterJob = focusState.jobs.find(
        (job) => job.operation === 'convert' && job.status === 'running',
      );
    assert(laterJob);
    const queued = await page.request.post(base + '/api/jobs', {
      headers: { 'X-Flux-Request': '1' },
      data: {
        operation: 'convert',
        id: focusState.files[2].id,
        target: 'jpg',
        options: { quality: 'balanced', width: 0 },
      },
    });
    assert.equal(queued.status(), 202);
    const queuedJob = await queued.json();
    await drive(
      () =>
        document.querySelectorAll('#rows .row')[2].querySelector('.job-state')?.textContent ===
        'Waiting',
    );
    async function poll() {
      const previous = await page.locator('#rows .row').first().elementHandle();
      const refreshed = page.waitForResponse(
        (response) =>
          response.url() === base + '/api/status' && response.request().method() === 'GET',
        { timeout: 10000 },
      );
      now += 1600;
      await page.clock.runFor(1600);
      const response = await refreshed;
      assert.equal(response.status(), 200);
      const snapshot = await response.json();
      assert.equal(snapshot.jobs.find((job) => job.id === laterJob.id)?.status, 'running');
      // A response alone is not proof that render has rebuilt the controls.
      await page.waitForFunction((el) => !el.isConnected, previous, { timeout: 10000 });
      await previous.dispose();
    }
    async function focusedFilename(field, value, start, end, direction) {
      assert.deepEqual(
        await field.evaluate((el) => ({
          focused: el === document.activeElement,
          value: el.value,
          start: el.selectionStart,
          end: el.selectionEnd,
          direction: el.selectionDirection,
        })),
        { focused: true, value, start, end, direction },
      );
    }
    const filename = page.locator('#rows .save-control input'),
      save = page.locator('#rows').getByRole('button', { name: 'Save as…', exact: true });
    await filename.fill('Edited output.jpg');
    await filename.evaluate((el) => el.setSelectionRange(2, 8, 'backward'));
    const filenameKey = await filename.getAttribute('data-focus-key');
    for (let i = 0; i < 2; i++) {
      await poll();
      assert.equal(await filename.getAttribute('data-focus-key'), filenameKey);
      await focusedFilename(filename, 'Edited output.jpg', 2, 8, 'backward');
    }
    await filename.fill('');
    const emptyDirection = await filename.evaluate((el) => el.selectionDirection);
    await poll();
    await focusedFilename(filename, '', 0, 0, emptyDirection);
    await filename.fill('Edited output.jpg');
    await page.keyboard.press('Tab');
    assert.equal(await save.evaluate((el) => el === document.activeElement), true);
    await poll();
    assert.equal(await save.evaluate((el) => el === document.activeElement), true);

    await page.getByRole('button', { name: 'Recent files', exact: true }).click();
    const historyName = page.locator('#result-list .save-control input'),
      historySave = page.locator('#result-list').getByRole('button', {
        name: 'Save as…',
        exact: true,
      });
    assert.equal(await historyName.inputValue(), 'Edited output.jpg');
    await historyName.fill('History output.jpg');
    await historyName.evaluate((el) => el.setSelectionRange(1, 5, 'forward'));
    await poll();
    await focusedFilename(historyName, 'History output.jpg', 1, 5, 'forward');
    await page.keyboard.press('Tab');
    await poll();
    assert.equal(await historySave.evaluate((el) => el === document.activeElement), true);
    assert.equal(await save.evaluate((el) => el === document.activeElement), false);

    const formatsNav = page.getByRole('button', { name: 'All formats', exact: true });
    await formatsNav.click();
    await poll();
    assert.equal(await formatsNav.evaluate((el) => el === document.activeElement), true);
    const search = page.getByRole('searchbox', { name: 'Search formats', exact: true });
    await search.fill('png');
    await poll();
    assert.equal(await search.evaluate((el) => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Convert files', exact: true }).click();
    assert.equal(await filename.inputValue(), 'History output.jpg');
    await Promise.all([
      ...[laterJob.id, queuedJob.id].map((id) =>
        page.waitForResponse(
          (response) =>
            response.url() === base + '/api/cancel' &&
            response.request().postDataJSON()?.id === id,
          { timeout: 10000 },
        ),
      ),
      page.getByRole('button', { name: 'Cancel', exact: true }).click(),
    ]);
    releaseFocus();
    await drive(() => document.querySelector('#cancel').hidden);
    assert.equal(await page.locator('#rows .job-state').nth(0).innerText(), 'Cancelled');
    assert.equal(await page.locator('#rows .job-state').nth(1).innerText(), 'Cancelled');
    await page.getByRole('button', { name: 'Delete all my files', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#dropzone').hidden);
    now += 3600000;
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
    await page.getByText('Failed', { exact: true }).waitFor();
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
      'Real API quotas: 20-file upload/conversion, waiting cancellation, reload, failed-job retry without duplicate successes, 8-file batch, immediate format notes, polling focus/selection/draft preservation in queue and history, keyboard saves and status labels passed (controlled clocks; stub codecs/scanner).',
    );
  } finally {
    releaseFocus();
    await browser.close();
    await app.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
