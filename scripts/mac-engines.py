#!/usr/bin/env python3
"""Bundle the shared conversion engine, tools, libraries and data for a local Mac build."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = pathlib.Path(os.environ.get('FLUX_MAC_ENGINE_RESOURCES', '/private/tmp/flux-full-engine/ConversionEngine'))
CACHE = pathlib.Path(os.environ.get('FLUX_MAC_ENGINE_CACHE', pathlib.Path.home() / 'Library/Caches/flux-mac-engines'))
MACHO = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
# Official Node.js LTS builds, pinned to https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.
NODE_VERSION = 'v24.21.0'
NODE_SHA256 = {'arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
               'x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097'}
def command(*args):
    return subprocess.check_output(args, text=True).strip()
def sha256(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''): digest.update(block)
    return digest.hexdigest()
def node_binary(arch):
    """Download (once) and verify an official Node.js build; return its extracted binary."""
    name = f'node-{NODE_VERSION}-darwin-{arch}'
    archive = CACHE / (name + '.tar.gz')
    if not archive.exists() or sha256(archive) != NODE_SHA256[arch]:
        CACHE.mkdir(parents=True, exist_ok=True)
        partial = archive.with_name(archive.name + '.partial')
        subprocess.run(['curl','--fail','--location','--proto','=https','--tlsv1.2','--retry','2','--silent','--show-error','-o',str(partial),f'https://nodejs.org/dist/{NODE_VERSION}/{name}.tar.gz'], check=True)
        if sha256(partial) != NODE_SHA256[arch]:
            partial.unlink(); raise RuntimeError(f'Checksum mismatch for {name}.tar.gz')
        partial.replace(archive)
    # Extract only the verified executable; never reuse a previously extracted copy.
    binary = CACHE / name / 'node'
    binary.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar, tar.extractfile(f'{name}/bin/node') as source, binary.open('wb') as target:
        shutil.copyfileobj(source, target)
    binary.chmod(0o755)
    return binary
def macho_architectures(root):
    """Architectures shared by every Mach-O file under root, so one thin tool limits the whole stage."""
    common = None
    for file in sorted(root.rglob('*')):
        if file.is_symlink() or not file.is_file() or file.suffix == '.class': continue
        with file.open('rb') as stream: header = stream.read(4)
        if header not in MACHO: continue
        try: archs = set(command('lipo','-archs',str(file)).split())
        except subprocess.CalledProcessError: raise RuntimeError(f'Cannot read architectures of {file}')
        common = archs if common is None else common & archs
    return sorted(common or [])
def copy(source, destination):
    source = pathlib.Path(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        subprocess.run(['ditto', '--noextattr', '--norsrc', str(source), str(destination)], check=True)
    else: shutil.copy2(source, destination)
def main():
    DEST.mkdir(parents=True, exist_ok=True)
    refresh = '--refresh' in sys.argv
    with_3d = '--with-3d' in sys.argv
    universal = '--universal' in sys.argv
    engines = json.loads(command('node', '-e', "require('./electron/engine.cjs').detectEngines(require('node:path').resolve('resources')).then(e=>console.log(JSON.stringify(e)))"))
    for folder in ['electron']:
        copy(ROOT / folder, DEST / folder)
    copy(ROOT / 'scripts/mac-engine.cjs', DEST / 'scripts/mac-engine.cjs')
    copy(ROOT / 'scripts/mac-calibre.sh', DEST / 'scripts/mac-calibre.sh')
    (DEST / 'scripts/mac-calibre.sh').chmod(0o755)
    for name in ['archive.py', 'advanced.py', 'models.py', 'pdf-tool', 'office-formats.json', 'imagemagick']:
        copy(ROOT / 'resources' / name, DEST / name)
    subprocess.run(['node', '-e', "require('./scripts/desktop-dependencies.cjs').copyDesktopDependencies(process.cwd(),process.argv[1])", str(DEST)], check=True)
    # --universal adds the x64 build; the release gate requires both architectures.
    runtimes = [node_binary(arch) for arch in (['arm64','x64'] if universal else ['arm64'])]
    (DEST / 'bin').mkdir(parents=True, exist_ok=True)
    if (DEST / 'bin/node').exists(): (DEST / 'bin/node').unlink()
    if universal: subprocess.run(['lipo','-create','-output',str(DEST/'bin/node'),*map(str, runtimes)], check=True)
    else: copy(runtimes[0], DEST / 'bin/node')
    prefixes = {}
    pending = set()
    def brew_path(source):
        source = pathlib.Path(source).resolve()
        parts = source.parts
        if parts[:4] != ('/', 'opt', 'homebrew', 'Cellar'): raise RuntimeError(f'Unexpected tool path {source}')
        prefix = pathlib.Path(*parts[:6])
        pending.add(prefix)
        return DEST / 'brew' / parts[4] / parts[5] / pathlib.Path(*parts[6:])
    names = ['ffmpeg','ffprobe','pandoc','qpdf','ghostscript','jpegtran','oxipng','cwebp','magick','sevenzip','tesseract']
    manifest = {}
    for name in names:
        if not engines.get(name): raise RuntimeError(f'Missing required engine: {name}')
        manifest[name] = str(brew_path(engines[name]).relative_to(DEST))
    apps = [('office','LibreOfficeDev.app'),('calibre','calibre.app')]
    if with_3d: apps.append(('blender','Blender.app'))
    elif (DEST/'apps/Blender.app').exists(): shutil.rmtree(DEST/'apps/Blender.app')
    for name, appname in apps:
        source = pathlib.Path(engines[name])
        app = next(p for p in source.parents if p.suffix == '.app')
        if not (DEST / 'apps' / appname).exists(): copy(app, DEST / 'apps' / appname)
        manifest[name] = str((DEST / 'apps' / appname / source.relative_to(app)).relative_to(DEST))
    manifest['calibre'] = 'scripts/mac-calibre.sh'
    copy(ROOT / 'resources/python-runtime', DEST / 'python-runtime')
    python = pathlib.Path(engines['python']).resolve()
    bundled_python = brew_path(python)
    for name in ['python','python3','python3.12']:
        file = DEST / 'python-runtime/bin' / name
        if file.exists() or file.is_symlink(): file.unlink()
        file.symlink_to(os.path.relpath(bundled_python, file.parent))
    cfg = DEST / 'python-runtime/pyvenv.cfg'
    cfg.write_text('home = ' + str(bundled_python.parent) + '\ninclude-system-site-packages = false\nversion = 3.12.14\n')
    # A relative wrapper supplies private stdlib/site packages after the app moves.
    file = DEST / 'python-runtime/bin/python'
    file.unlink()
    framework = bundled_python.parent.parent
    relative = os.path.relpath(bundled_python, file.parent)
    home = os.path.relpath(framework, file.parent)
    file.write_text('#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport PYTHONHOME="$base/' + home + '"\nexport PYTHONPATH="$base/../lib/python3.12/site-packages"\nexport PYTHONNOUSERSITE=1\nexec "$base/' + relative + '" "$@"\n')
    file.chmod(0o755)
    manifest['python'] = 'python-runtime/bin/python'
    manifest['pdf'] = 'pdf-tool'
    processed = set()
    # Include full formula data as well as libraries (codec modules, fonts, OCR, Ghostscript).
    while not refresh and pending - processed:
        prefix = next(iter(pending - processed)); processed.add(prefix)
        target = DEST / 'brew' / prefix.parent.name / prefix.name
        if not target.exists(): copy(prefix, target)
        for file in target.rglob('*'):
            if not file.is_file() or file.is_symlink() or file.suffix == '.class': continue
            with file.open('rb') as stream: header = stream.read(4)
            if header not in MACHO: continue
            try: linked = command('otool','-L',str(file)).splitlines()[1:]
            except subprocess.CalledProcessError: continue
            for line in linked:
                dependency = line.strip().split(' (compatibility')[0]
                if dependency.startswith('/opt/homebrew/'):
                    brew_path(dependency)
    # Homebrew stores only the versioned Python framework; supply the standard
    # framework entry points so macOS can seal and validate it as a bundle.
    python_framework = DEST / 'brew' / python.parts[4] / python.parts[5] / 'Frameworks/Python.framework'
    for file, target in [('Versions/Current','3.12'),('Python','Versions/Current/Python'),('Resources','Versions/Current/Resources'),('Headers','Versions/Current/Headers')]:
        link = python_framework / file
        if not link.exists() and not link.is_symlink(): link.symlink_to(target)
    for file in ([] if refresh else DEST.rglob('*')):
        if not file.is_symlink(): file.chmod(file.stat().st_mode | 0o200)
    subprocess.run(['xattr', '-crs', str(DEST)], check=True)
    # Relocate every native dependency; no Homebrew path is needed at runtime.
    for file in ([] if refresh else DEST.rglob('*')):
        if file.is_symlink():
            link = os.readlink(file)
            if link.startswith('/opt/homebrew/'):
                target = brew_path(link)
                file.unlink(); file.symlink_to(os.path.relpath(target, file.parent))
            continue
        if not file.is_file() or file.suffix == '.class': continue
        with file.open('rb') as stream: header = stream.read(4)
        if header not in MACHO: continue
        file.chmod(file.stat().st_mode | 0o200)
        try: linked = command('otool','-L',str(file)).splitlines()[1:]
        except subprocess.CalledProcessError: continue
        for line in linked:
            dependency = line.strip().split(' (compatibility')[0]
            if dependency.startswith('/opt/homebrew/'):
                target = brew_path(dependency)
                subprocess.run(['install_name_tool','-change',dependency,'@loader_path/' + os.path.relpath(target,file.parent),str(file)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Remove absolute run paths; relocated references above are self-contained.
        loads = command('otool','-l',str(file)).split('Load command')
        import re
        for load in loads:
            if 'cmd LC_RPATH' in load:
                match = re.search(r'path (.+) \(offset ', load)
                if match and match[1].startswith(('/opt/homebrew/','/usr/local/','/Users/')):
                    subprocess.run(['install_name_tool','-delete_rpath',match[1],str(file)], check=True, stderr=subprocess.DEVNULL)
        subprocess.run(['codesign','--force','--deep','--sign','-',str(file)], check=True, stderr=subprocess.DEVNULL)
    magick_root = (DEST / manifest['magick']).parent.parent
    gs_root = (DEST / manifest['ghostscript']).parent.parent
    tess_root = (DEST / manifest['tesseract']).parent.parent
    relative = lambda paths: [str(p.relative_to(DEST)) for p in paths if p.is_dir()]
    environment = {
        'MAGICK_HOME': relative([magick_root]),
        'MAGICK_CONFIGURE_PATH': relative(list((magick_root/'etc').glob('ImageMagick*')) + list((magick_root/'share').glob('ImageMagick*'))),
        'MAGICK_CODER_MODULE_PATH': relative(list((magick_root/'lib').glob('ImageMagick*/modules*/coders'))),
        'MAGICK_CODER_FILTER_PATH': relative(list((magick_root/'lib').glob('ImageMagick*/modules*/filters'))),
        'GS_LIB': relative(list((gs_root/'share/ghostscript').glob('*/Resource/Init')) + list((gs_root/'share/ghostscript').glob('*/lib')) + list((gs_root/'share/ghostscript').glob('*/Resource/Font'))),
        'TESSDATA_PREFIX': relative([tess_root/'share/tessdata']),
    }
    (DEST / 'engines.json').write_text(json.dumps({'schemaVersion':1,'engines':manifest,'excludedEngines':[] if with_3d else ['blender'],'distributionReady':False,'environment':environment,'architectures':macho_architectures(DEST)}))
    # Engine subprocesses use their own data directories instead of host installations.
    subprocess.run([str(DEST/'bin/node'),str(DEST/'scripts/mac-engine.cjs'),'--catalog'], check=True)
    print(f'Bundled {len(processed)} tool/library packages in {DEST}')
if __name__ == '__main__': main()
