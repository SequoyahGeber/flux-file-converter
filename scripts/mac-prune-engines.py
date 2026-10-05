#!/usr/bin/env python3
"""Trim build-only files and redundant CPU slices from a private engine stage."""
import argparse, json, pathlib, shutil, subprocess

MACHO = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}

def size(root):
    return sum(p.stat().st_size for p in root.rglob('*') if p.is_file() and not p.is_symlink())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--architecture', choices=['arm64','x86_64'])
    args = parser.parse_args()
    root = args.root.resolve()
    if root.name != 'ConversionEngine' or not (root/'engines.json').is_file():
        raise SystemExit('Pass a private ConversionEngine stage, not an installed app.')
    before = size(root)
    notices = root/'ThirdPartyNotices'
    # Preserve notices before dropping manuals and development directories.
    for p in list(root.rglob('*')):
        if p.is_file() and not p.is_symlink() and p.name.lower().startswith(('license','copying','notice')) and notices not in p.parents:
            destination = notices/p.relative_to(root)
            destination.parent.mkdir(parents=True,exist_ok=True)
            if destination.exists(): destination.chmod(destination.stat().st_mode | 0o200)
            shutil.copy2(p,destination)
            destination.chmod(destination.stat().st_mode | 0o200)
    removed = []
    def remove(p):
        if p.is_symlink() or p.is_file(): p.unlink()
        elif p.is_dir(): shutil.rmtree(p)
        else: return
        removed.append(str(p.relative_to(root)))
    # Static link archives, headers, manuals and build metadata are not loaded
    # by any converter. Keep runtime data, fonts, licences and codec modules.
    for prefix in (root/'brew').glob('*/*'):
        for name in ['include','share/man','share/doc','share/locale','lib/pkgconfig','lib/cmake']:
            remove(prefix/name)
    for p in list(root.rglob('*.a')): remove(p)
    for p in list(root.rglob('__pycache__')): remove(p)
    for p in (root/'python-runtime/lib/python3.12/site-packages').glob('pip*'): remove(p)
    # Keep Calibre's viewer tree: ebook PDF export shares its headless renderer
    # and WebEngine resources. Blender's translated UI is not used by Flux.
    for p in (root/'apps/Blender.app/Contents/Resources').glob('*/datafiles/locale'): remove(p)
    for p in (root/'apps/Blender.app/Contents/Resources').glob('*/python/lib/python*/config-*'): remove(p)
    for p in (root/'brew').glob('python@*/**/lib/python*/test'): remove(p)
    thinned = 0
    if args.architecture:
        for p in root.rglob('*'):
            if not p.is_file() or p.is_symlink() or p.suffix == '.class': continue
            with p.open('rb') as stream: header = stream.read(4)
            if header not in MACHO: continue
            result = subprocess.run(['lipo','-archs',str(p)],capture_output=True,text=True)
            architectures = result.stdout.split()
            if result.returncode or len(architectures) < 2: continue
            if args.architecture not in architectures: raise RuntimeError(f'{p} lacks {args.architecture}')
            temporary = p.with_name(p.name+'.flux-thin')
            subprocess.run(['lipo',str(p),'-thin',args.architecture,'-output',str(temporary)],check=True)
            temporary.chmod(p.stat().st_mode)
            temporary.replace(p); thinned += 1
        manifest = json.loads((root/'engines.json').read_text())
        manifest['architectures'] = [args.architecture]
        (root/'engines.json').write_text(json.dumps(manifest))
    # Re-sign after this step. Never prune a signed deliverable in place.
    receipt = {'beforeBytes':before,'afterBytes':size(root),'removed':removed,'thinnedBinaries':thinned,'architecture':args.architecture}
    (root/'size-reduction.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps({k:v for k,v in receipt.items() if k != 'removed'},indent=2))

if __name__ == '__main__': main()
