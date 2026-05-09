require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
const session = require('express-session');
const GoogleSheetsService = require('./services/googleSheetsService');
const StateService = require('./services/stateService');
const MenuController = require('./controllers/menuController');
const dashboard = require('./utils/dashboard');
const userService = require('./services/userService');

const app = express();
const port = process.env.PORT || 8000;
const AUTH_SESSIONS_DIR = process.env.AUTH_SESSIONS_DIR || '/data/auth_sessions';

// Configuración de Sesiones
app.use(session({
    secret: process.env.SESSION_SECRET || 'bot-menu-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));

app.use(express.urlencoded({ extended: true }));

// Koyeb Health Check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Ruta de Login (GET)
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Login - Bot Menu Editor</title>
            <style>
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background-color: white;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .login-box {
                    background-color: #fbfbfb;
                    border: 1px solid #e7e3e4;
                    padding: 40px;
                    border-radius: 8px;
                    width: 100%;
                    max-width: 400px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.05);
                }
                .login-box h2 {
                    margin-top: 0;
                    color: #333;
                    text-align: center;
                    margin-bottom: 30px;
                }
                .form-group {
                    margin-bottom: 20px;
                }
                .form-group label {
                    display: block;
                    margin-bottom: 5px;
                    color: #666;
                }
                .form-group input {
                    width: 100%;
                    padding: 12px;
                    border: 1px solid #e7e3e4;
                    border-radius: 4px;
                    box-sizing: border-box;
                    font-size: 16px;
                }
                .btn-login {
                    background-color: #00bc7d;
                    color: white;
                    border: none;
                    padding: 12px;
                    width: 100%;
                    border-radius: 4px;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: background-color 0.3s;
                }
                .btn-login:hover {
                    background-color: #00a56d;
                }
                .error-msg {
                    color: #d32f2f;
                    background: #ffcdd2;
                    padding: 10px;
                    border-radius: 4px;
                    margin-bottom: 20px;
                    text-align: center;
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h2>Bot Menu Editor</h2>
                ${req.query.error ? '<div class="error-msg">Usuario o contraseña incorrectos</div>' : ''}
                <form action="/login" method="POST">
                    <div class="form-group">
                        <label for="username">Usuario</label>
                        <input type="text" id="username" name="username" required autofocus>
                    </div>
                    <div class="form-group">
                        <label for="password">Contraseña</label>
                        <input type="password" id="password" name="password" required>
                    </div>
                    <button type="submit" class="btn-login">Login</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

// Ruta de Login (POST)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await userService.getUserByUsername(username);
        if (user && user.activo && password === user.password) {
            req.session.user = user;
            return res.redirect('/');
        }
        res.redirect('/login?error=1');
    } catch (error) {
        console.error('Login Error:', error);
        res.redirect('/login?error=1');
    }
});

// Ruta de Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Middleware de Autenticación
const authMiddleware = (req, res, next) => {
    if (req.session && req.session.user) {
        req.user = req.session.user;
        return next();
    }
    res.redirect('/login');
};

// Aplicar middleware a todas las rutas excepto login y health
app.use((req, res, next) => {
    if (req.path === '/login' || req.path === '/health') {
        return next();
    }
    authMiddleware(req, res, next);
});

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
            logger: pino({ level: 'error' }),
            auth: state,
            browser: ['Bot Menu', 'Chrome', '1.0.0'],
            printQRInTerminal: false
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
        const loggedUser = req.user;

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
                    .status.logged_out { background: #dc3545; color: white; }
                    .status.error { background: #dc3545; color: white; }
                    .last-update { font-size: 11px; color: #666; margin-top: 10px; }
                    .btn-reconnect { padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; margin-top: 10px; }
                    .btn-reconnect:hover { background: #218838; }
                    .btn-reconnect:disabled { background: #6c757d; cursor: not-allowed; }
                    .action-buttons { margin-top: 15px; }
                </style>
            </head>
            <body>
                <div class="header-nav">
                    <h1>WhatsApp Status</h1>
                    <div style="display: flex; gap: 10px;">
                        <a href="/" class="btn-back">Volver al Editor de Menú</a>
                        <a href="/logout" class="btn-back" style="background: #dc3545;">Salir</a>
                    </div>
                </div>
                <div class="container">
        `;

        html += `
        <script>
            async function reconnectBot(botId) {
                const btn = document.getElementById('btn-' + botId);
                btn.disabled = true;
                btn.textContent = 'Reiniciando...';

                try {
                    const response = await fetch('/reconnect/' + botId, { method: 'POST' });
                    if (response.ok) {
                        btn.textContent = 'Reconectando...';
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        alert('Error al reconectar. Intenta de nuevo.');
                        btn.disabled = false;
                        btn.textContent = 'Reintentar conexión';
                    }
                } catch (error) {
                    alert('Error: ' + error);
                    btn.disabled = false;
                    btn.textContent = 'Reintentar conexión';
                }
            }
        </script>
        `;

        // Filtrar bots según permisos
        const bots = Object.entries(botQRs).filter(([id]) => {
            if (loggedUser.idCliente === 'admin') return true;
            return id === loggedUser.idCliente;
        });

        if (bots.length === 0) {
            html += '<p>No bots initialized for your account.</p>';
        }

        for (const [id, data] of bots) {
            let statusText = data.status.replace('_', ' ');
            let instruction = 'Please wait...';

            if (data.status === 'connected') instruction = '✅ Connected and ready';
            else if (data.status === 'qr_ready') instruction = 'Scan the QR code with WhatsApp';
            else if (data.status === 'connecting') instruction = 'Establishing connection...';
            else if (data.status === 'disconnected') instruction = 'Connection lost. Retrying...';
            else if (data.status === 'logged_out') instruction = 'Session closed. Click the button below to reconnect.';

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
                    ${data.status === 'logged_out' ? `
                        <div class="action-buttons">
                            <button class="btn-reconnect" id="btn-${id}" onclick="reconnectBot('${id}')">Reintentar conexión</button>
                        </div>
                    ` : ''}
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

    // Endpoint to reconnect a bot
    app.post('/reconnect/:botId', (req, res) => {
        const loggedUser = req.user;
        const botId = req.params.botId;

        // Verify user has permission to reconnect this bot
        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== botId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Find the bot config
        const activeClients = botQRs;
        if (!activeClients[botId]) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        try {
            userService.getActiveClients().then(clients => {
                const client = clients.find(c => c.idCliente === botId);
                if (client) {
                    botQRs[botId].status = 'starting';
                    botQRs[botId].qr = null;

                    const authFolder = path.join(AUTH_SESSIONS_DIR, `auth_info_${botId}`);

                    if (fs.existsSync(authFolder)) {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                        console.log(`[${botId}] Auth folder deleted for reconnection`);
                    }

                    setTimeout(() => {
                        startBot({
                            id: botId,
                            spreadsheetId: process.env.SPREADSHEET_ID,
                            credentials: process.env.CREDENTIALS_JSON,
                            authFolder: authFolder
                        });
                    }, 500);

                    res.json({ success: true, message: 'Reconnection process started' });
                } else {
                    res.status(404).json({ error: 'Client configuration not found' });
                }
            }).catch(err => {
                res.status(500).json({ error: 'Error retrieving client config' });
            });
        } catch (error) {
            console.error(`[${botId}] Error during reconnection:`, error);
            res.status(500).json({ error: 'Error during reconnection' });
        }
    });

    // Integrated Dashboard routes
    app.use('/', dashboard.setupRoutes());

    app.listen(port, () => {
        console.log(`🚀 Servidor unificado corriendo en http://localhost:${port}`);
        console.log(`📊 Editor de Menú: http://localhost:${port}/`);
        console.log(`📱 QR WhatsApp: http://localhost:${port}/qr`);
    });

    // Iniciar bots dinámicamente desde Sheets
    const activeClients = await userService.getActiveClients();
    console.log(`[System] Found ${activeClients.length} active clients. Starting bots...`);

    // Ensure auth_sessions directory exists
    if (!fs.existsSync(AUTH_SESSIONS_DIR)) {
        fs.mkdirSync(AUTH_SESSIONS_DIR, { recursive: true });
    }

    for (const client of activeClients) {
        await startBot({
            id: client.idCliente,
            spreadsheetId: process.env.SPREADSHEET_ID,
            credentials: process.env.CREDENTIALS_JSON,
            authFolder: path.join(AUTH_SESSIONS_DIR, `auth_info_${client.idCliente}`)
        });
    }
}

main();
