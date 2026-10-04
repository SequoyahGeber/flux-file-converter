const { writeAll } = require('../electron/io.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LIMITS, fail } = require('./security.cjs');
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
          if (!offset)
            await fs.writeFile(path.join(root, 'input', files[index].name), '', {
              flag: 'wx',
              mode: 0o600,
            });
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
    // Finish every trailing empty file too: no request chunk may arrive to
    // trigger the loop above when all inputs are empty.
    while (index < files.length && offset === files[index].size) {
      if (handle) {
        await handle.close();
        handle = null;
      }
      if (!offset)
        await fs.writeFile(path.join(root, 'input', files[index].name), '', {
          flag: 'wx',
          mode: 0o600,
        });
      index++;
      offset = 0;
    }
    if (index !== files.length) throw fail('Incomplete input.');
  } finally {
    if (handle) await handle.close();
  }
}
async function execute(root, signal, spawnProcess = spawn) {
  if (signal.aborted) throw fail('Conversion cancelled.', 422);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
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
    if (signal.aborted) kill();
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
module.exports = { receive, execute };
