// Video Downloader Extension - Background Service Worker
// 1. Sniffs media requests on all sites (webRequest) and keeps a per-tab list.
// 2. Fetches YouTube formats via the InnerTube API; mobile clients return
//    direct URLs (no signatureCipher / throttled "n" parameter).
// 3. Bridges the page's live player response via a MAIN-world script.
// 4. Proxies media fetches for content scripts blocked by CORS.

importScripts('shared.js');

// ---------------- Media detection ----------------

const tabMedia = new Map();   // tabId -> [{url, kind, mime, size, ts}]
const tabBlob = new Set();    // tabs where only blob: (MSE) sources were seen
const MAX_PER_TAB = 50;

// Restore detections after a service worker restart
const ready = chrome.storage.session.get(['detected', 'blobTabs']).then(stored => {
  if (stored.detected) {
    for (const [id, items] of Object.entries(stored.detected)) tabMedia.set(Number(id), items);
  }
  if (stored.blobTabs) stored.blobTabs.forEach(id => tabBlob.add(id));
}).catch(() => {});

let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const detected = {};
    for (const [id, items] of tabMedia) detected[id] = items;
    chrome.storage.session.set({ detected: detected, blobTabs: [...tabBlob] });
  }, 500);
}

function updateBadge(tabId, items) {
  const count = (items || []).length;
  chrome.action.setBadgeText({ tabId: tabId, text: count ? String(count) : '' });
}
chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });

async function addDetection(tabId, item) {
  if (tabId == null || tabId < 0) return;
  await ready;
  const list = tabMedia.get(tabId) || [];
  const existing = list.find(x => x.url === item.url);
  if (existing) {
    if (item.mime) existing.mime = item.mime;
    // Keep the largest size seen (Content-Range total beats a chunk's length)
    if (item.size && item.size > (existing.size || 0)) existing.size = item.size;
    // Later evidence can reveal a "file" is actually a stream fragment
    if (item.kind === 'segment' && existing.kind === 'file') existing.kind = 'segment';
  } else {
    list.push({ url: item.url, kind: item.kind || 'file', mime: item.mime || '', size: item.size || 0, ts: Date.now() });
    if (list.length > MAX_PER_TAB) list.shift();
    tabMedia.set(tabId, list);
    updateBadge(tabId, list);
  }
  persist();
}

function clearTab(tabId) {
  tabMedia.delete(tabId);
  tabBlob.delete(tabId);
  updateBadge(tabId, []);
  persist();
}

const SNIFF_TYPES = ['media', 'xmlhttprequest', 'other'];

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
  const kind = YTDl.classifyMediaUrl(details.url);
  if (kind) addDetection(details.tabId, { url: details.url, kind: kind });
}, { urls: ['<all_urls>'], types: SNIFF_TYPES });

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
  const headers = details.responseHeaders || [];
  const get = name => {
    const h = headers.find(x => x.name.toLowerCase() === name);
    return h ? h.value : '';
  };
  const mime = get('content-type');
  let size = parseInt(get('content-length')) || 0;
  // Partial response (206): Content-Range carries the FULL file size
  const contentRange = get('content-range');
  if (contentRange) {
    const total = parseInt(contentRange.split('/')[1]);
    if (total > 0) size = total;
  }
  const urlKind = YTDl.classifyMediaUrl(details.url);
  let kind = urlKind || YTDl.kindFromMime(mime);
  // Small extension-less media responses are almost always stream fragments
  // (fMP4 segments served as video/mp4, etc.), not standalone videos
  if (kind === 'file' && !urlKind && size > 0 && size < 1.5 * 1024 * 1024) {
    kind = 'segment';
  }
  if (kind) addDetection(details.tabId, { url: details.url, kind: kind, mime: mime, size: size });
}, { urls: ['<all_urls>'], types: SNIFF_TYPES }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => clearTab(tabId));

// ---------------- Messages ----------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getFormats') {
    (async () => {
      const result = await fetchVideoFormats(request.videoId);
      if (result.success) {
        // InnerTube URLs often 403 (no fresh n-transform / PO token).
        // Override them with the URLs the page's own player resolved.
        const pr = await getTabPagePlayerResponse(sender.tab && sender.tab.id);
        if (pr.success && pr.playerResponse && pr.playerResponse.streamingData) {
          const all = [
            ...(pr.playerResponse.streamingData.formats || []),
            ...(pr.playerResponse.streamingData.adaptiveFormats || [])
          ];
          const byItag = new Map();
          for (const f of all) if (f.url) byItag.set(String(f.itag), f.url);
          for (const f of result.formats) {
            const live = byItag.get(String(f.itag));
            if (live) f.url = live;
          }
        }
      }
      sendResponse(result);
    })().catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'getPlayerResponse') {
    getTabPagePlayerResponse(sender.tab && sender.tab.id)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'getCapturedUrl') {
    // Return a real, fully-signed media URL sniffed from the page's own
    // network requests. InnerTube URLs can 403 (missing n-transform / PO
    // token); the player's own videoplayback request is always valid.
    const tabId = sender.tab && sender.tab.id;
    const list = tabMedia.get(tabId) || [];
    const itag = String(request.itag || '');
    let match = null;
    if (itag) {
      match = list.find(x => {
        try { return new URL(x.url).searchParams.get('itag') === itag; } catch (e) { return false; }
      });
    }
    if (!match) {
      match = list.filter(x => x.url.includes('videoplayback')).sort((a, b) => b.ts - a.ts)[0];
    }
    const fresh = match && (Date.now() - match.ts < 30 * 60 * 1000);
    sendResponse({ url: fresh ? match.url : null });
    return false;
  }
  if (request.action === 'getDetected') {
    ready.then(() => {
      sendResponse({
        success: true,
        items: tabMedia.get(request.tabId) || [],
        hasBlob: tabBlob.has(request.tabId)
      });
    });
    return true;
  }
  if (request.action === 'mediaFound') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      for (const item of request.items || []) {
        const kind = YTDl.classifyMediaUrl(item.url) || 'file';
        addDetection(tabId, { url: item.url, kind: kind });
      }
      if (request.hasBlob) {
        tabBlob.add(tabId);
        persist();
      }
    }
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'fetchProxy') {
    // Range is a forbidden header in page fetches but allowed here with
    // host permissions (needed for byte-range HLS segments). Some CDNs
    // (e.g. Vimeo) also require the page's Referer.
    const headers = Object.assign({}, request.headers);
    if (!headers.Referer && sender.tab && sender.tab.url) headers.Referer = sender.tab.url;
    fetch(request.url, { credentials: 'include', headers: headers }).then(async response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      sendResponse({ success: true, data: YTDl.bytesToBase64(bytes) });
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'mergeChunk' || request.action === 'mergeRun') {
    const tabId = sender.tab && sender.tab.id;
    if (request.action === 'mergeRun' && tabId != null) mergeJobs.set(request.jobId, tabId);
    ensureOffscreen()
      .then(() => forwardToOffscreen(request))
      .then(resp => sendResponse(resp))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'mergeEvent') {
    // From the offscreen document: route to the tab that started the merge
    const tabId = mergeJobs.get(request.jobId);
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, request, () => { void chrome.runtime.lastError; });
      if (request.event === 'done' || request.event === 'error') mergeJobs.delete(request.jobId);
    }
    return false;
  }
});

// ---------------- Track merging (ffmpeg.wasm in offscreen sandbox) ----------------

const mergeJobs = new Map(); // jobId -> tabId
let offscreenCreating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Merge separate video and audio tracks into one file with ffmpeg.wasm'
    }).catch(() => {}).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

// createDocument() resolves before offscreen.js registers its listener, so
// retry until the offscreen document actually acknowledges the message.
// Chunks/run are idempotent on the sandbox side, making retries safe.
async function forwardToOffscreen(message, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const resp = await new Promise(resolve => {
      chrome.runtime.sendMessage(message, r => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    });
    if (resp && resp.ok) return resp;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Merger is not reachable. Reload the extension and try again.');
}

// ---------------- YouTube InnerTube ----------------

const INNERTUBE_CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, headerName: 3 },
  { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone14,3', headerName: 5 },
  { clientName: 'WEB', clientVersion: '2.20240101.00.00', headerName: 1 }
];

// Read the CURRENT player response from the page's main world.
// movie_player.getPlayerResponse() stays fresh across SPA navigations,
// unlike window.ytInitialPlayerResponse / inline <script> data.
async function getTabPagePlayerResponse(tabId) {
  if (!tabId) return { success: false, error: 'No sender tab' };
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: () => {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        try {
          const r = player.getPlayerResponse();
          if (r) return r;
        } catch (e) {}
      }
      return window.ytInitialPlayerResponse || null;
    }
  });
  const playerResponse = results && results[0] && results[0].result;
  if (!playerResponse) return { success: false, error: 'No player response on page' };
  return { success: true, playerResponse: playerResponse };
}

// Try InnerTube clients in order until one returns usable direct URLs.
async function fetchVideoFormats(videoId) {
  let lastError = 'Could not load video data';
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const contextClient = {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: 'en'
      };
      if (client.androidSdkVersion) contextClient.androidSdkVersion = client.androidSdkVersion;
      if (client.deviceModel) contextClient.deviceModel = client.deviceModel;

      const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(client.headerName),
          'X-YouTube-Client-Version': client.clientVersion
        },
        body: JSON.stringify({
          context: { client: contextClient },
          videoId: videoId,
          contentCheckOk: true,
          racyCheckOk: true
        })
      });

      if (!response.ok) {
        lastError = 'HTTP ' + response.status;
        continue;
      }

      const data = await response.json();
      const playability = data.playabilityStatus;
      if (playability && playability.status !== 'OK') {
        lastError = playability.reason || playability.status;
        continue;
      }

      const formats = [
        ...(data.streamingData?.formats || []),
        ...(data.streamingData?.adaptiveFormats || [])
      ].filter(f => f.url);

      if (formats.length === 0) {
        lastError = 'No direct download URLs available';
        continue;
      }

      return {
        success: true,
        formats: formats,
        title: data.videoDetails?.title || 'video'
      };
    } catch (e) {
      lastError = e.message;
    }
  }
  return { success: false, error: lastError };
}