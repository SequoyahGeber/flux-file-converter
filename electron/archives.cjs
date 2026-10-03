const fs = require('node:fs/promises');
const path = require('node:path');
const { run, publish } = require('./engine.cjs');
async function archiveFiles(files, action, outputDir, engines, resources, { signal, onProgress = () => {} } = {}) {
  if (!engines.archive) throw new Error('The archive engine is unavailable.');
  if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
  await fs.mkdir(outputDir, { recursive: true });
  const stage = await fs.mkdtemp(path.join(outputDir, '.flux-'));
  let published;
  try {
    onProgress(5);
    if (action === 'pack') {
      const manifest = path.join(stage, 'inputs.json'); await fs.writeFile(manifest, JSON.stringify(files.map(f => f.path)));
      const name = files.length === 1 ? files[0].name.replace(/[\/:]/g, '_').slice(0, 160) : 'Archive';
      const output = path.join(stage, name + '.zip');
      await run(engines.archive, [path.join(resources, 'archive.py'), manifest, 'zip', output, path.join(stage, 'contents'), 'pack'], { signal });
      const stat = await fs.stat(output); published = await publish(output, outputDir); onProgress(100);
      return { path: published, name: path.basename(published), size: stat.size, completedAt: Date.now(), target: 'zip', sourceName: `${files.length} item${files.length === 1 ? '' : 's'}`, operation: 'pack' };
    }
    const file = files[0], contents = path.join(stage, 'contents');
    await run(engines.archive, [path.join(resources, 'archive.py'), file.path, 'zip', path.join(stage, 'unused.zip'), contents, 'extract'], { signal });
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
    const stem = path.basename(file.name, '.' + file.ext).replace(/[\/:]/g, '_').slice(0, 160) + '-extracted';
    for (let i = 0; i < 10000; i++) {
      const dest = path.join(outputDir, stem + (i ? ` (${i})` : ''));
      try { await fs.mkdir(dest); published = dest; break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!published) throw new Error('No unused extraction folder could be created.');
    for (const entry of await fs.readdir(contents)) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
      await fs.cp(path.join(contents, entry), path.join(published, entry), { recursive: true, force: false, errorOnExist: true });
    }
    onProgress(100);
    return { path: published, name: path.basename(published), size: file.size, completedAt: Date.now(), target: 'folder', sourceName: file.name, operation: 'extract' };
  } catch (error) { if (published && action !== 'pack') await fs.rm(published, { recursive: true, force: true }); throw error; }
  finally { await fs.rm(stage, { recursive: true, force: true }); }
}
module.exports = { archiveFiles };
