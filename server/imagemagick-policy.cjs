// Verify the policy reported by the executable, rather than the installed XML.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const coders =
  'MSL MVG EPHEMERAL URL HTTP HTTPS FTP FTPS PS PS2 PS3 EPS EPS2 EPS3 PDF XPS TEXT LABEL CAPTION SHOW WIN PLT'.split(
    ' ',
  );
const modules = 'MSL MVG URL PS PDF XPS VIDEO'.split(' ');
const ceilings = {
  memory: 256 * 1024 ** 2,
  map: 256 * 1024 ** 2,
  disk: 256 * 1024 ** 2,
  area: 40000000,
  width: 16000,
  height: 16000,
  time: 100,
  thread: 1,
};
function parsePolicies(listing) {
  const policies = [];
  let source, current;
  for (const line of listing.split(/\r?\n/)) {
    let match = line.match(/^\s*Path:\s*(.+?)\s*$/);
    if (match) {
      source = match[1];
      current = null;
    } else if ((match = line.match(/^\s*Policy:\s*(\w+)\s*$/))) {
      assert.ok(source, 'Policy has no source');
      current = { source, domain: match[1].toLowerCase() };
      policies.push(current);
    } else if ((match = line.match(/^\s*(name|value|rights|pattern):\s*(.*?)\s*$/))) {
      assert.ok(current, 'Policy field has no policy');
      assert.equal(current[match[1]], undefined, 'Duplicate policy field');
      current[match[1]] = match[2];
    }
  }
  assert.ok(policies.length, 'No active policies reported');
  return policies;
}
function matches(pattern, name) {
  // Accept explicit names, brace lists or a blanket denial, never substrings.
  const patterns =
    pattern.startsWith('{') && pattern.endsWith('}') ? pattern.slice(1, -1).split(',') : [pattern];
  return patterns.includes(name) || patterns.includes('*');
}
function amount(value) {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*(MiB|MB|GiB|GB|KiB|KB|MP|KP|B|P|s)?$/i);
  assert.ok(match, 'Unrecognized resource limit: ' + value);
  const units = {
    mib: 1024 ** 2,
    mb: 1000 ** 2,
    gib: 1024 ** 3,
    gb: 1000 ** 3,
    kib: 1024,
    kb: 1000,
    mp: 1000000,
    kp: 1000,
    b: 1,
    p: 1,
    s: 1,
  };
  return Number(match[1]) * units[(match[2] || 'b').toLowerCase()];
}
function verifyPolicy(listing) {
  const policies = parsePolicies(listing);
  const installed = policies.filter((p) => /^\/etc\/ImageMagick-[67]\/policy\.xml$/.test(p.source));
  assert.ok(installed.length, 'Flux policy is not loaded from a supported config directory');
  for (const [domain, patterns] of Object.entries({
    coder: coders,
    module: modules,
    delegate: ['*'],
    filter: ['*'],
    path: ['@*'],
  })) {
    const rules = policies.filter((p) => p.domain === domain);
    for (const rule of rules) {
      assert.equal(rule.rights?.toLowerCase(), 'none', 'Unexpected granting ' + domain + ' policy');
      assert.ok(rule.pattern, 'Missing policy pattern');
    }
    for (const pattern of patterns)
      assert.ok(
        installed.some(
          (p) =>
            p.domain === domain &&
            p.rights?.toLowerCase() === 'none' &&
            (domain === 'path' || domain === 'delegate' || domain === 'filter'
              ? p.pattern === pattern
              : matches(p.pattern || '', pattern)),
        ),
        'Missing ' + domain + ' denial: ' + pattern,
      );
  }
  for (const [name, ceiling] of Object.entries(ceilings)) {
    const rules = policies.filter((p) => p.domain === 'resource' && p.name === name);
    assert.ok(rules.length && installed.some((p) => rules.includes(p)), 'Missing resource: ' + name);
    // Check every loaded value: an additional permissive policy must fail too.
    for (const rule of rules)
      assert.ok(
        amount(rule.value) > 0 && amount(rule.value) <= ceiling,
        'Excessive resource: ' + name,
      );
  }
}
function verifyExecutables() {
  for (const executable of ['/usr/bin/convert', '/usr/local/bin/magick']) {
    const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 };
    const version = execFileSync(executable, ['-version'], options);
    assert.match(version, /ImageMagick [67]\./);
    verifyPolicy(execFileSync(executable, ['-list', 'policy'], options));
    console.log(executable + ': ' + version.split('\n')[0] + '; active Flux policy verified');
  }
}
module.exports = { parsePolicies, verifyPolicy, verifyExecutables };
if (require.main === module) verifyExecutables();
