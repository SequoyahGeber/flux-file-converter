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
module.exports = { writeAll };
