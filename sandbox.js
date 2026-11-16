// Video Downloader - Sandboxed merge worker
// Runs ffmpeg.wasm (loaded from CDN) to merge separate video/audio tracks
// into a single MP4 with stream copy (no re-encoding).

const FFMPEG_UMD = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd';
const CORE_UMD = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const CHUNK_SIZE = 3 * 1024 * 1024; // stay well under the messaging limit

let ffmpeg = null;
let loading = null;
const jobs = new Map(); // jobId -> {video: [], audio: [], videoExt, audioExt}

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

async function toBlobURL(url, mime) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load ' + url + ' (HTTP ' + response.status + ')');
  const buf = await response.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

function ensureLoaded(jobId) {
  if (ffmpeg) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      post({ jobId: jobId, event: 'status', message: 'Loading merger (~31 MB, once)...' });
      const f = new FFmpegWASM.FFmpeg();
      await f.load({
        coreURL: await toBlobURL(CORE_UMD + '/ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL(CORE_UMD + '/ffmpeg-core.wasm', 'application/wasm'),
        classWorkerURL: await toBlobURL(FFMPEG_UMD + '/814.ffmpeg.js', 'text/javascript')
      });
      ffmpeg = f;
    })().catch(e => { loading = null; throw e; });
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

    await ffmpeg.writeFile(vName, concatChunks(job.video));
    await ffmpeg.writeFile(aName, concatChunks(job.audio));
    job.video.length = 0;
    job.audio.length = 0;

    const code = await ffmpeg.exec([
      '-i', vName, '-i', aName,
      '-c', 'copy', '-movflags', '+faststart',
      'output.mp4'
    ]);
    if (code !== 0) throw new Error('Merge failed (ffmpeg exit code ' + code + ')');

    const data = await ffmpeg.readFile('output.mp4');
    try { await ffmpeg.deleteFile(vName); await ffmpeg.deleteFile(aName); await ffmpeg.deleteFile('output.mp4'); } catch (_) {}

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
  if (m.type === 'chunk') {
    let job = jobs.get(m.jobId);
    if (!job) {
      job = { video: [], audio: [], videoExt: 'mp4', audioExt: 'm4a' };
      jobs.set(m.jobId, job);
    }
    job[m.part === 'audio' ? 'audio' : 'video'].push(YTDl.base64ToBytes(m.data));
  } else if (m.type === 'run') {
    const job = jobs.get(m.jobId);
    if (job) {
      job.videoExt = m.videoExt || 'mp4';
      job.audioExt = m.audioExt || 'm4a';
    }
    runJob(m.jobId);
  }
});

parent.postMessage({ type: 'ready' }, '*');