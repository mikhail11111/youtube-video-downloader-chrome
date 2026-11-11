# YouTube Video Downloader — Chrome Extension

A Chrome extension (Manifest V3) that adds a **Download** button to YouTube video pages, letting you download videos in multiple qualities and formats directly from your browser.

## Features

- **Download button on YouTube** — appears next to Like/Share on any video page
- **Quality selector** — choose from 144p, 240p, 360p, 480p, 720p, 1080p and more
- **Audio-only downloads** — grab just the audio stream (M4A/Opus)
- **Toolbar popup** — click the extension icon to browse formats without opening the in-page panel
- **Rate-limited downloads** — downloads at ~500 KB/s to bypass YouTube's throttling, ensuring consistent full-speed downloads
- **No external API** — extracts format URLs directly from YouTube's player response
- **SPA-aware** — button re-injects automatically when navigating between videos
- **Sanitized filenames** — uses the video title as the file name

## Installation

### From source (Developer Mode)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/mikhail11111/youtube-video-downloader-chrome.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `youtube-video-downloader-chrome` folder
5. The extension icon will appear in your toolbar

## Usage

### In-page download button

1. Open any YouTube video
2. Click the red **Download** button that appears near the video controls
3. A panel opens showing all available video and audio formats
4. Click any format to start the download

### Toolbar popup

1. Click the extension icon in the Chrome toolbar
2. If you're on a YouTube video page, formats load automatically
3. Click any format button to download

## How it works

The extension injects a content script into YouTube pages that:

1. Reads `ytInitialPlayerResponse` from the page's JavaScript
2. Extracts `streamingData.formats` and `streamingData.adaptiveFormats`
3. Displays them in a panel or popup
4. Downloads using **rate-limited fetch** (~500 KB/s) to bypass YouTube's throttle detection

### Why rate limiting?

YouTube detects fast downloads and throttles them to ~100 KB/s after the first few seconds. By limiting the download speed to ~500 KB/s, the extension stays below YouTube's detection threshold, resulting in consistent full-speed downloads without throttling.

The rate limiter works by:
- Fetching the file as a `ReadableStream`
- Reading chunks and writing them to disk via the File System Access API
- Adding small delays between chunks to maintain the target speed
- Showing real-time progress (percentage, bytes, speed)

## File structure

```
youtube-video-downloader-chrome/
├── manifest.json       # Extension manifest (Manifest V3)
├── content.js          # In-page download button + format panel
├── content.css         # Panel styling
├── background.js       # Service worker: downloads + format fetching
├── popup.html          # Toolbar popup UI
├── popup.js            # Popup logic
├── popup.css           # Popup styling
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Limitations

- **SABR streaming** — YouTube may block some high-resolution formats via SABR; if a format fails, try a lower quality
- **Separate streams** — video and audio are separate streams; for a merged MP4, download both and combine with [ffmpeg](https://ffmpeg.org/):
  ```bash
  ffmpeg -i video.mp4 -i audio.m4a -c copy output.mp4
  ```
- **Large files** — the File System Access API (`showSaveFilePicker`) is used for saving; this requires Chrome 86+ and a secure context (HTTPS)
- **Unlisted/private videos** — may have download restrictions depending on the video's privacy settings
- **Rate limiting** — YouTube may throttle downloads at full speed; the extension relies on Chrome's native download manager

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Read the current YouTube page |
| `downloads` | Trigger file downloads via Chrome's download manager |
| `storage` | Store user preferences (future use) |
| `scripting` | Inject content scripts into YouTube pages |
| `host_permissions` | Access YouTube and Google Video CDN URLs |

## License

MIT

## Disclaimer

This extension is for personal use. Respect YouTube's Terms of Service and copyright laws. Only download content you have the right to download.