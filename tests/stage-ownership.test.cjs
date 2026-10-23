const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStage, sweepStages } = require('../electron/engine.cjs');

const MARKER = '.flux-stage-owner';
const STAGE = /^\.flux-[A-Za-z0-9]{6}$/;

async function withTemp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-stage-test-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
async function unmarkedStage(root, name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'keep.txt'), 'user data');
  return dir;
}

test('createStage makes a .flux-XXXXXX directory with a valid ownership marker', async () => {
  await withTemp(async (root) => {
    const dir = await createStage(root);
    assert.equal(path.dirname(dir), root);
    assert.match(path.basename(dir), STAGE);
    assert.ok((await fs.lstat(dir)).isDirectory());
    const markerPath = path.join(dir, MARKER);
    assert.ok((await fs.lstat(markerPath)).isFile());
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    assert.equal(marker.app, 'flux');
    assert.equal(marker.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(marker.created)));
  });
});

test('sweepStages removes a marked stage and its contents', async () => {
  await withTemp(async (root) => {
    const dir = await createStage(root);
    await fs.mkdir(path.join(dir, 'work'));
    await fs.writeFile(path.join(dir, 'work', 'partial.bin'), 'partial');
    await sweepStages(root);
    assert.equal(await exists(dir), false);
  });
});

test('sweepStages preserves unmarked look-alikes, ordinary directories and files', async () => {
  await withTemp(async (root) => {
    const legacy = await unmarkedStage(root, '.flux-A1b2C3');
    const backup = await unmarkedStage(root, '.flux-backup');
    const ordinary = await unmarkedStage(root, 'Photos');
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'source');
    const marked = await createStage(root);
    await sweepStages(root);
    assert.equal(await exists(marked), false);
    for (const dir of [legacy, backup, ordinary])
      assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(await fs.readFile(source, 'utf8'), 'source');
  });
});

test('sweepStages never follows or removes a stage-named symlink', async () => {
  await withTemp(async (root) => {
    const output = path.join(root, 'out');
    const target = path.join(root, 'target');
    await fs.mkdir(output);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, MARKER), JSON.stringify({ app: 'flux' }));
    await fs.writeFile(path.join(target, 'keep.txt'), 'user data');
    const link = path.join(output, '.flux-Lnk123');
    await fs.symlink(target, link);
    await sweepStages(output);
    assert.ok((await fs.lstat(link)).isSymbolicLink());
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'user data');
    assert.ok(await exists(path.join(target, MARKER)));
  });
});

test('sweepStages preserves stages whose marker is not a valid flux marker', async () => {
  await withTemp(async (root) => {
    const cases = {
      '.flux-Dir001': async (m) => fs.mkdir(m),
      '.flux-Emp002': async (m) => fs.writeFile(m, ''),
      '.flux-Bad003': async (m) => fs.writeFile(m, '{not json'),
      '.flux-App004': async (m) => fs.writeFile(m, JSON.stringify({ app: 'other' })),
      '.flux-Nul005': async (m) => fs.writeFile(m, 'null'),
      '.flux-Lst006': async (m) => fs.writeFile(m, JSON.stringify(['flux'])),
    };
    const dirs = [];
    for (const [name, write] of Object.entries(cases)) {
      const dir = await unmarkedStage(root, name);
      await write(path.join(dir, MARKER));
      dirs.push(dir);
    }
    await sweepStages(root);
    for (const dir of dirs)
      assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'user data', dir);
  });
});

test('sweepStages tolerates a missing output folder', async () => {
  await withTemp(async (root) => {
    await sweepStages(path.join(root, 'does-not-exist'));
  });
});

test('source guard: every stage is created through createStage', async () => {
  const dir = path.join(__dirname, '..', 'electron');
  const direct = /mkdtemp\(\s*path\.join\(\s*outputDir\s*,\s*['"]\.flux-['"]\s*\)\s*\)/g;
  const engine = await fs.readFile(path.join(dir, 'engine.cjs'), 'utf8');
  const start = engine.indexOf('async function createStage(');
  assert.ok(start >= 0, 'engine.cjs defines createStage');
  const end = engine.indexOf('\nasync function ', start + 1);
  const body = engine.slice(start, end);
  const outside = engine.slice(0, start) + engine.slice(end);
  assert.equal(body.match(direct)?.length, 1);
  assert.equal(outside.match(direct), null);
  assert.match(outside, /await createStage\(outputDir\)/);
  for (const name of ['compression.cjs', 'archives.cjs']) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    assert.equal(text.match(direct), null, `${name} must not call mkdtemp directly`);
    assert.match(text, /await createStage\(outputDir\)/, `${name} uses createStage`);
  }
});
