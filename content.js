// content.js
// Optimized version using Event Listeners + MutationObserver with fallback polling

(() => {
    // Prevent duplicate injection if possible, or just Scope it.
    // Scoping is enough to prevent 'Identifier already declared' errors.

    // Optimized version using Event Listeners + MutationObserver + Robust Polling

    let isRuntimeGone = false; // Only true if chrome.runtime is undefined
    let lastKnownState = null;
    let lastKnownUrl = window.location.href; // Track URL for SPA navigation detection
    let urlCheckInterval = null;
    let pauseBuffer = 0; // Buffer to prevent flickering PAUSE states

    // 1. Verify Runtime
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
        isRuntimeGone = true;
    }

    // Send state to background
    function sendState(action, force = false) {
        if (isRuntimeGone) return;

        // Optimistic check: if we think we sent this, don't spam.
        // But if 'force' is true (heartbeat), we send anyway.
        if (!force && lastKnownState === action) return;

        try {
            if (!chrome.runtime?.id) {
                isRuntimeGone = true;
                return;
            }

            chrome.runtime.sendMessage({
                action: action,
                domain: window.location.hostname
            }, (response) => {
                // Ignore errors (like "receiving end does not exist" during SW wake-up)
                // Do NOT disable the script. SW will wake up eventually.
                if (chrome.runtime.lastError) {
                    // console.warn("Clicksand: Msg failed, retrying next tick.");
                }
            });

            lastKnownState = action;
        } catch (e) {
            // runtime might be gone
            if (!chrome.runtime?.id) isRuntimeGone = true;
        }
    }

    // Check all videos and determine overall state
    function checkAllVideos(force = false) {
        if (isRuntimeGone) return;

        const videos = document.querySelectorAll('video');
        let anyPlaying = false;

        for (const v of videos) {
            // Robust check: playing, not ended, has started
            if (!v.paused && !v.ended && v.currentTime > 0 && v.readyState >= 1) {
                anyPlaying = true;
                break;
            }
        }

        if (anyPlaying) {
            pauseBuffer = 0; // Reset buffer
            const action = "VIDEO_PLAYING";
            // FORCE heartbeat if requested
            if (force) sendState(action, true);
            else sendState(action, false);
        } else {
            // Buffer the PAUSE signal (approx 2 ticks / 2 seconds)
            // This prevents "Ad Transition" gaps or brief buffer pauses from cutting metrics
            if (pauseBuffer < 2) {
                pauseBuffer++;
                // Don't send yet, keep previous state
            } else {
                sendState("VIDEO_PAUSED", false);
            }
        }
    }

    // Attach event listeners to a video element
    const attachedVideos = new WeakSet();
    function attachVideoListeners(video) {
        if (isRuntimeGone) return;
        if (attachedVideos.has(video)) return;
        attachedVideos.add(video);

        video.addEventListener('play', () => checkAllVideos());
        video.addEventListener('pause', () => checkAllVideos());
        video.addEventListener('ended', () => checkAllVideos());
        video.addEventListener('volumechange', () => checkAllVideos());
    }

    // MutationObserver to detect dynamically added videos (SPAs like YouTube)
    const observer = new MutationObserver((mutations) => {
        if (isRuntimeGone) { observer.disconnect(); return; }
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeName === 'VIDEO') attachVideoListeners(node);
                if (node.querySelectorAll) {
                    node.querySelectorAll('video').forEach(attachVideoListeners);
                }
            });
        });
    });

    // Start observing
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });

    // Initial attachment for existing videos
    document.querySelectorAll('video').forEach(attachVideoListeners);

    // ROBUST Polling Loop (1s)
    // This acts as the heartbeat generator AND the state checker
    let tickCount = 0;
    setInterval(() => {
        if (isRuntimeGone) return;
        tickCount++;

        // Check state every second
        // Force Heartbeat (send message) every 10 seconds (tick % 10 === 0)
        // This keeps Service Worker alive
        checkAllVideos(tickCount % 10 === 0);
    }, 1000);

    // Visibility change listener
    document.addEventListener('visibilitychange', () => {
        if (!isRuntimeGone) checkAllVideos();
    });

    // Initial check
    checkAllVideos();

    // --- SPA URL Change Detection ---
    // YouTube and similar sites use History API for navigation without page reloads

    function notifyUrlChange() {
        if (isRuntimeGone) return;

        const currentUrl = window.location.href;
        if (currentUrl !== lastKnownUrl) {
            lastKnownUrl = currentUrl;

            // Reset state on navigation to be clean
            lastKnownState = null;
            pauseBuffer = 0;

            try {
                chrome.runtime.sendMessage({
                    action: "URL_CHANGED",
                    url: window.location.href,
                    domain: window.location.hostname
                }, () => chrome.runtime.lastError); // Consume error

                // Re-scan DOM
                setTimeout(() => {
                    document.querySelectorAll('video').forEach(attachVideoListeners);
                    checkAllVideos();
                }, 1000);
            } catch (e) { }
        }
    }

    // Intercept History API pushState (used by YouTube, React Router, etc.)
    const originalPushState = history.pushState;
    history.pushState = function (...args) {
        originalPushState.apply(this, args);
        setTimeout(notifyUrlChange, 50);
    };

    // Intercept History API replaceState
    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        setTimeout(notifyUrlChange, 50);
    };

    // Handle back/forward navigation
    window.addEventListener('popstate', () => {
        setTimeout(notifyUrlChange, 50);
    });

    // Fallback: Check URL periodically (catches edge cases)
    setInterval(() => {
        if (!isContextInvalid) {
            notifyUrlChange();
        }
    }, 1000);

    // --- Achievement Popup (Steam-Style) ---

    // --- Premium Achievement Popup ---

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

        document.body.appendChild(popup);

        // Remove after animation (6s)
        setTimeout(() => {
            if (popup.parentElement) popup.parentElement.removeChild(popup);
        }, 6100);
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'SHOW_ACHIEVEMENT') {
            showAchievementPopup(request.title, request.message);
            sendResponse({ status: 'ok' });
        }
        return true;
    });

})();
