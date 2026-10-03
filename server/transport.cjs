const { writeAll } = require('../electron/io.cjs');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { once } = require('node:events');
const { LIMITS, fail, filename } = require('./security.cjs');
async function rpc(spec, files, output, config, signal) {
  const meta = Buffer.from(
    JSON.stringify({
      ...spec,
      files: files.map((f) => ({ name: filename(f.name), size: f.size })),
    }),
  ).toString('base64url');
  const url = new URL('/run', config.worker);
  const req = http.request(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + config.secret,
      'x-flux-job': meta,
      'content-length': files.reduce((n, f) => n + f.size, 0),
      'content-type': 'application/octet-stream',
    },
    signal,
    timeout: LIMITS.job + 15000,
  });
  const reply = new Promise((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Worker timed out.')));
  });
  reply.catch(() => {});
  try {
    for (const file of files)
      for await (const chunk of fs.createReadStream(file.path))
        if (!req.write(chunk)) await once(req, 'drain');
    req.end();
    const res = await reply;
    if (res.statusCode !== 200) {
      let message = '';
      for await (const c of res) {
        message += c;
        if (message.length > 8192) {
          res.destroy();
          break;
        }
      }
      throw fail(
        res.statusCode === 422
          ? 'The conversion engine could not process this file.'
          : 'The conversion worker is unavailable or rejected this job.',
        res.statusCode === 422 ? 422 : 503,
      );
    }
    if (spec.operation === 'inspect') {
      let body = '';
      for await (const c of res) {
        body += c;
        if (body.length > 64000) throw fail('Worker metadata exceeds its limit.', 502);
      }
      return JSON.parse(body);
    }
    const info = JSON.parse(
      Buffer.from(res.headers['x-flux-result'] || '', 'base64url').toString(),
    );
    filename(info.name);
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > LIMITS.output)
      throw fail('Output exceeds the download limit.', 413);
    const handle = await fsp.open(output, 'wx', 0o600);
    let size = 0;
    try {
      for await (const c of res) {
        size += c.length;
        if (size > info.size) throw fail('Worker returned an invalid output.', 502);
        await writeAll(handle, c);
      }
      if (size !== info.size) throw fail('Worker output was incomplete.', 502);
    } finally {
      await handle.close();
      res.destroy();
    }
    return {
      name: info.name,
      size,
      target: String(info.target || '').slice(0, 32),
      completedAt: Date.now(),
      originalSize: info.originalSize,
      savedBytes: info.savedBytes,
    };
  } finally {
    req.destroy();
  }
}
module.exports = { rpc };
