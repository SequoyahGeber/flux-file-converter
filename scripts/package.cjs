// Build an ad-hoc signed, local macOS app from Electron's installed runtime.
// Only production dependencies enter the application bundle.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { detectEngines } = require('../electron/engine.cjs');
const {
  desktopManifest,
  copyDesktopDependencies,
  runtimeFile,
} = require('./desktop-dependencies.cjs');
const root = path.resolve(__dirname, '..');
const releasePath = path.join(root, 'release', 'Flux.app');
const buildRoot = path.join(os.tmpdir(), 'flux-package-' + require('node:crypto').randomUUID());
const dest = path.join(buildRoot, 'Flux.app');
const copy = (from, to) =>
  fs.cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    mode: require('node:fs').constants.COPYFILE_FICLONE,
  });
async function main() {
  if (process.platform !== 'darwin') throw new Error('This build script targets macOS.');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  const executable = require('electron');
  const base = path.resolve(executable, '../../..');
  await copy(base, dest);
  const content = path.join(dest, 'Contents'),
    resources = path.join(content, 'Resources'),
    application = path.join(resources, 'app');
  await fs.mkdir(application, { recursive: true });
  for (const name of ['dist', 'electron'])
    await copy(path.join(root, name), path.join(application, name));
  const pkg = require('../package.json');
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify(desktopManifest(pkg)));
  await copyDesktopDependencies(root, application);
  await fs.mkdir(path.join(application, 'resources'), { recursive: true });
  await copy(path.join(root, 'resources/icon.png'), path.join(application, 'resources/icon.png'));
  for (const file of ['pdf-tool', 'archive.py', 'advanced.py', 'models.py', 'office-formats.json'])
    await copy(path.join(root, 'resources', file), path.join(resources, file));
  await copy(path.join(root, 'resources/icon.icns'), path.join(resources, 'icon.icns'));
  await copy(path.join(root, 'reference'), path.join(resources, 'reference'));
  await fs.copyFile(path.resolve(base, '..', 'LICENSE'), path.join(resources, 'LICENSE.electron'));
  const engines = await detectEngines(path.join(root, 'resources'));
  if (engines.office?.includes('LibreOfficeDev.app')) {
    const officeApp = engines.office.slice(0, engines.office.indexOf('.app') + 4);
    console.log('Bundling the local Office conversion engine…');
    await copy(officeApp, path.join(resources, 'libreoffice', 'LibreOfficeDev.app'));
  }
  if (engines.python) {
    console.log('Bundling font, table, and PDF libraries…');
    const runtime = path.resolve(engines.python, '../..');
    const bundled = path.join(resources, 'python-runtime');
    await fs.cp(runtime, bundled, { recursive: true, verbatimSymlinks: true, filter: runtimeFile });
    // Keep the venv's relative interpreter links, with a private binary to sign.
    const interpreter = path.join(bundled, 'bin/python3.12');
    await fs.rm(interpreter, { force: true });
    await fs.copyFile(engines.python, interpreter);
    await fs.chmod(interpreter, 0o755);
  }
  await fs.rename(path.join(content, 'MacOS/Electron'), path.join(content, 'MacOS/Flux'));
  const plist = path.join(content, 'Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleName: 'Flux',
    CFBundleDisplayName: 'Flux',
    CFBundleExecutable: 'Flux',
    CFBundleIdentifier: 'local.flux.converter',
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: pkg.version,
    CFBundleIconFile: 'icon.icns',
    LSApplicationCategoryType: 'public.app-category.utilities',
  }))
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  execFileSync('/usr/bin/xattr', ['-cr', dest]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', dest], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest], { stdio: 'inherit' });
  await fs.mkdir(path.dirname(releasePath), { recursive: true });
  const zipPath = path.join(root, 'release', `Flux-${pkg.version}-local.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', dest, zipPath]);
  await fs.rm(releasePath, { recursive: true, force: true });
  await copy(dest, releasePath);
  execFileSync('/usr/bin/xattr', ['-cr', releasePath]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', releasePath], {
    stdio: 'inherit',
  });
  await fs.rm(buildRoot, { recursive: true, force: true });
  console.log(
    `Created ${releasePath}\nSigned local archive: ${zipPath}\nThis ad-hoc build is not a TestFlight distribution build.`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rm(buildRoot, { recursive: true, force: true }));
