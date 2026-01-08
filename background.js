// background.js

// --- Mutex for Storage Locking ---
class Mutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    lock() {
        return new Promise((resolve) => {
            if (this._locked) {
                this._queue.push(resolve);
            } else {
                this._locked = true;
                resolve();
            }
        });
    }

    unlock() {
        if (this._queue.length > 0) {
            const resolve = this._queue.shift();
            resolve();
        } else {
            this._locked = false;
        }
    }
}

const storageMutex = new Mutex();

let activeTabId = null;
let lastStartTime = null;
let trackingPaused = false;
let videoPlayingMap = {}; // tabId -> boolean

// Initialize on load
(async () => {
    // Check for daily reset immediately
    await checkAndRotateDailyStats();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        startTracking(tab.id);
    }
})();

// Allow content scripts to connect for keep-alive monitoring
chrome.runtime.onConnect.addListener((port) => {
    // Just keep the port open. No specific logic needed.
});

// --- Event Listeners ---

// 1. Tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await stopTracking();
    if (!trackingPaused) {
        startTracking(activeInfo.tabId);
    } else {
        activeTabId = activeInfo.tabId;
    }
});

// 2. Tab updated
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tabId === activeTabId && changeInfo.status === 'complete') {
        // domain might have changed
    }
});

// 3. Window focus
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        await stopTracking();
        trackingPaused = true;
        activeTabId = null;
    } else {
        trackingPaused = false;
        const [tab] = await chrome.tabs.query({ active: true, windowId: windowId });
        if (tab) {
            startTracking(tab.id);
        }
    }
});

// 4. Tab closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (tabId === activeTabId) {
        await stopTracking();
        activeTabId = null;
    }
    delete videoPlayingMap[tabId];
});

// 5. Message from Content Script
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (sender.tab) {
        if (request.action === "VIDEO_PLAYING") {
            videoPlayingMap[sender.tab.id] = true;
        } else if (request.action === "VIDEO_PAUSED") {
            videoPlayingMap[sender.tab.id] = false;
        }

        if (sender.tab.id === activeTabId && !trackingPaused) {
            await stopTracking(); // Flush current interval
            startTracking(activeTabId); // Restart with new state
        }
    }
});


// --- Tracking Logic ---

function startTracking(tabId) {
    activeTabId = tabId;
    lastStartTime = Date.now();
    videoPlayingMap[tabId] = videoPlayingMap[tabId] || false; // preserve state if exists
}

async function stopTracking() {
    if (activeTabId !== null && lastStartTime !== null) {
        const now = Date.now();
        const duration = (now - lastStartTime) / 1000;
        lastStartTime = now;

        try {
            const tab = await chrome.tabs.get(activeTabId);
            if (tab && tab.url) {
                await updateTime(tab.url, duration, tab.favIconUrl, activeTabId);
            }
        } catch (e) { }
    }
}

async function updateTime(url, seconds, favIconUrl, tabId) {
    if (!url || !url.startsWith('http')) return;
    if (seconds <= 0) return;

    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    await storageMutex.lock();
    try {
        const data = await chrome.storage.local.get(['today_stats']);
        let todayStats = data.today_stats || {};

        if (!todayStats[domain]) {
            todayStats[domain] = { time: 0, icon: favIconUrl || '' };
        }
        if (favIconUrl) todayStats[domain].icon = favIconUrl;

        // --- UNIVERSAL VIDEO TRACKING ---

        // Check signals
        const explicitPlaying = videoPlayingMap[tabId];
        let isAudible = false;
        try {
            const tab = await chrome.tabs.get(tabId);
            isAudible = tab.audible;
        } catch (e) { }

        const isVideoActive = explicitPlaying || isAudible;

        // Determine if this domain is a "Video Site" (has separate metric)
        // 1. If it already has total_tab_time, preserve that mode.
        // 2. If video is currently active, upgrade to "Video Site" mode.
        const isVideoSite = (todayStats[domain].total_tab_time !== undefined) || isVideoActive;

        if (isVideoSite) {
            // Initialize dual metric if upgrading just now
            if (todayStats[domain].total_tab_time === undefined) {
                todayStats[domain].total_tab_time = todayStats[domain].time;
            }

            // Always increment Tab Time
            todayStats[domain].total_tab_time += seconds;

            // Increment Video Time only if playing
            if (isVideoActive) {
                todayStats[domain].time += seconds;
            }
        } else {
            // Standard Site
            todayStats[domain].time += seconds;
        }

        await chrome.storage.local.set({ today_stats: todayStats });
    } finally {
        storageMutex.unlock();
    }
}

// 6. Audible check
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.audible !== undefined) {
        // Handled by next update loop (heartbeat or stopTracking)
        // Optionally trigger immediate state check:
        // if (tabId === activeTabId) ...
    }
});

// --- Daily Rotation ---

async function checkAndRotateDailyStats() {
    await storageMutex.lock();
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const data = await chrome.storage.local.get(['currentDate', 'today_stats', 'history']);
        const lastDate = data.currentDate;

        if (lastDate !== todayStr) {
            console.log(`Rotated stats from ${lastDate} to ${todayStr}`);
            let history = data.history || {};
            if (lastDate && data.today_stats) {
                history[lastDate] = data.today_stats;
            }
            await chrome.storage.local.set({
                currentDate: todayStr,
                today_stats: {},
                history: history
            });
        }
    } finally {
        storageMutex.unlock();
    }
}

// Check rotation every minute
setInterval(checkAndRotateDailyStats, 60000);

// --- Browser Time ---
setInterval(async () => {
    await storageMutex.lock();
    try {
        const data = await chrome.storage.local.get(['today_stats']);
        let todayStats = data.today_stats || {};

        if (!todayStats.browser_time) todayStats.browser_time = 0;
        todayStats.browser_time += 1;

        await chrome.storage.local.set({ today_stats: todayStats });
    } finally {
        storageMutex.unlock();
    }
}, 1000);

// --- Heartbeat ---
setInterval(async () => {
    if (activeTabId !== null && !trackingPaused) {
        const now = Date.now();
        const duration = (now - lastStartTime) / 1000;

        if (duration > 1) {
            try {
                const tab = await chrome.tabs.get(activeTabId);
                if (tab && tab.url) {
                    await updateTime(tab.url, duration, tab.favIconUrl, activeTabId);
                    lastStartTime = now;
                }
            } catch (e) { }
        }
    }
}, 5000);
