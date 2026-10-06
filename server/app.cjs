const { writeAll } = require('../electron/io.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createAuth } = require('./auth.cjs');
const { scan } = require('./clamav.cjs');
const { rpc } = require('./transport.cjs');
const {
  LIMITS,
  fail,
  filename,
  safeMetadata,
  headers,
  RateLimit,
  Queue,
  options,
} = require('./security.cjs');
async function json(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 32000) throw fail('Request is too large.', 413);
    chunks.push(c);
  }
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw fail('Invalid JSON.');
  }
}
const send = (res, body, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};
async function createApp(config, deps = {}) {
  const authenticate = deps.auth || (await createAuth(config));
  const scanner = deps.scan || scan,
    worker = deps.rpc || ((...args) => rpc(...args));
  const sessions = new Map(),
    limits = new RateLimit(deps.now),
    queue = new Queue(),
    work = new Set();
  function track(promise) {
    work.add(promise);
    promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
  }
  let stored = 0,
    reserved = 0,
    uploading = 0,
    capability;
  await require('./cleanup.cjs').cleanApi(config.storage || '/work');
  const access = config.ownerEmail
    ? await require('./access.cjs').createAccess({
        storage: config.storage || '/work',
        ownerEmail: config.ownerEmail,
        origin: config.origin,
      })
    : null;
  const root = await fs.mkdtemp(path.join(config.storage || '/work', 'flux-api-'));
  async function capabilities() {
    if (!capability && deps.capabilities) capability = deps.capabilities;
    if (!capability) {
      const res = await fetch(new URL('/capabilities', config.worker), {
        headers: { authorization: 'Bearer ' + config.secret },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw fail('Conversion worker unavailable.', 503);
      const text = await res.text();
      if (text.length > 2_000_000) throw fail('Invalid worker capabilities.', 502);
      capability = JSON.parse(text);
    }
    return capability;
  }
  function session(user) {
    let s = sessions.get(user.id);
    if (!s) {
      if (sessions.size >= LIMITS.users) throw fail('The server is busy. Try again later.', 503);
      s = {
        dir: path.join(root, user.id),
        files: new Map(),
        uploads: new Map(),
        results: new Map(),
        jobs: new Map(),
        active: 0,
        requests: 0,
        removing: false,
        expiry: Date.now() + LIMITS.ttl,
        email: user.email,
      };
      sessions.set(user.id, s);
    }
    s.expiry = Date.now() + LIMITS.ttl;
    return s;
  }
  async function remove(s) {
    s.removing = true;
    try {
      await fs.rm(s.dir, { force: true, recursive: true });
      for (const item of [...s.files.values(), ...s.results.values()]) stored -= item.size;
      for (const upload of s.uploads.values()) reserved -= upload.size;
      s.files.clear();
      s.uploads.clear();
      s.results.clear();
      s.jobs.clear();
    } finally {
      s.removing = false;
    }
  }
  const sweep = setInterval(async () => {
    for (const [id, s] of sessions)
      if (!s.active && !s.requests && !s.removing && Date.now() > s.expiry) {
        try {
          await remove(s);
          sessions.delete(id);
        } catch {
          console.error('Temporary file cleanup failed; it will be retried.');
        }
      }
  }, 30000);
  sweep.unref();
  async function bounded(job, controller, run) {
    const timer = setTimeout(() => {
      job.timedOut = true;
      controller.abort();
    }, deps.jobTimeout || LIMITS.job);
    timer.unref();
    try {
      return await run();
    } finally {
      clearTimeout(timer);
    }
  }
  function view(s) {
    return {
      files: [...s.files.values()].map((f) => ({ id: f.id, ...safeMetadata(f) })),
      jobs: [...s.jobs.values()],
      history: [...s.results.values()].map(({ path: _, ...r }) => r),
      expiresInMinutes: 30,
    };
  }
  const server = http.createServer(async (req, res) => {
    headers(res);
    let requestSession;
    try {
      // Unauthenticated health carries no app, user, engine, or file details.
      if (req.url === '/health' && req.method === 'GET') {
        res.end('ok');
        return;
      }
      const user = await authenticate(req);
      limits.check(user.id + ':requests', 600, 60000);
      const url = new URL(req.url, 'http://localhost');
      if (
        req.method === 'GET' &&
        ['/', '/app.js', '/styles.css', '/icon.svg'].includes(url.pathname)
      ) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const types = {
          'index.html': 'text/html; charset=utf-8',
          'app.js': 'text/javascript; charset=utf-8',
          'styles.css': 'text/css; charset=utf-8',
          'icon.svg': 'image/svg+xml',
        };
        res.setHeader('Content-Type', types[file]);
        await pipeline(fss.createReadStream(path.join(__dirname, 'web', file)), res);
        return;
      }
      if (access) {
        if (req.method === 'GET' && url.pathname === '/api/state' && !access.allowed(user)) {
          send(res, {
            user: user.email,
            canUse: false,
            canManageAccess: false,
            files: [],
            jobs: [],
            history: [],
            formats: [],
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/access') {
          send(res, access.list(user));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/invites') {
          limits.check(user.id + ':invites', 10, 60000);
          send(res, await access.invite(user), 201);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/invites/claim') {
          limits.check(user.id + ':claims', 10, 60000);
          const body = await json(req);
          send(res, await access.claim(user, body.token));
          return;
        }
        if (req.method === 'DELETE' && /^\/api\/invites\/[a-f0-9-]{36}$/.test(url.pathname)) {
          send(res, await access.revokeInvite(user, url.pathname.split('/').pop()));
          return;
        }
        if (req.method === 'DELETE' && /^\/api\/members\/[a-f0-9]{64}$/.test(url.pathname)) {
          const id = url.pathname.split('/').pop();
          send(res, await access.revokeMember(user, id));
          const previous = sessions.get(id);
          if (previous) {
            previous.expiry = 0;
            for (const job of previous.jobs.values()) job.controller?.abort();
          }
          return;
        }
        if (!access.allowed(user))
          throw fail('An invitation is required to use this workspace.', 403);
      }
      const s = session(user);
      if (s.removing) throw fail('Temporary files are being cleared. Try again shortly.', 409);
      requestSession = s;
      s.requests++;
      if (req.method === 'GET' && url.pathname === '/api/state') {
        send(res, {
          ...view(s),
          ...(await capabilities()),
          user: user.email,
          canUse: true,
          canManageAccess: access?.isOwner(user) || false,
          enrollmentUrl: config.issuer ? config.issuer + '/AddMfaDevice' : undefined,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        send(res, view(s));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        limits.check(user.id + ':uploads', 10, 60000);
        const body = await json(req);
        const name = filename(body.name),
          size = body.size;
        if (!Number.isSafeInteger(size) || size < 1 || size > LIMITS.file)
          throw fail('Files must be between 1 byte and 5 GB.', 413);
        if (
          s.files.size + s.uploads.size >= LIMITS.files ||
          s.uploads.size >= 2 ||
          stored + reserved + size > LIMITS.storage
        )
          throw fail('Upload space is full. Delete previous files or try later.', 503);
        const id = crypto.randomUUID(),
          target = path.join(s.dir, id);
        reserved += size;
        s.uploads.set(id, { id, path: target, name, size, offset: 0, busy: true });
        try {
          await fs.mkdir(s.dir, { recursive: true, mode: 0o700 });
          await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 });
          s.uploads.get(id).busy = false;
        } catch (e) {
          reserved -= size;
          s.uploads.delete(id);
          throw e;
        }
        send(res, { id, chunkSize: LIMITS.chunk }, 201);
        return;
      }
      if (req.method === 'GET' && /^\/api\/uploads\/[a-f0-9-]{36}$/.test(url.pathname)) {
        // Lets the browser resume from the confirmed offset after a lost response.
        const upload = s.uploads.get(url.pathname.split('/').pop());
        if (!upload) throw fail('Upload expired.', 404);
        send(res, { offset: upload.offset, size: upload.size, busy: upload.busy });
        return;
      }
      if (req.method === 'PUT' && /^\/api\/uploads\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const upload = s.uploads.get(url.pathname.split('/').pop());
        if (!upload) throw fail('Upload expired.', 404);
        const offset = Number(req.headers['x-flux-offset']),
          size = Number(req.headers['content-length']);
        if (
          upload.busy ||
          offset !== upload.offset ||
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > LIMITS.chunk ||
          offset + size > upload.size ||
          req.headers['content-type'] !== 'application/octet-stream'
        )
          throw fail('Invalid upload chunk.', 409);
        if (uploading >= LIMITS.uploadStreams)
          throw Object.assign(fail('The server is busy with other uploads.', 429), {
            retryAfter: 2,
          });
        upload.busy = true;
        uploading++;
        s.active++;
        let handle,
          received = 0;
        try {
          handle = await fs.open(upload.path, 'r+');
          for await (const chunk of req) {
            received += chunk.length;
            if (received > size) throw fail('Chunk too large.', 413);
            await writeAll(handle, chunk, offset + received - chunk.length);
          }
          if (received !== size) throw fail('Incomplete chunk.');
          upload.offset += size;
        } finally {
          try {
            await handle?.close();
          } finally {
            upload.busy = false;
            uploading--;
            s.active--;
          }
        }
        // A successful response means the next chunk/completion can begin.
        send(res, { offset: upload.offset });
        return;
      }
      if (req.method === 'POST' && /^\/api\/uploads\/[a-f0-9-]{36}\/complete$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3],
          upload = s.uploads.get(id);
        if (!upload || upload.busy || upload.offset !== upload.size)
          throw fail('Upload is incomplete.', 409);
        if (s.active >= 2) throw fail('You already have two uploads or jobs in progress.', 429);
        if (s.jobs.size >= 100) throw fail('Clear recent jobs before submitting more.', 429);
        upload.busy = true;
        s.active++;
        let committed = false;
        const jobId = crypto.randomUUID(),
          job = {
            id: jobId,
            fileId: id,
            fileIds: [id],
            name: upload.name,
            operation: 'upload',
            status: 'queued',
            createdAt: Date.now(),
          },
          controller = new AbortController();
        Object.defineProperty(job, 'controller', { value: controller });
        s.jobs.set(jobId, job);
        track(
          queue
            .add(() =>
              bounded(job, controller, async () => {
                if (controller.signal.aborted) throw fail('Cancelled.');
                job.status = 'running';
                const scanMode = await scanner(upload.path, { signal: controller.signal });
                const inspected = await worker(
                  { operation: 'inspect' },
                  [upload],
                  null,
                  config,
                  controller.signal,
                );
                if (controller.signal.aborted) throw fail('Cancelled.');
                if (
                  upload.size > LIMITS.scanFull &&
                  (!['video', 'audio'].includes(inspected.family) ||
                    (!inspected.hasAudio && !inspected.hasVideo))
                )
                  throw fail(
                    'Files above 1.9 GB must be valid audio or video. Documents and archives need full-file malware scanning.',
                    413,
                  );
                const info = {
                  ...safeMetadata(inspected),
                  path: upload.path,
                  name: upload.name,
                  size: upload.size,
                  id,
                  scanMode,
                };
                if (scanMode === 'chunked')
                  info.warning =
                    'Large media: overlapping signature scans were used. This cannot fully analyze embedded containers.';
                s.files.set(id, info);
                stored += upload.size;
                committed = true;
                job.status = 'done';
                job.file = { id, ...safeMetadata(info), scanMode };
              }),
            )
            .catch((e) => {
              job.status = job.timedOut
                ? 'error'
                : controller.signal.aborted
                  ? 'cancelled'
                  : 'error';
              job.error = job.timedOut
                ? 'Job exceeded the ten-minute limit.'
                : e.status
                  ? e.message
                  : 'The file scan could not finish.';
            })
            .finally(async () => {
              try {
                if (!committed) await fs.rm(upload.path, { force: true });
              } finally {
                s.uploads.delete(id);
                reserved -= upload.size;
                s.active--;
              }
            }),
        );
        send(res, { id: jobId }, 202);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/files')
        throw fail('Use the bounded chunked upload API.', 410);
      if (req.method === 'DELETE' && /^\/api\/uploads\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop(),
          upload = s.uploads.get(id);
        if (upload) {
          if (upload.busy) throw fail('The upload is still stopping. Try again shortly.', 409);
          upload.busy = true;
          s.active++;
          try {
            await fs.rm(upload.path, { force: true });
            s.uploads.delete(id);
            reserved -= upload.size;
          } finally {
            upload.busy = false;
            s.active--;
          }
        }
        send(res, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        limits.check(user.id + ':jobs-minute', 6, 60000);
        limits.check(user.id + ':jobs-hour', 30, 3600000);
        const spec = await json(req);
        if (s.active >= 2) throw fail('You already have two uploads or jobs in progress.', 429);
        const op = spec.operation;
        if (!['convert', 'compress', 'pack', 'extract'].includes(op))
          throw fail('Unknown operation.');
        const ids = op === 'pack' ? spec.ids : [spec.id];
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > LIMITS.files ||
          new Set(ids).size !== ids.length
        )
          throw fail('Invalid file selection.');
        const files = ids.map((id) => s.files.get(id));
        if (files.some((f) => !f)) throw fail('That file is missing or expired.', 404);
        if (op === 'pack' && new Set(files.map((f) => f.name)).size !== files.length)
          throw fail('Rename duplicate filenames before creating a ZIP.');
        if (op === 'convert' && !files[0].targets?.includes(spec.target))
          throw fail('Unsupported output format.');
        if (
          op === 'compress' &&
          !files[0].compressionOptions?.some((c) => c.id === spec.compression)
        )
          throw fail('Unsupported compression option.');
        if (op === 'extract' && files[0].family !== 'archive')
          throw fail('Choose an archive to extract.');
        if (s.jobs.size >= 100) throw fail('Clear recent jobs before submitting more.', 429);
        const id = crypto.randomUUID(),
          output = path.join(s.dir, id),
          job = {
            id,
            fileId: spec.id,
            fileIds: ids,
            name: files[0].name,
            operation: op,
            target: op === 'convert' ? spec.target : undefined,
            compression: op === 'compress' ? spec.compression : undefined,
            options: options(spec.options),
            status: 'queued',
            createdAt: Date.now(),
          };
        if (stored + reserved + LIMITS.output > LIMITS.storage)
          throw fail('Insufficient output space. Clear previous results first.', 503);
        reserved += LIMITS.output;
        s.active++;
        s.jobs.set(id, job);
        const controller = new AbortController();
        Object.defineProperty(job, 'controller', { value: controller });
        track(
          queue
            .add(() =>
              bounded(job, controller, async () => {
                if (controller.signal.aborted) throw fail('Cancelled.');
                job.status = 'running';
                const info = await worker(
                  {
                    operation: op,
                    target: spec.target,
                    compression: spec.compression,
                    options: options(spec.options),
                  },
                  files,
                  output,
                  config,
                  controller.signal,
                );
                const scanMode = await scanner(output, { signal: controller.signal });
                if (
                  info.size > LIMITS.scanFull &&
                  ![
                    'mp4',
                    'mkv',
                    'mov',
                    'webm',
                    'avi',
                    'm4v',
                    'mpg',
                    'mpeg',
                    'flv',
                    '3gp',
                    'ts',
                    'mts',
                    'm2ts',
                    'vob',
                    'wmv',
                    'ogv',
                    'mp3',
                    'wav',
                    'flac',
                    'aac',
                    'm4a',
                    'ogg',
                    'opus',
                    'aiff',
                    'aif',
                    'wma',
                    'amr',
                    'ac3',
                    'caf',
                  ].includes(info.target)
                )
                  throw fail('Large non-media outputs exceed the full-file scanning limit.', 413);
                if (controller.signal.aborted) throw fail('Cancelled.');
                filename(info.name);
                const stat = await fs.lstat(output);
                if (!stat.isFile() || stat.size > LIMITS.output) throw fail('Invalid output.', 502);
                const result = {
                  id,
                  ...info,
                  size: stat.size,
                  path: output,
                  operation: op,
                  scanMode,
                };
                stored += stat.size;
                s.results.set(id, result);
                job.status = 'done';
                job.result = { ...result, path: undefined };
              }),
            )
            .catch(async (e) => {
              job.status = job.timedOut
                ? 'error'
                : controller.signal.aborted
                  ? 'cancelled'
                  : 'error';
              job.error = job.timedOut
                ? 'Job exceeded the ten-minute limit.'
                : e.status
                  ? e.message
                  : 'The conversion could not finish. Try a smaller file or another format.';
              await fs.rm(output, { force: true });
            })
            .finally(() => {
              reserved -= LIMITS.output;
              s.active--;
            }),
        );
        send(res, { id }, 202);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        const body = await json(req);
        const job = s.jobs.get(body.id);
        if (job?.controller) job.controller.abort();
        send(res, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/api/files') {
        if (s.active || s.requests > 1)
          throw fail('Cancel or finish your active jobs before deleting files.', 409);
        await remove(s);
        send(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && /^\/api\/download\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const result = s.results.get(url.pathname.split('/').pop());
        if (!result) throw fail('That download is missing or expired.', 404);
        const saveName = url.searchParams.has('name')
          ? filename(url.searchParams.get('name'))
          : result.name;
        if (path.extname(saveName).toLowerCase() !== path.extname(result.name).toLowerCase())
          throw fail('Keep the output file extension when changing its name.');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="download"; filename*=UTF-8\'\'' + encodeURIComponent(saveName),
        );
        res.setHeader('Content-Length', result.size);
        // Output HTML, SVG, PDFs and archives never render inline at this origin.
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        s.active++;
        try {
          await pipeline(fss.createReadStream(result.path), res);
        } finally {
          s.active--;
        }
        return;
      }
      throw fail('Not found.', 404);
    } catch (e) {
      if (res.headersSent) res.destroy();
      else {
        if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
        send(
          res,
          { error: e.status ? e.message : 'The request could not be completed.' },
          e.status || 500,
        );
      }
    } finally {
      if (requestSession) requestSession.requests--;
    }
  });
  server.requestTimeout = 630000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  server.on('clientError', (_, socket) =>
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'),
  );
  return {
    server,
    close: async () => {
      clearInterval(sweep);
      for (const s of sessions.values()) for (const job of s.jobs.values()) job.controller?.abort();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...work]);
      await fs.rm(root, { force: true, recursive: true });
    },
  };
}
async function main() {
  const config = {
    ownerEmail: process.env.FLUX_OWNER_EMAIL,
    storage: process.env.FLUX_STORAGE,
    issuer: process.env.ACCESS_ISSUER,
    audience: process.env.ACCESS_AUD,
    origin: process.env.PUBLIC_ORIGIN,
    worker: process.env.WORKER_URL || 'http://flux-worker:8090',
    secret: process.env.WORKER_SECRET,
  };
  if (!config.secret || config.secret.length < 32)
    throw new Error('A strong worker secret is required.');
  if (!config.ownerEmail) throw new Error('The invitation owner email is required.');
  const app = await createApp(config);
  app.server.listen(8080, process.env.FLUX_BIND || '0.0.0.0');
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
module.exports = { createApp };
