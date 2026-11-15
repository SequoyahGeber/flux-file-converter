// Every entitlement a target declares must be on its release script's allow-list, or the
// signed-archive check rejects every release build (it once missed files.bookmarks.app-scope).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const keys = (file) =>
  [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map(
    (m) => m[1],
  );
const allowed = (script, name) => {
  const text = fs.readFileSync(path.join(root, script), 'utf8');
  const start = text.indexOf(`${name} = {`);
  assert.ok(start >= 0, `${script} has no ${name} set`);
  const block = text.slice(start, text.indexOf('}', start));
  return new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
};

test('Mac entitlements are all allowed by mac-release.py', () => {
  const list = allowed('scripts/mac-release.py', 'expected');
  for (const key of keys('mac/Flux/Flux.entitlements'))
    assert.ok(list.has(key), `mac-release.py would reject ${key}`);
});

test('iPhone entitlements are all allowed by ios-release.py', () => {
  const list = allowed('scripts/ios-release.py', 'allowed');
  for (const key of keys('ios/Flux/Flux.entitlements'))
    assert.ok(list.has(key), `ios-release.py would reject ${key}`);
});
