'use strict';
const $ = id => document.getElementById(id);
let state = { files: [], jobs: [], history: [], formats: [] }, mode = 'convert', targets = new Map(), compression = new Map(), names = new Map(), loading = false;
const bytes = n => n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
function showError(e) { $('error').textContent = e.message || String(e); $('error').hidden = false; }
async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch('/api/' + url, { method, credentials: 'same-origin', headers: { ...(method !== 'GET' ? { 'X-Flux-Request': '1' } : {}), ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined });
  if (response.status === 401) { showError(new Error('Your login expired. Reload this page to sign in.')); throw new Error('Login required.'); }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function download(result) {
  const wrap = node('div', undefined, 'save-control'), name = node('input'); name.value = names.get(result.id) || result.name; name.setAttribute('aria-label', 'Save filename for ' + result.name); name.oninput = () => names.set(result.id, name.value);
  const button = node('button', 'Save as ↗', 'download'); button.onclick = async () => {
    try {
      const saveName = name.value.trim(); if (!saveName || /[\x00-\x1f\x7f/\\:]/.test(saveName) || saveName.startsWith('.') || saveName.startsWith('-') || new TextEncoder().encode(saveName).length > 180) throw new Error('Choose a filename without paths or control characters.');
      const url = '/api/download/' + encodeURIComponent(result.id) + '?name=' + encodeURIComponent(saveName);
      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({ suggestedName: saveName }); const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('This result expired. Convert the file again.');
        const writable = await handle.createWritable(); await response.body.pipeTo(writable);
      } else { const link = node('a'); link.href = url; link.download = saveName; document.body.append(link); link.click(); link.remove(); }
    } catch (e) { if (e.name !== 'AbortError') showError(e); }
  }; wrap.append(name, button); return wrap;
}
function choice(f) {
  const values = f.compressionOptions || [];
  if ($('compression').value === 'lossy') return values.find(c => c.id === 'lossy');
  return values.find(c => c.id === compression.get(f.id) && c.id !== 'lossy') || values.find(c => c.id === 'lossless') || values.find(c => c.id === 'archive');
}
function render() {
  $('queue').hidden = !state.files.length; $('dropzone').hidden = Boolean(state.files.length); $('count').textContent = state.files.length + ' files · ' + bytes(state.files.reduce((n, f) => n + f.size, 0));
  const active = state.jobs.some(j => ['queued', 'running'].includes(j.status)); $('run').disabled = active || loading || !state.files.length; $('cancel').hidden = !active; $('status').textContent = loading ? 'Uploading and scanning…' : active ? 'Working on your server…' : 'Ready when you are.';
  $('run').textContent = mode === 'compress' ? 'Compress files →' : mode === 'pack' ? ($('archive').value === 'pack' ? 'Create ZIP →' : 'Extract archives →') : 'Convert files →';
  $('rows').replaceChildren();
  for (const f of state.files) {
    const row = node('div', undefined, 'row'); row.append(node('div', (f.ext || 'FILE').toUpperCase().slice(0, 8), 'glyph'));
    const info = node('div'); info.append(node('div', f.name, 'file-name'), node('div', bytes(f.size) + (f.details ? ' · ' + f.details : ''), 'file-size')); row.append(info);
    const jobs = state.jobs.filter(j => j.fileIds?.includes(f.id)); const job = jobs[jobs.length - 1];
    if (mode === 'convert' && f.targets?.length) {
      const select = node('select'); select.setAttribute('aria-label', 'Output for ' + f.name); for (const target of f.targets) { const option = node('option', target.toUpperCase()); option.value = target; select.append(option); } select.value = targets.get(f.id) || (f.targets.includes('pdf') ? 'pdf' : f.targets[0]); targets.set(f.id, select.value); select.disabled = active; select.onchange = () => targets.set(f.id, select.value); row.append(select);
    } else if (mode === 'compress' && choice(f)) {
      const select = node('select'); select.setAttribute('aria-label', 'Compression for ' + f.name); const choices = (f.compressionOptions || []).filter(c => $('compression').value === 'lossy' ? c.id === 'lossy' : c.id !== 'lossy'); for (const c of choices) { const option = node('option', c.name); option.value = c.id; select.append(option); } select.value = choice(f).id; select.disabled = active; select.onchange = () => { compression.set(f.id, select.value); render(); }; row.append(select);
    } else row.append(node('span', mode === 'pack' ? ($('archive').value === 'pack' ? 'ZIP' : 'Extract') : 'No supported output', 'job-state'));
    row.append(job?.status === 'done' ? download(job.result) : node('span', job?.status || 'Ready', 'job-state' + (job?.status === 'error' ? ' failed' : '')));
    const warning = job?.error || f.warning || (mode === 'convert' ? f.notes?.[targets.get(f.id)] : mode === 'compress' ? choice(f)?.note : $('archive').value === 'extract' ? 'Downloads validated archive contents together as a ZIP.' : 'Includes this file in your ZIP.'); if (warning) row.append(node('div', warning, 'note')); $('rows').append(row);
  }
  $('result-list').replaceChildren(); for (const result of state.history) { const row = node('div', undefined, 'result-row'), text = node('div', result.name); text.append(node('small', bytes(result.size) + ' · ' + new Date(result.completedAt).toLocaleTimeString())); row.append(text, download(result)); $('result-list').append(row); }
  if (!state.history.length) $('result-list').append(node('p', 'Your completed downloads will appear here.', 'intro'));
}
function setMode(next) {
  mode = next; $('workspace').hidden = ['formats', 'history'].includes(mode); $('formats').hidden = mode !== 'formats'; $('history').hidden = mode !== 'history';
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === mode));
  $('breadcrumb').textContent = 'Workspace / ' + ({ convert: 'Convert files', compress: 'Compress files', pack: 'ZIP & Unzip', formats: 'All formats', history: 'Recent results' }[mode]);
  $('compression-label').hidden = mode !== 'compress'; $('archive-label').hidden = mode !== 'pack';
  $('title').replaceChildren(document.createTextNode(mode === 'compress' ? 'Big ideas.' : mode === 'pack' ? 'Pack it up.' : 'Good files.'), node('br'), document.createTextNode(mode === 'compress' ? 'Smaller files' : mode === 'pack' ? 'Or open it out' : 'New possibilities'), node('span', '.'));
  $('intro').textContent = mode === 'compress' ? 'Keep the details with lossless optimization, or trade some quality for a smaller file.' : mode === 'pack' ? 'Create a ZIP or extract validated archive contents for download.' : 'Images, videos, documents, and everything in between. Turn your files into what you need.';
  render(); if (mode === 'formats') renderFormats();
}
function renderFormats() {
  const query = $('search').value.trim().toLowerCase(); const list = state.formats.filter(f => (f.input + ' ' + f.family + ' ' + f.targets.join(' ')).includes(query)); $('format-count').textContent = list.length + ' inputs and engine aliases'; $('format-list').replaceChildren();
  for (const f of list.slice(0, 900)) { const row = node('div', undefined, 'format-row'); row.append(node('b', f.input.toUpperCase()), node('span', f.family), node('p', f.targets.length ? f.targets.map(t => t.toUpperCase()).join(' · ') : 'ZIP packaging available; no conversion output for this format.')); $('format-list').append(row); }
}
async function upload(files) {
  loading = true; $('error').hidden = true; render();
  try { for (const f of files) {
    if (f.size > 5_000_000_000) throw new Error(f.name + ' exceeds the 5 GB limit.');
    const upload = await api('uploads', { method: 'POST', body: { name: f.name, size: f.size } });
    for (let offset = 0; offset < f.size; offset += upload.chunkSize) {
      $('status').textContent = 'Uploading ' + f.name + ' · ' + Math.floor(offset / f.size * 100) + '%';
      await api('uploads/' + upload.id, { method: 'PUT', body: f.slice(offset, offset + upload.chunkSize), headers: { 'Content-Type': 'application/octet-stream', 'X-Flux-Offset': String(offset) } });
    }
    $('status').textContent = 'Scanning ' + f.name + '…';
    const completion = await api('uploads/' + upload.id + '/complete', { method: 'POST', body: {} });
    while (true) {
      Object.assign(state, await api('status')); const job = state.jobs.find(j => j.id === completion.id); render();
      if (job?.status === 'done') break; if (job?.status === 'error') throw new Error(job.error);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } }
  catch (e) { showError(e); } finally { loading = false; $('files').value = ''; render(); }
}
async function start() {
  $('error').hidden = true; loading = true; render();
  try {
    const specs = mode === 'pack' && $('archive').value === 'pack' ? [{ operation: 'pack', ids: state.files.map(f => f.id) }] : state.files.map(f => ({ operation: mode === 'pack' ? 'extract' : mode, id: f.id, target: targets.get(f.id), compression: choice(f)?.id, options: { quality: $('quality').value, width: Number($('width').value) } }));
    // Submit and finish sequentially: the server still enforces its own queue.
    for (const spec of specs) {
      const result = await api('jobs', { method: 'POST', body: spec });
      while (true) { Object.assign(state, await api('status')); render(); const job = state.jobs.find(j => j.id === result.id); if (job && !['queued', 'running'].includes(job.status)) break; await new Promise(resolve => setTimeout(resolve, 1500)); }
    }
  } catch (e) { showError(e); } finally { loading = false; render(); }
}
async function clear() { try { await api('files', { method: 'DELETE' }); Object.assign(state, await api('status')); render(); } catch (e) { showError(e); } }
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode)); $('choose').onclick = e => { e.stopPropagation(); $('files').click(); }; $('add').onclick = () => $('files').click(); $('dropzone').onclick = () => $('files').click(); $('dropzone').onkeydown = e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); $('files').click(); } }; $('files').onchange = e => upload([...e.target.files]); $('clear').onclick = clear; $('delete-results').onclick = clear; $('run').onclick = start; $('compression').onchange = render; $('archive').onchange = render; $('search').oninput = renderFormats;
$('cancel').onclick = async () => { for (const job of state.jobs.filter(j => ['queued', 'running'].includes(j.status))) await api('cancel', { method: 'POST', body: { id: job.id } }); };
document.body.ondragover = e => { e.preventDefault(); $('dropzone').classList.add('dragging'); }; document.body.ondragleave = () => $('dropzone').classList.remove('dragging'); document.body.ondrop = e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); if (!loading) upload([...e.dataTransfer.files]); };
api('state').then(s => { state = s; $('user').textContent = s.user; render(); renderFormats(); }).catch(showError);
