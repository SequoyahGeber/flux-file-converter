// Private one-job worker used by the native Mac bridge. Never opens a listener.
const fs = require('node:fs/promises');
const path = require('node:path');
const { detectEngines, inspectFile, convert, catalog } = require('../electron/engine.cjs');
const { compressionOptions, compress } = require('../electron/compression.cjs');
const { archiveFiles } = require('../electron/archives.cjs');
const { configureBundledEnvironment } = require('../electron/process.cjs');
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
async function main() {
  const resources = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(resources, 'engines.json'), 'utf8'));
  const environment = {};
  for (const [key, directories] of Object.entries(manifest.environment || {})) {
    environment[key] = directories
      .map((relative) => {
        const directory = path.resolve(resources, relative);
        if (!directory.startsWith(resources + path.sep))
          throw new Error('Invalid bundled data path.');
        return directory;
      })
      .join(path.delimiter);
  }
  environment.PATH = [
    ...new Set(
      Object.values(manifest.engines)
        .filter((tool) => typeof tool === 'string')
        .map((tool) => path.dirname(path.resolve(resources, tool))),
    ),
    '/usr/bin',
    '/bin',
  ].join(path.delimiter);
  configureBundledEnvironment(environment);
  const engines = await detectEngines(resources, { bundledOnly: true });
  if (process.argv[2] === '--catalog') {
    const families = catalog.families.filter((f) => f.id !== 'model' || engines.blender);
    const formats = families.flatMap((f) =>
      f.formats.map((ext) => {
        const file = { ext, family: f.id };
        const targets = catalog.targets(file, engines);
        return {
          input: ext,
          family: f.id,
          targets,
          notes: Object.fromEntries(targets.map((t) => [t, catalog.note(file, t)])),
          compressionOptions: compressionOptions(file, engines),
        };
      }),
    );
    await fs.writeFile(
      path.join(resources, 'capabilities.json'),
      JSON.stringify({ families, formats }),
    );
    return;
  }
  const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const files = [];
  for (const input of request.inputs)
    files.push(await inspectFile(input, engines, resources, { signal: controller.signal }));
  const context = { signal: controller.signal };
  let result;
  if (request.operation === 'pack' || request.operation === 'extract') {
    result = await archiveFiles(
      files,
      request.operation,
      request.output,
      engines,
      resources,
      context,
    );
  } else if (request.operation === 'compress') {
    result = await compress(
      files[0],
      request.compression,
      request.output,
      request.options,
      engines,
      resources,
      context,
    );
  } else if (request.target === 'zip') {
    result = await compress(
      files[0],
      'archive',
      request.output,
      request.options,
      engines,
      resources,
      context,
    );
  } else if (files[0].family === 'ebook' && request.target === 'pdf') {
    // Calibre's Chromium PDF renderer needs global Mach services unavailable
    // inside the app sandbox. Keep ebook import in Calibre and render its
    // intermediate Word document with the bundled Office engine instead.
    const intermediate = await convert(
      files[0],
      'docx',
      request.output,
      request.options,
      engines,
      resources,
      context,
    );
    try {
      const document = await inspectFile(intermediate.path, engines, resources, {
        signal: controller.signal,
      });
      result = await convert(
        document,
        'pdf',
        request.output,
        request.options,
        engines,
        resources,
        context,
      );
    } finally {
      await fs.rm(intermediate.path, { force: true });
    }
  } else {
    result = await convert(
      files[0],
      request.target,
      request.output,
      request.options,
      engines,
      resources,
      context,
    );
  }
  const filename = request.filename + (result.target === 'folder' ? '' : '.' + result.target);
  const destination = path.join(request.output, filename);
  if (result.path !== destination) await fs.rename(result.path, destination);
  await fs.writeFile(
    request.reply,
    JSON.stringify({
      path: destination,
      directory: result.target === 'folder',
      target: result.target,
    }),
  );
}
main().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
