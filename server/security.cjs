const crypto = require('node:crypto');
const path = require('node:path');
const LIMITS = Object.freeze({
  file: 5_000_000_000,
  scanFull: 1_900_000_000,
  chunk: 16 * 1024 ** 2,
  storage: 12_000_000_000,
  output: 5_000_000_000,
  files: 20,
  users: 32,
  queue: 8,
  // Concurrent chunk streams across all users; each session has at most two uploads.
  uploadStreams: 8,
  ttl: 30 * 60 * 1000,
  job: 600000,
});
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function filename(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 180 ||
    /[\x00-\x1f\x7f/\\:]/.test(value) ||
    value.startsWith('.') ||
    value.startsWith('-') ||
    value === '..' ||
    path.basename(value) !== value
  )
    throw fail('Use an ordinary filename without paths or control characters.');
  return value;
}
function sameSecret(a, b) {
  const x = Buffer.from(a || ''),
    y = Buffer.from(b || '');
  return x.length === y.length && x.length >= 32 && crypto.timingSafeEqual(x, y);
}
function safeMetadata(file) {
  const keys = [
    'name',
    'ext',
    'size',
    'family',
    'detected',
    'details',
    'warning',
    'duration',
    'hasAudio',
    'hasVideo',
    'pixelFormat',
    'pages',
    'outline',
    'targets',
    'notes',
    'compressionOptions',
  ];
  return Object.fromEntries(keys.filter((k) => file[k] !== undefined).map((k) => [k, file[k]]));
}
function headers(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
class RateLimit {
  constructor(now = Date.now) {
    this.now = now;
    this.windows = new Map();
  }
  check(key, count, milliseconds) {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now >= w.until) {
      w = { count: 0, until: now + milliseconds };
      this.windows.set(key, w);
    }
    if (w.count >= count)
      throw Object.assign(fail('Too many requests. Please wait and try again.', 429), {
        retryAfter: Math.max(1, Math.ceil((w.until - now) / 1000)),
      });
    w.count++;
    if (this.windows.size > 10000)
      for (const [k, v] of this.windows) if (now >= v.until) this.windows.delete(k);
  }
}
class Queue {
  constructor(max = LIMITS.queue) {
    this.max = max;
    this.pending = [];
    this.active = false;
  }
  add(fn) {
    if (this.pending.length + Number(this.active) >= this.max)
      return Promise.reject(fail('The server queue is full. Try again shortly.', 503));
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.drain();
    });
  }
  async drain() {
    if (this.active) return;
    this.active = true;
    while (this.pending.length) {
      const next = this.pending.shift();
      try {
        next.resolve(await next.fn());
      } catch (e) {
        next.reject(e);
      }
    }
    this.active = false;
  }
}
function options(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  return {
    quality: ['high', 'balanced', 'small'].includes(value.quality) ? value.quality : 'balanced',
    width: [0, 720, 1280, 1920].includes(value.width) ? value.width : 0,
  };
}
module.exports = {
  LIMITS,
  fail,
  filename,
  sameSecret,
  safeMetadata,
  headers,
  RateLimit,
  Queue,
  options,
};
