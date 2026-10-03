const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const YAML = require('yaml');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const catalog = require('./catalog.cjs');
const HOME = os.homedir();
const cancelled = () => Object.assign(new Error('Conversion cancelled.'), { code: 'CANCELLED' });
function run(command, args, { signal, onLine, timeout = 30 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    let stdout = '',
      stderr = '',
      pending = '',
      timedOut = false;
    if (process.env.FLUX_SERVER === '1') {
      timeout = Math.min(timeout, 600000);
      if (/^(ffmpeg|ffprobe)$/.test(path.basename(command)))
        args = ['-protocol_whitelist', 'file,pipe', '-threads', '1', ...args];
      if (path.basename(command) === 'pandoc') args = ['--sandbox', ...args];
    }
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      },
    });
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeout);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    const consume = (buffer, isErr) => {
      const text = buffer.toString();
      if (isErr) stderr = (stderr + text).slice(-100000);
      else stdout = (stdout + text).slice(-1000000);
      pending += text;
      const lines = pending.split(/[\r\n]+/);
      pending = lines.pop();
      lines.forEach((line) => onLine?.(line));
    };
    child.stdout.on('data', (x) => consume(x, false));
    child.stderr.on('data', (x) => consume(x, true));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(cancelled());
      if (timedOut) return reject(new Error('Conversion exceeded the 30 minute time limit.'));
      if (code !== 0)
        return reject(
          new Error(
            (stderr.trim() || stdout.trim() || `Conversion engine exited with code ${code}.`).slice(
              -1600,
            ),
          ),
        );
      resolve({ stdout, stderr });
    });
  });
}
async function findExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await fs.access(candidate, fss.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
async function detectEngines(resources = path.join(__dirname, '..', 'resources')) {
  const cache = path.join(HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies');
  const [ffmpeg, ffprobe, office, pandoc, pdf, archive] = await Promise.all([
    findExecutable([
      '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
    ]),
    findExecutable([
      '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe',
      '/opt/homebrew/bin/ffprobe',
      '/usr/local/bin/ffprobe',
      '/usr/bin/ffprobe',
    ]),
    findExecutable([
      path.join(resources, 'libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice'),
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/opt/homebrew/bin/soffice',
      '/usr/bin/soffice',
      path.join(
        cache,
        'native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice',
      ),
    ]),
    findExecutable(['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc', '/usr/bin/pandoc']),
    findExecutable([path.join(resources, 'pdf-tool')]),
    findExecutable([
      '/opt/homebrew/bin/python3',
      '/opt/homebrew/bin/python3.12',
      '/usr/bin/python3',
    ]),
  ]);
  const extras = {};
  for (const [key, name] of Object.entries({
    qpdf: 'qpdf',
    ghostscript: 'gs',
    jpegtran: 'jpegtran',
    oxipng: 'oxipng',
    cwebp: 'cwebp',
    magick: 'magick',
    sevenzip: '7zz',
  })) {
    extras[key] = await findExecutable([
      ...(key === 'magick' ? ['/opt/homebrew/opt/imagemagick-full/bin/magick'] : []),
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ]);
  }
  extras.python = await findExecutable([
    path.join(resources, 'python-runtime/bin/python'),
    '/opt/venv/bin/python',
  ]);
  extras.tesseract = await findExecutable([
    '/opt/homebrew/bin/tesseract',
    '/usr/local/bin/tesseract',
    '/usr/bin/tesseract',
  ]);
  extras.calibre = await findExecutable([
    '/Applications/calibre.app/Contents/MacOS/ebook-convert',
    '/usr/bin/ebook-convert',
  ]);
  extras.blender = await findExecutable([
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender',
  ]);
  const registry = { images: [], media: [], documents: [] };
  if (office)
    try {
      extras.officeInputs = JSON.parse(
        await fs.readFile(path.join(resources, 'office-formats.json'), 'utf8'),
      );
      registry.office = extras.officeInputs;
    } catch {}
  if (extras.magick) {
    const listing = (await run(extras.magick, ['-list', 'format'], { timeout: 30000 })).stdout;
    const pseudo = new Set(
      'art caption canvas clipboard clip CMYK CMYKA gray graya gradient histogram http https inline label msl mvg null pango pattern plasma preview rgb rgba rgbo shtml stegano strimg text tile txt url vid x xc ycbcr ycbcra'
        .toLowerCase()
        .split(' '),
    );
    extras.imageWrite = [];
    extras.imageRead = [];
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s*([\w]+)\*?\s+(\S+)\s+([r-][w-][+-])/);
      if (!m) continue;
      const ext = m[1].toLowerCase();
      if (pseudo.has(ext) || m[2] === 'VIDEO') continue;
      if (m[3][0] === 'r') {
        registry.images.push(ext);
        extras.imageRead.push(ext);
      }
      if (m[3][1] === 'w') extras.imageWrite.push(ext);
    }
  }
  if (ffmpeg) {
    const listing = (await run(ffmpeg, ['-hide_banner', '-demuxers'], { timeout: 15000 })).stdout;
    const pseudo =
      /^(lavfi|concat|image2|image2pipe|sdp|hls|dash|tty|bin|data|fbdev|oss|pulse|alsa|avfoundation|openal|v4l2|x11grab|gdigrab|dshow|decklink)$/;
    for (const line of listing.split('\n')) {
      const m = line.match(/^\s*D\s+(\S+)\s+(.+)/);
      if (!m) continue;
      for (const ext of m[1].split(','))
        if (!pseudo.test(ext) && /^[a-z0-9_]+$/.test(ext))
          registry.media.push({
            ext,
            audio: /audio|sound|pcm|music|flac|mp3|vorbis|opus|wave/i.test(m[2]),
            subtitle: /subtitle|caption|subrip|sami|microdvd|ttml/i.test(m[2]),
          });
    }
  }
  if (pandoc) {
    extras.documentInputs = (await run(pandoc, ['--list-input-formats'], { timeout: 15000 })).stdout
      .trim()
      .split('\n');
    registry.documents = extras.documentInputs.filter((t) => !['json', 'native'].includes(t));
  }
  catalog.extend(registry);
  return {
    ffmpeg,
    ffprobe,
    office,
    pandoc,
    pdf,
    archive: extras.python || archive,
    images: true,
    data: true,
    resources,
    ...extras,
  };
}
function displayError(error) {
  const message = error.message || String(error);
  if (
    /Invalid data found|could not find codec|does not contain any stream|unsupported image|Input buffer|corrupt|Vips/i.test(
      message,
    )
  )
    return 'This file could not be decoded. It may be damaged or use an unsupported codec.';
  return message;
}
async function inspectFile(filePath, engines, resources) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Choose files, rather than folders.');
  const name = path.basename(filePath),
    ext = catalog.extension(name);
  let group = catalog.family(ext);
  let detected;
  if (!group) {
    try {
      const meta = await sharp(filePath).metadata();
      group = { id: 'image' };
      detected = meta.format;
    } catch {}
    if (!group && engines.ffprobe)
      try {
        const probe = JSON.parse(
          (
            await run(engines.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', filePath], {
              timeout: 8000,
            })
          ).stdout,
        );
        if (probe.streams.some((s) => s.codec_type === 'video')) group = { id: 'video' };
        else if (probe.streams.some((s) => s.codec_type === 'audio')) group = { id: 'audio' };
      } catch {}
    if (!group)
      try {
        const mime = (
          await run('/usr/bin/file', ['--mime-type', '-b', filePath], { timeout: 5000 })
        ).stdout.trim();
        if (mime === 'application/pdf') group = { id: 'pdf' };
        else if (mime.startsWith('text/')) {
          group = { id: 'document' };
          detected = 'txt';
        }
      } catch {}
  }
  const info = {
    path: filePath,
    name,
    ext,
    size: stat.size,
    family: group?.id || 'unsupported',
    detected,
    details: '',
    warning: '',
  };
  if (!group)
    return {
      ...info,
      targets: [],
      warning: 'No installed engine can decode this file. ZIP packaging is still available.',
    };
  try {
    if (group.id === 'image') {
      if (!['heic', 'heif', 'bmp', 'ico'].includes(ext)) {
        try {
          const meta = await sharp(filePath).metadata();
          info.details = `${meta.width} × ${meta.height}`;
        } catch (error) {
          if (!engines.magick) throw error;
          info.details = (
            await run(
              engines.magick,
              ['identify', '-ping', '-format', '%w × %h', filePath + '[0]'],
              { timeout: 30000 },
            )
          ).stdout;
        }
      }
      if (stat.size < 1) throw new Error('This file is empty.');
    }
    if (['audio', 'video'].includes(group.id) && engines.ffprobe) {
      const result = await run(
        engines.ffprobe,
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
        { timeout: 15000 },
      );
      const meta = JSON.parse(result.stdout);
      info.duration = Number(meta.format?.duration) || 0;
      info.hasAudio = meta.streams.some((s) => s.codec_type === 'audio');
      info.hasVideo = meta.streams.some(
        (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
      );
      const video = meta.streams.find((s) => s.codec_type === 'video');
      info.pixelFormat = video?.pix_fmt;
      info.details =
        video && info.hasVideo
          ? `${video.width} × ${video.height}`
          : `${Math.round(info.duration)} seconds`;
      if (!info.hasAudio && !info.hasVideo)
        throw new Error('No convertible media streams were found.');
    }
    if (group.id === 'pdf' && engines.pdf) {
      const result = await run(engines.pdf, ['inspect', filePath], { timeout: 15000 });
      info.pages = JSON.parse(result.stdout).pages;
      info.details = `${info.pages} page${info.pages === 1 ? '' : 's'}`;
    }
    if (group.id === 'font' && engines.python)
      info.outline = JSON.parse(
        (
          await run(
            engines.python,
            [path.join(resources, 'advanced.py'), 'font-inspect', filePath],
            { timeout: 15000 },
          )
        ).stdout,
      ).outline;
    info.targets = catalog.targets(info, engines);
    if (!info.targets.length)
      info.warning = 'The conversion engine for this format is unavailable. Check Settings.';
  } catch (e) {
    info.warning = displayError(e);
    info.targets = [];
  }
  return info;
}
async function bmp(buffer) {
  const { data, info } = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = Math.ceil((info.width * 3) / 4) * 4,
    bytes = stride * info.height;
  const out = Buffer.alloc(54 + bytes);
  out.write('BM');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(info.width, 18);
  out.writeInt32LE(info.height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(bytes, 34);
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * info.channels,
        d = 54 + (info.height - 1 - y) * stride + x * 3;
      out[d] = data[s + 2];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s];
    }
  return out;
}
async function image(input, target, out, stage, options, engines, signal) {
  let source = input;
  const sharpTargets = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf', 'svg'];
  if (!sharpTargets.includes(target)) {
    if (!engines.magick) throw new Error('ImageMagick is needed for this image format.');
    const args = [
      '-limit',
      'memory',
      '512MiB',
      '-limit',
      'disk',
      '2GiB',
      input + '[0]',
      '-auto-orient',
    ];
    if (options.width) args.push('-resize', `${options.width}x>`);
    args.push(
      '-quality',
      options.quality === 'high' ? '95' : options.quality === 'small' ? '65' : '85',
      out,
    );
    await run(engines.magick, args, { signal });
    return;
  }
  if (['heic', 'heif', 'bmp', 'ico'].includes(catalog.extension(input))) {
    source = path.join(stage, 'decoded.png');
    if (catalog.extension(input) === 'ico') {
      if (!engines.ffmpeg) throw new Error('FFmpeg is needed to decode ICO files.');
      await run(
        engines.ffmpeg,
        ['-nostdin', '-y', '-v', 'error', '-i', input, '-frames:v', '1', source],
        { signal },
      );
    } else await run('/usr/bin/sips', ['-s', 'format', 'png', input, '--out', source], { signal });
  }
  try {
    await sharp(source).metadata();
  } catch (error) {
    if (!engines.magick) throw error;
    source = path.join(stage, 'normalized.png');
    await run(
      engines.magick,
      ['-limit', 'memory', '512MiB', '-limit', 'disk', '2GiB', input + '[0]', source],
      { signal },
    );
  }
  let pipeline = sharp(source, { limitInputPixels: 100000000 }).rotate();
  if (options.width) pipeline = pipeline.resize({ width: options.width, withoutEnlargement: true });
  const quality = options.quality === 'high' ? 95 : options.quality === 'small' ? 65 : 85;
  if (target === 'svg') {
    const normalized = await pipeline.png().toBuffer();
    const meta = await sharp(normalized).metadata();
    await fs.writeFile(
      out,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}" viewBox="0 0 ${meta.width} ${meta.height}"><image width="${meta.width}" height="${meta.height}" href="data:image/png;base64,${normalized.toString('base64')}"/></svg>`,
    );
    return;
  }
  if (target === 'pdf') {
    const normalized = await pipeline.png().toBuffer();
    const doc = await PDFDocument.create();
    const embed = await doc.embedPng(normalized);
    const dimensions = embed.scale(Math.min(1, 14400 / Math.max(embed.width, embed.height)));
    const page = doc.addPage([dimensions.width, dimensions.height]);
    page.drawImage(embed, { x: 0, y: 0, ...dimensions });
    await fs.writeFile(out, await doc.save());
    return;
  }
  if (target === 'bmp') {
    await fs.writeFile(out, await bmp(await pipeline.png().toBuffer()));
    return;
  }
  if (target === 'ico') {
    const png = await pipeline
      .resize({
        width: 256,
        height: 256,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[8] = 0;
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    await fs.writeFile(out, Buffer.concat([header, png]));
    return;
  }
  if (target === 'jpg')
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
  else if (target === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
  else if (target === 'tiff') pipeline = pipeline.tiff({ compression: 'lzw' });
  else pipeline = pipeline.toFormat(target, { quality });
  await pipeline.toFile(out);
}
const audioCodecs = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '192k'],
  wav: ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
  aac: ['-c:a', 'aac', '-b:a', '192k'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-c:a', 'pcm_s16be'],
  wma: ['-c:a', 'wmav2', '-b:a', '192k'],
  ac3: ['-c:a', 'ac3', '-b:a', '192k'],
  caf: ['-c:a', 'pcm_s16le'],
};
async function media(file, target, out, options, engines, signal, progress) {
  const quality = options.quality === 'high' ? '18' : options.quality === 'small' ? '30' : '23';
  let args = ['-nostdin', '-y', '-v', 'error', '-i', file.path];
  if (audioCodecs[target]) args.push('-map', '0:a:0', '-vn', ...audioCodecs[target]);
  else if (['jpg', 'png'].includes(target)) args.push('-map', '0:v:0', '-frames:v', '1');
  else if (target === 'gif')
    args.push(
      '-t',
      '15',
      '-filter_complex',
      '[0:v]fps=12,scale=w=min(720\\,iw):h=-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
      '-an',
    );
  else {
    args.push(
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      `scale=${options.width ? `min(${options.width}\\,iw)` : 'trunc(iw/2)*2'}:-2`,
    );
    if (target === 'webm')
      args.push(
        '-c:v',
        'libvpx-vp9',
        '-crf',
        quality,
        '-b:v',
        '0',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-c:a',
        'libopus',
      );
    else if (target === 'avi') args.push('-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame');
    else if (target === 'mpeg')
      args.push('-c:v', 'mpeg2video', '-q:v', '4', '-c:a', 'mp2', '-ar', '48000');
    else if (target === 'flv')
      args.push('-c:v', 'flv', '-q:v', '4', '-c:a', 'libmp3lame', '-ar', '44100');
    else if (target === 'wmv') args.push('-c:v', 'wmv2', '-q:v', '4', '-c:a', 'wmav2');
    else {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        quality,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
      );
      if (['mp4', 'mov'].includes(target)) args.push('-movflags', '+faststart');
    }
  }
  args.push('-progress', 'pipe:1', '-nostats', out);
  await run(engines.ffmpeg, args, {
    signal,
    onLine: (line) => {
      if (line.startsWith('out_time_us=') && file.duration)
        progress(Math.min(95, 5 + (Number(line.split('=')[1]) / 1000000 / file.duration) * 90));
    },
  });
}
function escapeHTML(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
async function officeConvert(input, target, stage, engines, signal, group = 'document') {
  const dir = await fs.mkdtemp(path.join(stage, 'office-'));
  const profile = await fs.mkdtemp(path.join(stage, 'profile-'));
  if (process.env.FLUX_SERVER === '1') {
    await fs.writeFile(
      path.join(profile, 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>',
    );
  }
  const filters = {
    document: {
      pdf: 'pdf:writer_pdf_Export',
      docx: 'docx:Office Open XML Text',
      doc: 'doc:MS Word 97',
      odt: 'odt:writer8',
      rtf: 'rtf:Rich Text Format',
      txt: 'txt:Text (encoded)',
      html: 'html:HTML (StarWriter)',
    },
    spreadsheet: {
      pdf: 'pdf:calc_pdf_Export',
      xlsx: 'xlsx:Calc MS Excel 2007 XML',
      xls: 'xls:MS Excel 97',
      ods: 'ods:calc8',
      csv: 'csv:Text - txt - csv (StarCalc):44,34,76,1',
      tsv: 'csv:Text - txt - csv (StarCalc):9,34,76,1',
      html: 'html:HTML (StarCalc)',
    },
    presentation: {
      pdf: 'pdf:impress_pdf_Export',
      pptx: 'pptx:Impress MS PowerPoint 2007 XML',
      ppt: 'ppt:MS PowerPoint 97',
      odp: 'odp:impress8',
    },
  };
  filters.drawing = {
    pdf: 'pdf:draw_pdf_Export',
    svg: 'svg:draw_svg_Export',
    png: 'png:draw_png_Export',
  };
  const filter = filters[group]?.[target];
  if (!filter) throw new Error('No valid Office export is available for this format.');
  await run(
    engines.office,
    [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--norestore',
      '--convert-to',
      filter,
      '--outdir',
      dir,
      input,
    ],
    { signal },
  );
  const ext = target === 'tsv' ? 'csv' : target;
  const file = (await fs.readdir(dir)).find((f) => f.toLowerCase().endsWith('.' + ext));
  if (!file)
    throw new Error(
      'The Office engine could not export this document. It may be damaged, password-protected, or unsupported.',
    );
  return path.join(dir, file);
}
async function document(file, target, out, stage, engines, signal) {
  const ext = file.detected || file.ext;
  if (ext === 'txt' && target === 'txt') {
    await fs.copyFile(file.path, out);
    return;
  }
  if (['mobi', 'azw3'].includes(target)) {
    await run(engines.calibre, [file.path, out], { signal });
    return;
  }
  const pandocFrom = {
    txt: 'markdown',
    md: 'markdown',
    markdown: 'markdown',
    html: 'html',
    htm: 'html',
    tex: 'latex',
    latex: 'latex',
  };
  const pandocTo = { txt: 'plain', md: 'gfm', html: 'html5', tex: 'latex' };
  const directOffice =
    (catalog.officeDocs.includes(ext) || engines.officeInputs?.document?.includes(ext)) &&
    ['doc', 'docx', 'odt', 'rtf', 'pdf'].includes(target);
  if (directOffice || !engines.pandoc) {
    const result = await officeConvert(file.path, target, stage, engines, signal);
    await fs.copyFile(result, out);
    return;
  }
  let input = file.path,
    inputType = pandocFrom[ext] || ext;
  if (ext === 'txt') {
    input = path.join(stage, 'literal.html');
    inputType = 'html';
    await fs.writeFile(
      input,
      `<html><head><meta charset="utf-8"></head><body><pre>${escapeHTML(await fs.readFile(file.path, 'utf8'))}</pre></body></html>`,
    );
  }
  if (!catalog.pandocInputs.includes(ext) && !engines.documentInputs?.includes(ext)) {
    input = await officeConvert(file.path, 'docx', stage, engines, signal);
    inputType = 'docx';
  }
  const intermediate = target === 'pdf' ? path.join(stage, 'document.docx') : out;
  const args = [
    input,
    '--from',
    inputType,
    '--to',
    target === 'pdf' ? 'docx' : pandocTo[target] || target,
    '--standalone',
    '--resource-path',
    path.dirname(input),
    '--output',
    intermediate,
  ];
  if (target === 'html')
    args.push('--embed-resources', '--extract-media', path.join(stage, 'media'));
  await run(engines.pandoc, args, { signal });
  if (target === 'pdf')
    await fs.copyFile(await officeConvert(intermediate, 'pdf', stage, engines, signal), out);
}
async function pdf(file, target, out, stage, options, engines, signal, progress) {
  if (target === 'docx' && engines.python) {
    await run(
      engines.python,
      [path.join(engines.resources, 'advanced.py'), 'pdf-docx', file.path, 'docx', out],
      { signal },
    );
    return out;
  }
  if (['png', 'jpg'].includes(target)) {
    const pages = path.join(stage, 'pages');
    await fs.mkdir(pages);
    await run(
      engines.pdf,
      [
        'render',
        file.path,
        pages,
        target,
        options.quality === 'high' ? '216' : options.quality === 'small' ? '96' : '144',
      ],
      {
        signal,
        onLine: (line) => {
          const m = line.match(/^PAGE (\d+) (\d+)/);
          if (m) progress(5 + (Number(m[1]) / Number(m[2])) * 85);
        },
      },
    );
    const results = await fs.readdir(pages);
    if (!results.length) throw new Error('No PDF pages could be rendered.');
    if (results.length === 1) {
      await fs.copyFile(path.join(pages, results[0]), out);
      return out;
    }
    const zip = out.replace(/\.[^.]+$/, '-pages.zip');
    await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', pages, zip], { signal });
    return zip;
  }
  const textPath = path.join(stage, 'extracted.txt');
  try {
    await run(engines.pdf, ['text', file.path, textPath], { signal });
  } catch (error) {
    if (!/no selectable text/i.test(error.message) || !engines.python || !engines.tesseract)
      throw error;
    await run(
      engines.python,
      [path.join(engines.resources, 'advanced.py'), 'pdf-text', file.path, 'txt', textPath],
      { signal },
    );
  }
  const text = await fs.readFile(textPath, 'utf8');
  if (target === 'txt') {
    await fs.writeFile(out, text);
    return out;
  }
  if (target === 'md') {
    await fs.writeFile(out, text.replace(/([\\`*_{}\[\]<>#+\-!|])/g, '\\$1'));
    return out;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHTML(file.name)}</title></head><body>${text
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHTML(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')}</body></html>`;
  if (target === 'html') {
    await fs.writeFile(out, html);
    return out;
  }
  const htmlPath = path.join(stage, 'extracted.html');
  await fs.writeFile(htmlPath, html);
  await run(engines.pandoc, [htmlPath, '-f', 'html', '-t', target, '-s', '-o', out], { signal });
  return out;
}
function validData(value, depth = 0) {
  if (depth > 100) throw new Error('Data is nested too deeply.');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('Data contains an unsafe reserved key.');
      validData(child, depth + 1);
    }
  }
  return value;
}
async function structured(file, target, out) {
  if (file.size > 50 * 1024 * 1024)
    throw new Error('Structured data conversion is limited to 50 MB per file.');
  const text = await fs.readFile(file.path, 'utf8');
  let value;
  switch (catalog.normalize(file.ext)) {
    case 'json':
      value = JSON.parse(text);
      break;
    case 'yaml':
      value = YAML.parse(text, { maxAliasCount: 50 });
      break;
    case 'xml':
      if (/<!DOCTYPE|<!ENTITY/i.test(text))
        throw new Error('XML with external entities or a DOCTYPE is not supported.');
      const validation = XMLValidator.validate(text);
      if (validation !== true) throw new Error('This XML is not well formed.');
      value = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
      }).parse(text);
      break;
    default:
      value = parse(text, {
        columns: true,
        delimiter: file.ext === 'tsv' ? '\t' : ',',
        skip_empty_lines: true,
        bom: true,
      });
  }
  validData(value);
  let result;
  if (target === 'json') result = JSON.stringify(value, null, 2) + '\n';
  else if (target === 'yaml') result = YAML.stringify(value);
  else if (target === 'xml') {
    const wrapped = Array.isArray(value) ? { data: { record: value } } : { data: value };
    result =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true }).build(
        wrapped,
      );
    if (XMLValidator.validate(result) !== true)
      throw new Error('Some keys cannot be represented as valid XML element names.');
  } else {
    if (
      !Array.isArray(value) ||
      value.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          Object.values(row).some((v) => v !== null && typeof v === 'object'),
      )
    )
      throw new Error(
        'CSV and TSV require an array of flat records. Nested data cannot be converted to a table.',
      );
    const columns = [...new Set(value.flatMap(Object.keys))];
    result = stringify(value, {
      header: true,
      columns,
      delimiter: target === 'tsv' ? '\t' : ',',
      escape_formulas: true,
    });
  }
  await fs.writeFile(out, result);
}
async function publish(stagePath, outputDir) {
  const parsed = path.parse(stagePath);
  for (let i = 0; i < 10000; i++) {
    const dest = path.join(outputDir, `${parsed.name}${i ? ` (${i})` : ''}${parsed.ext}`);
    try {
      await fs.link(stagePath, dest);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Could not find an unused output name.');
}
function sanitizeOptions(options = {}) {
  const width = Number(options.width) || 0;
  return {
    quality: ['high', 'balanced', 'small'].includes(options.quality) ? options.quality : 'balanced',
    width: [0, 1920, 1280, 720].includes(width) ? width : 0,
  };
}
async function convert(
  file,
  target,
  outputDir,
  options,
  engines,
  resources,
  { signal, onProgress = () => {} } = {},
) {
  if (!catalog.targets(file, engines).includes(target))
    throw new Error('This conversion is not supported.');
  if (signal?.aborted) throw cancelled();
  await fs.mkdir(outputDir, { recursive: true });
  const stage = await fs.mkdtemp(path.join(outputDir, '.flux-'));
  const stem =
    path
      .basename(file.name, '.' + file.ext)
      .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
      .slice(0, 160) || 'converted';
  const out = path.join(stage, `${stem}.${target}`);
  let product = out;
  const opts = sanitizeOptions(options);
  try {
    onProgress(3);
    switch (file.family) {
      case 'image':
        await image(file.path, target, out, stage, opts, engines, signal);
        break;
      case 'video':
      case 'audio':
        await media(file, target, out, opts, engines, signal, onProgress);
        break;
      case 'document':
        await document(file, target, out, stage, engines, signal);
        break;
      case 'pdf':
        product = await pdf(file, target, out, stage, opts, engines, signal, onProgress);
        break;
      case 'spreadsheet':
        if (['parquet', 'feather', 'ndjson'].includes(target)) {
          product = await require('./extra.cjs').extraConvert(
            file,
            target,
            out,
            stage,
            engines,
            resources,
            signal,
          );
          break;
        }
        if (
          ['csv', 'tsv'].includes(file.ext) &&
          ['csv', 'tsv', 'json', 'yaml', 'xml'].includes(target)
        )
          await structured(file, target, out);
        else
          await fs.copyFile(
            await officeConvert(file.path, target, stage, engines, signal, 'spreadsheet'),
            out,
          );
        break;
      case 'presentation':
        await fs.copyFile(
          await officeConvert(file.path, target, stage, engines, signal, 'presentation'),
          out,
        );
        break;
      case 'drawing':
        await fs.copyFile(
          await officeConvert(file.path, target, stage, engines, signal, 'drawing'),
          out,
        );
        break;
      case 'data':
        if (['parquet', 'feather', 'ndjson'].includes(target))
          product = await require('./extra.cjs').extraConvert(
            file,
            target,
            out,
            stage,
            engines,
            resources,
            signal,
          );
        else await structured(file, target, out);
        break;
      case 'font':
      case 'model':
      case 'table':
      case 'subtitle':
      case 'ebook':
        product = await require('./extra.cjs').extraConvert(
          file,
          target,
          out,
          stage,
          engines,
          resources,
          signal,
        );
        break;
      case 'archive':
        await run(
          engines.archive,
          [
            path.join(resources, 'archive.py'),
            file.path,
            target,
            out,
            path.join(stage, 'contents'),
          ],
          { signal },
        );
        break;
      default:
        throw new Error('Unsupported file format.');
    }
    if (signal?.aborted) throw cancelled();
    const stat = await fs.stat(product);
    if (!stat.size && !['txt', 'md', 'csv', 'tsv'].includes(target))
      throw new Error('Conversion produced an empty file.');
    onProgress(98);
    const result = await publish(product, outputDir);
    onProgress(100);
    return {
      path: result,
      name: path.basename(result),
      size: stat.size,
      completedAt: Date.now(),
      target,
      sourceName: file.name,
      sourceFamily: file.family,
    };
  } catch (e) {
    e.message = displayError(e);
    throw e;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
module.exports = {
  detectEngines,
  inspectFile,
  convert,
  run,
  publish,
  structured,
  sanitizeOptions,
  catalog,
};
