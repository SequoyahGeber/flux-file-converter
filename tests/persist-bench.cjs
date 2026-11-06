// Reports the unchanged production write/sync/close/chmod/rename cost and
// the reduced write count. No fragile timing threshold; uses synthetic history.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createMainHarness, settle } = require('./fixtures/main-harness.cjs');

async function main() {
  const parent = path.resolve('.test-output');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'flux-bl-023-persist-'));
  let renames = 0;
  const result = (i) => ({
    id: 'history-' + i,
    path: path.join(root, 'synthetic-result-' + i + '.jpg'),
    name: 'Synthetic result ' + i + '.jpg',
    sourceName: 'Synthetic source ' + i + '.png',
    sourceFamily: 'image',
    size: 12345,
    originalSize: 23456,
    target: 'jpg',
    completedAt: 1,
  });
  const h = await createMainHarness({
    userDataDir: root,
    fs: {
      open: fs.open,
      chmod: fs.chmod,
      async rename(from, to) {
        await fs.rename(from, to);
        renames++;
      },
    },
    convert: async (file) => result(file.name),
  });
  h.evaluate('history = ' + JSON.stringify(Array.from({ length: 100 }, (_, i) => result(i))));
  // Warm up the exact production persist function through its serialized chain.
  await h.evaluate('save()');
  renames = 0;
  const samples = 100;
  const before = performance.now();
  for (let i = 0; i < samples; i++) await h.evaluate('save()');
  const durableMilliseconds = performance.now() - before;
  assert.equal(renames, samples);
  const bytes = (await fs.stat(path.join(root, 'state.json'))).size;
  const inputs = Array.from({ length: 300 }, (_, i) => '/synthetic/' + i);
  const files = await h.invoke('add-paths', inputs);
  renames = 0;
  const batchStart = performance.now();
  await h.invoke(
    'start-jobs',
    files.map((file) => ({ id: file.id, target: 'jpg' })),
  );
  // Yield to real fs I/O, while keeping synthetic batch timers deterministic.
  const deadline = performance.now() + 10000;
  while (h.state().running && performance.now() < deadline) {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(h.state().running, false);
  assert.equal(renames, 1, 'a fast synthetic batch makes one final durable save');
  const batchMilliseconds = performance.now() - batchStart;
  const saved = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  assert.equal(saved.history.length, 100);
  const report = {
    workload: '100 history entries; pretty JSON; production persist through real filesystem',
    durableSaveSamples: samples,
    durableSaveBytes: bytes,
    durableSaveMilliseconds: durableMilliseconds / samples,
    batchJobs: 300,
    perJobBaselineRenames: 300,
    coalescedRenames: renames,
    batchMilliseconds,
    estimatedPerJobPersistenceMilliseconds: (durableMilliseconds / samples) * 300,
    finalHistoryEntries: saved.history.length,
    note: 'Synthetic jobs/timers isolate persistence; desktop proof uses real jobs/timers.',
  };
  await fs.writeFile(path.join(root, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, ...report }, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
