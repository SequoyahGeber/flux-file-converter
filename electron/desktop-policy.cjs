const fs = require('node:fs/promises');
const path = require('node:path');

const APP_URL = 'app://flux/index.html';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

async function assetPath(request, directory) {
  const url = new URL(request);
  if (
    url.protocol !== 'app:' ||
    url.hostname !== 'flux' ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('Invalid app resource.');
  const pathname = decodeURIComponent(url.pathname);
  if (
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    !/\.(html|js|css|svg|png|ico|woff2?)$/.test(pathname)
  )
    throw new Error('Invalid app resource.');
  const root = await fs.realpath(directory);
  const file = await fs.realpath(path.resolve(root, '.' + pathname));
  if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile())
    throw new Error('Invalid app resource.');
  return file;
}

function jobView(job) {
  const { id, operation, status, progress, result, error } = job;
  return {
    id,
    operation,
    status,
    progress,
    result,
    error,
    ...(job.includeFiles ? { includeIds: job.includeFiles.map((file) => file.id) } : {}),
  };
}

module.exports = { APP_URL, CSP, assetPath, jobView };
