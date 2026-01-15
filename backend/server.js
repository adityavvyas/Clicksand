const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(cors());
app.use(bodyParser.json());

// --- State Cache (InMemory) ---
const statsCache = new Map(); // userId -> { todayStats, history, currentDate }

// --- Helpers ---
function normalizeDomain(domain) {
    return domain.replace(/^www\./, '');
}

function isMatch(currentDomain, targetDomain) {
    const curr = normalizeDomain(currentDomain);
    const target = normalizeDomain(targetDomain);
    return curr === target || curr.endsWith('.' + target);
}

function getDataFile(userId) {
    // SECURITY: Simple sanitization to prevent directory traversal
    const safeId = userId.replace(/[^a-z0-9-]/gi, '');
    return path.join(DATA_DIR, `${safeId}.json`);
}

function loadUserData(userId) {
    if (statsCache.has(userId)) return statsCache.get(userId);

    let userData = {
        todayStats: {},
        history: {},
        currentDate: new Date().toISOString().split('T')[0],
        achievements: { // Per user config or default?
            "youtube.com": { limit: 120, interval: 60, message: "YouTube Limit Reached!" },
            "goclasses.in": { limit: 300, interval: 0, message: "Study Break!" }
        }
    };

    const filePath = getDataFile(userId);
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const loaded = JSON.parse(raw);
            userData = { ...userData, ...loaded };

            // ADAPTER: If userData has flat lists (from popup), convert to map for logic
            if (loaded.achievement_sites && Array.isArray(loaded.achievement_sites)) {
                // User has "Simple Mode" settings
                const limit = loaded.achievement_limit || 0;
                const interval = loaded.achievement_interval || 0;

                // Rebuild 'achievements' map from this list
                userData.achievements = {};
                loaded.achievement_sites.forEach(site => {
                    userData.achievements[site] = {
                        limit: limit * 60, // popup saves minutes, we need seconds? Popup saves minutes.
                        interval: interval * 60,
                        message: "Time Limit Reached!"
                    };
                });

                // Note: We multiply by 60 because popup inputs are minutes, but server counts seconds.
                // Assuming popup inputs are minutes.
            }

        } catch (e) {
            console.error(`Error loading data for ${userId}`, e);
        }
    }
    statsCache.set(userId, userData);
    return userData;
}

// function saveUserData moved to async implementation below

function checkDateRollover(userData) {
    const nowStr = new Date().toISOString().split('T')[0];
    if (nowStr !== userData.currentDate) {
        userData.history[userData.currentDate] = userData.todayStats;
        userData.todayStats = {};
        userData.currentDate = nowStr;
        // Immediate save on rollover
        // We can't easily save here without userId? 
        // We rely on caller to save.
        return true;
    }
    return false;
}

// --- Logic ---
function handleTimeBatch(batch) {
    const userId = batch.userId;
    if (!userId) {
        console.warn("Ignoring batch without userId");
        return;
    }

    const userData = loadUserData(userId);
    if (checkDateRollover(userData)) saveUserData(userId);

    const todayStats = userData.todayStats;
    const domain = batch.domain;
    if (!domain) return;

    // Use raw values
    const activeSecs = batch.activeSeconds || 0;
    const videoSecs = batch.videoSeconds || 0;

    if (!todayStats[domain]) {
        todayStats[domain] = {
            time: 0,
            video_time: 0,
            sessions: 0,
            currentSessionTime: 0,
            lastActiveTime: Date.now(),
            triggeredAchievements: {}
        };
    }

    const entry = todayStats[domain];
    const now = Date.now();

    // Logic: Time is the MAX of Active or Video (so watching counts as working)
    const effectiveIncrement = Math.max(activeSecs, videoSecs);

    entry.time += effectiveIncrement;
    entry.video_time += videoSecs;
    entry.lastActiveTime = now;
    if (batch.icon) entry.icon = batch.icon;

    // Session Logic (Timeout 30m)
    const SESSION_TIMEOUT = 30 * 60 * 1000;

    if (effectiveIncrement > 0) {
        if (!entry.lastSessionUpdate || (now - entry.lastSessionUpdate > SESSION_TIMEOUT)) {
            entry.sessions = (entry.sessions || 0) + 1;
            entry.currentSessionTime = 0;
            entry.triggeredAchievements = {};
        }
        entry.currentSessionTime += effectiveIncrement;
        entry.lastSessionUpdate = now;

        checkAchievements(domain, entry, userData.achievements, userId);
    }

    throttledSave(userId);
    io.emit(`stats_update_${userId}`, todayStats);
}

function checkAchievements(domain, entry, achievements, userId) {
    if (!achievements) return;

    // Check specific domain achievement
    // Also check wildcard or categories if implemented later
    // For now, simple domain match
    let config = achievements[domain];

    // Support subdomains if main domain has config
    if (!config) {
        const root = normalizeDomain(domain);
        config = achievements[root];
        // Iterate to find ending match if needed, but simple map lookup is faster if exact.
        // If we want flexible matching:
        if (!config) {
            for (const key in achievements) {
                if (isMatch(domain, key)) {
                    config = achievements[key];
                    break;
                }
            }
        }
    }

    if (!config) return;

    const sessionSecs = entry.currentSessionTime;
    const limit = config.limit || 0;
    const interval = config.interval || 0;

    if (limit > 0 && sessionSecs >= limit) {
        // Check if already triggered
        // We use a key like "limit_reached" or "interval_N"

        let shouldTrigger = false;
        let triggerType = "";

        // Initial Limit
        if (!entry.triggeredAchievements["limit_reached"]) {
            shouldTrigger = true;
            triggerType = "limit_reached";
        }
        // Interval checks (after limit)
        else if (interval > 0) {
            const timeSinceLimit = sessionSecs - limit;
            const steps = Math.floor(timeSinceLimit / interval);
            if (steps > 0) {
                const stepKey = `interval_${steps}`;
                if (!entry.triggeredAchievements[stepKey]) {
                    shouldTrigger = true;
                    triggerType = stepKey;
                    // Prevent spamming active intervals? Usually we just alert once per interval boundary
                }
            }
        }

        if (shouldTrigger) {
            entry.triggeredAchievements[triggerType] = true;

            // Emit Event
            io.emit(`achievement_unlocked_${userId}`, {
                domain: domain,
                message: config.message || "Time Limit Reached!",
                type: 'limit'
            });

            // Also save immediately? or let throttled handle it. 
            // Throttled is fine.
        }
    }
}

function saveUserData(userId) {
    const data = statsCache.get(userId);
    if (!data) return;
    // Async save to prevent blocking logic
    const filePath = getDataFile(userId);
    const json = JSON.stringify(data, null, 2);
    fs.writeFile(filePath, json, (err) => {
        if (err) console.error(`Error saving data for ${userId}`, err);
    });
}

const saveTimeouts = new Map();

function throttledSave(userId) {
    if (saveTimeouts.has(userId)) clearTimeout(saveTimeouts.get(userId));

    // Create closure for specific userId
    const timeout = setTimeout(() => {
        saveUserData(userId);
        saveTimeouts.delete(userId);
    }, 2000);

    saveTimeouts.set(userId, timeout);
}

// --- Routes ---
app.get('/', (req, res) => {
    res.send('Clicksand Backend is Online! ⏳');
});

app.post('/api/heartbeat', (req, res) => {
    const userId = req.body.userId;
    if (!userId) return res.sendStatus(400);

    const userData = loadUserData(userId);
    checkDateRollover(userData);

    if (!userData.todayStats['browser_time']) userData.todayStats['browser_time'] = 0;
    userData.todayStats['browser_time'] += 1;

    io.emit(`stats_update_${userId}`, userData.todayStats);
    res.sendStatus(200);
});

app.post('/api/log', (req, res) => {
    handleTimeBatch(req.body);
    res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
    const userId = req.query.userId || req.body.userId; // Allow query param for GET
    if (!userId) {
        return res.json({ todayStats: {}, history: {}, currentDate: new Date().toISOString().split('T')[0] });
    }

    const userData = loadUserData(userId);
    checkDateRollover(userData);
    res.json({
        todayStats: userData.todayStats,
        history: userData.history,
        currentDate: userData.currentDate
    });
});

app.post('/api/reset', (req, res) => {
    const userId = req.body.userId;
    if (!userId) return res.sendStatus(400);

    const userData = loadUserData(userId);
    userData.todayStats = {};
    userData.history = {};
    // Keep achievements config but reset any state if stored there? 
    // Achievements state is in todayStats (triggeredAchievements), so clearing todayStats clears that state.
    // userData.achievements is CONFIG. use default or keep user overrides? 
    // Assuming we want to keep CONFIG but reset STATS.

    saveUserData(userId);

    io.emit(`stats_update_${userId}`, userData.todayStats);
    res.json({ success: true });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));
