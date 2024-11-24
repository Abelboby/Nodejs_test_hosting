const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const MongoStore = require('wwebjs-mongo').MongoStore;
const { execSync } = require('child_process');
const path = require('path');
require('dotenv').config();

// Express app configuration
const app = express();
app.use(bodyParser.json());

// Global variables
let pairingCode = null;
let isReady = false;
let isInitialized = false;
let connectionRetryCount = 0;
const MAX_RETRIES = 5;
let client = null;
let store = null;
const ADMIN_NUMBER = '917034358874@c.us';
const CACHE_PATH = path.join(__dirname, '.wwebjs_auth/session/Default/Cache/Cache_Data');
// MongoDB configuration
const MONGO_URI = process.env.MONGODB_URI;

const clearCache = () => {
    try {
        console.log('Clearing cache...');
        execSync(`rm -rf "${CACHE_PATH}"`);
        console.log('Cache cleared successfully');
        return true;
    } catch (error) {
        console.error('Error clearing cache:', error);
        return false;
    }
};
// Initialize the database and create client
const initializeClient = async () => {
    try {
        // Connect to MongoDB first
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');
        
        // Create store
        store = new MongoStore({ mongoose: mongoose });
        
        // Create client with RemoteAuth
        client = new Client({
            authStrategy: new RemoteAuth({
                clientId: 'your-client-id',
                store: store,
                backupSyncIntervalMs: 300000
            }),
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

        // Setup event handlers
        setupEventHandlers();

        // Initialize the client
        await client.initialize();
        
        return true;
    } catch (error) {
        console.error('Failed to initialize client:', error);
        return false;
    }
};

// Function to reinitialize client
async function reinitializeClient() {
    try {
        console.log('Starting client reinitialization...');
        
        // Destroy existing client if it exists
        if (client) {
            console.log('Destroying existing client...');
            await client.destroy();
        }

        clearCache();
        // Reset states
        isReady = false;
        isInitialized = false;
        pairingCode = null;
        connectionRetryCount = 0;

        // Initialize new client
        return await initializeClient();
    } catch (error) {
        console.error('Error during reinitialization:', error);
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

    client.on('remote_session_saved', () => {
        console.log('Session saved to remote storage!');
    });

    client.on('disconnected', async (reason) => {
        console.log('Client disconnected:', reason);
        isReady = false;
        
        if (connectionRetryCount < MAX_RETRIES) {
            console.log(`Attempting to reconnect... (Attempt ${connectionRetryCount + 1}/${MAX_RETRIES})`);
            connectionRetryCount++;
            await client.initialize();
        } else {
            console.error('Max reconnection attempts reached. Triggering reinitialization...');
            await reinitializeClient();
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
            if (message.from === ADMIN_NUMBER && message.body.toLowerCase() === '.terminate') {
                console.log('Terminate command received from admin');
                await message.reply('Reinitializing client...');
                const success = await reinitializeClient();
                if (success) {
                    await client.sendMessage(ADMIN_NUMBER, 'Client reinitialized successfully');
                } else {
                    await client.sendMessage(ADMIN_NUMBER, 'Failed to reinitialize client');
                }
                return;
            }
            
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        status: isReady ? 'running' : 'initializing',
        uptime: process.uptime(),
        initialized: isInitialized
    });
});

// Manual reinitialization endpoint
app.all('/reinitialize', async (req, res) => {
    console.log('Manual reinitialization requested');
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    
    try {
        const success = await reinitializeClient();
        if (success) {
            res.json({
                success: true,
                message: 'Client reinitialized successfully',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to reinitialize client',
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Error during manual reinitialization:', error);
        res.status(500).json({
            success: false,
            message: 'Error during reinitialization process',
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

// Mention users endpoint with rate limiting
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

// Initialize client and start server
const PORT = 3000;

const startServer = async () => {
    try {
        // Initialize client (which includes database initialization)
        const clientInitialized = await initializeClient();
        if (!clientInitialized) {
            throw new Error('Failed to initialize client');
        }

        // Start Express server
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();