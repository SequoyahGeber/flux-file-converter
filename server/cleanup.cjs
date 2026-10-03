const fs = require('node:fs/promises');
const path = require('node:path');
// Only called on the container's dedicated scratch filesystems. Never follow
// links placed by a compromised parser, and recover restrictive directory modes.
async function remove(entry) {
  const stat = await fs.lstat(entry);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await fs.chmod(entry,0o700);
    for (const child of await fs.readdir(entry)) await remove(path.join(entry,child));
    await fs.rmdir(entry);
  } else await fs.unlink(entry);
}
async function cleanWorker() {
  for(const dir of [process.env.FLUX_WORKDIR||'/work',process.env.FLUX_TMPDIR||'/tmp'])for(const entry of await fs.readdir(dir)){
    const full=path.join(dir,entry),stat=await fs.lstat(full);
    if(entry==='lost+found'&&stat.isDirectory()&&stat.uid===0)continue;
    await remove(full);
  }
  // Some native tools ignore TMPDIR. In the shared container, only remove
  // entries owned by the worker; the API/scanner/tunnel use different UIDs.
  if(process.env.FLUX_TMPDIR && process.env.FLUX_TMPDIR!=='/tmp') {
    for(const entry of await fs.readdir('/tmp')) {
      const full=path.join('/tmp',entry),stat=await fs.lstat(full);
      if(stat.uid===process.getuid() && full!==process.env.FLUX_TMPDIR)await remove(full);
    }
  }
}
async function cleanApi(root) {
  for(const entry of await fs.readdir(root))if(/^flux-api-/.test(entry))await remove(path.join(root,entry));
}
module.exports={cleanWorker,cleanApi};
