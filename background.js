// YouTube Downloader Extension - Background Service Worker

// Handle download requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename || 'video.mp4',
      conflictAction: 'uniquify',
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId: downloadId });
      }
    });
    return true; // Keep channel open for async response
  }

  if (request.action === 'getFormats') {
    // Fetch video info from YouTube's API
    fetchVideoFormats(request.videoId).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// Fetch video formats from YouTube
async function fetchVideoFormats(videoId) {
  try {
    // Use YouTube's get_video_info or player API
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await response.text();

    // Extract ytInitialPlayerResponse
    const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!match) {
      return { success: false, error: 'Could not parse video data' };
    }

    const playerResponse = JSON.parse(match[1]);
    const formats = [
      ...(playerResponse.streamingData?.formats || []),
      ...(playerResponse.streamingData?.adaptiveFormats || [])
    ];
    const title = playerResponse.videoDetails?.title || 'video';

    return { success: true, formats: formats, title: title };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Handle download completion
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === 'complete') {
    console.log('Download completed:', delta.id);
  }
  if (delta.error) {
    console.error('Download error:', delta.error.current);
  }
});
