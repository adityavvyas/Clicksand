// content.js - The "Push" Engine
(() => {
    // Configuration
    const BATCH_INTERVAL_MS = 1000; // Live updates (1s)
    let activityBatch = {
        activeSeconds: 0,
        videoSeconds: 0
    };

    // State Tracking
    let lastUrl = location.href;

    // --- Core Logic: The Clock ---
    // --- Core Logic: The Clock ---
    let lastTick = Date.now();

    // Store last known video times to calculate delta
    const videoStates = new Map(); // videoElement -> lastTime

    setInterval(() => {
        const now = Date.now();
        const wallClockDelta = (now - lastTick) / 1000; // Fraction of seconds since last tick
        lastTick = now;

        const { isVideo, videoDelta } = calculateVideoProgress(wallClockDelta);

        // Frame Check
        const isMainFrame = (window === window.top);
        const isActive = document.hasFocus();

        if (isActive && isMainFrame) {
            // Count wall clock time for Active
            activityBatch.activeSeconds += 1; // 1 tick
        }

        if (isVideo) {
            // If video delta (content watched) is significantly higher than real time (speed > 1), use it.
            // But we must report in "seconds" for the backend to add.
            // If user watches 2s of content in 1s, we report 2s videoSeconds.
            activityBatch.videoSeconds += videoDelta;
        }

        // ... URL Change Detection or just periodic flush ...
        // Since we want 1s updates, we flush every tick if we have data.
        if (activityBatch.activeSeconds > 0 || activityBatch.videoSeconds > 0) {
            flushData();
        }

    }, 1000);

    // --- Helpers ---

    function flushData() {
        if (activityBatch.activeSeconds === 0 && activityBatch.videoSeconds === 0) return;

        const payload = {
            domain: window.location.hostname,
            activeSeconds: activityBatch.activeSeconds,
            videoSeconds: activityBatch.videoSeconds
        };

        // Reset local batch
        activityBatch.activeSeconds = 0;
        activityBatch.videoSeconds = 0;

        // Send to Background
        try {
            chrome.runtime.sendMessage({
                action: 'LOG_TIME_BATCH',
                data: payload
            });
        } catch (e) {
            // Context invalidated (extension updated/reloaded) - ignore
        }
    }

    function calculateVideoProgress(limitDelta) {
        const videos = document.querySelectorAll('video');
        let totalVideoDelta = 0;
        let anyPlaying = false;

        for (const v of videos) {
            if (!v.paused && !v.ended && v.readyState > 2) {
                anyPlaying = true;

                const curr = v.currentTime;
                const prev = videoStates.get(v);

                if (prev !== undefined) {
                    let delta = curr - prev;
                    if (delta > 0 && delta < 5) {
                        totalVideoDelta = Math.max(totalVideoDelta, delta);
                    }
                }
                videoStates.set(v, curr);
            } else {
                videoStates.delete(v);
            }
        }

        return { isVideo: anyPlaying, videoDelta: totalVideoDelta };
    }

    // Simple UI
    function showNotification(msg) {
        const div = document.createElement('div');
        div.style.position = 'fixed';
        div.style.bottom = '20px';
        div.style.right = '20px';
        div.style.background = '#222';
        div.style.color = '#fff';
        div.style.padding = '15px 25px';
        div.style.borderRadius = '8px';
        div.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
        div.style.zIndex = '999999';
        div.style.fontFamily = 'Inter, sans-serif';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.border = '1px solid #444';
        div.innerHTML = `
            <div style="font-size: 20px; margin-right: 10px;">🏆</div>
            <div>
                <div style="font-weight: bold; margin-bottom: 2px;">Achievement Unlocked</div>
                <div style="font-size: 14px; opacity: 0.8;">${msg}</div>
            </div>
        `;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 5000);
    }
})();
