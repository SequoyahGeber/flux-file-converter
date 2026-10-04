"""Local archive repacking with traversal, link, and expansion limits."""
import sys, os, zipfile, tarfile, pathlib, shutil, gzip, bz2, lzma, json, subprocess, itertools, stat
MAX_BYTES = min(int(os.environ.get('FLUX_ARCHIVE_MAX_BYTES', 2 * 1024**3)), 8 * 1024**3)
MAX_FILES = min(int(os.environ.get('FLUX_ARCHIVE_MAX_FILES', 25000)), 25000)
count = 0
total = 0

def safe_path(root, name):
    global count
    count += 1
    if count > MAX_FILES: raise ValueError('Archive contains too many entries (maximum 25,000).')
    name = name.replace('\\', '/')
    if name.startswith('/') or ':' in name.split('/')[0] or '..' in pathlib.PurePosixPath(name).parts:
        raise ValueError('Archive contains an unsafe path: ' + name)
    dest = (root / name).resolve()
    if dest != root and root not in dest.parents: raise ValueError('Archive path leaves its destination.')
    return dest

def copy_limited(src, dest):
    global total
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists(): raise ValueError('Archive contains duplicate file paths.')
    with open(dest, 'xb') as out:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk: break
            total += len(chunk)
            if total > MAX_BYTES: raise ValueError('Expanded archive exceeds the 2 GB safety limit.')
            out.write(chunk)

try:
    source, target, output, folder = sys.argv[1:5]
    action = sys.argv[5] if len(sys.argv) > 5 else 'repack'
    root = pathlib.Path(folder).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if action == 'pack':
        sources = json.loads(pathlib.Path(source).read_text())
        used = set()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for source_path in sources:
                source_file = pathlib.Path(source_path)
                name = source_file.name
                if name in used: raise ValueError('Items with the same name cannot share a ZIP. Rename one first.')
                used.add(name)
                # Iterate lazily: enumerating an entire large folder before
                # checking MAX_FILES defeats the memory and entry limits.
                entries = itertools.chain([source_file], source_file.rglob('*')) if source_file.is_dir() else [source_file]
                for entry in entries:
                    if entry.is_symlink(): raise ValueError('Symlinks cannot be added to a ZIP.')
                    if not entry.is_file() and not entry.is_dir(): raise ValueError('Special files cannot be archived.')
                    arcname = entry.relative_to(source_file.parent).as_posix()
                    safe_path(root, arcname)
                    if entry.is_dir():
                        archive.write(entry, arcname)
                    else:
                        descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(descriptor, 'rb') as content:
                            info = os.fstat(content.fileno())
                            if not stat.S_ISREG(info.st_mode): raise ValueError('Special files cannot be archived.')
                            if total + info.st_size > MAX_BYTES: raise ValueError('ZIP inputs exceed the 2 GB safety limit.')
                            with archive.open(arcname, 'w', force_zip64=True) as out:
                                while True:
                                    chunk = content.read(1024 * 1024)
                                    if not chunk: break
                                    total += len(chunk)
                                    if total > MAX_BYTES: raise ValueError('ZIP inputs exceed the 2 GB safety limit.')
                                    out.write(chunk)
        print('OK')
        sys.exit(0)
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            for entry in archive.infolist():
                path = safe_path(root, entry.filename)
                mode = entry.external_attr >> 16
                if (mode & 0o170000) == 0o120000: raise ValueError('Symlinks in archives are not supported.')
                if (mode & 0o170000) not in (0, 0o100000, 0o040000): raise ValueError('Special files in archives are not supported.')
                if entry.is_dir(): path.mkdir(parents=True, exist_ok=True)
                else:
                    if entry.file_size > MAX_BYTES: raise ValueError('Archive entry exceeds 2 GB.')
                    with archive.open(entry) as content: copy_limited(content, path)
                    os.chmod(path, (mode & 0o777) or 0o644)
    elif tarfile.is_tarfile(source):
        with tarfile.open(source, 'r:*') as archive:
            for entry in archive:
                path = safe_path(root, entry.name)
                if entry.isdir(): path.mkdir(parents=True, exist_ok=True)
                elif entry.isfile():
                    if entry.size > MAX_BYTES: raise ValueError('Archive entry exceeds 2 GB.')
                    with archive.extractfile(entry) as content: copy_limited(content, path)
                    os.chmod(path, entry.mode & 0o777)
                else: raise ValueError('Links and special files in archives are not supported.')
    elif pathlib.Path(source).suffix.lower() in ('.7z', '.rar'):
        sevenzip = shutil.which('7zz') or shutil.which('7z') or '/usr/local/bin/7zz'
        listing = subprocess.run([sevenzip, 'l', '-slt', '-ba', '-p', '--', source], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if listing.returncode != 0: raise ValueError('This archive is encrypted, damaged, or unsupported.')
        entries = []
        for block in listing.stdout.decode('utf8', errors='strict').strip().split('\n\n'):
            entry = {}
            for line in block.splitlines():
                if ' = ' in line:
                    key, value = line.split(' = ', 1); entry[key] = value
            if 'Path' in entry: entries.append(entry)
        for entry in entries:
            path = safe_path(root, entry['Path'])
            if any('Link' in key and value for key, value in entry.items()) or 'L' in entry.get('Attributes', '').split('_')[0]:
                raise ValueError('Links in archives are not supported.')
            if entry.get('Folder') == '+' or entry.get('Attributes', '').startswith('D'):
                path.mkdir(parents=True, exist_ok=True); continue
            if int(entry.get('Size', '0')) > MAX_BYTES: raise ValueError('Archive entry exceeds 2 GB.')
            process = subprocess.Popen([sevenzip, 'e', '-so', '-spd', '-y', '-p', '--', source, entry['Path']], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                copy_limited(process.stdout, path)
                if process.wait(timeout=60) != 0: raise ValueError('Could not decode an archive entry.')
            finally:
                if process.poll() is None: process.kill(); process.wait()
    else:
        suffix = pathlib.Path(source).suffix.lower()
        opener = {'.gz': gzip.open, '.bz2': bz2.open, '.xz': lzma.open}.get(suffix)
        if not opener: raise ValueError('This archive is damaged or unsupported.')
        with opener(source, 'rb') as content: copy_limited(content, safe_path(root, pathlib.Path(source).stem))
    if action == 'extract':
        print('OK')
        sys.exit(0)
    if target == '7z':
        sevenzip = shutil.which('7zz') or shutil.which('7z') or '/usr/local/bin/7zz'
        result = subprocess.run([sevenzip, 'a', '-t7z', '-mx=9', '--', output, '.'], cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        if result.returncode: raise ValueError('Could not create the 7Z archive.')
    elif target == 'zip':
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(root.rglob('*')):
                archive.write(file, file.relative_to(root).as_posix() + ('/' if file.is_dir() else ''))
    else:
        mode = {'tar': 'w', 'tgz': 'w:gz', 'tbz2': 'w:bz2', 'txz': 'w:xz'}[target]
        with tarfile.open(output, mode) as archive:
            for file in sorted(root.iterdir()): archive.add(file, arcname=file.name)
    print('OK')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
