try {
    importScripts('socket.io.min.js');
} catch (e) {
    console.error(e);
}

let userId = null;
let socket = null;

chrome.runtime.onInstalled.addListener(() => {
    console.log("Clicksand Proxy Installed");
    ensureUserId();
});

// Ensure we have a User ID
function ensureUserId() {
    chrome.storage.local.get('userId', (res) => {
        if (res.userId) {
            userId = res.userId;
            console.log("Identity Loaded:", userId);
            connectSocket();
        } else {
            userId = crypto.randomUUID();
            chrome.storage.local.set({ userId: userId });
            console.log("Identity Generated:", userId);
            connectSocket();
        }
    });
}

function connectSocket() {
    if (socket) return;
    try {
        socket = io('https://clicksand-production.up.railway.app');
        socket.on('connect', () => console.log("Background Socket Connected"));

        socket.on(`achievement_unlocked_${userId}`, (data) => {
            console.log("Achievement Received:", data);

            // Broadcast to active tab to show popup
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'SHOW_ACHIEVEMENT',
                        title: "Achievement Unlocked!",
                        message: data.message
                    });
                }
            });
        });

    } catch (e) {
        console.error("Socket Init Error:", e);
    }
}

// Load immediately on startup
ensureUserId();


// --- Proxy Logic ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'LOG_TIME_BATCH') {
        if (!userId) {
            // Should verify userId exists, if not, wait or drop?
            // For now, retry getting it if null
            ensureUserId();
        }

        // Inject User ID
        const payload = { ...request.data, userId: userId };

        // Proxy to Server
        fetch('https://clicksand-production.up.railway.app/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(err => console.error("Proxy Error:", err));

        sendResponse({ success: true });
        return false;
    }

    if (request.action === "PING") {
        sendResponse({ status: "alive" });
    }
});

// --- Total Browser Time Heartbeat ---
// We send a ping every 1 second to count "Browser Open Time"
setInterval(() => {
    if (userId) {
        fetch('https://clicksand-production.up.railway.app/api/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId })
        }).catch(() => { });
    }
}, 1000);
