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

io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('update_settings', (payload) => {
        const { userId, settings } = payload;
        if (!userId || !settings) return;

        const userData = loadUserData(userId);

        // Update user data with new settings
        if (settings.achievement_sites) userData.achievement_sites = settings.achievement_sites;
        if (settings.achievement_interval !== undefined) userData.achievement_interval = settings.achievement_interval;
        if (settings.achievement_limit !== undefined) userData.achievement_limit = settings.achievement_limit;

        // Re-transform/Refresh the achievements map immediately
        // Copy-paste logic from loadUserData or extract it? 
        // For safety, let's just re-run the transform logic here or let the next load handle it.
        // But since we modify userData in memory, we should update the map for the current session.
        if (userData.achievement_sites && Array.isArray(userData.achievement_sites)) {
            if (!userData.achievements) userData.achievements = {};
            const globalInterval = parseInt(userData.achievement_interval) || 0;
            const globalLimit = parseInt(userData.achievement_limit) || 0;

            userData.achievement_sites.forEach(site => {
                userData.achievements[site] = {
                    limit: globalLimit * 60,
                    interval: globalInterval * 60,
                    message: "Time check!"
                };
            });
        }

        saveUserData(userId);
        console.log(`Settings updated for ${userId}`);
    });
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
        } catch (e) {
            console.error(`Error loading data for ${userId}`, e);
        }
    }

    // --- TRANSFORM: Flat format to Map (if from client) ---
    // Client sends: achievement_sites (Array), achievement_interval (Int), achievement_limit (Int)
    // Server expects: achievements (Map: domain -> { limit, interval, ... })
    if (userData.achievement_sites && Array.isArray(userData.achievement_sites)) {
        if (!userData.achievements) userData.achievements = {};

        const globalInterval = parseInt(userData.achievement_interval) || 0;
        const globalLimit = parseInt(userData.achievement_limit) || 0;

        userData.achievement_sites.forEach(site => {
            // Apply global config to each site if not already specifically set? 
            // Or overwrite? Let's overwrite to ensure syncing with client global settings.
            userData.achievements[site] = {
                limit: globalLimit * 60, // Client sends minutes, logic uses seconds
                interval: globalInterval * 60, // Client sends minutes
                message: "Time check!"
            };
        });
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

    // Trigger if:
    // 1. Limit is set and reached (limit > 0 && sessionSecs >= limit)
    // 2. OR Limit is NOT set (Unlimited) but Interval IS set, and we passed the interval (limit == 0 && interval > 0 && sessionSecs >= interval)
    // Actually, if Limit is 0, we treat it as 0. 
    // Logic: if limit > 0, we check limit. If limit == 0, we assume 'unlimited' but check intervals from 0.

    // Effective Start for Intervals
    // If limit > 0, intervals start AFTER limit.
    // If limit == 0, intervals start AFTER 0 (every X mins).

    const effectiveLimit = limit > 0 ? limit : 0;
    const shouldCheck = (limit > 0 && sessionSecs >= limit) || (limit === 0 && interval > 0 && sessionSecs >= interval);

    if (shouldCheck) {
        let shouldTrigger = false;
        let triggerType = "";

        // Initial Limit (only if real limit exists)
        if (limit > 0 && !entry.triggeredAchievements["limit_reached"]) {
            shouldTrigger = true;
            triggerType = "limit_reached";
        }
        else if (interval > 0) {
            // Calculate steps past the effective limit
            const timeSinceLimit = sessionSecs - effectiveLimit;
            // If limit is 0, timeSinceLimit = sessionSecs.

            const steps = Math.floor(timeSinceLimit / interval);
            if (steps > 0) {
                const stepKey = `interval_${steps}`;
                if (!entry.triggeredAchievements[stepKey]) {
                    shouldTrigger = true;
                    // If limit was 0, and we just hit first interval, step is 1.
                    triggerType = stepKey;
                }
            }
        }

        // Safety: If limit=0 and we are at 1st interval, we triggered. 

        if (shouldTrigger) {
            entry.triggeredAchievements[triggerType] = true;

            // Customize message for interval
            let msg = config.message || "Time Limit Reached!";
            if (triggerType.startsWith('interval_')) {
                const step = parseInt(triggerType.split('_')[1]);
                const totalTimeMins = Math.floor((effectiveLimit + (step * interval)) / 60);
                msg = `You've been here for ${totalTimeMins} minutes!`;
            }

            io.emit(`achievement_unlocked_${userId}`, {
                domain: domain,
                message: msg,
                type: 'limit'
            });
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
