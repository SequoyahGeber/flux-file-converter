const fs = require('node:fs');
const net = require('node:net');
const { TextDecoder } = require('node:util');

// Descriptor 3 is a one-use anonymous startup channel, never an environment
// fallback. Wait for EOF as well as the complete bounded frame before admission.
function readWorkerSecret(fd = 3, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const frame = Buffer.alloc(4100);
    let stream,
      timer,
      used = 0,
      settled = false,
      secret,
      invalid = false;
    const finish = (failed) => {
      if (settled) return;
      settled = true;
      invalid = failed;
      clearTimeout(timer);
      frame.fill(0);
      if (stream) stream.destroy();
      else {
        try {
          fs.closeSync(fd);
        } catch {}
        reject(new Error('Invalid worker startup credential.'));
      }
    };
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFIFO() && !stat.isSocket()) throw new Error();
      // libuv makes the descriptor nonblocking; timeout also covers a writer
      // that supplies a valid frame but never closes its end.
      stream = new net.Socket({ fd, readable: true, writable: false });
      stream.once('close', () => {
        if (!settled) {
          invalid = true;
          frame.fill(0);
          clearTimeout(timer);
        }
        if (invalid) reject(new Error('Invalid worker startup credential.'));
        else resolve(secret);
      });
      stream.on('error', () => finish(true));
      stream.on('data', (chunk) => {
        if (used + chunk.length > frame.length) {
          chunk.fill(0);
          finish(true);
          return;
        }
        chunk.copy(frame, used);
        used += chunk.length;
        chunk.fill(0);
        if (used >= 4) {
          const length = frame.readUInt32BE(0);
          if (length < 32 || length > 4096 || used > length + 4) finish(true);
        }
      });
      stream.once('end', () => {
        try {
          if (used < 4 || used !== frame.readUInt32BE(0) + 4 || used < 36) throw new Error();
          secret = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            frame.subarray(4, used),
          );
          if (secret.includes('\0')) throw new Error();
          finish(false);
        } catch {
          finish(true);
        }
      });
      timer = setTimeout(() => finish(true), timeout);
    } catch {
      finish(true);
    }
  });
}

module.exports = { readWorkerSecret };
