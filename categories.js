// categories.js - Domain Categorization Module

// Default category presets for common sites
const DEFAULT_CATEGORIES = {
    // Work/Productive sites
    'github.com': 'work',
    'gitlab.com': 'work',
    'stackoverflow.com': 'work',
    'docs.google.com': 'work',
    'notion.so': 'work',
    'trello.com': 'work',
    'slack.com': 'work',
    'figma.com': 'work',
    'linear.app': 'work',
    'jira.atlassian.com': 'work',
    'vercel.com': 'work',
    'aws.amazon.com': 'work',
    'console.cloud.google.com': 'work',
    'leetcode.com': 'work',
    'codepen.io': 'work',

    // Distraction sites
    'youtube.com': 'distraction',
    'www.youtube.com': 'distraction',
    'reddit.com': 'distraction',
    'www.reddit.com': 'distraction',
    'twitter.com': 'distraction',
    'x.com': 'distraction',
    'facebook.com': 'distraction',
    'www.facebook.com': 'distraction',
    'instagram.com': 'distraction',
    'www.instagram.com': 'distraction',
    'tiktok.com': 'distraction',
    'www.tiktok.com': 'distraction',
    'netflix.com': 'distraction',
    'www.netflix.com': 'distraction',
    'twitch.tv': 'distraction',
    'www.twitch.tv': 'distraction',
    '9gag.com': 'distraction'
};

// Category colors and icons
const CATEGORY_CONFIG = {
    work: {
        color: '#4CAF50',
        bgColor: '#E8F5E9',
        icon: '🟢',
        label: 'Work'
    },
    distraction: {
        color: '#F44336',
        bgColor: '#FFEBEE',
        icon: '🔴',
        label: 'Distraction'
    },
    neutral: {
        color: '#9E9E9E',
        bgColor: '#F5F5F5',
        icon: '⚪',
        label: 'Neutral'
    }
};

// Get category for a domain (checks user overrides first, then defaults)
async function getCategory(domain) {
    try {
        const data = await chrome.storage.local.get(['category_overrides']);
        const overrides = data.category_overrides || {};

        // Check user override first
        if (overrides[domain]) {
            return overrides[domain];
        }

        // Check default presets
        if (DEFAULT_CATEGORIES[domain]) {
            return DEFAULT_CATEGORIES[domain];
        }

        // Default to neutral
        return 'neutral';
    } catch (e) {
        console.error('Error getting category:', e);
        return 'neutral';
    }
}

// Set category override for a domain
async function setCategory(domain, category) {
    try {
        const data = await chrome.storage.local.get(['category_overrides']);
        const overrides = data.category_overrides || {};

        if (category === 'neutral' && DEFAULT_CATEGORIES[domain]) {
            // If setting to neutral but there's a default, store explicit override
            overrides[domain] = category;
        } else if (category === 'neutral' && !DEFAULT_CATEGORIES[domain]) {
            // If neutral and no default, remove override
            delete overrides[domain];
        } else {
            // Store the override
            overrides[domain] = category;
        }

        await chrome.storage.local.set({ category_overrides: overrides });
        return true;
    } catch (e) {
        console.error('Error setting category:', e);
        return false;
    }
}

// Cycle through categories: neutral -> work -> distraction -> neutral
function getNextCategory(currentCategory) {
    const order = ['neutral', 'work', 'distraction'];
    const currentIndex = order.indexOf(currentCategory);
    const nextIndex = (currentIndex + 1) % order.length;
    return order[nextIndex];
}

// Get category config
function getCategoryConfig(category) {
    return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.neutral;
}
