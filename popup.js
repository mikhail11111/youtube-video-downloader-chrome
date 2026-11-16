// Video Downloader - Popup Script
// YouTube watch pages: InnerTube format list.
// Other sites: media detected by network sniffing + DOM scan.
// Downloads are delegated to the content script so they keep running
// when the popup closes.

document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('status');
  const videoInfo = document.getElementById('video-info');
  const videoTitle = document.getElementById('video-title');
  const videoFormats = document.getElementById('video-formats');
  const audioFormats = document.getElementById('audio-formats');
  const detectedInfo = document.getElementById('detected-info');
  const detectedList = document.getElementById('detected-list');
  const rescanBtn = document.getElementById('rescan-btn');
  const loading = document.getElementById('loading');

  function showStatus(msg, type) {
    status.style.display = 'block';
    status.textContent = msg;
    status.className = 'status' + (type === 'success' ? ' success-msg' : type === 'error' ? ' error-msg' : '');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    showStatus('Open a page with a video to detect media', '');
    return;
  }

  const videoId = /youtube\.com\/watch/i.test(tab.url) ? new URL(tab.url).searchParams.get('v') : null;

  if (videoId) {
    loadYouTubeFormats(videoId);
  } else {
    rescanBtn.style.display = 'block';
    rescanBtn.addEventListener('click', () => {
      rescanBtn.disabled = true;
      chrome.tabs.sendMessage(tab.id, { action: 'rescan' }, () => {
        void chrome.runtime.lastError;
        setTimeout(() => {
          rescanBtn.disabled = false;
          loadDetected();
        }, 1600);
      });
    });
    loadDetected();
  }

  // ---------------- Generic sites ----------------

  function loadDetected() {
    status.style.display = 'none';
    detectedInfo.style.display = 'none';
    loading.style.display = 'block';

    chrome.runtime.sendMessage({ action: 'getDetected', tabId: tab.id }, (response) => {
      loading.style.display = 'none';
      const items = (response && response.items) || [];
      const hasStream = items.some(i => i.kind === 'hls' || i.kind === 'dash');
      // Fragments are parts of a stream, never standalone downloads
      const files = items.filter(i => i.kind !== 'segment');
      const segments = items.filter(i => i.kind === 'segment');
      const order = { hls: 0, dash: 1, file: 2 };
      files.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.ts - a.ts));

      if (files.length === 0 && segments.length === 0) {
        const hint = response && response.hasBlob
          ? 'This page plays video via MSE. Press play, wait a few seconds, then rescan.'
          : 'No media detected yet. Play the video, then rescan or reopen this popup.';
        showStatus(hint, '');
        return;
      }

      detectedList.innerHTML = '';
      for (const item of files) {
        detectedList.appendChild(createMediaBtn(item));
      }
      if (segments.length > 0) {
        const note = document.createElement('div');
        note.className = 'fragment-note';
        note.textContent = hasStream
          ? segments.length + ' stream fragments belong to the playlist(s) above - download the playlist, not the fragments.'
          : segments.length + ' stream fragments detected, but no playlist was captured. Reload the page, play the video from the start, then rescan.';
        detectedList.appendChild(note);
      }
      detectedInfo.style.display = 'block';
    });
  }

  function createMediaBtn(item) {
    const btn = document.createElement('button');
    btn.className = 'format-btn media-btn';

    const badge = document.createElement('span');
    badge.className = 'kind-badge kind-' + item.kind;
    badge.textContent = item.kind === 'hls' ? 'HLS' : item.kind === 'dash' ? 'DASH' : item.kind === 'segment' ? 'SEG' : 'FILE';

    const label = document.createElement('span');
    label.className = 'format-label media-label';
    let name = '';
    try {
      const u = new URL(item.url);
      name = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    } catch (e) { name = item.url; }
    label.textContent = name.length > 40 ? name.substring(0, 37) + '...' : name;
    label.title = item.url;

    const meta = document.createElement('span');
    meta.className = 'format-size';
    let host = '';
    try { host = new URL(item.url).hostname; } catch (e) {}
    meta.textContent = (item.size ? YTDl.formatBytes(item.size) + ' - ' : '') + host;

    btn.appendChild(badge);
    btn.appendChild(label);
    btn.appendChild(meta);

    btn.addEventListener('click', () => {
      chrome.tabs.sendMessage(tab.id, { action: 'downloadMedia', item: item }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.started) {
          showStatus('Could not reach the page. Refresh the tab and try again.', 'error');
          return;
        }
        showStatus('Confirm the save in the page panel. You can close this popup.', 'success');
      });
    });
    return btn;
  }

  // ---------------- YouTube ----------------

  function loadYouTubeFormats(videoId) {
    status.style.display = 'none';
    loading.style.display = 'block';

    chrome.runtime.sendMessage({ action: 'getFormats', videoId: videoId }, (response) => {
      loading.style.display = 'none';

      if (!response || !response.success) {
        showStatus(response ? response.error : 'Failed to load formats', 'error');
        return;
      }

      videoTitle.textContent = response.title;
      videoInfo.style.display = 'block';

      const { video, audio } = YTDl.dedupeSort(response.formats);

      function createBtn(format, title) {
        const btn = document.createElement('button');
        btn.className = 'format-btn';
        const quality = format.qualityLabel || format.quality || 'Unknown';
        const isVideo = YTDl.isVideoFormat(format);
        const videoOnly = isVideo && !YTDl.hasAudio(format);
        const size = format.contentLength ? YTDl.formatBytes(parseInt(format.contentLength)) : '';

        // Build with textContent — format metadata must never be parsed as HTML
        const label = document.createElement('span');
        label.className = 'format-label';
        label.textContent = quality;
        const type = document.createElement('span');
        type.className = 'format-type';
        const codec = YTDl.codecLabel(format);
        type.textContent = YTDl.mimeSubtype(format) + (codec ? ' · ' + codec : '') + (videoOnly ? ' · AUTO-MERGE' : '');
        const sizeEl = document.createElement('span');
        sizeEl.className = 'format-size';
        sizeEl.textContent = size;
        btn.appendChild(label);
        btn.appendChild(type);
        btn.appendChild(sizeEl);

        if (videoOnly) {
          btn.title = 'Video-only stream: the best audio track is downloaded and merged into one MP4 automatically.';
        }

        btn.addEventListener('click', () => {
          // Run the download in the page's content script, not in this popup
          chrome.tabs.sendMessage(tab.id, { action: 'downloadFormat', format: format, title: title }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.started) {
              showStatus('Could not reach the page. Refresh the YouTube tab and try again.', 'error');
              return;
            }
            showStatus('Confirm the save in the page panel. You can close this popup.', 'success');
          });
        });
        return btn;
      }

      if (video.length > 0) {
        for (const f of video) {
          videoFormats.appendChild(createBtn(f, response.title));
        }
      } else {
        videoFormats.innerHTML = '<div class="error-msg">No video formats</div>';
      }

      if (audio.length > 0) {
        for (const f of audio) {
          audioFormats.appendChild(createBtn(f, response.title));
        }
      } else {
        audioFormats.innerHTML = '<div class="error-msg">No audio formats</div>';
      }
    });
  }
});