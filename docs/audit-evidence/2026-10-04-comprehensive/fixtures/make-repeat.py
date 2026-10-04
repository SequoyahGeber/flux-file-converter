from pathlib import Path
Path('repeat.txt').write_bytes(b'A' * 1024 * 1024)
