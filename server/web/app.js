'use strict';
const $ = (id) => document.getElementById(id);
let state = { files: [], jobs: [], history: [], formats: [] },
  mode = 'convert',
  batchMode = 'convert',
  targets = new Map(),
  compression = new Map(),
  names = new Map(),
  loading = false,
  cancelled = false,
  uploadController,
  waitController,
  loadingText = '';
const bytes = (n) =>
  n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
function showError(e) {
  $('error').textContent = e.message || String(e);
  $('error').hidden = false;
}
async function api(url, { method = 'GET', body, headers = {}, signal } = {}) {
  const response = await fetch('/api/' + url, {
    method,
    signal,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? { 'X-Flux-Request': '1' } : {}),
      ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    showError(new Error('Your login expired. Reload this page to sign in.'));
    throw new Error('Login required.');
  }
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error(
      response.status >= 500
        ? 'The converter is restarting or unavailable. Try reloading shortly.'
        : 'Reload this page to reconnect through Cloudflare Access.',
    );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || 'Request failed.'), {
      status: response.status,
      retryAfter: Number(response.headers.get('Retry-After')) || 0,
    });
  return result;
}
async function quotaRequest(url, options, label) {
  while (!cancelled) {
    try {
      return await api(url, options);
    } catch (error) {
      if (error.status !== 429 || error.retryAfter <= 0 || error.retryAfter > 3600) throw error;
      const until = Date.now() + error.retryAfter * 1000;
      let refreshAt = Date.now() + 15000;
      while (Date.now() < until) {
        if (cancelled) throw new DOMException('Cancelled.', 'AbortError');
        if (Date.now() >= refreshAt) {
          // A long hourly-quota wait is active use, not 30-minute inactivity.
          Object.assign(state, await api('status'));
          refreshAt = Date.now() + 15000;
        }
        loadingText = `Waiting for server quota · ${Math.ceil((until - Date.now()) / 1000)}s · ${label}`;
        $('status').textContent = loadingText;
        await new Promise((resolve, reject) => {
          const signal = waitController.signal;
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException('Cancelled.', 'AbortError'));
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener('abort', abort);
              resolve();
            },
            Math.min(1000, until - Date.now()),
          );
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }
  throw new DOMException('Cancelled.', 'AbortError');
}
function matchesJob(job, spec) {
  return (
    job.operation === spec.operation &&
    JSON.stringify(job.fileIds) === JSON.stringify(spec.ids || [spec.id]) &&
    (spec.operation !== 'convert' || job.target === spec.target) &&
    (spec.operation !== 'compress' || job.compression === spec.compression) &&
    (!['convert', 'compress'].includes(spec.operation) ||
      (job.options?.quality === spec.options.quality && job.options?.width === spec.options.width))
  );
}
function rememberChoices() {
  try {
    sessionStorage.setItem(
      'flux-batch-choices',
      JSON.stringify({
        mode: batchMode,
        files: state.files.map((file) => ({
          id: file.id,
          target: targets.get(file.id),
          compression: compression.get(file.id),
        })),
        quality: $('quality').value,
        width: $('width').value,
        archive: $('archive').value,
        compression: $('compression').value,
      }),
    );
  } catch {
    /* Storage may be disabled; conversion still works in this tab. */
  }
}
function restoreChoices() {
  try {
    const text = sessionStorage.getItem('flux-batch-choices');
    if (!text || text.length > 32000) return 'convert';
    const saved = JSON.parse(text);
    if (Array.isArray(saved.files))
      for (const choice of saved.files.slice(0, 20)) {
        const file = state.files.find((file) => file.id === choice?.id);
        if (file?.targets?.includes(choice.target)) targets.set(file.id, choice.target);
        if (file?.compressionOptions?.some((option) => option.id === choice.compression))
          compression.set(file.id, choice.compression);
      }
    for (const id of ['quality', 'width', 'archive', 'compression']) {
      if ([...$(id).options].some((option) => option.value === saved[id])) $(id).value = saved[id];
    }
    return ['convert', 'compress', 'pack'].includes(saved.mode) ? saved.mode : 'convert';
  } catch {
    return 'convert';
  }
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function download(result) {
  const wrap = node('div', undefined, 'save-control'),
    name = node('input');
  name.value = names.get(result.id) || result.name;
  name.setAttribute('aria-label', 'Save filename for ' + result.name);
  name.oninput = () => names.set(result.id, name.value);
  const button = node('button', 'Save as ↗', 'download');
  button.onclick = async () => {
    try {
      const saveName = name.value.trim();
      if (
        !saveName ||
        /[\x00-\x1f\x7f/\\:]/.test(saveName) ||
        saveName.startsWith('.') ||
        saveName.startsWith('-') ||
        new TextEncoder().encode(saveName).length > 180
      )
        throw new Error('Choose a filename without paths or control characters.');
      if (saveName.split('.').pop().toLowerCase() !== result.name.split('.').pop().toLowerCase())
        throw new Error(
          'Keep the .' + result.name.split('.').pop() + ' extension when changing its name.',
        );
      const url =
        '/api/download/' + encodeURIComponent(result.id) + '?name=' + encodeURIComponent(saveName);
      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({ suggestedName: saveName });
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('This result expired. Convert the file again.');
        const writable = await handle.createWritable();
        await response.body.pipeTo(writable);
      } else {
        const link = node('a');
        link.href = url;
        link.download = saveName;
        document.body.append(link);
        link.click();
        link.remove();
      }
    } catch (e) {
      if (e.name !== 'AbortError') showError(e);
    }
  };
  wrap.append(name, button);
  return wrap;
}
function choice(f) {
  const values = f.compressionOptions || [];
  if ($('compression').value === 'lossy') return values.find((c) => c.id === 'lossy');
  return (
    values.find((c) => c.id === compression.get(f.id) && c.id !== 'lossy') ||
    values.find((c) => c.id === 'lossless') ||
    values.find((c) => c.id === 'archive')
  );
}
function render() {
  // The status/cancel controls live in the queue, including the first upload
  // before inspection has added any file rows.
  $('queue').hidden = !state.files.length && !loading;
  $('dropzone').hidden = Boolean(state.files.length) || loading;
  $('count').textContent =
    state.files.length +
    (state.files.length === 1 ? ' file · ' : ' files · ') +
    bytes(state.files.reduce((n, f) => n + f.size, 0));
  const active = state.jobs.some((j) => ['queued', 'running'].includes(j.status));
  $('run').disabled = active || loading || !state.files.length;
  $('cancel').hidden = !active && !loading;
  $('status').textContent = loading
    ? loadingText || 'Working on your server…'
    : active
      ? 'Working on your server…'
      : 'Ready when you are.';
  $('choose').disabled = loading || active;
  $('add').disabled = loading || active;
  $('clear').disabled = loading || active;
  for (const id of ['quality', 'width', 'archive', 'compression'])
    $(id).disabled = loading || active;
  $('run').textContent =
    mode === 'compress'
      ? 'Compress files →'
      : mode === 'pack'
        ? $('archive').value === 'pack'
          ? 'Create ZIP →'
          : 'Extract archives →'
        : 'Convert files →';
  $('rows').replaceChildren();
  for (const f of state.files) {
    const row = node('div', undefined, 'row');
    row.append(node('div', (f.ext || 'FILE').toUpperCase().slice(0, 8), 'glyph'));
    const info = node('div');
    info.append(
      node('div', f.name, 'file-name'),
      node('div', bytes(f.size) + (f.details ? ' · ' + f.details : ''), 'file-size'),
    );
    row.append(info);
    const jobs = state.jobs.filter((j) => j.operation !== 'upload' && j.fileIds?.includes(f.id));
    const job = jobs[jobs.length - 1];
    if (mode === 'convert' && f.targets?.length) {
      const select = node('select');
      select.setAttribute('aria-label', 'Output for ' + f.name);
      for (const target of f.targets) {
        const option = node('option', target.toUpperCase());
        option.value = target;
        select.append(option);
      }
      select.value = targets.get(f.id) || (f.targets.includes('pdf') ? 'pdf' : f.targets[0]);
      targets.set(f.id, select.value);
      select.disabled = active || loading;
      select.onchange = () => {
        targets.set(f.id, select.value);
        rememberChoices();
        const warning = job?.error || f.warning || f.notes?.[select.value];
        let note = row.querySelector('.note');
        if (warning) {
          if (!note) {
            note = node('div', undefined, 'note');
            row.append(note);
          }
          note.textContent = warning;
        } else note?.remove();
      };
      row.append(select);
    } else if (mode === 'compress' && choice(f)) {
      const select = node('select');
      select.setAttribute('aria-label', 'Compression for ' + f.name);
      const choices = (f.compressionOptions || []).filter((c) =>
        $('compression').value === 'lossy' ? c.id === 'lossy' : c.id !== 'lossy',
      );
      for (const c of choices) {
        const option = node('option', c.name);
        option.value = c.id;
        select.append(option);
      }
      select.value = choice(f).id;
      select.disabled = active || loading;
      select.onchange = () => {
        compression.set(f.id, select.value);
        render();
      };
      row.append(select);
    } else
      row.append(
        node(
          'span',
          mode === 'pack'
            ? $('archive').value === 'pack'
              ? 'ZIP'
              : 'Extract'
            : 'No supported output',
          'job-state',
        ),
      );
    row.append(
      job?.status === 'done'
        ? download(job.result)
        : node(
            'span',
            job?.status || 'Ready',
            'job-state' + (job?.status === 'error' ? ' failed' : ''),
          ),
    );
    const warning =
      job?.error ||
      f.warning ||
      (mode === 'convert'
        ? f.notes?.[targets.get(f.id)]
        : mode === 'compress'
          ? choice(f)?.note
          : $('archive').value === 'extract'
            ? 'Downloads validated archive contents together as a ZIP.'
            : 'Includes this file in your ZIP.');
    if (warning) row.append(node('div', warning, 'note'));
    $('rows').append(row);
  }
  $('result-list').replaceChildren();
  for (const result of state.history) {
    const row = node('div', undefined, 'result-row'),
      text = node('div', result.name);
    text.append(
      node('small', bytes(result.size) + ' · ' + new Date(result.completedAt).toLocaleTimeString()),
    );
    row.append(text, download(result));
    $('result-list').append(row);
  }
  if (!state.history.length)
    $('result-list').append(node('p', 'Your completed downloads will appear here.', 'intro'));
  rememberChoices();
}
function setMode(next) {
  if (['convert', 'compress', 'pack'].includes(next)) batchMode = next;
  mode = next;
  const permitted = state.canUse !== false;
  $('workspace').hidden = !permitted || ['formats', 'history', 'access'].includes(mode);
  $('formats').hidden = !permitted || mode !== 'formats';
  $('history').hidden = !permitted || mode !== 'history';
  $('access').hidden = mode !== 'access' || !state.canManageAccess;
  $('invitation-required').hidden = permitted;
  $('access-nav').hidden = !state.canManageAccess;
  document
    .querySelectorAll('[data-mode]')
    .forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
  $('breadcrumb').textContent =
    'Workspace / ' +
    {
      convert: 'Convert files',
      compress: 'Compress files',
      pack: 'ZIP & Unzip',
      formats: 'All formats',
      history: 'Recent results',
      access: 'Invite people',
    }[mode];
  $('compression-label').hidden = mode !== 'compress';
  $('archive-label').hidden = mode !== 'pack';
  $('title').replaceChildren(
    document.createTextNode(
      mode === 'compress' ? 'Big ideas.' : mode === 'pack' ? 'Pack it up.' : 'Good files.',
    ),
    node('br'),
    document.createTextNode(
      mode === 'compress'
        ? 'Smaller files'
        : mode === 'pack'
          ? 'Or open it out'
          : 'New possibilities',
    ),
    node('span', '.'),
  );
  $('intro').textContent =
    mode === 'compress'
      ? 'Keep the details with lossless optimization, or trade some quality for a smaller file.'
      : mode === 'pack'
        ? 'Create a ZIP or extract validated archive contents for download.'
        : 'Images, videos, documents, and everything in between. Turn your files into what you need.';
  render();
  if (mode === 'formats') renderFormats();
  if (mode === 'access' && state.canManageAccess) refreshAccess().catch(showError);
}
async function refreshAccess() {
  const access = await api('access');
  $('member-list').replaceChildren();
  $('invite-list').replaceChildren();
  if (!access.members.length)
    $('member-list').append(node('p', 'Only you have access so far.', 'intro'));
  for (const member of access.members) {
    const row = node('div', undefined, 'access-row'),
      text = node('div', member.email),
      button = node('button', 'Revoke access');
    text.append(node('small', 'Joined ' + new Date(member.joinedAt).toLocaleDateString()));
    button.onclick = async () => {
      try {
        await api('members/' + member.id, { method: 'DELETE' });
        await refreshAccess();
      } catch (e) {
        showError(e);
      }
    };
    row.append(text, button);
    $('member-list').append(row);
  }
  if (!access.invites.length)
    $('invite-list').append(node('p', 'Create a link to invite someone.', 'intro'));
  for (const invite of access.invites) {
    const row = node('div', undefined, 'access-row'),
      text = node(
        'div',
        invite.status === 'claimed'
          ? 'Claimed by ' + invite.claimedBy
          : invite.status.charAt(0).toUpperCase() + invite.status.slice(1),
      );
    text.append(node('small', 'Expires ' + new Date(invite.expiresAt).toLocaleString()));
    row.append(text);
    if (invite.status === 'pending') {
      const button = node('button', 'Revoke link');
      button.onclick = async () => {
        try {
          await api('invites/' + invite.id, { method: 'DELETE' });
          await refreshAccess();
        } catch (e) {
          showError(e);
        }
      };
      row.append(button);
    }
    $('invite-list').append(row);
  }
}
function renderFormats() {
  const query = $('search').value.trim().toLowerCase();
  const list = state.formats.filter((f) =>
    (f.input + ' ' + f.family + ' ' + f.targets.join(' ')).includes(query),
  );
  $('format-count').textContent = list.length + ' inputs and engine aliases';
  $('format-list').replaceChildren();
  for (const f of list.slice(0, 900)) {
    const row = node('div', undefined, 'format-row');
    row.append(
      node('b', f.input.toUpperCase()),
      node('span', f.family),
      node(
        'p',
        f.targets.length
          ? f.targets.map((t) => t.toUpperCase()).join(' · ')
          : 'ZIP packaging available; no conversion output for this format.',
      ),
    );
    $('format-list').append(row);
  }
}
async function upload(files) {
  if (loading || state.jobs.some((j) => ['queued', 'running'].includes(j.status))) return;
  loading = true;
  cancelled = false;
  waitController = new AbortController();
  loadingText = 'Uploading and scanning…';
  const controller = new AbortController();
  uploadController = controller;
  let uploadID;
  $('error').hidden = true;
  render();
  try {
    for (const f of files) {
      if (cancelled) break;
      if (f.size > 5_000_000_000) throw new Error(f.name + ' exceeds the 5 GB limit.');
      loadingText = 'Uploading and scanning…';
      const upload = await quotaRequest(
        'uploads',
        { method: 'POST', body: { name: f.name, size: f.size } },
        f.name,
      );
      uploadID = upload.id;
      if (cancelled) throw new DOMException('Upload cancelled.', 'AbortError');
      for (let offset = 0; offset < f.size; offset += upload.chunkSize) {
        if (cancelled) throw new DOMException('Upload cancelled.', 'AbortError');
        $('status').textContent =
          'Uploading ' + f.name + ' · ' + Math.floor((offset / f.size) * 100) + '%';
        await api('uploads/' + upload.id, {
          method: 'PUT',
          body: f.slice(offset, offset + upload.chunkSize),
          headers: { 'Content-Type': 'application/octet-stream', 'X-Flux-Offset': String(offset) },
          signal: controller.signal,
        });
      }
      if (cancelled) throw new DOMException('Upload cancelled.', 'AbortError');
      $('status').textContent = 'Scanning ' + f.name + '…';
      const completion = await api('uploads/' + upload.id + '/complete', {
        method: 'POST',
        body: {},
      });
      while (true) {
        Object.assign(state, await api('status'));
        const job = state.jobs.find((j) => j.id === completion.id);
        if (!job) throw new Error('This upload expired. Add the file again.');
        if (cancelled && ['queued', 'running'].includes(job.status))
          await api('cancel', { method: 'POST', body: { id: job.id } });
        render();
        if (job?.status === 'done') break;
        if (['error', 'cancelled'].includes(job?.status))
          throw new Error(job.error || 'Upload cancelled.');
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      uploadID = undefined;
    }
  } catch (e) {
    if (!cancelled) showError(e);
  } finally {
    if (uploadID) {
      // An interrupted chunk may still be closing on the server. Retry only
      // this upload's cleanup, retaining all previously completed files.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await api('uploads/' + uploadID, { method: 'DELETE' });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
    uploadController = undefined;
    waitController = undefined;
    loading = false;
    $('files').value = '';
    render();
  }
}
async function start() {
  if (loading || state.jobs.some((j) => ['queued', 'running'].includes(j.status))) return;
  $('error').hidden = true;
  loading = true;
  cancelled = false;
  waitController = new AbortController();
  loadingText = 'Converting files…';
  render();
  try {
    const specs =
      mode === 'pack' && $('archive').value === 'pack'
        ? [{ operation: 'pack', ids: state.files.map((f) => f.id) }]
        : state.files.map((f) => ({
            operation: mode === 'pack' ? 'extract' : mode,
            id: f.id,
            target: targets.get(f.id),
            compression: choice(f)?.id,
            options: { quality: $('quality').value, width: Number($('width').value) },
          }));
    // Submit and finish sequentially: the server still enforces its own queue.
    for (const spec of specs) {
      if (cancelled) break;
      if (
        state.jobs.some(
          (job) =>
            job.status === 'done' &&
            matchesJob(job, spec) &&
            state.history.some((result) => result.id === job.result?.id),
        )
      )
        continue;
      loadingText = 'Converting files…';
      const result = await quotaRequest('jobs', { method: 'POST', body: spec }, 'unfinished files');
      while (true) {
        Object.assign(state, await api('status'));
        render();
        const job = state.jobs.find((j) => j.id === result.id);
        if (!job) throw new Error('This job expired. Convert the file again.');
        if (cancelled && ['queued', 'running'].includes(job.status))
          await api('cancel', { method: 'POST', body: { id: job.id } });
        if (job.status === 'done') break;
        if (['error', 'cancelled'].includes(job.status)) {
          if (cancelled) break;
          throw new Error(job.error || 'Conversion cancelled. Retry to resume unfinished files.');
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  } catch (e) {
    if (!cancelled) showError(e);
  } finally {
    waitController = undefined;
    loading = false;
    render();
  }
}
async function clear() {
  try {
    await api('files', { method: 'DELETE' });
    targets.clear();
    compression.clear();
    names.clear();
    Object.assign(state, await api('status'));
    render();
  } catch (e) {
    showError(e);
  }
}
document
  .querySelectorAll('[data-mode]')
  .forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('choose').onclick = (e) => {
  e.stopPropagation();
  $('files').click();
};
$('add').onclick = () => $('files').click();
$('dropzone').onclick = () => $('files').click();
$('dropzone').onkeydown = (e) => {
  if (['Enter', ' '].includes(e.key)) {
    e.preventDefault();
    $('files').click();
  }
};
$('files').onchange = (e) => upload([...e.target.files]);
$('clear').onclick = clear;
$('delete-results').onclick = clear;
$('run').onclick = start;
$('compression').onchange = render;
$('archive').onchange = render;
$('quality').onchange = rememberChoices;
$('width').onchange = rememberChoices;
$('search').oninput = renderFormats;
$('cancel').onclick = async () => {
  cancelled = true;
  uploadController?.abort();
  waitController?.abort();
  try {
    for (const job of state.jobs.filter((j) => ['queued', 'running'].includes(j.status)))
      await api('cancel', { method: 'POST', body: { id: job.id } });
  } catch (e) {
    showError(e);
  }
};
document.body.ondragover = (e) => {
  e.preventDefault();
  $('dropzone').classList.add('dragging');
};
document.body.ondragleave = () => $('dropzone').classList.remove('dragging');
document.body.ondrop = (e) => {
  e.preventDefault();
  $('dropzone').classList.remove('dragging');
  if (!loading) upload([...e.dataTransfer.files]);
};
$('create-invite').onclick = async () => {
  $('create-invite').disabled = true;
  try {
    const invite = await api('invites', { method: 'POST', body: {} });
    $('invite-link').value = invite.url;
    $('new-invite').hidden = false;
    $('invite-expiry').textContent =
      'One use · Expires ' + new Date(invite.expiresAt).toLocaleString();
    await refreshAccess();
  } catch (e) {
    showError(e);
  } finally {
    $('create-invite').disabled = false;
  }
};
$('copy-invite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('invite-link').value);
    $('copy-invite').textContent = 'Copied';
  } catch {
    $('invite-link').select();
    $('invite-expiry').textContent = 'Select and copy this link to share it.';
  }
};
async function initialize() {
  const url = new URL(location.href),
    token = url.searchParams.get('invite');
  // Keep invitation credentials out of subsequent history/referrer URLs.
  if (token) {
    url.searchParams.delete('invite');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  let invitationError;
  if (token)
    try {
      await api('invites/claim', { method: 'POST', body: { token } });
    } catch (e) {
      invitationError = e;
    }
  state = await api('state');
  $('user').textContent = state.user;
  if (state.enrollmentUrl) $('enrollment-link').href = state.enrollmentUrl;
  setMode(restoreChoices());
  renderFormats();
  if (invitationError) showError(invitationError);
}
initialize().catch(showError);
