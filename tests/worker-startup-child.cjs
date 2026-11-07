// Test subprocess only: install cleanup guards BEFORE loading the real worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const [mode, base] = process.argv.slice(2);
const send = (value) => process.send(value);
const closed = () => {
  try {
    fs.fstatSync(3);
    return false;
  } catch (error) {
    return error.code === 'EBADF';
  }
};

if (mode === 'reader') {
  send({ type: 'started' });
  require('../server/worker-startup.cjs')
    .readWorkerSecret(3, 500)
    .then(
      (secret) =>
        send({
          type: 'result',
          ok: true,
          length: Buffer.byteLength(secret),
          closed: closed(),
        }),
      (error) =>
        send({
          type: 'result',
          ok: false,
          fixedError: error.message === 'Invalid worker startup credential.',
          closed: closed(),
        }),
    )
    .finally(() => process.disconnect());
} else {
  assert.equal(mode, 'worker');
  assert.ok(path.basename(base).startsWith('flux-worker-startup-'));
  assert.equal(fs.realpathSync(base), base);
  assert.ok(fs.lstatSync(base).isDirectory());
  const work = path.join(base, 'work');
  const decoy = path.join(base, 'decoy');
  const virtualTmp = '/tmp/' + path.basename(base) + '-scratch';
  const sentinel = 'cleanup-guard';
  const inside = (root, entry) => entry === root || entry.startsWith(root + path.sep);
  const operations = ['readdir', 'lstat', 'chmod', 'rmdir', 'unlink', 'rm'];
  const real = Object.fromEntries(operations.map((name) => [name, fsp[name]]));
  const wrappers = {};
  let swept = false;
  const map = (entry) => {
    const requested = path.resolve(String(entry));
    // Check owned real paths first: on Linux base itself lives under /tmp.
    if (inside(work, requested) || inside(decoy, requested)) return requested;
    if (requested === '/tmp' || requested.startsWith('/tmp/')) {
      if (requested === '/tmp') swept = true;
      const mapped = path.join(decoy, requested.slice('/tmp'.length));
      assert.ok(inside(decoy, mapped));
      return mapped;
    }
    throw new Error('Startup test refused cleanup outside its sandbox.');
  };
  for (const name of operations) {
    wrappers[name] = async (entry, ...args) => {
      const mapped = map(entry);
      const result = await real[name](mapped, ...args);
      // Keep the guard sentinel during the worker-UID /tmp sweep.
      if (name === 'lstat' && mapped === path.join(decoy, sentinel))
        result.uid = process.getuid() + 1;
      return result;
    };
    fsp[name] = wrappers[name];
  }
  process.env.FLUX_WORKDIR = work;
  process.env.FLUX_TMPDIR = virtualTmp;
  process.env.FLUX_BIND = '127.0.0.1';
  const cleanup = require('../server/cleanup.cjs');
  const cleanWorker = cleanup.cleanWorker;
  cleanup.cleanWorker = async () => {
    for (const name of operations) assert.equal(fsp[name], wrappers[name]);
    assert.equal(process.env.FLUX_WORKDIR, work);
    assert.equal(process.env.FLUX_TMPDIR, virtualTmp);
    assert.ok((await fsp.readdir('/tmp')).includes(sentinel));
    assert.equal(closed(), true, 'Startup descriptor must close before cleanup.');
    send({ type: 'cleanup', closed: true, guarded: true });
    await cleanWorker();
    assert.equal(swept, true, 'The guarded /tmp sweep must run.');
    assert.deepEqual(await real.readdir(work), []);
    assert.deepEqual(
      (await real.readdir(decoy)).sort(),
      [sentinel, path.basename(virtualTmp)].sort(),
    );
    assert.deepEqual(await real.readdir(path.join(decoy, path.basename(virtualTmp))), []);
  };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (port, host) {
    assert.equal(port, 8090);
    assert.equal(host, '127.0.0.1');
    assert.equal(closed(), true, 'Startup descriptor must close before listening.');
    this.once('listening', () => {
      send({ type: 'ready', port: this.address().port, closed: true });
    });
    return listen.call(this, 0, host);
  };
  send({ type: 'guarded' });
  require('../server/worker.cjs');
}
