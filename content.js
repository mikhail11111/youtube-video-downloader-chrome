// YouTube Downloader Extension - Content Script
// Injected into YouTube pages to add download button
// Supports rate-limited downloads to bypass YouTube throttling

(function() {
  'use strict';

  const DEFAULT_RATE_LIMIT = 500 * 1024; // 500 KB/s

  let panel = null;
  let currentVideoId = null;

  // Create the download panel
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
      <div class="ytdl-status"></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.ytdl-panel-close').addEventListener('click', () => {
      panel.classList.remove('visible');
    });

    return panel;
  }

  // Get video ID from URL
  function getVideoId() {
    const url = new URL(window.location.href);
    return url.searchParams.get('v');
  }

  // Extract player response from page
  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse) {
        return window.ytInitialPlayerResponse;
      }
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        if (match) {
          try {
            return JSON.parse(match[1]);
          } catch (e) {}
        }
      }
    } catch (e) {
      console.error('YTDl: Error getting player response:', e);
    }
    return null;
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
  }

  function setStatus(message, type) {
    const status = panel.querySelector('.ytdl-status');
    status.textContent = message;
    status.className = 'ytdl-status' + (type ? ' ytdl-' + type : '');
  }

  // Rate-limited download using fetch + ReadableStream + File System Access API
  async function rateLimitedDownload(url, filename, rateLimit) {
    rateLimit = rateLimit || DEFAULT_RATE_LIMIT;
    try {
      setStatus('Starting download...', '');

      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          'Referer': 'https://www.youtube.com/',
          'Origin': 'https://www.youtube.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = response.headers.get('Content-Length');
      const totalBytes = contentLength ? parseInt(contentLength) : 0;

      // Ask user where to save (requires user gesture — we have it from click)
      const handle = await window.showSaveFilePicker({
        suggestedName: filename || 'video.mp4',
        types: [{
          description: 'Media file',
          accept: { 'video/*': ['.mp4', '.webm', '.m4a', '.mp3', '.mkv'] }
        }]
      });

      const writable = await handle.createWritable();
      const reader = response.body.getReader();

      let downloadedBytes = 0;
      const startTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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
        setStatus(`Downloading... ${progress}% (${formatBytes(downloadedBytes)}${totalBytes ? '/' + formatBytes(totalBytes) : ''}) ${speed}`, '');
      }

      await writable.close();

      setStatus(`Download complete! (${formatBytes(downloadedBytes)})`, 'success');
      return { success: true, downloaded: downloadedBytes };
    } catch (e) {
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
    }
  }

  function createFormatItem(format, videoTitle) {
    const item = document.createElement('div');
    item.className = 'ytdl-format-item';

    const isVideo = format.mimeType && format.mimeType.includes('video');
    const isAudio = format.mimeType && format.mimeType.includes('audio');
    const type = isVideo ? 'VIDEO' : (isAudio ? 'AUDIO' : 'MEDIA');
    const quality = format.qualityLabel || format.quality || '';
    const size = format.contentLength ? formatBytes(parseInt(format.contentLength)) : '';

    item.innerHTML = `
      <div>
        <div class="ytdl-format-label">${quality || type}</div>
        <div class="ytdl-format-type">${type} ${format.mimeType ? format.mimeType.split(';')[0].split('/')[1].toUpperCase() : ''}</div>
      </div>
      <div class="ytdl-format-size">${size}</div>
    `;

    item.addEventListener('click', async () => {
      const url = format.url;
      if (!url) {
        setStatus('No download URL available', 'error');
        return;
      }

      const ext = isVideo ? 'mp4' : (isAudio ? 'm4a' : 'mp4');
      const filename = sanitizeFilename(videoTitle) + '_' + (quality || 'video') + '.' + ext;

      await rateLimitedDownload(url, filename, DEFAULT_RATE_LIMIT);
    });

    return item;
  }

  function showFormats(formats, videoTitle) {
    const body = panel.querySelector('.ytdl-panel-body');
    body.innerHTML = '';

    if (!formats || formats.length === 0) {
      body.innerHTML = '<div class="ytdl-error">No downloadable formats found</div>';
      return;
    }

    const videoFormats = formats.filter(f => f.mimeType && f.mimeType.includes('video'));
    const audioFormats = formats.filter(f => f.mimeType && f.mimeType.includes('audio') && !f.mimeType.includes('video'));

    const seenQualities = new Set();
    const uniqueVideo = [];
    for (const f of videoFormats) {
      const q = f.qualityLabel || f.quality;
      if (!seenQualities.has(q)) {
        seenQualities.add(q);
        uniqueVideo.push(f);
      }
    }

    uniqueVideo.sort((a, b) => {
      const getRes = (f) => {
        const m = (f.qualityLabel || '').match(/(\d+)/);
        return m ? parseInt(m[1]) : 0;
      };
      return getRes(b) - getRes(a);
    });

    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (uniqueVideo.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;font-weight:600;color:#888;margin-bottom:8px;text-transform:uppercase;';
      header.textContent = 'Video Formats (rate-limited)';
      body.appendChild(header);
      for (const f of uniqueVideo) {
        body.appendChild(createFormatItem(f, videoTitle));
      }
    }

    if (audioFormats.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;font-weight:600;color:#888;margin:12px 0 8px;text-transform:uppercase;';
      header.textContent = 'Audio Formats';
      body.appendChild(header);
      for (const f of audioFormats) {
        body.appendChild(createFormatItem(f, videoTitle));
      }
    }

    if (uniqueVideo.length === 0 && audioFormats.length === 0) {
      body.innerHTML = '<div class="ytdl-error">No downloadable formats found. YouTube may be using SABR streaming.</div>';
    }
  }

  function loadFormats() {
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

    const playerResponse = getPlayerResponse();
    if (playerResponse && playerResponse.streamingData) {
      const formats = [
        ...(playerResponse.streamingData.formats || []),
        ...(playerResponse.streamingData.adaptiveFormats || [])
      ];
      const title = (playerResponse.videoDetails && playerResponse.videoDetails.title) || 'video';
      showFormats(formats, title);
      return;
    }

    // Fallback: fetch from background
    chrome.runtime.sendMessage({ action: 'getFormats', videoId: videoId }, (response) => {
      if (response && response.success) {
        showFormats(response.formats, response.title);
      } else {
        body.innerHTML = '<div class="ytdl-error">Could not load formats. Try refreshing the page.</div>';
        setStatus(response ? response.error : 'Unknown error', 'error');
      }
    });
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

  function observePage() {
    const observer = new MutationObserver(() => {
      if (getVideoId() && !document.querySelector('.ytdl-download-btn')) {
        setTimeout(addDownloadButton, 1000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    createPanel();
    if (getVideoId()) {
      setTimeout(addDownloadButton, 1500);
    }
    observePage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
