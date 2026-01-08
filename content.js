// content.js
// Robust version using Port detection

let isContextInvalid = false;
let port = null;

// 1. Establish connection to verify context is alive
try {
    if (chrome.runtime && chrome.runtime.connect) {
        port = chrome.runtime.connect({ name: "keepalive" });
        port.onDisconnect.addListener(() => {
            // Background script died or extension reloaded
            console.log("[TimeTracker] Extension reloaded. Disabling old script.");
            isContextInvalid = true;
        });
    } else {
        isContextInvalid = true;
    }
} catch (e) {
    isContextInvalid = true;
}

function checkVideo() {
    if (isContextInvalid) return;

    try {
        // Double check runtime presence
        if (!chrome.runtime?.id) throw new Error("Context invalid");

        const videos = document.querySelectorAll('video');
        let playing = false;

        for (const v of videos) {
            if (!v.paused && !v.ended && v.readyState > 2) {
                playing = true;
                break;
            }
        }

        chrome.runtime.sendMessage({
            action: playing ? "VIDEO_PLAYING" : "VIDEO_PAUSED",
            domain: window.location.hostname
        }, (response) => {
            if (chrome.runtime.lastError) {
                // If message fails, assume context is gone
                isContextInvalid = true;
            }
        });

    } catch (e) {
        isContextInvalid = true;
    }
}

// 2. Poll Loop
const pollInterval = setInterval(() => {
    if (isContextInvalid) {
        clearInterval(pollInterval);
        return;
    }
    checkVideo();
}, 1000);

// 3. Visibility Listener
document.addEventListener('visibilitychange', () => {
    if (!isContextInvalid) checkVideo();
});
