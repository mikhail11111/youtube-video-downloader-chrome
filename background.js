// YouTube Downloader Extension - Background Service Worker
// Handles format fetching; downloads are done in content script for rate limiting

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getFormats') {
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
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await response.text();

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
