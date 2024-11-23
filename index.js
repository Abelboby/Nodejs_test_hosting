const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const bodyParser = require('body-parser');

// Express app configuration
const app = express();
app.use(bodyParser.json());

// Global variables with proper initialization
let pairingCode = null;
let isReady = false;
let isInitialized = false;  // New flag to track initialization
let connectionRetryCount = 0;
const MAX_RETRIES = 5;

// Initialize WhatsApp client with optimized settings
const client = new Client({
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

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Application error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Client event handlers
client.on('qr', async (qr) => {
    if (!isInitialized) {  // Only generate pairing code if not initialized
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
    isInitialized = true;  // Mark as initialized when ready
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
        console.error('Max reconnection attempts reached. Manual restart required.');
    }
});

// Message handler with rate limiting
const messageHandlers = new Map();
client.on('message', async (message) => {
    try {
        // Basic rate limiting
        const now = Date.now();
        const lastMessageTime = messageHandlers.get(message.from) || 0;
        
        if (now - lastMessageTime < 1000) { // 1 second cooldown
            return;
        }
        
        messageHandlers.set(message.from, now);

        console.log(`Message from ${message.from}: ${message.body}`);
        if (message.body.toLowerCase() === 'nokate') {
            await message.reply('working good!');
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
});

// API Routes
app.get('/', (req, res) => {
    res.json({
        status: isReady ? 'running' : 'initializing',
        uptime: process.uptime(),
        initialized: isInitialized
    });
});

app.get('/pairing-code', (req, res) => {
    if (isInitialized) {
        // If client is already initialized, return appropriate message
        res.json({ 
            success: true, 
            message: 'WhatsApp client is already initialized',
            initialized: true
        });
    } else if (pairingCode) {
        // If not initialized but we have a pairing code
        res.json({ 
            success: true, 
            pairingCode,
            initialized: false
        });
    } else {
        // If neither initialized nor have a pairing code
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
        // First check if client is ready
        if (!isReady) {
            return res.status(503).json({
                success: false,
                message: 'WhatsApp client is not ready'
            });
        }

        const { groupId, userNumbers, messageType } = req.body;

        // Input validation
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

        // Rate limiting
        const now = Date.now();
        const lastRequest = mentionRateLimit.get(groupId) || 0;
        if (now - lastRequest < 5000) { // 5 seconds cooldown per group
            return res.status(429).json({ 
                success: false, 
                message: 'Please wait before sending another mention request' 
            });
        }
        mentionRateLimit.set(groupId, now);

        // Get the chat
        const chat = await client.getChatById(groupId);

        if (messageType === 'paid') {
            // Process mentions in batches for better performance
            const batchSize = 5;
            for (let i = 0; i < userNumbers.length; i += batchSize) {
                const batch = userNumbers.slice(i, i + batchSize);
                await Promise.all(batch.map(async (number) => {
                    await chat.sendMessage(`@${number}✅`, {
                        mentions: [`${number}@c.us`]
                    });
                }));
                await new Promise(resolve => setTimeout(resolve, 1000)); // Delay between batches
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
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Closing server...');
    await client.destroy();
    process.exit(0);
});

// Initialize client and start server
const PORT = process.env.PORT || 3000;

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