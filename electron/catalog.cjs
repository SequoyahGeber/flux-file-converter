const families = [
  {
    id: 'image',
    name: 'Images',
    description: 'Photos, graphics, and icons',
    formats: 'jpg jpeg png webp avif gif tif tiff bmp ico heic heif svg',
  },
  {
    id: 'video',
    name: 'Video',
    description: 'Video, audio extraction, and still frames',
    formats: 'mp4 mkv mov webm avi m4v mpg mpeg flv 3gp ts mts m2ts vob wmv ogv',
  },
  {
    id: 'audio',
    name: 'Audio',
    description: 'Music, voice, and lossless audio',
    formats: 'mp3 wav flac aac m4a ogg opus aiff aif wma amr ac3 caf',
  },
  {
    id: 'document',
    name: 'Documents & ebooks',
    description: 'Office documents, text, and ebooks',
    formats: 'docx doc docm odt ott rtf txt md markdown html htm rst tex latex org epub fb2 wpd',
  },
  { id: 'pdf', name: 'PDF', description: 'Page images and extracted text', formats: 'pdf' },
  {
    id: 'spreadsheet',
    name: 'Spreadsheets',
    description: 'Workbooks and tabular data',
    formats: 'xlsx xls xlsm xlsb ods csv tsv',
  },
  {
    id: 'presentation',
    name: 'Presentations',
    description: 'Slide decks and PDF export',
    formats: 'pptx ppt pptm odp pps ppsx potx',
  },
  {
    id: 'data',
    name: 'Structured data',
    description: 'JSON, YAML, XML, and tables',
    formats: 'json yaml yml xml',
  },
  {
    id: 'archive',
    name: 'Archives',
    description: 'Repack compressed files and folders',
    formats: 'zip tar tgz tar.gz tbz2 tar.bz2 txz tar.xz gz bz2 xz',
  },
  {
    id: 'ebook',
    name: 'Kindle & ebooks',
    description: 'Unencrypted ebooks and comic books',
    formats: 'mobi azw azw3 prc pdb lit lrf pml rb tcr snb cbz cbr cb7',
  },
  {
    id: 'font',
    name: 'Fonts',
    description: 'Web fonts and native font containers',
    formats: 'ttf otf woff woff2 ttc otc',
  },
  {
    id: 'model',
    name: '3D models',
    description: 'Meshes, scenes, and interchange files',
    formats: 'blend obj stl ply fbx gltf glb usd usda usdc usdz abc',
  },
  {
    id: 'subtitle',
    name: 'Subtitles',
    description: 'Timed text and caption tracks',
    formats: 'srt ass ssa vtt sub sbv lrc sami smi',
  },
  {
    id: 'table',
    name: 'Data tables & databases',
    description: 'Columnar data, records, and SQLite exports',
    formats: 'parquet pq feather arrow ndjson jsonl sqlite sqlite3 db',
  },
  {
    id: 'drawing',
    name: 'Drawings & publishing',
    description: 'Diagrams, vectors, and publishing documents',
    formats: 'odg otg fodg vsd vsdx vsdm vdx vstx pub cdr cmx sda std',
  },
].map((f) => ({ ...f, formats: f.formats.split(' ') }));
function extend({ images = [], media = [], documents = [], office = {} } = {}) {
  const append = (id, formats) => {
    const group = families.find((f) => f.id === id);
    for (const ext of formats) if (!family(ext)) group.formats.push(ext);
  };
  for (const [id, formats] of Object.entries(office)) append(id, formats);
  append('image', images);
  for (const f of media) append(f.subtitle ? 'subtitle' : f.audio ? 'audio' : 'video', [f.ext]);
  append('document', documents);
  append('archive', ['7z', 'rar']);
}
const normalize = (ext) =>
  ({
    jpeg: 'jpg',
    tif: 'tiff',
    aif: 'aiff',
    markdown: 'md',
    htm: 'html',
    latex: 'tex',
    yml: 'yaml',
    'tar.gz': 'tgz',
    'tar.bz2': 'tbz2',
    'tar.xz': 'txz',
  })[ext] || ext;
function extension(name) {
  const lower = name.toLowerCase();
  for (const ext of ['tar.gz', 'tar.bz2', 'tar.xz']) if (lower.endsWith('.' + ext)) return ext;
  return lower.includes('.') ? lower.split('.').pop() : '';
}
function family(ext) {
  return families.find((f) => f.formats.includes(ext));
}
const imageTargets = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf'];
const videoTargets = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'mpeg', 'flv', 'ts', 'wmv'];
const audioTargets = [
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'opus',
  'aiff',
  'wma',
  'ac3',
  'caf',
];
const officeDocs = ['docx', 'doc', 'docm', 'odt', 'ott', 'rtf', 'wpd'];
const pandocInputs = [
  'docx',
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'rst',
  'tex',
  'latex',
  'org',
  'epub',
  'fb2',
];
const pandocOutputs = [
  'docx',
  'odt',
  'rtf',
  'txt',
  'md',
  'html',
  'rst',
  'tex',
  'org',
  'epub',
  'fb2',
];
function targets(file, engines) {
  const ext = file.detected || file.ext || extension(file.name);
  const input = normalize(file.ext || ext);
  const f = file.family || family(ext)?.id;
  let list = [];
  if (f === 'image')
    list = [
      ...imageTargets,
      'svg',
      ...(engines.magick
        ? [
            'heic',
            'jp2',
            'jxl',
            'qoi',
            'exr',
            'hdr',
            'dpx',
            'tga',
            'psd',
            'eps',
            'ps',
            'pbm',
            'pgm',
            'ppm',
            'pnm',
            'pcx',
            'sgi',
            'xpm',
            'xbm',
            'fits',
            'miff',
          ].filter((t) => engines.imageWrite?.includes(t))
        : []),
    ];
  if (f === 'video' && engines.ffmpeg)
    list = [
      ...(file.hasVideo !== false ? videoTargets : []),
      ...(file.hasAudio !== false ? audioTargets : []),
      ...(file.hasVideo !== false ? ['gif', 'png', 'jpg'] : []),
    ];
  if (f === 'audio' && engines.ffmpeg) list = audioTargets;
  if (f === 'document') {
    if (engines.pandoc && (pandocInputs.includes(ext) || engines.documentInputs?.includes(ext)))
      list.push(...pandocOutputs);
    if (engines.office)
      list.push(
        'pdf',
        ...(officeDocs.includes(ext) ||
        engines.officeInputs?.document?.includes(ext) ||
        ['txt', 'html', 'htm'].includes(ext)
          ? ['docx', 'doc', 'odt', 'rtf', 'txt', 'html']
          : []),
      );
    if (engines.pandoc && engines.office && pandocInputs.includes(ext)) list.push('pdf');
    if (
      (officeDocs.includes(ext) || engines.officeInputs?.document?.includes(ext)) &&
      engines.office &&
      engines.pandoc
    )
      list.push(...pandocOutputs);
    if (engines.calibre && ['epub', 'fb2', 'docx', 'txt', 'html', 'rtf', 'odt'].includes(ext))
      list.push('mobi', 'azw3');
  }
  if (f === 'pdf' && engines.pdf)
    list = ['png', 'jpg', 'txt', 'html', ...(engines.pandoc ? ['docx', 'md', 'epub'] : [])];
  if (f === 'spreadsheet') {
    if (engines.office) list = ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'pdf', 'html'];
    if (['csv', 'tsv'].includes(ext))
      list.push(
        'csv',
        'tsv',
        'json',
        'yaml',
        'xml',
        ...(engines.python ? ['parquet', 'feather', 'ndjson'] : []),
      );
  }
  if (f === 'presentation' && engines.office) list = ['pptx', 'ppt', 'odp', 'pdf'];
  if (f === 'data')
    list = [
      'json',
      'yaml',
      'xml',
      'csv',
      'tsv',
      ...(ext === 'json' && engines.python ? ['parquet', 'feather', 'ndjson'] : []),
    ];
  if (f === 'archive' && engines.archive)
    list = ['zip', 'tar', 'tgz', 'tbz2', 'txz', ...(engines.python ? ['7z'] : [])];
  if (f === 'ebook')
    list = engines.calibre ? ['epub', 'mobi', 'azw3', 'pdf', 'txt', 'docx', 'rtf', 'fb2'] : [];
  if (f === 'font' && engines.python)
    list = ['woff', 'woff2', ...(file.outline ? [file.outline] : [])];
  if (f === 'model' && engines.blender)
    list = ['blend', 'obj', 'stl', 'ply', 'fbx', 'glb', 'gltf', 'usda', 'usdc', 'usdz'];
  if (f === 'subtitle' && engines.ffmpeg) list = ['srt', 'ass', 'ssa', 'vtt'];
  if (f === 'table' && engines.python)
    list = ['json', 'csv', 'tsv', 'parquet', 'feather', 'ndjson'];
  if (f === 'drawing' && engines.office) list = ['pdf', 'svg', 'png'];
  return [...new Set(list)].filter((t) => t !== input);
}
function note(file, target) {
  const f = family(file.ext)?.id;
  if (f === 'pdf' && target === 'docx')
    return 'Reconstructs a Word document from the PDF. Complex layouts may change; review the result.';
  if (f === 'pdf' && ['txt', 'md', 'html', 'epub'].includes(target))
    return 'Extracts text without preserving page layout. Scanned PDFs use English OCR when available.';
  if (f === 'pdf' && ['jpg', 'png'].includes(target))
    return 'Every page becomes an image. Multiple pages are saved together in a ZIP.';
  if (f === 'image' && target === 'jpg') return 'Transparency is filled with a white background.';
  if (f === 'image' && ['gif', 'tiff'].includes(normalize(file.ext)))
    return 'Converts the first frame or page of multi-frame images.';
  if (f === 'video' && audioTargets.includes(target))
    return 'Extracts the audio track from this video.';
  if (f === 'video' && ['jpg', 'png'].includes(target))
    return 'Saves a still frame from the beginning of the video.';
  if (f === 'video' && target === 'gif')
    return 'Creates an animated GIF of the first 15 seconds, up to 720 px wide.';
  if (f === 'spreadsheet' && ['csv', 'tsv'].includes(target))
    return 'Exports the first sheet as values. Formatting and other sheets are not included.';
  if (f === 'document' && ['txt', 'md'].includes(target))
    return 'Text formats may omit layout, images, and document styling.';
  if (f === 'data' && ['csv', 'tsv'].includes(target))
    return 'Requires an array of flat records. Nested values cannot become a table.';
  if (f === 'archive') return 'Repacks archive contents. Symlinks and unsafe paths are rejected.';
  if (f === 'model')
    return ['stl', 'ply'].includes(target)
      ? 'Mesh export. Materials, animations, and scene features may be omitted.'
      : 'Unsupported materials or scene features may change. Outputs with companion assets are bundled into a ZIP.';
  if (f === 'font') return 'Preserves the outline type. Font collections export the first font.';
  if (f === 'drawing')
    return target === 'pdf'
      ? 'Exports the diagram or publishing document to PDF.'
      : 'Exports the first page. Complex layout features may change.';
  if (f === 'ebook')
    return 'Requires an unencrypted ebook. Layout and device-specific features may change.';
  if (f === 'table')
    return 'Exports records. Database JSON includes all tables; other formats require one table. Database schema is not preserved.';
  if (target === 'svg' && f === 'image')
    return 'Embeds the raster image in an SVG. This does not create editable vector paths.';
  return '';
}
module.exports = {
  families,
  normalize,
  extension,
  family,
  targets,
  note,
  officeDocs,
  pandocInputs,
  videoTargets,
  audioTargets,
  extend,
};
