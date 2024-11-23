const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const bodyParser = require('body-parser');
const { execSync } = require('child_process');
const path = require('path');

// Express app configuration
const app = express();
app.use(bodyParser.json());

// Global variables with proper initialization
let pairingCode = null;
let isReady = false;
let isInitialized = false;
let connectionRetryCount = 0;
const MAX_RETRIES = 5;

// Cache cleanup configuration
const CACHE_CLEANUP_INTERVAL = 1000 * 60 * 60; // Every 1 hour
const CACHE_PATH = path.join(__dirname, '.wwebjs_auth/session/Default/Cache/Cache_Data');

// Initialize WhatsApp client with optimized settings
let client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-extensions'
        ],
        defaultViewport: null
    }
});

// Function to clear cache and reinitialize client
async function clearCacheAndReinitialize() {
    try {
        console.log('Starting cache cleanup...');
        
        // Destroy existing client if it exists
        if (client) {
            console.log('Destroying existing client...');
            await client.destroy();
        }

        // Clear the cache
        try {
            execSync(`rm -rf "${CACHE_PATH}"`);
            console.log('Cache cleared successfully');
        } catch (error) {
            console.error('Error clearing cache:', error.message);
        }

        // Reset states
        isReady = false;
        isInitialized = false;
        pairingCode = null;
        connectionRetryCount = 0;

        // Initialize new client
        console.log('Initializing new client...');
        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--disable-extensions'
                ],
                defaultViewport: null
            }
        });

        // Reattach event handlers
        setupEventHandlers();

        // Initialize the new client
        await client.initialize();
        
        console.log('Client reinitialization complete');
        return true;
    } catch (error) {
        console.error('Error during cache cleanup and reinitialization:', error);
        return false;
    }
}

// Setup event handlers function
function setupEventHandlers() {
    client.on('qr', async (qr) => {
        if (!isInitialized) {
            try {
                pairingCode = await client.requestPairingCode("916238261633", false);
                console.log('Pairing code received:', pairingCode);
            } catch (error) {
                console.error('Error generating pairing code:', error);
            }
        }
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        isReady = true;
        isInitialized = true;
        connectionRetryCount = 0;
    });

    client.on('disconnected', async (reason) => {
        console.log('Client disconnected:', reason);
        isReady = false;
        
        if (connectionRetryCount < MAX_RETRIES) {
            console.log(`Attempting to reconnect... (Attempt ${connectionRetryCount + 1}/${MAX_RETRIES})`);
            connectionRetryCount++;
            await client.initialize();
        } else {
            console.error('Max reconnection attempts reached. Triggering cache cleanup...');
            await clearCacheAndReinitialize();
        }
    });

    // Message handler with rate limiting
    const messageHandlers = new Map();
    client.on('message', async (message) => {
        try {
            const now = Date.now();
            const lastMessageTime = messageHandlers.get(message.from) || 0;
            
            if (now - lastMessageTime < 1000) return;
            
            messageHandlers.set(message.from, now);

            console.log(`Message from ${message.from}: ${message.body}`);
            if (message.body.toLowerCase() === 'nokate') {
                await message.reply('working good!');
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
}

// Initial event handlers setup
setupEventHandlers();

// Schedule periodic cache cleanup
setInterval(async () => {
    console.log('Running scheduled cache cleanup...');
    await clearCacheAndReinitialize();
}, CACHE_CLEANUP_INTERVAL);

// API Routes
app.get('/', (req, res) => {
    res.json({
        status: isReady ? 'running' : 'initializing',
        uptime: process.uptime(),
        initialized: isInitialized,
        lastCleanup: client.lastCleanup || 'Never'
    });
});

// Manual cache cleanup endpoint
// Replace the existing cleanup endpoint with this:

// Manual cache cleanup endpoint - supports both GET and POST
app.all('/cleanup', async (req, res) => {
    console.log('Manual cache cleanup requested');
    
    // Add CORS headers if needed
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    
    try {
        const success = await clearCacheAndReinitialize();
        if (success) {
            res.json({
                success: true,
                message: 'Cache cleared and client reinitialized successfully',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to clear cache and reinitialize client',
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Error during manual cleanup:', error);
        res.status(500).json({
            success: false,
            message: 'Error during cleanup process',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/pairing-code', (req, res) => {
    if (isInitialized) {
        res.json({ 
            success: true, 
            message: 'WhatsApp client is already initialized',
            initialized: true
        });
    } else if (pairingCode) {
        res.json({ 
            success: true, 
            pairingCode,
            initialized: false
        });
    } else {
        res.status(404).json({ 
            success: false, 
            message: 'Pairing code not available yet',
            initialized: false
        });
    }
});

// Optimized mention users endpoint with validation and rate limiting
const mentionRateLimit = new Map();
app.post('/mention-users', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({
                success: false,
                message: 'WhatsApp client is not ready'
            });
        }

        const { groupId, userNumbers, messageType } = req.body;

        if (!groupId || !userNumbers || !messageType) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
            });
        }

        if (!Array.isArray(userNumbers) || userNumbers.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'userNumbers must be a non-empty array' 
            });
        }

        const now = Date.now();
        const lastRequest = mentionRateLimit.get(groupId) || 0;
        if (now - lastRequest < 5000) {
            return res.status(429).json({ 
                success: false, 
                message: 'Please wait before sending another mention request' 
            });
        }
        mentionRateLimit.set(groupId, now);

        const chat = await client.getChatById(groupId);

        if (messageType === 'paid') {
            const batchSize = 5;
            for (let i = 0; i < userNumbers.length; i += batchSize) {
                const batch = userNumbers.slice(i, i + batchSize);
                await Promise.all(batch.map(async (number) => {
                    await chat.sendMessage(`@${number}✅`, {
                        mentions: [`${number}@c.us`]
                    });
                }));
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            res.json({ 
                success: true, 
                message: 'Users mentioned successfully in individual messages.' 
            });

        } else if (messageType === 'pending') {
            const mentionsText = userNumbers.map(number => `\n@${number}`).join(' ');
            await chat.sendMessage(`*Pending*${mentionsText}`, {
                mentions: userNumbers.map(number => `${number}@c.us`)
            });
            res.json({ 
                success: true, 
                message: 'Users mentioned successfully in a single message.' 
            });

        } else {
            res.status(400).json({ 
                success: false, 
                message: 'Invalid messageType. Use "paid" or "pending".' 
            });
        }

    } catch (error) {
        console.error('Error mentioning users:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to mention users',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Graceful shutdown handling
// process.on('SIGTERM', async () => {
//     console.log('SIGTERM received. Closing server...');
//     await client.destroy();
//     process.exit(0);
// });
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Attempting reinitialization...');
    try {
        // Use the existing clearCacheAndReinitialize function
        const success = await clearCacheAndReinitialize();
        
        if (success) {
            console.log('Server successfully reinitialized after SIGTERM');
        } else {
            console.error('Failed to reinitialize after SIGTERM, but keeping server alive');
        }
    } catch (error) {
        console.error('Error during SIGTERM reinitialization:', error);
        // Even if reinitialization fails, we don't exit
    }
});

// Add a SIGINT handler as well for Ctrl+C
process.on('SIGINT', async () => {
    console.log('SIGINT received. Attempting reinitialization...');
    try {
        const success = await clearCacheAndReinitialize();
        
        if (success) {
            console.log('Server successfully reinitialized after SIGINT');
        } else {
            console.error('Failed to reinitialize after SIGINT, but keeping server alive');
        }
    } catch (error) {
        console.error('Error during SIGINT reinitialization:', error);
    }
});


// Initialize client and start server
const PORT = 3000;

const startServer = async () => {
    try {
        await client.initialize();
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();