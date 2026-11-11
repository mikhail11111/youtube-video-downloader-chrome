// YouTube Downloader Extension - Content Script
// Injected into YouTube pages to add download button

(function() {
  'use strict';

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
      // Try to get from ytInitialPlayerResponse
      if (window.ytInitialPlayerResponse) {
        return window.ytInitialPlayerResponse;
      }
      // Try to find in scripts
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

  // Format bytes to human readable
  function formatBytes(bytes) {
    if (!bytes) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
  }

  // Get download URL for a format
  function getFormatUrl(format) {
    return format.url || null;
  }

  // Create format item element
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

    item.addEventListener('click', () => {
      const url = getFormatUrl(format);
      if (url) {
        downloadFile(url, videoTitle, format);
      } else {
        setStatus('No download URL available for this format', 'error');
      }
    });

    return item;
  }

  // Download file using Chrome downloads API
  function downloadFile(url, title, format) {
    setStatus('Starting download...', '');
    chrome.runtime.sendMessage({
      action: 'download',
      url: url,
      filename: sanitizeFilename(title) + '_' + (format.qualityLabel || format.quality || 'video') + '.mp4',
      headers: {
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com'
      }
    }, (response) => {
      if (response && response.success) {
        setStatus('Download started!', 'success');
      } else {
        setStatus('Download failed: ' + (response ? response.error : 'Unknown error'), 'error');
      }
    });
  }

  // Sanitize filename
  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
  }

  // Set status message
  function setStatus(message, type) {
    const status = panel.querySelector('.ytdl-status');
    status.textContent = message;
    status.className = 'ytdl-status' + (type ? ' ytdl-' + type : '');
  }

  // Show formats in panel
  function showFormats(formats, videoTitle) {
    const body = panel.querySelector('.ytdl-panel-body');
    body.innerHTML = '';

    if (!formats || formats.length === 0) {
      body.innerHTML = '<div class="ytdl-error">No downloadable formats found</div>';
      return;
    }

    // Sort: video formats first (by quality desc), then audio
    const videoFormats = formats.filter(f => f.mimeType && f.mimeType.includes('video'));
    const audioFormats = formats.filter(f => f.mimeType && f.mimeType.includes('audio') && !f.mimeType.includes('video'));
    const otherFormats = formats.filter(f => !f.mimeType || (!f.mimeType.includes('video') && !f.mimeType.includes('audio')));

    // Deduplicate video formats by quality
    const seenQualities = new Set();
    const uniqueVideo = [];
    for (const f of videoFormats) {
      const q = f.qualityLabel || f.quality;
      if (!seenQualities.has(q)) {
        seenQualities.add(q);
        uniqueVideo.push(f);
      }
    }

    // Sort video by resolution (higher first)
    uniqueVideo.sort((a, b) => {
      const getRes = (f) => {
        const m = (f.qualityLabel || '').match(/(\d+)/);
        return m ? parseInt(m[1]) : 0;
      };
      return getRes(b) - getRes(a);
    });

    // Sort audio by bitrate (higher first)
    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (uniqueVideo.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;font-weight:600;color:#888;margin-bottom:8px;text-transform:uppercase;';
      header.textContent = 'Video Formats';
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

    if (uniqueVideo.length === 0 && audioFormats.length === 0 && otherFormats.length > 0) {
      for (const f of otherFormats) {
        body.appendChild(createFormatItem(f, videoTitle));
      }
    }
  }

  // Load formats for current video
  function loadFormats() {
    const videoId = getVideoId();
    if (!videoId) {
      setStatus('Not a video page', 'error');
      return;
    }

    if (videoId === currentVideoId && panel.querySelector('.ytdl-format-item')) {
      return; // Already loaded
    }
    currentVideoId = videoId;

    const body = panel.querySelector('.ytdl-panel-body');
    body.innerHTML = '<div class="ytdl-loading"><div class="ytdl-spinner"></div><div>Loading formats...</div></div>';

    // Get player response from page
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

    // Fallback: ask background script to fetch
    chrome.runtime.sendMessage({ action: 'getFormats', videoId: videoId }, (response) => {
      if (response && response.success) {
        showFormats(response.formats, response.title);
      } else {
        body.innerHTML = '<div class="ytdl-error">Could not load formats. Try refreshing the page.</div>';
        setStatus(response ? response.error : 'Unknown error', 'error');
      }
    });
  }

  // Add download button to YouTube page
  function addDownloadButton() {
    // Remove existing button
    const existing = document.querySelector('.ytdl-download-btn');
    if (existing) existing.remove();

    // Find the subscribe button or action buttons area
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

    // Insert before the menu or at the end of actions
    const menu = actionsContainer.querySelector('#menu, ytd-menu-renderer');
    if (menu) {
      actionsContainer.insertBefore(btn, menu);
    } else {
      actionsContainer.appendChild(btn);
    }
  }

  // Observe page changes (YouTube is SPA)
  function observePage() {
    const observer = new MutationObserver(() => {
      if (getVideoId() && !document.querySelector('.ytdl-download-btn')) {
        setTimeout(addDownloadButton, 1000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize
  function init() {
    createPanel();
    if (getVideoId()) {
      setTimeout(addDownloadButton, 1500);
    }
    observePage();
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
