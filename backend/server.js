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
        } catch (e) {
            console.error(`Error loading data for ${userId}`, e);
        }
    }
    statsCache.set(userId, userData);
    return userData;
}

function saveUserData(userId) {
    const data = statsCache.get(userId);
    if (!data) return;
    try {
        fs.writeFileSync(getDataFile(userId), JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Error saving data for ${userId}`, e);
    }
}

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

    entry.time += activeSecs;
    entry.video_time += videoSecs;
    entry.lastActiveTime = now;
    if (batch.icon) entry.icon = batch.icon;

    // Session Logic (Timeout 30m)
    const SESSION_TIMEOUT = 30 * 60 * 1000;
    const effectiveIncrement = Math.max(activeSecs, videoSecs);

    if (effectiveIncrement > 0) {
        if (!entry.lastSessionUpdate || (now - entry.lastSessionUpdate > SESSION_TIMEOUT)) {
            entry.sessions = (entry.sessions || 0) + 1;
            entry.currentSessionTime = 0;
            entry.triggeredAchievements = {};
        }
        entry.currentSessionTime += effectiveIncrement;
        entry.lastSessionUpdate = now;

        checkAchievements(domain, entry, userId);
    }

    throttledSave(userId);
    // Emit only to THIS user's socket room? 
    // We don't have rooms yet, but we can emit with ID.
    io.emit(`stats_update_${userId}`, todayStats);
}

function checkAchievements(domain, entry, userId) {
    const userData = statsCache.get(userId);
    if (!userData) return; // Should not happen if handleTimeBatch loaded it

    const achievements = userData.achievements;

    // Check against config
    for (const [targetDomain, rule] of Object.entries(achievements)) {
        if (isMatch(domain, targetDomain)) {
            const sessionSecs = entry.currentSessionTime;
            const limitSecs = rule.limit; // raw seconds for now (or minutes * 60)
            const intervalSecs = rule.interval;

            // Logic: 
            // 1. Must cross limit
            if (sessionSecs >= limitSecs) {
                let shouldTrigger = false;
                const lastTrigger = entry.triggeredAchievements[targetDomain] || 0;

                // Interval 0 -> Trigger once
                if (intervalSecs === 0) {
                    if (lastTrigger === 0) shouldTrigger = true;
                } else {
                    const lastCheckpoint = entry.triggeredAchievements[targetDomain] || 0;
                    if (lastCheckpoint === 0) {
                        shouldTrigger = true; // First time
                        entry.triggeredAchievements[targetDomain] = sessionSecs;
                    } else if (intervalSecs > 0 && (sessionSecs - lastCheckpoint >= intervalSecs)) {
                        shouldTrigger = true;
                        entry.triggeredAchievements[targetDomain] = sessionSecs;
                    }
                }
            }

            if (shouldTrigger) {
                // Emit only to CLIENT (via broadcast but isolated by ID event)
                // We change event name to achievement_unlocked_USERID
                io.emit(`achievement_unlocked_${userId}`, {
                    domain: domain,
                    message: rule.message,
                    time: sessionSecs
                });
                // Update state is done above in checkpoint
            }
        }
    }
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
    saveUserData(userId);

    io.emit(`stats_update_${userId}`, userData.todayStats);
    res.json({ success: true });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
