// YouTube Downloader - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('status');
  const videoInfo = document.getElementById('video-info');
  const videoTitle = document.getElementById('video-title');
  const videoFormats = document.getElementById('video-formats');
  const audioFormats = document.getElementById('audio-formats');
  const loading = document.getElementById('loading');

  // Get current tab
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

  // Show loading
  status.style.display = 'none';
  loading.style.display = 'block';

  // Get formats from background
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

    // Deduplicate video by quality
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

    // Sort audio by bitrate
    audioFmt.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    function formatBytes(bytes) {
      if (!bytes) return '';
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
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
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          action: 'download',
          url: format.url,
          filename: sanitizeFilename(title) + '_' + quality + '.mp4'
        }, (resp) => {
          if (resp && resp.success) {
            showStatus('Download started!', 'success');
          } else {
            showStatus('Failed: ' + (resp ? resp.error : 'Unknown'), 'error');
          }
        });
      });
      return btn;
    }

    function sanitizeFilename(name) {
      return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    }

    function showStatus(msg, type) {
      status.style.display = 'block';
      status.textContent = msg;
      status.className = 'status ' + (type === 'success' ? 'success-msg' : 'error-msg');
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
