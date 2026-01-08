# Clicksand

A Chrome extension to track time spent on websites. Monitors active browsing time with specialized tracking for video sites.

## Features

- **Time Tracking**: Automatically tracks time spent on each website
- **Video Detection**: Distinguishes between video watching time and tab open time
- **Daily/Weekly/Monthly Views**: View your browsing stats by different time periods
- **Pinned Sites**: Pin important sites for quick access
- **Export Data**: Download your tracking data as CSV

## Installation

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the folder containing these files

## Files

- `manifest.json` - Extension configuration
- `background.js` - Background service worker for tracking
- `content.js` - Content script for video detection
- `popup.html` - Extension popup UI
- `popup.js` - Popup logic and charts
- `hourglass.png` - Extension icon

## Privacy

All data is stored locally in your browser. No data is transmitted to external servers.

## License

MIT
