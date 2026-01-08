// popup.js - Complete Implementation

let currentView = 'today';
let pinnedSites = [];
// Store hit regions: { type: 'rect'|'arc', x, y, w, h, cx, cy, innerRadius, outerRadius, startAngle, endAngle, data: {} }
let chartRegions = [];

// Icons
const PIN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L12 12M12 12L19 19M12 12L5 19M12 12L12 22"></path></svg>';
const ICON_PIN_FILLED = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#FBC02D" stroke="#F57F17" stroke-width="1.5"><path d="M16 12V4H8v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
const ICON_PIN_OUTLINE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 12V4H8v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;


// --- INITIALIZATION ---

async function initPins() {
    try {
        const data = await chrome.storage.local.get('pinnedSites');
        pinnedSites = data.pinnedSites || [];
        loadData(currentView);
    } catch (e) {
        console.error("Error initPins", e);
    }
}

function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentView = tab.dataset.view;

            const f = document.getElementById('monthly-footer');
            if (f) f.classList.toggle('hidden', currentView !== 'monthly');

            const tc = document.getElementById('timeChart');
            const wc = document.getElementById('weeklyChart');
            if (tc) tc.classList.toggle('hidden', currentView === 'weekly');
            if (wc) wc.classList.toggle('hidden', currentView !== 'weekly');

            loadData(currentView);
        });
    });

    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);
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


// --- DATA LOADING ---

async function loadData(view) {
    try {
        const data = await chrome.storage.local.get(['today_stats', 'history']);

        if (view === 'weekly') {
            const aggregated = aggregateWeekly(data.history, data.today_stats);
            renderBrowserTime(aggregated.browser_time);

            const pinnedStats = {};
            const otherStats = {};

            Object.entries(aggregated).forEach(([domain, info]) => {
                if (domain === 'browser_time') return;
                // Safety: info might be number if legacy data? verify object
                let inf = (typeof info === 'number') ? { time: info } : info;

                if (pinnedSites.includes(domain)) {
                    pinnedStats[domain] = inf;
                } else {
                    otherStats[domain] = inf;
                }
            });

            renderPinned(pinnedStats);
            renderList(otherStats);
            renderWeeklyChart(data.history, data.today_stats);
            return;
        }

        // Today / Monthly
        let stats = {};
        if (view === 'today') {
            stats = data.today_stats || {};
        } else if (view === 'monthly') {
            stats = aggregateMonthly(data.history, data.today_stats);
        }

        renderBrowserTime(stats.browser_time || 0);

        const pinnedStats = {};
        const otherStats = {};

        Object.entries(stats).forEach(([domain, info]) => {
            if (domain === 'browser_time') return;
            // Safety
            if (!info) return;

            if (pinnedSites.includes(domain)) {
                pinnedStats[domain] = info;
            } else {
                otherStats[domain] = info;
            }
        });

        renderPinned(pinnedStats);
        renderList(otherStats);
        renderChart(stats);
    } catch (e) {
        console.error("Error loadData", e);
        document.getElementById('stats-list').innerHTML = '<div style="padding:20px; color:red;">Error loading data</div>';
    }
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

    container.innerHTML = '';

    // Sort safely
    const entries = Object.entries(stats).sort((a, b) => (b[1].time || 0) - (a[1].time || 0));

    if (entries.length === 0) {
        wrapper.style.display = 'none';
        return;
    }
    wrapper.style.display = 'block';

    entries.forEach(([domain, info]) => {
        const item = document.createElement('div');
        item.className = 'item';
        item.style.background = '#e8f5e9';
        item.style.border = '1px solid #c8e6c9';
        item.style.position = 'relative';

        const pinBtn = document.createElement('div');
        pinBtn.innerHTML = ICON_PIN_FILLED;
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

        let html = `<div style="font-weight:bold; font-size:14px; margin-bottom:2px;">${domain}</div>`;
        const showDual = (info.total_tab_time !== undefined && info.total_tab_time > 0);

        if (showDual) {
            html += `
             <div style="display:flex; gap:10px; font-size:11px; align-items:center;">
                <span style="color:#2E7D32; font-weight:600; background:#fff; padding:2px 6px; border-radius:4px; border:1px solid #C8E6C9;">
                    Video: ${formatTime(info.time)}
                </span>
                <span style="color:#666;">
                    Tab: ${formatTime(info.total_tab_time)}
                </span>
             </div>`;
        } else {
            html += `<div style="font-size:11px; color:#666;">Active: ${formatTime(info.time)}</div>`;
        }
        dom.innerHTML = html;

        item.appendChild(pinBtn);
        item.appendChild(img);
        item.appendChild(dom);
        container.appendChild(item);
    });
}

function renderList(stats) {
    const container = document.getElementById('stats-list');
    if (!container) return;
    container.innerHTML = '';

    // Sort safely
    const sorted = Object.entries(stats)
        .sort((a, b) => (b[1].time || 0) - (a[1].time || 0))
        .slice(0, 50);

    if (sorted.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#888">No data found</div>';
        return;
    }

    sorted.forEach(([domain, info]) => {
        // Safety check
        if (!info) return;

        const item = document.createElement('div');
        item.className = 'item';

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

        let html = `<div>${domain}</div>`;

        if (info.total_tab_time && info.total_tab_time > 0) {
            html += `<div style="font-size:10px; color:#999;">Video: <b>${formatTime(info.time)}</b> | Tab: ${formatTime(info.total_tab_time)}</div>`;
        }
        dom.innerHTML = html;

        const time = document.createElement('div');
        time.className = 'time';
        time.textContent = formatTime(info.time);

        item.appendChild(pinBtn);
        item.appendChild(img);
        item.appendChild(dom);
        item.appendChild(time);
        container.appendChild(item);
    });
}


// --- CHART RENDERERS ---

function renderWeeklyChart(history, todayStats) {
    chartRegions = chartRegions.filter(r => r.chartId !== 'weeklyChart');

    const canvas = document.getElementById('weeklyChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = (rect.width || 360) * dpr;
    canvas.height = 200 * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.width / dpr;
    const height = 200;

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

    // Draw
    const paddingX = 30;
    const paddingY = 20;
    const graphWidth = width - (paddingX * 2);
    const graphHeight = height - paddingY - 10;

    const barWidth = graphWidth / 7 * 0.6;

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

    days.forEach((day, index) => {
        const step = graphWidth / 7;
        const barX = paddingX + (step * index) + (step - barWidth) / 2;

        let currentY = graphHeight;

        topSites.forEach(site => {
            const val = (day.data[site] && day.data[site].time) || 0;
            if (val > 0) {
                const h = (val / maxDaily) * graphHeight;
                ctx.fillStyle = stringToColor(site);
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

        let others = 0;
        Object.entries(day.data).forEach(([d, v]) => {
            if (d === 'browser_time') return;
            if (topSites.includes(d)) return;
            others += (v.time || 0);
        });
        if (others > 0) {
            const h = (others / maxDaily) * graphHeight;
            ctx.fillStyle = '#e0e0e0';
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

        ctx.fillStyle = '#666';
        ctx.textAlign = 'center';
        ctx.font = '11px Segoe UI';
        ctx.fillText(day.label, barX + barWidth / 2, height - 5);
    });

    ctx.textAlign = 'right';
    ctx.fillText(`${(maxDaily / 3600).toFixed(1)}h`, paddingX - 5, 10);
    ctx.fillText("0", paddingX - 5, graphHeight);
}


function renderChart(stats) {
    if (currentView === 'weekly') return;

    chartRegions = chartRegions.filter(r => r.chartId !== 'timeChart');

    const canvas = document.getElementById('timeChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const size = 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    const chartStats = { ...stats };
    delete chartStats.browser_time;

    const sorted = Object.entries(chartStats).sort((a, b) => (b[1].time || 0) - (a[1].time || 0));
    const total = sorted.reduce((sum, item) => sum + (item[1].time || 0), 0);

    let startAngle = -0.5 * Math.PI;
    const center = size / 2;
    const radius = center - 10;
    const innerRadius = radius * 0.65;

    if (total === 0) {
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, 2 * Math.PI);
        ctx.strokeStyle = '#eee';
        ctx.lineWidth = 20;
        ctx.stroke();
        return;
    }

    sorted.slice(0, 8).forEach((item, index) => {
        const t = item[1].time || 0;
        const sliceAngle = (t / total) * 2 * Math.PI;

        ctx.beginPath();
        ctx.moveTo(center, center);
        ctx.arc(center, center, radius, startAngle, startAngle + sliceAngle);
        ctx.fillStyle = stringToColor(item[0]);
        ctx.fill();

        chartRegions.push({
            chartId: 'timeChart',
            type: 'arc',
            cx: center,
            cy: center,
            innerRadius: innerRadius,
            outerRadius: radius,
            startAngle: startAngle,
            endAngle: startAngle + sliceAngle,
            data: { label: item[0], value: t }
        });

        startAngle += sliceAngle;
    });

    if (sorted.length > 8) {
        const remaining = sorted.slice(8).reduce((sum, item) => sum + (item[1].time || 0), 0);
        const sliceAngle = (remaining / total) * 2 * Math.PI;

        ctx.beginPath();
        ctx.moveTo(center, center);
        ctx.arc(center, center, radius, startAngle, startAngle + sliceAngle);
        ctx.fillStyle = '#e0e0e0';
        ctx.fill();

        chartRegions.push({
            chartId: 'timeChart',
            type: 'arc',
            cx: center,
            cy: center,
            innerRadius: innerRadius,
            outerRadius: radius,
            startAngle: startAngle,
            endAngle: startAngle + sliceAngle,
            data: { label: 'Others', value: remaining }
        });
    }

    ctx.beginPath();
    ctx.arc(center, center, innerRadius, 0, 2 * Math.PI);
    ctx.fillStyle = '#f5f5f5';
    ctx.fill();

    ctx.fillStyle = '#333';
    ctx.font = 'bold 20px Segoe UI';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatTime(total), center, center - 10);

    ctx.font = '11px Segoe UI';
    ctx.fillStyle = '#666';
    ctx.fillText("Total Time", center, center + 12);
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

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 75%, 50%)`;
}

function _favicon(domain) {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

function formatTime(seconds) {
    if (!seconds && seconds !== 0) return '0s';
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
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

// --- BOOTSTRAP ---
// --- BOOTSTRAP ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (!chrome.storage || !chrome.storage.local) {
            throw new Error("Storage permission missing or API unavailable");
        }
        initTabs();
        await initPins();
        initTooltips();
    } catch (e) {
        console.error("Popup initialization failed:", e);
        document.body.innerHTML = `<div style="padding:20px; color:red; text-align:center;">
            <h3>Extension Error</h3>
            <p>${e.message}</p>
        </div>`;
    }
});
