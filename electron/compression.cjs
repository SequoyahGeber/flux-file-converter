const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { run, publish, sanitizeOptions } = require('./engine.cjs');
const { normalize } = require('./catalog.cjs');

function compressionOptions(file, engines) {
  const ext = normalize(file.ext), choices = [];
  if (file.family === 'image') {
    if (ext === 'png' && engines.oxipng) choices.push({ id: 'lossless', target: 'png', name: 'Lossless PNG', note: 'Optimizes compression while preserving pixels and metadata.' });
    if (ext === 'jpg' && engines.jpegtran) choices.push({ id: 'lossless', target: 'jpg', name: 'Lossless JPEG', note: 'Optimizes JPEG encoding without changing image data.' });
    if (ext === 'webp' && engines.cwebp) choices.push({ id: 'lossless', target: 'webp', name: 'Lossless WebP', note: 'Preserves the decoded pixels. An already lossy WebP may become larger.' });
    if (!['svg', 'gif', 'tiff'].includes(ext)) choices.push({ id: 'lossy', target: 'webp', name: 'Smaller WebP', note: 'Reduces image quality for a smaller file. Keeps transparency.' });
  }
  if (file.family === 'pdf') {
    if (engines.qpdf) choices.push({ id: 'lossless', target: 'pdf', name: 'Lossless PDF', note: 'Recompresses PDF streams without downsampling images. Rewriting invalidates digital signatures.' });
    if (engines.ghostscript) choices.push({ id: 'lossy', target: 'pdf', name: 'Smaller PDF', note: 'Downsamples images. Forms, annotations, and signatures may change; review the result.' });
  }
  if (file.family === 'video' && file.hasVideo !== false && engines.ffmpeg) {
    choices.push({ id: 'lossy', target: 'mp4', name: 'Smaller MP4', note: 'Re-encodes video and audio. Quality and resolution settings control file size.' });
    choices.push({ id: 'frames', target: 'mkv', name: 'Lossless video (FFV1)', note: 'Preserves decoded video pixels and copies audio. Often larger than an MP4; uses MKV.' });
  }
  if (file.family === 'audio' && engines.ffmpeg) choices.push({ id: 'lossy', target: 'm4a', name: 'Smaller audio', note: 'Re-encodes audio to AAC. This reduces quality and is not reversible.' });
  // ZIP is valid for every ordinary file, including formats we do not decode.
  choices.push({ id: 'archive', target: 'zip', name: 'Lossless ZIP', note: 'Preserves the original file bytes inside a ZIP. Already compressed files may not shrink.' });
  return choices;
}
async function compress(file, mode, outputDir, options, engines, resources, { signal, onProgress = () => {} } = {}) {
  const choice = compressionOptions(file, engines).find(c => c.id === mode);
  if (!choice) throw new Error('This compression option is unavailable.');
  if (signal?.aborted) throw Object.assign(new Error('Compression cancelled.'), { code: 'CANCELLED' });
  await fs.mkdir(outputDir, { recursive: true });
  const stage = await fs.mkdtemp(path.join(outputDir, '.flux-'));
  const stem = path.basename(file.name, '.' + file.ext).replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 160) || 'file';
  const out = path.join(stage, `${stem}-compressed.${choice.target}`);
  const opts = sanitizeOptions(options); let keptOriginal = false;
  try {
    onProgress(5);
    if (mode === 'archive') await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', file.path, out], { signal });
    else if (file.family === 'image') {
      if (mode === 'lossless' && choice.target === 'jpg') await run(engines.jpegtran, ['-copy', 'all', '-optimize', '-outfile', out, file.path], { signal });
      else if (mode === 'lossless' && choice.target === 'png') await run(engines.oxipng, ['-o', '4', '--out', out, '--', file.path], { signal });
      else {
        let input = file.path;
        if (['heic', 'heif', 'bmp', 'ico'].includes(file.ext)) {
          input = path.join(stage, 'decoded.png');
          if (file.ext === 'ico') await run(engines.ffmpeg, ['-nostdin', '-v', 'error', '-i', file.path, '-frames:v', '1', input], { signal });
          else await run('/usr/bin/sips', ['-s', 'format', 'png', file.path, '--out', input], { signal });
        }
        if (mode === 'lossless') {
          const decoded = path.join(stage, 'pixels.png'); await sharp(input).keepMetadata().png().toFile(decoded);
          await run(engines.cwebp, ['-quiet', '-lossless', '-exact', '-metadata', 'all', '-z', '7', decoded, '-o', out], { signal });
        } else {
          let pipeline = sharp(input).rotate(); if (opts.width) pipeline = pipeline.resize({ width: opts.width, withoutEnlargement: true });
          await pipeline.webp({ quality: opts.quality === 'high' ? 85 : opts.quality === 'small' ? 50 : 70, effort: 6 }).toFile(out);
        }
      }
    } else if (file.family === 'pdf') {
      if (mode === 'lossless') await run(engines.qpdf, ['--object-streams=generate', '--stream-data=compress', '--recompress-flate', '--compression-level=9', file.path, out], { signal });
      else {
        const preset = opts.quality === 'high' ? '/printer' : opts.quality === 'small' ? '/screen' : '/ebook';
        await run(engines.ghostscript, ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7', `-dPDFSETTINGS=${preset}`, '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dQUIET', `-sOutputFile=${out}`, '-f', file.path], { signal });
      }
    } else {
      const args = ['-nostdin', '-y', '-v', 'error', '-i', file.path];
      if (mode === 'frames') args.push('-map', '0:v:0', '-map', '0:a?', '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-g', '1', '-pix_fmt', '+' + file.pixelFormat, '-c:a', 'copy');
      else if (file.family === 'video') {
        const crf = opts.quality === 'high' ? '23' : opts.quality === 'small' ? '32' : '28';
        args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${opts.width ? `trunc(min(${opts.width}\\,iw)/2)*2` : 'trunc(iw/2)*2'}:-2`, '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
      } else args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', opts.quality === 'high' ? '192k' : opts.quality === 'small' ? '64k' : '128k');
      args.push('-progress', 'pipe:1', '-nostats', out);
      await run(engines.ffmpeg, args, { signal, onLine: line => { if (line.startsWith('out_time_us=') && file.duration) onProgress(Math.min(95, 5 + Number(line.split('=')[1]) / 1e6 / file.duration * 90)); } });
    }
    if (signal?.aborted) throw Object.assign(new Error('Compression cancelled.'), { code: 'CANCELLED' });
    let stat = await fs.stat(out); if (!stat.size) throw new Error('Compression produced an empty file.');
    // For same-format optimization, never keep a result that is larger than the original.
    if (normalize(file.ext) === choice.target && stat.size >= file.size && mode !== 'frames') {
      await fs.copyFile(file.path, out); stat = await fs.stat(out); keptOriginal = true;
    }
    const output = await publish(out, outputDir); onProgress(100);
    return { path: output, name: path.basename(output), size: stat.size, originalSize: file.size, savedBytes: file.size - stat.size, keptOriginal, completedAt: Date.now(), target: choice.target, sourceName: file.name, sourceFamily: file.family, operation: 'compress', compression: mode };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
module.exports = { compressionOptions, compress };
