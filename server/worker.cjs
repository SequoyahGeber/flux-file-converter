const { writeAll } = require('../electron/io.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { LIMITS, fail, filename, sameSecret } = require('./security.cjs');
const secret = process.env.WORKER_SECRET;
if (!secret || secret.length < 32) throw new Error('A strong worker secret is required.');
let busy = false;
let idle = Promise.resolve(),
  release;
async function receive(req, files, root) {
  await fs.mkdir(path.join(root, 'input'));
  let index = 0,
    offset = 0,
    handle;
  try {
    for await (const chunk of req) {
      let at = 0;
      while (at < chunk.length) {
        while (index < files.length && offset === files[index].size) {
          if (handle) {
            await handle.close();
            handle = null;
          }
          if (!offset) await fs.writeFile(path.join(root, 'input', files[index].name), '');
          index++;
          offset = 0;
        }
        if (index >= files.length) throw fail('Upload length mismatch.');
        if (!handle)
          handle = await fs.open(path.join(root, 'input', files[index].name), 'wx', 0o600);
        const take = Math.min(chunk.length - at, files[index].size - offset);
        await writeAll(handle, chunk.subarray(at, at + take));
        at += take;
        offset += take;
      }
    }
    if (index === files.length - 1 && offset === files[index].size) index++;
    if (index !== files.length) throw fail('Incomplete input.');
  } finally {
    if (handle) await handle.close();
  }
}
async function execute(root, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/flux-sandbox',
      ['/usr/local/bin/node', '/app/server/job.cjs', root],
      {
        detached: true,
        cwd: root,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: root,
          TMPDIR: root,
          XDG_RUNTIME_DIR: root,
          FLUX_SERVER: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          FLUX_ARCHIVE_MAX_BYTES: '1900000000',
          FLUX_ARCHIVE_MAX_FILES: '2000',
          OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          MAGICK_THREAD_LIMIT: '1',
          QT_QPA_PLATFORM: 'offscreen',
          NODE_OPTIONS: '--max-old-space-size=512',
        },
      },
    );
    let message = '',
      timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, LIMITS.job);
    timer.unref();
    signal.addEventListener('abort', kill, { once: true });
    child.stderr.on('data', (b) => {
      message = (message + b).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      kill();
      if (code === 0 && !signal.aborted) resolve();
      else reject(fail(timedOut ? 'Job timed out.' : 'Conversion failed.', 422));
    });
  });
}
const server = http.createServer(async (req, res) => {
  let root,
    claimed = false;
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.end('ok');
      return;
    }
    if (!sameSecret(req.headers.authorization?.replace(/^Bearer /, ''), secret))
      throw fail('Unauthorized.', 401);
    if (req.method === 'GET' && req.url === '/capabilities') {
      res.setHeader('Content-Type', 'application/json');
      res.end(await fs.readFile('/app/server/capabilities.json'));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/run') throw fail('Not found.', 404);
    // A download can finish just before scratch cleanup. Give cleanup a brief
    // chance to finish before accepting the next request from the serial API.
    if (busy) {
      let timer;
      try {
        await Promise.race([
          idle,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail('Worker is busy.', 503)), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (busy) throw fail('Worker is busy.', 503);
    }
    const header = req.headers['x-flux-job'];
    if (typeof header !== 'string' || header.length > 48000) throw fail('Invalid job.');
    const spec = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (
      !['inspect', 'convert', 'compress', 'pack', 'extract'].includes(spec.operation) ||
      !Array.isArray(spec.files) ||
      !spec.files.length ||
      spec.files.length > LIMITS.files
    )
      throw fail('Invalid job.');
    const seen = new Set();
    let size = 0;
    for (const file of spec.files) {
      filename(file.name);
      if (
        seen.has(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > LIMITS.file
      )
        throw fail('Invalid input.');
      seen.add(file.name);
      size += file.size;
    }
    if (size > LIMITS.storage || Number(req.headers['content-length']) !== size)
      throw fail('Input exceeds the job limit.', 413);
    busy = true;
    idle = new Promise((resolve) => {
      release = resolve;
    });
    claimed = true;
    root = await fs.mkdtemp(path.join(process.env.FLUX_WORKDIR || '/work', 'flux-job-'));
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    await receive(req, spec.files, root);
    await fs.writeFile(path.join(root, 'job.json'), JSON.stringify(spec));
    await execute(root, controller.signal);
    const result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    if (spec.operation === 'inspect') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } else {
      filename(result.name);
      if (!Number.isSafeInteger(result.size) || result.size > LIMITS.output)
        throw fail('Invalid result.', 422);
      const out = await fs.realpath(path.resolve(root, result.path));
      if (!out.startsWith(root + '/')) throw fail('Invalid result path.', 422);
      const stat = await fs.lstat(out);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== result.size)
        throw fail('Invalid output.', 422);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', result.size);
      res.setHeader(
        'X-Flux-Result',
        Buffer.from(
          JSON.stringify({
            name: result.name,
            size: result.size,
            target: result.target,
            originalSize: result.originalSize,
            savedBytes: result.savedBytes,
          }),
        ).toString('base64url'),
      );
      await pipeline(fss.createReadStream(out), res);
    }
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = e.status || 400;
      res.end('Job rejected.');
    } else res.destroy();
  } finally {
    if (claimed) {
      try {
        await require('./cleanup.cjs').cleanWorker();
      } finally {
        busy = false;
        release();
      }
    }
  }
});
server.requestTimeout = 630000;
server.headersTimeout = 10000;
server.maxConnections = 4;
require('./cleanup.cjs')
  .cleanWorker()
  .then(() => server.listen(8090, process.env.FLUX_BIND || '0.0.0.0'))
  .catch((e) => {
    console.error('Scratch cleanup failed.');
    process.exit(1);
  });
