// A full disk or a killed worker must never leave a partial result at a visible name, and
// must never touch the source or files that were already in the output folder. These tests
// use real tiny disk images (macOS hdiutil): HFS+ supports hard links, ExFAT does not, so it
// exercises publish()'s fallback. They skip, with a reason, where hdiutil is unavailable.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const engine = require('../electron/engine.cjs');
const { productBytes } = require('./fixtures/publish-child.cjs');

const resources = path.resolve(__dirname, '..', 'resources');
const child = path.join(__dirname, 'fixtures', 'publish-child.cjs');
const STAGE = /^\.flux-[A-Za-z0-9]{6}$/;
const MB = 1024 * 1024;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = async (file) => sha256(await fs.readFile(file));
const pad = (n) => String(n).padStart(7, '0');
// ExFAT keeps extended attributes in "._name" companions; they are not results.
const listing = async (dir) => (await fs.readdir(dir)).filter((n) => !n.startsWith('._')).sort();
const free = async (where) => {
  const info = await fs.statfs(where);
  return info.bavail * info.bsize;
};
const tool = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 60000 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );

async function hostScratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-disk-full-src-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Creates a small disk image and mounts it; returns the mount point, or null after
// t.skip() when this host cannot do that. Callers must return when it is null.
async function diskImage(t, format, megabytes) {
  if (process.platform !== 'darwin') return t.skip('Disk images need macOS hdiutil.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-disk-full-img-'));
  const mount = path.join(dir, 'mnt');
  const mountedApart = async () => {
    try {
      return (await fs.stat(mount)).dev !== (await fs.stat(dir)).dev;
    } catch {
      return false;
    }
  };
  // Always tried, even when attach failed part way. The scratch folder is only removed once
  // the volume is gone, so a stuck mount is never deleted through its mount point.
  t.after(async () => {
    for (let attempt = 0; attempt < 3 && (await mountedApart()); attempt++) {
      await tool('hdiutil', ['detach', '-force', mount]).catch(() => {});
      if (await mountedApart()) await new Promise((r) => setTimeout(r, 500));
    }
    if (await mountedApart()) console.error(`Could not detach ${mount}; left in place.`);
    else await fs.rm(dir, { recursive: true, force: true });
  });
  try {
    const image = path.join(dir, 'volume.dmg');
    await tool('hdiutil', [
      'create',
      '-size',
      `${megabytes}m`,
      '-fs',
      format,
      '-volname',
      'FLUXTEST',
      image,
    ]);
    await fs.mkdir(mount);
    await tool('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, image]);
  } catch (e) {
    return t.skip(`Could not create or attach a ${format} disk image: ${e.stderr || e.message}`);
  }
  // Never write to the host's own disk: the mount must be a different volume, and small.
  assert.ok(await mountedApart(), 'the disk image is mounted on its own volume');
  const room = await free(mount);
  assert.ok(room <= megabytes * MB, 'the mounted volume is no larger than the image');
  return mount;
}

// Leaves roughly `leave` bytes free on the volume holding `file`.
async function fillExcept(file, leave) {
  const root = path.dirname(file);
  const limit = (await free(root)) + MB;
  const handle = await fs.open(file, 'wx');
  const chunk = Buffer.alloc(64 * 1024, 0x5a);
  let written = 0;
  try {
    for (;;) {
      const room = (await free(root)) - leave;
      if (room <= 0) break;
      assert.ok(written <= limit, 'the filler never exceeds the volume size');
      const { bytesWritten } = await handle.write(chunk, 0, Math.min(chunk.length, room));
      written += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function supportsHardLinks(dir) {
  const a = path.join(dir, 'link-probe-a');
  const b = path.join(dir, 'link-probe-b');
  await fs.writeFile(a, 'x');
  try {
    await fs.link(a, b);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(a, { force: true });
    await fs.rm(b, { force: true });
  }
}

async function state(file) {
  const info = await fs.stat(file);
  return { sha: await hashFile(file), mtimeMs: info.mtimeMs, size: info.size };
}

async function csvSource(dir, rows) {
  const file = path.join(dir, 'records.csv');
  const lines = ['id,name,value'];
  for (let i = 0; i < rows; i++) {
    lines.push(`${pad(i)},name-${pad(i)}-${'x'.repeat(60)},${pad(i * 7)}`);
  }
  await fs.writeFile(file, lines.join('\n') + '\n');
  return file;
}
// The JSON size is linear in the row count, so measure a small sample on the host.
async function rowsForJsonBytes(dir, bytes) {
  const sample = await csvSource(dir, 1000);
  const json = path.join(dir, 'sample.json');
  await engine.structured({ path: sample, ext: 'csv' }, 'json', json);
  const perRow = (await fs.stat(json)).size / 1000;
  await fs.rm(json);
  await fs.rm(sample);
  return Math.floor(bytes / perRow);
}
let detected;
async function convertCsv(file, outputDir) {
  detected ||= await engine.detectEngines(resources);
  const info = await engine.inspectFile(file, detected, resources);
  return engine.convert(info, 'json', outputDir, {}, detected, resources);
}

// Every visible file is absent or exactly the product. Only the empty name reservation of a
// publish interrupted without hard links may be zero-length, and only when allowed.
async function assertNoPartialResult(dir, productSha, { allowEmpty, keep = [] }) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    // Hidden stages are checked by sweepStages; ExFAT may add AppleDouble companions.
    const hidden = STAGE.test(entry.name) || entry.name.startsWith('._');
    if (hidden || keep.includes(entry.name)) continue;
    assert.ok(entry.isFile(), `${entry.name} is a file`);
    const data = await fs.readFile(path.join(dir, entry.name));
    if (!data.length) {
      assert.ok(allowEmpty, `${entry.name} is an empty placeholder`);
      continue;
    }
    assert.equal(sha256(data), productSha, `${entry.name} is a partial or corrupt result`);
  }
}
async function assertSweepIsClean(dir, productSha, options) {
  await assertNoPartialResult(dir, productSha, options);
  const visible = (names) => names.filter((n) => !STAGE.test(n) && !n.startsWith('._')).sort();
  const before = visible(await fs.readdir(dir));
  await engine.sweepStages(dir);
  const after = await fs.readdir(dir);
  assert.deepEqual(
    after.filter((n) => n.startsWith('.flux-')),
    [],
    'no marked stage remains after the launch sweep',
  );
  assert.deepEqual(visible(after), before, 'the sweep keeps every visible entry');
  await assertNoPartialResult(dir, productSha, options);
  for (const name of options.keep || [])
    assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), 'precious user file');
}

// Runs publish-child.cjs and kills it with SIGKILL `delay` ms after it prints `line`.
function killChild(outputDir, bytes, hook, line, delay = 0) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [child, outputDir, String(bytes), hook], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let sent = false;
    const watchdog = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`publish child hung before "${line}".\nstdout: ${out}\nstderr: ${err}`));
    }, 30000);
    proc.stdout.on('data', (data) => {
      out += data;
      if (!sent && out.includes(`${line}\n`)) {
        sent = true;
        if (delay) setTimeout(() => proc.kill('SIGKILL'), delay);
        else proc.kill('SIGKILL');
      }
    });
    proc.stderr.on('data', (data) => (err += data));
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, out, err });
    });
  });
}

test('a full disk while writing the stage publishes nothing and leaves every file alone', async (t) => {
  const mount = await diskImage(t, 'HFS+', 8);
  if (!mount) return;
  const outputDir = path.join(mount, 'out');
  await fs.mkdir(outputDir);
  await fs.writeFile(path.join(outputDir, 'keep.txt'), 'precious user file');
  const filler = path.join(mount, 'filler.bin');
  await fillExcept(filler, 64 * 1024);
  const left = await free(mount);
  assert.ok(left < 256 * 1024, `the volume is nearly full (${left} bytes free)`);

  const src = await hostScratch(t);
  const source = await csvSource(src, 20000);
  assert.ok((await state(source)).size > 0);
  const json = path.join(src, 'expected.json');
  await engine.structured({ path: source, ext: 'csv' }, 'json', json);
  assert.ok((await fs.stat(json)).size > left * 4, 'the output cannot fit in the free space');
  const before = {
    source: await state(source),
    filler: await state(filler),
    keep: await state(path.join(outputDir, 'keep.txt')),
    listing: await fs.readdir(outputDir),
  };

  await assert.rejects(convertCsv(source, outputDir), (e) => {
    assert.match(`${e.code} ${e.message}`, /ENOSPC|space/i);
    return true;
  });

  assert.deepEqual(await fs.readdir(outputDir), before.listing, 'no new entry, no stage');
  assert.deepEqual(await state(source), before.source);
  assert.deepEqual(await state(filler), before.filler);
  assert.deepEqual(await state(path.join(outputDir, 'keep.txt')), before.keep);
});

test('publishing by rename fits where a second copy would not', async (t) => {
  const mount = await diskImage(t, 'ExFAT', 16);
  if (!mount) return;
  if (await supportsHardLinks(mount)) return t.skip('This volume supports hard links.');
  const outputDir = path.join(mount, 'out');
  await fs.mkdir(outputDir);
  await fs.writeFile(path.join(outputDir, 'keep.txt'), 'precious user file');
  const room = await free(outputDir);
  const src = await hostScratch(t);

  // Through convert(): the product is more than half of the free space.
  const source = await csvSource(src, await rowsForJsonBytes(src, Math.floor(room * 0.6)));
  const expected = path.join(src, 'expected.json');
  await engine.structured({ path: source, ext: 'csv' }, 'json', expected);
  const size = (await fs.stat(expected)).size;
  assert.ok(size * 2 > room, 'two copies of the product would not fit');
  const sourceBefore = await state(source);
  const result = await convertCsv(source, outputDir);
  assert.equal(path.dirname(result.path), outputDir);
  assert.equal(await hashFile(result.path), await hashFile(expected));
  assert.deepEqual(await state(source), sourceBefore);
  assert.deepEqual(await listing(outputDir), ['keep.txt', 'records.json']);
  await fs.rm(result.path);

  // Through createStage() and publish() directly.
  const stage = await engine.createStage(outputDir);
  const product = path.join(stage, 'result.bin');
  await fs.writeFile(product, productBytes(size));
  const published = await engine.publish(product, outputDir);
  assert.equal(await hashFile(published), sha256(productBytes(size)));
  await fs.rm(stage, { recursive: true, force: true });
  assert.deepEqual(await listing(outputDir), ['keep.txt', 'result.bin']);
  assert.equal(await fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'), 'precious user file');
});

test('a full disk during the cross-volume copy publishes nothing', async (t) => {
  const mount = await diskImage(t, 'ExFAT', 16);
  if (!mount) return;
  if (await supportsHardLinks(mount)) return t.skip('This volume supports hard links.');
  const outputDir = path.join(mount, 'out');
  await fs.mkdir(outputDir);
  await fs.writeFile(path.join(outputDir, 'keep.txt'), 'precious user file');
  const room = await free(outputDir);
  const src = await hostScratch(t);
  // A rename that reports EXDEV once forces the copy into a second stage beside the result.
  const realRename = fss.promises.rename;
  let failed = false;
  fss.promises.rename = async (from, to) => {
    if (!failed && from.startsWith(outputDir + path.sep)) {
      failed = true;
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    }
    return realRename(from, to);
  };
  t.after(() => (fss.promises.rename = realRename));
  const full = (e) => {
    assert.match(`${e.code} ${e.message}`, /ENOSPC|space/i);
    return true;
  };

  const source = await csvSource(src, await rowsForJsonBytes(src, Math.floor(room * 0.6)));
  const sourceBefore = await state(source);
  await assert.rejects(convertCsv(source, outputDir), full);
  assert.equal(failed, true, 'the copy fallback was reached');
  assert.deepEqual(await listing(outputDir), ['keep.txt'], 'no result, placeholder or stage');
  assert.deepEqual(await state(source), sourceBefore);

  failed = false;
  const size = Math.floor(room * 0.6);
  const stage = await engine.createStage(outputDir);
  const product = path.join(stage, 'result.bin');
  await fs.writeFile(product, productBytes(size));
  await assert.rejects(engine.publish(product, outputDir), full);
  assert.equal(failed, true, 'the copy fallback was reached');
  assert.deepEqual(
    await listing(outputDir),
    ['keep.txt', path.basename(stage)].sort(),
    'only the caller stage remains: no result, placeholder or second stage',
  );
  assert.equal(await hashFile(product), sha256(productBytes(size)), 'the staged product is intact');
  await fs.rm(stage, { recursive: true, force: true });
  assert.deepEqual(await listing(outputDir), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'), 'precious user file');
});

const killCases = [
  ['HFS+', 8, 'link-before', true, false],
  ['HFS+', 8, 'link-after', true, false],
  ['ExFAT', 16, 'fallback', false, true],
  ['ExFAT', 16, 'rename-after', false, false],
  ['ExFAT', 16, 'exdev', false, true],
];
for (const [format, size, hook, links, allowEmpty] of killCases) {
  test(`a worker killed mid-publish (${format}, ${hook}) leaves no partial result`, async (t) => {
    const mount = await diskImage(t, format, size);
    if (!mount) return;
    if ((await supportsHardLinks(mount)) !== links)
      return t.skip(`Expected ${format} hard link support to be ${links}.`);
    const outputDir = path.join(mount, 'out');
    await fs.mkdir(outputDir);
    await fs.writeFile(path.join(outputDir, 'keep.txt'), 'precious user file');
    const bytes = 1 * MB;
    const run = await killChild(outputDir, bytes, hook, 'mid');
    assert.equal(run.signal, 'SIGKILL', `the child was killed mid-publish\n${run.out}${run.err}`);
    await assertSweepIsClean(outputDir, sha256(productBytes(bytes)), {
      allowEmpty,
      keep: ['keep.txt'],
    });
  });
}

test('a worker killed at any moment of a real publish leaves no partial result', async (t) => {
  const mount = await diskImage(t, 'ExFAT', 32);
  if (!mount) return;
  if (await supportsHardLinks(mount)) return t.skip('This volume supports hard links.');
  const bytes = 4 * MB;
  const productSha = sha256(productBytes(bytes));
  const delays = [0, 1, 2, 5, 10, 20, 50, 100];
  for (const [index, delay] of delays.entries()) {
    const outputDir = path.join(mount, `run-${index}`);
    await fs.mkdir(outputDir);
    await fs.writeFile(path.join(outputDir, 'keep.txt'), 'precious user file');
    const run = await killChild(outputDir, bytes, 'plain', 'publishing', delay);
    assert.ok(
      run.signal === 'SIGKILL' || run.code === 0,
      `kill after ${delay} ms: the child was killed or finished\n${run.out}${run.err}`,
    );
    await assertSweepIsClean(outputDir, productSha, { allowEmpty: true, keep: ['keep.txt'] });
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('a failed placement removes only its own placeholder and an empty product still publishes', async (t) => {
  const dir = await hostScratch(t);
  const outputDir = path.join(dir, 'out');
  await fs.mkdir(outputDir);
  await fs.writeFile(path.join(outputDir, 'result.txt'), 'precious user file');
  const product = path.join(dir, 'result.txt');
  await fs.writeFile(product, 'finished');
  const { link, rename } = fss.promises;
  t.after(() => Object.assign(fss.promises, { link, rename }));
  const failWith = (code) => () => Promise.reject(Object.assign(new Error(code), { code }));
  fss.promises.link = failWith('ENOTSUP');
  fss.promises.rename = failWith('EIO');
  await assert.rejects(engine.publish(product, outputDir), { code: 'EIO' });
  assert.deepEqual(await fs.readdir(outputDir), ['result.txt']);
  assert.equal(await fs.readFile(path.join(outputDir, 'result.txt'), 'utf8'), 'precious user file');
  assert.equal(await fs.readFile(product, 'utf8'), 'finished');

  fss.promises.rename = rename;
  await fs.writeFile(product, '');
  const published = await engine.publish(product, outputDir);
  assert.equal(path.basename(published), 'result (1).txt');
  assert.equal((await fs.stat(published)).size, 0);
  assert.equal(await fs.readFile(path.join(outputDir, 'result.txt'), 'utf8'), 'precious user file');
});
