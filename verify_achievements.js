const io = require('socket.io-client');
const axios = require('axios');

const USER_ID = 'test-user-' + Date.now();
const DOMAIN = 'test-domain.com';
const SERVER_URL = 'http://localhost:3000';

const socket = io(SERVER_URL);

console.log(`Testing with User ID: ${USER_ID}`);

socket.on('connect', async () => {
    console.log('Socket connected');

    // 1. Set Settings (Interval: 2 seconds, Max Count: 5)
    console.log('Setting achievements...');
    await axios.post(`${SERVER_URL}/api/settings`, {
        userId: USER_ID,
        achievements: {
            [DOMAIN]: { interval: 2, maxCount: 5, message: "Test Success!" }
        }
    });

    // 2. Listen for Achievement
    socket.on(`achievement_unlocked_${USER_ID}`, (data) => {
        console.log('✅ ACHIEVEMENT UNLOCKED!', data);
        process.exit(0);
    });

    // 3. Log Time (Simulate watching 5 seconds)
    console.log('Logging time...');
    // Log 1s
    await axios.post(`${SERVER_URL}/api/log`, {
        userId: USER_ID,
        domain: DOMAIN,
        activeSeconds: 1,
        videoSeconds: 1
    });

    // Log 2s (Total 3s -> Should trigger 2s interval)
    setTimeout(async () => {
        await axios.post(`${SERVER_URL}/api/log`, {
            userId: USER_ID,
            domain: DOMAIN,
            activeSeconds: 2,
            videoSeconds: 2
        });
        console.log('Logged batch 2');
    }, 1000);

});

// Timeout fail
setTimeout(() => {
    console.error('❌ Timeout: No achievement received.');
    process.exit(1);
}, 5000);
