// background.js - The "Stateless" Storage Manager

let todayStats = {};
let isDataLoaded = false;
let saveTimeout = null;

// --- Initialization ---
(async () => {
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

    // Load data immediately on wake up
    await loadDailyStats();
})();

// --- Message Listener (The Core) ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // 1. Handle Time Updates (Push Model)
    if (request.action === 'LOG_TIME_BATCH') {
        handleTimeBatch(request.data, sender);
        sendResponse({ success: true }); // Acknowledge to keep connection healthy
    }

    // 2. UI Requests
    else if (request.action === "GET_LIVE_STATS") {
        // Return what we have in memory
        sendResponse(todayStats);
    }

    // 3. Reset Data
    else if (request.action === "RESET_DATA") {
        performReset().then(() => sendResponse({ success: true }));
        return true; // Async
    }
});

// --- Logic Handlers ---

async function handleTimeBatch(data, sender) {
    if (!isDataLoaded) await loadDailyStats();

    const domain = data.domain;
    const activeSecs = data.activeSeconds || 0;
    const videoSecs = data.videoSeconds || 0;

    if (activeSecs === 0 && videoSecs === 0) return;

    // 1. Global Browser Time (Only from Active Usage)
    if (activeSecs > 0) {
        if (!todayStats['browser_time']) todayStats['browser_time'] = 0;
        todayStats['browser_time'] += activeSecs;
    }

    // 2. Initialize Domain Entry if missing
    if (!todayStats[domain]) {
        todayStats[domain] = {
            time: 0,
            video_time: 0,
            sessions: 0,
            currentSessionTime: 0,
            icon: sender.tab?.favIconUrl || '',
            lastActiveTime: Date.now()
        };
    }

    const entry = todayStats[domain];
    const now = Date.now();

    // 3. Update Stats
    entry.time += activeSecs;
    entry.video_time += videoSecs;
    entry.lastActiveTime = now;

    // Update Icon if we have a better one
    if (sender.tab?.favIconUrl) entry.icon = sender.tab.favIconUrl;

    // 4. Session Logic (Only tracking "Active" sessions)
    if (activeSecs > 0) {
        const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 mins

        // If it's been a long time since last update, count as new session
        // We track 'lastSessionUpdate' specifically for this to avoid gaps
        if (!entry.lastSessionUpdate || (now - entry.lastSessionUpdate > SESSION_TIMEOUT_MS)) {
            entry.sessions = (entry.sessions || 0) + 1;
            entry.currentSessionTime = 0;
        }

        entry.currentSessionTime += activeSecs;
        entry.lastSessionUpdate = now;

        // 5. Check Achievements
        checkAchievements(domain, entry.currentSessionTime, sender.tab?.id);
    }

    // 6. Save Data (Debounced)
    triggerSave();
}

// --- Persistence ---

async function loadDailyStats() {
    const todayStr = new Date().toISOString().split('T')[0];
    const data = await chrome.storage.local.get(['currentDate', 'today_stats']);

    if (data.currentDate !== todayStr) {
        // New Day: Archive yesterday
        if (data.currentDate && data.today_stats) {
            const key = `history_${data.currentDate}`;
            await chrome.storage.local.set({ [key]: data.today_stats });
        }
        // Reset
        todayStats = {};
        await chrome.storage.local.set({ currentDate: todayStr, today_stats: {} });
    } else {
        todayStats = data.today_stats || {};
    }
    isDataLoaded = true;
}

function triggerSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        if (isDataLoaded) {
            await chrome.storage.local.set({ today_stats: todayStats });
        }
    }, 2000); // Save 2s after last update
}

async function performReset() {
    todayStats = {};
    const data = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(data).filter(k =>
        k.startsWith('history_') || k === 'today_stats' || k === 'history'
    );
    await chrome.storage.local.remove(keysToRemove);
    await loadDailyStats();
}

// --- Achievements System ---

let achievementCheckpoints = {}; // Transient memory (fine to reset on SW death)
const ACHIEVEMENT_MESSAGES = [
    "You're on fire! 🔥", "Absolute dedication! 🚀", "Unstoppable! 💪", "Laser focus! 🎯",
    "Time flies when you're working! 🕶️", "Legendary stamina! 🏆"
];

async function checkAchievements(domain, sessionTimeSecs, tabId) {
    if (!tabId) return;

    // Load config on the fly (or cache it)
    // For simplicity, we fetch defaults or cached small config
    const data = await chrome.storage.local.get(['achievement_sites', 'achievement_interval', 'achievement_limit']);
    const sites = data.achievement_sites || [];
    const intervalMins = parseInt(data.achievement_interval) || 30;
    const limit = parseInt(data.achievement_limit) || 0;

    // Check match
    const normDomain = domain.replace(/^www\./, '').toLowerCase();
    const isMatch = sites.some(site => {
        const s = site.replace(/^www\./, '').toLowerCase();
        return normDomain === s || normDomain.endsWith('.' + s);
    });

    if (!isMatch) return;

    // Check Interval
    const minutes = Math.floor(sessionTimeSecs / 60);
    if (minutes > 0 && minutes % intervalMins === 0) {

        // Prevent duplicate firing for the same minute
        const key = `${domain}_${minutes}`;
        if (achievementCheckpoints[key]) return;

        // Check Limit
        const firedCount = Object.keys(achievementCheckpoints).filter(k => k.startsWith(domain)).length;
        if (limit > 0 && firedCount >= limit) return;

        achievementCheckpoints[key] = true;
        fireAchievement(domain, minutes, tabId);
    }
}

function fireAchievement(domain, minutes, tabId) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    let timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    const msg = ACHIEVEMENT_MESSAGES[Math.floor(Math.random() * ACHIEVEMENT_MESSAGES.length)];

    chrome.tabs.sendMessage(tabId, {
        action: 'SHOW_ACHIEVEMENT',
        title: `Achievement: ${domain}`,
        message: `${timeStr} reached! ${msg}`
    }).catch(() => { }); // Ignore if tab closed
}
