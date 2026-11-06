const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { detectEngines, run } = require('../electron/engine.cjs');
const { desktopPerformance } = require('./fixtures/desktop-performance.cjs');
let root;
async function textSizes(page, state, required) {
  for (const selector of required) await page.locator(selector).first().waitFor();
  const result = await page.evaluate(() => {
    const elements = new Set(document.querySelectorAll('input, select, textarea'));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim()) elements.add(walker.currentNode.parentElement);
    }
    const measured = [...elements]
      .filter(
        (el) =>
          el instanceof HTMLElement &&
          !el.closest('script, style, option, [inert]') &&
          el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      )
      .map((el) => ({
        selector:
          el.tagName.toLowerCase() +
          (el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
        text: (el.value || el.textContent).trim().slice(0, 80),
        size: parseFloat(getComputedStyle(el).fontSize),
      }));
    return { count: measured.length, failures: measured.filter((item) => item.size < 10) };
  });
  assert.ok(result.count > 0, state + ': no visible text measured');
  assert.deepEqual(result.failures, [], state + ': ' + JSON.stringify(result.failures));
}
async function textContrast(page, selectors, minimum = 4.5) {
  for (const selector of selectors) await page.locator(selector).first().waitFor();
  const results = await page.evaluate((targets) => {
    const luminance = (color) => {
      const values = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          value /= 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    return targets.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        let parent = element,
          background;
        while (parent) {
          background = getComputedStyle(parent).backgroundColor;
          if (background !== 'rgba(0, 0, 0, 0)') break;
          parent = parent.parentElement;
        }
        const foreground = getComputedStyle(element).color;
        const a = luminance(foreground),
          b = luminance(background);
        return {
          selector,
          foreground,
          background,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      }),
    );
  }, selectors);
  for (const selector of selectors)
    assert.ok(
      results.some((result) => result.selector === selector),
      selector + ': no contrast targets',
    );
  for (const result of results) assert.ok(result.ratio >= minimum, JSON.stringify(result));
}
async function actionContrast(page, selector, minimum = 4.5) {
  await textContrast(page, [selector], minimum);
  await page.locator(selector).first().hover();
  await page.locator(selector).first().evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
  });
  await textContrast(page, [selector], minimum);
  // Move off the control so later checks measure its normal state.
  await page.mouse.move(0, 0);
}
async function reachableControls(page, state, selectors) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert.ok(
      bounds.x >= -0.5 &&
        bounds.y >= -0.5 &&
        bounds.right <= bounds.width + 0.5 &&
        bounds.bottom <= bounds.height + 0.5,
      state + ': ' + selector + ' ' + JSON.stringify(bounds),
    );
  }
}
async function nativeMenuAction(page, action) {
  // Exercise the exact fixed JavaScript used by the native menu, without a
  // production test hook. Swift compilation and key equivalents need native proof.
  const source = await fs.readFile(path.join(__dirname, '../mac/Flux/FluxApp.swift'), 'utf8');
  const script = source.match(/callAsyncJavaScript\("""([\s\S]*?)""", arguments:/);
  assert.ok(script, 'Native menu activation script is missing');
  await page.evaluate('(action) => {' + script[1] + '\n}', action);
}
async function currentPage(page, name) {
  const current = page.locator('.side-button[aria-current="page"]');
  await current.filter({ hasText: name }).waitFor();
  assert.equal(await current.count(), 1);
  assert.equal(await page.locator('.side-button[aria-current]').count(), 1);
}
async function notification(page, node, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('.notification > span')?.textContent === expected,
    text,
  );
  assert.equal(await node.evaluate((el) => el === document.querySelector('.notification')), true);
  assert.equal(await page.locator('.notification[role="status"]').count(), 1);
}
async function focusContrast(page, control, wrapper) {
  await page.keyboard.press('Tab');
  await control.focus();
  assert.equal(await control.evaluate((el) => el === document.activeElement), true);
  const result = await control.evaluate((input, selector) => {
    const element = selector ? input.closest(selector) : input;
    const style = getComputedStyle(element);
    let parent = element.parentElement;
    while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)')
      parent = parent.parentElement;
    const luminance = (color) => {
      const [r, g, b] = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          value /= 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const a = luminance(style.outlineColor),
      b = luminance(getComputedStyle(parent).backgroundColor);
    return {
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
  }, wrapper);
  assert.notEqual(result.style, 'none');
  assert.ok(result.width >= 3, JSON.stringify(result));
  assert.ok(result.ratio >= 3, JSON.stringify(result));
}
async function progressValues(bar) {
  await bar.waitFor();
  const values = await bar.evaluate((el) => ({
    min: el.getAttribute('aria-valuemin'),
    max: el.getAttribute('aria-valuemax'),
    now: el.getAttribute('aria-valuenow'),
    name: el.getAttribute('aria-label'),
  }));
  checkProgress(values);
}
function checkProgress(values) {
  assert.equal(values.min, '0');
  assert.equal(values.max, '100');
  assert.match(values.now, /^\d+(\.\d+)?$/);
  assert.ok(Number(values.now) >= 0 && Number(values.now) <= 100);
  assert.match(values.name, /^Progress for .+/);
}
// A separate window has no preload. Its test-local bridge drives the real renderer
// subscription without adding capabilities to either production bridge.
async function announcementFixtures(electronApp, url) {
  const opened = electronApp.waitForEvent('window');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    void window.loadURL('about:blank');
  });
  const page = await opened;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      let update;
      const files = ['One', 'Two', 'Three', 'Unsupported'].map((name, i) => ({
        id: String(i),
        name: name + '.json',
        path: '/fixture/' + name + '.json',
        ext: 'json',
        family: 'data',
        size: 100,
        targets: i === 3 ? [] : ['csv'],
      }));
      window.a11yFixture = {
        requests: [],
        reject: false,
        native: false,
        emit: (event) => update(event),
        complete: () => update({ batchComplete: true, history: [] }),
      };
      window.flux = {
        getState: async () => ({
          engines: { data: true, local: true },
          nativeLocal: window.a11yFixture.native,
          samples: [{ id: 'json', title: 'JSON to CSV', target: 'csv' }],
          privacyText: 'Fixture privacy policy. Files are converted locally.',
          enginePaths: {},
          outputDir: '/fixture/results',
          families: [{ id: 'data', name: 'Data', formats: ['json'] }],
          history: [],
          files,
          running: false,
        }),
        describeFormat: async () => ['csv'],
        refreshEngines: async () => window.flux.getState(),
        releaseFiles: async () => true,
        onUpdate: (callback) => {
          update = callback;
          return () => {};
        },
        onFiles: () => () => {},
        start: async (requests) => {
          window.a11yFixture.requests = requests;
          if (window.a11yFixture.reject) throw new Error('Fixture start rejected.');
        },
        cancel: async () => {
          for (const request of window.a11yFixture.requests)
            update({ ...request, status: 'cancelled', progress: 0 });
          window.a11yFixture.complete();
        },
      };
    });
    await page.goto(url);
    await page.getByRole('button', { name: 'Convert files 4 files', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'All formats 1 format', exact: true }).count(),
      1,
    );
    await textSizes(page, 'Fixture queue', ['.file-info', '.unsupported-label']);
    await textContrast(page, ['.unsupported-label', '.workspace-footer']);
    await actionContrast(page, '.remove-button', 3);
    const node = await page.locator('.notification').elementHandle();
    await notification(page, node, '');
    for (const [action, name] of [
      ['compress', 'Compress files'],
      ['archive', 'ZIP & Unzip'],
      ['history', 'Recent files'],
      ['formats', 'All formats'],
      ['convert', 'Convert files'],
    ]) {
      await nativeMenuAction(page, action);
      await currentPage(page, name);
    }
    await nativeMenuAction(page, 'start');
    await page.getByRole('button', { name: 'Cancel batch', exact: true }).waitFor();
    await nativeMenuAction(page, 'compress');
    await currentPage(page, 'Convert files');
    await page.getByRole('alert').getByText(/before switching workspaces/).waitFor();
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await nativeMenuAction(page, 'cancel');
    await page.locator('.queue-bottom .primary-button').waitFor();
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await notification(page, node, '');
    const start = async () => {
      await page.locator('.queue-bottom .primary-button').click();
      await page.getByRole('button', { name: 'Cancel batch', exact: true }).waitFor();
      await notification(page, node, '');
    };
    await start();
    assert.deepEqual(
      await page.evaluate(() => window.a11yFixture.requests.map((r) => r.id)),
      ['0', '1', '2'],
    );
    await page.evaluate(() => {
      window.a11yFixture.emit({ id: '0', status: 'running', progress: 150 });
    });
    const bar = page.getByRole('progressbar', { name: 'Progress for One.json', exact: true });
    await progressValues(bar);
    assert.equal(await bar.getAttribute('aria-valuenow'), '100');
    await page.evaluate(() => {
      window.a11yFixture.emit({ id: '0', status: 'running', progress: -5 });
    });
    await page.waitForFunction(
      () => document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '0',
    );
    await page.locator('.spin').waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.spin')).animationName === 'none',
    );
    const transitions = await page.evaluate(() =>
      [...document.querySelectorAll('.spin, .row-progress-track > div, button, select')].flatMap(
        (el) =>
          [null, '::before', '::after'].map(
            (pseudo) => getComputedStyle(el, pseudo).transitionDuration,
          ),
      ),
    );
    for (const duration of transitions) assert.match(duration, /^0s(, 0s)*$/);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.spin')).animationName === 'spin',
    );
    assert.equal(
      await page
        .locator('.row-progress-track > div')
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      '0.2s',
    );
    // Deliver terminal events and completion in one turn to catch stale queue reads.
    await page.evaluate(() => {
      const f = window.a11yFixture;
      f.emit({
        id: '0',
        status: 'done',
        progress: 100,
        result: { id: 'result', name: 'One.csv', size: 100, target: 'csv' },
      });
      f.emit({ id: '1', status: 'error', error: 'Fixture failure.' });
      f.emit({ id: '2', status: 'cancelled' });
      f.complete();
    });
    await notification(
      page,
      node,
      'Batch finished. 1 file ready. 1 file failed. 1 file cancelled.',
    );
    assert.equal(await page.locator('.row-warning[role="status"]').count(), 2);
    await textSizes(page, 'Fixture mixed results', [
      '.row-warning',
      '.result-button',
      '.unsupported-label',
    ]);
    await textContrast(page, ['.row-warning', '.unsupported-label', '.workspace-footer']);
    await actionContrast(page, '.result-button');
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await notification(page, node, '');
    // Only failed/cancelled files are retried; old successes and unsupported files stay out.
    for (let repeat = 0; repeat < 2; repeat++) {
      await start();
      assert.deepEqual(
        await page.evaluate(() => window.a11yFixture.requests.map((r) => r.id)),
        ['1', '2'],
      );
      await page.evaluate(() => {
        for (const r of window.a11yFixture.requests)
          window.a11yFixture.emit({ ...r, status: 'error', error: 'Fixture failure.' });
        window.a11yFixture.complete();
      });
      await notification(page, node, 'Batch finished. 2 files failed.');
    }
    await start();
    await page.getByRole('button', { name: 'Cancel batch', exact: true }).click();
    await notification(page, node, 'Batch finished. 2 files cancelled.');
    // A rejected start must discard tracking; a subsequent completion has no claimed outcomes.
    await page.evaluate(() => {
      window.a11yFixture.reject = true;
    });
    await page.locator('.queue-bottom .primary-button').click();
    await page.getByRole('alert').getByText('Fixture start rejected.', { exact: true }).waitFor();
    await page.evaluate(() => window.a11yFixture.complete());
    await notification(page, node, 'Batch finished.');
    await page.evaluate(() => {
      window.a11yFixture.reject = false;
    });
    await start();
    await page.evaluate(() => {
      for (const r of window.a11yFixture.requests)
        window.a11yFixture.emit({
          ...r,
          status: 'done',
          progress: 100,
          result: { id: r.id, name: r.id + '.csv', size: 100, target: 'csv' },
        });
      window.a11yFixture.complete();
    });
    await notification(page, node, 'Batch finished. Your results are ready.');
    const completedRequests = await page.evaluate(() => window.a11yFixture.requests);
    assert.equal(await page.locator('.queue-bottom .primary-button').isDisabled(), true);
    await nativeMenuAction(page, 'start');
    assert.deepEqual(await page.evaluate(() => window.a11yFixture.requests), completedRequests);
    // Allow the production timeout to clear it; the live region must remain mounted.
    await notification(page, node, '');
    await page.getByRole('button', { name: 'ZIP & Unzip', exact: true }).click();
    await start();
    const archiveMode = page.getByRole('group', { name: 'Archive mode', exact: true });
    assert.equal(await archiveMode.getByRole('button', { pressed: true }).isDisabled(), true);
    assert.equal(await archiveMode.getByRole('button', { pressed: false }).isDisabled(), true);
    assert.deepEqual(
      await page.evaluate(() => window.a11yFixture.requests[0].includeIds),
      ['0', '1', '2', '3'],
    );
    await page.evaluate(() => {
      const r = window.a11yFixture.requests[0];
      window.a11yFixture.emit({ ...r, status: 'error', error: 'Pack failed.' });
      window.a11yFixture.complete();
    });
    await notification(page, node, 'Batch finished. 4 files failed.');
    await start();
    await page.getByRole('button', { name: 'Cancel batch', exact: true }).click();
    await notification(page, node, 'Batch finished. 4 files cancelled.');
    await nativeMenuAction(page, 'formats');
    await currentPage(page, 'All formats');
    // No batch control exists on this page.
    const requests = await page.evaluate(() => window.a11yFixture.requests);
    await nativeMenuAction(page, 'start');
    await nativeMenuAction(page, 'cancel');
    assert.deepEqual(await page.evaluate(() => window.a11yFixture.requests), requests);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    await page.getByRole('dialog', { name: 'JSON files', exact: true }).waitFor();
    for (const action of ['convert', 'compress', 'archive', 'history', 'start', 'cancel'])
      await nativeMenuAction(page, action);
    await currentPage(page, 'All formats');
    assert.deepEqual(await page.evaluate(() => window.a11yFixture.requests), requests);
    await textSizes(page, 'Fixture format dialog', ['.modal-formats b']);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Settings/ }).click();
    await currentPage(page, 'Settings');
    await textSizes(page, 'Fixture mixed engine availability', [
      '.engine-status:not(.unavailable)',
      '.engine-status.unavailable',
      '.engine-row code',
    ]);
    await textContrast(page, ['.engine-status:not(.unavailable)', '.engine-status.unavailable']);
    await page.evaluate(() => {
      window.a11yFixture.native = true;
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Privacy policy', exact: true }).click();
    await page.getByRole('dialog', { name: 'Privacy policy', exact: true }).waitFor();
    await textSizes(page, 'Native privacy dialog', ['.policy-text']);
    await page.keyboard.press('Escape');
    await nativeMenuAction(page, 'convert');
    // These CSS viewports cover the minimum window and the space available at
    // 150% zoom. They do not prove WKWebView pageZoom or native key equivalents.
    for (const viewport of [
      { width: 900, height: 560 },
      { width: 600, height: 373 },
    ]) {
      await page.setViewportSize(viewport);
      await reachableControls(page, 'Narrow queue', [
        '.queue-bottom .primary-button',
        '.output-bar .text-button',
        '.sidebar-bottom .side-button',
      ]);
    }
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await textSizes(page, 'Native sample picker', [
      '.sample-picker select',
      '.sample-picker small',
    ]);
    for (const viewport of [{ width: 900, height: 560 }, { width: 600, height: 373 }]) {
      await page.setViewportSize(viewport);
      await reachableControls(page, 'Narrow native home', [
        '.dropzone .primary-button',
        '.sample-picker select',
        '.sample-picker .secondary-button',
        '.output-bar .text-button',
        '.sidebar-bottom .side-button',
      ]);
      const overflowing = await page.locator('.dropzone').evaluate((el) => {
        const parent = el.getBoundingClientRect();
        return [...el.children].some((child) => {
          const rect = child.getBoundingClientRect();
          return (
            rect.top < parent.top ||
            rect.bottom > parent.bottom ||
            rect.left < parent.left ||
            rect.right > parent.right
          );
        });
      });
      assert.equal(
        overflowing,
        false,
        'Native sample picker overflows at ' + JSON.stringify(viewport),
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}
async function main() {
  await fs.mkdir(path.resolve('.test-output'), { recursive: true });
  root = await fs.mkdtemp(path.resolve('.test-output/flux-bl-023-desktop-'));
  console.log('Desktop evidence:', root);
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.mkdir(path.join(root, 'results'), { recursive: true });
  const engines = await detectEngines(path.resolve('resources'));
  const image = path.join(root, 'Holiday photo.png');
  await sharp({ create: { width: 400, height: 300, channels: 4, background: '#8d74cb' } })
    .png({ compressionLevel: 0 })
    .toFile(image);
  const video = path.join(root, 'Weekend clip.mp4');
  await run(engines.ffmpeg, [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=10',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    video,
  ]);
  await desktopPerformance(root, video);
  const md = path.join(root, 'Project notes.md');
  await fs.writeFile(md, '# Project notes\n\nA real conversion through the desktop interface.');
  const word = path.join(root, 'Project notes.docx');
  await run(engines.pandoc, [md, '-o', word]);
  const pdf = path.join(root, 'Reading list.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of ['Reading list, page 1', 'Reading list, page 2'])
    doc.addPage([300, 200]).drawText(text, { x: 20, y: 90, font, size: 17 });
  await fs.writeFile(pdf, await doc.save({ useObjectStreams: false }));
  const electronApp = await _electron.launch({
    args: ['.'],
    env: { ...process.env, FLUX_TEST_DATA_DIR: path.join(root, 'state') },
  });
  const page = await electronApp.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.waitForSelector('h1');
    await currentPage(page, 'Convert files');
    await textSizes(page, 'Home', ['.dropzone', '.art-file span', '.workspace-footer']);
    await textContrast(page, ['.workspace-footer']);
    const notice = await page.locator('.notification').elementHandle();
    await notification(page, notice, '');
    assert.equal(await page.getByRole('button', { name: 'Convert files', exact: true }).count(), 1);
    const choose = page.getByRole('button', { name: 'Choose files', exact: true });
    await focusContrast(page, choose);
    const options = page.getByRole('button', { name: 'Options', exact: true });
    assert.equal(await options.getAttribute('aria-expanded'), 'false');
    await options.click();
    assert.equal(await options.getAttribute('aria-expanded'), 'true');
    await focusContrast(page, page.getByLabel('Quality / file size'));
    await textSizes(page, 'Options', ['.options-panel label', '.options-panel select']);
    await options.click();
    assert.equal(await options.getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: path.join(root, '01-home.png') });
    await electronApp.evaluate(
      ({ dialog }, paths) => {
        const files = paths.files,
          output = paths.output;
        dialog.showOpenDialog = async (_win, options) => ({
          canceled: false,
          filePaths: options?.title === 'Choose output folder' ? [output] : files,
        });
      },
      { files: [image, video, word, pdf], output: path.join(root, 'results') },
    );
    const initialOutput = (await page.evaluate(() => window.flux.getState())).outputDir;
    await page.getByRole('button', { name: `Save to ${initialOutput}`, exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: `Save to ${path.join(root, 'results')}`, exact: true })
        .count(),
      1,
    );
    await page.getByRole('button', { name: 'Choose files', exact: true }).click();
    await page.getByLabel('Output format for Holiday photo.png').selectOption('jpg');
    await page.getByLabel('Output format for Weekend clip.mp4').selectOption('mkv');
    await page.getByLabel('Output format for Project notes.docx').selectOption('pdf');
    await page.getByLabel('Output format for Reading list.pdf').selectOption('png');
    assert.equal(
      await page.getByRole('button', { name: 'Convert files 4 files', exact: true }).count(),
      1,
    );
    await focusContrast(page, page.getByLabel('Output format for Holiday photo.png'));
    await textSizes(page, 'Conversion queue', [
      '.file-info > span',
      '.queue-toolbar',
      '.queue-bottom',
    ]);
    await actionContrast(page, '.remove-button', 3);
    await page.screenshot({ path: path.join(root, '02-batch.png') });
    // Capture a real running row when it renders, even if it finishes before the next assertion.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[role="progressbar"]');
        if (!el) return;
        window.a11yObservedProgress = {
          min: el.getAttribute('aria-valuemin'),
          max: el.getAttribute('aria-valuemax'),
          now: el.getAttribute('aria-valuenow'),
          name: el.getAttribute('aria-label'),
        };
        observer.disconnect();
      });
      observer.observe(document.querySelector('.queue-rows'), {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
    await page.getByRole('button', { name: /Convert 4 files/ }).click();
    await page.waitForFunction(() => Boolean(window.a11yObservedProgress));
    const observed = await page.evaluate(() => window.a11yObservedProgress);
    checkProgress(observed);
    const progressNames = [
      'Holiday photo.png',
      'Weekend clip.mp4',
      'Project notes.docx',
      'Reading list.pdf',
    ];
    assert.ok(progressNames.some((name) => observed.name === `Progress for ${name}`));
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 4, {
      timeout: 120000,
    });
    await notification(page, notice, 'Batch finished. Your results are ready.');
    let state = await page.evaluate(() => window.flux.getState());
    assert.equal(state.history.length, 4);
    for (const result of state.history) assert.ok((await fs.stat(result.path)).size > 0);
    await textSizes(page, 'Conversion results', ['.row-result', '.result-button']);
    await actionContrast(page, '.result-button');
    await page.screenshot({ path: path.join(root, '03-results.png') });
    await page.getByRole('button', { name: /Compress files/ }).click();
    await currentPage(page, 'Compress files');
    const compression = page.getByRole('group', { name: 'Compression mode', exact: true });
    assert.equal(
      await compression.getByRole('button', { name: /Lossless/, pressed: true }).count(),
      1,
    );
    assert.equal(
      await compression.getByRole('button', { name: /Smaller file/, pressed: false }).count(),
      1,
    );
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await electronApp.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      },
      [image, pdf],
    );
    await page.getByRole('button', { name: 'Choose files', exact: true }).click();
    await page.getByRole('button', { name: /Compress 2 files/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 2, {
      timeout: 120000,
    });
    await textSizes(page, 'Lossless compression', ['.mode-options small', '.row-result']);
    await page.screenshot({ path: path.join(root, '04-lossless.png') });
    await page.getByRole('button', { name: /Smaller file/, pressed: false }).click();
    assert.equal(
      await compression.getByRole('button', { name: /Smaller file/, pressed: true }).count(),
      1,
    );
    assert.equal(
      await compression.getByRole('button', { name: /Lossless/, pressed: false }).count(),
      1,
    );
    await options.click();
    await textSizes(page, 'Smaller file compression', ['.options-panel', '.mode-options small']);
    await options.click();
    await page.getByRole('button', { name: /Compress 2 files/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 2, {
      timeout: 120000,
    });
    state = await page.evaluate(() => window.flux.getState());
    assert.equal(state.history.filter((h) => h.operation === 'compress').length, 4);
    await page.getByRole('button', { name: /ZIP & Unzip/ }).click();
    await currentPage(page, 'ZIP & Unzip');
    const archive = page.getByRole('group', { name: 'Archive mode', exact: true });
    assert.equal(
      await archive.getByRole('button', { name: 'Create ZIP', pressed: true }).count(),
      1,
    );
    assert.equal(
      await archive.getByRole('button', { name: 'Extract archive', pressed: false }).count(),
      1,
    );
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('button', { name: 'Choose files', exact: true }).click();
    await page.locator('.queue-bottom .primary-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 2);
    state = await page.evaluate(() => window.flux.getState());
    const zip = state.history.find((h) => h.operation === 'pack');
    assert.ok(zip);
    await textSizes(page, 'ZIP results', ['.segmented', '.row-result']);
    await page.screenshot({ path: path.join(root, '05-zip.png') });
    await archive.getByRole('button', { name: 'Extract archive', exact: true }).click();
    assert.equal(
      await archive.getByRole('button', { name: 'Extract archive', pressed: true }).count(),
      1,
    );
    assert.equal(
      await archive.getByRole('button', { name: 'Create ZIP', pressed: false }).count(),
      1,
    );
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await electronApp.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
    }, zip.path);
    await page.getByRole('button', { name: 'Choose files', exact: true }).click();
    await page.getByRole('button', { name: 'Extract archives', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 1);
    state = await page.evaluate(() => window.flux.getState());
    const extracted = state.history.find((h) => h.operation === 'extract');
    assert.deepEqual(
      await fs.readFile(path.join(extracted.path, path.basename(image))),
      await fs.readFile(image),
    );
    await page
      .getByRole('button', { name: /All formats/ })
      .first()
      .click();
    await currentPage(page, 'All formats');
    await textSizes(page, 'All formats', ['.format-card', '.format-tags button']);
    const formatCount = state.families.reduce((n, family) => n + family.formats.length, 0);
    assert.equal(
      await page
        .getByRole('button', { name: `All formats ${formatCount} formats`, exact: true })
        .count(),
      1,
    );
    const search = page.getByRole('textbox', { name: 'Search formats', exact: true });
    await focusContrast(page, search, '.format-search');
    await search.fill('png');
    assert.ok((await page.locator('.format-tags button').count()) >= 1);
    const formatTrigger = page.getByRole('button', { name: 'PNG', exact: true });
    await formatTrigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'PNG files' }).waitFor();
    assert.equal(
      await page.getByLabel('Close format details').evaluate((el) => el === document.activeElement),
      true,
    );
    for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(
        await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))),
        true,
      );
    }
    await textSizes(page, 'Format dialog', ['.modal-formats b', '.modal-details']);
    await textContrast(page, [
      '.format-modal > p',
      '.modal-details',
      '.modal-formats > span',
      '.modal-formats b',
    ]);
    await page.keyboard.press('Escape');
    assert.equal(await formatTrigger.evaluate((el) => el === document.activeElement), true);
    await page.getByRole('button', { name: /Settings/ }).click();
    await currentPage(page, 'Settings');
    await textSizes(page, 'Settings', ['.engine-row', '.settings-folder']);
    await textContrast(page, ['.engine-status:not(.unavailable)']);
    await page.screenshot({ path: path.join(root, '06-settings.png') });
    assert.equal(await page.locator('.engine-status.unavailable').count(), 0);
    await page.getByRole('button', { name: /Recent files/ }).click();
    await currentPage(page, 'Recent files');
    assert.equal(
      await page.getByRole('button', { name: 'Recent files 10 files', exact: true }).count(),
      1,
    );
    await textSizes(page, 'Recent files', ['.history-row', '.history-date', '.history-size']);
    await page.screenshot({ path: path.join(root, '07-history.png') });
    assert.equal(await page.locator('.history-row').count(), 10);
    const precise = path.join(root, 'Precise identifiers.json');
    const originalJSON = '[{"id":9007199254740993,"amount":0.1234567890123456789}]';
    await fs.writeFile(precise, originalJSON);
    await page
      .getByRole('button', { name: /Convert files/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, precise);
    await page.getByRole('button', { name: 'Choose files', exact: true }).click();
    await currentPage(page, 'Convert files');
    assert.equal(
      await page.getByRole('button', { name: 'Convert files 1 file', exact: true }).count(),
      1,
    );
    await page.getByLabel('Output format for Precise identifiers.json').selectOption('csv');
    await page.getByRole('button', { name: 'Convert file', exact: true }).click();
    await page
      .getByText(/cannot be converted without losing precision/)
      .first()
      .waitFor();
    await page
      .locator('.row-warning[role="status"]')
      .getByText(/cannot be converted without losing precision/)
      .waitFor();
    await notification(page, notice, 'Batch finished. 1 file failed.');
    assert.equal((await page.evaluate(() => window.flux.getState())).history.length, 10);
    assert.equal(await fs.readFile(precise, 'utf8'), originalJSON);
    const bridge = await page.evaluate(async () => ({
      arbitraryPaths: typeof window.flux.addPaths,
      pathExtraction: typeof window.flux.pathForFile,
      manufacturedFiles: await window.flux.addDroppedFiles([
        new File(['synthetic'], 'virtual.txt'),
      ]),
      files: (await window.flux.getState()).files.length,
    }));
    assert.equal(bridge.arbitraryPaths, 'undefined');
    assert.equal(bridge.pathExtraction, 'undefined');
    assert.deepEqual(bridge.manufacturedFiles, []);
    assert.equal(bridge.files, 1);
    await page.getByRole('button', { name: /ZIP & Unzip/ }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    assert.equal((await page.evaluate(() => window.flux.getState())).files.length, 0);
    assert.deepEqual(errors, []);
    await announcementFixtures(electronApp, page.url());
    console.log(
      'Desktop acceptance passed: batch conversion, lossless/lossy compression, ZIP creation, extraction, format search, settings, and history.',
    );
  } catch (error) {
    console.log(
      'UI ERROR',
      await page
        .locator('.error-banner')
        .innerText()
        .catch(() => 'none'),
    );
    console.log(
      'JOBS',
      await page.evaluate(async () =>
        (await window.flux.getState()).jobs.map((j) => ({
          operation: j.operation,
          status: j.status,
          error: j.error,
        })),
      ),
    );
    await page.screenshot({ path: path.join(root, 'failure.png') });
    throw error;
  } finally {
    await electronApp.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
