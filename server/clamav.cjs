const net = require('node:net');
const fs = require('node:fs');
const { once } = require('node:events');
const { LIMITS, fail } = require('./security.cjs');
async function scanStream(file, { host = process.env.CLAMAV_HOST || 'flux-scanner', port = 3310, timeout = 180000, start, end } = {}) {
  const socket = net.createConnection({ host, port }); let response = '', expired;
  const timer = setTimeout(() => { expired = true; socket.destroy(new Error('Malware scanner timed out.')); }, timeout); timer.unref();
  const result = new Promise((resolve, reject) => {
    socket.on('error', () => reject(fail(expired ? 'Malware scan timed out; the file was rejected.' : 'Malware scanner unavailable; the file was rejected.', 503)));
    socket.on('data', chunk => { response += chunk.toString(); if (response.length > 4096) socket.destroy(new Error('Invalid scan response')); if (response.includes('\0')) resolve(response.split('\0')[0]); });
    socket.on('end', () => { if (!response.includes('\0')) reject(fail('Incomplete malware scan; the file was rejected.', 503)); });
  });
  // Attach a rejection handler immediately, including while streaming the file.
  result.catch(() => {});
  try {
    await once(socket, 'connect'); socket.write('zINSTREAM\0'); let total = 0;
    for await (const chunk of fs.createReadStream(file, { start, end })) {
      total += chunk.length; if (total > LIMITS.scanFull) throw fail('File exceeds the scanning limit.', 413);
      const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length); socket.write(size);
      if (!socket.write(chunk)) await once(socket, 'drain');
    }
    socket.write(Buffer.alloc(4)); const verdict = await result;
    if (verdict !== 'stream: OK') throw fail(/FOUND$/.test(verdict) ? 'This file was rejected by the malware scanner (malware, encryption, or scan limits).' : 'The malware scan could not complete; the file was rejected.', 422);
  } finally { clearTimeout(timer); socket.destroy(); }
}
async function scan(file, config = {}) {
  const size = (await fs.promises.stat(file)).size;
  if (size <= LIMITS.scanFull) { await scanStream(file, config); return 'full'; }
  // ClamAV has a 2 GB technical limit. For explicitly allowed large media,
  // scan overlapping windows for signatures. This is NOT a full container scan.
  const window = 64 * 1024 ** 2, overlap = 1024 ** 2, deadline = Date.now() + LIMITS.job;
  for (let start = 0; start < size; start += window - overlap) {
    if (Date.now() >= deadline) throw fail('Malware scan exceeded ten minutes; the file was rejected.', 422);
    await scanStream(file, { ...config, start, end: Math.min(size - 1, start + window - 1), timeout: Math.min(180000, deadline - Date.now()) });
  } return 'chunked';
}
module.exports = { scan };
