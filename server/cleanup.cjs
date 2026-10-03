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
  for(const dir of ['/work','/tmp'])for(const entry of await fs.readdir(dir)){
    const full=path.join(dir,entry),stat=await fs.lstat(full);
    if(entry==='lost+found'&&stat.isDirectory()&&stat.uid===0)continue;
    await remove(full);
  }
}
async function cleanApi(root) {
  for(const entry of await fs.readdir(root))if(/^flux-api-/.test(entry))await remove(path.join(root,entry));
}
module.exports={cleanWorker,cleanApi};
