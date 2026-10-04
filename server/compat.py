#!/opt/venv/bin/python
"""Small Linux equivalents for the desktop engine's fixed native tool calls."""
import sys, os, pathlib, zipfile, subprocess
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == 'ditto':
    source, out = map(pathlib.Path, args[-2:])
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        for entry in source.rglob('*') if source.is_dir() else [source]:
            if entry.is_symlink(): raise ValueError('Links cannot be archived.')
            if not entry.is_file() and not entry.is_dir(): raise ValueError('Special files cannot be archived.')
            archive.write(entry, entry.relative_to(source) if source.is_dir() else entry.name)
elif name == 'sips':
    if args[:3] != ['-s', 'format', 'png'] or args[-2] != '--out': raise ValueError('Invalid image operation')
    subprocess.run(['/usr/local/bin/magick', args[3] + '[0]', args[-1]], check=True)
elif name == 'oxipng':
    out, source = args[args.index('--out') + 1], args[-1]
    subprocess.run(['/usr/bin/optipng', '-quiet', '-o4', '-out', out, '--', source], check=True)
elif name == 'magick':
    executable = '/usr/bin/identify' if args and args[0] == 'identify' else '/usr/bin/convert'
    os.execv(executable, [executable] + (args[1:] if executable.endswith('identify') else args))
else: raise ValueError('Invalid compatibility tool')
