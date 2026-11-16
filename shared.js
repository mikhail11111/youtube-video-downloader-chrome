// YouTube Downloader Extension - Shared helpers (popup + content script)

const YTDl = {
  formatBytes(bytes) {
    if (!bytes) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
  },

  sanitizeFilename(name) {
    return (name || 'video').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').substring(0, 100).trim() || 'video';
  },

  isVideoFormat(f) {
    return !!(f.mimeType && f.mimeType.includes('video'));
  },

  isAudioFormat(f) {
    return !!(f.mimeType && f.mimeType.includes('audio') && !f.mimeType.includes('video'));
  },

  // Progressive formats carry audioTracks; adaptive video-only streams do not.
  hasAudio(format) {
    return !!(format.audioTracks && format.audioTracks.length);
  },

  mimeSubtype(format) {
    return format.mimeType ? format.mimeType.split(';')[0].split('/')[1].toUpperCase() : '';
  },

  // H.264 video / AAC audio are the preferred delivery codecs (MP4-compatible)
  isH264(format) {
    return /avc1/i.test(format.mimeType || '');
  },

  codecLabel(format) {
    const m = format.mimeType || '';
    if (/avc1/i.test(m)) return 'H.264';
    if (/hev1|hvc1/i.test(m)) return 'H.265';
    if (/vp09|vp9/i.test(m)) return 'VP9';
    if (/av01/i.test(m)) return 'AV1';
    if (/mp4a/i.test(m)) return 'AAC';
    if (/opus/i.test(m)) return 'Opus';
    if (/vorbis/i.test(m)) return 'Vorbis';
    return '';
  },

  // Derive the real container extension from the MIME type (webm != mp4).
  extFromMime(format) {
    const mime = (format.mimeType || '').split(';')[0];
    const isVideo = this.isVideoFormat(format);
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4')) return isVideo ? 'mp4' : 'm4a';
    return isVideo ? 'mp4' : 'm4a';
  },

  // Dedupe video formats by quality, preferring H.264 and the smallest file
  // at equal quality; sort video by resolution and audio AAC-first by bitrate.
  dedupeSort(formats) {
    const videoFormats = (formats || []).filter(f => this.isVideoFormat(f));
    const audioFormats = (formats || []).filter(f => this.isAudioFormat(f));

    const byQuality = new Map();
    for (const f of videoFormats) {
      const q = f.qualityLabel || f.quality;
      const cur = byQuality.get(q);
      if (!cur) { byQuality.set(q, f); continue; }
      const rank = x => (this.isH264(x) ? 0 : 1);
      const size = x => parseInt(x.contentLength || '0') || Infinity;
      if (rank(f) < rank(cur) || (rank(f) === rank(cur) && size(f) < size(cur))) {
        byQuality.set(q, f);
      }
    }
    const uniqueVideo = [...byQuality.values()];

    const getRes = (f) => {
      const m = (f.qualityLabel || '').match(/(\d+)/);
      return m ? parseInt(m[1]) : 0;
    };
    uniqueVideo.sort((a, b) => getRes(b) - getRes(a));
    const aacRank = f => (/mp4a/i.test(f.mimeType || '') ? 0 : 1);
    audioFormats.sort((a, b) => (aacRank(a) - aacRank(b)) || ((b.bitrate || 0) - (a.bitrate || 0)));

    return { video: uniqueVideo, audio: audioFormats };
  },

  buildFilename(format, videoTitle) {
    const quality = format.qualityLabel || format.quality || 'video';
    return this.sanitizeFilename(videoTitle) + '_' + quality + '.' + this.extFromMime(format);
  },

  // Classify a request URL as media: file | hls | dash | segment | null
  classifyMediaUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    if (path.endsWith('.m3u8')) return 'hls';
    if (path.endsWith('.mpd')) return 'dash';
    if (/\.(ts|m4s|m4f)$/.test(path)) return 'segment';
    // Stream fragments: numbered chunk paths, range/sequence params, YouTube CDN
    if (/(seg|segment|fragment|chunk|frag)[-_/.]?\d/.test(path)) return 'segment';
    if (/[?&](range|sq|rbuf|rn)=/.test(query)) return 'segment';
    if (path.includes('videoplayback')) return 'segment';
    if (/\.(mp4|m4v|webm|mkv|mov|avi|flv|m4a|mp3|ogg|wav)$/.test(path)) return 'file';
    return null;
  },

  // Classify by response Content-Type (catches extension-less media URLs)
  kindFromMime(mime) {
    const m = (mime || '').split(';')[0].trim().toLowerCase();
    if (['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(m)) return 'hls';
    if (m === 'application/dash+xml') return 'dash';
    if (m === 'video/mp2t') return 'segment';
    if (m.startsWith('video/') || m.startsWith('audio/')) return 'file';
    return null;
  },

  bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  },

  base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },

  // Fetch media bytes. Direct fetch first (HLS/DASH CDNs usually send CORS
  // headers for hls.js/dash.js); on CORS/network failure fall back to the
  // background service worker, which fetches with host permissions.
  async fetchBytes(url, signal, headers) {
    try {
      const response = await fetch(url, { credentials: 'include', signal: signal, headers: headers });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) throw e;
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'fetchProxy', url: url, headers: headers }, r => {
          void chrome.runtime.lastError;
          resolve(r);
        });
      });
      if (!resp || !resp.success) throw new Error(resp ? resp.error : 'Fetch failed: ' + url);
      return this.base64ToBytes(resp.data);
    }
  }
};