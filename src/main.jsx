import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRightLeft,
  ArrowRight,
  ArrowUpRight,
  Plus,
  ChevronRight,
  ChevronDown,
  X,
  Search,
  ShieldCheck,
  Folder,
  FolderOpen,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileSpreadsheet,
  FileArchive,
  Presentation,
  Code2,
  File,
  Clock3,
  Settings2,
  Grid2X2,
  HardDrive,
  Check,
  CheckCircle2,
  Loader2,
  CircleAlert,
  Minimize2,
  Download,
  SlidersHorizontal,
  RotateCcw,
  Play,
  LockKeyhole,
  Box,
  Sparkles,
  ArrowDownToLine,
  Upload,
  Zap,
  Cuboid,
  Type,
  Captions,
  BookOpen,
  Database,
  PenTool,
} from 'lucide-react';
import './styles.css';

const icons = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  document: FileText,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  data: Code2,
  archive: FileArchive,
  folder: Folder,
  unsupported: File,
  model: Cuboid,
  font: Type,
  subtitle: Captions,
  ebook: BookOpen,
  table: Database,
  drawing: PenTool,
};
const colors = {
  image: 'purple',
  video: 'blue',
  audio: 'pink',
  document: 'amber',
  pdf: 'red',
  spreadsheet: 'green',
  presentation: 'orange',
  data: 'teal',
  archive: 'slate',
  folder: 'amber',
  model: 'blue',
  font: 'pink',
  subtitle: 'teal',
  ebook: 'amber',
  table: 'green',
  drawing: 'purple',
};
const fallbackFamilies = [
  ['image', 'Images', 'jpg jpeg png webp avif gif tif tiff bmp ico heic heif svg'],
  ['video', 'Video', 'mp4 mkv mov webm avi m4v mpg mpeg flv 3gp ts mts m2ts vob wmv ogv'],
  ['audio', 'Audio', 'mp3 wav flac aac m4a ogg opus aiff aif wma amr ac3 caf'],
  [
    'document',
    'Documents & ebooks',
    'docx doc docm odt ott rtf txt md markdown html htm rst tex latex org epub fb2 wpd',
  ],
  ['pdf', 'PDF', 'pdf'],
  ['spreadsheet', 'Spreadsheets', 'xlsx xls xlsm xlsb ods csv tsv'],
  ['presentation', 'Presentations', 'pptx ppt pptm odp pps ppsx potx'],
  ['data', 'Structured data', 'json yaml yml xml'],
  ['archive', 'Archives', 'zip tar tgz tar.gz tbz2 tar.bz2 txz tar.xz gz bz2 xz'],
].map(([id, name, formats]) => ({ id, name, formats: formats.split(' ') }));
const api = window.flux;
const bytes = (n) =>
  n === 0
    ? '0 B'
    : n < 1024
      ? `${n} B`
      : n < 1024 ** 2
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1024 ** 3
          ? `${(n / 1024 ** 2).toFixed(1)} MB`
          : `${(n / 1024 ** 3).toFixed(2)} GB`;
const date = (n) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(n);
const formatLabel = (t) =>
  ({ jpg: 'JPG', tiff: 'TIFF', m4a: 'M4A', tgz: 'TAR.GZ', tbz2: 'TAR.BZ2', txz: 'TAR.XZ' })[t] ||
  t.toUpperCase();
function FileGlyph({ family, ext, large = false }) {
  const Icon = icons[family] || File;
  return (
    <div className={`file-glyph ${colors[family] || 'slate'} ${large ? 'large' : ''}`}>
      <Icon size={large ? 26 : 20} />
      {ext && <span>{ext.toUpperCase()}</span>}
    </div>
  );
}
function Logo({ small = false }) {
  return (
    <div className={`logo ${small ? 'small' : ''}`}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 8h14m0 0-4-4m4 4-4 4M19 16H5m0 0 4-4m-4 4 4 4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
function App() {
  const [route, setRoute] = useState('convert'),
    [queue, setQueue] = useState([]),
    [history, setHistory] = useState([]),
    [engines, setEngines] = useState({}),
    [enginePaths, setEnginePaths] = useState({}),
    [families, setFamilies] = useState(fallbackFamilies);
  const [output, setOutput] = useState('Downloads / Flux'),
    [running, setRunning] = useState(false),
    [adding, setAdding] = useState(false),
    [dragging, setDragging] = useState(false),
    [toast, setToast] = useState(''),
    [error, setError] = useState('');
  const [quality, setQuality] = useState('balanced'),
    [width, setWidth] = useState('0'),
    [compressionMode, setCompressionMode] = useState('lossless'),
    [archiveMode, setArchiveMode] = useState('pack'),
    [search, setSearch] = useState(''),
    [selectedFormat, setSelectedFormat] = useState(null),
    [formatTargets, setFormatTargets] = useState([]),
    [showOptions, setShowOptions] = useState(false),
    [bulkTarget, setBulkTarget] = useState('');
  const searchRef = useRef();
  const dragDepth = useRef(0);
  const applyState = (s) => {
    setEngines(s.engines);
    setEnginePaths(s.enginePaths);
    setOutput(s.outputDir);
    setHistory(s.history);
    setFamilies(s.families);
    setRunning(s.running);
  };
  const add = (files) => {
    setQueue((q) => [
      ...q,
      ...files
        .filter((f) => !q.some((x) => x.id === f.id))
        .map((f) => ({
          ...f,
          target: f.targets.includes('pdf') ? 'pdf' : f.targets[0] || '',
          compression: f.compressionOptions?.[0]?.id || '',
          status: 'ready',
          progress: 0,
        })),
    ]);
    setError('');
  };
  useEffect(() => {
    if (!api) return;
    api
      .getState()
      .then(applyState)
      .catch((e) => setError(e.message));
    const off = api.onUpdate((job) => {
      if (job.batchComplete) {
        setRunning(false);
        setHistory(job.history);
        setToast('Batch finished. Your results are ready.');
        return;
      }
      setQueue((q) =>
        q.map((f) =>
          job.operation === 'pack' && job.includeFiles?.some((x) => x.id === f.id)
            ? {
                ...f,
                status: job.status,
                progress: job.progress,
                result: job.result,
                error: job.error,
              }
            : f.id === job.id
              ? { ...f, ...job, ...(job.file || {}) }
              : f,
        ),
      );
    });
    const offFiles = api.onFiles(add);
    return () => {
      off();
      offFiles();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setRoute('formats');
        setTimeout(() => searchRef.current?.focus(), 30);
      }
      if (e.key === 'Escape') {
        setSelectedFormat(null);
        setError('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const mode = ['convert', 'compress', 'archive'].includes(route) ? route : 'convert';
  const compatibleCompression = (f) => {
    if (compressionMode === 'lossy') return f.compressionOptions?.find((o) => o.id === 'lossy');
    return (
      f.compressionOptions?.find((o) => o.id === f.compression && o.id !== 'lossy') ||
      f.compressionOptions?.find((o) => o.id === 'lossless') ||
      f.compressionOptions?.find((o) => o.id === 'archive')
    );
  };
  const ready = (f) =>
    mode === 'convert'
      ? f.targets?.length > 0
      : mode === 'compress'
        ? Boolean(compatibleCompression(f))
        : archiveMode === 'pack'
          ? Boolean(f.path)
          : f.family === 'archive';
  const pending = queue.filter((f) => ready(f) && f.status !== 'done');
  const done = queue.filter((f) => f.status === 'done');
  const total = queue.reduce((sum, f) => sum + f.size, 0);
  const allTargets = useMemo(
    () =>
      queue.length
        ? queue
            .filter((f) => f.targets?.length)
            .reduce(
              (shared, f, i) => (i ? shared.filter((t) => f.targets.includes(t)) : f.targets),
              [],
            )
        : [],
    [queue],
  );
  const formatCount = families.reduce((n, f) => n + f.formats.length, 0);
  const titles = {
    convert: 'File converter',
    compress: 'File compressor',
    archive: 'ZIP & Unzip',
    history: 'Recent files',
    formats: 'All formats',
    settings: 'Settings',
  };
  async function action(fn) {
    try {
      return await fn();
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    }
  }
  async function selectFiles() {
    if (!api) {
      setError('Open the Flux Mac app to add and convert local files.');
      return;
    }
    setAdding(true);
    try {
      const files = await api.selectFiles();
      add(files);
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  }
  async function drop(e) {
    e.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (running) return;
    if (!api) {
      setError('Open the Flux Mac app to use drag and drop.');
      return;
    }
    setAdding(true);
    try {
      add(
        await api.addPaths(
          [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean),
        ),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  }
  async function start() {
    const options = { quality, width: Number(width) };
    let requests;
    if (mode === 'archive' && archiveMode === 'pack')
      requests = [
        { id: pending[0]?.id, includeIds: queue.filter(ready).map((f) => f.id), operation: 'pack' },
      ];
    else
      requests = pending.map((f) => ({
        id: f.id,
        target: f.target,
        compression: compatibleCompression(f)?.id,
        operation: mode === 'archive' ? 'extract' : mode,
        options,
      }));
    if (!requests.length || !requests[0].id) return;
    setError('');
    setRunning(true);
    try {
      await api.start(requests);
    } catch (e) {
      setRunning(false);
      setError(e.message);
    }
  }
  const update = (id, change) =>
    setQueue((q) => q.map((f) => (f.id === id ? { ...f, ...change } : f)));
  function switchMode(value) {
    if (running) {
      setError('Finish or cancel the current batch before switching workspaces.');
      return;
    }
    setRoute(value);
    setQueue((q) =>
      q.map((f) => ({ ...f, status: 'ready', result: undefined, error: undefined, progress: 0 })),
    );
    setBulkTarget('');
  }
  function SideButton({ id, icon: Icon, children, count }) {
    return (
      <button
        className={`side-button ${route === id ? 'active' : ''}`}
        onClick={() =>
          ['convert', 'compress', 'archive'].includes(id) ? switchMode(id) : setRoute(id)
        }
      >
        <Icon size={18} />
        <span>{children}</span>
        {count > 0 && <b>{count}</b>}
      </button>
    );
  }
  const detailFamily = selectedFormat && families.find((f) => f.formats.includes(selectedFormat));
  return (
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={drop}
    >
      <aside className="sidebar">
        <div className="traffic-space" />
        <div className="brand">
          <Logo />
          <span>
            flux<span className="brand-dot">.</span>
          </span>
        </div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav>
          <SideButton id="convert" icon={ArrowRightLeft} count={queue.length}>
            Convert files
          </SideButton>
          <SideButton id="compress" icon={Minimize2}>
            Compress files
          </SideButton>
          <SideButton id="archive" icon={FileArchive}>
            ZIP & Unzip
          </SideButton>
          <SideButton id="history" icon={Clock3} count={history.length}>
            Recent files
          </SideButton>
        </nav>
        <div className="sidebar-label second-label">EXPLORE</div>
        <nav>
          <SideButton id="formats" icon={Grid2X2}>
            All formats<span className="nav-mini">{formatCount}</span>
          </SideButton>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <div className="privacy-icon">
              <ShieldCheck size={20} />
            </div>
            <b>A little more private.</b>
            <p>
              Your files stay right here.
              <br />
              Every conversion is local.
            </p>
            <span>
              <span className="green-dot" />
              No cloud. No uploads.
            </span>
          </div>
          <SideButton id="settings" icon={Settings2}>
            Settings
          </SideButton>
          <div className="version">
            <Logo small />
            <span>Made for your Mac</span>
            <span>v1.0</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <b>{titles[route]}</b>
          </div>
          <div className="topbar-actions">
            <span className="local-badge">
              <span className="green-dot" />
              Running locally
            </span>
            <button
              className="icon-button search-button"
              aria-label="Search formats"
              onClick={() => {
                setRoute('formats');
                setTimeout(() => searchRef.current?.focus(), 30);
              }}
            >
              <Search size={18} />
            </button>
            <kbd>⌘ K</kbd>
          </div>
        </header>
        <div className="main-scroll">
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {['convert', 'compress', 'archive'].includes(route) && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span className="purple-dot" />
                    {mode === 'convert'
                      ? 'A NEW FORMAT, IN A MOMENT'
                      : mode === 'compress'
                        ? 'LESS SPACE. MORE POSSIBILITIES.'
                        : 'EVERYTHING, ALL TOGETHER'}
                  </div>
                  <h1>
                    {mode === 'convert' ? (
                      <>
                        Good files.
                        <br />
                        New possibilities<span>.</span>
                      </>
                    ) : mode === 'compress' ? (
                      <>
                        Big ideas.
                        <br />
                        Smaller files<span>.</span>
                      </>
                    ) : (
                      <>
                        Pack it up.
                        <br />
                        Or open it out<span>.</span>
                      </>
                    )}
                  </h1>
                  <p>
                    {mode === 'convert'
                      ? 'Images, videos, documents, and everything in between.'
                      : mode === 'compress'
                        ? 'Make room without giving up more than you want to.'
                        : 'Create a ZIP from files and folders, or safely extract an archive.'}
                    <br />
                    {mode === 'convert'
                      ? 'One place to turn your files into what you need.'
                      : mode === 'compress'
                        ? 'Choose lossless optimization or a smaller file with lower quality.'
                        : 'Your originals stay exactly where they are.'}
                  </p>
                </div>
                <div className="heading-meta">
                  <span className="format-pill">
                    <Grid2X2 size={14} />
                    {formatCount} recognized formats
                  </span>
                  <span>One very useful app.</span>
                </div>
              </div>
              {mode === 'compress' && (
                <div className="mode-options">
                  <button
                    className={compressionMode === 'lossless' ? 'selected' : ''}
                    disabled={running}
                    onClick={() => {
                      setCompressionMode('lossless');
                      setQueue((q) =>
                        q.map((f) => ({
                          ...f,
                          status: 'ready',
                          result: undefined,
                          error: undefined,
                        })),
                      );
                    }}
                  >
                    <ShieldCheck size={18} />
                    <span>
                      <b>Lossless</b>
                      <small>Keep the details. Optimize or ZIP.</small>
                    </span>
                    <span className="radio" />
                  </button>
                  <button
                    className={compressionMode === 'lossy' ? 'selected' : ''}
                    disabled={running}
                    onClick={() => {
                      setCompressionMode('lossy');
                      setQueue((q) =>
                        q.map((f) => ({
                          ...f,
                          status: 'ready',
                          result: undefined,
                          error: undefined,
                        })),
                      );
                    }}
                  >
                    <Minimize2 size={18} />
                    <span>
                      <b>Smaller file</b>
                      <small>Trade some quality for more space.</small>
                    </span>
                    <span className="radio" />
                  </button>
                </div>
              )}
              {mode === 'archive' && (
                <div className="segmented">
                  <button
                    className={archiveMode === 'pack' ? 'selected' : ''}
                    disabled={running}
                    onClick={() => {
                      setArchiveMode('pack');
                      setQueue((q) =>
                        q.map((f) => ({
                          ...f,
                          status: 'ready',
                          result: undefined,
                          error: undefined,
                        })),
                      );
                    }}
                  >
                    <FileArchive size={16} />
                    Create ZIP
                  </button>
                  <button
                    className={archiveMode === 'extract' ? 'selected' : ''}
                    disabled={running}
                    onClick={() => {
                      setArchiveMode('extract');
                      setQueue((q) =>
                        q.map((f) => ({
                          ...f,
                          status: 'ready',
                          result: undefined,
                          error: undefined,
                        })),
                      );
                    }}
                  >
                    <FolderOpen size={16} />
                    Extract archive
                  </button>
                </div>
              )}
              {!queue.length ? (
                <div className={`dropzone ${dragging ? 'dragging' : ''}`}>
                  <div className="dropzone-art">
                    <div className="art-file art-left">
                      <FileImage size={23} />
                      <span>{mode === 'archive' ? 'FILES' : 'PNG'}</span>
                    </div>
                    <div className="art-file art-middle">
                      <ArrowRightLeft size={23} />
                    </div>
                    <div className="art-file art-right">
                      <FileImage size={23} />
                      <span>{mode === 'archive' ? 'ZIP' : 'JPG'}</span>
                    </div>
                  </div>
                  <h2>
                    {adding
                      ? 'Reading your files…'
                      : mode === 'archive' && archiveMode === 'extract'
                        ? 'Drop your archives here'
                        : 'Drop your files here'}
                  </h2>
                  <p>
                    {mode === 'archive' && archiveMode === 'pack'
                      ? 'Files or folders. Bundle them into one ZIP.'
                      : 'A single file or a whole batch. You’re in good hands.'}
                  </p>
                  <div className="drop-buttons">
                    <button
                      className="primary-button"
                      disabled={adding || running}
                      onClick={selectFiles}
                    >
                      {adding ? <Loader2 className="spin" size={17} /> : <Plus size={18} />}Choose
                      files<span className="button-shortcut">⌘ O</span>
                    </button>
                    {mode === 'archive' && archiveMode === 'pack' && (
                      <button
                        className="secondary-button"
                        onClick={() => action(async () => add(await api.selectFolder()))}
                      >
                        <Folder size={16} />
                        Choose folder
                      </button>
                    )}
                  </div>
                  <div className="drop-footnote">
                    <LockKeyhole size={12} />
                    Never uploaded. Never shared.
                  </div>
                </div>
              ) : (
                <section className="queue-panel">
                  <div className="queue-toolbar">
                    <div>
                      <b>
                        {queue.length} {queue.length === 1 ? 'file' : 'files'} added
                      </b>
                      <span>{bytes(total)}</span>
                      {done.length > 0 && (
                        <span className="done-badge">
                          <CheckCircle2 size={13} />
                          {done.length} ready
                        </span>
                      )}
                    </div>
                    <div className="queue-toolbar-actions">
                      {mode === 'convert' && allTargets.length > 0 && (
                        <select
                          aria-label="Set format for all files"
                          value={bulkTarget}
                          disabled={running}
                          onChange={(e) => {
                            const target = e.target.value;
                            setBulkTarget(target);
                            setQueue((q) =>
                              q.map((f) =>
                                f.targets.includes(target)
                                  ? { ...f, target, status: 'ready', result: undefined }
                                  : f,
                              ),
                            );
                          }}
                        >
                          <option value="">Set all formats</option>
                          {allTargets.map((t) => (
                            <option value={t} key={t}>
                              {formatLabel(t)}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="text-button" disabled={running} onClick={selectFiles}>
                        <Plus size={16} />
                        Add files
                      </button>
                      {mode === 'archive' && archiveMode === 'pack' && (
                        <button
                          className="text-button"
                          disabled={running}
                          onClick={() => action(async () => add(await api.selectFolder()))}
                        >
                          <Folder size={16} />
                          Add folder
                        </button>
                      )}
                      <button
                        className="text-button muted"
                        disabled={running}
                        onClick={() => {
                          setQueue([]);
                          setBulkTarget('');
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="queue-rows">
                    {queue.map((f) => {
                      const choice = mode === 'compress' ? compatibleCompression(f) : null;
                      const note =
                        mode === 'compress'
                          ? choice?.note
                          : mode === 'convert'
                            ? f.notes?.[f.target]
                            : archiveMode === 'pack'
                              ? 'Included in one ZIP with your other items.'
                              : 'Extracts into a new folder.';
                      return (
                        <div
                          className={`file-row ${f.status === 'done' ? 'is-done' : ''}`}
                          key={f.id}
                        >
                          <div className="file-main">
                            <FileGlyph family={f.family} ext={f.ext} />
                            <div className="file-info">
                              <b title={f.name}>{f.name}</b>
                              <span>
                                {f.family === 'folder' ? 'Folder' : bytes(f.size)}
                                {f.details && (
                                  <>
                                    <i /> {f.details}
                                  </>
                                )}
                              </span>
                            </div>
                            <div className="file-output">
                              {f.status === 'done' ? (
                                <button
                                  className="result-button"
                                  onClick={() => action(() => api.reveal(f.result.id))}
                                >
                                  <CheckCircle2 size={16} />
                                  Show in Finder
                                  <ArrowUpRight size={13} />
                                </button>
                              ) : f.status === 'running' ? (
                                <span className="file-progress">
                                  <Loader2 className="spin" size={16} />
                                  {f.progress}%
                                </span>
                              ) : mode === 'convert' && f.targets.length > 0 ? (
                                <>
                                  <ArrowRight size={16} />
                                  <select
                                    aria-label={`Output format for ${f.name}`}
                                    disabled={running}
                                    value={f.target}
                                    onChange={(e) =>
                                      update(f.id, {
                                        target: e.target.value,
                                        status: 'ready',
                                        error: undefined,
                                      })
                                    }
                                  >
                                    {f.targets.map((t) => (
                                      <option key={t} value={t}>
                                        {formatLabel(t)}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              ) : mode === 'compress' && choice ? (
                                compressionMode === 'lossless' &&
                                f.compressionOptions.filter((o) => o.id !== 'lossy').length > 1 ? (
                                  <select
                                    aria-label={`Compression for ${f.name}`}
                                    disabled={running}
                                    value={choice.id}
                                    onChange={(e) =>
                                      update(f.id, {
                                        compression: e.target.value,
                                        status: 'ready',
                                        error: undefined,
                                      })
                                    }
                                  >
                                    {f.compressionOptions
                                      .filter((o) => o.id !== 'lossy')
                                      .map((o) => (
                                        <option key={o.id} value={o.id}>
                                          {o.name}
                                        </option>
                                      ))}
                                  </select>
                                ) : (
                                  <span className="output-label">{choice.name}</span>
                                )
                              ) : mode === 'archive' && ready(f) ? (
                                <span className="output-label">
                                  {archiveMode === 'pack' ? 'ZIP' : 'Folder'}
                                </span>
                              ) : (
                                <span className="unsupported-label">
                                  {mode === 'compress'
                                    ? 'No lossy option'
                                    : mode === 'archive'
                                      ? 'Choose an archive'
                                      : 'Unavailable'}
                                </span>
                              )}
                            </div>
                            <button
                              className="remove-button"
                              aria-label={`Remove ${f.name}`}
                              disabled={running}
                              onClick={() => setQueue((q) => q.filter((x) => x.id !== f.id))}
                            >
                              <X size={15} />
                            </button>
                          </div>
                          {(f.error ||
                            f.status === 'cancelled' ||
                            (f.warning && mode === 'convert')) && (
                            <div className="row-warning">
                              <CircleAlert size={13} />
                              {f.error ||
                                (f.status === 'cancelled'
                                  ? 'Cancelled. You can try again.'
                                  : f.warning)}
                            </div>
                          )}
                          {f.status === 'done' && f.result && (
                            <div className="row-result">
                              <span>{f.result.name}</span>
                              <span>
                                {f.result.target === 'folder'
                                  ? 'Extracted folder'
                                  : bytes(f.result.size)}
                                {f.result.operation === 'compress' && (
                                  <>
                                    {' '}
                                    ·{' '}
                                    {f.result.keptOriginal
                                      ? 'Already optimized · original quality kept'
                                      : f.result.savedBytes > 0
                                        ? `${Math.round((f.result.savedBytes / f.size) * 100)}% smaller`
                                        : `${bytes(Math.abs(f.result.savedBytes))} larger`}
                                  </>
                                )}
                              </span>
                            </div>
                          )}
                          {note && f.status !== 'done' && <div className="row-note">{note}</div>}
                          {f.status === 'running' && (
                            <div className="row-progress-track">
                              <div style={{ width: `${f.progress}%` }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="queue-bottom">
                    <span>
                      <ShieldCheck size={15} />
                      Original files are always preserved
                    </span>
                    {running ? (
                      <button
                        className="secondary-button"
                        onClick={() => action(() => api.cancel())}
                      >
                        <X size={16} />
                        Cancel batch
                      </button>
                    ) : (
                      <button className="primary-button" disabled={!pending.length} onClick={start}>
                        {mode === 'convert' ? (
                          <ArrowRightLeft size={16} />
                        ) : mode === 'compress' ? (
                          <Minimize2 size={16} />
                        ) : (
                          <FileArchive size={16} />
                        )}{' '}
                        {mode === 'convert'
                          ? `Convert ${pending.length === 1 ? 'file' : `${pending.length} files`}`
                          : mode === 'compress'
                            ? `Compress ${pending.length === 1 ? 'file' : `${pending.length} files`}`
                            : archiveMode === 'pack'
                              ? 'Create ZIP'
                              : 'Extract archives'}
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </div>
                </section>
              )}
              <div className="output-bar">
                <div className="output-location">
                  <FolderOpen size={17} />
                  <span>Save to</span>
                  <button
                    disabled={running}
                    title={output}
                    onClick={() => action(async () => setOutput(await api.selectOutput()))}
                  >
                    {output.split('/').slice(-2).join(' / ')}
                    <ChevronDown size={13} />
                  </button>
                </div>
                <button
                  className={`text-button ${showOptions ? 'purple-text' : ''}`}
                  onClick={() => setShowOptions((v) => !v)}
                >
                  <SlidersHorizontal size={15} />
                  Options
                  <ChevronDown size={13} />
                </button>
              </div>
              {showOptions && (
                <div className="options-panel">
                  <label>
                    Quality / file size
                    <select
                      value={quality}
                      disabled={running}
                      onChange={(e) => {
                        setQuality(e.target.value);
                        setQueue((q) =>
                          q.map((f) => ({ ...f, status: 'ready', result: undefined })),
                        );
                      }}
                    >
                      <option value="high">High quality</option>
                      <option value="balanced">Balanced</option>
                      <option value="small">Smallest file</option>
                    </select>
                  </label>
                  <label>
                    Maximum image / video width
                    <select
                      value={width}
                      disabled={running || (mode === 'compress' && compressionMode === 'lossless')}
                      onChange={(e) => {
                        setWidth(e.target.value);
                        setQueue((q) =>
                          q.map((f) => ({ ...f, status: 'ready', result: undefined })),
                        );
                      }}
                    >
                      <option value="0">Original size</option>
                      <option value="1920">1920 px</option>
                      <option value="1280">1280 px</option>
                      <option value="720">720 px</option>
                    </select>
                  </label>
                  <p>
                    Lossless optimization preserves quality. Already compressed files may have
                    little room to shrink.
                  </p>
                </div>
              )}
              {!queue.length && (
                <>
                  <div className="section-label">
                    <span>A FEW OF THE POSSIBILITIES</span>
                    <button className="text-button" onClick={() => setRoute('formats')}>
                      Explore all formats
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <div className="possibility-grid">
                    {[
                      [
                        'image',
                        'Images',
                        'PNG, JPG, WebP, HEIC',
                        'A fresh format for every photo.',
                      ],
                      [
                        'video',
                        'Video & audio',
                        'MP4, MKV, MP3, WAV',
                        'From the big screen to a voice note.',
                      ],
                      [
                        'document',
                        'Documents',
                        'DOCX, PDF, EPUB, XLSX',
                        'Ready to read, share, or work on.',
                      ],
                    ].map(([id, title, formats, subtitle]) => {
                      const Icon = icons[id];
                      return (
                        <button
                          className="possibility-card"
                          key={id}
                          onClick={() => {
                            setSearch(id === 'video' ? 'mp' : id === 'image' ? 'png' : 'doc');
                            setRoute('formats');
                          }}
                        >
                          <div className={`card-icon ${colors[id]}`}>
                            <Icon size={19} />
                          </div>
                          <ArrowUpRight className="card-arrow" size={16} />
                          <h3>{title}</h3>
                          <span>{formats}</span>
                          <p>{subtitle}</p>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              <div className="workspace-footer">
                <span>
                  <Zap size={13} />
                  Less friction. More flow.
                </span>
                <span>
                  Private by design
                  <ShieldCheck size={13} />
                </span>
              </div>
            </>
          )}
          {route === 'history' && (
            <>
              <div className="utility-heading">
                <div className="eyebrow">READY WHEN YOU ARE</div>
                <h1>
                  Recent files<span>.</span>
                </h1>
                <p>Your latest conversions, compressions, and archives.</p>
              </div>
              <div className="utility-toolbar">
                <span>{history.length} results</span>
                <button
                  className="text-button"
                  onClick={() =>
                    action(async () => {
                      setHistory(await api.clearHistory());
                      setToast('History cleared. Your output files are still saved.');
                    })
                  }
                >
                  Clear history
                </button>
              </div>
              {!history.length ? (
                <div className="empty-state">
                  <Clock3 size={30} />
                  <h2>A clean slate.</h2>
                  <p>Converted files will appear here, ready to find again.</p>
                  <button className="secondary-button" onClick={() => setRoute('convert')}>
                    Convert your first file
                    <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="history-list">
                  {history.map((h) => (
                    <div className="history-row" key={h.id}>
                      <FileGlyph
                        family={
                          h.target === 'zip'
                            ? 'archive'
                            : h.target === 'folder'
                              ? 'folder'
                              : h.sourceFamily
                        }
                        ext={h.target === 'folder' ? '' : h.target}
                      />
                      <div>
                        <b>{h.name}</b>
                        <span>
                          {h.sourceName} <ArrowRight size={11} />{' '}
                          {h.operation === 'extract'
                            ? 'Extracted'
                            : h.operation === 'pack'
                              ? 'Zipped'
                              : h.operation === 'compress'
                                ? 'Compressed'
                                : 'Converted'}
                        </span>
                      </div>
                      <span className="history-size">
                        {h.target === 'folder' ? 'Folder' : bytes(h.size)}
                      </span>
                      <span className="history-date">{date(h.completedAt)}</span>
                      <button
                        className="secondary-button small-button"
                        onClick={() => action(() => api.reveal(h.id))}
                      >
                        Show in Finder
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {route === 'formats' && (
            <>
              <div className="utility-heading">
                <div className="eyebrow">FIND YOUR NEXT FORMAT</div>
                <h1>
                  A world of formats<span>.</span>
                </h1>
                <p>
                  {formatCount} recognized formats and engine aliases, with compatible output
                  choices for every file.
                </p>
              </div>
              <div className="format-search">
                <Search size={19} />
                <input
                  ref={searchRef}
                  placeholder="Search a format or category…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button aria-label="Clear search" onClick={() => setSearch('')}>
                    <X size={16} />
                  </button>
                )}
                <kbd>⌘ K</kbd>
              </div>
              <div className="format-grid">
                {families
                  .filter(
                    (f) =>
                      f.name.toLowerCase().includes(search.toLowerCase()) ||
                      f.formats.some((x) => x.includes(search.toLowerCase())),
                  )
                  .map((f) => {
                    const Icon = icons[f.id];
                    return (
                      <div className="format-card" key={f.id}>
                        <div className="format-card-heading">
                          <span className={`card-icon ${colors[f.id]}`}>
                            <Icon size={19} />
                          </span>
                          <h3>{f.name}</h3>
                          <span>{f.formats.length}</span>
                        </div>
                        <div className="format-tags">
                          {f.formats
                            .filter(
                              (x) =>
                                f.name.toLowerCase().includes(search.toLowerCase()) ||
                                x.includes(search.toLowerCase()),
                            )
                            .map((ext) => (
                              <button
                                key={ext}
                                onClick={() => {
                                  setSelectedFormat(ext);
                                  setFormatTargets([]);
                                  if (api)
                                    api
                                      .describeFormat(ext)
                                      .then(setFormatTargets)
                                      .catch((e) => setError(e.message));
                                }}
                              >
                                {ext.toUpperCase()}
                              </button>
                            ))}
                        </div>
                        <p>
                          {f.id === 'pdf'
                            ? 'Page images and selectable text. Scanned pages can use English OCR.'
                            : f.id === 'archive'
                              ? 'ZIP creation, safe extraction, and archive repacking.'
                              : f.id === 'video'
                                ? 'Container conversion, audio extraction, and still frames.'
                                : f.id === 'data'
                                  ? 'Nested data stays structured. Tables require flat records.'
                                  : f.id === 'document'
                                    ? 'Office documents, rich text, and ebook conversion.'
                                    : f.id === 'image'
                                      ? 'Photos, graphics, icons, and image-to-PDF.'
                                      : f.id === 'spreadsheet'
                                        ? 'Workbooks, first-sheet CSV exports, and PDF.'
                                        : f.id === 'presentation'
                                          ? 'Slide decks and shareable PDF exports.'
                                          : 'Lossy formats and lossless audio containers.'}
                        </p>
                      </div>
                    );
                  })}
              </div>
              {!families.some(
                (f) =>
                  f.name.toLowerCase().includes(search.toLowerCase()) ||
                  f.formats.some((x) => x.includes(search.toLowerCase())),
              ) && (
                <div className="empty-state">
                  <Search size={25} />
                  <h2>No matching formats.</h2>
                  <p>Try a file extension like PNG, or a category like video.</p>
                </div>
              )}
              <button
                className="secondary-button matrix-button"
                onClick={() => action(() => api.openFormatList())}
              >
                <Grid2X2 size={16} />
                Open full conversion matrix
                <ArrowUpRight size={14} />
              </button>
              <div className="catalog-note">
                <CircleAlert size={15} />
                Formats have compatible destinations. Support can depend on installed engines,
                codecs, and the contents of a file.
              </div>
            </>
          )}
          {route === 'settings' && (
            <>
              <div className="utility-heading">
                <div className="eyebrow">MAKE YOURSELF AT HOME</div>
                <h1>
                  Your workspace<span>.</span>
                </h1>
                <p>Everything you need. Right here on your Mac.</p>
              </div>
              <section className="settings-card">
                <h3>
                  <FolderOpen size={18} />
                  Output folder
                </h3>
                <p>
                  New results are saved here. Existing files get a new name and are never
                  overwritten.
                </p>
                <div className="settings-folder">
                  <span title={output}>{output}</span>
                  <button
                    className="secondary-button"
                    disabled={running}
                    onClick={() => action(async () => setOutput(await api.selectOutput()))}
                  >
                    Change folder
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Open output folder"
                    onClick={() => action(() => api.openOutput())}
                  >
                    <ArrowUpRight size={17} />
                  </button>
                </div>
              </section>
              <section className="settings-card">
                <div className="settings-heading">
                  <h3>
                    <Box size={18} />
                    Conversion engines
                  </h3>
                  <button
                    className="text-button"
                    onClick={() =>
                      action(async () => {
                        applyState(await api.refreshEngines());
                        setToast('Engine availability refreshed.');
                      })
                    }
                  >
                    <RotateCcw size={14} />
                    Refresh
                  </button>
                </div>
                <p>These local tools power the supported formats. No files leave your computer.</p>
                <div className="engine-list">
                  {[
                    ['magick', 'ImageMagick', 'Camera RAW, Photoshop, scientific images, and more'],
                    [
                      'python',
                      'Extended format engine',
                      'Fonts, data tables, and PDF reconstruction',
                    ],
                    ['blender', 'Blender', '3D meshes, models, and scene conversion'],
                    ['calibre', 'Calibre', 'Kindle and ebook conversion'],
                    ['sevenzip', '7-Zip', '7Z/RAR extraction and 7Z output'],
                    ['tesseract', 'Tesseract', 'English OCR for scanned PDF pages'],
                    ['images', 'Image engine', 'JPG, PNG, WebP, AVIF, TIFF, GIF, icons'],
                    ['ffmpeg', 'FFmpeg', 'Video, audio, and media compression'],
                    ['office', 'LibreOffice', 'Documents, spreadsheets, and presentations'],
                    ['pandoc', 'Pandoc', 'Text, documents, and ebooks'],
                    ['pdf', 'macOS PDFKit', 'PDF page rendering and text extraction'],
                    ['qpdf', 'QPDF', 'Lossless PDF compression'],
                    ['ghostscript', 'Ghostscript', 'Smaller PDFs with image downsampling'],
                    ['oxipng', 'OxiPNG', 'Lossless PNG optimization'],
                    ['jpegtran', 'JPEGtran', 'Lossless JPEG optimization'],
                    ['archive', 'Archive engine', 'ZIP, TAR, GZIP, BZIP2, and XZ'],
                    ['data', 'Data engine', 'JSON, YAML, XML, CSV, and TSV'],
                  ].map(([key, name, description]) => (
                    <div className="engine-row" key={key}>
                      <div className={engines[key] ? 'engine-check' : 'engine-missing'}>
                        {engines[key] ? <Check size={13} /> : <X size={13} />}
                      </div>
                      <div>
                        <b>{name}</b>
                        <span>{description}</span>
                        {!engines[key] && !['images', 'data', 'pdf', 'archive'].includes(key) && (
                          <code>
                            brew install{' '}
                            {key === 'office'
                              ? '--cask libreoffice'
                              : key === 'ghostscript'
                                ? 'ghostscript'
                                : key === 'jpegtran'
                                  ? 'jpeg-turbo'
                                  : key}
                          </code>
                        )}
                      </div>
                      <span className={`engine-status ${engines[key] ? '' : 'unavailable'}`}>
                        {engines[key] ? 'Ready' : 'Unavailable'}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
              <div className="settings-privacy">
                <ShieldCheck size={24} />
                <div>
                  <b>Local by default. Always.</b>
                  <p>
                    Flux doesn’t send your files to a server. Only recent output paths are kept in
                    the app’s local history.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {dragging && (
        <div className="drag-overlay">
          <Upload size={42} />
          <h2>Drop to add your files</h2>
          <p>They’ll stay on your Mac.</p>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {selectedFormat && (
        <div className="modal-backdrop" onClick={() => setSelectedFormat(null)}>
          <div className="format-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close icon-button"
              aria-label="Close format details"
              onClick={() => setSelectedFormat(null)}
            >
              <X size={19} />
            </button>
            <FileGlyph family={detailFamily?.id} ext={selectedFormat} large />
            <h2>{selectedFormat.toUpperCase()} files</h2>
            <p>
              {detailFamily?.name}. Add a file to see the compatible outputs available for its
              contents.
            </p>
            {formatTargets.length > 0 && (
              <div className="modal-formats">
                <span>CAN CONVERT TO</span>
                <div>
                  {formatTargets.map((t) => (
                    <b key={t}>{formatLabel(t)}</b>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-details">
              <ShieldCheck size={17} />
              Local conversion, compression, and ZIP packaging.
            </div>
            <button
              className="primary-button"
              onClick={() => {
                setSelectedFormat(null);
                setRoute('convert');
                selectFiles();
              }}
            >
              <Plus size={16} />
              Add a file
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
