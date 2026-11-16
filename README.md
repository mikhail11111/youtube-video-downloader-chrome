# Video Downloader — Chrome Extension

A Chrome extension (Manifest V3) that detects and downloads videos and audio from **YouTube and other websites**. It sniffs media traffic on any site, lists what it finds in the toolbar popup, and downloads direct files, HLS (.m3u8) and DASH (.mpd) streams.

## Features

- **Single complete files** — separate video/audio tracks (YouTube adaptive, DASH, HLS audio renditions) are merged into one MP4 automatically with ffmpeg.wasm (stream copy, no quality loss)
- **H.264 preferred** — always picks H.264 video / AAC audio when the source offers them (YouTube formats, HLS variants, DASH tracks); at equal quality the smallest file wins. The codec is shown on every entry
- **Works on any site** — media requests are detected automatically while you browse; the toolbar badge shows how many were found
- **Popup-first UI** — click the extension icon to see all detected media (streams first, then files) and pick what to download
- **HLS support** — parses master/media playlists, quality selection, AES-128 decryption, segment merging (TS or fMP4 output)
- **DASH support** — parses MPD manifests (SegmentTemplate/SegmentList/SegmentTimeline), picks the best video and audio tracks
- **YouTube support** — dedicated Download button on video pages plus InnerTube-based format fetching (direct, unthrottled CDN URLs)
- **Rate-limited direct downloads** — ~500 KB/s pacing with real-time progress and a cancel button
- **Downloads survive the popup** — the actual download runs in the page, so closing the popup doesn't stop it
- **SPA-aware** — YouTube button re-injects automatically when navigating between videos
- **Sanitized filenames** — uses the page/video title as the file name

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** and select this folder
4. The extension icon will appear in your toolbar

## Usage

### Any site

1. Open a page with a video and **press play** (streams are only requested during playback)
2. Click the extension icon — the badge shows the number of detected media items
3. Pick an entry: **HLS**/**DASH** streams are downloaded segment-by-segment and merged; **FILE** entries are plain media files
4. Confirm the save in the page panel and choose a location
5. If nothing is listed, click **Rescan page**

### YouTube

1. Open any YouTube video
2. Click the red **Download** button near the video controls, or use the toolbar popup
3. Pick a quality (video-only streams are marked **NO AUDIO**), confirm, and save

## How it works

1. **Background service worker**
   - Observes network requests (`chrome.webRequest`) on all sites and classifies media by URL extension and response Content-Type; detections are kept per tab in `chrome.storage.session`
   - Fetches YouTube formats from the InnerTube API (ANDROID/IOS/WEB clients return direct URLs without signature ciphers or throttled `n` parameters)
   - Proxies media fetches for content scripts blocked by CORS
2. **Content script** (all sites, all frames)
   - Scans `<video>`/`<audio>` elements for direct sources
   - Top frame: runs the download panel and the actual download (File System Access API), so it survives popup closure
3. **Stream engine** (`stream.js`)
   - HLS: master playlist variant selection, media playlist parsing, AES-128 key handling, byte-range segments (coalesced Range requests), init + segment concatenation
   - DASH: MPD parsing, best-track selection, segment URL generation, init + segment concatenation
4. **Popup** — lists detected media (or YouTube formats) and delegates downloads to the content script
5. **Merger** (`offscreen.html` + `sandbox.html`)
   - An offscreen document hosts a sandboxed iframe (the only MV3 context allowed to load remote scripts) running ffmpeg-core from a CDN **directly in the page** — no wrapper/worker, which hang silently in sandboxed contexts
   - The ~31 MB core downloads with progress reporting and a timeout; tracks are transferred in 3 MB chunks, merged with `-c copy` (no re-encoding), and the single MP4 is streamed back to the page for saving

Each saved file starts with an in-page click, because the save dialog (`showSaveFilePicker`) requires a user gesture in the page itself.

## File structure

```
├── manifest.json       # Extension manifest (Manifest V3)
├── shared.js           # Helpers: classification, fetch proxy, filenames
├── stream.js           # HLS + DASH parsing and segmented download engine
├── content.js          # DOM scanning, download panel + downloader
├── content.css         # Panel styling
├── background.js       # Service worker: sniffing, InnerTube, CORS proxy, merge routing
├── offscreen.html      # Offscreen document hosting the merger iframe
├── offscreen.js        # Message bridge: extension <-> sandbox
├── sandbox.html        # Sandboxed page (allows ffmpeg-core from CDN)
├── sandbox.js          # ffmpeg-core merge engine (direct, no worker)
├── popup.html          # Toolbar popup UI
├── popup.js            # Popup logic
├── popup.css           # Popup styling
└── icons/
```

## Limitations

- **No transcoding** — the extension picks H.264 sources when available but cannot re-encode other codecs; if a site only offers VP9/AV1/H.265, that is what gets saved (labeled in the UI). Convert afterwards with `ffmpeg -i in.webm -c:v libx264 -crf 23 -c:a aac out.mp4`
- **First merge needs internet** — the ffmpeg core (~31 MB) is loaded from unpkg.com when the first merge runs, with progress and a 3-minute timeout. Very large videos are held in memory during merging
- **DRM** — Widevine/PlayReady/FairPlay-protected streams (Netflix, Spotify, etc.) cannot be downloaded; they are reported as unsupported
- **MSE/blob players** — sites that hide the stream behind `blob:` URLs are covered only if the underlying segments/manifests are visible in network traffic; press play first
- **TS output** — muxed HLS streams with MPEG-TS segments are saved as `.ts` (playable in VLC etc.); remux with `ffmpeg -i in.ts -c copy out.mp4` if needed
- **SABR (YouTube)** — YouTube may block some high-resolution formats; if a format fails, try a lower quality
- **Browser support** — the File System Access API requires Chrome 86+ (desktop)

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Read the current page |
| `scripting` | Read YouTube's live player response (MAIN world) as a fallback |
| `webRequest` | Detect media requests (read-only observation, no blocking) |
| `storage` | Keep per-tab detections across service worker restarts |
| `offscreen` | Host the ffmpeg.wasm merger in an offscreen document |
| `host_permissions: <all_urls>` | Detect and fetch media from any site |

## License

MIT

## Disclaimer

This extension is for personal use. Respect websites' Terms of Service and copyright laws. Only download content you have the right to download.