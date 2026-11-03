#!/usr/bin/env node
// Long-session soak: runs hundreds of mixed conversions through the in-process
// engine (electron/engine.cjs, compression.cjs, archives.cjs) and watches memory,
// file handles, child processes and temp space for leaks.
//
//   npm run soak -- --iterations 300 --seed 1 [--concurrency 1] [--out file.json]
//                   [--evidence docs/audit-evidence/<dir>] [--keep]
//
// Everything happens inside one scratch root created under the OS temp folder.
// TMPDIR is pointed into it before the engine loads, so the flux-paths-* aliases
// that io.cjs makes are measured exactly. The root is removed at the end unless
// --keep is given. Exit codes: 0 clean, 1 leak found, 2 setup or harness error.
// This file is deliberately not named *.test.cjs: `npm test` must not run it.
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WARMUP_FRACTION = 0.1;
const FD_SLACK = 5;
const HEAP_SLOPE_LIMIT = 64 * 1024; // bytes per job
const HEAP_RATIO_LIMIT = 1.5;
const GC_EVERY = 10;
const JOB_WATCHDOG_MS = 180000;

// Pure detector. samples: one object per job, in completion order, with
// { job, rss, heapUsed, external, fds, children, tmpEntries, tmpBytes, aliases, stages, gc }.
// The last sample must be taken after all work has finished.
function analyse(samples, opts = {}) {
  const warmupFraction = opts.warmupFraction ?? WARMUP_FRACTION;
  const fdSlack = opts.fdSlack ?? FD_SLACK;
  const slopeLimit = opts.slopeLimit ?? HEAP_SLOPE_LIMIT;
  const heapRatio = opts.heapRatio ?? HEAP_RATIO_LIMIT;
  if (!samples.length) throw new Error('No samples to analyse.');
  const jobs = samples.length;
  const warmup = Math.max(1, Math.floor(jobs * warmupFraction));
  const after = samples.filter((s, i) => i >= warmup);
  const settled = after.filter((s) => s.gc);
  const baseline = settled[0] || after[0] || samples[0];
  const final = samples[jobs - 1];
  let peak = {};
  for (const key of ['rss', 'heapUsed', 'external', 'fds', 'children', 'tmpEntries', 'tmpBytes']) {
    let max = 0;
    for (const s of samples) if (s[key] > max) max = s[key];
    peak[key] = max;
  }
  // Least-squares heap slope over post-warm-up samples taken right after gc();
  // without enough of those, every post-warm-up sample is used.
  const points = settled.length >= 3 ? settled : after;
  let slope = null;
  if (points.length >= 3) {
    let sx = 0,
      sy = 0;
    for (const p of points) {
      sx += p.job;
      sy += p.heapUsed;
    }
    const mx = sx / points.length,
      my = sy / points.length;
    let num = 0,
      den = 0;
    for (const p of points) {
      num += (p.job - mx) * (p.heapUsed - my);
      den += (p.job - mx) ** 2;
    }
    slope = den ? num / den : 0;
  }
  const findings = [];
  if (final.fds - baseline.fds > fdSlack)
    findings.push({
      id: 'fds',
      message: `Open file handles grew from ${baseline.fds} to ${final.fds} (more than ${fdSlack}).`,
    });
  if (final.children > 0)
    findings.push({
      id: 'children',
      message: `${final.children} child process(es) were still alive after the last job.`,
    });
  if (final.aliases > 0)
    findings.push({
      id: 'aliases',
      message: `${final.aliases} flux-paths-* alias folder(s) remain in the temp folder.`,
    });
  if (final.stages > 0)
    findings.push({
      id: 'stages',
      message: `${final.stages} .flux-* stage folder(s) remain in the output folder.`,
    });
  if (final.tmpEntries > baseline.tmpEntries)
    findings.push({
      id: 'temp',
      message: `Temp folder holds ${final.tmpEntries} entries (${final.tmpBytes} bytes), baseline ${baseline.tmpEntries}${final.tmpNames ? `: ${final.tmpNames.join(', ')}` : ''}.`,
    });
  if (slope !== null && slope > slopeLimit && final.heapUsed > heapRatio * baseline.heapUsed)
    findings.push({
      id: 'heap',
      message: `heapUsed grows ${Math.round(slope)} bytes/job after warm-up and ended at ${(final.heapUsed / baseline.heapUsed).toFixed(2)}x baseline.`,
    });
  return {
    leak: findings.length > 0,
    findings,
    warmupJobs: warmup,
    baseline,
    final,
    peak,
    heapSlopeBytesPerJob: slope === null ? null : Math.round(slope),
    rssGrowthBytes: final.rss - baseline.rss,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const opts = { iterations: 300, seed: 1, concurrency: 1, out: null, evidence: null, keep: false };
  const integer = (name, value, min, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value.`);
      return argv[++i];
    };
    if (arg === '--iterations') opts.iterations = integer(arg, value(), 1, 100000);
    else if (arg === '--seed') opts.seed = integer(arg, value(), 0, 4294967295);
    else if (arg === '--concurrency') opts.concurrency = integer(arg, value(), 1, 4);
    else if (arg === '--out') opts.out = path.resolve(value());
    else if (arg === '--evidence') opts.evidence = path.resolve(value());
    else if (arg === '--keep') opts.keep = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  return opts;
}

function exposeGc() {
  if (typeof global.gc === 'function') return global.gc;
  require('node:v8').setFlagsFromString('--expose-gc');
  const gc = require('node:vm').runInNewContext('gc');
  if (typeof gc !== 'function') throw new Error('Garbage collection could not be exposed.');
  return gc;
}

function count(directory, pattern) {
  try {
    return fs.readdirSync(directory).filter((name) => pattern.test(name)).length;
  } catch {
    return 0;
  }
}
function treeSize(directory) {
  let entries = 0,
    bytes = 0;
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      entries++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else
        try {
          bytes += fs.lstatSync(full).size;
        } catch {}
    }
  };
  walk(directory);
  return { entries, bytes };
}
function childCount() {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(process.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

async function makeFixtures(dir, ctx) {
  const { engine, engines, resources } = ctx;
  const sharp = require('sharp');
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const f = {};
  const add = (key, name) => (f[key] = path.join(dir, name));
  await fsp.mkdir(dir, { recursive: true });
  add('png', 'photo.png');
  await sharp({
    create: {
      width: 256,
      height: 192,
      channels: 3,
      background: '#704bba',
      noise: { type: 'gaussian', mean: 128, sigma: 30 },
    },
  })
    .png({ compressionLevel: 0 })
    .toFile(f.png);
  add('jpg', 'photo.jpg');
  await sharp(f.png).jpeg({ quality: 92, optimiseCoding: false }).toFile(f.jpg);
  // The % and [1] make io.cjs toolPaths create a flux-paths-* alias for this source.
  add('percent', 'scan%03d [1].png');
  await fsp.copyFile(f.png, f.percent);
  add('pdf', 'two pages.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of ['Flux soak page one', 'Second page is retained']) {
    const page = doc.addPage([300, 200]);
    page.drawText(text, { x: 20, y: 100, size: 15, font });
  }
  await fsp.writeFile(f.pdf, await doc.save({ useObjectStreams: false }));
  add('md', 'document.md');
  await fsp.writeFile(
    f.md,
    '# Flux soak\n\nA document with a table.\n\n| Name | Value |\n|---|---|\n| Test | 42 |\n',
  );
  add('csv', 'sheet.csv');
  await fsp.writeFile(f.csv, 'Name,Amount\n"Tokyo, Japan",42\nSeoul,99\nLima,7\n');
  add('json', 'records.json');
  await fsp.writeFile(
    f.json,
    JSON.stringify([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
    ]),
  );
  add('yaml', 'records.yaml');
  await fsp.writeFile(f.yaml, 'items:\n  - name: a\n    value: 1\n  - name: b\n    value: 2\n');
  // Corrupt inputs: random bytes under real extensions.
  const rng = mulberry32(99);
  const junk = () => Buffer.from(Array.from({ length: 2048 }, () => Math.floor(rng() * 256)));
  for (const [key, name] of [
    ['badPng', 'corrupt.png'],
    ['badPdf', 'corrupt.pdf'],
    ['badMp4', 'corrupt.mp4'],
  ]) {
    add(key, name);
    await fsp.writeFile(f[key], junk());
  }
  if (engines.ffmpeg) {
    add('mp4', 'movie.mp4');
    await engine.run(engines.ffmpeg, [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=128x96:rate=12',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      f.mp4,
    ]);
    add('wav', 'voice.wav');
    await engine.run(engines.ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=700:duration=2',
      f.wav,
    ]);
  }
  if (engines.pandoc) {
    const file = await engine.inspectFile(f.md, engines, resources);
    const out = path.join(dir, 'made');
    const result = await engine.convert(file, 'docx', out, {}, engines, resources);
    add('docx', 'report.docx');
    await fsp.copyFile(result.path, f.docx);
    await fsp.rm(out, { recursive: true, force: true });
  }
  return f;
}

// Candidate routes. needs: engines that must be present; slow: good targets for aborts.
function candidateRoutes(f) {
  const c = (family, fixture, target, weight, extra = {}) => ({
    family,
    fixture,
    kind: 'convert',
    target,
    weight,
    ...extra,
  });
  const z = (family, fixture, mode, weight, extra = {}) => ({
    family,
    fixture,
    kind: 'compress',
    mode,
    weight,
    ...extra,
  });
  return [
    c('image', 'png', 'jpg', 5),
    c('image', 'png', 'webp', 4),
    c('image', 'png', 'tiff', 3),
    c('image', 'png', 'pdf', 3),
    c('image', 'jpg', 'png', 4),
    c('image', 'jpg', 'avif', 2, { slow: true }),
    c('image', 'png', 'bmp', 2, { needs: [] }),
    z('compress', 'png', 'lossless', 4, { needs: ['oxipng'] }),
    z('compress', 'png', 'lossy', 3, { options: { quality: 'small' } }),
    z('compress', 'jpg', 'lossless', 3, { needs: ['jpegtran'] }),
    z('compress', 'pdf', 'lossless', 3, { needs: ['qpdf'] }),
    z('compress', 'pdf', 'lossy', 2, { needs: ['ghostscript'], slow: true }),
    z('compress', 'mp4', 'lossy', 2, {
      needs: ['ffmpeg'],
      slow: true,
      options: { quality: 'small' },
    }),
    z('compress', 'wav', 'lossy', 2, { needs: ['ffmpeg'], slow: true }),
    z('compress', 'png', 'archive', 3, { needs: ['archive'] }),
    c('pdf', 'pdf', 'png', 4, { needs: ['pdf'], slow: true }),
    c('pdf', 'pdf', 'txt', 3, { needs: ['pdf'] }),
    c('document', 'md', 'docx', 3, { needs: ['pandoc'] }),
    c('document', 'md', 'html', 2, { needs: ['pandoc'] }),
    c('document', 'md', 'epub', 2, { needs: ['pandoc'] }),
    c('document', 'docx', 'txt', 2, { needs: ['pandoc'] }),
    c('document', 'docx', 'pdf', 1, { needs: ['office'], slow: true }),
    c('data', 'csv', 'json', 3),
    c('data', 'csv', 'yaml', 2),
    c('data', 'json', 'csv', 2),
    c('data', 'json', 'yaml', 2),
    c('data', 'yaml', 'json', 2),
    c('data', 'csv', 'xlsx', 1, { needs: ['office'], slow: true }),
    c('media', 'wav', 'mp3', 3, { needs: ['ffmpeg'], slow: true }),
    c('media', 'mp4', 'mp3', 3, { needs: ['ffmpeg'], slow: true }),
    c('media', 'mp4', 'mkv', 2, { needs: ['ffmpeg'], slow: true }),
    c('media', 'wav', 'flac', 2, { needs: ['ffmpeg'] }),
    { family: 'archive', fixture: 'png', kind: 'zip', weight: 5, needs: ['archive'] },
    c('percent-name', 'percent', 'jpg', 5),
    z('percent-name', 'percent', 'lossy', 3, { options: { quality: 'small' } }),
  ].filter((r) => f[r.fixture]);
}

const cancelled = (error) => error && error.code === 'CANCELLED';

async function main(opts) {
  const startedAt = Date.now();
  const hostTmp = os.tmpdir();
  const root = await fsp.mkdtemp(path.join(hostTmp, 'flux-soak-'));
  const tmp = path.join(root, 'tmp'),
    out = path.join(root, 'out'),
    fixtures = path.join(root, 'fixtures');
  await fsp.mkdir(tmp);
  await fsp.mkdir(out);
  // From here on os.tmpdir() points into the scratch root. Load the engine only now.
  process.env.TMPDIR = tmp;
  const repo = path.resolve(__dirname, '..');
  const result = { harnessErrors: [] };
  let exit = 0;
  try {
    const gc = exposeGc();
    const engine = require('../electron/engine.cjs');
    const { compress, compressionOptions } = require('../electron/compression.cjs');
    const { archiveFiles } = require('../electron/archives.cjs');
    const resources = path.join(repo, 'resources');
    const engines = await engine.detectEngines(resources);
    const ctx = { engine, engines, resources };
    const files = await makeFixtures(fixtures, ctx);

    // Keep only routes the detected engines allow; record why the others are skipped.
    const routes = [],
      skipped = [];
    const inspected = {};
    for (const route of candidateRoutes(files)) {
      const label = `${route.family}:${path.basename(files[route.fixture])}->${route.target || route.mode || 'zip'}`;
      const missing = (route.needs || []).filter((need) => !engines[need]);
      if (missing.length) {
        skipped.push({ route: label, reason: `engine not found: ${missing.join(', ')}` });
        continue;
      }
      inspected[route.fixture] ||= await engine.inspectFile(
        files[route.fixture],
        engines,
        resources,
      );
      const file = inspected[route.fixture];
      const allowed =
        route.kind === 'convert'
          ? engine.catalog.targets(file, engines).includes(route.target)
          : route.kind === 'compress'
            ? compressionOptions(file, engines).some((o) => o.id === route.mode)
            : Boolean(engines.archive);
      if (!allowed) {
        skipped.push({
          route: label,
          reason: 'not offered by the catalog with the detected engines',
        });
        continue;
      }
      route.label = label;
      routes.push(route);
    }
    if (!routes.length) throw new Error('No conversion route is available.');
    const corrupt = [
      ['badPng', 'jpg'],
      ['badPdf', 'png'],
      ['badMp4', 'mp3'],
    ]
      .filter(([key, target]) => {
        if (key === 'badPdf') return Boolean(engines.pdf);
        if (key === 'badMp4') return Boolean(engines.ffmpeg);
        return Boolean(target);
      })
      .map(([fixture, target]) => ({
        family: 'corrupt',
        fixture,
        kind: 'convert',
        target,
        label: `corrupt:${path.basename(files[fixture])}->${target}`,
      }));

    // Deterministic plan: ~3% corrupt inputs, ~5% aborted jobs, the rest weighted.
    const rng = mulberry32(opts.seed);
    const pick = (list) => {
      const total = list.reduce((sum, r) => sum + (r.weight || 1), 0);
      let x = rng() * total;
      for (const r of list) if ((x -= r.weight || 1) < 0) return r;
      return list[list.length - 1];
    };
    const slowRoutes = routes.filter((r) => r.slow);
    const plan = [];
    for (let i = 0; i < opts.iterations; i++) {
      const roll = rng();
      if (roll < 0.03) plan.push({ route: pick(corrupt), mode: 'corrupt' });
      else if (roll < 0.08)
        plan.push({
          route: pick(slowRoutes.length ? slowRoutes : routes),
          mode: 'abort',
          abortAfterMs: rng() < 0.1 ? 0 : 20 + Math.floor(rng() * 280),
        });
      else plan.push({ route: pick(routes), mode: 'normal' });
    }

    const runJob = async (item, signal) => {
      const { route } = item;
      const source = files[route.fixture];
      const file = await engine.inspectFile(source, engines, resources, { signal });
      if (route.kind === 'convert')
        return engine.convert(file, route.target, out, route.options || {}, engines, resources, {
          signal,
        });
      if (route.kind === 'compress')
        return compress(file, route.mode, out, route.options || {}, engines, resources, { signal });
      return archiveFiles(
        [files.png, files.md, files.csv].map((p) => ({ path: p, name: path.basename(p) })),
        'pack',
        out,
        engines,
        resources,
        { signal },
      );
    };

    const samples = [],
      counts = { ok: 0, failedExpected: 0, unexpectedFailure: 0, cancelled: 0 },
      families = {},
      unexpected = [];
    let corruptAccepted = 0,
      abortedTooLate = 0,
      next = 0,
      finished = 0;
    const take = (job, force, label) => {
      if (force) gc();
      const memory = process.memoryUsage();
      const size = treeSize(tmp);
      return {
        job,
        t: Date.now() - startedAt,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        fds: fs.readdirSync('/dev/fd').length,
        children: childCount(),
        tmpEntries: size.entries,
        tmpBytes: size.bytes,
        aliases: count(tmp, /^flux-paths-/),
        stages: count(out, /^\.flux-/),
        gc: Boolean(force),
        ...(label && { route: label }),
      };
    };
    const worker = async () => {
      while (next < plan.length) {
        const index = next++;
        const item = plan[index];
        const controller = new AbortController();
        let timer,
          watchdog,
          timedOut = false,
          outcome,
          note;
        if (item.mode === 'abort') {
          if (item.abortAfterMs) timer = setTimeout(() => controller.abort(), item.abortAfterMs);
          else controller.abort();
        }
        watchdog = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, JOB_WATCHDOG_MS);
        try {
          const done = await runJob(item, controller.signal);
          outcome = 'ok';
          if (item.mode === 'corrupt') corruptAccepted++;
          if (item.mode === 'abort') abortedTooLate++;
          const resolved = path.resolve(done.path);
          if (resolved.startsWith(out + path.sep))
            await fsp.rm(resolved, { recursive: true, force: true });
        } catch (error) {
          if (timedOut) {
            outcome = 'unexpectedFailure';
            note = 'Job exceeded the soak watchdog.';
          } else if (cancelled(error) && item.mode === 'abort') outcome = 'cancelled';
          else if (item.mode === 'corrupt') outcome = 'failedExpected';
          else {
            outcome = 'unexpectedFailure';
            note = String(error && error.message).slice(0, 300);
          }
        } finally {
          clearTimeout(timer);
          clearTimeout(watchdog);
        }
        counts[outcome]++;
        const family = (families[item.route.family] ||= {
          ok: 0,
          failedExpected: 0,
          unexpectedFailure: 0,
          cancelled: 0,
        });
        family[outcome]++;
        if (outcome === 'unexpectedFailure' && unexpected.length < 20)
          unexpected.push({ job: index, route: item.route.label, mode: item.mode, message: note });
        finished++;
        const s = take(finished, finished % GC_EVERY === 0, item.route.label);
        s.outcome = outcome;
        samples.push(s);
        if (finished % 25 === 0 || finished === plan.length)
          console.error(
            `soak: ${finished}/${plan.length} jobs, rss ${(s.rss / 1048576).toFixed(0)} MiB, heap ${(s.heapUsed / 1048576).toFixed(1)} MiB, fds ${s.fds}`,
          );
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: opts.concurrency }, () => worker()),
    );
    for (const r of settled)
      if (r.status === 'rejected') result.harnessErrors.push(String(r.reason?.stack || r.reason));
    if (result.harnessErrors.length) throw new Error('A soak worker failed (see harnessErrors).');

    // Let engine children be reaped, then take the final, post-gc sample.
    for (let wait = 0; wait < 6 && childCount() > 0; wait++)
      await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 300));
    const last = take(finished, true, 'final');
    last.outcome = 'final';
    // Names of whatever is left behind, so a temp finding can be traced to its source.
    last.tmpNames = fs.readdirSync(tmp).sort().slice(0, 20);
    last.job = finished + 1;
    samples.push(last);

    const analysis = analyse(samples);
    Object.assign(result, {
      options: opts,
      environment: {
        node: process.version,
        arch: process.arch,
        platform: process.platform,
        darwin: os.release(),
        sharp: require('sharp').versions.sharp,
        engines: Object.keys(engines)
          .filter(
            (k) =>
              typeof engines[k] === 'string' &&
              !['data', 'images', 'resources', 'officeInputs'].includes(k),
          )
          .sort(),
      },
      iterationsPlanned: opts.iterations,
      iterationsCompleted: finished,
      wallMs: Date.now() - startedAt,
      counts,
      corruptAccepted,
      abortedFinishedBeforeAbort: abortedTooLate,
      families,
      routes: routes.map((r) => r.label),
      skipped,
      unexpected,
      analysis,
      samples,
    });
    exit = analysis.leak ? 1 : 0;
    // The final sample is job finished+1; keep outcome counts independent of it.
  } catch (error) {
    result.setupError = String(error && error.message);
    if (error && error.stack) result.harnessErrors.push(error.stack);
    exit = 2;
  } finally {
    if (!opts.keep) {
      // Only ever remove the folder this run created.
      if (path.dirname(root) === hostTmp && path.basename(root).startsWith('flux-soak-'))
        await fsp.rm(root, { recursive: true, force: true });
    }
  }
  result.scratchRoot = root;
  result.scratchKept = Boolean(opts.keep);
  result.repo = repo;
  return { exit, result };
}

// Replaces anything identifying this machine or user before results are saved.
function sanitise(text, result) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const host = os.hostname().replace(/\.local$/, '');
  let value = text;
  const replace = (needle, token) => {
    if (needle && needle.length >= 3) value = value.split(needle).join(token);
  };
  replace(result.scratchRoot, '<SCRATCH>');
  replace(result.repo, '<REPO>');
  replace(home, '<HOME>');
  value = value.replace(/\/(?:private\/)?var\/folders\/[^\s"'\\]+/g, '<TMPROOT>');
  value = value.replace(/\/Users\/[^/\s"'\\]+/g, '/Users/<USER>');
  replace(user, '<USER>');
  replace(host, '<HOST>');
  return value;
}

function evidence(result) {
  const a = result.analysis;
  const keys = [
    'job',
    't',
    'rss',
    'heapUsed',
    'external',
    'fds',
    'children',
    'tmpEntries',
    'tmpBytes',
    'aliases',
    'stages',
  ];
  const trim = (s) =>
    Object.fromEntries([...keys, ...(s.tmpNames ? ['tmpNames'] : [])].map((k) => [k, s[k]]));
  return {
    summary: {
      leak: a.leak,
      findings: a.findings,
      iterationsPlanned: result.iterationsPlanned,
      iterationsCompleted: result.iterationsCompleted,
      wallMs: result.wallMs,
      counts: result.counts,
      corruptAccepted: result.corruptAccepted,
      abortedFinishedBeforeAbort: result.abortedFinishedBeforeAbort,
      warmupJobs: a.warmupJobs,
      heapSlopeBytesPerJob: a.heapSlopeBytesPerJob,
      rssGrowthBytes: a.rssGrowthBytes,
    },
    options: {
      iterations: result.options.iterations,
      seed: result.options.seed,
      concurrency: result.options.concurrency,
    },
    environment: result.environment,
    families: result.families,
    skipped: result.skipped,
    unexpectedFailures: result.unexpected,
    baseline: trim(a.baseline),
    final: trim(a.final),
    peak: a.peak,
    samplesEvery10th: result.samples.filter((s) => s.job % 10 === 0).map(trim),
  };
}

function summaryText(result) {
  const a = result.analysis,
    c = result.counts,
    e = result.environment;
  const mib = (n) => (n / 1048576).toFixed(1);
  return [
    'Flux long-session soak (FLUX-BL-012)',
    '',
    `Command: npm run soak -- --iterations ${result.options.iterations} --seed ${result.options.seed} --concurrency ${result.options.concurrency}`,
    `Node ${e.node}, ${e.arch} ${e.platform} (Darwin ${e.darwin}), sharp ${e.sharp}`,
    `Engines found: ${e.engines.join(', ')}`,
    result.skipped.length
      ? `Skipped routes: ${result.skipped.map((s) => `${s.route} (${s.reason})`).join('; ')}`
      : 'Skipped routes: none',
    `Iterations: ${result.iterationsCompleted} of ${result.iterationsPlanned} completed`,
    `Wall time: ${(result.wallMs / 1000).toFixed(1)} s`,
    `Outcomes: ok ${c.ok}, failed as expected ${c.failedExpected}, unexpected failure ${c.unexpectedFailure}, cancelled ${c.cancelled}` +
      ` (corrupt inputs accepted: ${result.corruptAccepted}; aborted jobs that finished first: ${result.abortedFinishedBeforeAbort})`,
    `Baseline (job ${a.baseline.job}): rss ${mib(a.baseline.rss)} MiB, heapUsed ${mib(a.baseline.heapUsed)} MiB, fds ${a.baseline.fds}, tmp entries ${a.baseline.tmpEntries}`,
    `Final: rss ${mib(a.final.rss)} MiB, heapUsed ${mib(a.final.heapUsed)} MiB, fds ${a.final.fds}, children ${a.final.children}, tmp entries ${a.final.tmpEntries} (${a.final.tmpBytes} bytes), flux-paths-* ${a.final.aliases}, stages ${a.final.stages}`,
    `Peak: rss ${mib(a.peak.rss)} MiB, heapUsed ${mib(a.peak.heapUsed)} MiB, fds ${a.peak.fds}, children ${a.peak.children}, tmp entries ${a.peak.tmpEntries}, tmp bytes ${a.peak.tmpBytes}`,
    `Heap slope after warm-up (${a.warmupJobs} jobs): ${a.heapSlopeBytesPerJob} bytes/job; rss change ${mib(a.rssGrowthBytes)} MiB (reported only, never a finding alone)`,
    '',
    a.leak
      ? 'Findings:\n' + a.findings.map((f) => `- ${f.id}: ${f.message}`).join('\n')
      : 'No leak found by the detector.',
    '',
    'Limits: this exercises the in-process Electron engine driven from Node, one run, one seed.',
    'The server isolates every job in a supervised worker and the native Mac app uses OfflineKit; neither was soaked.',
    'Samples are taken after each job finishes, so with --concurrency above 1 the baseline can include in-flight work.',
    ...(result.skipped.length ? ['Skipped routes above were not exercised in this run.'] : []),
    'RSS includes native allocator caches (sharp/libvips), so it is reported but not a finding by itself.',
    '',
  ].join('\n');
}

async function cli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`soak: ${error.message}`);
    console.error(
      'usage: soak.cjs [--iterations N] [--seed N] [--concurrency 1-4] [--out file.json] [--evidence dir] [--keep]',
    );
    return 2;
  }
  const { exit, result } = await main(opts);
  if (exit === 2) {
    console.error(`soak: setup failed: ${result.setupError}`);
    for (const e of result.harnessErrors) console.error(sanitise(e, result));
    return 2;
  }
  try {
    if (opts.out) {
      await fsp.mkdir(path.dirname(opts.out), { recursive: true });
      await fsp.writeFile(opts.out, sanitise(JSON.stringify(result, null, 1), result) + '\n');
    }
    if (opts.evidence) {
      await fsp.mkdir(opts.evidence, { recursive: true });
      await fsp.writeFile(
        path.join(opts.evidence, 'soak.json'),
        sanitise(JSON.stringify(evidence(result), null, 1), result) + '\n',
      );
      await fsp.writeFile(
        path.join(opts.evidence, 'summary.txt'),
        sanitise(summaryText(result), result),
      );
    }
  } catch (error) {
    console.error(`soak: could not write results: ${error.message}`);
    return 2;
  }
  console.error(sanitise(summaryText(result), result));
  return exit;
}

module.exports = { analyse, parseArgs, mulberry32 };
if (require.main === module)
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`soak: ${error.stack || error}`);
      process.exit(2);
    },
  );
