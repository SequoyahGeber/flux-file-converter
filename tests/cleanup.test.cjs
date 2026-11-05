const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { cleanWorker, cleanApi } = require('../server/cleanup.cjs');

// cleanup.cjs looks up fs.readdir/lstat/chmod/rmdir/unlink on the shared
// 'node:fs/promises' object at call time, so wrapping those properties
// intercepts it. cleanWorker sweeps the hard-coded '/tmp', so it must only ever
// run through runWorkerClean() below, which refuses unless the wrappers that
// redirect '/tmp' into a decoy folder are in place.
const WRAPPED = ['readdir', 'lstat', 'chmod', 'rmdir', 'unlink'];
const real = Object.fromEntries(WRAPPED.map((name) => [name, fs[name]]));
const SENTINEL = 'flux-cleanup-test-sentinel';
const hasUid = typeof process.getuid === 'function';

let active = null;

async function exists(p) {
  try {
    await real.lstat(p);
    return true;
  } catch {
    return false;
  }
}
async function listing(dir) {
  return (await real.readdir(dir)).sort();
}
async function unlock(p) {
  const stat = await real.lstat(p);
  if (!stat.isDirectory()) return;
  await real.chmod(p, 0o700);
  for (const child of await real.readdir(p)) await unlock(path.join(p, child));
}
function inside(base, p) {
  return p === base || p.startsWith(base + path.sep);
}
// A folder (or tree) that its owner cannot enter until the mode is restored.
async function lockedTree(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  await real.chmod(dir, 0o000);
}
// Not root, so a mode-000 folder really blocks readdir (otherwise the "recovers
// restrictive modes" assertions would pass vacuously).
async function assertBlocks(dir) {
  if (hasUid && process.getuid() !== 0) await assert.rejects(real.readdir(dir), { code: 'EACCES' });
}

// One base per test, always removed afterwards (mode-000 leftovers included).
async function makeBase(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-cleanup-test-'));
  const saved = { FLUX_WORKDIR: process.env.FLUX_WORKDIR, FLUX_TMPDIR: process.env.FLUX_TMPDIR };
  t.after(async () => {
    restoreFs();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await unlock(base).catch(() => {});
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}

function restoreFs() {
  for (const name of WRAPPED) fs[name] = real[name];
  active = null;
}

// Paths inside the base pass through (checked first so Linux, where os.tmpdir()
// is /tmp, still works), '/tmp' is redirected into the decoy, anything else is
// refused so a wrong mapping fails loudly instead of touching real files.
function installWrappers(ctx) {
  const map = (p) => {
    const requested = path.normalize(String(p));
    let mapped;
    if (inside(ctx.base, requested)) mapped = requested;
    else if (requested === '/tmp' || requested.startsWith('/tmp/'))
      mapped = path.join(ctx.decoy, requested.slice('/tmp'.length));
    else throw new Error(`cleanup test refused a path outside its sandbox: ${requested}`);
    ctx.seen.push({ requested, mapped });
    return mapped;
  };
  ctx.wrappers = {};
  for (const name of WRAPPED) {
    ctx.wrappers[name] = async (p, ...rest) => {
      const mapped = map(p);
      const result = await real[name](mapped, ...rest);
      if (name === 'lstat' && ctx.uids.has(mapped)) result.uid = ctx.uids.get(mapped);
      return result;
    };
    fs[name] = ctx.wrappers[name];
  }
  active = ctx;
}

// The only way this file calls cleanWorker.
async function runWorkerClean(ctx) {
  if (!ctx || active !== ctx) throw new Error('guard: /tmp wrappers are not installed');
  for (const name of WRAPPED)
    if (fs[name] !== ctx.wrappers[name]) throw new Error(`guard: fs.${name} is not wrapped`);
  if (!String(process.env.FLUX_TMPDIR).startsWith('/tmp/'))
    throw new Error('guard: FLUX_TMPDIR must be a /tmp/ path');
  if (!inside(ctx.base, String(process.env.FLUX_WORKDIR)))
    throw new Error('guard: FLUX_WORKDIR must be inside the test folder');
  if (!(await fs.readdir('/tmp')).includes(SENTINEL))
    throw new Error('guard: /tmp does not resolve to the decoy folder');
  return cleanWorker();
}

// FLUX_TMPDIR is the virtual path '/tmp/<name>-tmpdir': cleanWorker compares the
// literal '/tmp/<entry>' with it, so only a '/tmp/' value exercises that guard.
async function makeWorkerSandbox(t) {
  const base = await makeBase(t);
  const ctx = {
    base,
    work: path.join(base, 'work'),
    decoy: path.join(base, 'decoy'),
    tmpDir: `/tmp/${path.basename(base)}-tmpdir`,
    uids: new Map(),
    seen: [],
  };
  ctx.tmpDirReal = path.join(ctx.decoy, path.basename(ctx.tmpDir));
  await fs.mkdir(ctx.work);
  await fs.mkdir(ctx.tmpDirReal, { recursive: true });
  await fs.writeFile(path.join(ctx.decoy, SENTINEL), 'sentinel');
  ctx.uids.set(path.join(ctx.decoy, SENTINEL), process.getuid() + 1);
  process.env.FLUX_WORKDIR = ctx.work;
  process.env.FLUX_TMPDIR = ctx.tmpDir;
  installWrappers(ctx);
  return ctx;
}

test('cleanApi removes only flux-api-* entries and never follows links', async (t) => {
  const base = await makeBase(t);
  const storage = path.join(base, 'storage');
  const outside = path.join(base, 'outside');
  await fs.mkdir(storage);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'outside data');
  await fs.writeFile(path.join(storage, 'access.json'), '{"members":["a@example.com"]}');
  await fs.writeFile(path.join(storage, 'flux-apiary'), 'not an api folder');
  await fs.mkdir(path.join(storage, 'other'));
  await fs.writeFile(path.join(storage, 'other', 'note.txt'), 'other data');
  const old = path.join(storage, 'flux-api-old');
  await fs.mkdir(old);
  await fs.writeFile(path.join(old, 'upload.bin'), 'scratch');
  await fs.symlink(outside, path.join(old, 'nested-link'));
  await lockedTree(path.join(old, 'locked'), { 'inner.bin': 'locked scratch' });
  await assertBlocks(path.join(old, 'locked'));
  await fs.symlink(outside, path.join(storage, 'flux-api-link'));

  await cleanApi(storage);

  assert.deepEqual(await listing(storage), ['access.json', 'flux-apiary', 'other']);
  assert.equal(
    await fs.readFile(path.join(storage, 'access.json'), 'utf8'),
    '{"members":["a@example.com"]}',
  );
  assert.equal(await fs.readFile(path.join(storage, 'flux-apiary'), 'utf8'), 'not an api folder');
  assert.deepEqual(await listing(path.join(storage, 'other')), ['note.txt']);
  assert.equal(await fs.readFile(path.join(storage, 'other', 'note.txt'), 'utf8'), 'other data');
  assert.deepEqual(await listing(outside), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside data');
});

test(
  'cleanWorker empties the work dir, unlinks links without following them, keeps a root lost+found',
  { skip: !hasUid && 'needs process.getuid' },
  async (t) => {
    const ctx = await makeWorkerSandbox(t);
    const outside = path.join(ctx.base, 'outside2');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'outside data');
    await fs.symlink(outside, path.join(ctx.work, 'link'));
    await fs.symlink(path.join(outside, 'keep.txt'), path.join(ctx.work, 'file-link'));
    await fs.writeFile(path.join(ctx.work, 'stray.bin'), 'scratch');
    const tree = path.join(ctx.work, 'tree');
    await fs.mkdir(path.join(tree, 'deep'), { recursive: true });
    await fs.writeFile(path.join(tree, 'a.bin'), 'a');
    await fs.writeFile(path.join(tree, 'deep', 'b.bin'), 'b');
    await fs.symlink(outside, path.join(tree, 'deep', 'nested-link'));
    await real.chmod(path.join(tree, 'deep'), 0o000);
    await real.chmod(tree, 0o000);
    await assertBlocks(tree);
    const lostFound = path.join(ctx.work, 'lost+found');
    await fs.mkdir(lostFound);
    await fs.writeFile(path.join(lostFound, 'recovered.bin'), 'fsck data');
    ctx.uids.set(lostFound, 0);

    await runWorkerClean(ctx);

    assert.deepEqual(await listing(ctx.work), ['lost+found']);
    assert.equal(await fs.readFile(path.join(lostFound, 'recovered.bin'), 'utf8'), 'fsck data');
    assert.deepEqual(await listing(outside), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside data');
  },
);

test(
  'cleanWorker empties FLUX_TMPDIR (user lost+found included) and sweeps only this uid in /tmp',
  { skip: !hasUid && 'needs process.getuid' },
  async (t) => {
    const ctx = await makeWorkerSandbox(t);
    const uid = process.getuid();
    const userOwner = uid === 0 ? 1000 : uid;
    const foreign = uid + 1;
    await fs.writeFile(path.join(ctx.tmpDirReal, 'scratch.bin'), 'scratch');
    const userLostFound = path.join(ctx.tmpDirReal, 'lost+found');
    await fs.mkdir(userLostFound);
    await fs.writeFile(path.join(userLostFound, 'x.bin'), 'x');
    ctx.uids.set(userLostFound, userOwner);
    const mine = path.join(ctx.decoy, 'mine');
    await fs.mkdir(path.join(mine, 'deep'), { recursive: true });
    await fs.writeFile(path.join(mine, 'deep', 'm.bin'), 'm');
    await real.chmod(path.join(mine, 'deep'), 0o000);
    await real.chmod(mine, 0o000);
    await assertBlocks(mine);
    await fs.writeFile(path.join(ctx.decoy, 'mine-file'), 'mine');
    const theirs = path.join(ctx.decoy, 'theirs');
    await fs.mkdir(theirs);
    await fs.writeFile(path.join(theirs, 't.bin'), 'theirs');
    ctx.uids.set(theirs, foreign);

    await runWorkerClean(ctx);

    assert.ok(await exists(ctx.tmpDirReal), 'FLUX_TMPDIR itself must survive the /tmp sweep');
    assert.deepEqual(await listing(ctx.tmpDirReal), []);
    assert.equal(await exists(mine), false);
    assert.equal(await exists(path.join(ctx.decoy, 'mine-file')), false);
    assert.equal(await fs.readFile(path.join(theirs, 't.bin'), 'utf8'), 'theirs');
    assert.equal(await fs.readFile(path.join(ctx.decoy, SENTINEL), 'utf8'), 'sentinel');
    assert.deepEqual(
      await listing(ctx.decoy),
      [path.basename(ctx.tmpDir), SENTINEL, 'theirs'].sort(),
    );
    assert.deepEqual(await listing(ctx.work), []);
    // Nothing reached a real path outside the sandbox.
    assert.ok(
      ctx.seen.some((s) => s.requested === '/tmp'),
      'the /tmp sweep did not run',
    );
    for (const { requested, mapped } of ctx.seen) {
      assert.ok(inside(ctx.base, mapped), `${requested} escaped to ${mapped}`);
      if (requested === '/tmp' || requested.startsWith('/tmp/'))
        assert.ok(inside(ctx.decoy, mapped), `${requested} was not redirected to the decoy`);
    }
  },
);

test(
  'the cleanWorker guard refuses to run without the /tmp wrappers or with unsafe settings',
  { skip: !hasUid && 'needs process.getuid' },
  async (t) => {
    const ctx = await makeWorkerSandbox(t);
    const marker = path.join(ctx.work, 'marker.bin');
    await fs.writeFile(marker, 'must survive');
    const refuses = async (pattern) => {
      await assert.rejects(runWorkerClean(ctx), pattern);
      assert.equal(await fs.readFile(marker, 'utf8'), 'must survive');
    };

    for (const name of WRAPPED) {
      fs[name] = real[name];
      await refuses(new RegExp(`guard: fs\\.${name} is not wrapped`));
      fs[name] = ctx.wrappers[name];
    }
    const tmpDir = process.env.FLUX_TMPDIR;
    process.env.FLUX_TMPDIR = '/var/tmp/flux-cleanup-test';
    await refuses(/guard: FLUX_TMPDIR/);
    process.env.FLUX_TMPDIR = tmpDir;
    const workDir = process.env.FLUX_WORKDIR;
    process.env.FLUX_WORKDIR = `${ctx.base}-elsewhere`;
    await refuses(/guard: FLUX_WORKDIR/);
    process.env.FLUX_WORKDIR = workDir;
    await fs.rm(path.join(ctx.decoy, SENTINEL));
    await refuses(/guard: \/tmp does not resolve/);
    await fs.writeFile(path.join(ctx.decoy, SENTINEL), 'sentinel');
    restoreFs();
    await refuses(/guard: \/tmp wrappers are not installed/);
    // The wrapped functions really are gone after the restore.
    for (const name of WRAPPED) assert.equal(fs[name], real[name]);
  },
);
