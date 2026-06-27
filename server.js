require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8000;

const AUTH_SESSIONS_DIR = path.resolve(
    process.env.AUTH_SESSIONS_DIR || 
    (process.platform !== 'win32' && fs.existsSync('/data') 
        ? '/data/auth_sessions' 
        : path.join(process.cwd(), 'auth_sessions'))
);

console.log(`[System] Auth sessions directory: ${AUTH_SESSIONS_DIR}`);

try {
    if (!fs.existsSync(AUTH_SESSIONS_DIR)) {
        console.log(`[System] Creating directory: ${AUTH_SESSIONS_DIR}`);
        fs.mkdirSync(AUTH_SESSIONS_DIR, { recursive: true });
    }
    const WEB_SESSIONS_DIR = path.join(AUTH_SESSIONS_DIR, 'web_sessions');
    if (!fs.existsSync(WEB_SESSIONS_DIR)) {
        console.log(`[System] Creating directory: ${WEB_SESSIONS_DIR}`);
        fs.mkdirSync(WEB_SESSIONS_DIR, { recursive: true });
    }
} catch (err) {
    console.error(`[System] Error creating session directories: ${err.message}`);
}

app.use(session({
    store: new FileStore({
        path: path.join(AUTH_SESSIONS_DIR, 'web_sessions'),
        ttl: 3600,
        reapInterval: 3600,
        logFn: () => {}
    }),
    secret: process.env.SESSION_SECRET || 'bot-menu-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 60 * 60 * 1000
    }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use(express.static(path.join(__dirname, 'app', 'src', 'public'), { index: false }));

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    } catch { return {}; }
}

function writeConfig(data) {
    var current = readConfig();
    Object.assign(current, data);
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(current, null, 2));
}

app.get('/api/config', (req, res) => {
    var cfg = readConfig();
    res.json({
        phone: process.env.BOT_PHONE || '5492494249236',
        precioEstandar: cfg.precio_estandar != null ? cfg.precio_estandar : (process.env.PRECIO_ESTANDAR || '22000')
    });
});

app.post('/api/config', (req, res) => {
    if (req.body.precio_estandar != null) {
        writeConfig({ precio_estandar: Number(req.body.precio_estandar) });
    }
    res.json({ ok: true });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const { appRouter, main } = require('./app/src/app');

app.use('/app', appRouter);

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
    console.log(`📊 Editor de Menú: http://localhost:${port}/app/`);
    console.log(`📱 QR WhatsApp: http://localhost:${port}/app/qr`);
});

main().catch(err => {
    console.error('[System] Error during bot initialization:', err);
});
