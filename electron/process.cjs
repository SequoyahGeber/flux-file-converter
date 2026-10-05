const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const cancelled = () => Object.assign(new Error('Conversion cancelled.'), { code: 'CANCELLED' });
const DEFAULT_TIMEOUT = 10 * 60 * 1000;
let bundledEnvironment;
// Set only by the trusted native worker using its private tool bundle.
function configureBundledEnvironment(environment) {
  bundledEnvironment = { ...environment };
}
const ENVIRONMENT_KEYS = [
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_RUNTIME_DIR',
  'FLUX_SERVER',
  'FLUX_ARCHIVE_MAX_BYTES',
  'FLUX_ARCHIVE_MAX_FILES',
  'MAGICK_CONFIGURE_PATH',
  'FONTCONFIG_PATH',
  'GS_LIB',
];

function engineEnvironment(source = process.env) {
  const env = Object.fromEntries(
    ENVIRONMENT_KEYS.filter((key) => typeof source[key] === 'string').map((key) => [
      key,
      source[key],
    ]),
  );
  const threads = source.FLUX_SERVER === '1' ? '1' : '2';
  return {
    ...env,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    PYTHONDONTWRITEBYTECODE: '1',
    OMP_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    MAGICK_THREAD_LIMIT: threads,
    QT_QPA_PLATFORM: 'offscreen',
    ...bundledEnvironment,
  };
}

function run(command, args, { signal, onLine, timeout = DEFAULT_TIMEOUT, cwd } = {}) {
  if (
    typeof command !== 'string' ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string')
  )
    return Promise.reject(new Error('Invalid conversion command.'));
  if (signal?.aborted) return Promise.reject(cancelled());
  timeout = Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT, 1), DEFAULT_TIMEOUT);
  const name = path.basename(command),
    env = engineEnvironment();
  if (/^(ffmpeg|ffprobe)$/.test(name)) {
    if (name === 'ffmpeg' && args.includes('-i'))
      args = [...args.slice(0, -1), '-threads', env.OMP_NUM_THREADS, args.at(-1)];
    args = [
      '-protocol_whitelist',
      'file,pipe',
      '-threads',
      env.OMP_NUM_THREADS,
      ...(name === 'ffmpeg'
        ? ['-filter_threads', env.OMP_NUM_THREADS, '-filter_complex_threads', env.OMP_NUM_THREADS]
        : []),
      ...args,
    ];
  }
  if (name === 'pandoc') args = ['--sandbox', ...args];
  // Server jobs already belong to a restricted process group. Local jobs get
  // their own group so cancellation also stops the tools' descendants.
  const grouped = process.platform !== 'win32' && env.FLUX_SERVER !== '1';
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '',
      timedOut = false,
      callbackError,
      settled = false,
      killTimer;
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const pending = ['', ''];
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: grouped,
      env,
    });
    const kill = (force) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') callbackError ||= error;
      }
    };
    const abort = () => {
      kill(false);
      if (!killTimer) {
        killTimer = setTimeout(() => kill(true), 1500);
        killTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeout);
    timer.unref();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const consume = (buffer, stream) => {
      const text = decoders[stream].write(buffer);
      if (stream) stderr = (stderr + text).slice(-100000);
      else stdout = (stdout + text).slice(-1000000);
      if (!onLine) return;
      const lines = (pending[stream] + text).split(/[\r\n]+/);
      // A hostile tool can emit an endless line. Never retain it indefinitely.
      pending[stream] = lines.pop().slice(-8192);
      for (const line of lines) {
        try {
          onLine(line.slice(-8192));
        } catch (error) {
          callbackError = error;
          abort();
          break;
        }
      }
    };
    child.stdout.on('data', (buffer) => consume(buffer, 0));
    child.stderr.on('data', (buffer) => consume(buffer, 1));
    child.once('error', (error) => finish(error));
    child.once('exit', () => {
      if (grouped) kill(true);
    });
    child.once('close', (code) => {
      if (signal?.aborted) return finish(cancelled());
      if (timedOut)
        return finish(
          new Error(`Conversion exceeded the time limit (${Math.ceil(timeout / 1000)} seconds).`),
        );
      if (callbackError) return finish(callbackError);
      if (code !== 0)
        return finish(
          new Error(
            (stderr.trim() || stdout.trim() || `Conversion engine exited with code ${code}.`).slice(
              -1600,
            ),
          ),
        );
      finish(null, {
        stdout: (stdout + decoders[0].end()).slice(-1000000),
        stderr: (stderr + decoders[1].end()).slice(-100000),
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

module.exports = { run, engineEnvironment, DEFAULT_TIMEOUT, configureBundledEnvironment };
