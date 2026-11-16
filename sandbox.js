// Video Downloader - Sandboxed merge worker
// Runs ffmpeg-core (Emscripten, loaded from CDN) DIRECTLY in this page to
// merge separate video/audio tracks into one MP4 with stream copy.
// No wrapper/worker: blob module workers fail silently in sandboxed pages,
// which used to hang the merge at "Loading merger..." forever.

const CORE_UMD = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const CHUNK_SIZE = 3 * 1024 * 1024; // stay well under the messaging limit
const LOAD_TIMEOUT = 180000;       // never hang silently on a stalled CDN

let core = null;
let loading = null;
const jobs = new Map(); // jobId -> {video: [], audio: [], videoExt, audioExt}
const startedJobs = new Set(); // run is idempotent even after the job is consumed

function post(payload) {
  parent.postMessage({ type: 'event', payload: payload }, '*');
}

function concatChunks(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out. Check your connection and try again.')), ms))
  ]);
}

// Fetch the wasm binary with progress reporting (it is ~31 MB)
async function fetchWasm(jobId, signal) {
  const response = await fetch(CORE_UMD + '/ffmpeg-core.wasm', { signal });
  if (!response.ok) throw new Error('Failed to load merger core (HTTP ' + response.status + ')');
  const total = parseInt(response.headers.get('content-length')) || 32129114;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received - lastReport > 4 * 1024 * 1024) {
      lastReport = received;
      post({ jobId: jobId, event: 'status', message: `Loading merger ${Math.round(received / 1048576)}/${Math.round(total / 1048576)} MB...` });
    }
  }
  return concatChunks(chunks);
}

function ensureLoaded(jobId) {
  if (core) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      if (typeof createFFmpegCore !== 'function') {
        throw new Error('ffmpeg core script failed to load from CDN (check internet connection)');
      }
      post({ jobId: jobId, event: 'status', message: 'Loading merger (~31 MB, once)...' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT);
      let wasm;
      try {
        wasm = await withTimeout(fetchWasm(jobId, controller.signal), LOAD_TIMEOUT, 'Merger download');
      } finally {
        clearTimeout(timer);
      }
      post({ jobId: jobId, event: 'status', message: 'Starting merger engine...' });
      core = await withTimeout(
        createFFmpegCore({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }),
        LOAD_TIMEOUT, 'Merger startup'
      );
    })().catch(e => {
      loading = null;
      if (e.name === 'AbortError') throw new Error('Merger download timed out. Check your connection and try again.');
      throw e;
    });
  }
  return loading;
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  try {
    if (!job || job.video.length === 0 || job.audio.length === 0) {
      throw new Error('Missing track data for merge');
    }
    await ensureLoaded(jobId);

    const vName = 'video.' + (job.videoExt || 'mp4');
    const aName = 'audio.' + (job.audioExt || 'm4a');
    post({ jobId: jobId, event: 'status', message: 'Merging video + audio...' });

    core.FS.writeFile(vName, concatChunks(job.video));
    core.FS.writeFile(aName, concatChunks(job.audio));
    job.video.length = 0;
    job.audio.length = 0;

    core.exec('-i', vName, '-i', aName, '-c', 'copy', '-movflags', '+faststart', 'output.mp4');
    const code = core.ret;
    core.reset();
    if (code !== 0) throw new Error('Merge failed (ffmpeg exit code ' + code + ')');

    const data = core.FS.readFile('output.mp4');
    try { core.FS.unlink(vName); core.FS.unlink(aName); core.FS.unlink('output.mp4'); } catch (_) {}

    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      post({ jobId: jobId, event: 'chunk', data: YTDl.bytesToBase64(data.subarray(i, i + CHUNK_SIZE)) });
    }
    post({ jobId: jobId, event: 'done', size: data.length });
  } catch (e) {
    post({ jobId: jobId, event: 'error', error: e.message || String(e) });
  }
}

window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    parent.postMessage({ type: 'ready' }, '*');
    return;
  }
  if (m.type === 'chunk') {
    if (startedJobs.has(m.jobId)) return;
    let job = jobs.get(m.jobId);
    if (!job) {
      job = { video: [], audio: [], videoExt: 'mp4', audioExt: 'm4a', seen: new Set() };
      jobs.set(m.jobId, job);
    }
    // Delivery is retried upstream; drop duplicate chunks by index
    const key = m.part + ':' + m.index;
    if (job.seen.has(key)) return;
    job.seen.add(key);
    job[m.part === 'audio' ? 'audio' : 'video'].push(YTDl.base64ToBytes(m.data));
  } else if (m.type === 'run') {
    if (startedJobs.has(m.jobId)) return;
    startedJobs.add(m.jobId);
    const job = jobs.get(m.jobId);
    if (job) {
      job.videoExt = m.videoExt || 'mp4';
      job.audioExt = m.audioExt || 'm4a';
    }
    runJob(m.jobId);
  }
});

parent.postMessage({ type: 'ready' }, '*');