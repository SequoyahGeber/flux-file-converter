const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { bundledEngines } = require('../electron/bundled-engines.cjs');
const { desktopManifest, copyDesktopDependencies } = require('./desktop-dependencies.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'packaging/mas');
const MACHO = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
const allowedLoader = (name) =>
  ['@loader_path/', '@executable_path/', '@rpath/', '/System/Library/', '/usr/lib/'].some(
    (prefix) => name.startsWith(prefix),
  );
function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function validateProfile(profile, { bundleId, team, development, certificate }) {
  if (profile.allDevices)
    throw new Error('Use a device-bound development or Mac App Store profile for Flux.');
  if (profile.team !== team || profile.identifier !== `${team}.${bundleId}`)
    throw new Error('The provisioning profile does not belong to this Flux bundle ID and team.');
  if (!Number.isFinite(Date.parse(profile.expires)) || Date.parse(profile.expires) <= Date.now())
    throw new Error('The provisioning profile has expired.');
  if (Boolean(profile.development) !== development)
    throw new Error('The provisioning profile does not match the requested signing mode.');
  if (!profile.certificates.includes(certificate))
    throw new Error('The selected signing certificate is absent from the provisioning profile.');
}

async function auditResources(directory) {
  const root = await fs.realpath(directory);
  await bundledEngines(root);
  const notices = await fs.readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  if (notices.trim().length < 100)
    throw new Error(
      'Include complete third-party notices and redistribution/source information for the bundled engines.',
    );
  const problems = [];
  let binaries = 0;
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const actual = await fs.realpath(file);
        if (!actual.startsWith(root + path.sep))
          throw new Error(`An engine symlink escapes the bundle: ${path.relative(root, file)}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.isFile())
        throw new Error('Engine resources must contain ordinary files and directories.');
      const handle = await fs.open(file, 'r');
      const header = Buffer.alloc(4);
      let count;
      try {
        count = (await handle.read(header, 0, 4, 0)).bytesRead;
      } finally {
        await handle.close();
      }
      if (count !== 4 || !MACHO.has(header.readUInt32BE())) continue;
      binaries++;
      if (!command('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/).includes('arm64'))
        problems.push(`${path.relative(root, file)} lacks arm64`);
      for (const line of command('/usr/bin/otool', ['-L', file]).split('\n').slice(1)) {
        const dependency = line.trim().split(' (compatibility version')[0];
        if (dependency && !allowedLoader(dependency))
          problems.push(`${path.relative(root, file)} links ${dependency}`);
      }
      const commands = command('/usr/bin/otool', ['-l', file]).split('Load command');
      for (const item of commands.filter((item) => /cmd LC_RPATH\s/.test(item))) {
        const rpath = item.match(/\bpath (.+) \(offset /)?.[1];
        if (rpath && !allowedLoader(rpath.endsWith('/') ? rpath : rpath + '/'))
          problems.push(`${path.relative(root, file)} has nonportable RPATH ${rpath}`);
      }
    }
  }
  await walk(root);
  if (problems.length)
    throw new Error(
      `Portable engine audit failed (${problems.length} issues):\n${problems.slice(0, 20).join('\n')}`,
    );
  return { root, binaries };
}

function readProfile(file) {
  const decoded = command('/usr/bin/security', ['cms', '-D', '-i', file]);
  const script =
    "import sys,plistlib,json,hashlib; p=plistlib.loads(sys.stdin.buffer.read());e=p['Entitlements'];print(json.dumps({'team':p['TeamIdentifier'][0],'identifier':e.get('com.apple.application-identifier'),'expires':p['ExpirationDate'].isoformat()+'Z','development':bool(p.get('ProvisionedDevices')),'allDevices':bool(p.get('ProvisionsAllDevices')),'certificates':[hashlib.sha1(c).hexdigest().upper() for c in p['DeveloperCertificates']]}))";
  return JSON.parse(command('/usr/bin/python3', ['-c', script], { input: decoded }));
}

async function preflight({ development = false, env = process.env } = {}) {
  const errors = [],
    bundleId = env.FLUX_MAS_BUNDLE_ID || 'com.sequoyah.flux.mac',
    team = env.FLUX_MAS_TEAM || '8MLN9FH4F9';
  const build = env.FLUX_MAS_BUILD,
    identity = env.FLUX_MAS_IDENTITY,
    installer = env.FLUX_MAS_INSTALLER_IDENTITY;
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    errors.push('Build on an Apple Silicon Mac.');
  if (!/^[A-Z0-9]{10}$/.test(team)) errors.push('Set a valid FLUX_MAS_TEAM.');
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}$/.test(bundleId))
    errors.push('Set a registered Flux bundle ID.');
  if (!/^[1-9]\d{0,17}$/.test(build || ''))
    errors.push('Set FLUX_MAS_BUILD to an increasing numeric build number.');
  let identities = [];
  if (process.platform === 'darwin') {
    try {
      identities = [
        ...command('/usr/bin/security', ['find-identity', '-v']).matchAll(
          /([A-F0-9]{40}) "([^"]+)"/g,
        ),
      ].map((match) => ({ hash: match[1], name: match[2] }));
    } catch {
      errors.push('The signing keychain could not be read.');
    }
  }
  const selected = identities.find((item) => item.name === identity || item.hash === identity);
  const pattern = development
    ? /^Apple Development:|^Mac Developer:/
    : /^Apple Distribution:|^3rd Party Mac Developer Application:/;
  if (!selected || !pattern.test(selected.name))
    errors.push(
      `Set FLUX_MAS_IDENTITY to an available ${development ? 'Apple Development' : 'Apple Distribution / Mac App Distribution'} identity.`,
    );
  if (
    !development &&
    !identities.some(
      (item) =>
        (item.name === installer || item.hash === installer) &&
        /^3rd Party Mac Developer Installer:|^Mac Installer Distribution:/.test(item.name),
    )
  )
    errors.push(
      'Set FLUX_MAS_INSTALLER_IDENTITY to an available Mac Installer Distribution identity.',
    );
  if (!env.FLUX_MAS_PROFILE)
    errors.push('Supply a Flux macOS provisioning profile in FLUX_MAS_PROFILE.');
  else {
    try {
      validateProfile(readProfile(env.FLUX_MAS_PROFILE), {
        bundleId,
        team,
        development,
        certificate: selected?.hash,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  let resources;
  if (!env.FLUX_MAS_RESOURCES)
    errors.push(
      'Supply the complete portable engine bundle in FLUX_MAS_RESOURCES; current Homebrew tools and the local venv are not portable.',
    );
  else {
    try {
      resources = await auditResources(env.FLUX_MAS_RESOURCES);
    } catch (error) {
      errors.push(error.message);
    }
  }
  let privacyManifest;
  if (!env.FLUX_MAS_PRIVACY_MANIFEST)
    errors.push(
      'Supply the reviewed PrivacyInfo.xcprivacy in FLUX_MAS_PRIVACY_MANIFEST, including native dependency API declarations.',
    );
  else {
    try {
      privacyManifest = await fs.realpath(env.FLUX_MAS_PRIVACY_MANIFEST);
      const privacy = JSON.parse(
        command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', privacyManifest]),
      );
      if (
        typeof privacy.NSPrivacyTracking !== 'boolean' ||
        !Array.isArray(privacy.NSPrivacyCollectedDataTypes) ||
        !Array.isArray(privacy.NSPrivacyAccessedAPITypes)
      )
        throw new Error(
          'The privacy manifest needs valid tracking, collected-data and accessed-API declarations.',
        );
      if (
        !privacy.NSPrivacyAccessedAPITypes.some(
          (item) =>
            item.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryFileTimestamp' &&
            Array.isArray(item.NSPrivacyAccessedAPITypeReasons) &&
            item.NSPrivacyAccessedAPITypeReasons.length,
        )
      )
        throw new Error(
          'The privacy manifest must describe file metadata APIs used by Flux and its runtime.',
        );
    } catch (error) {
      errors.push(error.message);
    }
  }
  return {
    errors,
    bundleId,
    team,
    build,
    identity,
    installer,
    profile: env.FLUX_MAS_PROFILE,
    resources,
    privacyManifest,
    development,
  };
}

async function build(options) {
  const { packager } = require('@electron/packager');
  const { sign, flat } = require('@electron/osx-sign');
  const pkg = require('../package.json');
  const working = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-mas-'));
  try {
    const stage = path.join(working, 'source');
    await fs.mkdir(stage);
    for (const name of ['dist', 'electron'])
      await fs.cp(path.join(ROOT, name), path.join(stage, name), { recursive: true });
    await fs.mkdir(path.join(stage, 'resources'));
    await fs.copyFile(
      path.join(ROOT, 'resources/icon.png'),
      path.join(stage, 'resources/icon.png'),
    );
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(desktopManifest(pkg)));
    await copyDesktopDependencies(ROOT, stage);
    const outputs = await packager({
      dir: stage,
      name: 'Flux',
      platform: 'mas',
      arch: 'arm64',
      electronVersion: require('electron/package.json').version,
      appBundleId: options.bundleId,
      appVersion: pkg.version,
      buildVersion: options.build,
      icon: path.join(ROOT, 'resources/icon.icns'),
      out: path.join(working, 'output'),
      prune: false,
      asar: { unpack: '**/*.{node,dylib}' },
      extendInfo: {
        LSApplicationCategoryType: 'public.app-category.utilities',
        ElectronTeamID: options.team,
      },
    });
    const app = path.join(outputs[0], 'Flux.app'),
      resources = path.join(app, 'Contents/Resources');
    await fs.cp(options.resources.root, resources, { recursive: true, verbatimSymlinks: true });
    for (const name of ['archive.py', 'advanced.py', 'models.py', 'office-formats.json'])
      await fs.copyFile(path.join(ROOT, 'resources', name), path.join(resources, name));
    await fs.cp(path.join(ROOT, 'reference'), path.join(resources, 'reference'), {
      recursive: true,
    });
    await fs.copyFile(options.privacyManifest, path.join(resources, 'PrivacyInfo.xcprivacy'));
    command('/usr/bin/xattr', ['-cr', app]);
    await sign({
      app,
      platform: 'mas',
      type: options.development ? 'development' : 'distribution',
      identity: options.identity,
      provisioningProfile: options.profile,
      optionsForFile: (file) => ({
        hardenedRuntime: false,
        entitlements: path.join(
          CONFIG,
          path.resolve(file) === path.resolve(app)
            ? 'app.entitlements.plist'
            : 'child.entitlements.plist',
        ),
      }),
    });
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const output = path.join(ROOT, 'release/mas');
    await fs.mkdir(output, { recursive: true });
    if (options.development) {
      // A ZIP prevents cloud-sync extended attributes from invalidating the signed app.
      const artifact = path.join(
        output,
        `Flux-${pkg.version}-${options.build}-mas-development.zip`,
      );
      command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, artifact]);
      console.log(`Created development sandbox build: ${artifact}`);
    } else {
      const artifact = path.join(output, `Flux-${pkg.version}-${options.build}.pkg`);
      await flat({ app, platform: 'mas', identity: options.installer, pkg: artifact });
      command('/usr/sbin/pkgutil', ['--check-signature', artifact], { stdio: 'inherit' });
      console.log(
        `Created signed package: ${artifact}\nUpload and TestFlight availability have not been verified.`,
      );
    }
  } finally {
    await fs.rm(working, { recursive: true, force: true });
  }
}

async function main() {
  const options = await preflight({ development: process.argv.includes('--development') });
  if (options.errors.length) {
    console.error(
      `TestFlight preparation blocked:\n${options.errors.map((error) => '- ' + error).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Preflight passed: ${options.bundleId}, build ${options.build}, ${options.resources.binaries} bundled native binaries. Clean-machine sandbox acceptance and App Store Connect validation remain required.`,
  );
  if (!process.argv.includes('--check')) await build(options);
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { validateProfile, readProfile, preflight, auditResources, allowedLoader };
