const http = require('node:http');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createAuth } = require('./auth.cjs');
const { scan } = require('./clamav.cjs');
const { rpc } = require('./transport.cjs');
const { LIMITS, fail, filename, safeMetadata, headers, RateLimit, Queue, options } = require('./security.cjs');
async function json(req) {
  let body = ''; for await (const c of req) { body += c; if (Buffer.byteLength(body) > 32000) throw fail('Request is too large.', 413); }
  try { return JSON.parse(body); } catch { throw fail('Invalid JSON.'); }
}
const send = (res, body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
async function createApp(config, deps = {}) {
  const authenticate = deps.auth || await createAuth(config);
  const scanner = deps.scan || scan, worker = deps.rpc || ((...args) => rpc(...args));
  const sessions = new Map(), limits = new RateLimit(), queue = new Queue(); let stored = 0, reserved = 0, uploading = 0, capability;
  const root = await fs.mkdtemp(path.join(config.storage || '/work', 'flux-api-'));
  async function capabilities() {
    if (!capability) {
      const res = await fetch(new URL('/capabilities', config.worker), { headers: { authorization: 'Bearer ' + config.secret }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw fail('Conversion worker unavailable.', 503);
      const text = await res.text(); if (text.length > 512000) throw fail('Invalid worker capabilities.', 502); capability = JSON.parse(text);
    } return capability;
  }
  function session(user) {
    let s = sessions.get(user.id);
    if (!s) { if (sessions.size >= LIMITS.users) throw fail('The server is busy. Try again later.', 503); s = { dir: path.join(root, user.id), files: new Map(), uploads: new Map(), results: new Map(), jobs: new Map(), active: 0, expiry: Date.now() + LIMITS.ttl, email: user.email }; sessions.set(user.id, s); }
    s.expiry = Date.now() + LIMITS.ttl; return s;
  }
  async function remove(s) { for (const item of [...s.files.values(), ...s.results.values()]) stored -= item.size; for (const upload of s.uploads.values()) reserved -= upload.size; s.files.clear(); s.uploads.clear(); s.results.clear(); s.jobs.clear(); await fs.rm(s.dir, { force: true, recursive: true }); }
  const sweep = setInterval(async () => { for (const [id, s] of sessions) if (!s.active && Date.now() > s.expiry) { sessions.delete(id); await remove(s); } }, 30000); sweep.unref();
  function view(s) { return { files: [...s.files.values()].map(f => ({ id: f.id, ...safeMetadata(f) })), jobs: [...s.jobs.values()], history: [...s.results.values()].map(({ path: _, ...r }) => r), expiresInMinutes: 30 }; }
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      // Unauthenticated health carries no app, user, engine, or file details.
      if (req.url === '/health' && req.method === 'GET') { res.end('ok'); return; }
      const user = await authenticate(req); limits.check(user.id + ':requests', 600, 60000);
      const url = new URL(req.url, 'http://localhost'); const s = session(user);
      if (req.method === 'GET' && url.pathname === '/api/state') { send(res, { ...view(s), ...(await capabilities()), user: user.email }); return; }
      if (req.method === 'GET' && url.pathname === '/api/status') { send(res, view(s)); return; }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        limits.check(user.id + ':uploads', 10, 60000); const body = await json(req); const name = filename(body.name), size = body.size;
        if (!Number.isSafeInteger(size) || size < 1 || size > LIMITS.file) throw fail('Files must be between 1 byte and 5 GB.', 413);
        if (s.files.size + s.uploads.size >= LIMITS.files || s.uploads.size >= 2 || stored + reserved + size > LIMITS.storage) throw fail('Upload space is full. Delete previous files or try later.', 503);
        const id = crypto.randomUUID(), target = path.join(s.dir, id); reserved += size; s.uploads.set(id, { id, path: target, name, size, offset: 0, busy: true });
        try { await fs.mkdir(s.dir, { recursive: true, mode: 0o700 }); await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 }); s.uploads.get(id).busy = false; }
        catch (e) { reserved -= size; s.uploads.delete(id); throw e; }
        send(res, { id, chunkSize: LIMITS.chunk }, 201); return;
      }
      if (req.method === 'PUT' && /^\/api\/uploads\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const upload = s.uploads.get(url.pathname.split('/').pop()); if (!upload) throw fail('Upload expired.', 404);
        const offset = Number(req.headers['x-flux-offset']), size = Number(req.headers['content-length']);
        if (upload.busy || offset !== upload.offset || !Number.isSafeInteger(size) || size < 1 || size > LIMITS.chunk || offset + size > upload.size || req.headers['content-type'] !== 'application/octet-stream') throw fail('Invalid upload chunk.', 409);
        if (uploading >= 2) throw fail('Too many simultaneous uploads.', 429);
        upload.busy = true; uploading++; s.active++; const handle = await fs.open(upload.path, 'r+'); let received = 0;
        try { for await (const chunk of req) { received += chunk.length; if (received > size) throw fail('Chunk too large.', 413); await handle.write(chunk, 0, chunk.length, offset + received - chunk.length); } if (received !== size) throw fail('Incomplete chunk.'); upload.offset += size; send(res, { offset: upload.offset }); }
        finally { await handle.close(); upload.busy = false; uploading--; s.active--; } return;
      }
      if (req.method === 'POST' && /^\/api\/uploads\/[a-f0-9-]{36}\/complete$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3], upload = s.uploads.get(id); if (!upload || upload.busy || upload.offset !== upload.size) throw fail('Upload is incomplete.', 409);
        upload.busy = true; s.active++; let committed = false; const jobId = crypto.randomUUID(), job = { id: jobId, fileId: id, fileIds: [id], name: upload.name, operation: 'upload', status: 'queued', createdAt: Date.now() }; s.jobs.set(jobId, job);
        queue.add(async () => {
          job.status = 'running'; const scanMode = await scanner(upload.path); const inspected = await worker({ operation: 'inspect' }, [upload], null, config);
          if (upload.size > LIMITS.scanFull && (!['video', 'audio'].includes(inspected.family) || (!inspected.hasAudio && !inspected.hasVideo))) throw fail('Files above 1.9 GB must be valid audio or video. Documents and archives need full-file malware scanning.', 413);
          const info = { ...safeMetadata(inspected), path: upload.path, name: upload.name, size: upload.size, id, scanMode };
          if (scanMode === 'chunked') info.warning = 'Large media: overlapping signature scans were used. This cannot fully analyze embedded containers.';
          s.files.set(id, info); stored += upload.size; committed = true; job.status = 'done'; job.file = { id, ...safeMetadata(info), scanMode };
        }).catch(e => { job.status = 'error'; job.error = e.status ? e.message : 'The file scan could not finish.'; }).finally(async () => { s.uploads.delete(id); reserved -= upload.size; s.active--; if (!committed) await fs.rm(upload.path, { force: true }); });
        send(res, { id: jobId }, 202); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/files') {
        limits.check(user.id + ':uploads', 10, 60000);
        const size = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(size) || size < 1 || size > LIMITS.scanFull) throw fail('Use chunked uploads for larger files.', 413);
        if (req.headers['content-type'] !== 'application/octet-stream') throw fail('Invalid upload type.');
        let name; try { name = filename(decodeURIComponent(req.headers['x-flux-filename'] || '')); } catch { throw fail('Invalid filename.'); }
        if (s.files.size >= LIMITS.files) throw fail('Maximum 20 files per session.', 413);
        if (uploading >= 2 || stored + reserved + size > LIMITS.storage) throw fail('The server upload space is full. Delete old files or try later.', 503);
        const id = crypto.randomUUID(), target = path.join(s.dir, id); await fs.mkdir(s.dir, { recursive: true, mode: 0o700 });
        reserved += size; uploading++; s.active++; let received = 0, committed = false;
        try {
          const handle = await fs.open(target, 'wx', 0o600);
          try { for await (const chunk of req) { received += chunk.length; if (received > size) throw fail('Upload exceeds its declared size.', 413); await handle.write(chunk); } if (received !== size) throw fail('Upload was incomplete.'); }
          finally { await handle.close(); }
          await scanner(target); const file = { path: target, name, size };
          const inspected = await queue.add(() => worker({ operation: 'inspect' }, [file], null, config));
          const info = { ...safeMetadata(inspected), path: target, name, size, id };
          s.files.set(id, info); stored += size; committed = true; send(res, { id, ...safeMetadata(info) }, 201);
        } finally { reserved -= size; uploading--; s.active--; if (!committed) await fs.rm(target, { force: true }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        limits.check(user.id + ':jobs-minute', 6, 60000); limits.check(user.id + ':jobs-hour', 30, 3600000);
        if (s.active >= 2) throw fail('You already have two uploads or jobs in progress.', 429);
        const spec = await json(req); const op = spec.operation;
        if (!['convert', 'compress', 'pack', 'extract'].includes(op)) throw fail('Unknown operation.');
        const ids = op === 'pack' ? spec.ids : [spec.id];
        if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.files || new Set(ids).size !== ids.length) throw fail('Invalid file selection.');
        const files = ids.map(id => s.files.get(id)); if (files.some(f => !f)) throw fail('That file is missing or expired.', 404);
        if (op === 'pack' && new Set(files.map(f => f.name)).size !== files.length) throw fail('Rename duplicate filenames before creating a ZIP.');
        if (op === 'convert' && !files[0].targets?.includes(spec.target)) throw fail('Unsupported output format.');
        if (op === 'compress' && !files[0].compressionOptions?.some(c => c.id === spec.compression)) throw fail('Unsupported compression option.');
        if (op === 'extract' && files[0].family !== 'archive') throw fail('Choose an archive to extract.');
        if (s.jobs.size >= 100) throw fail('Clear recent jobs before submitting more.', 429);
        const id = crypto.randomUUID(), output = path.join(s.dir, id), job = { id, fileId: spec.id, fileIds: ids, name: files[0].name, operation: op, status: 'queued', createdAt: Date.now() };
        if (stored + reserved + LIMITS.output > LIMITS.storage) throw fail('Insufficient output space. Clear previous results first.', 503);
        reserved += LIMITS.output; s.active++; s.jobs.set(id, job);
        const controller = new AbortController(); Object.defineProperty(job, 'controller', { value: controller });
        queue.add(async () => {
          if (controller.signal.aborted) throw fail('Cancelled.'); job.status = 'running';
          const info = await worker({ operation: op, target: spec.target, compression: spec.compression, options: options(spec.options) }, files, output, config, controller.signal);
          const scanMode = await scanner(output); if (info.size > LIMITS.scanFull && !['mp4','mkv','mov','webm','avi','m4v','mpg','mpeg','flv','3gp','ts','mts','m2ts','vob','wmv','ogv','mp3','wav','flac','aac','m4a','ogg','opus','aiff','aif','wma','amr','ac3','caf'].includes(info.target)) throw fail('Large non-media outputs exceed the full-file scanning limit.', 413);
          if (controller.signal.aborted) throw fail('Cancelled.');
          filename(info.name); const stat = await fs.lstat(output); if (!stat.isFile() || stat.size > LIMITS.output) throw fail('Invalid output.', 502);
          const result = { id, ...info, size: stat.size, path: output, operation: op, scanMode }; stored += stat.size; s.results.set(id, result); job.status = 'done'; job.result = { ...result, path: undefined };
        }).catch(async e => { job.status = controller.signal.aborted ? 'cancelled' : 'error'; job.error = e.status ? e.message : 'The conversion could not finish. Try a smaller file or another format.'; await fs.rm(output, { force: true }); }).finally(() => { reserved -= LIMITS.output; s.active--; });
        send(res, { id }, 202); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') { const body = await json(req); const job = s.jobs.get(body.id); if (job?.controller) job.controller.abort(); send(res, { ok: true }); return; }
      if (req.method === 'DELETE' && url.pathname === '/api/files') { if (s.active) throw fail('Cancel or finish your active jobs before deleting files.', 409); await remove(s); send(res, { ok: true }); return; }
      if (req.method === 'GET' && /^\/api\/download\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const result = s.results.get(url.pathname.split('/').pop()); if (!result) throw fail('That download is missing or expired.', 404);
        const saveName = url.searchParams.has('name') ? filename(url.searchParams.get('name')) : result.name;
        res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', "attachment; filename=\"download\"; filename*=UTF-8''" + encodeURIComponent(saveName)); res.setHeader('Content-Length', result.size);
        // Output HTML, SVG, PDFs and archives never render inline at this origin.
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'"); s.active++;
        try { await pipeline(fss.createReadStream(result.path), res); } finally { s.active--; } return;
      }
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css', '/icon.svg'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'icon.svg': 'image/svg+xml' };
        res.setHeader('Content-Type', types[file]); await pipeline(fss.createReadStream(path.join(__dirname, 'web', file)), res); return;
      }
      throw fail('Not found.', 404);
    } catch (e) { if (res.headersSent) res.destroy(); else send(res, { error: e.status ? e.message : 'The request could not be completed.' }, e.status || 500); }
  });
  server.requestTimeout = 630000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxConnections = 64;
  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return { server, close: async () => { clearInterval(sweep); for (const s of sessions.values()) for (const job of s.jobs.values()) job.controller?.abort(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { force: true, recursive: true }); } };
}
async function main() {
  const config = { issuer: process.env.ACCESS_ISSUER, audience: process.env.ACCESS_AUD, origin: process.env.PUBLIC_ORIGIN, worker: process.env.WORKER_URL || 'http://flux-worker:8090', secret: process.env.WORKER_SECRET };
  if (!config.secret || config.secret.length < 32) throw new Error('A strong worker secret is required.');
  const app = await createApp(config); app.server.listen(8080, '0.0.0.0');
  const stop = async () => { await app.close(); process.exit(0); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { createApp };
