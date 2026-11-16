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

window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'ready') {
    sandboxReady = true;
    while (pending.length) frame.contentWindow.postMessage(pending.shift(), '*');
  } else if (m.type === 'event') {
    // Forward merge progress/result chunks to the background, which routes
    // them to the originating tab's content script
    chrome.runtime.sendMessage(Object.assign({ action: 'mergeEvent' }, m.payload));
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'mergeChunk') {
    postToSandbox({ type: 'chunk', jobId: request.jobId, part: request.part, data: request.data });
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'mergeRun') {
    postToSandbox({ type: 'run', jobId: request.jobId, videoExt: request.videoExt, audioExt: request.audioExt });
    sendResponse({ ok: true });
    return false;
  }
});