"""Format-specific local conversions for fonts and tabular data."""
import sys, json, pathlib, sqlite3

def main():
    action, source = sys.argv[1:3]
    if action == 'font-inspect':
        from fontTools.ttLib import TTFont
        font = TTFont(source, fontNumber=0, lazy=True)
        print(json.dumps({'outline': 'otf' if font.sfntVersion == 'OTTO' else 'ttf'}))
        font.close(); return
    target, output = sys.argv[3:5]
    if action == 'pdf-docx':
        from pdf2docx import Converter
        converter = Converter(source)
        try: converter.convert(output, multi_processing=False)
        finally: converter.close()
        return
    if action == 'pdf-text':
        import pymupdf, tempfile, subprocess, os
        doc = pymupdf.open(source)
        if doc.needs_pass: raise ValueError('Unlock this PDF before converting it.')
        pages = []
        with tempfile.TemporaryDirectory(prefix='flux-ocr-', dir=pathlib.Path(output).parent) as folder:
            for number, page in enumerate(doc):
                text = page.get_text()
                if not text.strip():
                    image = pathlib.Path(folder) / ('page-' + str(number) + '.png')
                    scale = min(3, (20000000 / max(1, page.rect.width * page.rect.height)) ** .5)
                    page.get_pixmap(matrix=pymupdf.Matrix(scale, scale)).save(image)
                    command = __import__('shutil').which('tesseract') or '/usr/bin/tesseract'
                    result = subprocess.run([command, str(image), 'stdout', '-l', 'eng'], capture_output=True, text=True, timeout=120)
                    if result.returncode: raise ValueError('Scanned-page OCR failed. ' + result.stderr[-500:])
                    text = result.stdout
                pages.append(text)
        text = '\n\n'.join(pages)
        if not text.strip(): raise ValueError('No text could be recognized in this PDF.')
        pathlib.Path(output).write_text(text, encoding='utf8'); return
    if action == 'font':
        from fontTools.ttLib import TTFont
        font = TTFont(source, fontNumber=0, recalcTimestamp=False)
        outline = 'otf' if font.sfntVersion == 'OTTO' else 'ttf'
        if target in ('otf', 'ttf') and target != outline:
            raise ValueError('Changing outline types requires rebuilding the font; choose its native outline or WOFF/WOFF2.')
        font.flavor = target if target in ('woff', 'woff2') else None
        font.save(output); font.close(); return
    import pandas as pd
    ext = pathlib.Path(source).suffix.lower()
    if ext in ('.parquet', '.pq'): df = pd.read_parquet(source)
    elif ext in ('.feather', '.arrow'): df = pd.read_feather(source)
    elif ext in ('.ndjson', '.jsonl'): df = pd.read_json(source, lines=True)
    elif ext == '.json':
        records = json.loads(pathlib.Path(source).read_text(encoding='utf8'))
        if not isinstance(records, list) or any(not isinstance(r, dict) for r in records): raise ValueError('Table conversion needs an array of records.')
        if any(isinstance(v, (dict, list)) for r in records for v in r.values()): raise ValueError('Nested values cannot be represented as a flat table.')
        df = pd.DataFrame(records)
    elif ext in ('.sqlite', '.sqlite3', '.db'):
        conn = sqlite3.connect(pathlib.Path(source).resolve().as_uri() + '?mode=ro', uri=True)
        tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        if not tables: raise ValueError('This database has no user tables.')
        if target == 'json':
            result = {}
            for table in tables:
                quoted = table.replace('"', '""'); frame = pd.read_sql_query('SELECT * FROM "' + quoted + '"', conn)
                result[table] = json.loads(frame.to_json(orient='records', date_format='iso', force_ascii=False))
            pathlib.Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8'); conn.close(); return
        if len(tables) != 1: raise ValueError('A database with multiple tables can export to JSON. A single table is needed for other outputs.')
        df = pd.read_sql_query('SELECT * FROM "' + tables[0].replace('"', '""') + '"', conn); conn.close()
    else: df = pd.read_csv(source, sep='\t' if ext == '.tsv' else ',', dtype=str, keep_default_na=False)
    if target == 'parquet': df.to_parquet(output, index=False)
    elif target in ('feather', 'arrow'): df.reset_index(drop=True).to_feather(output)
    elif target in ('ndjson', 'jsonl'): df.to_json(output, orient='records', lines=True, date_format='iso', force_ascii=False)
    elif target == 'json': df.to_json(output, orient='records', indent=2, date_format='iso', force_ascii=False)
    else:
        # Avoid spreadsheet formula evaluation on exported tables.
        def safe(v):
            if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r')): return "'" + v
            return v
        df = df.map(safe)
        df.to_csv(output, index=False, sep='\t' if target == 'tsv' else ',')
try: main()
except Exception as error:
    print(str(error), file=sys.stderr); sys.exit(1)
