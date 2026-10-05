#!/usr/bin/env python3
"""Sign bundled converters as sandbox-inheriting children, then reseal the native app."""
import pathlib, plistlib, subprocess, sys, tempfile
MACHO = {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
def sign(app, identity, keychain=None):
    root = app / 'Contents/Resources/ConversionEngine'
    if not root.exists(): return
    with tempfile.TemporaryDirectory(prefix='flux-child-sign-') as temp:
        entitlement = pathlib.Path(temp) / 'child.plist'
        entitlement.write_bytes(plistlib.dumps({'com.apple.security.app-sandbox':True,'com.apple.security.inherit':True}))
        office_entitlement = pathlib.Path(temp) / 'office.plist'
        # Office's UNO bridge creates MAP_JIT trampolines. Keep this exception
        # on Office alone; the native UI and Node worker do not use JIT.
        office_entitlement.write_bytes(plistlib.dumps({'com.apple.security.app-sandbox':True,'com.apple.security.inherit':True,'com.apple.security.cs.allow-jit':True}))
        base = ['codesign','--force','--options','runtime','--sign',identity]
        if keychain: base += ['--keychain',keychain]
        for file in app.rglob('*'):
            if not file.is_symlink(): file.chmod(file.stat().st_mode | 0o200)
        subprocess.run(['xattr','-crs',str(app)],check=True)
        bundles = sorted((p for p in root.rglob('*') if 'ThirdPartyNotices' not in p.parts and p.is_dir() and not p.is_symlink() and p.suffix in ['.app','.framework','.appex','.mdimporter']),key=lambda p:len(p.parts),reverse=True)
        primary = set()
        for bundle in bundles:
            info = bundle / 'Contents/Info.plist'
            if info.is_file():
                executable = plistlib.loads(info.read_bytes()).get('CFBundleExecutable')
                if executable: primary.add(bundle / 'Contents/MacOS' / executable)
        for file in root.rglob('*'):
            if file in primary or not file.is_file() or file.is_symlink() or file.suffix == '.class': continue
            with file.open('rb') as stream: header = stream.read(4)
            if header not in MACHO: continue
            result = subprocess.run(['otool','-hv',str(file)],capture_output=True,text=True)
            if result.returncode: continue
            executable = 'EXECUTE' in result.stdout
            subprocess.run(base + (['--entitlements',str(entitlement)] if executable else []) + [str(file)],check=True)
        for bundle in bundles:
            # Vendor apps include signed non-Mach-O resources; regenerate their
            # signatures after stripping source-machine extended attributes.
            child_entitlement = office_entitlement if bundle.name == 'LibreOfficeDev.app' else entitlement
            subprocess.run(base + (['--deep','--entitlements',str(child_entitlement)] if bundle.suffix != '.framework' else []) + [str(bundle)],check=True)
        # Preserve the main app's existing provisioning and entitlements.
        subprocess.run(base + ['--preserve-metadata=entitlements,identifier,requirements',str(app)],check=True,stderr=subprocess.DEVNULL)
        subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
if __name__ == '__main__': sign(pathlib.Path(sys.argv[1]),sys.argv[2],sys.argv[3] if len(sys.argv)>3 else None)
