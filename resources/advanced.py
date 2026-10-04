"""Format-specific local conversions for fonts and tabular data."""
import sys, json, pathlib, sqlite3, csv, math
from decimal import Decimal

TABLE_BYTES = 50 * 1024 * 1024
TABLE_ROWS = 100000
TABLE_COLUMNS = 1000
TABLE_CELLS = 1000000

def table_shape(rows, columns):
    if columns > TABLE_COLUMNS or rows > TABLE_ROWS or rows * columns > TABLE_CELLS:
        raise ValueError("Tables are limited to 1,000 columns, 100,000 rows and 1,000,000 cells.")

def headers(names):
    if not names or any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError("CSV needs unique, nonempty headers and at most 1,000 columns.")
    table_shape(0, len(names))
    if any(n in ("__proto__", "constructor", "prototype") for n in names):
        raise ValueError("Data contains an unsafe reserved key.")

def exact_float(token):
    value = float(token)
    if not math.isfinite(value) or (value == 0 and token.startswith("-")) or Decimal(token) != Decimal(str(value)):
        raise ValueError("This numeric value cannot be converted without losing precision. Use quoted strings for exact identifiers or high-precision decimals.")
    return value

def exact_int(token):
    value = int(token)
    # Match the shared JavaScript route before selecting a native table adapter.
    if (value == 0 and token.startswith("-")) or Decimal(value) != Decimal(str(float(value))):
        raise ValueError("This numeric identifier cannot be converted without losing precision. Use a quoted string.")
    return value

def pairs(items):
    result = {}
    for key, value in items:
        if key in result: raise ValueError("JSON contains duplicate keys.")
        result[key] = value
    return result

def read_json(text):
    def invalid(value): raise ValueError("Non-finite numbers are not supported.")
    return json.loads(text, parse_float=exact_float, parse_int=exact_int, parse_constant=invalid, object_pairs_hook=pairs)

def records_frame(records, pd):
    if not isinstance(records, list) or any(not isinstance(r, dict) for r in records):
        raise ValueError("Table conversion needs an array of records.")
    names = set()
    for record in records:
        if any(isinstance(v, (dict, list)) for v in record.values()):
            raise ValueError("Nested values cannot be represented as a flat table.")
        names.update(record)
        table_shape(len(records), len(names))
    if names: headers(list(names))
    # Object dtype keeps integers, booleans and nulls from coercing one another.
    return pd.DataFrame(records, dtype=object)

def write_json(output, value, lines=False):
    encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, indent=None if lines else 2, default=json_scalar)
    size = 0
    with pathlib.Path(output).open("w", encoding="utf8") as stream:
        for item in value if lines else [value]:
            for chunk in encoder.iterencode(item):
                size += len(chunk.encode("utf8"))
                if size > TABLE_BYTES: raise ValueError("Converted data exceeds 50 MB.")
                stream.write(chunk)
            stream.write("\n"); size += 1
            if size > TABLE_BYTES: raise ValueError("Converted data exceeds 50 MB.")

def json_scalar(value):
    import datetime
    if isinstance(value, (datetime.datetime, datetime.date)): return value.isoformat()
    if hasattr(value, "item"): return value.item()
    raise ValueError("This table value cannot be represented in JSON without losing its type or precision.")

def frame_records(df):
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")

def bounded_frame(df):
    headers(list(df.columns))
    table_shape(len(df), len(df.columns))
    if df.memory_usage(index=True, deep=True).sum() > TABLE_BYTES:
        raise ValueError("Decoded table exceeds 50 MB.")
    return df

def read_table(source, pd):
    ext = pathlib.Path(source).suffix.lower()
    if ext in (".csv", ".tsv"):
        csv.field_size_limit(TABLE_BYTES)
        with pathlib.Path(source).open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, delimiter="\t" if ext == ".tsv" else ",", strict=True)
            names = next(reader, []); headers(names); rows = []
            for row in reader:
                if not row: continue
                if len(row) != len(names): raise ValueError("CSV rows must match the header column count.")
                table_shape(len(rows) + 1, len(names)); rows.append(row)
        return bounded_frame(pd.DataFrame(rows, columns=names, dtype=object))
    if ext == ".json":
        return bounded_frame(records_frame(read_json(pathlib.Path(source).read_text(encoding="utf8")), pd))
    if ext in (".ndjson", ".jsonl"):
        records = []
        with pathlib.Path(source).open(encoding="utf8") as stream:
            for line in stream:
                if not line.strip(): continue
                table_shape(len(records) + 1, 1)
                record = read_json(line)
                if not isinstance(record, dict): raise ValueError("Table conversion needs records.")
                records.append(record)
        return bounded_frame(records_frame(records, pd))
    if ext in (".parquet", ".pq"):
        import pyarrow.parquet as pq
        file = pq.ParquetFile(source)
        table_shape(file.metadata.num_rows, len(file.schema_arrow))
        if sum(file.metadata.row_group(i).total_byte_size for i in range(file.metadata.num_row_groups)) > TABLE_BYTES:
            raise ValueError("Decoded table exceeds 50 MB.")
        batches = []; size = 0
        for batch in file.iter_batches(batch_size=1000):
            size += batch.nbytes
            if size > TABLE_BYTES: raise ValueError("Decoded table exceeds 50 MB.")
            batches.append(batch)
        import pyarrow as pa
        return bounded_frame(pa.Table.from_batches(batches, schema=file.schema_arrow).to_pandas(types_mapper=pd.ArrowDtype))
    if ext in (".feather", ".arrow"):
        import pyarrow as pa
        batches = []; rows = size = 0
        with pa.memory_map(source, "r") as stream:
            reader = pa.ipc.open_file(stream); table_shape(0, len(reader.schema))
            for i in range(reader.num_record_batches):
                batch = reader.get_batch(i); rows += batch.num_rows; size += batch.nbytes
                table_shape(rows, len(reader.schema))
                if size > TABLE_BYTES: raise ValueError("Decoded table exceeds 50 MB.")
                batches.append(batch)
            return bounded_frame(pa.Table.from_batches(batches, schema=reader.schema).to_pandas(types_mapper=pd.ArrowDtype))
    raise ValueError("Unsupported table input.")

def sqlite_frame(conn, table, pd):
    quoted = table.replace('"', '""')
    names = [row[1] for row in conn.execute('PRAGMA table_info("' + quoted + '")')]
    headers(names)
    cursor = conn.execute('SELECT * FROM "' + quoted + '" LIMIT 100001')
    records = []
    while True:
        batch = cursor.fetchmany(1000)
        if not batch: break
        table_shape(len(records) + len(batch), len(names)); records.extend(batch)
    return bounded_frame(pd.DataFrame(records, columns=names, dtype=object))

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
    if pathlib.Path(source).stat().st_size > TABLE_BYTES:
        raise ValueError('Structured data conversion is limited to 50 MB per file.')
    if pathlib.Path(source).resolve() == pathlib.Path(output).resolve():
        raise ValueError('Choose a separate output file.')
    import pandas as pd
    ext = pathlib.Path(source).suffix.lower()
    if ext in ('.sqlite', '.sqlite3', '.db'):
        conn = sqlite3.connect(pathlib.Path(source).resolve().as_uri() + '?mode=ro', uri=True)
        try:
            tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            if not tables: raise ValueError('This database has no user tables.')
            if target == 'json':
                result = {}; cells = rows = 0
                for table in tables:
                    frame = sqlite_frame(conn, table, pd)
                    rows += len(frame); cells += len(frame) * len(frame.columns)
                    if rows > TABLE_ROWS or cells > TABLE_CELLS: raise ValueError('Database exceeds the table row/cell limits.')
                    result[table] = frame_records(frame)
                write_json(output, result); return
            if len(tables) != 1: raise ValueError('A database with multiple tables can export to JSON. A single table is needed for other outputs.')
            df = sqlite_frame(conn, tables[0], pd)
        finally: conn.close()
    else: df = read_table(source, pd)
    if target == 'parquet': df.to_parquet(output, index=False)
    elif target in ('feather', 'arrow'): df.reset_index(drop=True).to_feather(output)
    elif target in ('ndjson', 'jsonl'): write_json(output, frame_records(df), lines=True)
    elif target == 'json': write_json(output, frame_records(df))
    else:
        # Avoid spreadsheet formula evaluation on exported tables.
        def safe(v):
            if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r')): return "'" + v
            return v
        df = df.map(safe)
        df.to_csv(output, index=False, sep='\t' if target == 'tsv' else ',', chunksize=1000)
    if pathlib.Path(output).stat().st_size > TABLE_BYTES:
        raise ValueError('Converted data exceeds 50 MB.')
try: main()
except Exception as error:
    if len(sys.argv) >= 5 and sys.argv[1] == 'table' and pathlib.Path(sys.argv[2]).resolve() != pathlib.Path(sys.argv[4]).resolve():
        pathlib.Path(sys.argv[4]).unlink(missing_ok=True)
    print(str(error), file=sys.stderr); sys.exit(1)
