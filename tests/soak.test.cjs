const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyse } = require('../scripts/soak.cjs');

// Synthetic series: one sample per job, gc'd on every 10th, plus a final sample.
function series(overrides = () => ({}), jobs = 300) {
  const samples = [];
  for (let job = 1; job <= jobs + 1; job++)
    samples.push({
      job,
      rss: 200e6,
      heapUsed: 50e6,
      external: 10e6,
      fds: 20,
      children: 0,
      tmpEntries: 0,
      tmpBytes: 0,
      aliases: 0,
      stages: 0,
      gc: job % 10 === 0 || job === jobs + 1,
      ...overrides(job, jobs + 1),
    });
  return samples;
}
const ids = (result) => result.findings.map((f) => f.id);

test('flat samples show no leak', () => {
  const result = analyse(series());
  assert.equal(result.leak, false);
  assert.deepEqual(result.findings, []);
  assert.equal(result.warmupJobs, 30);
  assert.equal(result.heapSlopeBytesPerJob, 0);
});
test('RSS growth alone is reported, not flagged', () => {
  const result = analyse(series((job) => ({ rss: 200e6 + job * 1e6 })));
  assert.equal(result.leak, false);
  assert.ok(result.rssGrowthBytes > 200e6);
});
test('file handle growth of 6 is flagged and growth of 5 is not', () => {
  const grow = (n) => analyse(series((job, last) => ({ fds: job === last ? 20 + n : 20 })));
  assert.deepEqual(ids(grow(6)), ['fds']);
  assert.equal(grow(5).leak, false);
});
test('a leftover temp entry is flagged', () => {
  const result = analyse(
    series((job, last) => (job === last ? { tmpEntries: 1, tmpBytes: 12 } : {})),
  );
  assert.deepEqual(ids(result), ['temp']);
});
test('a leftover alias or stage folder is flagged', () => {
  const result = analyse(series((job, last) => (job === last ? { aliases: 1, stages: 2 } : {})));
  assert.deepEqual(ids(result), ['aliases', 'stages']);
});
test('a lingering child process is flagged', () => {
  const result = analyse(series((job, last) => (job === last ? { children: 1 } : {})));
  assert.deepEqual(ids(result), ['children']);
});
test('steady heap growth is flagged', () => {
  const result = analyse(series((job) => ({ heapUsed: 50e6 + job * 200 * 1024 })));
  assert.deepEqual(ids(result), ['heap']);
  assert.ok(result.heapSlopeBytesPerJob > 64 * 1024);
});
test('heap growth only during warm-up is not flagged', () => {
  const result = analyse(series((job) => ({ heapUsed: 50e6 + Math.min(job, 30) * 2e6 })));
  assert.equal(result.leak, false);
  assert.equal(result.heapSlopeBytesPerJob, 0);
});
test('a steep slope without a 1.5x final heap is not flagged', () => {
  const result = analyse(series((job) => ({ heapUsed: 500e6 + job * 100 * 1024 })));
  assert.ok(result.heapSlopeBytesPerJob > 64 * 1024);
  assert.equal(result.leak, false);
});
test('peaks are computed for very long series without argument limits', () => {
  const result = analyse(series((job) => ({ rss: job === 5 ? 900e6 : 200e6 }), 150000));
  assert.equal(result.peak.rss, 900e6);
});
test('requiring the script starts no run', () => {
  assert.equal(typeof analyse, 'function');
});
