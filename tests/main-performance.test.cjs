const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMainHarness, deferred, settle } = require('./fixtures/main-harness.cjs');

const source = (input, warning = '') => ({
  path: input,
  name: path.basename(input),
  ext: 'png',
  family: 'image',
  size: 10,
  targets: ['jpg'],
  warning,
});
const product = (file) => ({
  path: '/flux-test/results/' + file.name,
  name: file.name,
  size: 5,
  completedAt: 1,
});
async function add(harness, count) {
  return harness.invoke('add-paths', Array.from({ length: count }, (_, i) => '/input/' + i));
}
async function start(harness, files) {
  await harness.invoke('start-jobs', files.map((file) => ({ id: file.id, target: 'jpg' })));
}
async function complete(harness) {
  for (let i = 0; i < 1000 && harness.state().running; i++) await settle();
  assert.equal(harness.state().running, false, 'batch completes without hanging');
}
function finalHistory(harness, count) {
  assert.equal(harness.writes.at(-1).state.history.length, count);
  assert.equal(harness.timers.size, 0, 'no stale history timer');
}

test('inspection bounds workers and preserves order, IDs and per-file failures', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const entered = [];
  let active = 0,
    peak = 0;
  const h = await createMainHarness({
    async inspectFile(input) {
      const index = Number(path.basename(input));
      entered.push(index);
      peak = Math.max(peak, ++active);
      try {
        await gates[index].promise;
        return source(input, index === 3 ? 'decode warning' : '');
      } finally {
        active--;
      }
    },
  });
  const adding = h.invoke('add-paths', [
    '/input/0',
    '/input/1',
    '/input/2',
    '/input/3',
    '/input/4',
    '/input/folder',
    '/input/1',
  ]);
  await settle();
  assert.deepEqual(entered, [0, 1, 2]);
  await assert.rejects(h.invoke('add-paths', []), /inspection/);
  await assert.rejects(h.invoke('start-jobs', []), /batch or file selection/);
  await assert.rejects(h.invoke('release-files', []), /batch before removing/);
  await assert.rejects(h.invoke('select-files'), /batch or file selection/);
  gates[2].resolve();
  await settle();
  assert.deepEqual(entered, [0, 1, 2, 3]);
  gates[1].reject(new Error('synthetic failure'));
  await settle();
  gates[4].resolve();
  gates[3].resolve();
  await settle();
  // The guard remains active until the last worker drains.
  await assert.rejects(h.invoke('add-paths', []), /inspection/);
  gates[0].resolve();
  const result = await adding;
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(result.map((file) => file.path), [
    '/input/0',
    '/input/1',
    '/input/2',
    '/input/3',
    '/input/4',
    '/input/folder',
  ]);
  assert.match(result[1].warning, /synthetic failure/);
  assert.equal(result[1].family, 'unsupported');
  assert.equal(result[5].family, 'folder');
  assert.deepEqual(result[5].compressionOptions, []);
  assert.deepEqual(result[3].compressionOptions, [{ id: 'archive' }]);
  assert.match(result[0].notes.jpg, /Transparency/);
  assert.deepEqual(h.state().files.map((file) => file.path), [
    '/input/0',
    '/input/2',
    '/input/3',
    '/input/4',
    '/input/folder',
  ]);
  assert.equal((await h.invoke('add-paths', ['/input/0', '/input/0']))[0].id, result[0].id);
  assert.equal(entered.length, 5, 'existing paths are not inspected again');
  assert.deepEqual(await h.invoke('add-paths', []), []);
});

test('inspection validates paths and rechecks capacity before insertion', async () => {
  const gate = deferred();
  const h = await createMainHarness({
    inspectFile: async (input) => {
      await gate.promise;
      return source(input);
    },
  });
  await assert.rejects(h.invoke('add-paths', ['relative']), /300 files/);
  await assert.rejects(h.invoke('add-paths', Array(301).fill('/input/a')), /300 files/);
  h.evaluate(`for (let i = 0; i < 299; i++) {
    files.set('old-' + i, { id: 'old-' + i, path: '/old/' + i });
    filesByPath.set('/old/' + i, 'old-' + i);
  }`);
  await assert.rejects(h.invoke('add-paths', ['/input/a', '/input/b']), /Remove files/);
  const adding = h.invoke('add-paths', ['/input/a']);
  await settle();
  h.evaluate("files.set('concurrent', { id: 'concurrent', path: '/other' })");
  gate.resolve();
  const result = await adding;
  assert.match(result[0].warning, /Remove files/);
  assert.equal(h.state().files.length, 300);
});

test('a fast batch saves once, retains the history cap and preserves durable JSON', async () => {
  const h = await createMainHarness();
  const files = await add(h, 150);
  await start(h, files);
  await complete(h);
  assert.equal(h.writes.length, 1, 'one batch rename instead of one per job');
  finalHistory(h, 100);
  assert.ok(h.state().jobs.every((job) => job.status === 'done'));
  assert.deepEqual(h.actions, ['open', 'write', 'sync', 'close', 'chmod', 'rename']);
  assert.match(h.writes[0].text, /\n  "outputDir":/);
  assert.equal(h.messages.at(-1).data.batchComplete, true);
});

test('an early result is saved while the next job is slow; periodic saves are spaced', async () => {
  const slow = deferred();
  const h = await createMainHarness({
    convert: async (file) => {
      if (file.name === '1') await slow.promise;
      return product(file);
    },
  });
  await start(h, await add(h, 2));
  await settle();
  assert.equal(h.state().history.length, 1);
  await h.advance(1999);
  assert.equal(h.writes.length, 0);
  await h.advance(1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.state().running, true);
  finalHistory(h, 1);
  await h.advance(6000);
  assert.equal(h.writes.length, 1, 'clean history does not save repeatedly');
  slow.resolve();
  await complete(h);
  assert.equal(h.writes.length, 2);
  finalHistory(h, 2);
});

test('changes arriving during a save remain dirty and explicit saves serialize', async () => {
  const second = deferred(),
    third = deferred(),
    rename = deferred();
  let block = true;
  const h = await createMainHarness({
    hooks: {
      rename: async () => {
        if (block) await rename.promise;
      },
    },
    convert: async (file) => {
      if (file.name === '1') await second.promise;
      if (file.name === '2') await third.promise;
      return product(file);
    },
  });
  await start(h, await add(h, 3));
  await settle();
  await h.advance(2000);
  assert.equal(h.writes.length, 0);
  second.resolve();
  await settle();
  assert.equal(h.state().history.length, 2);
  block = false;
  rename.resolve();
  await settle();
  assert.equal(h.writes[0].state.history.length, 1);
  await h.advance(1999);
  assert.equal(h.writes.length, 1);
  await h.advance(1);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].at - h.writes[0].at, 2000);
  assert.equal(h.writes[1].state.history.length, 2);
  await h.invoke('clear-history');
  assert.equal(h.writes.at(-1).state.history.length, 0, 'explicit history clear saves immediately');
  third.resolve();
  await complete(h);
  finalHistory(h, 1);
  for (let i = 0; i < h.actions.length; i += 6)
    assert.deepEqual(h.actions.slice(i, i + 6), [
      'open',
      'write',
      'sync',
      'close',
      'chmod',
      'rename',
    ]);
});

test('failed history saves preserve success and retry', async () => {
  const slow = deferred();
  let failing = true,
    attempts = 0;
  const h = await createMainHarness({
    hooks: {
      rename: async () => {
        attempts++;
        if (failing) throw Object.assign(new Error('full disk'), { code: 'ENOSPC' });
      },
    },
    convert: async (file) => {
      if (file.name === '1') await slow.promise;
      return product(file);
    },
  });
  const files = await add(h, 2);
  await start(h, files);
  await settle();
  await h.advance(2000);
  assert.equal(attempts, 1);
  assert.equal(h.state().jobs[0].status, 'done');
  failing = false;
  await h.advance(2000);
  assert.equal(h.writes.length, 1, 'failed periodic save remains eligible for retry');
  failing = true;
  slow.resolve();
  await complete(h);
  assert.ok(h.state().jobs.every((job) => job.status === 'done'));
  assert.equal(h.timers.size, 0);
  failing = false;
  await start(h, [files[0]]);
  await complete(h);
  finalHistory(h, 3);
});

test('final save precedes batch completion and deferred quit', async () => {
  const finalWrite = deferred();
  const slow = deferred();
  let secondStarted = false;
  const h = await createMainHarness({
    hooks: { rename: () => finalWrite.promise },
    convert: async (file, _target, _dest, _opts, _engines, _resources, { signal }) => {
      if (file.name === '1') {
        secondStarted = true;
        await slow.promise;
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      }
      return product(file);
    },
  });
  await start(h, await add(h, 3));
  await settle();
  assert.equal(secondStarted, true);
  await assert.rejects(h.invoke('add-paths', []), /current batch/);
  await assert.rejects(h.invoke('release-files', []), /batch before removing/);
  h.app.quit();
  assert.equal(h.quits, 0);
  slow.resolve();
  await settle();
  assert.equal(h.state().running, true);
  assert.equal(h.messages.some((message) => message.data.batchComplete), false);
  assert.equal(h.quits, 0);
  finalWrite.resolve();
  await complete(h);
  assert.deepEqual(h.state().jobs.map((job) => job.status), ['done', 'cancelled', 'cancelled']);
  finalHistory(h, 1);
  assert.equal(h.quits, 1);
  assert.equal(h.released, 1);
  assert.equal(h.messages.at(-1).data.batchComplete, true);
});

test('cancel and a stage sweep failure both drain through the final save', async () => {
  const gate = deferred();
  const h = await createMainHarness({
    convert: async (file) => {
      await gate.promise;
      return product(file);
    },
  });
  await start(h, await add(h, 2));
  await settle();
  await h.invoke('cancel-jobs');
  gate.resolve();
  await complete(h);
  assert.deepEqual(h.state().jobs.map((job) => job.status), ['done', 'cancelled']);
  finalHistory(h, 1);
  const broken = await createMainHarness({
    sweepStages: async () => {
      throw new Error('sweep failed');
    },
  });
  await start(broken, await add(broken, 2));
  await complete(broken);
  assert.ok(broken.state().jobs.every((job) => job.status === 'error'));
  finalHistory(broken, 0);
});
