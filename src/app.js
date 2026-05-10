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
            <div class="login-box" style="position: relative;">
                <canvas id="botLogoLogin" width="200" height="200" style="position: absolute; top: -110px; left: -70px; width: 180px; height: 180px; pointer-events: none; filter: drop-shadow(0 5px 15px rgba(0,0,0,0.1));"></canvas>
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

            <script>
                function drawRobot(canvasId) {
                    const canvas = document.getElementById(canvasId);
                    if (!canvas) return;
                    const ctx = canvas.getContext('2d');
                    
                    // Cuerpo
                    ctx.beginPath(); ctx.roundRect(50, 80, 100, 80, 15); ctx.fillStyle = '#4A90E2'; ctx.fill();
                    // Cuello
                    ctx.fillStyle = '#357ABD'; ctx.fillRect(90, 70, 20, 10);
                    // Cabeza
                    ctx.beginPath(); ctx.roundRect(60, 25, 80, 50, 20); ctx.fillStyle = '#4A90E2'; ctx.fill();
                    // Visor
                    ctx.beginPath(); ctx.roundRect(70, 35, 60, 30, 10); ctx.fillStyle = '#2C3E50'; ctx.fill();
                    // Ojos
                    ctx.beginPath(); ctx.arc(88, 50, 5, 0, Math.PI * 2); ctx.arc(112, 50, 5, 0, Math.PI * 2); ctx.fillStyle = '#00FFCC'; ctx.fill();
                    // Herramienta
                    ctx.save(); ctx.translate(140, 140); ctx.rotate(-Math.PI / 4);
                    ctx.beginPath(); ctx.roundRect(-5, -40, 10, 60, 5); ctx.fillStyle = '#FF5E62'; ctx.fill();
                    ctx.beginPath(); ctx.moveTo(-5, -40); ctx.lineTo(0, -55); ctx.lineTo(5, -40); ctx.fillStyle = '#2C3E50'; ctx.fill();
                    ctx.restore();
                    // Antena
                    ctx.beginPath(); ctx.moveTo(100, 25); ctx.lineTo(100, 10); ctx.strokeStyle = '#4A90E2'; ctx.lineWidth = 3; ctx.stroke();
                    ctx.beginPath(); ctx.arc(100, 10, 4, 0, Math.PI * 2); ctx.fillStyle = '#FF5E62'; ctx.fill();
                }
                drawRobot('botLogoLogin');
            </script>
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
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.clearCookie('connect.sid'); // Nombre por defecto de la cookie de session
        res.redirect('/login');
    });
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

const botQRs = {}; // Object to store status and data for each bot

async function startBot(botConfig, forceStart = false) {
    const { id, spreadsheetId, credentials, authFolder } = botConfig;
    
    // Si el bot ya está corriendo o conectando, no hacer nada a menos que sea forceStart
    if (botQRs[id]?.status === 'connected' || botQRs[id]?.status === 'connecting' || botQRs[id]?.status === 'qr_ready') {
        if (!forceStart) return;
    }

    console.log(`[${id}] Starting initialization...`);
    botQRs[id] = { 
        ...botQRs[id],
        status: 'starting', 
        qr: null, 
        rawQr: null,
        lastUpdate: new Date().toLocaleTimeString(),
        config: botConfig,
        lastActiveViewer: Date.now() // Al iniciar, asumimos que alguien lo está viendo
    };
    
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

        botQRs[id].sock = sock;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            botQRs[id].lastUpdate = new Date().toLocaleTimeString();
            
            if (qr) {
                console.log(`[${id}] New QR code received`);
                botQRs[id].rawQr = qr;
                
                // Si es la primera vez que recibimos el QR en este ciclo, guardamos el timestamp
                if (botQRs[id].status !== 'qr_ready') {
                    botQRs[id].qrReadyTimestamp = Date.now();
                }
                
                botQRs[id].status = 'qr_ready';
                
                // Solo generar la imagen si alguien está mirando (últimos 30 segundos)
                if (Date.now() - (botQRs[id].lastActiveViewer || 0) < 30000) {
                    try {
                        botQRs[id].qr = await QRCode.toDataURL(qr);
                    } catch (err) {
                        console.error(`[${id}] Error generating QR DataURL:`, err);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom) ? 
                    lastDisconnect.error.output.statusCode : 0;
                
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[${id}] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                
                // Si fue cerrado por inactividad o timeout, no intentar reconectar automáticamente
                if (botQRs[id].status === 'stopped_inactivity' || botQRs[id].status === 'timeout_qr') {
                    console.log(`[${id}] Connection stopped due to inactivity/timeout. Waiting for manual start.`);
                    return;
                }

                botQRs[id].status = 'disconnected';
                botQRs[id].qr = null;
                botQRs[id].rawQr = null;
                botQRs[id].qrReadyTimestamp = null;

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
                botQRs[id].rawQr = null;
                botQRs[id].qrReadyTimestamp = null;
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
    // API: Obtener estado de un bot
    app.get('/api/bot/status/:id', async (req, res) => {
        const id = req.params.id;
        const loggedUser = req.user;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const data = botQRs[id];
        if (!data) return res.status(404).json({ error: 'Not found' });

        // Marcar actividad del visor
        data.lastActiveViewer = Date.now();

        // Si hay un QR pendiente de generar imagen, hacerlo ahora
        if (data.status === 'qr_ready' && !data.qr && data.rawQr) {
            try {
                data.qr = await QRCode.toDataURL(data.rawQr);
            } catch (err) {
                console.error(`[${id}] Error lazy-generating QR:`, err);
            }
        }

        res.json({
            status: data.status,
            qr: data.qr,
            lastUpdate: data.lastUpdate
        });
    });

    // API: Iniciar conexión de un bot
    app.post('/api/bot/start/:id', async (req, res) => {
        const id = req.params.id;
        const loggedUser = req.user;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const data = botQRs[id];
        if (!data || !data.config) return res.status(404).json({ error: 'Config not found' });

        if (data.status === 'connected' || data.status === 'connecting' || data.status === 'qr_ready') {
            return res.json({ success: true, message: 'Already running' });
        }

        startBot(data.config, true);
        res.json({ success: true, message: 'Starting...' });
    });

    // API: Detener conexión de un bot (por inactividad/visibilidad)
    app.post('/api/bot/stop/:id', async (req, res) => {
        const id = req.params.id;
        const loggedUser = req.user;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const data = botQRs[id];
        if (!data) return res.status(404).json({ error: 'Not found' });

        // Solo detener si está en estados de "espera de QR"
        if (data.status === 'qr_ready' || data.status === 'starting' || data.status === 'connecting') {
            console.log(`[${id}] Stopping connection explicitly (User left page)`);
            if (data.sock) {
                try { data.sock.end(); } catch (e) {}
            }
            data.status = 'stopped_inactivity';
            data.qr = null;
            data.rawQr = null;
            data.qrReadyTimestamp = null;
            return res.json({ success: true, message: 'Stopped' });
        }

        res.json({ success: true, message: 'No action needed' });
    });

    // Integrated Dashboard routes
    app.use('/', dashboard.setupRoutes());

    // Nueva ruta /qr dinámica
    app.get('/qr', (req, res) => {
        const loggedUser = req.user;
        const bots = Object.entries(botQRs).filter(([id]) => {
            if (loggedUser.idCliente === 'admin') return true;
            return id === loggedUser.idCliente;
        });

        let html = `
        <html>
            <head>
                <title>WhatsApp Bot QR Status</title>
                <style>
                    :root {
                        --primary-color: #00bc7d;
                        --primary-hover: #00a56d;
                        --bg-white: #ffffff;
                        --bg-box: #fbfbfb;
                        --border-color: #e7e3e4;
                        --text-main: #333;
                        --text-muted: #666;
                        --error-color: #dc3545;
                        --info-color: #007bff;
                    }
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; flex-direction: column; align-items: center; padding: 20px; background: var(--bg-white); color: var(--text-main); }
                    .header-nav { width: 100%; max-width: 800px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid var(--border-color); }
                    .btn-back { 
                        padding: 12px 20px; 
                        background: var(--bg-box); 
                        color: var(--text-muted); 
                        text-decoration: none; 
                        border-radius: 6px; 
                        font-weight: 600; 
                        font-size: 14px; 
                        transition: all 0.2s; 
                        border: 1px solid var(--border-color);
                        display: inline-flex;
                        align-items: center;
                    }
                    .btn-back:hover { 
                        background: var(--primary-color); 
                        color: white; 
                        border-color: var(--primary-color);
                    }
                    .container { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; width: 100%; max-width: 1000px; }
                    .bot-card { background: var(--bg-box); border: 1px solid var(--border-color); border-radius: 12px; padding: 25px; width: 320px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); text-align: center; }
                    .status { display: inline-block; padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; margin-bottom: 15px; text-transform: uppercase; }
                    .status.connected { background: #e6f7f0; color: #00bc7d; }
                    .status.qr_ready { background: #fff4e5; color: #ff9800; }
                    .status.waiting_start { background: #f0f0f0; color: #666; }
                    .status.connecting { background: #e5f1ff; color: #007bff; }
                    .status.disconnected, .status.logged_out, .status.stopped_inactivity, .status.timeout_qr { background: #ffebee; color: #dc3545; }
                    .qr-container { min-height: 256px; display: flex; align-items: center; justify-content: center; background: #fff; margin: 15px 0; border: 1px dashed #ccc; border-radius: 8px; position: relative; }
                    .qr-img { width: 256px; height: 256px; }
                    .btn-action { 
                        padding: 12px 24px; 
                        background: var(--primary-color); 
                        color: white; 
                        border: none; 
                        border-radius: 6px; 
                        cursor: pointer; 
                        font-weight: 700; 
                        width: 100%; 
                        transition: all 0.2s; 
                        margin-top: 10px;
                    }
                    .btn-action:hover { background: var(--primary-hover); }
                    .btn-action.btn-danger { background: var(--error-color); }
                    .btn-action:disabled { background: #ccc; cursor: not-allowed; }
                    .last-update { font-size: 11px; color: #999; margin-top: 15px; }
                </style>
            </head>
            <body>
                <div class="header-nav">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <canvas id="botLogoQR" width="200" height="200" style="width: 60px; height: 60px;"></canvas>
                        <h1>WhatsApp Status</h1>
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <a href="/" class="btn-back">Volver al Editor de Menú</a>
                        <a href="/logout" class="btn-back btn-danger" style="color: white; background: var(--error-color); border: none;">Salir</a>
                    </div>
                </div>
                <div class="container">
                    ${bots.length === 0 ? '<p>No hay bots configurados para tu cuenta.</p>' : ''}
                    ${bots.map(([id, data]) => `
                        <div class="bot-card" id="card-${id}">
                            <h2>Bot: ${id}</h2>
                            <div class="status-badge status ${data.status}" id="status-${id}">${data.status.replace(/_/g, ' ')}</div>
                            <div class="qr-container" id="qr-container-${id}">
                                <p class="placeholder-text" id="placeholder-${id}">Cargando...</p>
                            </div>
                            <div id="instruction-${id}" style="font-size: 14px; margin-bottom: 10px; color: #555;">...</div>
                            <div class="action-buttons" id="actions-${id}">
                                <!-- Botones dinámicos -->
                            </div>
                            <div class="last-update" id="update-${id}">Ultima actualización: ${data.lastUpdate}</div>
                        </div>
                    `).join('')}
                </div>

                <script>
                    function drawRobot(canvasId) {
                        const canvas = document.getElementById(canvasId);
                        if (!canvas) return;
                        const ctx = canvas.getContext('2d');
                        ctx.beginPath(); ctx.roundRect(50, 80, 100, 80, 15); ctx.fillStyle = '#4A90E2'; ctx.fill();
                        ctx.fillStyle = '#357ABD'; ctx.fillRect(90, 70, 20, 10);
                        ctx.beginPath(); ctx.roundRect(60, 25, 80, 50, 20); ctx.fillStyle = '#4A90E2'; ctx.fill();
                        ctx.beginPath(); ctx.roundRect(70, 35, 60, 30, 10); ctx.fillStyle = '#2C3E50'; ctx.fill();
                        ctx.beginPath(); ctx.arc(88, 50, 5, 0, Math.PI * 2); ctx.arc(112, 50, 5, 0, Math.PI * 2); ctx.fillStyle = '#00FFCC'; ctx.fill();
                        ctx.save(); ctx.translate(140, 140); ctx.rotate(-Math.PI / 4);
                        ctx.beginPath(); ctx.roundRect(-5, -40, 10, 60, 5); ctx.fillStyle = '#FF5E62'; ctx.fill();
                        ctx.beginPath(); ctx.moveTo(-5, -40); ctx.lineTo(0, -55); ctx.lineTo(5, -40); ctx.fillStyle = '#2C3E50'; ctx.fill(); ctx.restore();
                        ctx.beginPath(); ctx.moveTo(100, 25); ctx.lineTo(100, 10); ctx.strokeStyle = '#4A90E2'; ctx.lineWidth = 3; ctx.stroke();
                        ctx.beginPath(); ctx.arc(100, 10, 4, 0, Math.PI * 2); ctx.fillStyle = '#FF5E62'; ctx.fill();
                    }
                    drawRobot('botLogoQR');

                    const botIds = ${JSON.stringify(bots.map(([id]) => id))};

                    async function updateBotStatus(id) {
                        try {
                            const res = await fetch('/api/bot/status/' + id);
                            if (!res.ok) return;
                            const data = await res.json();
                            
                            const statusBadge = document.getElementById('status-' + id);
                            statusBadge.className = 'status-badge status ' + data.status;
                            statusBadge.textContent = data.status.replace(/_/g, ' ');

                            const qrContainer = document.getElementById('qr-container-' + id);
                            const instruction = document.getElementById('instruction-' + id);
                            const actions = document.getElementById('actions-' + id);
                            const updateTime = document.getElementById('update-' + id);
                            
                            updateTime.textContent = 'Ultima actualización: ' + data.lastUpdate;

                            if (data.status === 'connected') {
                                qrContainer.innerHTML = '<p style="color: #00bc7d; font-weight: bold;">Sesión Activa ✅</p>';
                                instruction.textContent = 'El bot está funcionando correctamente.';
                                actions.innerHTML = '<button class="btn-action btn-danger" onclick="deleteSession(\\'' + id + '\\')">Cerrar Sesión WhatsApp</button>';
                            } else if (data.status === 'qr_ready') {
                                if (data.qr) {
                                    qrContainer.innerHTML = '<img class="qr-img" src="' + data.qr + '" />';
                                    instruction.textContent = 'Escanea el código QR con tu WhatsApp.';
                                } else {
                                    qrContainer.innerHTML = '<p>Generando código QR...</p>';
                                }
                                actions.innerHTML = '<button class="btn-action btn-danger" onclick="deleteSession(\\'' + id + '\\')">Cancelar / Reiniciar</button>';
                            } else if (data.status === 'waiting_start' || data.status === 'stopped_inactivity' || data.status === 'logged_out' || data.status === 'disconnected' || data.status === 'timeout_qr') {
                                qrContainer.innerHTML = '<p style="color: #666;">' + (data.status === 'timeout_qr' ? 'Tiempo Excedido' : 'Conexión Detenida') + '</p>';
                                instruction.textContent = data.status === 'timeout_qr' ? 'El tiempo de escaneo ha terminado.' : 'Haz clic para iniciar la conexión y ver el QR.';
                                actions.innerHTML = '<button class="btn-action" onclick="startBot(\\'' + id + '\\')">Iniciar Bot / Mostrar QR</button>';
                            } else {
                                qrContainer.innerHTML = '<p>Iniciando...</p>';
                                instruction.textContent = 'Por favor espera...';
                                actions.innerHTML = '<button class="btn-action" disabled>Procesando...</button>';
                            }
                        } catch (err) {
                            console.error('Error polling ' + id, err);
                        }
                    }

                    async function startBot(id) {
                        const btn = document.querySelector('#actions-' + id + ' button');
                        if (btn) btn.disabled = true;
                        await fetch('/api/bot/start/' + id, { method: 'POST' });
                        updateBotStatus(id);
                    }

                    async function deleteSession(id) {
                        if (!confirm('¿Seguro que deseas borrar la sesión? Deberás escanear el QR nuevamente.')) return;
                        const btn = document.querySelector('#actions-' + id + ' button');
                        if (btn) btn.disabled = true;
                        await fetch('/reconnect/' + id, { method: 'POST' });
                        updateBotStatus(id);
                    }

                    // Start polling for each bot only if tab is visible
                    let pollingIntervals = [];

                    function startPolling() {
                        if (pollingIntervals.length > 0) return;
                        botIds.forEach(id => {
                            updateBotStatus(id);
                            const interval = setInterval(() => updateBotStatus(id), 5000);
                            pollingIntervals.push(interval);
                        });
                        console.log('Polling started');
                    }

                    async function stopPolling() {
                        pollingIntervals.forEach(clearInterval);
                        pollingIntervals = [];
                        
                        // Detener bots explícitamente al salir
                        for (const id of botIds) {
                            try {
                                await fetch('/api/bot/stop/' + id, { method: 'POST' });
                            } catch (e) {
                                console.error('Error stopping ' + id, e);
                            }
                        }
                        console.log('Polling and bots stopped');
                    }

                    // Handle visibility changes to stop heartbeat when user leaves the tab
                    document.addEventListener('visibilitychange', () => {
                        if (document.hidden) {
                            stopPolling();
                        } else {
                            startPolling();
                        }
                    });

                    // Initial start
                    startPolling();
                </script>
            </body>
        </html>
        `;
        res.send(html);
    });

    // Endpoint para borrar sesión (reutilizado)
    app.post('/reconnect/:botId', (req, res) => {
        const loggedUser = req.user;
        const botId = req.params.botId;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== botId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const data = botQRs[botId];
        if (!data) return res.status(404).json({ error: 'Bot not found' });

        try {
            if (data.sock) {
                try { data.sock.end(); } catch (e) {}
            }

            const authFolder = path.join(AUTH_SESSIONS_DIR, `auth_info_${botId}`);
            if (fs.existsSync(authFolder)) {
                fs.rmSync(authFolder, { recursive: true, force: true });
                console.log(`[${botId}] Session deleted manually`);
            }

            botQRs[botId].status = 'logged_out';
            botQRs[botId].qr = null;
            botQRs[botId].rawQr = null;

            res.json({ success: true });
        } catch (error) {
            console.error(`[${botId}] Error during session deletion:`, error);
            res.status(500).json({ error: 'Error' });
        }
    });

    app.listen(port, () => {
        console.log(`🚀 Servidor unificado corriendo en http://localhost:${port}`);
        console.log(`📊 Editor de Menú: http://localhost:${port}/`);
        console.log(`📱 QR WhatsApp: http://localhost:${port}/qr`);
    });

    // Iniciar bots dinámicamente desde Sheets
    const activeClients = await userService.getUsers(); // Obtener todos para inicializar config
    console.log(`[System] Loading ${activeClients.length} potential clients...`);

    if (!fs.existsSync(AUTH_SESSIONS_DIR)) {
        fs.mkdirSync(AUTH_SESSIONS_DIR, { recursive: true });
    }

    for (const client of activeClients) {
        if (client.idCliente === 'admin') continue;

        const authFolder = path.join(AUTH_SESSIONS_DIR, `auth_info_${client.idCliente}`);
        const credsFile = path.join(authFolder, 'creds.json');
        
        const botConfig = {
            id: client.idCliente,
            spreadsheetId: process.env.SPREADSHEET_ID,
            credentials: process.env.CREDENTIALS_JSON,
            authFolder: authFolder
        };

        // Inicializar objeto de estado
        botQRs[client.idCliente] = {
            status: 'waiting_start',
            qr: null,
            rawQr: null,
            lastUpdate: new Date().toLocaleTimeString(),
            config: botConfig,
            lastActiveViewer: 0
        };

        // Solo iniciar automáticamente si tiene sesión activa Y el cliente está marcado como activo
        if (fs.existsSync(credsFile) && client.activo) {
            console.log(`[System] Auto-starting active session for ${client.idCliente}`);
            startBot(botConfig);
        } else {
            console.log(`[System] Bot ${client.idCliente} waiting for manual start (No active session or inactive).`);
        }
    }

    // Intervalo de limpieza por inactividad
    setInterval(() => {
        const now = Date.now();
        Object.entries(botQRs).forEach(([id, data]) => {
            // 1. Timeout de escaneo (30 segundos en estado qr_ready)
            if (data.status === 'qr_ready' && data.qrReadyTimestamp) {
                if (now - data.qrReadyTimestamp > 30000) {
                    console.log(`[${id}] QR Scan Timeout (30s exceeded). Stopping...`);
                    data.status = 'timeout_qr';
                    if (data.sock) {
                        try { data.sock.end(); } catch (e) {}
                    }
                    data.qr = null;
                    data.rawQr = null;
                    data.qrReadyTimestamp = null;
                    return; // Saltar al siguiente bot
                }
            }

            // 2. Detener por inactividad de visor (45 segundos)
            if (data.status === 'qr_ready' || data.status === 'starting' || data.status === 'connecting') {
                if (now - (data.lastActiveViewer || 0) > 45000) {
                    console.log(`[${id}] Stopping connection due to inactive viewer (Saving memory)`);
                    if (data.sock) {
                        try { data.sock.end(); } catch (e) {}
                    }
                    data.status = 'stopped_inactivity';
                    data.qr = null;
                    data.rawQr = null;
                    data.qrReadyTimestamp = null;
                }
            }
            
            // Si el bot está en qr_ready pero no hay visor activo hace 15 segundos, limpiar la imagen Base64 para liberar memoria
            if (data.status === 'qr_ready' && data.qr && (now - (data.lastActiveViewer || 0) > 15000)) {
                console.log(`[${id}] Clearing QR image from memory (Still in qr_ready state)`);
                data.qr = null;
            }
        });
    }, 30000);
}

main();

