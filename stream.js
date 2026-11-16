// Video Downloader Extension - Stream engine (content-side)
// Parses and downloads HLS (.m3u8) and DASH (.mpd) streams by fetching
// segments and concatenating them. DRM-protected streams are rejected.
//
// Callbacks provided by the content script:
//   opts.signal          AbortSignal for cancellation
//   opts.baseName        sanitized filename base (no extension)
//   opts.onStatus(msg, type)             progress reporting
//   opts.chooseVariant(variants) -> Promise<variant>   HLS quality picker
//   opts.openFile(suggestedName, ext) -> Promise<writable>  (user gesture!)
//   opts.merge(videoBytes, audioBytes, videoExt, audioExt) -> Promise<bytes>
//                                        single-file merge via ffmpeg.wasm

const YTStream = (() => {
  'use strict';

  const decoder = new TextDecoder();

  function absUrl(base, rel) {
    return new URL(rel, base).href;
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  async function fetchText(url, signal) {
    return decoder.decode(await YTDl.fetchBytes(url, signal));
  }

  function concatChunks(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // In-memory sink with the same write() interface as a file writable
  function memorySink() {
    const chunks = [];
    return {
      write: async (b) => { chunks.push(new Uint8Array(b)); },
      bytes: () => concatChunks(chunks)
    };
  }

  // ---------------- HLS ----------------

  // Parse an HLS attribute list: KEY=VALUE,KEY2="quoted value"
  function parseAttributes(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    return attrs;
  }

  function parseMaster(text, baseUrl) {
    const variants = [];
    const renditions = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith('#')) { uri = next; i = j; break; }
        }
        if (uri) {
          variants.push({
            url: absUrl(baseUrl, uri),
            bandwidth: parseInt(attrs.BANDWIDTH || '0'),
            resolution: attrs.RESOLUTION || '',
            codecs: attrs.CODECS || '',
            audioGroup: attrs.AUDIO || ''
          });
        }
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
        if (attrs.TYPE === 'AUDIO' && attrs.URI) {
          renditions.push({
            groupId: attrs['GROUP-ID'] || '',
            name: attrs.NAME || 'audio',
            url: absUrl(baseUrl, attrs.URI)
          });
        }
      }
    }
    // H.264 first, then highest bandwidth
    const avcRank = v => (/avc1/i.test(v.codecs) ? 0 : 1);
    variants.sort((a, b) => (avcRank(a) - avcRank(b)) || (b.bandwidth - a.bandwidth));
    return { variants: variants, renditions: renditions };
  }

  function parseMediaPlaylist(text, baseUrl) {
    const segments = [];
    let initUrl = null;
    let initRange = null;
    let key = null;
    let mediaSequence = 0;
    let pendingDuration = 0;
    let pendingRange = null;
    let lastEnd = 0;
    let lastUrl = null;
    const parseRange = (v, fallbackOffset) => {
      const m = /^(\d+)(?:@(\d+))?$/.exec((v || '').trim());
      if (!m) return null;
      return { length: parseInt(m[1]), offset: m[2] != null ? parseInt(m[2]) : fallbackOffset };
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1]) || 0;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) {
          initUrl = absUrl(baseUrl, attrs.URI);
          initRange = parseRange(attrs.BYTERANGE, 0);
        }
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
        key = attrs.METHOD === 'NONE' ? null : {
          method: attrs.METHOD,
          uri: attrs.URI ? absUrl(baseUrl, attrs.URI) : null,
          iv: attrs.IV || null
        };
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      } else if (!line.startsWith('#')) {
        const url = absUrl(baseUrl, line);
        // Omitted @offset continues right after the previous range of the same file
        const fallback = url === lastUrl ? lastEnd : 0;
        const range = parseRange(pendingRange, fallback);
        segments.push({ url: url, duration: pendingDuration, key: key, range: range });
        if (range) { lastEnd = range.offset + range.length; lastUrl = url; }
        pendingDuration = 0;
        pendingRange = null;
      }
    }
    return { segments: segments, initUrl: initUrl, initRange: initRange, mediaSequence: mediaSequence };
  }

  const hlsKeyCache = new Map();

  async function decryptSegment(bytes, keyInfo, seqNumber, signal) {
    if (!keyInfo) return bytes;
    if (keyInfo.method !== 'AES-128') {
      throw new Error('Unsupported HLS encryption: ' + keyInfo.method + ' (DRM)');
    }
    let keyBytes = hlsKeyCache.get(keyInfo.uri);
    if (!keyBytes) {
      keyBytes = await YTDl.fetchBytes(keyInfo.uri, signal);
      hlsKeyCache.set(keyInfo.uri, keyBytes);
    }
    const iv = new Uint8Array(16);
    if (keyInfo.iv) {
      const hex = keyInfo.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      // Default IV = media sequence number as 128-bit big-endian
      new DataView(iv.buffer).setUint32(12, seqNumber >>> 0);
    }
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, cryptoKey, bytes);
    return new Uint8Array(plain);
  }

  // Byte-range playlists (one big file per track) are fetched in coalesced
  // ~8 MiB Range requests instead of one request per tiny segment
  const RANGE_BATCH = 8 * 1024 * 1024;

  function rangeHeaders(range) {
    return range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
  }

  // Write init + all segments of a parsed media playlist; returns byte count
  async function writeSegments(parsed, writable, opts) {
    const { signal, onStatus } = opts;
    let bytes = 0;
    if (parsed.initUrl) {
      const init = await YTDl.fetchBytes(parsed.initUrl, signal, rangeHeaders(parsed.initRange));
      await writable.write(init);
      bytes += init.length;
    }
    let i = 0;
    while (i < parsed.segments.length) {
      checkAbort(signal);
      const seg = parsed.segments[i];
      let data;
      if (seg.range) {
        // Coalesce consecutive ranges of the same file into one request
        let end = seg.range.offset + seg.range.length;
        let j = i + 1;
        while (j < parsed.segments.length) {
          const nxt = parsed.segments[j];
          if (nxt.url !== seg.url || !nxt.range || nxt.range.offset !== end ||
              end - seg.range.offset + nxt.range.length > RANGE_BATCH) break;
          end += nxt.range.length;
          j++;
        }
        const batch = { offset: seg.range.offset, length: end - seg.range.offset };
        let buf = await YTDl.fetchBytes(seg.url, signal, rangeHeaders(batch));
        // Server ignored Range and sent the whole file: slice absolute offsets
        const fromStart = buf.length > batch.length;
        let off = fromStart ? batch.offset : 0;
        for (let k = i; k < j; k++) {
          const len = parsed.segments[k].range.length;
          let piece = buf.subarray(off, off + len);
          off += len;
          piece = await decryptSegment(piece, parsed.segments[k].key, parsed.mediaSequence + k, signal);
          await writable.write(piece);
          bytes += piece.length;
        }
        onStatus(`Segment ${j}/${parsed.segments.length} (${YTDl.formatBytes(bytes)})`, '');
        i = j;
      } else {
        data = await YTDl.fetchBytes(seg.url, signal);
        data = await decryptSegment(data, seg.key, parsed.mediaSequence + i, signal);
        await writable.write(data);
        bytes += data.length;
        onStatus(`Segment ${i + 1}/${parsed.segments.length} (${YTDl.formatBytes(bytes)})`, '');
        i++;
      }
    }
    return bytes;
  }

  async function savePlaylist(parsed, suggestedName, ext, opts) {
    const writable = await opts.openFile(suggestedName, ext);
    try {
      const bytes = await writeSegments(parsed, writable, opts);
      await writable.close();
      return bytes;
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      throw e;
    }
  }

  async function downloadHls(url, opts) {
    const { signal, onStatus } = opts;
    onStatus('Loading playlist...', '');
    let text = await fetchText(url, signal);
    let playlistUrl = url;
    let audioRendition = null;

    if (text.includes('#EXT-X-STREAM-INF')) {
      const master = parseMaster(text, url);
      if (master.variants.length === 0) throw new Error('No variants in master playlist');
      // Always deliver H.264 when the stream offers it (no transcoding possible)
      const avcVariants = master.variants.filter(v => /avc1/i.test(v.codecs));
      const choices = avcVariants.length > 0 ? avcVariants : master.variants;
      const variant = choices.length === 1 ? choices[0] : await opts.chooseVariant(choices);
      checkAbort(signal);
      playlistUrl = variant.url;
      audioRendition = master.renditions.find(r => r.groupId === variant.audioGroup) || null;
      text = await fetchText(playlistUrl, signal);
    }

    const parsed = parseMediaPlaylist(text, playlistUrl);
    if (parsed.segments.length === 0) throw new Error('Empty playlist');
    const isFmp4 = !!parsed.initUrl || /\.(mp4|m4s|m4f)(\?|$)/i.test(parsed.segments[0].url);
    const ext = isFmp4 ? 'mp4' : 'ts';

    if (audioRendition) {
      // Separate audio rendition: download both tracks to memory and merge
      // into ONE file. Open the picker right after the user's click.
      const writable = await opts.openFile(opts.baseName + '.mp4', 'mp4');
      try {
        const vSink = memorySink();
        await writeSegments(parsed, vSink, opts);
        checkAbort(signal);
        onStatus('Audio track...', '');
        const audioText = await fetchText(audioRendition.url, signal);
        const audioParsed = parseMediaPlaylist(audioText, audioRendition.url);
        if (audioParsed.segments.length === 0) throw new Error('Empty audio playlist');
        const aExt = audioParsed.initUrl ? 'm4a' : (/\.aac(\?|$)/i.test(audioParsed.segments[0].url) ? 'aac' : 'ts');
        const aSink = memorySink();
        await writeSegments(audioParsed, aSink, opts);
        checkAbort(signal);
        const merged = await opts.merge(vSink.bytes(), aSink.bytes(), ext, aExt);
        await writable.write(merged);
        await writable.close();
        onStatus(`Download complete! (${YTDl.formatBytes(merged.length)})`, 'success');
        return { success: true, bytes: merged.length };
      } catch (e) {
        try { await writable.abort(); } catch (_) {}
        throw e;
      }
    }

    const bytes = await savePlaylist(parsed, opts.baseName + '.' + ext, ext, opts);
    onStatus(`Download complete! (${YTDl.formatBytes(bytes)})`, 'success');
    return { success: true, bytes: bytes };
  }

  // ---------------- DASH ----------------

  function findChild(el, name) {
    for (const child of el.children) {
      if (child.localName === name) return child;
    }
    return null;
  }

  function chainBase(parentBase, el) {
    const b = findChild(el, 'BaseURL');
    return b ? absUrl(parentBase, b.textContent.trim()) : parentBase;
  }

  // ISO 8601 duration (e.g. PT1H2M3.5S) -> seconds
  function parseDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(iso || '');
    if (!m) return 0;
    return (parseInt(m[1] || '0') * 86400) + (parseInt(m[2] || '0') * 3600) +
      (parseInt(m[3] || '0') * 60) + parseFloat(m[4] || '0');
  }

  // Build the segment URL list for a Representation.
  // Returns {initUrl, urls} or {fileUrl} for single-file representations.
  function buildSegments(rep, adapt, period, mpd, baseUrl) {
    const tmpl = findChild(rep, 'SegmentTemplate') || findChild(adapt, 'SegmentTemplate');
    const list = findChild(rep, 'SegmentList') || findChild(adapt, 'SegmentList');
    const totalSec = parseDuration(period.getAttribute('duration')) ||
      parseDuration(mpd.getAttribute('mediaPresentationDuration'));

    if (tmpl) {
      const timescale = parseInt(tmpl.getAttribute('timescale') || '1');
      const startNumber = parseInt(tmpl.getAttribute('startNumber') || '1');
      const repId = rep.getAttribute('id') || '';
      const bandwidth = rep.getAttribute('bandwidth') || '';
      const fill = (tpl, num, time) => tpl
        .replace(/\$RepresentationID\$/g, repId)
        .replace(/\$Bandwidth\$/g, bandwidth)
        .replace(/\$Number%(\d+)d\$/g, (_, w) => String(num).padStart(parseInt(w), '0'))
        .replace(/\$Number\$/g, String(num))
        .replace(/\$Time\$/g, String(time));

      const initTpl = tmpl.getAttribute('initialization') || '';
      const mediaTpl = tmpl.getAttribute('media') || '';
      const initUrl = initTpl ? absUrl(baseUrl, fill(initTpl, startNumber, 0)) : null;
      const urls = [];
      const timeline = findChild(tmpl, 'SegmentTimeline');

      if (timeline) {
        let t = 0;
        let num = startNumber;
        for (const s of timeline.children) {
          if (s.localName !== 'S') continue;
          const d = parseInt(s.getAttribute('d'));
          let r = parseInt(s.getAttribute('r') || '0');
          if (s.getAttribute('t')) t = parseInt(s.getAttribute('t'));
          if (r < 0) {
            // r=-1: repeat until the end of the presentation
            r = Math.max(0, Math.ceil((totalSec * timescale - t) / d) - 1);
          }
          for (let k = 0; k <= r; k++) {
            urls.push(absUrl(baseUrl, fill(mediaTpl, num, t)));
            t += d;
            num++;
          }
        }
      } else {
        const segDur = parseInt(tmpl.getAttribute('duration') || '0');
        if (!segDur || !totalSec) throw new Error('Cannot determine DASH segment count');
        const count = Math.ceil(totalSec / (segDur / timescale));
        for (let i = 0; i < count; i++) {
          urls.push(absUrl(baseUrl, fill(mediaTpl, startNumber + i, 0)));
        }
      }
      return { initUrl: initUrl, urls: urls };
    }

    if (list) {
      const initEl = findChild(list, 'Initialization');
      const initUrl = initEl && initEl.getAttribute('sourceURL') ? absUrl(baseUrl, initEl.getAttribute('sourceURL')) : null;
      const urls = [];
      for (const u of list.children) {
        if (u.localName === 'SegmentURL' && u.getAttribute('media')) {
          urls.push(absUrl(baseUrl, u.getAttribute('media')));
        }
      }
      return { initUrl: initUrl, urls: urls };
    }

    // SegmentBase or no segment info: the representation URL is the whole file
    return { fileUrl: baseUrl };
  }

  async function downloadDash(url, opts) {
    const { signal, onStatus } = opts;
    onStatus('Loading MPD...', '');
    const text = await fetchText(url, signal);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') throw new Error('Invalid MPD manifest');
    if (mpd.getElementsByTagName('ContentProtection').length > 0) {
      throw new Error('DRM-protected DASH stream is not supported');
    }
    const period = findChild(mpd, 'Period');
    if (!period) throw new Error('No Period in MPD');

    const mpdBase = chainBase(url, mpd);
    const periodBase = chainBase(mpdBase, period);
    const sets = [...period.children].filter(e => e.localName === 'AdaptationSet');

    const setKind = (set) => {
      const ct = (set.getAttribute('contentType') || set.getAttribute('mimeType') || '').toLowerCase();
      if (ct.includes('video')) return 'video';
      if (ct.includes('audio')) return 'audio';
      const rep = findChild(set, 'Representation');
      const mime = rep ? (rep.getAttribute('mimeType') || '').toLowerCase() : '';
      if (mime.startsWith('video')) return 'video';
      if (mime.startsWith('audio')) return 'audio';
      return null;
    };
    const bestRep = (set) => {
      const reps = [...set.children].filter(e => e.localName === 'Representation');
      const codecOf = r => (r.getAttribute('codecs') || set.getAttribute('codecs') || '').toLowerCase();
      // Prefer H.264 video / AAC audio representations when available
      const preferred = reps.filter(r => /^avc1|^mp4a/.test(codecOf(r)));
      const pool = preferred.length > 0 ? preferred : reps;
      return pool.sort((a, b) => parseInt(b.getAttribute('bandwidth') || '0') - parseInt(a.getAttribute('bandwidth') || '0'))[0];
    };

    const videoSets = sets.filter(s => setKind(s) === 'video');
    const audioSets = sets.filter(s => setKind(s) === 'audio');
    const videoSet = videoSets.find(s => /avc1/i.test(s.getAttribute('codecs') || '')) || videoSets[0];
    const audioSet = audioSets.find(s => /mp4a/i.test(s.getAttribute('codecs') || '')) || audioSets[0];
    if (!videoSet && !audioSet) throw new Error('No playable tracks in MPD');

    const tracks = [];
    if (videoSet) tracks.push({ kind: 'video', set: videoSet, rep: bestRep(videoSet), ext: 'mp4' });
    if (audioSet) tracks.push({ kind: 'audio', set: audioSet, rep: bestRep(audioSet), ext: 'm4a' });

    for (const track of tracks) {
      if (!track.rep) throw new Error('No Representation for ' + track.kind + ' track');
    }
    const trackData = tracks.map(track => {
      const adaptBase = chainBase(periodBase, track.set);
      const repBase = chainBase(adaptBase, track.rep);
      return { track: track, segs: buildSegments(track.rep, track.set, period, mpd, repBase) };
    });

    async function writeTrack(entry, sink) {
      const track = entry.track;
      const segs = entry.segs;
      if (segs.fileUrl) {
        const data = await YTDl.fetchBytes(segs.fileUrl, signal);
        await sink.write(data);
        return data.length;
      }
      let bytes = 0;
      if (segs.initUrl) {
        const init = await YTDl.fetchBytes(segs.initUrl, signal);
        await sink.write(init);
        bytes += init.length;
      }
      for (let i = 0; i < segs.urls.length; i++) {
        checkAbort(signal);
        const data = await YTDl.fetchBytes(segs.urls[i], signal);
        await sink.write(data);
        bytes += data.length;
        onStatus(`${track.kind}: segment ${i + 1}/${segs.urls.length} (${YTDl.formatBytes(bytes)})`, '');
      }
      return bytes;
    }

    if (trackData.length === 2) {
      // Video + audio tracks: download both to memory, merge into ONE MP4
      const writable = await opts.openFile(opts.baseName + '.mp4', 'mp4');
      try {
        const vSink = memorySink();
        await writeTrack(trackData[0], vSink);
        checkAbort(signal);
        const aSink = memorySink();
        await writeTrack(trackData[1], aSink);
        checkAbort(signal);
        const merged = await opts.merge(vSink.bytes(), aSink.bytes(), trackData[0].track.ext, trackData[1].track.ext);
        await writable.write(merged);
        await writable.close();
        onStatus(`Download complete! (${YTDl.formatBytes(merged.length)})`, 'success');
        return { success: true, bytes: merged.length };
      } catch (e) {
        try { await writable.abort(); } catch (_) {}
        throw e;
      }
    }

    // Single track (video-only or audio-only manifest): save directly
    const entry = trackData[0];
    const writable = await opts.openFile(opts.baseName + '_' + entry.track.kind + '.' + entry.track.ext, entry.track.ext);
    try {
      const bytes = await writeTrack(entry, writable);
      await writable.close();
      onStatus(`Download complete! (${YTDl.formatBytes(bytes)})`, 'success');
      return { success: true, bytes: bytes };
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      throw e;
    }
  }

  return { downloadHls: downloadHls, downloadDash: downloadDash };
})();