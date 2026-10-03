// A loopback-only native acceptance fixture. Authentication and scanning here are
// synthetic test dependencies; this module is never packaged or deployed.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../server/app.cjs');
const { detectEngines, inspectFile, convert } = require('../electron/engine.cjs');
const { compress } = require('../electron/compression.cjs');
const { archiveFiles } = require('../electron/archives.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-mac-fixture-'));
  const resources = path.resolve('resources');
  const engines = await detectEngines(resources);
  const app = await createApp(
    { storage: root, ownerEmail: 'demo@example.com', origin: 'http://127.0.0.1:43821' },
    {
      auth: async () => ({ id: 'synthetic-user', email: 'demo@example.com' }),
      scan: async () => 'full',
      capabilities: {
        formats: [{ input: 'png', family: 'image', targets: ['jpg', 'png', 'webp', 'tiff'] }],
        families: [{ id: 'image', name: 'Images', formats: ['png'] }],
        engines: { images: true },
      },
      rpc: async (spec, files, output) => {
        const file = files[0];
        if (spec.operation === 'inspect') return inspectFile(file.path, engines, resources);
        const outDir = await fs.mkdtemp(path.join(root, 'result-'));
        try {
          let result;
          const info = await inspectFile(file.path, engines, resources);
          if (spec.operation === 'convert')
            result = await convert(info, spec.target, outDir, spec.options, engines, resources);
          else if (spec.operation === 'compress')
            result = await compress(
              info,
              spec.compression,
              outDir,
              spec.options,
              engines,
              resources,
            );
          else result = await archiveFiles(files, spec.operation, outDir, engines, resources);
          await fs.copyFile(result.path, output);
          return { ...result, path: undefined };
        } finally {
          await fs.rm(outDir, { force: true, recursive: true });
        }
      },
    },
  );
  await sharp({ create: { width: 160, height: 120, channels: 4, background: '#8364c0' } })
    .png()
    .toFile(path.join(root, 'sample.png'));
  await new Promise((resolve) => app.server.listen(43821, '127.0.0.1', resolve));
  console.log(
    JSON.stringify({
      origin: 'http://127.0.0.1:43821',
      fixture: path.join(root, 'sample.png'),
      root,
    }),
  );
  const close = async () => {
    await app.close();
    await fs.rm(root, { force: true, recursive: true });
    process.exit();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
