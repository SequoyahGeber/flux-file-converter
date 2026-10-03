#!/usr/bin/env python3
"""Reproduce synthetic review samples, offline policies and public static pages."""
import hashlib
import html
import json
import pathlib
import re
import shutil
import struct
import zipfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "native/OfflineKit/Sources/OfflineKit/Resources"
SITE = ROOT / "docs/site"


def archive(path, entries):
    with zipfile.ZipFile(path, "w") as output:
        for name, contents in entries.items():
            item = zipfile.ZipInfo(name, (2026, 10, 3, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o100600 << 16
            output.writestr(item, contents)


def chunk(kind, content):
    return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))


def main():
    RESOURCES.mkdir(parents=True, exist_ok=True)
    colors = [(118, 69, 188), (161, 127, 216), (212, 195, 240), (243, 237, 252)]
    scanlines = b"".join(b"\0" + bytes(colors[(y // 32) % 4]) * 256 for y in range(128))
    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 128, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")
    (RESOURCES / "Flux-sample-image.png").write_bytes(image)
    document = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>
<w:p><w:r><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="7645BC"/></w:rPr><w:t>Flux sample document</w:t></w:r></w:p>
<w:p><w:r><w:t>This fictional file demonstrates local conversion. </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Original files remain unchanged.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Example</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Synthetic record</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2438400" cy="1219200"/><a:graphic><a:blip r:embed="image1"/></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
</w:body></w:document>'''
    archive(RESOURCES / "Flux-sample-document.docx", {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": document,
        "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>',
        "word/media/image.png": image
    })
    shutil.copyfile(ROOT / "native/OfflineKit/Tests/OfflineKitTests/Resources/remux.mp4", RESOURCES / "Flux-sample-video.mp4")
    (RESOURCES / "Flux-sample-data.json").write_text('[{"name":"Example A","value":42},{"name":"Example B","value":7}]\n')
    archive(RESOURCES / "Flux-sample-archive.zip", {"Read me.txt": "Fictional review files. No personal data.\n", "Sample image.png": image})
    navigation = '<nav><a href="../">Flux Local</a> · <a href="../privacy/">Privacy</a> · <a href="../support/">Support</a></nav>'
    styles = 'body{font:17px/1.65 system-ui,sans-serif;color:#292333;background:#fbf9fd;max-width:760px;margin:3rem auto;padding:0 1.5rem}h1,h2{line-height:1.2;color:#6b4099}h2{margin-top:2rem}a{color:#693695}nav{margin-bottom:2rem;font-size:15px}footer{border-top:1px solid #dacde7;margin-top:3rem;padding-top:1rem;font-size:14px}'
    for name in ["privacy", "support"]:
        markdown = (ROOT / f"docs/{name}.md").read_text()
        plain = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", markdown).replace("`", "")
        plain = re.sub(r"^#+ ", "", plain, flags=re.M)
        (RESOURCES / f"Flux-{name}.txt").write_text(plain)
        blocks = []
        for block in markdown.strip().split("\n\n"):
            escaped = html.escape(block).replace("`", "")
            escaped = re.sub(r"\[([^\]]+)\]\((https://[^)]+)\)", r'<a href="\2">\1</a>', escaped)
            if escaped.startswith("## "): blocks.append("<h2>" + escaped[3:] + "</h2>")
            elif escaped.startswith("# "): blocks.append("<h1>" + escaped[2:] + "</h1>")
            else: blocks.append("<p>" + escaped + "</p>")
        title = "Flux privacy policy" if name == "privacy" else "Flux support"
        page = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="{title}"><title>{title}</title><style>{styles}</style></head><body>{navigation}<main>{"".join(blocks)}</main><footer>Flux Local for Mac and iPhone · On-device file conversion</footer></body></html>'
        destination = SITE / name; destination.mkdir(parents=True, exist_ok=True)
        (destination / "index.html").write_text(page)
    (SITE / ".nojekyll").write_text("")
    (SITE / "index.html").write_text(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flux Local</title><style>{styles}</style></head><body><h1>Flux Local</h1><p>File conversion, compression and ZIP tools for Mac and iPhone. Files stay on your device. No login or server connection is required.</p><p><a href="privacy/">Privacy policy</a> · <a href="support/">Support and supported conversions</a> · <a href="https://github.com/SequoyahGeber/flux-file-converter">Source and licenses</a></p><p>Beta testers can report issues through Send Beta Feedback in TestFlight. Please use synthetic files and omit private contents.</p></body></html>')
    print("Prepared five fictional samples and matching offline/public policy and support pages.")


if __name__ == "__main__":
    main()
