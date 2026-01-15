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

        // --- URL Change Detection (SPA Support) ---
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            flushData();
        }

    }, 1000);

    // --- Helpers ---
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
                    // Sanity check: if delta is negative (seek back) or huge (seek forward), ignore
                    // "Huge" means > speed * limitDelta + buffer. 
                    // Let's say if > 5s jump, it's a seek.
                    if (delta > 0 && delta < 5) {
                        // This is valid playback
                        // If multiple videos playing? Rare. We just take the MAX or SUM? 
                        // Usually 1 main video. Let's take MAX to avoid double counting if duplicate streams.
                        totalVideoDelta = Math.max(totalVideoDelta, delta);
                    }
                }
                videoStates.set(v, curr);
            } else {
                videoStates.delete(v);
            }
        }

        // Return 0 if no video is playing, or the calculated delta
        // If the delta is tiny (e.g. 0.001), treat as 0? No, accumulate.

        return { isVideo: anyPlaying, videoDelta: totalVideoDelta };
    }

    /*
    function checkVideoPlaying() {
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
            // Check if playing, visible, and has started
            if (!v.paused && !v.ended && v.currentTime > 0 && v.readyState > 2) {
                return true;
            }
        }
        return false;
    }
    */

    // --- Achievement Popup Listener ---
    // Keeps the achievement UI logic you already had
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'SHOW_ACHIEVEMENT') {
            showAchievementPopup(request.title, request.message);
            sendResponse({ status: 'ok' });
        }
    });

    function injectAchievementStyles() {
        if (document.getElementById('clicksand-styles')) return;

        const style = document.createElement('style');
        style.id = 'clicksand-styles';
        style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

        @keyframes clicksand-slide-up {
            0% { transform: translateY(120px) scale(0.9); opacity: 0; }
            10% { transform: translateY(0) scale(1); opacity: 1; }
            90% { transform: translateY(0) scale(1); opacity: 1; }
            100% { transform: translateY(120px) scale(0.9); opacity: 0; }
        }

        @keyframes clicksand-glow {
            0% { box-shadow: 0 0 5px rgba(100, 200, 255, 0.2); }
            50% { box-shadow: 0 0 20px rgba(100, 200, 255, 0.6), 0 0 10px rgba(100, 200, 255, 0.4); }
            100% { box-shadow: 0 0 5px rgba(100, 200, 255, 0.2); }
        }

        .clicksand-achievement {
            position: fixed;
            bottom: 30px;
            right: 30px;
            width: 340px;
            background: rgba(22, 27, 34, 0.95);
            /* Gradient Border via Pseudo-element or box-shadow */
            border-left: 4px solid #58a6ff;
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            display: flex;
            align-items: center;
            padding: 16px;
            z-index: 2147483647;
            font-family: 'Inter', system-ui, sans-serif;
            color: #fff;
            animation: clicksand-slide-up 6s cubic-bezier(0.16, 1, 0.3, 1) forwards, clicksand-glow 3s infinite;
            pointer-events: none;
            overflow: hidden;
        }

        /* Subtle shine effect */
        .clicksand-achievement::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
        }

        .clicksand-icon-container {
            width: 48px;
            height: 48px;
            background: cubic-bezier(0.16, 1, 0.3, 1);
            background: linear-gradient(135deg, #1f6feb, #111b27);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-right: 16px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.1);
        }

        .clicksand-icon svg {
            width: 24px;
            height: 24px;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
        }

        .clicksand-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            min-width: 0; /* For text overflow */
        }

        .clicksand-title {
            font-size: 11px;
            text-transform: uppercase;
            color: #58a6ff;
            font-weight: 800;
            letter-spacing: 1px;
            margin-bottom: 4px;
            text-shadow: 0 0 10px rgba(88, 166, 255, 0.3);
        }

        .clicksand-msg {
            font-size: 14px;
            font-weight: 600;
            color: #e6edf3;
            line-height: 1.4;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
    `;
        document.head.appendChild(style);
    }

    function showAchievementPopup(title, message) {
        injectAchievementStyles();

        // Safe removal of old popups
        const existing = document.querySelectorAll('.clicksand-achievement');
        existing.forEach(el => el.remove());

        const popup = document.createElement('div');
        popup.className = 'clicksand-achievement';
        popup.innerHTML = `
        <div class="clicksand-icon-container">
            <div class="clicksand-icon">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 15C15.866 15 19 11.866 19 8H5C5 11.866 8.13401 15 12 15Z" fill="#FFD700" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M19 8C20.6569 8 22 6.65685 22 5C22 3.34315 20.6569 2 19 2H5C3.34315 2 2 3.34315 2 5C2 6.65685 3.34315 8 5 8" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M12 15V22" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M8 22H16" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
        </div>
        <div class="clicksand-content">
            <div class="clicksand-title">${title || "ACHIEVEMENT UNLOCKED"}</div>
            <div class="clicksand-msg">${message || "Keep up the great work!"}</div>
        </div>
    `;

        // Check for Fullscreen
        const fsElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;

        if (fsElement) {
            fsElement.appendChild(popup);
        } else {
            document.body.appendChild(popup);
        }

        // Remove after animation (6s)
        setTimeout(() => {
            if (popup.parentElement) popup.parentElement.removeChild(popup);
        }, 6100);
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
