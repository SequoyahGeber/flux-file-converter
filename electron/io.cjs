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
  value = value.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^[.\s-]+/, '');
  let result = '',
    size = 0;
  for (const character of value) {
    size += Buffer.byteLength(character);
    if (size > 160) break;
    result += character;
  }
  return result.trimEnd() || fallback;
}
module.exports = { writeAll, readBounded, outputStem };
