#!/opt/venv/bin/python
import sys, json, pathlib
import pymupdf
command, source = sys.argv[1:3]
with pymupdf.open(source) as doc:
    if doc.is_encrypted: raise ValueError('Encrypted PDFs are not supported.')
    if len(doc) > 100: raise ValueError('PDF exceeds the 100 page server limit.')
    if command == 'inspect': print(json.dumps({'pages': len(doc)}))
    elif command == 'text':
        text = '\n\n'.join(p.get_text() for p in doc)
        if not text.strip(): raise ValueError('No selectable text')
        pathlib.Path(sys.argv[3]).write_text(text, encoding='utf8')
    elif command == 'render':
        folder, fmt, dpi = sys.argv[3:6]
        dpi = min(int(dpi), 216)
        for n, page in enumerate(doc):
            if page.rect.width * page.rect.height * (dpi / 72) ** 2 > 20_000_000: raise ValueError('PDF page exceeds the pixel limit.')
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            pix.save(str(pathlib.Path(folder) / ('page-%03d.%s' % (n + 1, fmt))))
            print('PAGE %d %d' % (n + 1, len(doc)))
    else: raise ValueError('Unknown PDF operation')
