const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const DESKTOP_DEPENDENCIES = [
  'csv-parse',
  'csv-stringify',
  'fast-xml-parser',
  'pdf-lib',
  'sharp',
  'yaml',
];

function desktopManifest(pkg) {
  return {
    name: pkg.name,
    version: pkg.version,
    main: pkg.main,
    dependencies: Object.fromEntries(
      DESKTOP_DEPENDENCIES.map((name) => [name, pkg.dependencies[name]]),
    ),
  };
}

async function copyDesktopDependencies(root, application) {
  const tree = JSON.parse(
    execFileSync('npm', ['ls', '--omit=dev', '--all', '--long', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const modules = new Set();
  function visit(item) {
    if (!item?.path) return; // npm represents unavailable optional platform packages as {}.
    if (!item.path.startsWith(path.join(root, 'node_modules') + path.sep))
      throw new Error('A desktop dependency points outside the locked dependency tree.');
    modules.add(item.path);
    for (const dependency of Object.values(item.dependencies || {})) visit(dependency);
  }
  for (const name of DESKTOP_DEPENDENCIES) {
    if (!tree.dependencies?.[name]?.path)
      throw new Error(`Install the locked ${name} dependency before packaging.`);
    visit(tree.dependencies[name]);
  }
  const copied = [];
  for (const module of [...modules].sort((a, b) => a.length - b.length)) {
    if (copied.some((parent) => module.startsWith(parent + path.sep))) continue;
    await fs.cp(module, path.join(application, path.relative(root, module)), {
      recursive: true,
      verbatimSymlinks: true,
    });
    copied.push(module);
  }
}

function runtimeFile(file) {
  return (
    !file
      .split(path.sep)
      .some((part) => ['__pycache__', 'tests', '.pytest_cache'].includes(part)) &&
    !file.endsWith('.pyc')
  );
}
module.exports = { desktopManifest, copyDesktopDependencies, runtimeFile };
