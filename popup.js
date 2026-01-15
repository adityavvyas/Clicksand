// popup.js - Complete Implementation

let currentView = 'today';
let pinnedSites = [];
let sortOption = 'time-desc'; // Default sort: time high to low
// Store hit regions: { type: 'rect'|'arc', x, y, w, h, cx, cy, innerRadius, outerRadius, startAngle, endAngle, data: {} }
let chartRegions = [];
let socket = null; // Socket.io instance

// Icons
const PIN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L12 12M12 12L19 19M12 12L5 19M12 12L12 22"></path></svg>';
const ICON_PIN_FILLED = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#FBC02D" stroke="#F57F17" stroke-width="1.5"><path d="M16 12V4H8v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
const ICON_PIN_OUTLINE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 12V4H8v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;


// --- INITIALIZATION ---

async function initPins() {
    try {
        const data = await chrome.storage.local.get('pinnedSites');
        pinnedSites = data.pinnedSites || [];

        // Initialize Socket
        initSocket();

        loadData(currentView);
    } catch (e) {
        console.error("Error initPins", e);
    }
}

function initSocket() {
    try {
        socket = io('http://localhost:3000');

        socket.on('connect', () => {
            console.log('Connected to backend');
        });

        // Listen for USER SPECIFIC updates
        socket.on(`stats_update_${userId}`, (stats) => {
            // Only update if we are in 'today' view to avoid jitter in historical views
            if (currentView === 'today') {
                // We received the new todayStats directly
                renderViewWithData('today', { today_stats: stats }, null);
            }
        });

    } catch (e) {
        console.error("Socket error", e);
    }
}

function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // function to update DOM
            const updateDOM = () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentView = tab.dataset.view;

                const f = document.getElementById('monthly-footer');
                if (f) f.classList.toggle('hidden', currentView !== 'monthly');

                const tc = document.getElementById('timeChart');
                const wc = document.getElementById('weeklyChart');
                const sp = document.getElementById('settings-panel');
                const cc = document.getElementById('chart-container');
                const bc = document.getElementById('browser-time-container');
                const pc = document.getElementById('pinned-container');
                const sl = document.getElementById('stats-list');
                const sc = document.getElementById('sort-container');
                const lg = document.getElementById('chart-legend');
                const allSitesTitle = document.querySelector('[data-section="all-sites"]');

                // Settings view handling
                if (currentView === 'settings') {
                    if (sp) sp.classList.remove('hidden');
                    if (cc) cc.classList.add('hidden');
                    if (bc) bc.classList.add('hidden');
                    if (pc) pc.classList.add('hidden');
                    if (sl) sl.classList.add('hidden');
                    if (sc) sc.classList.add('hidden');
                    if (lg) lg.classList.add('hidden');
                    if (allSitesTitle) allSitesTitle.classList.add('hidden');
                } else {
                    // Restore all visibility when leaving settings
                    if (sp) sp.classList.add('hidden');
                    if (cc) cc.classList.remove('hidden');
                    if (bc) bc.classList.remove('hidden');
                    if (sl) sl.classList.remove('hidden');
                    if (sc) sc.classList.remove('hidden');
                    if (lg) lg.classList.remove('hidden');
                    if (allSitesTitle) allSitesTitle.classList.remove('hidden');
                    if (pc) pc.classList.remove('hidden');
                }

                if (tc) tc.classList.toggle('hidden', currentView === 'weekly');
                if (wc) wc.classList.toggle('hidden', currentView !== 'weekly');

                // Re-load data so charts animate if needed (though they are canvas)
                loadData(currentView);
            };

            // Use View Transitions API if available
            if (document.startViewTransition) {
                document.startViewTransition(() => {
                    updateDOM();
                });
            } else {
                updateDOM();
            }
        });
    });

    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);

    // Sort dropdown handler
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            sortOption = sortSelect.value;
            loadData(currentView);
        });
    }
    // Reset Data Logic
    const resetBtn = document.getElementById('reset-data-btn');
    const modal = document.getElementById('confirmation-modal');
    const cancelBtn = document.getElementById('cancel-reset-btn');
    const confirmBtn = document.getElementById('confirm-reset-btn');

    if (resetBtn && modal && cancelBtn && confirmBtn) {
        resetBtn.addEventListener('click', () => {
            modal.classList.remove('hidden');
        });

        cancelBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
        });

        confirmBtn.addEventListener('click', async () => {
            // Disable button
            confirmBtn.disabled = true;
            confirmBtn.innerText = "Deleting...";

            try {
                // Call Backend Reset
                await fetch('http://localhost:3000/api/reset', { method: 'POST' });

                // Clear local caches in popup (refresh)
                await loadData('today');

                // Show success checkmark briefly? or just hide
                setTimeout(() => {
                    modal.classList.add('hidden');
                    confirmBtn.disabled = false;
                    confirmBtn.innerText = "Delete";
                    // Maybe refreshing the view
                    window.location.reload();
                }, 1000);
            } catch (e) {
                console.error("Reset failed", e);
                confirmBtn.innerText = "Error";
                setTimeout(() => {
                    confirmBtn.disabled = false;
                    confirmBtn.innerText = "Delete";
                }, 2000);
            }
        });
    }
}

function initTooltips() {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;

    const canvases = ['timeChart', 'weeklyChart'];

    canvases.forEach(id => {
        const canvas = document.getElementById(id);
        if (!canvas) return;

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            // Mouse relative to canvas element (0,0 is top-left of canvas)
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            let hit = null;

            // Check regions
            for (let i = chartRegions.length - 1; i >= 0; i--) {
                const r = chartRegions[i];
                if (r.chartId !== id) continue;

                if (r.type === 'rect') {
                    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                        hit = r;
                        break;
                    }
                } else if (r.type === 'arc') {
                    // Check if mouse is within radius range
                    const dx = x - r.cx;
                    const dy = y - r.cy;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist >= r.innerRadius && dist <= r.outerRadius) {
                        const angle = Math.atan2(dy, dx);
                        if (isAngleInSlice(angle, r.startAngle, r.endAngle)) {
                            hit = r;
                            break;
                        }
                    }
                }
            }

            if (hit) {
                // Style matches "Speech Bubble"
                // Content
                tooltip.innerHTML = `<div style="font-weight:bold; margin-bottom:2px;">${hit.data.label}</div><div style="color:#666;">${formatTime(hit.data.value)}</div>`;
                tooltip.style.display = 'block';

                // Position: Centered above the cursor (so arrow points down to cursor)
                // We add an offset so it doesn't cover the cursor
                const tooltipRect = tooltip.getBoundingClientRect();
                const w = tooltipRect.width;
                const h = tooltipRect.height;

                let tx = e.pageX - (w / 2);
                let ty = e.pageY - h - 15; // 15px above

                // Boundary check
                if (tx < 5) tx = 5;
                if (tx + w > document.body.clientWidth - 5) tx = document.body.clientWidth - w - 5;
                if (ty < 5) ty = e.pageY + 15; // If too close to top, flip to bottom? (CSS arrow won't flip but text is readable)

                tooltip.style.left = tx + 'px';
                tooltip.style.top = ty + 'px';
            } else {
                tooltip.style.display = 'none';
            }
        });

        canvas.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
        });
    });
}


// --- API & Data ---
async function loadData(view) {
    try {
        const res = await fetch(`http://localhost:3000/api/stats?userId=${userId}`);
        if (!res.ok) throw new Error("Backend offline");

        const data = await res.json();
        const liveToday = data.todayStats || {};
        const history = data.history || {};

        // Helper to render based on fetched data
        renderViewWithData(view, { today_stats: liveToday, history: history }, null);

    } catch (e) {
        console.error("Error loadData", e);
        document.getElementById('stats-list').innerHTML = '<div style="padding:20px; color:red;">State: Backend Offline<br><small>Run "npm start" in backend folder</small></div>';
    }
}

// Extracted render logic to reuse for socket updates
function renderViewWithData(view, data, _unused) {
    const liveToday = data.today_stats || {};
    const history = data.history || {};

    if (view === 'weekly') {
        const aggregated = aggregateWeekly(history, liveToday);
        renderBrowserTime(aggregated.browser_time);

        const pinnedStats = {};
        const otherStats = {};
        Object.entries(aggregated).forEach(([domain, info]) => {
            if (domain === 'browser_time') return;
            let inf = (typeof info === 'number') ? { time: info } : info;
            if (pinnedSites.includes(domain)) pinnedStats[domain] = inf;
            else otherStats[domain] = inf;
        });

        renderPinned(pinnedStats);
        renderList(otherStats);
        renderWeeklyChart(history, liveToday);
        return;
    }

    if (view === 'monthly') {
        const aggregated = aggregateMonthly(history, liveToday);
        renderBrowserTime(aggregated.browser_time);

        const pinnedStats = {};
        const otherStats = {};
        Object.entries(aggregated).forEach(([domain, info]) => {
            if (domain === 'browser_time') return;
            let inf = (typeof info === 'number') ? { time: info } : info;
            if (pinnedSites.includes(domain)) pinnedStats[domain] = inf;
            else otherStats[domain] = inf;
        });

        renderPinned(pinnedStats);
        renderList(otherStats);
        renderChart(aggregated);
        return;
    }

    // View === 'today'
    renderBrowserTime(liveToday.browser_time || 0);

    const pinnedStats = {};
    const otherStats = {};

    Object.entries(liveToday).forEach(([domain, info]) => {
        if (domain === 'browser_time') return;
        if (!info) return;

        if (pinnedSites.includes(domain)) {
            pinnedStats[domain] = info;
        } else {
            otherStats[domain] = info;
        }
    });

    renderPinned(pinnedStats);
    renderList(otherStats);
    renderChart(liveToday);
}


// --- RENDERERS ---

function renderBrowserTime(time) {
    const el = document.getElementById('total-browser-time');
    if (el) el.textContent = formatTime(time || 0);
}

function renderPinned(stats) {
    const container = document.getElementById('pinned-list');
    const wrapper = document.getElementById('pinned-container');
    if (!container || !wrapper) return;

    // Sort safely
    const entries = Object.entries(stats).sort((a, b) => (b[1].time || 0) - (a[1].time || 0));

    if (entries.length === 0) {
        wrapper.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    wrapper.style.display = 'block';

    // Map existing elements
    const existingMap = new Map();
    Array.from(container.children).forEach(el => {
        if (el.dataset.domain) existingMap.set(el.dataset.domain, el);
    });

    entries.forEach(([domain, info]) => {
        let item = existingMap.get(domain);

        if (!item) {
            item = document.createElement('div');
            item.className = 'item'; // Standard Item Style
            // Removing specific green background to match "other sites"
            // But maybe keep a subtle border to distinguish?
            // User asked for "same details", implies same look.
            // But we want to show it IS pinned. The header "Pinned" does that.
            item.dataset.domain = domain;

            const pinBtn = document.createElement('div');
            pinBtn.innerHTML = ICON_PIN_FILLED; // Filled to show it IS pinned
            pinBtn.style.cursor = 'pointer';
            pinBtn.style.marginRight = '10px';
            pinBtn.style.display = 'flex';
            pinBtn.title = "Unpin";
            pinBtn.onclick = async () => {
                pinnedSites = pinnedSites.filter(s => s !== domain);
                await chrome.storage.local.set({ pinnedSites });
                loadData(currentView);
            };

            const img = document.createElement('img');
            img.className = 'icon';
            img.src = info.icon || _favicon(domain);

            const dom = document.createElement('div');
            dom.className = 'domain';

            const time = document.createElement('div');
            time.className = 'time';

            item.appendChild(pinBtn);
            item.appendChild(img);
            item.appendChild(dom);
            item.appendChild(time);
        }

        // Update Content
        const dom = item.querySelector('.domain');
        const time = item.querySelector('.time');

        let html = `<div>${domain}</div>`;
        const sessions = info.sessions || 0;
        const hasVideoTime = (info.video_time !== undefined && info.video_time > 0);

        if (hasVideoTime) {
            html += `<div style="font-size:10px; color:var(--text-muted);">Video: <b>${formatTime(info.video_time)}</b> | Active: ${formatTime(info.time)} | ${sessions} session${sessions !== 1 ? 's' : ''}</div>`;
        } else {
            html += `<div style="font-size:10px; color:var(--text-muted);">${sessions} session${sessions !== 1 ? 's' : ''}</div>`;
        }

        // We omit the progress bar for Pinned items to avoid confusion with the "All Sites" percentage
        // unless we passed global total. Simpler is cleaner.

        if (dom.innerHTML !== html) dom.innerHTML = html;

        const timeText = formatTime(info.time);
        if (time.textContent !== timeText) time.textContent = timeText;

        container.appendChild(item); // Reorder/Append
    });

    // Remove unused
    const newDomains = new Set(entries.map(e => e[0]));
    Array.from(container.children).forEach(el => {
        if (!newDomains.has(el.dataset.domain)) el.remove();
    });
}

async function renderList(stats) {
    const container = document.getElementById('stats-list');
    if (!container) return;

    // Sort based on sortOption
    let sorted = Object.entries(stats);

    switch (sortOption) {
        case 'time-desc':
            sorted.sort((a, b) => (b[1].time || 0) - (a[1].time || 0));
            break;
        case 'time-asc':
            sorted.sort((a, b) => (a[1].time || 0) - (b[1].time || 0));
            break;
        case 'sessions-desc':
            sorted.sort((a, b) => (b[1].sessions || 0) - (a[1].sessions || 0));
            break;
        case 'sessions-asc':
            sorted.sort((a, b) => (a[1].sessions || 0) - (b[1].sessions || 0));
            break;
        case 'name-asc':
            sorted.sort((a, b) => a[0].localeCompare(b[0]));
            break;
        case 'name-desc':
            sorted.sort((a, b) => b[0].localeCompare(a[0]));
            break;
        default:
            sorted.sort((a, b) => (b[1].time || 0) - (a[1].time || 0));
    }

    sorted = sorted.slice(0, 50);

    if (sorted.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#888">No data found</div>';
        return;
    }

    // If currently showing "No data found", clear it
    if (container.children.length > 0 && !container.children[0].classList.contains('item')) {
        container.innerHTML = '';
    }

    // Calculate total sessions for percentage
    const totalSessions = Object.values(stats).reduce((sum, s) => sum + (s.sessions || 0), 0);

    const existingMap = new Map();
    Array.from(container.children).forEach(el => {
        if (el.dataset.domain) existingMap.set(el.dataset.domain, el);
    });

    for (const [domain, info] of sorted) {
        if (!info) continue;

        let item = existingMap.get(domain);

        if (!item) {
            item = document.createElement('div');
            item.className = 'item';
            item.dataset.domain = domain;

            const pinBtn = document.createElement('div');
            pinBtn.innerHTML = ICON_PIN_OUTLINE;
            pinBtn.style.cursor = 'pointer';
            pinBtn.style.marginRight = '10px';
            pinBtn.style.display = 'flex';
            pinBtn.title = "Pin to top";
            pinBtn.onclick = async () => {
                if (!pinnedSites.includes(domain)) {
                    pinnedSites.push(domain);
                    await chrome.storage.local.set({ pinnedSites });
                    loadData(currentView);
                }
            };

            const img = document.createElement('img');
            img.className = 'icon';
            img.src = info.icon || _favicon(domain);

            const dom = document.createElement('div');
            dom.className = 'domain';

            const time = document.createElement('div');
            time.className = 'time';

            item.appendChild(pinBtn);
            item.appendChild(img);
            item.appendChild(dom);
            item.appendChild(time);
        }

        // Update content
        const dom = item.querySelector('.domain');
        const time = item.querySelector('.time');

        let html = `<div>${domain}</div>`;
        const sessions = info.sessions || 0;
        const hasVideoTime = (info.video_time !== undefined && info.video_time > 0);

        // Percentage Calculation
        let percent = 0;
        if (totalSessions > 0) {
            percent = (sessions / totalSessions) * 100;
        }

        if (hasVideoTime) {
            html += `<div style="font-size:10px; color:var(--text-muted);">Video: <b>${formatTime(info.video_time)}</b> | Active: ${formatTime(info.time)} | ${sessions} session${sessions !== 1 ? 's' : ''}</div>`;
        } else {
            html += `<div style="font-size:10px; color:var(--text-muted);">${sessions} session${sessions !== 1 ? 's' : ''}</div>`;
        }

        // Progress Bar
        html += `
        <div style="width:100%; height:4px; background:#eee; border-radius:2px; margin-top:4px; overflow:hidden;">
            <div style="width:${percent}%; height:100%; background:var(--accent); border-radius:2px;"></div>
        </div>
        `;

        if (dom.innerHTML !== html) dom.innerHTML = html;

        const timeText = formatTime(info.time);
        if (time.textContent !== timeText) time.textContent = timeText;

        container.appendChild(item);
    }

    // Remove unused
    const newDomains = new Set(sorted.map(e => e[0]));
    Array.from(container.children).forEach(el => {
        if (el.dataset.domain && !newDomains.has(el.dataset.domain)) el.remove();
    });
}


// --- CHART RENDERERS ---

function renderWeeklyChart(history, todayStats) {
    chartRegions = chartRegions.filter(r => r.chartId !== 'weeklyChart');

    const canvas = document.getElementById('weeklyChart');
    const legendContainer = document.getElementById('chart-legend');
    const chartContainer = document.getElementById('chart-container');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // SWITCH TO COLUMN LAYOUT due to user request for labels
    if (chartContainer) {
        chartContainer.style.flexDirection = 'column';
        chartContainer.style.alignItems = 'center';
    }

    // Get Theme Colors
    const style = getComputedStyle(document.body);
    const textColor = style.getPropertyValue('--text-primary').trim();
    const mutedColor = style.getPropertyValue('--text-muted').trim();

    // CLEAR LEGEND to prevent flexbox squeezing before rebuilding
    if (legendContainer) legendContainer.innerHTML = '';

    const dpr = window.devicePixelRatio || 1;

    // We hardcode a width that fits nicely with full container
    const containerWidth = document.getElementById('chart-container').clientWidth;
    // If container not rendered, fallback
    const graphWidthAlloc = containerWidth > 0 ? (containerWidth - 140) : 320;

    canvas.width = graphWidthAlloc * dpr;
    canvas.height = 160 * dpr;
    canvas.style.width = graphWidthAlloc + 'px';
    canvas.style.height = '160px'; // Shorter than Today chart
    ctx.scale(dpr, dpr);

    const width = canvas.width / dpr;
    const height = 160;

    // Aggregates
    const days = [];
    const siteTotals = {};

    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];

        let dataForDay = {};
        if (i === 0) dataForDay = todayStats || {};
        else if (history && history[dateStr]) dataForDay = history[dateStr];

        days.push({
            date: dateStr,
            label: d.toLocaleDateString('en-US', { weekday: 'short' }),
            data: dataForDay
        });

        Object.entries(dataForDay).forEach(([domain, info]) => {
            if (domain === 'browser_time') return;
            const t = (typeof info === 'number') ? info : info.time;
            siteTotals[domain] = (siteTotals[domain] || 0) + (t || 0);
        });
    }

    const topSites = Object.entries(siteTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(x => x[0]);

    // Color Generation (Once per chart to ensure consistency across bars)
    const siteColorMap = {};
    const usedColors = new Set();
    topSites.forEach(site => {
        siteColorMap[site] = getSiteColor(site, usedColors);
    });

    // Populate Legend (Weekly Totals)
    if (legendContainer) {
        // Horizontal Legend for Column Layout
        legendContainer.style.maxWidth = '100%';
        legendContainer.style.flexDirection = 'row';
        legendContainer.style.flexWrap = 'wrap';
        legendContainer.style.justifyContent = 'center';
        legendContainer.style.gap = '15px';

        topSites.forEach(site => {
            const div = document.createElement('div');
            div.className = 'legend-item';
            div.innerHTML = `
                <div class="legend-color" style="background: ${siteColorMap[site]}"></div>
                <span class="legend-label" title="${site}">${site}</span>
                <span class="legend-time">${formatTime(siteTotals[site])}</span>
            `;
            legendContainer.appendChild(div);
        });
    }


    // Draw Graph
    const paddingX = 40;
    const paddingY = 20;
    const drawW = width - paddingX;
    const drawH = height - paddingY - 10;

    // Scale
    let maxDaily = 0;
    days.forEach(day => {
        let dailyTotal = 0;
        Object.entries(day.data).forEach(([d, v]) => {
            if (d === 'browser_time') return;
            dailyTotal += (v.time || 0);
        });
        if (dailyTotal > maxDaily) maxDaily = dailyTotal;
    });
    if (maxDaily < 3600) maxDaily = 3600;

    ctx.clearRect(0, 0, width, height);

    const barWidth = (drawW - paddingX) / 7 * 0.7;
    const step = (drawW - paddingX) / 7;

    days.forEach((day, index) => {
        const barX = paddingX + (step * index) + (step - barWidth) / 2;
        let currentY = drawH;

        // Draw Stacked Bars
        topSites.forEach(site => {
            const val = (day.data[site] && day.data[site].time) || 0;
            if (val > 0) {
                const h = (val / maxDaily) * drawH;
                ctx.fillStyle = siteColorMap[site];

                // Rounded top for top-most segment? Hard to calculate.
                // Just rect.
                ctx.fillRect(barX, currentY - h, barWidth, h);

                chartRegions.push({
                    chartId: 'weeklyChart',
                    type: 'rect',
                    x: barX,
                    y: currentY - h,
                    w: barWidth,
                    h: h,
                    data: { label: site, value: val }
                });

                currentY -= h;
            }
        });

        // Others
        let others = 0;
        Object.entries(day.data).forEach(([d, v]) => {
            if (d === 'browser_time') return;
            if (topSites.includes(d)) return;
            others += (v.time || 0);
        });
        if (others > 0) {
            const h = (others / maxDaily) * drawH;
            ctx.fillStyle = params = style.getPropertyValue('--border').trim() || '#e0e0e0';
            ctx.fillRect(barX, currentY - h, barWidth, h);

            chartRegions.push({
                chartId: 'weeklyChart',
                type: 'rect',
                x: barX,
                y: currentY - h,
                w: barWidth,
                h: h,
                data: { label: 'Others', value: others }
            });
        }

        // Labels
        ctx.fillStyle = mutedColor;
        ctx.textAlign = 'center';
        ctx.font = '500 10px Inter';
        ctx.fillText(day.label, barX + barWidth / 2, height - 5);
    });

    // Y-Axis Labels
    ctx.textAlign = 'right';
    ctx.font = '500 10px Inter';
    ctx.fillStyle = mutedColor;
    ctx.fillText(`${(maxDaily / 3600).toFixed(1)}h`, paddingX - 8, 10);
    ctx.fillText("0", paddingX - 8, drawH);
}


function renderChart(stats) {
    if (currentView === 'weekly') return;

    chartRegions = chartRegions.filter(r => r.chartId !== 'timeChart');

    const canvas = document.getElementById('timeChart');
    const legendContainer = document.getElementById('chart-legend');
    const chartContainer = document.getElementById('chart-container');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // RESTORE ROW LAYOUT for Today View
    if (chartContainer) {
        chartContainer.style.flexDirection = 'row';
        chartContainer.style.alignItems = 'center';
    }
    // Restore Legend Styles
    if (legendContainer) {
        legendContainer.style.maxWidth = '160px'; // Original
        legendContainer.style.flexDirection = 'column';
        legendContainer.style.flexWrap = 'nowrap';
        legendContainer.style.justifyContent = 'flex-start';
        legendContainer.style.gap = '8px';
    }

    // Get Theme Colors
    const style = getComputedStyle(document.body);
    const textColor = style.getPropertyValue('--text-primary').trim();
    const mutedColor = style.getPropertyValue('--text-muted').trim();
    const bgColor = style.getPropertyValue('--bg-secondary').trim(); // For clearing if needed, or matching bg

    const size = 150; // Compact size
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    const chartStats = { ...stats };
    delete chartStats.browser_time;

    // Use Max(active, video) for the chart value
    const sorted = Object.entries(chartStats).sort((a, b) => {
        const valA = Math.max(a[1].time || 0, a[1].video_time || 0);
        const valB = Math.max(b[1].time || 0, b[1].video_time || 0);
        return valB - valA;
    });

    const total = sorted.reduce((sum, item) => {
        const val = Math.max(item[1].time || 0, item[1].video_time || 0);
        return sum + val;
    }, 0);

    const center = size / 2;
    const radius = 65;
    const thickness = 20;

    // Clear legend
    if (legendContainer) legendContainer.innerHTML = '';

    // Helper to draw segment
    function drawSegment(start, end, color) {
        ctx.beginPath();
        ctx.arc(center, center, radius, start, end);
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        ctx.stroke();
    }

    let startAngle = -0.5 * Math.PI;

    if (total === 0) {
        drawSegment(0, 2 * Math.PI, style.getPropertyValue('--border').trim());

        ctx.fillStyle = mutedColor;
        ctx.font = '600 14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText("No Activity", center, center);
        return;
    }

    const topItems = sorted.slice(0, 6); // Top 6 is cleaner
    const legendItems = [];

    // Color Setup for Today Chart
    const usedColors = new Set();

    topItems.forEach((item, index) => {
        const t = Math.max(item[1].time || 0, item[1].video_time || 0);
        const sliceAngle = (t / total) * 2 * Math.PI;
        // Use Smart Brand Color
        const color = getSiteColor(item[0], usedColors);

        // Draw Segment
        // Add tiny gap? No, seamlessly looks better for time
        drawSegment(startAngle, startAngle + sliceAngle, color);

        // Interaction Region (approximate with arc)
        chartRegions.push({
            chartId: 'timeChart',
            type: 'arc',
            cx: center,
            cy: center,
            innerRadius: radius - thickness / 2,
            outerRadius: radius + thickness / 2,
            startAngle: startAngle,
            endAngle: startAngle + sliceAngle,
            data: { label: item[0], value: t }
        });

        legendItems.push({ domain: item[0], time: t, color: color });
        startAngle += sliceAngle;
    });

    if (sorted.length > 6) {
        const remaining = sorted.slice(6).reduce((sum, item) => sum + (item[1].time || 0), 0);
        const sliceAngle = (remaining / total) * 2 * Math.PI;

        drawSegment(startAngle, startAngle + sliceAngle, '#e0e0e0');

        chartRegions.push({
            chartId: 'timeChart',
            type: 'arc',
            cx: center,
            cy: center,
            innerRadius: radius - thickness / 2,
            outerRadius: radius + thickness / 2,
            startAngle: startAngle,
            endAngle: startAngle + sliceAngle,
            data: { label: 'Others', value: remaining }
        });

        legendItems.push({ domain: 'Others', time: remaining, color: '#e0e0e0' });
    }

    // Center Text
    ctx.fillStyle = textColor;
    ctx.font = 'bold 20px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatTime(total).split(' ')[0], center, center - 10); // "2h"

    ctx.fillStyle = mutedColor;
    ctx.font = '500 12px Inter, sans-serif';
    ctx.fillText(formatTime(total).split(' ').slice(1).join(' ') || 'Total', center, center + 12);

    // Render legend
    if (legendContainer) {
        legendItems.forEach(item => {
            const div = document.createElement('div');
            div.className = 'legend-item';
            div.innerHTML = `
                <div class="legend-color" style="background: ${item.color}"></div>
                <span class="legend-label" title="${item.domain}">${item.domain}</span>
                <span class="legend-time">${formatTime(item.time)}</span>
            `;
            legendContainer.appendChild(div);
        });
    }
}


// --- UTILITY ---

function aggregateWeekly(history, today) {
    return aggregateDays(history, today, 7);
}

function aggregateMonthly(history, today) {
    return aggregateDays(history, today, 30);
}

function aggregateDays(history, today, daysCount) {
    const stats = {};
    const todayDate = new Date();
    const parseDate = (str) => new Date(str);

    if (history) {
        Object.entries(history).forEach(([dateStr, dayStats]) => {
            const d = parseDate(dateStr);
            const diffTime = Math.abs(todayDate - d);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays <= daysCount) {
                mergeStats(stats, dayStats);
            }
        });
    }
    if (today) mergeStats(stats, today);
    return stats;
}

function mergeStats(target, source) {
    if (source.browser_time) target.browser_time = (target.browser_time || 0) + source.browser_time;
    Object.entries(source).forEach(([domain, info]) => {
        if (domain === 'browser_time') return;
        if (!target[domain]) target[domain] = { time: 0, total_tab_time: 0, icon: info.icon };
        const t = (typeof info === 'number') ? info : (info.time || 0);
        target[domain].time += t;
        if (info.total_tab_time) target[domain].total_tab_time += info.total_tab_time;
    });
}

// --- COLOR SYSTEM ---

const BRAND_COLORS = {
    'youtube.com': '#FF0000',
    'google.com': '#4285F4',
    'facebook.com': '#1877F2',
    'twitter.com': '#1DA1F2',
    'x.com': '#000000',
    'instagram.com': '#E1306C', // Pink/Purple gradient usually, pick dominant
    'linkedin.com': '#0077B5',
    'github.com': '#181717', // Dark
    'reddit.com': '#FF4500',
    'twitch.tv': '#9146FF',
    'amazon.com': '#FF9900',
    'netflix.com': '#E50914',
    'wikipedia.org': '#000000',
    'stackoverflow.com': '#F48024',
    'chatgpt.com': '#74aa9c',
    'openai.com': '#74aa9c',
    'whatsapp.com': '#25D366',
    'spotify.com': '#1DB954',
    'tiktok.com': '#000000',
    'bing.com': '#008373',
    'duckduckgo.com': '#DE5833',
    'discord.com': '#5865F2',
    'microsoft.com': '#F25022',
    'apple.com': '#A2AAAD',
    'gmail.com': '#EA4335',
    'outlook.com': '#0078D4',
    'yahoo.com': '#6001D2'
};

function getSiteColor(domain, usedColors = new Set()) {
    let color = null;

    // 1. Check Brand Colors
    // Normalize to handle subdomains loosely if needed, but usually strict match or 'ends with' is better
    // Simple exact match first
    for (const [key, val] of Object.entries(BRAND_COLORS)) {
        if (domain === key || domain.endsWith('.' + key)) {
            color = val;
            break;
        }
    }

    // 2. Fallback to Hash
    if (!color) {
        color = stringToColor(domain);
    }

    // 3. Collision Avoidance (The "Second Unique Color" Logic)
    // If this color is already used (or very close), shift it.
    // Since we can't easily check "visual closeness" efficiently without a huge lib,
    // we'll rely on strict string equality of hex codes first for 'usedColors'.
    // If exact match found, we shift hue.

    let iterations = 0;
    while (usedColors.has(color) && iterations < 10) {
        // Shift Hue
        color = shiftColor(color, 30 * (iterations + 1));
        iterations++;
    }

    usedColors.add(color);
    return color;
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    // Use consistent Saturation/Lightness for nice UI
    return hslToHex(h, 75, 50);
}

function shiftColor(hex, degree) {
    let [h, s, l] = hexToHsl(hex);
    h = (h + degree) % 360;
    return hslToHex(h, s * 100, l * 100);
}

function hexToHsl(hex) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16) / 255;
    let g = parseInt(hex.substring(2, 4), 16) / 255;
    let b = parseInt(hex.substring(4, 6), 16) / 255;

    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }
    return [h, s, l];
}

// Helper: HSL to Hex
function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function _favicon(domain) {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

function formatTime(seconds) {
    if (!seconds && seconds !== 0) return '00:00:00';

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

function isAngleInSlice(angle, start, end) {
    const normalize = (a) => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const nAngle = normalize(angle);
    const nStart = normalize(start);
    const nEnd = normalize(end);

    if (nStart < nEnd) return nAngle >= nStart && nAngle <= nEnd;
    if (nStart > nEnd) return nAngle >= nStart || nAngle <= nEnd;
    return false;
}

// --- EXPORT ---

async function exportCSV() {
    try {
        const data = await chrome.storage.local.get(['history', 'today_stats', 'currentDate']);
        const history = data.history || {};
        const today = data.today_stats || {};
        const todayDate = data.currentDate || new Date().toISOString().split('T')[0];

        // Merge today into history for export
        const fullHistory = { ...history, [todayDate]: today };

        let csvContent = "Date,Domain,Active Time (s),Video Time (s),Tab Time (s)\n";

        // Sort dates descending
        const dates = Object.keys(fullHistory).sort().reverse();

        dates.forEach(date => {
            const dayStats = fullHistory[date];
            if (!dayStats) return;

            Object.entries(dayStats).forEach(([domain, info]) => {
                if (domain === 'browser_time') return;

                // Handle legacy format (number) vs new format (object)
                const time = (typeof info === 'number') ? info : (info.time || 0);
                const tabTime = (typeof info === 'object' && info.total_tab_time) ? info.total_tab_time : 0;

                // Check if video time is meaningful (for this app logic, time IS video time if tracked as such)
                // We'll output: Active Time (general), Video Time (if active), Tab Time

                csvContent += `${date},${domain},${time},${time},${tabTime}\n`;
            });
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "time_tracker_export.csv");
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (e) {
        console.error("Export failed", e);
        alert("Failed to export data");
    }
}

// --- SETTINGS ---

async function initSettings() {
    const toggle = document.getElementById('video-budget-toggle');
    const slider = document.getElementById('video-budget-slider');
    const display = document.getElementById('budget-limit-display');
    const limitSection = document.getElementById('budget-limit-section');
    const themeSelect = document.getElementById('theme-select');
    const compactToggle = document.getElementById('compact-toggle');

    if (!toggle || !slider) return;

    // Load current settings
    try {
        const data = await chrome.storage.local.get(['video_budget', 'app_settings']);
        const budget = data.video_budget || { enabled: false, limit: 3600 };
        const settings = data.app_settings || { theme: 'default', compact: false };

        toggle.checked = budget.enabled;
        slider.value = Math.floor(budget.limit / 60);
        updateLimitDisplay(slider.value);
        limitSection.style.opacity = budget.enabled ? '1' : '0.5';

        // Apply theme
        if (themeSelect) {
            themeSelect.value = settings.theme;
            document.documentElement.setAttribute('data-theme', settings.theme);
        }

        // Apply compact mode
        if (compactToggle) {
            compactToggle.checked = settings.compact;
            if (settings.compact) document.body.classList.add('compact');
        }
    } catch (e) {
        console.error("Error loading settings", e);
    }

    // Video budget toggle handler
    toggle.addEventListener('change', async () => {
        limitSection.style.opacity = toggle.checked ? '1' : '0.5';
        await saveVideoBudget();
    });

    // Slider handlers
    slider.addEventListener('input', () => {
        updateLimitDisplay(slider.value);
    });

    slider.addEventListener('change', async () => {
        await saveVideoBudget();
    });

    // Theme handler
    if (themeSelect) {
        themeSelect.addEventListener('change', async () => {
            const theme = themeSelect.value;
            document.documentElement.setAttribute('data-theme', theme);
            await saveAppSettings();
        });
    }

    // Compact mode handler
    if (compactToggle) {
        compactToggle.addEventListener('change', async () => {
            if (compactToggle.checked) {
                document.body.classList.add('compact');
            } else {
                document.body.classList.remove('compact');
            }
            await saveAppSettings();
        });
    }

    function updateLimitDisplay(minutes) {
        const hrs = Math.floor(minutes / 60);
        const mins = minutes % 60;
        display.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    }

    async function saveVideoBudget() {
        const budget = {
            enabled: toggle.checked,
            limit: parseInt(slider.value) * 60,
            snoozeUntil: 0
        };
        try {
            await chrome.storage.local.set({ video_budget: budget });
        } catch (e) {
            console.error("Error saving settings", e);
        }
    }

    async function saveAppSettings() {
        const settings = {
            theme: themeSelect ? themeSelect.value : 'default',
            compact: compactToggle ? compactToggle.checked : false
        };
        try {
            await chrome.storage.local.set({ app_settings: settings });
        } catch (e) {
            console.error("Error saving settings", e);
        }
    }

    // --- Achievement Sites Logic ---
    const achInput = document.getElementById('achievement-sites-input');
    const achIntervalInput = document.getElementById('achievement-interval');
    const achBtn = document.getElementById('save-achievements-btn');

    if (achInput && achBtn) {
        // Load existing
        const achLimitInput = document.getElementById('achievement-limit');

        try {
            const achData = await chrome.storage.local.get(['achievement_sites', 'achievement_interval', 'achievement_limit']);
            if (achData.achievement_sites && Array.isArray(achData.achievement_sites)) {
                achInput.value = achData.achievement_sites.join('\n');
            }
            if (achData.achievement_interval && achIntervalInput) {
                achIntervalInput.value = achData.achievement_interval;
            }
            if (achData.achievement_limit && achLimitInput) {
                achLimitInput.value = achData.achievement_limit;
            }
        } catch (e) { }

        achBtn.addEventListener('click', async () => {
            const raw = achInput.value;
            const domains = raw.split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0);

            let interval = 30;
            if (achIntervalInput) {
                interval = parseInt(achIntervalInput.value);
                if (isNaN(interval) || interval < 1) interval = 30;
            }

            let limit = 0;
            if (achLimitInput) {
                limit = parseInt(achLimitInput.value);
                if (isNaN(limit) || limit < 0) limit = 0;
            }

            await chrome.storage.local.set({
                achievement_sites: domains,
                achievement_interval: interval,
                achievement_limit: limit
            });
            alert('Achievement settings saved!');
        });
    }

    const resetBtn = document.getElementById('reset-achievements-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (confirm("Reset all achievement settings?")) {
                await chrome.storage.local.set({
                    achievement_sites: [],
                    achievement_interval: 30,
                    achievement_limit: 0
                });
                achInput.value = '';
                if (achIntervalInput) achIntervalInput.value = 30;
                if (achLimitInput) achLimitInput.value = 0;
                alert('Settings reset!');
            }
        });
    }
    const testBtn = document.getElementById('test-achievement-btn');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab) {
                alert("No active tab found.");
                return;
            }

            if (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:")) {
                alert("Cannot show achievements on system pages. Try a website like youtube.com");
                return;
            }

            const payload = {
                action: 'SHOW_ACHIEVEMENT',
                title: 'Steam-Style Popup',
                message: 'Unlocked: Developer Testing Mode!'
            };

            const attemptSend = () => new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tab.id, payload, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            });

            try {
                // Attempt 1
                await attemptSend();
            } catch (error) {
                console.log("Connection failed, attempting re-injection...");
                // Attempt 2: Re-inject content script
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content.js']
                    });
                    // Short delay for script to initialize
                    await new Promise(r => setTimeout(r, 100));
                    await attemptSend();
                } catch (retryError) {
                    console.log("Retry failed");
                }
            }
        });
    }
}

// --- BOOTSTRAP ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (!chrome.storage || !chrome.storage.local) {
            throw new Error("Storage permission missing or API unavailable");
        }

        // Get User ID
        const res = await chrome.storage.local.get('userId');
        userId = res.userId;
        if (!userId) {
            userId = crypto.randomUUID();
            await chrome.storage.local.set({ userId });
        }
        console.log("Popup User ID:", userId);

        initSocket();

        initTabs();
        await initPins();
        initTooltips();
        await initSettings();

        loadData(currentView);

        // Live update: refresh every 1 second for real-time tracking display
        setInterval(() => {
            if (currentView !== 'settings') {
                loadData(currentView);
            }
        }, 1000);

    } catch (e) {
        console.error("Init Error", e);
        document.body.innerHTML = `<div style="padding:20px; color:red; text-align:center;">
                <h3>Extension Error</h3>
                <p>${e.message}</p>
            </div>`;
    }
});
