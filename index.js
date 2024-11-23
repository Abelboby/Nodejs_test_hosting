const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const app = express();

let pairingCode = null;  // Store the pairing code here
let isReady = false;

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

// Handle QR code generation
client.on('qr', async (qr) => {
    // Here we use the requestPairingCode logic to fetch the pairing code
    try {
        pairingCode = await client.requestPairingCode("916238261633", false);  // Use a valid phone number
        console.log('Pairing code received:');
        console.log(pairingCode);
    } catch (error) {
        console.error('Error generating pairing code:', error);
    }
});

// Handle when the client is ready
client.on('ready', () => {
    console.log('Client is ready!');
    isReady = true;
});

// Handle incoming messages
client.on('message', async (message) => {
    console.log(`Message from ${message.from}: ${message.body}`);
    if (message.body.toLowerCase() === 'nokate') {
        await message.reply('Hi there! This is an automated response.');
    }
});

// Start the WhatsApp client
client.initialize();

// Health check route
app.get('/', (req, res) => {
    if (isReady) {
        res.send('WhatsApp bot is running!');
    } else {
        res.status(500).send('Bot is initializing...');
    }
});

// API endpoint to get the pairing code
app.get('/pairing-code', (req, res) => {
    if (pairingCode) {
        res.json({ pairingCode });
    } else {
        res.status(404).json({ message: 'Pairing code not available yet' });
    }
});

// Start the Express server
app.listen(3000, () => {
    console.log('Health check and API server running on port 3000');
});
