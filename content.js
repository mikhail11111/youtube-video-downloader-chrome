// Video Downloader Extension - Content Script
// Runs on all sites (all frames):
//  - scans <video>/<audio> elements and reports direct sources to background
//  - top frame only: download panel + download runner (picker + File System
//    Access), so downloads survive popup closure
//  - YouTube only: in-page Download button + InnerTube format panel

(function() {
  'use strict';

  const DEFAULT_RATE_LIMIT = 500 * 1024; // 500 KB/s
  const IS_TOP = window === window.top;
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);

  let panel = null;
  let currentVideoId = null;
  let downloadController = null;

  // ---------------- Panel (top frame only) ----------------

  function createPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'ytdl-download-panel';
    panel.innerHTML = `
      <div class="ytdl-panel-header">
        <span>Download Video</span>
        <button class="ytdl-panel-close">&times;</button>
      </div>
      <div class="ytdl-panel-body">
        <div class="ytdl-loading">
          <div class="ytdl-spinner"></div>
          <div>Loading formats...</div>
        </div>
      </div>
      <div class="ytdl-status-row">
        <div class="ytdl-status"></div>
        <button class="ytdl-cancel" hidden>Cancel</button>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.ytdl-panel-close').addEventListener('click', () => {
      panel.classList.remove('visible');
    });

    panel.querySelector('.ytdl-cancel').addEventListener('click', () => {
      if (downloadController) downloadController.abort();
    });

    return panel;
  }

  function setStatus(message, type) {
    const status = panel.querySelector('.ytdl-status');
    status.textContent = message;
    status.className = 'ytdl-status' + (type ? ' ytdl-' + type : '');
  }

  function setCancelVisible(visible) {
    panel.querySelector('.ytdl-cancel').hidden = !visible;
  }

  function sendMessage(message) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(message, response => {
        void chrome.runtime.lastError; // suppress unchecked lastError warning
        resolve(response);
      });
    });
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  // A single clickable entry; the click provides the user gesture required
  // by showSaveFilePicker (popup clicks do NOT transfer activation here).
  function showConfirmation(label, sub, onConfirm) {
    const body = panel.querySelector('.ytdl-panel-body');
    body.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'ytdl-format-item';
    const info = document.createElement('div');
    const labelEl = document.createElement('div');
    labelEl.className = 'ytdl-format-label';
    labelEl.textContent = label;
    const subEl = document.createElement('div');
    subEl.className = 'ytdl-format-type';
    subEl.textContent = sub;
    info.appendChild(labelEl);
    info.appendChild(subEl);
    item.appendChild(info);
    item.addEventListener('click', onConfirm, { once: true });
    body.appendChild(item);
    setStatus('Click to choose a save location', '');
  }

  // HLS variant picker rendered in the panel
  function chooseVariant(variants) {
    return new Promise(resolve => {
      const body = panel.querySelector('.ytdl-panel-body');
      body.innerHTML = '';
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;font-weight:600;color:#888;margin-bottom:8px;text-transform:uppercase;';
      header.textContent = 'Select quality';
      body.appendChild(header);
      for (const v of variants) {
        const item = document.createElement('div');
        item.className = 'ytdl-format-item';
        const label = document.createElement('div');
        label.className = 'ytdl-format-label';
        label.textContent = v.resolution || (Math.round(v.bandwidth / 1000) + ' kbps');
        const sub = document.createElement('div');
        sub.className = 'ytdl-format-type';
        sub.textContent = Math.round(v.bandwidth / 1000) + ' kbps' + (/avc1/i.test(v.codecs || '') ? ' · H.264' : (v.codecs ? ' · ' + v.codecs.split(',')[0] : ''));
        item.appendChild(label);
        item.appendChild(sub);
        item.addEventListener('click', () => resolve(v), { once: true });
        body.appendChild(item);
      }
      setStatus('Pick a quality to download', '');
    });
  }

  // ---------------- Track merging (ffmpeg.wasm via offscreen sandbox) ----------------

  const MERGE_CHUNK = 3 * 1024 * 1024; // stay well under the messaging limit

  function concatBytes(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Send both tracks to the sandboxed merger in chunks, await merged bytes
  function mergeTracks(videoBytes, audioBytes, videoExt, audioExt, signal) {
    return new Promise((resolve, reject) => {
      const jobId = 'm' + Date.now() + Math.random().toString(36).slice(2);
      const resultChunks = [];
      let settled = false;

      function finish(fn) {
        if (settled) return;
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn();
      }
      function onAbort() {
        finish(() => reject(new DOMException('Aborted', 'AbortError')));
      }
      function listener(msg) {
        if (!msg || msg.action !== 'mergeEvent' || msg.jobId !== jobId) return;
        if (msg.event === 'chunk') {
          resultChunks.push(YTDl.base64ToBytes(msg.data));
        } else if (msg.event === 'status') {
          setStatus(msg.message, '');
        } else if (msg.event === 'done') {
          finish(() => resolve(concatBytes(resultChunks)));
        } else if (msg.event === 'error') {
          finish(() => reject(new Error(msg.error || 'Merge failed')));
        }
      }

      chrome.runtime.onMessage.addListener(listener);
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
      }

      (async () => {
        try {
          for (const part of ['video', 'audio']) {
            const bytes = part === 'video' ? videoBytes : audioBytes;
            for (let i = 0; i < bytes.length; i += MERGE_CHUNK) {
              const resp = await sendMessage({
                action: 'mergeChunk', jobId: jobId, part: part,
                data: YTDl.bytesToBase64(bytes.subarray(i, i + MERGE_CHUNK))
              });
              if (resp && resp.success === false) throw new Error(resp.error);
            }
          }
          const resp = await sendMessage({ action: 'mergeRun', jobId: jobId, videoExt: videoExt, audioExt: audioExt });
          if (resp && resp.success === false) throw new Error(resp.error);
        } catch (e) {
          finish(() => reject(e));
        }
      })();
    });
  }

  // Rate-limited fetch into memory (for tracks that will be merged)
  async function downloadToMemory(url, signal, label) {
    const response = await fetch(url, { credentials: 'include', signal: signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const totalBytes = parseInt(response.headers.get('Content-Length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      chunks.push(value);
      received += value.length;
      const delay = (value.length / DEFAULT_RATE_LIMIT) * 1000;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      const progress = totalBytes > 0 ? Math.round((received / totalBytes) * 100) + '%' : YTDl.formatBytes(received);
      setStatus(`${label}: ${progress} (${YTDl.formatBytes(received)})`, '');
    }
    return concatBytes(chunks);
  }

  // YouTube video-only format: fetch best audio too, merge into one MP4
  async function downloadYouTubeMerged(videoFmt, audioFmt, videoTitle) {
    if (downloadController) {
      setStatus('A download is already in progress', 'error');
      return;
    }
    downloadController = new AbortController();
    const signal = downloadController.signal;
    let writable = null;
    try {
      const base = YTDl.buildFilename(videoFmt, videoTitle).replace(/\.[a-z0-9]+$/i, '');
      // Picker first, while the click's user activation is fresh
      writable = await openWritable(base + '.mp4', 'mp4');
      setCancelVisible(true);
      const vBytes = await downloadToMemory(videoFmt.url, signal, 'Video');
      const aBytes = await downloadToMemory(audioFmt.url, signal, 'Audio');
      const merged = await mergeTracks(vBytes, aBytes, YTDl.extFromMime(videoFmt), YTDl.extFromMime(audioFmt), signal);
      signal.throwIfAborted();
      await writable.write(merged);
      await writable.close();
      writable = null;
      setStatus(`Download complete! (${YTDl.formatBytes(merged.length)})`, 'success');
    } catch (e) {
      if (writable) { try { await writable.abort(); } catch (_) {} }
      if (e.name === 'AbortError') setStatus('Download cancelled', 'error');
      else if (e.name === 'NotAllowedError') setStatus('Save cancelled', '');
      else setStatus('Download failed: ' + e.message, 'error');
      console.error('YTDl merged download error:', e);
    } finally {
      downloadController = null;
      setCancelVisible(false);
    }
  }

  async function openWritable(suggestedName, ext) {
    const accept = {};
    if (ext === 'ts') accept['video/*'] = ['.ts'];
    else if (ext === 'aac') accept['audio/*'] = ['.aac'];
    else if (ext === 'm4a') accept['audio/*'] = ['.m4a'];
    else if (ext === 'webm') accept['video/*'] = ['.webm'];
    else accept['video/*'] = ['.mp4', '.mkv'];
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedName,
      types: [{ description: 'Media file', accept: accept }]
    });
    return handle.createWritable();
  }

  // ---------------- Direct-file download ----------------

  // Rate-limited download using fetch + ReadableStream + File System Access API
  async function rateLimitedDownload(url, filename, rateLimit) {
    if (downloadController) {
      setStatus('A download is already in progress', 'error');
      return { success: false, error: 'Busy' };
    }
    rateLimit = rateLimit || DEFAULT_RATE_LIMIT;
    downloadController = new AbortController();
    const signal = downloadController.signal;
    let writable = null;
    let reader = null;

    try {
      // Ask user where to save FIRST, while the click's user activation is fresh
      const handle = await window.showSaveFilePicker({
        suggestedName: filename || 'video.mp4',
        types: [{
          description: 'Media file',
          accept: { 'video/*': ['.mp4', '.webm', '.m4a', '.mkv'], 'audio/*': ['.m4a', '.webm', '.mp3'] }
        }]
      });

      setStatus('Starting download...', '');
      setCancelVisible(true);

      const response = await fetch(url, { credentials: 'include', signal: signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = response.headers.get('Content-Length');
      const totalBytes = contentLength ? parseInt(contentLength) : 0;

      writable = await handle.createWritable();
      reader = response.body.getReader();

      let downloadedBytes = 0;
      const startTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();

        await writable.write(value);
        downloadedBytes += value.length;

        // Rate limiting: delay to stay below YouTube's throttle threshold
        const delay = (value.length / rateLimit) * 1000;
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Report progress
        const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? (downloadedBytes / elapsed / 1024).toFixed(0) + ' KB/s' : '';
        setStatus(`Downloading... ${progress}% (${YTDl.formatBytes(downloadedBytes)}${totalBytes ? '/' + YTDl.formatBytes(totalBytes) : ''}) ${speed}`, '');
      }

      await writable.close();
      writable = null;

      setStatus(`Download complete! (${YTDl.formatBytes(downloadedBytes)})`, 'success');
      return { success: true, downloaded: downloadedBytes };
    } catch (e) {
      // Clean up partial file and stop the network stream
      if (writable) { try { await writable.abort(); } catch (_) {} }
      if (reader) { try { await reader.cancel(); } catch (_) {} }

      if (e.name === 'AbortError') {
        setStatus('Download cancelled', 'error');
        return { success: false, error: 'Cancelled' };
      }
      if (e.name === 'NotAllowedError') {
        // User cancelled the save dialog
        setStatus('Save cancelled', '');
        return { success: false, error: 'Cancelled' };
      }
      setStatus('Download failed: ' + e.message, 'error');
      console.error('YTDl rate-limited download error:', e);
      return { success: false, error: e.message };
    } finally {
      downloadController = null;
      setCancelVisible(false);
    }
  }

  // ---------------- Stream downloads (HLS / DASH) ----------------

  async function runStream(item, baseName) {
    if (downloadController) {
      setStatus('A download is already in progress', 'error');
      return;
    }
    downloadController = new AbortController();
    setCancelVisible(true);
    const opts = {
      signal: downloadController.signal,
      baseName: baseName,
      onStatus: (msg, type) => setStatus(msg, type || ''),
      chooseVariant: chooseVariant,
      openFile: openWritable,
      merge: (v, a, ve, ae) => mergeTracks(v, a, ve, ae, downloadController.signal)
    };
    try {
      if (item.kind === 'hls') await YTStream.downloadHls(item.url, opts);
      else await YTStream.downloadDash(item.url, opts);
    } catch (e) {
      if (e.name === 'AbortError') setStatus('Download cancelled', 'error');
      else if (e.name === 'NotAllowedError') setStatus('Save cancelled', '');
      else setStatus('Download failed: ' + e.message, 'error');
      console.error('YTDl stream download error:', e);
    } finally {
      downloadController = null;
      setCancelVisible(false);
    }
  }

  function extFromUrlOrMime(item) {
    try {
      const m = new URL(item.url).pathname.match(/\.([a-z0-9]{2,4})$/i);
      if (m) return m[1].toLowerCase();
    } catch (e) {}
    const mime = (item.mime || '').split(';')[0].trim().toLowerCase();
    const map = {
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
      'video/quicktime': 'mov', 'video/mp2t': 'ts',
      'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg'
    };
    return map[mime] || 'mp4';
  }

  // Entry point for downloads requested by the popup
  function handleDownloadMedia(item) {
    createPanel();
    panel.classList.add('visible');
    const baseName = YTDl.sanitizeFilename(document.title || 'video');
    if (item.kind === 'hls' || item.kind === 'dash') {
      showConfirmation('Save ' + item.kind.toUpperCase() + ' stream', hostOf(item.url), () => {
        runStream(item, baseName);
      });
    } else {
      const ext = extFromUrlOrMime(item);
      showConfirmation('Save media file', hostOf(item.url) + ' - .' + ext, () => {
        rateLimitedDownload(item.url, baseName + '.' + ext, DEFAULT_RATE_LIMIT);
      });
    }
  }

  // ---------------- DOM media scanning (all frames) ----------------

  let scanTimer = null;

  function scanDom() {
    const items = [];
    let hasBlob = false;
    const seen = new Set();
    document.querySelectorAll('video, audio').forEach(el => {
      const sources = [el.src, el.currentSrc];
      el.querySelectorAll('source').forEach(s => sources.push(s.src));
      for (const src of sources) {
        if (!src || seen.has(src)) continue;
        seen.add(src);
        if (src.startsWith('blob:')) { hasBlob = true; continue; }
        if (/^https?:/i.test(src)) items.push({ url: src });
      }
    });
    if (items.length || hasBlob) {
      sendMessage({ action: 'mediaFound', items: items, hasBlob: hasBlob });
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanDom();
    }, 1500);
  }

  // ---------------- YouTube-specific flow ----------------

  function getVideoId() {
    const url = new URL(window.location.href);
    const v = url.searchParams.get('v');
    if (v) return v;
    const shorts = url.pathname.match(/^\/shorts\/([\w-]{11})/);
    return shorts ? shorts[1] : null;
  }

  let currentFormats = [];

  function startDownload(format, videoTitle) {
    if (!format.url) {
      setStatus('No download URL available', 'error');
      return;
    }
    // Video-only stream: auto-pair the best audio track and merge into one file
    if (YTDl.isVideoFormat(format) && !YTDl.hasAudio(format)) {
      const audio = YTDl.dedupeSort(currentFormats).audio[0];
      if (audio && audio.url) {
        downloadYouTubeMerged(format, audio, videoTitle);
        return;
      }
    }
    const filename = YTDl.buildFilename(format, videoTitle);
    rateLimitedDownload(format.url, filename, DEFAULT_RATE_LIMIT);
  }

  function createFormatItem(format, videoTitle) {
    const item = document.createElement('div');
    item.className = 'ytdl-format-item';

    const isVideo = YTDl.isVideoFormat(format);
    const isAudio = YTDl.isAudioFormat(format);
    const type = isVideo ? 'VIDEO' : (isAudio ? 'AUDIO' : 'MEDIA');
    const quality = format.qualityLabel || format.quality || '';
    const size = format.contentLength ? YTDl.formatBytes(parseInt(format.contentLength)) : '';
    const videoOnly = isVideo && !YTDl.hasAudio(format);

    // Build with textContent — format metadata must never be parsed as HTML
    const info = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'ytdl-format-label';
    label.textContent = quality || type;
    const typeLine = document.createElement('div');
    typeLine.className = 'ytdl-format-type';
    const codec = YTDl.codecLabel(format);
    typeLine.textContent = type + ' ' + YTDl.mimeSubtype(format) + (codec ? ' · ' + codec : '') + (videoOnly ? ' · AUTO-MERGE' : '');
    info.appendChild(label);
    info.appendChild(typeLine);

    const sizeEl = document.createElement('div');
    sizeEl.className = 'ytdl-format-size';
    sizeEl.textContent = size;

    item.appendChild(info);
    item.appendChild(sizeEl);

    if (videoOnly) {
      item.title = 'Video-only stream: the best audio track is downloaded and merged into one MP4 automatically.';
    }

    item.addEventListener('click', () => startDownload(format, videoTitle));
    return item;
  }

  function showFormats(formats, videoTitle) {
    currentFormats = formats || [];
    const body = panel.querySelector('.ytdl-panel-body');
    body.innerHTML = '';

    const { video, audio } = YTDl.dedupeSort(formats);

    if (video.length === 0 && audio.length === 0) {
      body.innerHTML = '<div class="ytdl-error">No downloadable formats found. YouTube may be using SABR streaming.</div>';
      return;
    }

    if (video.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;font-weight:600;color:#888;margin-bottom:8px;text-transform:uppercase;';
      header.textContent = 'Video Formats (rate-limited)';
      body.appendChild(header);
      for (const f of video) {
        body.appendChild(createFormatItem(f, videoTitle));
      }
    }

    if (audio.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;font-weight:600;color:#888;margin:12px 0 8px;text-transform:uppercase;';
      header.textContent = 'Audio Formats';
      body.appendChild(header);
      for (const f of audio) {
        body.appendChild(createFormatItem(f, videoTitle));
      }
    }
  }

  async function loadFormats() {
    const videoId = getVideoId();
    if (!videoId) {
      setStatus('Not a video page', 'error');
      return;
    }

    if (videoId === currentVideoId && panel.querySelector('.ytdl-format-item')) {
      return;
    }
    currentVideoId = videoId;

    const body = panel.querySelector('.ytdl-panel-body');
    body.innerHTML = '<div class="ytdl-loading"><div class="ytdl-spinner"></div><div>Loading formats...</div></div>';

    // Primary: InnerTube API via background (direct, unthrottled URLs)
    const response = await sendMessage({ action: 'getFormats', videoId: videoId });
    if (response && response.success) {
      showFormats(response.formats, response.title);
      return;
    }

    // Fallback: live player response from the page's main world
    const pageResponse = await sendMessage({ action: 'getPlayerResponse' });
    if (pageResponse && pageResponse.success && pageResponse.playerResponse.streamingData) {
      const pr = pageResponse.playerResponse;
      const formats = [
        ...(pr.streamingData.formats || []),
        ...(pr.streamingData.adaptiveFormats || [])
      ].filter(f => f.url);
      const title = (pr.videoDetails && pr.videoDetails.title) || 'video';
      if (formats.length > 0) {
        showFormats(formats, title);
        return;
      }
    }

    body.innerHTML = '<div class="ytdl-error">Could not load formats. Try refreshing the page.</div>';
    setStatus(response ? response.error : 'Unknown error', 'error');
  }

  function addDownloadButton() {
    const existing = document.querySelector('.ytdl-download-btn');
    if (existing) existing.remove();

    const actionsContainer = document.querySelector('#top-row #actions, #menu-container, ytd-video-primary-info-renderer #top-row');
    if (!actionsContainer) return;

    const btn = document.createElement('button');
    btn.className = 'ytdl-download-btn';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      <span>Download</span>
    `;
    btn.addEventListener('click', () => {
      createPanel();
      panel.classList.toggle('visible');
      if (panel.classList.contains('visible')) {
        loadFormats();
      }
    });

    const menu = actionsContainer.querySelector('#menu, ytd-menu-renderer');
    if (menu) {
      actionsContainer.insertBefore(btn, menu);
    } else {
      actionsContainer.appendChild(btn);
    }
  }

  // ---------------- Page observation ----------------

  function observePage() {
    // Debounced: pages mutate the DOM constantly; queue at most one check
    let pending = null;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        scheduleScan();
        if (IS_TOP && IS_YT && getVideoId() && !document.querySelector('.ytdl-download-btn')) {
          addDownloadButton();
        }
      }, 1000);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (IS_TOP && IS_YT) {
      // SPA navigation: invalidate cached formats and re-add the button
      document.addEventListener('yt-navigate-finish', () => {
        currentVideoId = null;
        if (getVideoId()) {
          setTimeout(addDownloadButton, 500);
          if (panel && panel.classList.contains('visible')) {
            loadFormats();
          }
        }
      });
    }
  }

  // ---------------- Messages ----------------

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'downloadMedia') {
      if (!IS_TOP) return;
      handleDownloadMedia(request.item);
      sendResponse({ started: true });
      return false;
    }
    if (request.action === 'downloadFormat') {
      // YouTube format chosen in the popup; confirm in-page for the picker gesture
      if (!IS_TOP) return;
      createPanel();
      panel.classList.add('visible');
      const f = request.format;
      const label = (f.qualityLabel || f.quality || 'media') + ' ' + YTDl.mimeSubtype(f);
      showConfirmation('Save ' + label, 'Click to choose a save location', () => {
        startDownload(f, request.title);
      });
      sendResponse({ started: true });
      return false;
    }
    if (request.action === 'rescan') {
      scanDom();
      if (IS_TOP) sendResponse({ ok: true });
      return false;
    }
  });

  // ---------------- Init ----------------

  function init() {
    if (IS_TOP) createPanel();
    if (IS_TOP && IS_YT && getVideoId()) {
      setTimeout(addDownloadButton, 1500);
    }
    observePage();
    scheduleScan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();