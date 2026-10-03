const fs = require('node:fs/promises');
const path = require('node:path');
// Loaded lazily to avoid the engine module's exports being incomplete in a cycle.
const getEngine = () => require('./engine.cjs');
async function model(file, target, out, stage, engines, resources, signal) {
  const dir = path.join(stage, 'model');
  await fs.mkdir(dir);
  const output = path.join(dir, path.basename(out));
  await getEngine().run(
    engines.blender,
    [
      '--background',
      '--factory-startup',
      '--disable-autoexec',
      '--python-exit-code',
      '1',
      '--python',
      path.join(resources, 'models.py'),
      '--',
      file.path,
      target,
      output,
    ],
    { signal },
  );
  const extras = await fs.readdir(dir);
  if (extras.length > 1) {
    const zip = out.replace(/\.[^.]+$/, '-assets.zip');
    await getEngine().run('/usr/bin/ditto', ['-c', '-k', '--norsrc', dir, zip], { signal });
    return zip;
  }
  await fs.copyFile(output, out);
  return out;
}
async function extraConvert(file, target, out, stage, engines, resources, signal) {
  const { run } = getEngine();
  if (file.family === 'model') return model(file, target, out, stage, engines, resources, signal);
  if (file.family === 'font')
    await run(
      engines.python,
      [path.join(resources, 'advanced.py'), 'font', file.path, target, out],
      { signal },
    );
  else if (file.family === 'table' || ['parquet', 'feather', 'ndjson'].includes(target))
    await run(
      engines.python,
      [path.join(resources, 'advanced.py'), 'table', file.path, target, out],
      { signal },
    );
  else if (file.family === 'subtitle')
    await run(
      engines.ffmpeg,
      ['-nostdin', '-y', '-v', 'error', '-i', file.path, '-map', '0:s:0', out],
      { signal },
    );
  else if (file.family === 'ebook') {
    if (engines.calibre) await run(engines.calibre, [file.path, out], { signal });
    else
      await run(
        engines.pandoc,
        [file.path, '-t', target === 'txt' ? 'plain' : target, '-s', '-o', out],
        { signal },
      );
  } else throw new Error('No conversion engine is available for this format.');
  return out;
}
module.exports = { extraConvert };
