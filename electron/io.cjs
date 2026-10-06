// FileHandle.write may successfully write fewer bytes than requested.
async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position === undefined ? null : position + offset,
    );
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten < 1 ||
      bytesWritten > buffer.length - offset
    )
      throw new Error('The file could not be fully written.');
    offset += bytesWritten;
  }
}
async function readBounded(file, limit) {
  const fs = require('node:fs');
  const chunks = [];
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    if (size > limit) throw new Error('Text or structured data exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function outputStem(value, fallback = 'converted') {
  // NFC keeps decomposed accents and Indic vowel signs as letters, not underscores.
  value = value
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} ._()-]/gu, '_')
    .replace(/^[.\s-]+/, '');
  let result = '',
    size = 0;
  for (const character of value) {
    size += Buffer.byteLength(character);
    if (size > 160) break;
    result += character;
  }
  return result.trimEnd() || fallback;
}
// Strips the detected extension regardless of case: Photo.JPG -> Photo.
function baseStem(name, ext) {
  return ext && name.toLowerCase().endsWith('.' + ext.toLowerCase())
    ? name.slice(0, -(ext.length + 1))
    : name;
}
// ImageMagick, FFmpeg and Ghostscript expand %-patterns, and ImageMagick also
// reads [frame] suffixes, in file paths. A source named scan%03d.jpg would read
// a neighbouring scan000.jpg. Tools receive aliases without those characters.
const PATTERN = /[%[\]]/;
async function toolPaths(stage, input, safeName) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  let alias,
    work = stage,
    source = input;
  if (PATTERN.test(stage) || (input && PATTERN.test(input))) {
    alias = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-paths-'));
    if (PATTERN.test(stage)) {
      work = path.join(alias, 'stage');
      await fs.symlink(stage, work);
    }
    if (input && PATTERN.test(input)) {
      await fs.mkdir(path.join(alias, 'input'));
      source = path.join(alias, 'input', safeName);
      await fs.symlink(input, source);
    }
  }
  return {
    work,
    source,
    release: () => alias && fs.rm(alias, { recursive: true, force: true }),
  };
}
module.exports = { writeAll, readBounded, outputStem, baseStem, toolPaths };
