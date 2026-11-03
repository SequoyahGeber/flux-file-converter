// Child process for tests/disk-full.test.cjs. It stages a product in <outputDir>, publishes
// it and, depending on the hook, stops at a known point inside publish() so the parent can
// SIGKILL it there. Usage: node publish-child.cjs <outputDir> <bytes> <hook>
//
// hooks (each prints "mid" and then hangs):
//   plain          no interception; prints "publishing" just before publish() runs
//   link-before    before the hard link is made
//   link-after     after the hard link was made
//   fallback       hard links unsupported; a copy writes half the bytes to its destination,
//                  a rename stops before it is made
//   rename-after   hard links unsupported; stops after the rename was made
//   exdev          hard links unsupported and the rename reports EXDEV; the fallback copy
//                  writes half the bytes to its destination
const crypto = require('node:crypto');
const fss = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const engine = require('../../electron/engine.cjs');

// Deterministic, incompressible-looking content so the parent can recompute its sha256.
function productBytes(size) {
  const out = Buffer.alloc(size);
  let block = crypto.createHash('sha256').update('flux-bl-011').digest();
  for (let at = 0; at < size; at += block.length) {
    block.copy(out, at, 0, Math.min(block.length, size - at));
    block = crypto.createHash('sha256').update(block).digest();
  }
  return out;
}

function stop() {
  fss.writeSync(1, 'mid\n');
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}
const unsupported = () =>
  Promise.reject(Object.assign(new Error('not supported'), { code: 'ENOTSUP' }));

async function main(outputDir, size, hook) {
  const stage = await engine.createStage(outputDir);
  const product = path.join(stage, 'result.bin');
  await fs.writeFile(product, productBytes(size));
  const real = { link: fs.link, rename: fs.rename, copyFile: fs.copyFile };
  const halfCopy = async (from, to) => {
    const bytes = await fs.readFile(from);
    fss.writeFileSync(to, bytes.subarray(0, bytes.length >> 1));
    return stop();
  };
  if (hook === 'link-before') fs.link = stop;
  if (hook === 'link-after')
    fs.link = async (...args) => {
      await real.link(...args);
      return stop();
    };
  if (['fallback', 'rename-after', 'exdev'].includes(hook)) fs.link = unsupported;
  if (hook === 'fallback') {
    fs.copyFile = halfCopy;
    fs.rename = stop;
  }
  if (hook === 'rename-after')
    fs.rename = async (...args) => {
      await real.rename(...args);
      return stop();
    };
  if (hook === 'exdev') {
    let first = true;
    fs.rename = (from, to) => {
      if (!first) return real.rename(from, to);
      first = false;
      return Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    };
    fs.copyFile = halfCopy;
  }
  if (hook === 'plain') fss.writeSync(1, 'publishing\n');
  await engine.publish(product, outputDir);
  fss.writeSync(1, 'done\n');
}

module.exports = { productBytes };
if (require.main === module) {
  const [outputDir, size, hook] = process.argv.slice(2);
  main(outputDir, Number(size), hook).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
