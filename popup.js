// YouTube Downloader - Popup Script
// Supports rate-limited downloads to bypass YouTube throttling

const DEFAULT_RATE_LIMIT = 500 * 1024; // 500 KB/s

document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('status');
  const videoInfo = document.getElementById('video-info');
  const videoTitle = document.getElementById('video-title');
  const videoFormats = document.getElementById('video-formats');
  const audioFormats = document.getElementById('audio-formats');
  const loading = document.getElementById('loading');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
    status.textContent = 'Navigate to a YouTube video page';
    return;
  }

  const videoId = new URL(tab.url).searchParams.get('v');
  if (!videoId) {
    status.textContent = 'No video ID found';
    return;
  }

  status.style.display = 'none';
  loading.style.display = 'block';

  chrome.runtime.sendMessage({ action: 'getFormats', videoId: videoId }, (response) => {
    loading.style.display = 'none';

    if (!response || !response.success) {
      status.style.display = 'block';
      status.textContent = response ? response.error : 'Failed to load formats';
      status.className = 'status error-msg';
      return;
    }

    videoTitle.textContent = response.title;
    videoInfo.style.display = 'block';

    const formats = response.formats || [];
    const videoFmt = formats.filter(f => f.mimeType && f.mimeType.includes('video'));
    const audioFmt = formats.filter(f => f.mimeType && f.mimeType.includes('audio') && !f.mimeType.includes('video'));

    const seenQ = new Set();
    const uniqueVideo = [];
    for (const f of videoFmt) {
      const q = f.qualityLabel || f.quality;
      if (!seenQ.has(q)) {
        seenQ.add(q);
        uniqueVideo.push(f);
      }
    }
    uniqueVideo.sort((a, b) => {
      const getRes = (f) => { const m = (f.qualityLabel || '').match(/(\d+)/); return m ? parseInt(m[1]) : 0; };
      return getRes(b) - getRes(a);
    });

    audioFmt.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    function formatBytes(bytes) {
      if (!bytes) return '';
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
    }

    function sanitizeFilename(name) {
      return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    }

    function showStatus(msg, type) {
      status.style.display = 'block';
      status.textContent = msg;
      status.className = 'status ' + (type === 'success' ? 'success-msg' : 'error-msg');
    }

    async function rateLimitedDownload(url, filename) {
      try {
        showStatus('Starting download...', '');

        const response = await fetch(url, {
          credentials: 'include',
          headers: {
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const totalBytes = parseInt(response.headers.get('Content-Length') || '0');

        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Media file', accept: { 'video/*': ['.mp4', '.webm', '.m4a', '.mp3'] } }]
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

          const delay = (value.length / DEFAULT_RATE_LIMIT) * 1000;
          if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? (downloadedBytes / elapsed / 1024).toFixed(0) + ' KB/s' : '';
          showStatus(`Downloading... ${progress}% (${formatBytes(downloadedBytes)}${totalBytes ? '/' + formatBytes(totalBytes) : ''}) ${speed}`, '');
        }

        await writable.close();
        showStatus(`Download complete! (${formatBytes(downloadedBytes)})`, 'success');
      } catch (e) {
        if (e.name === 'AbortError' || e.name === 'NotAllowedError') {
          showStatus('Cancelled', '');
        } else {
          showStatus('Failed: ' + e.message, 'error');
        }
      }
    }

    function createBtn(format, title) {
      const btn = document.createElement('button');
      btn.className = 'format-btn';
      const quality = format.qualityLabel || format.quality || 'Unknown';
      const type = format.mimeType ? format.mimeType.split(';')[0].split('/')[1].toUpperCase() : '';
      const size = format.contentLength ? formatBytes(parseInt(format.contentLength)) : '';
      btn.innerHTML = `
        <span class="format-label">${quality}</span>
        <span class="format-type">${type}</span>
        <span class="format-size">${size}</span>
      `;
      btn.addEventListener('click', async () => {
        const isVideo = format.mimeType && format.mimeType.includes('video');
        const isAudio = format.mimeType && format.mimeType.includes('audio');
        const ext = isVideo ? 'mp4' : (isAudio ? 'm4a' : 'mp4');
        const filename = sanitizeFilename(title) + '_' + quality + '.' + ext;
        await rateLimitedDownload(format.url, filename);
      });
      return btn;
    }

    if (uniqueVideo.length > 0) {
      for (const f of uniqueVideo) {
        videoFormats.appendChild(createBtn(f, response.title));
      }
    } else {
      videoFormats.innerHTML = '<div class="error-msg">No video formats</div>';
    }

    if (audioFmt.length > 0) {
      for (const f of audioFmt) {
        audioFormats.appendChild(createBtn(f, response.title));
      }
    } else {
      audioFormats.innerHTML = '<div class="error-msg">No audio formats</div>';
    }
  });
});
