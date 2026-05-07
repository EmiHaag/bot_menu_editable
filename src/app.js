require('dotenv').config();
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const express = require('express');
const basicAuth = require('express-basic-auth');
const GoogleSheetsService = require('./services/googleSheetsService');
const StateService = require('./services/stateService');
const MenuController = require('./controllers/menuController');
const dashboard = require('./utils/dashboard');
const botsConfig = require('./config/bots');

const app = express();
const port = process.env.PORT || 8000; // Koyeb suele usar 8000 por defecto

// Koyeb Health Check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Configuración de Basic Auth
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'admin';

app.use(basicAuth({
    users: { [adminUser]: adminPass },
    challenge: true,
    realm: 'Bot Menu Editor',
}));

const botQRs = {}; // Object to store QR codes for each bot

async function startBot(botConfig) {
    const { id, spreadsheetId, credentials, authFolder } = botConfig;
    
    console.log(`[${id}] Starting initialization...`);
    botQRs[id] = { status: 'starting', qr: null, lastUpdate: new Date().toLocaleTimeString() };
    
    try {
        const googleSheetsService = new GoogleSheetsService({
            clientId: id,
            spreadsheetId,
            credentials
        });
        
        const stateService = new StateService(id);
        const menuController = new MenuController(googleSheetsService, stateService);

        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`[${id}] Using Baileys version: ${version.join('.')}`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'error' }), // Reducimos nivel de log para evitar ruido
            auth: state,
            browser: ['Bot Menu', 'Chrome', '1.0.0'],
            printQRInTerminal: false // Ya lo imprimimos nosotros
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            botQRs[id].lastUpdate = new Date().toLocaleTimeString();
            
            if (qr) {
                console.log(`[${id}] New QR code received (Available at /qr)`);
                
                try {
                    botQRs[id].qr = await QRCode.toDataURL(qr);
                    botQRs[id].status = 'qr_ready';
                } catch (err) {
                    console.error(`[${id}] Error generating QR DataURL:`, err);
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom) ? 
                    lastDisconnect.error.output.statusCode : 0;
                
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[${id}] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                
                botQRs[id].status = 'disconnected';
                botQRs[id].qr = null;

                if (shouldReconnect) {
                    console.log(`[${id}] Attempting to reconnect in 5s...`);
                    setTimeout(() => startBot(botConfig), 5000);
                } else {
                    console.log(`[${id}] Logged out. session deleted.`);
                    botQRs[id].status = 'logged_out';
                }
            } else if (connection === 'open') {
                console.log(`[${id}] ✅ Connection opened successfully!`);
                botQRs[id].status = 'connected';
                botQRs[id].qr = null;
            } else if (connection) {
                botQRs[id].status = connection;
                console.log(`[${id}] Connection state: ${connection}`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const jid = msg.key.remoteJid;
                        const text = msg.message.conversation || 
                                     msg.message.extendedTextMessage?.text || 
                                     msg.message.buttonsResponseMessage?.selectedButtonId ||
                                     msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;

                        if (text) {
                            console.log(`[${id}] Message from ${jid}: ${text}`);
                            await menuController.handleIncomingMessage(sock, jid, text);
                        }
                    }
                }
            }
        });

    } catch (error) {
        console.error(`[${id}] Critical error during startup:`, error);
        botQRs[id].status = 'error';
        setTimeout(() => startBot(botConfig), 10000);
    }
}

async function main() {
    // Express route to serve QR codes
    app.get('/qr', (req, res) => {
        let html = `
        <html>
            <head>
                <title>WhatsApp Bot QR Status</title>
                <meta http-equiv="refresh" content="10">
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; padding: 20px; background: #f0f2f5; }
                    .header-nav { width: 100%; max-width: 800px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                    .btn-back { padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
                    .container { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; }
                    .bot-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; min-width: 300px; }
                    .qr-img { width: 256px; height: 256px; margin: 10px 0; border: 1px solid #ddd; }
                    .status { font-weight: bold; margin-bottom: 10px; padding: 8px; border-radius: 4px; text-transform: uppercase; font-size: 12px; }
                    .status.connected { background: #d4edda; color: #155724; }
                    .status.qr_ready { background: #d1ecf1; color: #0c5460; }
                    .status.disconnected { background: #f8d7da; color: #721c24; }
                    .status.connecting { background: #fff3cd; color: #856404; }
                    .status.error { background: #dc3545; color: white; }
                    .last-update { font-size: 11px; color: #666; margin-top: 10px; }
                </style>
            </head>
            <body>
                <div class="header-nav">
                    <h1>WhatsApp Status</h1>
                    <a href="/" class="btn-back">Volver al Editor de Menú</a>
                </div>
                <div class="container">
        `;

        const bots = Object.entries(botQRs);
        if (bots.length === 0) {
            html += '<p>No bots initialized yet.</p>';
        }

        for (const [id, data] of bots) {
            let statusText = data.status.replace('_', ' ');
            let instruction = 'Please wait...';
            
            if (data.status === 'connected') instruction = '✅ Connected and ready';
            else if (data.status === 'qr_ready') instruction = 'Scan the QR code with WhatsApp';
            else if (data.status === 'connecting') instruction = 'Establishing connection...';
            else if (data.status === 'disconnected') instruction = 'Connection lost. Retrying...';

            html += `
                <div class="bot-card">
                    <h2>Bot: ${id}</h2>
                    <div class="status ${data.status}">Status: ${statusText}</div>
                    ${data.qr ? `<img class="qr-img" src="${data.qr}" alt="QR Code" />` : `
                        <div style="height: 256px; display: flex; align-items: center; justify-content: center; background: #eee; margin: 10px 0; border-radius: 4px;">
                            <p style="color: #666; padding: 20px;">${data.status === 'connected' ? 'Session Active' : 'Waiting for QR...'}</p>
                        </div>
                    `}
                    <p>${instruction}</p>
                    <div class="last-update">Last update: ${data.lastUpdate}</div>
                </div>
            `;
        }

        html += `
                </div>
                <p style="margin-top: 20px; color: #666;"><small>Page refreshes automatically every 10 seconds</small></p>
            </body>
        </html>
        `;
        res.send(html);
    });

    // Integrated Dashboard routes
    app.use('/', dashboard.setupRoutes());

    app.listen(port, () => {
        console.log(`🚀 Servidor unificado corriendo en http://localhost:${port}`);
        console.log(`📊 Editor de Menú: http://localhost:${port}/`);
        console.log(`📱 QR WhatsApp: http://localhost:${port}/qr`);
    });

    for (const botConfig of botsConfig) {
        await startBot(botConfig);
    }
}

main();
