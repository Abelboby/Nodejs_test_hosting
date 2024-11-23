const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

let isReady = false;

client.on('qr', (qr) => {
    console.log('QR Code received, scan it using your phone:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
    isReady = true;
});

client.on('message', async (message) => {
    console.log(`Message from ${message.from}: ${message.body}`);
    if (message.body.toLowerCase() === 'hello') {
        await message.reply('Hi there! This is an automated response.');
    }
});

client.initialize();

// Health check route
app.get('/', (req, res) => {
    if (isReady) {
        res.send('WhatsApp bot is running!');
    } else {
        res.status(500).send('Bot is initializing...');
    }
});

// Start Express server
app.listen(3000, () => console.log('Health check server is running on port 3000'));
