const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve('.test-output/packaged');
(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const app = await _electron.launch({
    executablePath: path.resolve('release/Flux.app/Contents/MacOS/Flux'),
    env: { ...process.env, FLUX_TEST_DATA_DIR: path.join(root, 'state') },
  });
  const page = await app.firstWindow();
  try {
    await page.waitForSelector('h1');
    const state = await page.evaluate(() => window.flux.getState());
    assert.ok(state.enginePaths.office.includes('Flux.app/Contents/Resources/libreoffice'));
    assert.ok(state.enginePaths.python.includes('Flux.app/Contents/Resources/python-runtime'));
    const isPackaged = await app.evaluate(({ app }) => app.isPackaged);
    assert.equal(isPackaged, true);
    const modules = path.resolve('release/Flux.app/Contents/Resources/app/node_modules');
    for (const name of ['electron', 'prettier', 'jose', 'react', 'react-dom', 'lucide-react'])
      await assert.rejects(fs.access(path.join(modules, name)), { code: 'ENOENT' });
    await app.evaluate(
      ({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      },
      path.join(root, 'results'),
    );
    await page.locator('.output-location button').click();
    const word = path.resolve('.test-output/desktop/Project notes.docx');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, word);
    await page.getByRole('button', { name: /Choose files/ }).click();
    await page.getByLabel('Output format for Project notes.docx').selectOption('pdf');
    await page.locator('.queue-bottom .primary-button').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.result-button').length === 1,
      null,
      { timeout: 60000 },
    );
    let results = (await page.evaluate(() => window.flux.getState())).history;
    const pdf = results[0].path;
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, pdf);
    await page.getByRole('button', { name: /Choose files/ }).click();
    await page.getByLabel(`Output format for ${path.basename(pdf)}`).selectOption('docx');
    await page.locator('.queue-bottom .primary-button').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.result-button').length === 1,
      null,
      { timeout: 60000 },
    );
    results = (await page.evaluate(() => window.flux.getState())).history;
    assert.ok(results.some((r) => r.target === 'pdf'));
    assert.ok(results.some((r) => r.target === 'docx'));
    assert.ok((await fs.stat(results[0].path)).size > 0);
    await page.screenshot({ path: path.join(root, 'acceptance.png') });
    console.log(
      'Packaged Mac app passed: relocated Office engine, relocated Python runtime, DOCX → PDF → DOCX through the desktop UI.',
    );
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
