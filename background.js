// background.js - Robust Heartbeat Tracking
// Replaces fragile timestamp-diff logic with a state-based heartbeat.

let trackerState = {
    activeTabId: null,
    activeDomain: null,
    activeFavIconUrl: null,
    videoPlayingTabs: new Map(), // Map<TabId, Domain>
    isIdle: false,
    isWindowFocused: true,
    lastHeartbeat: Date.now()
};

let todayStats = {};

const CONFIG = {
    idleThresholdSeconds: 60,
    heartbeatIntervalMs: 1000,
    saveIntervalMs: 30000
};

// --- Initialization ---
(async () => {
    // 1. Data Migration / Reset (Fresh Start)
    // 1. Data Migration / Reset (Fresh Start)
    const resetCheck = await chrome.storage.local.get(['has_reset_v2', 'migrated_to_v3']);
    
    // Fresh Install / Factory Reset
    if (!resetCheck.has_reset_v2) {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ has_reset_v2: true, migrated_to_v3: true });
    } else if (!resetCheck.migrated_to_v3) {
        // MIGRATION: Split 'history' object into separate keys 'history_YYYY-MM-DD'
        const data = await chrome.storage.local.get(['history']);
        if (data.history) {
            const updates = {};
            for (const [date, stats] of Object.entries(data.history)) {
                updates[`history_${date}`] = stats;
            }
            await chrome.storage.local.set(updates);
            await chrome.storage.local.remove('history');
        }
        await chrome.storage.local.set({ migrated_to_v3: true });
    }

    // 2. Load data
    await loadDailyStats();

    // 2. Initial State Check
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await updateActiveTab(tab);

    // 3. Start Heartbeat
    setInterval(heartbeatTick, CONFIG.heartbeatIntervalMs);

    // 4. Persistence Alarm
    chrome.alarms.create('save_stats', { periodInMinutes: 1 });
    chrome.alarms.create('keep_alive', { periodInMinutes: 1 });

    // 5. Idle Detection
    chrome.idle.setDetectionInterval(CONFIG.idleThresholdSeconds);
})();

// --- The Heartbeat (Core Logic) ---
async function heartbeatTick() {
    const now = Date.now();
    let deltaSeconds = (now - trackerState.lastHeartbeat) / 1000;
    trackerState.lastHeartbeat = now;

    // Relaxed threshold: Service Workers can sleep and wake up after 10-30s.
    // We shouldn't discard that time as "System Sleep" if it's just SW Sleep.
    // 120s is a safe upper bound (User likely wouldn't stare at a frozen screen for 2m without idle triggering).
    if (deltaSeconds > 120) return;

    if (trackerState.isIdle) return;

    // --- 1. GLOBAL BROWSER TIME ---
    // Track usage if Window is Focused OR Video is playing (Passive listening)
    const canTrackBrowser = trackerState.isWindowFocused || trackerState.videoPlayingTabs.size > 0;

    if (canTrackBrowser) {
        if (!todayStats['browser_time']) todayStats['browser_time'] = 0;
        todayStats['browser_time'] += deltaSeconds;
    }

    // --- 2. BACKGROUND VIDEO TRACKING ---
    // Increment video_time for ALL tabs playing video
    trackerState.videoPlayingTabs.forEach((domain, tabId) => {
        if (!todayStats[domain]) {
            // Init if missing (rare case if tab loaded before extension)
            todayStats[domain] = { time: 0, currentSessionTime: 0, sessions: 0, icon: '', lastActiveTime: now };
        }
        const entry = todayStats[domain];
        if (!entry.video_time) entry.video_time = 0;
        entry.video_time += deltaSeconds;

        // We do NOT increment currentSessionTime here anymore.
        // Achievements are reserved for ACTIVE usage only.

        // Also update last active time to keep session alive?
        // Maybe not, "Active" implies user interaction. Video is passive.
        // But let's keep it alive so session doesn't reset while watching a movie.
        entry.lastActiveTime = now;
    });

    // --- 3. ACTIVE TAB TRACKING ---
    // Strict requirement: User must be focused on the window
    if (!trackerState.isWindowFocused) return;

    // Must have a valid domain
    if (!trackerState.activeDomain) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) await updateActiveTab(tab);
        return;
    }

    // Ensure entry exists
    if (!todayStats[trackerState.activeDomain]) {
        todayStats[trackerState.activeDomain] = {
            time: 0,
            currentSessionTime: 0,
            total_tab_time: 0,
            sessions: 0,
            icon: trackerState.activeFavIconUrl,
            lastActiveTime: Date.now()
        };
    }

    const entry = todayStats[trackerState.activeDomain];

    // Increment Active Time
    entry.time += deltaSeconds;

    // Increment Session Time (Active Only)
    if (entry.currentSessionTime === undefined) entry.currentSessionTime = 0;
    entry.currentSessionTime += deltaSeconds;

    // Check Achievements (Active Only)
    checkAchievements(trackerState.activeDomain, entry.currentSessionTime);

    entry.lastActiveTime = now;
    if (trackerState.activeFavIconUrl) entry.icon = trackerState.activeFavIconUrl;
}

// --- Event Listeners ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await updateActiveTab(tab);
    } catch (e) { }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tabId === trackerState.activeTabId && changeInfo.status === 'complete') {
        await updateActiveTab(tab);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    // Clean up video state
    if (trackerState.videoPlayingTabs.has(tabId)) {
        trackerState.videoPlayingTabs.delete(tabId);
    }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // Ignored
    } else {
        trackerState.isWindowFocused = true;
        const [tab] = await chrome.tabs.query({ active: true, windowId: windowId });
        if (tab) await updateActiveTab(tab);
    }
});

chrome.idle.onStateChanged.addListener((newState) => {
    trackerState.isIdle = (newState !== 'active');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.tab) {
        const domain = new URL(sender.tab.url).hostname;

        if (request.action === "VIDEO_PLAYING") {
            trackerState.videoPlayingTabs.set(sender.tab.id, domain);
        } else if (request.action === "VIDEO_PAUSED") {
            trackerState.videoPlayingTabs.delete(sender.tab.id);
        } else if (request.action === "URL_CHANGED") {
            if (sender.tab.id === trackerState.activeTabId) {
                updateActiveTab(sender.tab);
            }
            // Also update map if domain changed?
            // Usually URL change implies reload or nav, so video stops anyway.
        }
    }
    if (request.action === "GET_LIVE_STATS") {
        sendResponse(todayStats);
    } else if (request.action === "RESET_DATA") {
        // Clear In-Memory Stats
        for (const key in todayStats) delete todayStats[key];
        trackerState.videoPlayingTabs.clear();

        // Reset Achievement Checkpoints
        for (const key in achievementCheckpoints) delete achievementCheckpoints[key];

        // Clear Storage (All history keys + today_stats + history legacy)
        chrome.storage.local.get(null, (allData) => {
            const keysToRemove = Object.keys(allData).filter(k => 
                k.startsWith('history_') || k === 'today_stats' || k === 'history'
            );
            chrome.storage.local.remove(keysToRemove, () => {
                sendResponse({ success: true });
            });
        });

        // Re-init current active tab stats immediately so we don't crash
        if (trackerState.activeTabId) {
            chrome.tabs.get(trackerState.activeTabId, (tab) => {
                if (tab) updateActiveTab(tab);
            });
        }
        return true; // Async response
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'save_stats') {
        saveDailyStats();
    }
});

// --- Achievement System ---
let achievementSites = [];
let achievementInterval = 30; // Default minutes
let achievementLimit = 0; // 0 = Unlimited
let achievementCheckpoints = {};

// --- Helpers ---

async function updateActiveTab(tab) {
    if (!tab || !tab.url || !tab.url.startsWith('http')) {
        trackerState.activeDomain = null;
        trackerState.activeTabId = null;
        return;
    }

    const domain = new URL(tab.url).hostname;

    // Session Counting
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    const now = Date.now();
    let isNewSession = false;

    if (!todayStats[domain]) {
        todayStats[domain] = { time: 0, currentSessionTime: 0, sessions: 0, icon: tab.favIconUrl || '', lastActiveTime: 0 };
        isNewSession = true;
    } else {
        const lastActive = todayStats[domain].lastActiveTime || 0;
        if (domain !== trackerState.activeDomain || (now - lastActive > SESSION_TIMEOUT_MS)) {
            isNewSession = true;
        }
    }

    if (isNewSession) {
        todayStats[domain].sessions = (todayStats[domain].sessions || 0) + 1;
        todayStats[domain].currentSessionTime = 0;
        const matched = findMatchedSite(domain);
        if (matched) achievementCheckpoints[matched] = [];
    }

    trackerState.activeTabId = tab.id;
    trackerState.activeDomain = domain;
    trackerState.activeFavIconUrl = tab.favIconUrl;
    trackerState.isVideoPlaying = false;
}

async function loadDailyStats() {
    const todayStr = new Date().toISOString().split('T')[0];
    const data = await chrome.storage.local.get(['currentDate', 'today_stats', 'achievement_sites', 'achievement_interval', 'achievement_limit']);

    if (data.achievement_sites) achievementSites = data.achievement_sites;
    if (data.achievement_interval) achievementInterval = parseInt(data.achievement_interval) || 30;
    if (data.achievement_limit) achievementLimit = parseInt(data.achievement_limit) || 0;

    if (data.currentDate !== todayStr) {
        // Rotate: Save yesterday's stats to a stable key
        if (data.currentDate && data.today_stats) {
            const key = `history_${data.currentDate}`;
            await chrome.storage.local.set({ [key]: data.today_stats });
        }
        
        todayStats = {};
        achievementCheckpoints = {};
        await chrome.storage.local.set({ currentDate: todayStr, today_stats: {} });
    } else {
        todayStats = data.today_stats || {};
    }
}

async function saveDailyStats() {
    await chrome.storage.local.set({ today_stats: todayStats });
}

function normalizeDomain(d) {
    return d.replace(/^www\./, '').toLowerCase();
}

function findMatchedSite(domain) {
    const normDomain = normalizeDomain(domain);
    return achievementSites.find(site => {
        const normSite = normalizeDomain(site);
        return normDomain === normSite || normDomain.endsWith('.' + normSite);
    });
}

function checkAchievements(domain, timeSeconds) {
    const matchedSite = findMatchedSite(domain);
    if (!matchedSite) return;

    if (!achievementCheckpoints[matchedSite]) achievementCheckpoints[matchedSite] = [];

    if (achievementLimit > 0 && achievementCheckpoints[matchedSite].length >= achievementLimit) {
        return;
    }

    const minutes = Math.floor(timeSeconds / 60);
    const interval = achievementInterval > 0 ? achievementInterval : 30;

    if (minutes > 0 && minutes % interval === 0) {
        if (!achievementCheckpoints[matchedSite].includes(minutes)) {
            achievementCheckpoints[matchedSite].push(minutes);
            fireAchievement(matchedSite, minutes);
        }
    }
}

const ACHIEVEMENT_MESSAGES = [
    "You're on fire! 🔥",
    "Absolute dedication! 🚀",
    "Nothing can stop you now! 💪",
    "Look at you go! ✨",
    "Zoned in and crushing it! 🎯",
    "Time flies when you're awesome! 🕶️",
    "Legendary focus! 🏆",
    "Unstoppable momentum! 🌊",
    "Simply amazing! ⭐",
    "Keep being a superstar! 🌟"
];

function fireAchievement(domain, minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    let timeStr = "";
    if (hours > 0) timeStr += `${hours}h `;
    if (mins > 0) timeStr += `${mins}m`;

    const randomMsg = ACHIEVEMENT_MESSAGES[Math.floor(Math.random() * ACHIEVEMENT_MESSAGES.length)];
    const tabId = trackerState.activeTabId;

    if (tabId) {
        const payload = {
            action: 'SHOW_ACHIEVEMENT',
            title: `Achievement Unlocked: ${domain}`,
            message: `${timeStr} reached! ${randomMsg}`
        };

        // Attempt 1: Send Message
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            if (chrome.runtime.lastError) {
                // Attempt 2: Inject and Retry
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                }, () => {
                    if (!chrome.runtime.lastError) {
                        // Retry Send
                        setTimeout(() => {
                            chrome.tabs.sendMessage(tabId, payload, () => { });
                        }, 100);
                    }
                });
            }
        });
    }
}

// Reload achievement settings if changed
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.achievement_sites) {
            achievementSites = changes.achievement_sites.newValue || [];
        }
        if (changes.achievement_interval) {
            achievementInterval = parseInt(changes.achievement_interval.newValue) || 30;
        }
        if (changes.achievement_limit) {
            achievementLimit = parseInt(changes.achievement_limit.newValue) || 0;
        }
    }
});
