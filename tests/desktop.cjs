const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { detectEngines, run } = require('../electron/engine.cjs');
const root = path.resolve('.test-output/desktop');
async function main() {
  await fs.rm(root, { recursive: true, force: true });
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
    await page.locator('.output-location button').click();
    await page.getByRole('button', { name: /Choose files/ }).click();
    await page.getByLabel('Output format for Holiday photo.png').selectOption('jpg');
    await page.getByLabel('Output format for Weekend clip.mp4').selectOption('mkv');
    await page.getByLabel('Output format for Project notes.docx').selectOption('pdf');
    await page.getByLabel('Output format for Reading list.pdf').selectOption('png');
    await page.screenshot({ path: path.join(root, '02-batch.png') });
    await page.getByRole('button', { name: /Convert 4 files/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 4, {
      timeout: 120000,
    });
    let state = await page.evaluate(() => window.flux.getState());
    assert.equal(state.history.length, 4);
    for (const result of state.history) assert.ok((await fs.stat(result.path)).size > 0);
    await page.screenshot({ path: path.join(root, '03-results.png') });
    await page.getByRole('button', { name: /Compress files/ }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await electronApp.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      },
      [image, pdf],
    );
    await page.getByRole('button', { name: /Choose files/ }).click();
    await page.getByRole('button', { name: /Compress 2 files/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 2, {
      timeout: 120000,
    });
    await page.screenshot({ path: path.join(root, '04-lossless.png') });
    await page.getByRole('button', { name: /Smaller file/ }).click();
    await page.getByRole('button', { name: /Compress 2 files/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 2, {
      timeout: 120000,
    });
    state = await page.evaluate(() => window.flux.getState());
    assert.equal(state.history.filter((h) => h.operation === 'compress').length, 4);
    await page.getByRole('button', { name: /ZIP & Unzip/ }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('button', { name: /Choose files/ }).click();
    await page.locator('.queue-bottom .primary-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.result-button').length === 2);
    state = await page.evaluate(() => window.flux.getState());
    const zip = state.history.find((h) => h.operation === 'pack');
    assert.ok(zip);
    await page.screenshot({ path: path.join(root, '05-zip.png') });
    await page.getByRole('button', { name: 'Extract archive', exact: true }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await electronApp.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
    }, zip.path);
    await page.getByRole('button', { name: /Choose files/ }).click();
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
    await page.getByPlaceholder('Search a format or category…').fill('png');
    assert.ok((await page.locator('.format-tags button').count()) >= 1);
    await page.getByRole('button', { name: 'PNG', exact: true }).click();
    await page.getByLabel('Close format details').click();
    await page.getByRole('button', { name: /Settings/ }).click();
    await page.screenshot({ path: path.join(root, '06-settings.png') });
    assert.equal(await page.locator('.engine-status.unavailable').count(), 0);
    await page.getByRole('button', { name: /Recent files/ }).click();
    await page.screenshot({ path: path.join(root, '07-history.png') });
    assert.equal(await page.locator('.history-row').count(), 10);
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
