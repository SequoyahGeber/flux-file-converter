const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { _electron } = require('playwright');

async function select(electronApp, page, inputs) {
  await electronApp.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, inputs);
  return page.evaluate(() => window.flux.selectFiles());
}
async function release(page) {
  await page.evaluate(async () => {
    const state = await window.flux.getState();
    await window.flux.releaseFiles(state.files.map((file) => file.id));
  });
}
async function reset(electronApp) {
  await electronApp.evaluate(() => {
    const metrics = globalThis.__fluxPerformance;
    for (const key of Object.keys(metrics)) if (key !== 'recording') metrics[key] = 0;
    metrics.recording = true;
  });
}
async function snapshot(electronApp) {
  return electronApp.evaluate(() => {
    globalThis.__fluxPerformance.recording = false;
    return { ...globalThis.__fluxPerformance };
  });
}
async function desktopPerformance(root, video) {
  const clips = [];
  for (let i = 0; i < 50; i++) {
    const clip = path.join(root, 'performance-clip-' + String(i).padStart(2, '0') + '.mp4');
    await fs.copyFile(video, clip);
    clips.push(clip);
  }
  const report = {
    workload: '50 identical synthetic MP4 clips; full warm-up per mode; real add-paths IPC',
    baseline: 'Same source with one worker (serial reference, not a historical binary)',
    inspection: {},
  };
  for (const mode of ['serial', 'parallel']) {
    const stateDir = path.join(root, 'performance-state-' + mode);
    await fs.mkdir(stateDir);
    const electronApp = await _electron.launch({
      args: [path.resolve(__dirname, 'desktop-performance-main.cjs')],
      env: {
        ...process.env,
        FLUX_TEST_DATA_DIR: stateDir,
        FLUX_TEST_SERIAL_INSPECTION: mode === 'serial' ? '1' : '0',
      },
    });
    try {
      const page = await electronApp.firstWindow();
      await page.waitForSelector('h1');
      await select(electronApp, page, clips);
      await release(page);
      await reset(electronApp);
      const before = performance.now();
      const files = await select(electronApp, page, clips);
      const milliseconds = performance.now() - before;
      const metrics = await snapshot(electronApp);
      assert.deepEqual(files.map((file) => file.path), clips);
      assert.ok(files.every((file) => file.family === 'video' && !file.warning));
      assert.equal(metrics.inspections, 50);
      assert.equal(metrics.probes, 50, 'parallelism does not add probes');
      assert.equal(metrics.activeInspections, 0);
      assert.equal(metrics.peakInspections, mode === 'serial' ? 1 : 3);
      assert.ok(metrics.peakProbes <= (mode === 'serial' ? 1 : 3));
      report.inspection[mode] = { milliseconds, ...metrics };
      if (mode === 'parallel') {
        await release(page);
        const inputs = [];
        for (let i = 0; i < 50; i++) {
          const input = path.join(root, 'performance-data-' + i + '.json');
          await fs.writeFile(input, JSON.stringify([{ index: i, value: 'synthetic' }]));
          inputs.push(input);
        }
        const added = await select(electronApp, page, inputs);
        const output = path.join(root, 'performance-results');
        await fs.mkdir(output);
        await electronApp.evaluate(({ dialog }, folder) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
        }, output);
        await page.evaluate(() => window.flux.selectOutput());
        await page.evaluate(() => window.flux.clearHistory());
        await reset(electronApp);
        const batchStart = performance.now();
        await page.evaluate(
          (records) =>
            window.flux.start(records.map((file) => ({ id: file.id, target: 'yaml' }))),
          added,
        );
        await page.waitForFunction(async () => !(await window.flux.getState()).running);
        const batchMilliseconds = performance.now() - batchStart;
        const batch = await snapshot(electronApp);
        const state = await page.evaluate(() => window.flux.getState());
        assert.ok(state.jobs.every((job) => job.status === 'done'));
        assert.equal(state.history.length, 50);
        assert.ok(
          batch.renames >= 1 && batch.renames <= 2,
          'short batch uses one or two state renames instead of 50: ' + JSON.stringify(batch),
        );
        const disk = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
        assert.deepEqual(disk.history, state.history, 'batch completion includes durable history');
        for (const result of state.history) assert.ok((await fs.stat(result.path)).size > 0);
        report.persistence = {
          workload: '50 real JSON-to-YAML conversions; setup/clear-history saves excluded',
          milliseconds: batchMilliseconds,
          perJobBaselineRenames: 50,
          actualRenames: batch.renames,
          finalHistoryEntries: disk.history.length,
        };
      }
    } finally {
      await electronApp.close();
    }
  }
  report.parallelToSerialRatio =
    report.inspection.parallel.milliseconds / report.inspection.serial.milliseconds;
  await fs.writeFile(path.join(root, 'performance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('FLUX-BL-023 desktop performance:', JSON.stringify(report));
  return report;
}
module.exports = { desktopPerformance };
