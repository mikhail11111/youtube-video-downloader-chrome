// Video Downloader - Offscreen document
// Bridge between the extension (chrome.runtime messages) and the sandboxed
// iframe that runs ffmpeg.wasm (sandboxed pages may load remote scripts).

const frame = document.getElementById('sandbox-frame');
let sandboxReady = false;
const pending = [];

function postToSandbox(msg) {
  if (sandboxReady) {
    frame.contentWindow.postMessage(msg, '*');
  } else {
    pending.push(msg);
  }
}

// The iframe may post 'ready' before this listener exists, so keep pinging
// until the sandbox answers; it replies 'ready' to every 'init'.
const initTimer = setInterval(() => {
  if (sandboxReady) { clearInterval(initTimer); return; }
  try { frame.contentWindow.postMessage({ type: 'init' }, '*'); } catch (_) {}
}, 250);

window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'ready') {
    sandboxReady = true;
    clearInterval(initTimer);
    while (pending.length) frame.contentWindow.postMessage(pending.shift(), '*');
  } else if (m.type === 'event') {
    // Forward merge progress/result chunks to the background, which routes
    // them to the originating tab's content script
    chrome.runtime.sendMessage(Object.assign({ action: 'mergeEvent' }, m.payload));
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'mergeChunk') {
    postToSandbox({ type: 'chunk', jobId: request.jobId, part: request.part, index: request.index, data: request.data });
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'mergeRun') {
    postToSandbox({ type: 'run', jobId: request.jobId, videoExt: request.videoExt, audioExt: request.audioExt });
    sendResponse({ ok: true });
    return false;
  }
});